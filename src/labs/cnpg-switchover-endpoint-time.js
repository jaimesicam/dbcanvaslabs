// The measurement loop, the endpoint behaviour and the operator's own promotion timestamps
// below are confirmed live against a real K3D + CloudNativePG deploy (server/, see
// LABORATORY.md). Grading runs server-side and re-derives the timing from the cluster's own
// status, so it never has to take the learner's stopwatch on trust.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, the cnpg
// plugin and a client Pod are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgSwitchoverEndpointTime = {
  id: 'cnpg-switchover-endpoint-time',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster with real streaming replication, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time, and the cnpg plugin is fetched and installed on every node. It is also why the number you measure is a real measurement, on a real cluster, on this machine.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — one primary and two replicas streaming from it, on timeline 1',
      'The pg-cluster-rw Service, currently resolving to the one instance labelled primary',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      "Nothing is broken, and nothing is going to break — this is the planned handover, the one you would perform before draining a node. CloudNativePG's own end-to-end suite asserts that the write endpoint follows a *switchover* within twenty seconds, a looser budget than an unplanned failover gets, and for a reason worth understanding. You will reproduce that measurement: record where the endpoint points, hand the primary role across while timing how long the endpoint takes to name the new instance, then check your stopwatch against the operator's own promotion timestamps.",
  },

  tasks: [
    {
      id: 'record-endpoint',
      title: 'Record where the write endpoint points',
      limitSec: 300,
      criteria: [
        'pg-cluster-rw has exactly one endpoint',
        '/root/rw-before.txt was written',
        'It names the Pod pg-cluster-rw points at',
      ],
      brief: `Take the "before" reading, because a measurement without one is just a number.

The read-write Service has exactly one endpoint: the address of whichever Pod currently carries the primary label. Find that address, work out which Pod it belongs to, and record the Pod name in \`/root/rw-before.txt\`.

Worth noticing before you move anything: the Service is not configuration pointing at a Pod. It is a live query over a label the operator maintains, which is why moving the label is all it takes to move the traffic.`,
      instructions: `Look at the Service and what stands behind it:

\`\`\`
kubectl get svc pg-cluster-rw -o wide
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
\`\`\`

One address, because the selector is \`cnpg.io/instanceRole=primary\` and exactly one instance carries that label:

\`\`\`
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

Match the address to a Pod and record its name:

\`\`\`
echo pg-cluster-1 > /root/rw-before.txt
\`\`\`

Check the replicas are caught up too, since a switchover is only safe if one of them is ready to take over:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\`

Both replicas \`streaming\`, LSNs matching, lag columns at zero.`,
      hint: `\`kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'\` prints the address alone; match it against the IP column of \`kubectl get pods -o wide\`.`,
      solution: `kubectl get svc pg-cluster-rw -o wide
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl cnpg status pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}' > /root/rw-before.txt`,
    },

    {
      id: 'time-the-switchover',
      title: 'Hand the role across and time the endpoint',
      limitSec: 480,
      criteria: [
        'pg-cluster-rw now points at the instance you promoted',
        '/root/switchover-seconds.txt was written',
        'It records a switch time under 20 seconds',
        "CNPG's own promotion timestamps agree it took under 20 seconds",
      ],
      brief: `Now take the measurement. Ask the operator to promote a specific replica and, without pausing in between, poll the write endpoint once a second until it names a different address — then record how many seconds that took in \`/root/switchover-seconds.txt\`.

Run the promotion and the timing as one block in a single terminal tab. Starting a stopwatch by hand in another tab measures your own reflexes, not the cluster's.

Expect this to take longer than an unplanned failover would, and that is the interesting part: a switchover deliberately shuts the old primary down cleanly *first*, so the elapsed time includes a graceful PostgreSQL shutdown that a crash never pays for. Then check your number against something you did not measure at all — the operator stamps when it decided on a new primary and when that instance actually became one.`,
      instructions: `Run this as one block, in a single terminal tab. It records the current endpoint, asks for the switchover, starts the clock, and polls once a second until the endpoint names something else:

\`\`\`
OLD=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
kubectl cnpg promote pg-cluster pg-cluster-2
START=$(date +%s)
while true; do
  IP=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
  [ -n "$IP" ] && [ "$IP" != "$OLD" ] && break
  sleep 1
done
echo $(( $(date +%s) - START )) > /root/switchover-seconds.txt
cat /root/switchover-seconds.txt
\`\`\`

The promote command returns immediately — it sets the cluster's target primary and the operator does the rest — so the clock starts on the request, not on its completion.

While that runs, the cluster passes through a state you can watch from another tab:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

"Switchover in progress" while the old primary shuts down and the chosen replica is promoted, then back to "Cluster in healthy state".

Now compare your stopwatch with the cluster's own:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.targetPrimaryTimestamp}{"\\n"}{.status.currentPrimaryTimestamp}{"\\n"}'
\`\`\`

The first is when the operator decided there should be a new primary; the second is when that instance actually was one. The gap between them is the promotion itself — the rest of what you measured is the old primary shutting down and the endpoint being recomputed.`,
      hint: `Promote one of the two **replicas**, not the current primary — the argument order is \`kubectl cnpg promote <cluster> <instance>\`. If the loop never ends, the endpoint may be briefly empty rather than changed; the condition here waits for a non-empty address that differs from the old one, so let it keep polling.`,
      solution: `OLD=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
kubectl cnpg promote pg-cluster pg-cluster-2
START=$(date +%s)
while true; do
  IP=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
  [ -n "$IP" ] && [ "$IP" != "$OLD" ] && break
  sleep 1
done
echo $(( $(date +%s) - START )) > /root/switchover-seconds.txt
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.targetPrimaryTimestamp}{"\\n"}{.status.currentPrimaryTimestamp}{"\\n"}'`,
    },

    {
      id: 'prove-service-followed',
      title: 'Prove the endpoint change was real',
      limitSec: 360,
      criteria: [
        "A row noted 'after-switchover-endpoint' exists",
        'pg-cluster-rw serves that write from the newly-promoted primary',
        'Cluster reports healthy again',
      ],
      brief: `A moved endpoint is only worth something if traffic follows it, so finish by writing through the Service and confirming which instance served the write.

Connect from the client Pod, whose configuration has not changed and never will, and insert a row noted \`after-switchover-endpoint\` through \`pg-cluster-rw\`. Then ask the session which server address answered.

That address should be the instance you promoted, and the cluster should be back to healthy with the old primary rejoined as a replica — the whole point of a planned handover being that it costs seconds of write availability and no reconfiguration anywhere.`,
      instructions: `Write through the Service, from a client that has been running untouched the whole time:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE switch_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO switch_proof (note) VALUES ('after-switchover-endpoint') RETURNING *;"
\`\`\`

Ask who served it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

The address belongs to the instance you promoted, and recovery is false — it is a full primary now. Confirm the cluster has finished settling:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

"Cluster in healthy state", 3 of 3 ready. The instance that used to be primary restarted once and rejoined as a replica of the one you promoted, keeping its own volume — a demotion, not a rebuild.`,
      hint: `If the write is refused as read-only, the switchover has not finished settling — wait for \`kubectl get cluster.postgresql.cnpg.io pg-cluster\` to read healthy and try again.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE switch_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO switch_proof (note) VALUES ('after-switchover-endpoint') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get cluster.postgresql.cnpg.io pg-cluster`,
    },
  ],
}
