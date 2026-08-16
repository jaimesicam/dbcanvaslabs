// The image tags, the roll order and the in-place primary restart are confirmed live against
// a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). This lab's environment
// deliberately starts on ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie so the upgrade
// to 18.4 is a real image change rather than a no-op re-apply, and both images are pre-seeded
// into every node so the roll is not waiting on a registry. Grading reads spec.imageName, the
// images the Pods are actually running, the server version and the data.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster on the older image,
// the cnpg plugin, a client Pod and the toolbox are this lab's starting state, built by its
// own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgRollingUpdate = {
  id: 'cnpg-rolling-update',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster on a deliberately older image, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, and both image versions are pulled and pushed into every node so the upgrade is not waiting on a download.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster running ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie — one minor release behind, on purpose',
      'The newer image, ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie, already imported into all three nodes, so the roll starts immediately rather than pulling',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'This database is running a PostgreSQL minor release older than the one you want. You will record exactly what is running, change one field to move it forward, and watch the operator roll the change through the cluster instance by instance — then account for what it cost: which Pods were replaced, which was not, and whether anything was lost. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'survey-the-version',
      title: 'Record what is running before you change it',
      limitSec: 420,
      criteria: [
        'The cluster is running the 18.3 image it was built with',
        'PostgreSQL reports a matching server version',
        '/root/before-image.txt was written',
        'It records the image the cluster started on',
      ],
      brief: `An upgrade is only verifiable against a baseline, so take one properly.

Read the image from three places, because they can disagree and each disagreement means something different: what the Cluster spec asks for, what the Pods are actually running, and what PostgreSQL itself reports as its server version.

The middle one is the one people forget. A spec naming a new image while the Pods still run the old one is not a broken cluster — it is a roll in progress, and telling those apart at a glance is the skill this objective is building.

Write a row too. It is the thing you will check at the end.`,
      instructions: `Work in the **toolbox** tab. What the spec asks for:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.imageName}{"\\n"}'
\`\`\`

What the Pods are running — from their container *status*, not their spec:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,AGE:.metadata.creationTimestamp
\`\`\`

And what PostgreSQL says about itself:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT version();"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT current_setting('server_version');"
\`\`\`

All three agree on 18.3. Record the image:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.imageName}' > /root/before-image.txt
cat /root/before-image.txt
\`\`\`

Leave a row to find afterwards:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE upgrade_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_demo (note) VALUES ('before-upgrade') RETURNING *;"
\`\`\`

One more baseline worth having — the Pod creation timestamps:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,CREATED:.metadata.creationTimestamp
\`\`\`

Note which instance is primary. After the roll you will compare these timestamps and find that not every instance was treated the same way.`,
      hint: `\`.status.containerStatuses[0].image\` is what a Pod is running; \`.spec.containers[0].image\` is what it was asked to run. During a roll those differ, which is exactly when you most want to know.`,
      solution: `kubectl get cluster pg-cluster -o jsonpath='{.spec.imageName}{"\\n"}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,AGE:.metadata.creationTimestamp
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT current_setting('server_version');"
kubectl get cluster pg-cluster -o jsonpath='{.spec.imageName}' > /root/before-image.txt
cat /root/before-image.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE upgrade_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_demo (note) VALUES ('before-upgrade') RETURNING *;"`,
    },

    {
      id: 'roll-the-image',
      title: 'Change the image and watch it roll',
      limitSec: 720,
      criteria: [
        'spec.imageName now names the 18.4 image',
        'All 3 instance Pods are running that image',
        'PostgreSQL reports the new server version',
        'The cluster is healthy with 3 of 3 ready',
      ],
      brief: `Upgrading a PostgreSQL minor release here is changing one field. The operator does the rest, and the order it chooses is the whole design: replicas first, one at a time, primary last.

That order is what keeps the database usable throughout. Each replica is replaced while the primary keeps serving; only at the very end does the instance handling writes have to change.

Watch it happen rather than waiting for it to finish. There is a window where the spec names the new image and some Pods are still on the old one, and seeing that state is worth more than the end result.

A minor release upgrade like this needs no data migration — the on-disk format is compatible, so an instance starts on the same data directory with a newer binary.`,
      instructions: `Change the image:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}}'
\`\`\`

Now look immediately, and keep looking:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,READY:.status.containerStatuses[0].ready
kubectl get cluster pg-cluster
\`\`\`

A mixture: some instances on 18.4, some still on 18.3, and the cluster reporting itself not ready while it works through them. That mixed state is normal and is exactly what a rolling update is.

The database stays usable throughout. Prove it rather than assuming it — run this while the roll is still going:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now(), 'still serving';"
\`\`\`

Wait for it to finish:

\`\`\`
sleep 150
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,RESTARTS:.status.containerStatuses[0].restartCount,CREATED:.metadata.creationTimestamp
\`\`\`

All three on 18.4 and healthy. Confirm from inside the database:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT version();"
\`\`\`

Now compare the creation timestamps against the baseline you took. Every instance has a new Pod, because an image change *cannot* be done in place — the container has to be recreated to run a different image. That is the difference from a configuration change, where the primary's PostgreSQL can be restarted inside its existing container.

Which instance is primary now?

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}{"\\n"}'
kubectl get cluster pg-cluster -o json | jq '{primaryUpdateMethod: .spec.primaryUpdateMethod, primaryUpdateStrategy: .spec.primaryUpdateStrategy}'
\`\`\`

With the default \`primaryUpdateMethod\` of \`restart\`, the primary keeps its role and its Pod is recreated last. Setting it to \`switchover\` instead would promote an already-upgraded replica and demote the old primary — less write downtime, but the primary moves. Worth choosing deliberately rather than discovering during a maintenance window.`,
      hint: `Run the mixed-state check within the first 20–30 seconds of patching. If you miss it, \`kubectl get events --sort-by=.lastTimestamp | tail -20\` still shows the instances being upgraded one at a time.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,READY:.status.containerStatuses[0].ready
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now(), 'still serving';"
sleep 150
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,CREATED:.metadata.creationTimestamp
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT version();"`,
    },

    {
      id: 'data-intact',
      title: 'Account for what the upgrade cost',
      limitSec: 420,
      criteria: [
        'The row written before the upgrade survived it',
        'A row written after the upgrade was accepted',
        'Both replicas are streaming on the new image',
      ],
      brief: `Finish by checking the three things an upgrade could plausibly have broken: the data, the ability to write, and replication.

The data is on the PersistentVolumeClaims, which were never touched — a new Pod attached to the same volume. That is why a minor upgrade is cheap: no dump, no restore, no migration.

Replication is the one worth confirming explicitly. The instances were replaced one at a time and each had to reconnect to the primary afterwards, so a cluster that is healthy but not actually streaming would be a real and quiet failure.`,
      instructions: `The row from before:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM upgrade_demo ORDER BY id;"
\`\`\`

Still there, on a database whose every process has been replaced since it was written. Write another:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_demo (note) VALUES ('after-upgrade') RETURNING *;"
\`\`\`

Now replication:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sent_lsn, replay_lsn FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Both standbys streaming, with replay positions tracking the primary's. Check a replica has the new row, which is the end-to-end proof:

\`\`\`
sleep 5
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -c "SELECT * FROM upgrade_demo ORDER BY id;"
\`\`\`

And the volumes, which are the reason none of this cost anything:

\`\`\`
kubectl get pvc
\`\`\`

Their ages predate the upgrade. The Pods are new; the storage is not.

Finally, the whole picture in one command:

\`\`\`
kubectl cnpg status pg-cluster | head -18
\`\`\`

One field changed, every instance replaced, no data moved and no downtime for readers. That is what makes minor-version upgrades routine — and it is worth contrasting with a *major* version upgrade, which changes the on-disk format and is a different operation entirely, not a rolling update.`,
      hint: `Query a replica directly with \`kubectl exec\` rather than through the \`-ro\` Service, so you know which instance answered — the point is that a specific replica caught up after being replaced.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM upgrade_demo ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_demo (note) VALUES ('after-upgrade') RETURNING *;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state, sent_lsn, replay_lsn FROM pg_stat_replication ORDER BY application_name;"
sleep 5
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -c "SELECT * FROM upgrade_demo ORDER BY id;"
kubectl get pvc
kubectl cnpg status pg-cluster | head -18`,
    },
  ],
}
