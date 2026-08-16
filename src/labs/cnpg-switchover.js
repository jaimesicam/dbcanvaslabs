// The plugin command, the phases it moves through and the demotion behaviour below are
// confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md).
// Grading runs server-side, against the real cluster, comparing what is true now against
// the primary and volume this environment was built with.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, the cnpg
// plugin and a client Pod are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgSwitchover = {
  id: 'cnpg-switchover',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster with real streaming replication, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time, and the cnpg plugin is fetched and installed on every node.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — one primary and two replicas streaming from it asynchronously, on timeline 1, each with its own PersistentVolumeClaim',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      'Nothing is broken, and nothing is going to break: this is the planned move, the one you would perform before draining a node or patching a kernel. You will check the replicas are caught up, choose which one should take over, hand the role across deliberately, and then confirm the old primary came back as a replica on its own original volume rather than being rebuilt from scratch.',
  },

  tasks: [
    {
      id: 'survey-and-write',
      title: 'Check the replicas and choose a successor',
      limitSec: 420,
      criteria: [
        'Both replicas are streaming and caught up',
        "A row noted 'before-switchover' exists",
        '/root/switchover-target.txt was written',
        'It names one of the two replicas, not the instance that is primary',
      ],
      brief: `A switchover is a planned handover, so it begins with a check that a handover is safe: is there a replica caught up enough to take over without losing anything?

Ask the primary about its replicas — their state, and how far behind they are replaying. Then write a row noted \`before-switchover\`, so that afterwards you can prove nothing was dropped in the move.

Finally, choose which replica should take over and record its name in \`/root/switchover-target.txt\`. Choosing, rather than being handed a successor, is the whole difference between this and an unplanned failover.`,
      instructions: `Look at the cluster and the roles it has assigned:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole -o wide
\`\`\`

The plugin gives you the same picture with replication included:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\`

Read the Streaming Replication section: both replicas \`streaming\`, all four LSN columns matching the primary's, and the lag columns at zero. That is what "safe to hand over" looks like.

The authoritative version of the same question, asked of PostgreSQL directly:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Now write the row that has to survive the move:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE switchover_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO switchover_proof (note) VALUES ('before-switchover') RETURNING *;"
\`\`\`

And record which instance you intend to promote — either replica will do:

\`\`\`
echo pg-cluster-2 > /root/switchover-target.txt
\`\`\``,
      hint: `Ask \`kubectl get pods -L cnpg.io/instanceRole\` which Pod is \`primary\`, and name one of the other two. Recording the current primary's own name is the one answer that cannot work.`,
      solution: `kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole -o wide
kubectl cnpg status pg-cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication ORDER BY application_name;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE switchover_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO switchover_proof (note) VALUES ('before-switchover') RETURNING *;"
echo pg-cluster-2 > /root/switchover-target.txt`,
    },

    {
      id: 'promote',
      title: 'Hand the primary role across',
      limitSec: 420,
      criteria: [
        'The primary moved to the instance you named',
        'It is no longer the instance that was primary when this environment was built',
        'Cluster reports healthy again',
      ],
      brief: `Now perform the switchover: tell the operator which instance should be primary, and let it carry out the handover.

What follows is deliberately different from a crash. The current primary is shut down cleanly first, so it stops accepting writes and flushes everything it has; only then is your chosen replica promoted, having replayed the last of that WAL. That ordering is why a planned switchover loses nothing at all.

Watch the cluster's status while it happens. It leaves the healthy state, reports a switchover in progress, and comes back healthy with a different instance in charge — typically in well under a minute.`,
      instructions: `One command, naming the cluster and the instance that should take over:

\`\`\`
kubectl cnpg promote pg-cluster pg-cluster-2
\`\`\`

It reports that the instance will be promoted and returns immediately — the work is the operator's. Watch it:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole -o wide
\`\`\`

The status moves to "Switchover in progress" while the old primary shuts down cleanly and the chosen replica is promoted, then back to "Cluster in healthy state" with your instance labelled \`primary\`. The read-write Service follows within a couple of seconds of the promotion:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
\`\`\`

And the timeline has advanced from 1 to 2, exactly as it would after an unplanned promotion — a switchover is still a promotion, just a tidy one:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
\`\`\`

Underneath, the plugin did something you could have done by hand: it set the cluster's target primary to the instance you named, and the operator reconciled reality to match.`,
      hint: `The argument order is the cluster first, then the instance: \`kubectl cnpg promote pg-cluster <instance>\`. Promote the instance you recorded — grading compares the two.`,
      solution: `kubectl cnpg promote pg-cluster pg-cluster-2
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole -o wide
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'`,
    },

    {
      id: 'old-primary-rejoined',
      title: 'Confirm the old primary was demoted, not rebuilt',
      limitSec: 420,
      criteria: [
        'The original primary is running as a replica',
        'It is streaming from the new primary',
        'It reused its original volume — it was demoted, not re-cloned',
      ],
      brief: `The instance that used to be primary is still here. Find out what happened to it.

It restarted once and came back as a replica, streaming from the instance you promoted. What it did *not* do is take a fresh copy of the database: it kept its own PersistentVolumeClaim, with the data already on it, and simply followed the new timeline from the point where the two diverged.

That distinction is the difference between a switchover costing seconds and costing as long as a full base backup. Check the volume behind it and confirm it is the same one it always had.`,
      instructions: `Look at the instance that used to be primary:

\`\`\`
kubectl get pods -L cnpg.io/instanceRole -o wide
\`\`\`

It is \`Running\`, labelled \`replica\`, with a restart count of 1 — the clean shutdown and restart that demoted it. Ask the new primary who is streaming from it:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Both other instances are there, the former primary among them.

Now the part worth checking properly — the storage:

\`\`\`
kubectl get pvc
\`\`\`

Each instance still has exactly one claim, named after it, with the same age as at the start. Nothing was deleted and nothing was re-provisioned: the demoted instance reattached to the volume it already had, and caught up by replaying WAL rather than by cloning the database again.

The plugin's own view says the same thing in one screen:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\``,
      hint: `Substitute the Pod now marked \`primary\` when asking for \`pg_stat_replication\` — on the demoted instance that view is empty, because it no longer has anyone streaming from it.`,
      solution: `kubectl get pods -L cnpg.io/instanceRole -o wide
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
kubectl get pvc
kubectl cnpg status pg-cluster`,
    },

    {
      id: 'writes-follow',
      title: 'Confirm writes follow, and nothing was lost',
      limitSec: 360,
      criteria: [
        "The 'before-switchover' row is intact on the new primary",
        "A row noted 'after-switchover' reached the new primary through pg-cluster-rw",
        'All 3 instances see both rows',
      ],
      brief: `Finish by proving the two things a planned handover is judged on: nothing was lost, and writes work again immediately.

Read your earlier row back through the read-write Service — which now resolves to a different instance than when you wrote it — then write a second row noted \`after-switchover\` through that same unchanged Service name.

Then ask all three instances what they see. Both rows, everywhere, including on the demoted instance that is now replicating from a database it used to be the source of.`,
      instructions: `Read the row you wrote before the switchover, through the Service:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM switchover_proof;"
\`\`\`

The client's configuration never changed, and it is now talking to a different instance. Write again through the same name:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO switchover_proof (note) VALUES ('after-switchover') RETURNING *;"
\`\`\`

Now ask each instance directly, so no Service can pick a convenient answer for you:

\`\`\`
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT note FROM switchover_proof ORDER BY id;"; done
\`\`\`

Three instances, both rows on each. The one that used to be primary now holds a row it never received as a primary — it replayed it as a replica, from the instance it used to feed.`,
      hint: `If \`SELECT\` works but the \`INSERT\` is refused as read-only, you are dialling \`pg-cluster-ro\` rather than \`pg-cluster-rw\`.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM switchover_proof;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO switchover_proof (note) VALUES ('after-switchover') RETURNING *;"
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT note FROM switchover_proof ORDER BY id;"; done`,
    },
  ],
}
