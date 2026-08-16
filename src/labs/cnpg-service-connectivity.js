// Service names, selectors, endpoint counts and the read-only refusal below are confirmed
// live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). Grading runs
// server-side, against the real cluster.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a
// client Pod are this lab's starting state, built by its own provisioning, because the
// subject is which of the three Services a client should be pointed at. No reference to any
// other lab (see CLAUDE.md, "Lab content contract").

export const cnpgServiceConnectivity = {
  id: 'cnpg-service-connectivity',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster and a real client to connect from, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — one primary and two streaming replicas, spread across the three nodes',
      'The three Services the operator creates for it — pg-cluster-rw, pg-cluster-ro and pg-cluster-r — already wired to their instances',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      'Nothing is broken and nothing is missing. What you do not yet know is which of those three Services a given client should be pointed at, and what happens when you pick the wrong one. You will read what each Service actually resolves to, write through the read-write Service, watch the read-only Service refuse the same statement, and count the endpoints behind each.',
  },

  tasks: [
    {
      id: 'survey-services',
      title: 'See what the three Services resolve to',
      limitSec: 360,
      criteria: [
        'All three Services exist: pg-cluster-rw, pg-cluster-ro and pg-cluster-r',
        'pg-cluster-rw has exactly one endpoint',
        '/root/rw-endpoint.txt was written',
        'It names the Pod pg-cluster-rw currently points at',
      ],
      brief: `The operator created three Services for this one database, and they are not interchangeable. Your first job is to find out what each of them actually points at.

Look at the Services and, more importantly, at their selectors — that label match is the whole mechanism. Then look up the endpoints behind the read-write Service, work out which Pod that address belongs to, and record that Pod's name in \`/root/rw-endpoint.txt\`.

The point of doing it this way round, endpoint first and Pod second, is that a Service is nothing but a selector and the set of Pods matching it right now. Once you have seen that, the behaviour of all three follows.`,
      instructions: `Start by listing the Services the operator created, with their selectors:

\`\`\`
kubectl get svc -o wide
\`\`\`

Three of them belong to the database. Read the SELECTOR column closely — \`pg-cluster-rw\` selects \`cnpg.io/instanceRole=primary\`, \`pg-cluster-ro\` selects \`cnpg.io/instanceRole=replica\`, and \`pg-cluster-r\` selects every instance Pod regardless of role. Nothing else distinguishes them.

Now ask which Pod addresses are actually behind the read-write Service:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
\`\`\`

That is one address. Find out whose it is:

\`\`\`
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

Match the IP, and note that the Pod it belongs to is the one labelled \`primary\`. That label is applied by the operator, and it moves — which is precisely why an application connects to a Service name rather than a Pod. Record the Pod name:

\`\`\`
echo <pod-name> > /root/rw-endpoint.txt
\`\`\``,
      hint: `\`kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'\` prints just the address. Then match it against the IP column of \`kubectl get pods -o wide\`.`,
      solution: `kubectl get svc -o wide
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}' > /root/rw-endpoint.txt
cat /root/rw-endpoint.txt`,
    },

    {
      id: 'write-through-rw',
      title: 'Write through the read-write Service',
      limitSec: 360,
      criteria: ["A row noted 'via-rw' exists in svc_proof", 'The same row is readable through pg-cluster-ro'],
      brief: `Now connect the way an application would: from a separate client Pod, to a Service name, with no idea which instance is on the other end.

The \`psql-client\` Pod is already running with the app user's credentials in its environment, so a bare psql command against a Service name is all it takes. Create a small table through \`pg-cluster-rw\`, write a row noted \`via-rw\`, then read that same row back through \`pg-cluster-ro\`.

Reading it back through the other Service is the part that matters: it proves replication carried your write to an instance you never addressed.`,
      instructions: `The client Pod already has \`PGUSER\`, \`PGDATABASE\` and \`PGPASSWORD\` set from the operator-generated \`pg-cluster-app\` Secret, so you only ever have to name a host.

Create the table through the read-write Service:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE svc_proof (id serial primary key, note text, created_at timestamptz default now());"
\`\`\`

Write a row through it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO svc_proof (note) VALUES ('via-rw') RETURNING *;"
\`\`\`

Now read the same row back through the read-only Service, which never resolves to the instance you just wrote to:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-ro -c "SELECT id, note FROM svc_proof;"
\`\`\`

To see the difference plainly, ask each Service who answered and whether that instance is in recovery:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl exec psql-client -- psql -h pg-cluster-ro -c "SELECT inet_server_addr(), pg_is_in_recovery();"
\`\`\`

The read-write Service answers false; the read-only Service answers true. Same database, different instance, decided entirely by which name you dialled.`,
      hint: `Everything runs from the \`psql-client\` Pod, not from inside a database Pod: \`kubectl exec psql-client -- psql -h <service> -c "<sql>"\`. If psql asks for a password, you are missing the \`--\` before \`psql\`, so kubectl is swallowing the arguments.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE svc_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO svc_proof (note) VALUES ('via-rw') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-ro -c "SELECT id, note FROM svc_proof;"
kubectl exec psql-client -- psql -h pg-cluster-ro -c "SELECT inet_server_addr(), pg_is_in_recovery();"`,
    },

    {
      id: 'read-only-refuses-writes',
      title: 'Watch the read-only Service refuse a write',
      limitSec: 300,
      criteria: [
        'pg-cluster-ro really refuses an INSERT',
        '/root/ro-error.txt was written',
        'It captured the read-only transaction error',
      ],
      brief: `Send exactly the same INSERT to the read-only Service and read the error it comes back with.

This is not the Service rejecting you — a Service does nothing but forward. The connection reaches a real PostgreSQL replica, which is in recovery, and PostgreSQL itself refuses the statement. Capture that error message into \`/root/ro-error.txt\`.

It is worth seeing the failure mode once, because it is how a misconfigured application announces itself: reads work perfectly, and then the first write fails at run time with a message about a read-only transaction.`,
      instructions: `Send the same INSERT you just ran successfully, only this time to the read-only Service:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-ro -c "INSERT INTO svc_proof (note) VALUES ('via-ro');"
\`\`\`

It fails with \`ERROR: cannot execute INSERT in a read-only transaction\`. The Service forwarded the connection perfectly well — the instance it forwarded to is a streaming replica, permanently in recovery, and PostgreSQL will not accept a write there.

Capture the error itself, standard error included:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-ro -c "INSERT INTO svc_proof (note) VALUES ('via-ro');" > /root/ro-error.txt 2>&1
cat /root/ro-error.txt
\`\`\`

Nothing is broken and nothing needs undoing: the transaction never committed, so the table is exactly as you left it.`,
      hint: `The error arrives on standard error, so \`> /root/ro-error.txt\` alone captures an empty file — redirect both streams with \`> /root/ro-error.txt 2>&1\`.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-ro -c "INSERT INTO svc_proof (note) VALUES ('via-ro');" > /root/ro-error.txt 2>&1
cat /root/ro-error.txt`,
    },

    {
      id: 'count-endpoints',
      title: 'Count what stands behind each Service',
      limitSec: 300,
      criteria: [
        'pg-cluster-ro has 2 endpoints — the replicas only',
        'pg-cluster-r has 3 endpoints — every instance',
        '/root/ro-endpoints.txt was written',
        'It records the number 2',
      ],
      brief: `Finish by counting the endpoints behind the read-only Service and the plain read Service, and record how many the read-only one has in \`/root/ro-endpoints.txt\`.

Two versus three is the entire distinction between them, and it decides which one a reporting query should use. The read-only Service spreads reads across replicas only, keeping that load off the primary. The plain read Service includes the primary as well, so it is the one to use when any instance will do.

Knowing the counts also tells you what to expect when an instance goes away: the sets are recomputed from labels continuously, not fixed at creation.`,
      instructions: `Count the addresses behind the read-only Service:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-ro
\`\`\`

Two addresses — the two replicas, and never the primary. Now the plain read Service:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-r
\`\`\`

Three addresses, every instance including the primary. That is the whole difference: \`-ro\` keeps read traffic off the primary, \`-r\` is for when any instance will do.

Record how many endpoints the read-only Service has:

\`\`\`
echo 2 > /root/ro-endpoints.txt
\`\`\`

If you want to see the sets recomputed live, ask for the addresses on their own and compare the three Services side by side:

\`\`\`
for s in rw ro r; do echo -n "$s: "; kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-$s -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo; done
\`\`\``,
      hint: `One address per endpoint, so counting the addresses is counting the instances. \`kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-ro -o jsonpath='{.items[*].endpoints[*].addresses[*]}'\` prints them on one line.`,
      solution: `kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-ro
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-r
echo 2 > /root/ro-endpoints.txt`,
    },
  ],
}
