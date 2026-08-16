// The phase string a degraded cluster reports, the recovery timings and the fact that no
// promotion happens are confirmed live against a real K3D + CloudNativePG deploy (server/,
// see LABORATORY.md): a deleted replica showed ready=2 within 2 seconds and the cluster was
// healthy again 15 seconds after the deletion, on the same timeline, with the same primary.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a
// client Pod are this lab's starting state, built by its own provisioning. No reference to
// any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgDegradedRecovery = {
  id: 'cnpg-degraded-recovery',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster with real streaming replication, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here. It is also why the recovery you time is a real recovery.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" with 3 of 3 ready — one primary and two replicas streaming from it, on timeline 1',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      'Nothing is broken yet, and the database is empty. A cluster missing an instance is degraded, not failed: it still has a primary, it still takes writes, and it is one instance short of the redundancy it was asked for. You will destroy a replica, time how long the operator takes to put the cluster back to three of three, and then prove that what you watched was a rebuild and not a failover — same primary, same timeline, no promotion anywhere.',
  },

  tasks: [
    {
      id: 'observe-and-write',
      title: 'Record what healthy looks like',
      limitSec: 420,
      criteria: [
        'All 3 instances are ready',
        'Two replicas are streaming from the primary',
        "A row noted 'before-degradation' exists",
        '/root/degraded-target.txt was written',
        'It names one of the two replicas, not the primary',
      ],
      brief: `Before breaking anything, write down what "healthy" means here, so the recovery is measurable rather than impressive.

Confirm the cluster reports three of three ready and that both replicas are streaming. Write a row noted \`before-degradation\` so you can tell afterwards that nothing was lost. Then choose which replica you are going to destroy and record its name in \`/root/degraded-target.txt\`.

Choose a replica, not the primary. Losing a replica is the case this lab is about: the cluster is degraded but fully functional, and the operator's job is to restore redundancy without disturbing anything else.`,
      instructions: `Look at the cluster's own summary, and at the roles it has assigned:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

READY reads 3, and exactly one Pod is labelled \`primary\`. Ask the primary who is streaming from it — replication statistics are privileged, so connect as the superuser over the Pod's own socket:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Two rows, both streaming. Now write the row whose survival you will check afterwards:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE degraded_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO degraded_proof (note) VALUES ('before-degradation') RETURNING *;"
\`\`\`

And record which replica you intend to destroy — either of the two will do:

\`\`\`
echo pg-cluster-3 > /root/degraded-target.txt
\`\`\`

Note the timeline as well, because it is the number that will prove no promotion happened:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
\`\`\``,
      hint: `Name one of the Pods that \`kubectl get pods -L cnpg.io/instanceRole\` marks \`replica\`. Recording the primary's name is the one answer that cannot work — destroying it would be a failover, which is a different scenario entirely.`,
      solution: `kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE degraded_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO degraded_proof (note) VALUES ('before-degradation') RETURNING *;"
echo pg-cluster-3 > /root/degraded-target.txt
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'`,
      },

    {
      id: 'degrade-and-time',
      title: 'Destroy the replica and time the recovery',
      limitSec: 480,
      criteria: [
        '/root/recovery-seconds.txt was written',
        'It records a recovery time under 60 seconds',
        'The instance you deleted is running again',
        'The cluster reports healthy with 3 of 3 ready',
      ],
      brief: `Destroy the replica you chose and time how long the cluster takes to report three of three ready again. Record that number in \`/root/recovery-seconds.txt\`.

Do the deletion and the timing in one block, in a single terminal tab, so the clock starts at the deletion rather than at whenever you managed to switch tabs.

The loop below waits for two things in order: first for the cluster to actually report fewer than three ready — otherwise you would time nothing, because the status takes a moment to catch up with reality — and then for it to be healthy again. What you are measuring is the whole round trip, from destruction to restored redundancy.`,
      instructions: `Run this as one block, in a single terminal tab:

\`\`\`
TARGET=$(cat /root/degraded-target.txt)
START=$(date +%s); DEGRADED=""
kubectl delete pod $TARGET --wait=false
while true; do
  R=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.readyInstances}')
  P=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.phase}')
  NOW=$(date +%s)
  [ "$R" != "3" ] && [ -z "$DEGRADED" ] && DEGRADED=1 && echo "degraded after $((NOW-START))s: ready=$R phase=$P"
  [ -n "$DEGRADED" ] && [ "$R" = "3" ] && [ "$P" = "Cluster in healthy state" ] && break
  sleep 2
done
echo $(( $(date +%s) - START )) > /root/recovery-seconds.txt
cat /root/recovery-seconds.txt
\`\`\`

Watch the phase it passes through on the way: READY drops to 2 and the status reads "Waiting for the instances to become active" — the cluster's own words for degraded. It never stops serving: there is still a primary, and \`pg-cluster-rw\` never moved.

The recovery is quick because nothing has to be re-cloned. The Pod was deleted, not its storage, so the replacement Pod reattaches to the same PersistentVolumeClaim and catches up by replaying the WAL it missed.

Confirm where it ended up:

\`\`\`
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get pvc
\`\`\``,
      hint: `If the loop exits immediately with a very small number, the cluster status had not caught up with the deletion yet — that is what the \`DEGRADED\` guard is for, so run the whole block rather than the parts.`,
      solution: `TARGET=$(cat /root/degraded-target.txt)
START=$(date +%s); DEGRADED=""
kubectl delete pod $TARGET --wait=false
while true; do
  R=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.readyInstances}')
  P=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.phase}')
  NOW=$(date +%s)
  [ "$R" != "3" ] && [ -z "$DEGRADED" ] && DEGRADED=1 && echo "degraded after $((NOW-START))s: ready=$R phase=$P"
  [ -n "$DEGRADED" ] && [ "$R" = "3" ] && [ "$P" = "Cluster in healthy state" ] && break
  sleep 2
done
echo $(( $(date +%s) - START )) > /root/recovery-seconds.txt
kubectl get pods -o wide -L cnpg.io/instanceRole`,
    },

    {
      id: 'no-failover',
      title: 'Prove no failover happened',
      limitSec: 300,
      criteria: [
        'The primary never changed',
        'The cluster is still on its original timeline',
        'Both replicas are streaming again',
      ],
      brief: `Now show what did *not* happen, which is the real lesson.

The primary is the same instance it was before you destroyed anything. The timeline is unchanged. No instance was promoted, the write endpoint never moved, and any client holding a connection to the primary never noticed.

Losing a replica costs redundancy, not availability. A cluster that responds to every instance failure with a promotion would be far more disruptive than one that only promotes when the primary itself is gone.`,
      instructions: `Check who is primary now:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole
\`\`\`

The same instance as before. And the timeline:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
\`\`\`

Still 1. A promotion always starts a new timeline, so an unchanged timeline is proof that none happened — the cluster repaired itself without any change of leadership.

Confirm replication is back to full strength:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Two rows again, both streaming, including the instance you destroyed.`,
      hint: `Run \`pg_stat_replication\` against the Pod that is currently marked \`primary\` — on a replica the view is empty, because nothing streams from it.`,
      solution: `kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"`,
    },

    {
      id: 'confirm-data',
      title: 'Confirm nothing was lost',
      limitSec: 300,
      criteria: [
        "The 'before-degradation' row is intact on all 3 instances",
        "A row noted 'after-recovery' reached the primary through pg-cluster-rw",
      ],
      brief: `Finish by checking the data, on every instance rather than through a Service that would pick a convenient one for you.

The row you wrote before the degradation should be on all three instances, including the one you destroyed — it came back, reattached to its own storage, and replayed what it missed.

Then write a second row through the read-write Service to show the cluster is fully operational again, not merely reporting healthy.`,
      instructions: `Ask each instance directly what it holds:

\`\`\`
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT note FROM degraded_proof ORDER BY id;"; done
\`\`\`

All three have the \`before-degradation\` row. Now write again through the Service:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO degraded_proof (note) VALUES ('after-recovery') RETURNING *;"
\`\`\`

And confirm it landed everywhere:

\`\`\`
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM degraded_proof;"; done
\`\`\`

Two rows on each. The cluster is back to the redundancy it was asked for, and never stopped taking writes while it got there.`,
      hint: `If an instance reports "relation does not exist", it has not finished catching up — give it a few seconds and ask again.`,
      solution: `for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT note FROM degraded_proof ORDER BY id;"; done
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO degraded_proof (note) VALUES ('after-recovery') RETURNING *;"
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM degraded_proof;"; done`,
    },
  ],
}
