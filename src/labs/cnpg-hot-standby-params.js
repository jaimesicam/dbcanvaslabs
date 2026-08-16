// The parameter set, the control-file channel and the roll order are confirmed live against
// a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). `pg_controldata` on a
// standby reports the *primary's* values — max_connections, max_worker_processes,
// max_wal_senders, max_prepared_xacts, max_locks_per_xact — learned from the WAL rather than
// from its own configuration. Raising max_connections 100 → 200 rolled the standbys first
// (pg-cluster-3 then pg-cluster-2 went not-ready) with the primary's postmaster restarted in
// place; lowering it again rolled in the same order.
//
// A hypothesis tested and disproved while building this: the roll order does NOT reverse for
// a decrease. It is always replicas first — which is the order the dangerous direction needs.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster, the cnpg plugin, a
// client Pod and the toolbox are this lab's starting state, built by its own provisioning.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgHotStandbyParams = {
  id: 'cnpg-hot-standby-params',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, each with the configuration the operator generated for them.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster with one primary and two streaming standbys, running entirely on generated configuration — no parameters were set in its manifest',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A handful of PostgreSQL settings are different from all the others: a standby is not allowed to hold them at a lower value than its primary, and one that does refuses to serve reads at all. You will find out which settings those are, discover the channel by which a standby learns the primary’s values — which is not its configuration file — and then change one and watch the operator roll the cluster in the only order that is safe. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'find-the-parameters',
      title: 'Find the settings a standby is not allowed to under-provision',
      limitSec: 480,
      criteria: [
        'The five hot-standby-sensitive parameters agree on the primary and a standby',
        "The standby's control file records the primary's max_connections",
        '/root/control-file.txt was written',
        'It captured the value the control file is holding',
      ],
      brief: `Five PostgreSQL settings govern fixed-size shared memory structures that recovery has to replay into: \`max_connections\`, \`max_worker_processes\`, \`max_wal_senders\`, \`max_prepared_transactions\` and \`max_locks_per_transaction\`.

A standby must hold each of them at a value **no lower** than its primary. If it does not, it cannot start hot standby — it refuses to accept read connections, naming the offending setting and the primary's value.

Which raises the question this objective is really about: how does a standby know what the primary's value is? Not from its configuration file, and not by asking. Find the channel — it is on disk, and \`pg_controldata\` will show it to you.`,
      instructions: `Work in the **toolbox** tab. Read the five settings on the primary and on a standby:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
echo "primary: $PRIMARY"
for POD in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  echo "-- $POD"
  kubectl exec $POD -c postgres -- psql -U postgres -tAc \\
    "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('max_connections','max_worker_processes','max_wal_senders','max_prepared_transactions','max_locks_per_transaction') ORDER BY name;"
done
\`\`\`

Identical everywhere, because the operator generates one configuration for the whole cluster. That is not a coincidence — it is the operator keeping the rule satisfied for you.

Now the channel. Ask a **standby** what it believes the primary's values are:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata \\
  | grep -E "max_connections|max_worker_processes|max_wal_senders|max_prepared_xacts|max_locks_per_xact"
\`\`\`

Those lines are in the standby's **control file**, and they are the *primary's* values, not its own. PostgreSQL writes a parameter-change record into the WAL whenever one of these settings changes, and a standby replaying that record updates its control file. That is how the limits travel: through the write-ahead log, like everything else.

Note the two abbreviated names — \`max_prepared_xacts\` and \`max_locks_per_xact\` — which is a small trap when you go looking for them.

Record what the standby is holding:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata \\
  | grep "max_connections setting:" > /root/control-file.txt
cat /root/control-file.txt
\`\`\`

Compare it against the standby's *own* setting, which is a different number in principle even though it matches today:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -tAc "SHOW max_connections;"
\`\`\`

Same value. The rule PostgreSQL enforces at startup is that its own setting must be greater than or equal to the control-file value — so equal is fine, higher is fine, and lower is fatal.`,
      hint: `\`pg_controldata\` is a binary that reads the control file directly, so it works whether or not PostgreSQL is running. The data directory is \`/var/lib/postgresql/data/pgdata\`.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
for POD in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  echo "-- $POD"
  kubectl exec $POD -c postgres -- psql -U postgres -tAc "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('max_connections','max_worker_processes','max_wal_senders','max_prepared_transactions','max_locks_per_transaction') ORDER BY name;"
done
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep -E "max_connections|max_worker_processes|max_wal_senders|max_prepared_xacts|max_locks_per_xact"
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep "max_connections setting:" > /root/control-file.txt
cat /root/control-file.txt
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -tAc "SHOW max_connections;"`,
    },

    {
      id: 'raise-the-limit',
      title: 'Raise one, and watch the order it is done in',
      limitSec: 720,
      criteria: [
        'max_connections is declared as 200',
        'The primary and the standby are both running 200',
        "The standby's control file followed the primary up to 200",
        'The cluster came back healthy with 3 of 3 ready',
      ],
      brief: `Raise \`max_connections\` and watch which instances restart first.

The answer is standbys first, primary last — and for these five settings that order is not a preference, it is the only safe one. Raising the primary first would leave both standbys holding a value below the primary's, and the moment they replayed the parameter-change record they would refuse to serve reads.

Doing the standbys first means they are already at the higher value when the primary arrives there. At no point is any standby under-provisioned relative to its primary.

Watch the roll, then check the control file again: it should have followed.`,
      instructions: `Raise it:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"parameters":{"max_connections":"200"}}}}'
\`\`\`

Watch which instance goes not-ready first — sample quickly, the window is short:

\`\`\`
for i in 1 2 3 4 5 6; do
  kubectl get pods -l cnpg.io/cluster=pg-cluster \\
    -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready --no-headers | tr '\\n' ' '
  echo
  sleep 10
done
\`\`\`

The standbys go first, one at a time. Wait for it to settle:

\`\`\`
sleep 120
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,CREATED:.metadata.creationTimestamp
\`\`\`

Note the primary: its Pod was not recreated and its restart count is still 0. The operator restarts PostgreSQL inside the running container rather than replacing the Pod, which is the default \`primaryUpdateMethod\`.

Now confirm every instance is at the new value:

\`\`\`
for POD in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  printf "%s " $POD; kubectl exec $POD -c postgres -- psql -U postgres -tAc "SHOW max_connections;"
done
\`\`\`

And the channel from the first objective — the standby's control file should have followed the primary up:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata \\
  | grep "max_connections setting:"
\`\`\`

200, arriving through the WAL. The standby's own setting is also 200, so the rule holds with equality — which is exactly where the operator's roll order put it.`,
      hint: `Sample the Pods within the first 20–30 seconds of patching, or the roll is over before you look. If you miss it, the creation timestamps afterwards still give the order away.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"max_connections":"200"}}}}'
for i in 1 2 3 4 5 6; do
  kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready --no-headers | tr '\\n' ' '; echo; sleep 10
done
sleep 120
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,CREATED:.metadata.creationTimestamp
for POD in pg-cluster-1 pg-cluster-2 pg-cluster-3; do printf "%s " $POD; kubectl exec $POD -c postgres -- psql -U postgres -tAc "SHOW max_connections;"; done
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep "max_connections setting:"`,
    },

    {
      id: 'lower-it-again',
      title: 'Lower it, and find out whether the order changes',
      limitSec: 600,
      criteria: [
        'max_connections is back to 100 on the primary',
        "The standby's control file followed it back down",
        'Every sensitive parameter agrees across instances again',
      ],
      brief: `Lowering one of these settings is the *safe* direction: a standby holding a value above its primary's breaks nothing, because the rule is only violated by being lower.

So it is reasonable to expect the operator to reverse the order — primary first, standbys after — since that is what a decrease would allow.

It does not. The order is the same either way: standbys first, primary last. Worth confirming yourself rather than taking it on trust, and worth understanding why it is fine — one order is safe in both directions, so there is nothing to gain from having two.`,
      instructions: `Put it back:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"parameters":{"max_connections":"100"}}}}'
\`\`\`

Sample the order again, exactly as before:

\`\`\`
for i in 1 2 3 4 5 6; do
  kubectl get pods -l cnpg.io/cluster=pg-cluster \\
    -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready --no-headers | tr '\\n' ' '
  echo
  sleep 10
done
\`\`\`

Standbys first again. Wait it out and check the result:

\`\`\`
sleep 120
kubectl get cluster pg-cluster
for POD in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  printf "%s " $POD; kubectl exec $POD -c postgres -- psql -U postgres -tAc "SHOW max_connections;"
done
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata \\
  | grep "max_connections setting:"
\`\`\`

Everything back at 100, control file included.

One last look at the whole set, to leave the cluster in a state you have actually verified rather than assumed:

\`\`\`
for POD in pg-cluster-1 pg-cluster-2; do
  echo "-- $POD"
  kubectl exec $POD -c postgres -- psql -U postgres -tAc \\
    "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('max_connections','max_worker_processes','max_wal_senders','max_prepared_transactions','max_locks_per_transaction') ORDER BY name;"
done
\`\`\`

So the practical rule to carry away: you never hand-manage these five in a CloudNativePG cluster, because the operator applies one configuration to every instance and rolls them in an order that keeps the standbys' values from ever falling behind. Where it bites is anywhere *outside* that — a standby you built yourself, or a restore onto a machine configured more modestly than the primary it came from.`,
      hint: `Expect the same order as the increase. If you were hoping to see it reverse, that hypothesis is worth testing and discarding — which is what this objective is for.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"max_connections":"100"}}}}'
for i in 1 2 3 4 5 6; do
  kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready --no-headers | tr '\\n' ' '; echo; sleep 10
done
sleep 120
for POD in pg-cluster-1 pg-cluster-2 pg-cluster-3; do printf "%s " $POD; kubectl exec $POD -c postgres -- psql -U postgres -tAc "SHOW max_connections;"; done
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep "max_connections setting:"`,
    },
  ],
}
