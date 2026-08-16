// The lease holder identity, the spread across nodes and the takeover time are confirmed
// live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): three
// replicas landed on three different nodes, one held the Lease, and deleting the holder saw
// a standby take over in 2 seconds. Grading reads the Lease and the learner's measurement.
//
// Self-contained, like every lab here: the operator, a healthy cluster and a client Pod are
// this lab's starting state, built by its own provisioning. No reference to any other lab
// (see CLAUDE.md, "Lab content contract").

export const cnpgOperatorHA = {
  id: 'cnpg-operator-ha',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real CloudNativePG operator and a real database for it to manage, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running as a single replica, started with --leader-elect and already holding a Lease in the cnpg-system namespace',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state"',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to keep querying from',
    ],
    yourJob:
      'The operator already takes a leader-election Lease even though only one replica is running, which is the machinery that makes running several safe. You will scale it out, find which replica actually holds the lease, destroy that one and time how long a standby takes to pick it up — then confirm the followers really were idle rather than duplicating its work.',
  },

  tasks: [
    {
      id: 'scale-up',
      title: 'Run three operators, and find the one in charge',
      limitSec: 420,
      criteria: [
        'The operator Deployment reports 3 ready replicas',
        'Exactly one Pod holds the leader-election Lease',
        '/root/leader.txt was written',
        'It names the Pod holding the Lease',
      ],
      brief: `Scale the operator to three replicas and then answer the question that matters: which one is actually doing the work?

All three run the same binary and watch the same API server, but only the holder of the leader-election Lease reconciles anything. The other two sit waiting for that Lease to expire.

Find the holder and record its name in \`/root/leader.txt\`. The Lease's holder identity is the Pod name with a random suffix, so the Pod name is everything before the underscore.`,
      instructions: `Scale it out:

\`\`\`
kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=3
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get pods -o wide
\`\`\`

Three Pods, spread across the three nodes by the scheduler. Now look at the Lease:

\`\`\`
kubectl -n cnpg-system get lease
\`\`\`

One Lease, one holder. Read the holder identity in full:

\`\`\`
kubectl -n cnpg-system get lease -o jsonpath='{range .items[*]}{.metadata.name}{" -> "}{.spec.holderIdentity}{"\\n"}{end}'
\`\`\`

It is a Pod name followed by an underscore and a UUID — the UUID identifies the *process*, so a restarted Pod with the same name would still be a new holder. Record just the Pod name:

\`\`\`
kubectl -n cnpg-system get lease -o jsonpath='{.items[0].spec.holderIdentity}' | cut -d_ -f1 > /root/leader.txt
cat /root/leader.txt
\`\`\`

Running three replicas does not make the operator three times as fast — it makes it survivable. Exactly one reconciles at any moment, by design: two controllers acting on the same Cluster would fight.`,
      hint: `If a second Lease appears with a different name, it belongs to another component in that namespace — the operator's own is the one whose holder matches one of the \`cnpg-controller-manager-*\` Pods.`,
      solution: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=3
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get pods -o wide
kubectl -n cnpg-system get lease -o jsonpath='{range .items[*]}{.metadata.name}{" -> "}{.spec.holderIdentity}{"\\n"}{end}'
kubectl -n cnpg-system get lease -o jsonpath='{.items[0].spec.holderIdentity}' | cut -d_ -f1 > /root/leader.txt
cat /root/leader.txt`,
    },

    {
      id: 'kill-the-leader',
      title: 'Destroy the leader and time the takeover',
      limitSec: 480,
      criteria: [
        'The Lease is held by a different Pod than the one you recorded',
        '/root/takeover-seconds.txt was written',
        'It records a takeover in under 30 seconds',
        'The database was unaffected throughout',
      ],
      brief: `Delete the replica holding the Lease and time how long another takes to claim it.

Run the deletion and the polling as one block, in a single tab, so the clock starts at the deletion. The loop has to wait for a holder that is both non-empty and different from the one you recorded — during the handover the field is briefly blank, and a loop that accepts that reports a takeover of zero seconds having measured nothing.

Expect this to be fast — seconds, not the full lease duration — because a graceful shutdown releases the Lease rather than letting it expire.`,
      instructions: `Run this as one block:

\`\`\`
LEADER=$(cat /root/leader.txt)
START=$(date +%s)
kubectl -n cnpg-system delete pod $LEADER --wait=false
while true; do
  H=$(kubectl -n cnpg-system get lease -o jsonpath='{.items[0].spec.holderIdentity}' 2>/dev/null | cut -d_ -f1)
  if [ -n "$H" ] && [ "$H" != "$LEADER" ]; then echo "new leader: $H"; break; fi
  [ $(( $(date +%s) - START )) -gt 180 ] && { echo TIMEOUT; break; }
  sleep 2
done
echo $(( $(date +%s) - START )) > /root/takeover-seconds.txt
cat /root/takeover-seconds.txt
\`\`\`

A couple of seconds. The Pod you deleted shut down cleanly and released its Lease on the way out, so a standby could claim it immediately instead of waiting for it to expire — which is the difference between a planned and an abrupt loss of the leader.

The database, meanwhile:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT now();"
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Untouched. Confirm the Deployment replaced the Pod you destroyed:

\`\`\`
kubectl -n cnpg-system get pods
\`\`\``,
      hint: `The guard for a non-empty holder matters: without it the loop sees a blank field mid-handover, decides it differs from the old leader, and reports zero seconds.`,
      solution: `LEADER=$(cat /root/leader.txt)
START=$(date +%s)
kubectl -n cnpg-system delete pod $LEADER --wait=false
while true; do
  H=$(kubectl -n cnpg-system get lease -o jsonpath='{.items[0].spec.holderIdentity}' 2>/dev/null | cut -d_ -f1)
  if [ -n "$H" ] && [ "$H" != "$LEADER" ]; then echo "new leader: $H"; break; fi
  [ $(( $(date +%s) - START )) -gt 180 ] && { echo TIMEOUT; break; }
  sleep 2
done
echo $(( $(date +%s) - START )) > /root/takeover-seconds.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT now();"
kubectl -n cnpg-system get pods`,
    },

    {
      id: 'followers-are-idle',
      title: 'Confirm the followers were doing nothing',
      limitSec: 420,
      criteria: [
        "A non-leader Pod's log shows it waiting to acquire the Lease",
        'Reconciliation still works — the cluster has all 3 instances',
        'The cluster is healthy',
      ],
      brief: `Finish by checking the claim that makes this safe: that the replicas which do not hold the Lease are genuinely idle.

Read a follower's log. It says it is attempting to acquire the leader lease, and nothing else — no reconciliation, no writes to any Cluster. That is what stops three operators from fighting over the same database.

Then prove the survivor is really working, by giving it something to do: delete an instance Pod and watch it be recreated.`,
      instructions: `Find a Pod that is not the leader, and read its log:

\`\`\`
LEADER=$(kubectl -n cnpg-system get lease -o jsonpath='{.items[0].spec.holderIdentity}' | cut -d_ -f1)
echo "leader: $LEADER"
kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg
FOLLOWER=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{range .items[*]}{.metadata.name}{"\\n"}{end}' | grep -v "^$LEADER$" | head -1)
echo "follower: $FOLLOWER"
kubectl -n cnpg-system logs $FOLLOWER --tail=20
\`\`\`

Its last line is an attempt to acquire the leader lease. It has connected, it is watching, and it is deliberately doing nothing else.

Now make sure the leader really is reconciling — delete an instance and watch it come back:

\`\`\`
kubectl delete pod pg-cluster-3 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

Recreated, and the cluster is healthy again — the surviving replicas took over the work as well as the Lease.`,
      hint: `The follower is any \`cnpg-controller-manager-*\` Pod whose name is not the Lease holder. If its log has scrolled past the message, \`--tail=50\` usually brings it back — it retries continuously.`,
      solution: `LEADER=$(kubectl -n cnpg-system get lease -o jsonpath='{.items[0].spec.holderIdentity}' | cut -d_ -f1)
FOLLOWER=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{range .items[*]}{.metadata.name}{"\\n"}{end}' | grep -v "^$LEADER$" | head -1)
kubectl -n cnpg-system logs $FOLLOWER --tail=20
kubectl delete pod pg-cluster-3 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster`,
    },
  ],
}
