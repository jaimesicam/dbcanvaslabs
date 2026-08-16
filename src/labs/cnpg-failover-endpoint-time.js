// The measurement loop, the endpoint behaviour and the operator's own promotion timestamps
// below are confirmed live against a real K3D + CloudNativePG deploy (server/, see
// LABORATORY.md) — a real deletion of a real primary moved the write endpoint in 2 seconds.
// Grading runs server-side and re-derives the timing from the cluster's own status, so it
// never has to take the learner's stopwatch on trust.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a
// client Pod are this lab's starting state, built by its own provisioning. No reference to
// any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgFailoverEndpointTime = {
  id: 'cnpg-failover-endpoint-time',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster with real streaming replication, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here. It is also why the number you measure is a real measurement, on a real cluster, on this machine.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — one primary and two replicas streaming from it, on timeline 1',
      'The pg-cluster-rw Service, currently resolving to the one instance labelled primary',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      "Everything is healthy, so there is nothing to fix — there is something to measure. CloudNativePG's own end-to-end test suite asserts that the write endpoint follows an unplanned failover in under ten seconds, and you are going to reproduce that claim: record where the endpoint points, destroy the primary while timing how long the endpoint takes to name a different Pod, and then check your stopwatch against the operator's own promotion timestamps.",
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

Understanding why there is exactly one is worth a moment. The Service selects on a label the operator maintains, so the endpoint set is not configuration — it is a live query, and moving the label is what will move the endpoint.`,
      instructions: `Look at the Service and what stands behind it:

\`\`\`
kubectl get svc pg-cluster-rw -o wide
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
\`\`\`

One address. The selector is \`cnpg.io/instanceRole=primary\`, and exactly one instance Pod carries that label:

\`\`\`
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

Match the address to a Pod and record its name:

\`\`\`
echo pg-cluster-1 > /root/rw-before.txt
\`\`\`

Keep that name in mind — the whole measurement is "how long until this is a different name".`,
      hint: `\`kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'\` prints the address alone; match it against the IP column of \`kubectl get pods -o wide\`.`,
      solution: `kubectl get svc pg-cluster-rw -o wide
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}' > /root/rw-before.txt`,
    },

    {
      id: 'time-the-switch',
      title: 'Destroy the primary and time the endpoint',
      limitSec: 480,
      criteria: [
        'pg-cluster-rw now points at a different Pod',
        '/root/rw-switch-seconds.txt was written',
        'It records a switch time under 10 seconds',
        "CNPG's own promotion timestamps agree it took under 10 seconds",
      ],
      brief: `Now take the measurement. Destroy the primary Pod and, without pausing in between, poll the write endpoint once a second until it names a different address — then record how many seconds that took in \`/root/rw-switch-seconds.txt\`.

Do the deletion and the timing in one go, in a single terminal tab. Starting the clock by hand in another tab would be measuring your own reflexes, not the cluster's.

Expect a single-digit number. Then check it against something you did not measure at all: the operator stamps the moment it decided on a new primary and the moment that instance actually became one, and the gap between those two is the promotion, timed by the cluster itself.`,
      instructions: `Run this as one block, in a single terminal tab. It records the current endpoint, deletes the primary without waiting for it to go, starts the clock, and polls once a second until the endpoint names something else:

\`\`\`
OLD=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
kubectl delete pod $(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}') --wait=false
START=$(date +%s)
while true; do
  IP=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
  [ -n "$IP" ] && [ "$IP" != "$OLD" ] && break
  sleep 1
done
echo $(( $(date +%s) - START )) > /root/rw-switch-seconds.txt
cat /root/rw-switch-seconds.txt
\`\`\`

The \`--wait=false\` matters: without it, the delete command blocks until the Pod is gone, and the clock would start after the interesting part had already begun.

A single-digit number, usually two or three. In between those seconds the operator noticed the instance was unreachable, chose a replica, promoted it, moved the \`cnpg.io/instanceRole=primary\` label onto it, and Kubernetes recomputed the Service's endpoints from that label.

Now check your stopwatch against the cluster's own account:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.targetPrimaryTimestamp}{"\\n"}{.status.currentPrimaryTimestamp}{"\\n"}'
\`\`\`

The first is when the operator decided there should be a new primary; the second is when that instance actually was one. The gap between them is the promotion itself, under a second on an idle cluster — the rest of what you measured is detection and the endpoint update. And confirm the endpoint really moved:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\``,
      hint: `If the loop never ends, the endpoint may have gone empty rather than changed — a deliberately empty write endpoint is how Kubernetes stops traffic reaching a database with no primary. The condition here waits for a non-empty address that differs from the old one, so let it keep polling.`,
      solution: `OLD=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
kubectl delete pod $(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}') --wait=false
START=$(date +%s)
while true; do
  IP=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
  [ -n "$IP" ] && [ "$IP" != "$OLD" ] && break
  sleep 1
done
echo $(( $(date +%s) - START )) > /root/rw-switch-seconds.txt
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.targetPrimaryTimestamp}{"\\n"}{.status.currentPrimaryTimestamp}{"\\n"}'`,
    },

    {
      id: 'prove-service-followed',
      title: 'Prove the endpoint change was real',
      limitSec: 360,
      criteria: [
        "A row noted 'after-endpoint-switch' exists",
        'pg-cluster-rw serves that write from the newly-promoted primary',
        'Cluster reports healthy again',
      ],
      brief: `A moved endpoint is only worth something if traffic follows it, so finish by writing through the Service and confirming which instance served the write.

Connect from the client Pod, whose configuration has not changed and never will, and insert a row noted \`after-endpoint-switch\` through \`pg-cluster-rw\`. Then ask the session which server address answered.

That address should be the newly-promoted Pod, and the cluster should be back to healthy with the instance you destroyed rejoined as a replica. Ten seconds of unavailability, no client reconfigured.`,
      instructions: `Write through the Service, from a client that has been running untouched the whole time:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE endpoint_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO endpoint_proof (note) VALUES ('after-endpoint-switch') RETURNING *;"
\`\`\`

Ask who served it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

The address belongs to the instance that was a replica when you started, and recovery is false — it is a full primary now. Confirm the cluster has finished settling:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

"Cluster in healthy state", 3 of 3 ready: the instance you destroyed has been recreated and rejoined as a replica of the new primary. The only thing that ever changed for the client was a few seconds of refused connections.`,
      hint: `If the write is refused as read-only, the Service has more than one endpoint for a moment during the recovery — wait for \`kubectl get cluster.postgresql.cnpg.io pg-cluster\` to read healthy and try again.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE endpoint_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO endpoint_proof (note) VALUES ('after-endpoint-switch') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get cluster.postgresql.cnpg.io pg-cluster`,
    },
  ],
}
