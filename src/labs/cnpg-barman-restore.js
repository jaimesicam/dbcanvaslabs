// The recovery bootstrap, the externalClusters plugin block and the fact that WAL replay
// carries the restore past the base backup are confirmed live against a real K3D +
// CloudNativePG + SeaweedFS deploy (server/, see LABORATORY.md): a row written after the
// base backup was taken really did appear in the restored cluster. Grading reads the
// restored cluster's own data and its bootstrap spec.
//
// Self-contained, like every lab here: the operator, the Barman Cloud plugin, a cluster
// already archiving WAL and a base backup already in the bucket are this lab's starting
// state, built by its own provisioning. No reference to any other lab (see CLAUDE.md,
// "Lab content contract").

export const cnpgBarmanRestore = {
  id: 'cnpg-barman-restore',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real S3-compatible object store beside it holding a real base backup, and a real PostgreSQL cluster archiving its WAL there continuously. All of it is thrown away when you finish. Nothing is simulated, which is why this is one of the longest builds of the set: cert-manager and the Barman Cloud plugin are installed and waited for, the database is bootstrapped, archiving is switched on, and a base backup is taken before you arrive.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage), published inside the cluster as the Service seaweedfs on port 8333, with a cnpg-backups bucket',
      'The CloudNativePG v1.30.0 operator, cert-manager v1.19.1 and the Barman Cloud plugin v0.14.0, all installed and Running',
      'A healthy 3-instance Cluster named pg-cluster, already archiving WAL to the bucket through the plugin, with an ObjectStore named seaweedfs-store describing the destination',
      'A completed Backup named base-backup — a real base backup, taken while this environment was built, sitting in the bucket',
      'The cnpg kubectl plugin v1.30.0 on all three nodes, a psql-client Pod with the app credentials, and a recovery manifest staged at /root/restore.yaml — written, but deliberately not applied',
    ],
    yourJob:
      'The backup exists and the archive is filling, and nothing has ever been restored from either. You will write a row *after* the base backup was taken, then bring up a second cluster that recovers from the object store — and find your row in it, which it can only have got by replaying WAL the base backup does not contain.',
  },

  tasks: [
    {
      id: 'survey-the-archive',
      title: 'See what you have to restore from',
      limitSec: 420,
      criteria: [
        'The cluster is archiving WAL to the object store',
        'A completed Backup already exists',
        'The bucket holds a base backup',
        "A row noted 'after-backup' exists",
      ],
      brief: `A restore needs two things, and it is worth confirming both before trusting either: a base backup to start from, and a WAL archive to replay forward from it.

Look at what already exists here — a completed Backup, a continuously working archive, and the cluster's own report of how far back it could recover to. Then write a row noted \`after-backup\`.

That row is the point of the whole lab. It is committed *after* the base backup was taken, so it exists only in the WAL archive. If it turns up in the restored cluster, the restore demonstrably replayed WAL rather than just unpacking a backup.`,
      instructions: `Start with the cluster's own account of its backups:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\`

The "Continuous Backup status" section names the object store, gives a "First Point of Recoverability" and a "Last Successful Backup", and reports "Working WAL archiving: OK". Those two timestamps are the edges of your recovery window.

Confirm the pieces separately:

\`\`\`
kubectl get backup
kubectl get objectstore
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\\n"}{end}'
\`\`\`

\`ContinuousArchiving=True\` is the operator confirming a WAL file really reached the bucket — not that the configuration looks right.

Now write the row that the base backup cannot possibly contain:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE restore_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO restore_proof (note) VALUES ('after-backup') RETURNING *;"
\`\`\`

Push it into the archive rather than waiting for a segment to fill on its own — switching WAL is superuser work, so it goes over an instance's own socket:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
kubectl cnpg status pg-cluster | grep -i "wal"
\`\`\``,
      hint: `The table and the row are created through \`pg-cluster-rw\` as the app user; only \`pg_switch_wal()\` needs the postgres superuser, over an instance Pod's socket.`,
      solution: `kubectl cnpg status pg-cluster
kubectl get backup
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\\n"}{end}'
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE restore_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO restore_proof (note) VALUES ('after-backup') RETURNING *;"
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"`,
    },

    {
      id: 'restore',
      title: 'Recover a new cluster from the object store',
      limitSec: 600,
      criteria: [
        'cluster.postgresql.cnpg.io/pg-restored exists',
        'It bootstraps by recovery from the barman-cloud external cluster',
        'The restored cluster reports healthy',
      ],
      brief: `Restoring in CloudNativePG means creating a cluster that bootstraps by *recovery* instead of by \`initdb\` — a second cluster beside the first, not a rewind of the original.

Read the staged manifest before applying it. Two blocks do the work: a \`bootstrap.recovery\` naming a source, and an \`externalClusters\` entry that says what that source is — the Barman Cloud plugin, which object store to read, and whose data to read out of it.

That last part, \`serverName\`, is the detail people miss: one bucket can hold many clusters' backups, so the recovery has to name which server's data it wants.`,
      instructions: `Look at the manifest:

\`\`\`
cat /root/restore.yaml
\`\`\`

\`bootstrap.recovery.source: origin\` says "bootstrap by recovering from the external cluster called origin", and the \`externalClusters\` entry defines \`origin\` as the plugin reading \`serverName: pg-cluster\` out of the \`seaweedfs-store\` ObjectStore. There is no \`initdb\` anywhere — this database will be assembled from the bucket.

Apply it and watch both clusters:

\`\`\`
kubectl apply -f /root/restore.yaml
kubectl get cluster.postgresql.cnpg.io
\`\`\`

The original stays healthy throughout; a restore reads the bucket and never touches the source. The new one goes through a recovery job — fetching the base backup, then replaying WAL — and then reports "Cluster in healthy state" with 1 of 1 ready.

While it works, look at what it created:

\`\`\`
kubectl get pods
kubectl get pvc
\`\`\`

A recovery Job appears first and disappears when it is done, then the instance Pod starts on the volume it produced.`,
      hint: `Give it a few minutes: the recovery fetches a base backup and replays WAL before PostgreSQL will accept connections. \`kubectl get cluster.postgresql.cnpg.io\` is the thing to watch, not the Pod list.`,
      solution: `cat /root/restore.yaml
kubectl apply -f /root/restore.yaml
kubectl get cluster.postgresql.cnpg.io
kubectl get pods
kubectl get pvc`,
    },

    {
      id: 'verify-restore',
      title: 'Find the row the base backup never had',
      limitSec: 420,
      criteria: [
        'The restored cluster contains the row written after the base backup',
        'It is a separate cluster with its own Services',
        'The original cluster is untouched and still taking writes',
      ],
      brief: `Now read the restored database, and check for the row you wrote after the base backup was taken.

It is there. It cannot have come from the base backup, which predates it — it was replayed out of the WAL archive, which is what "recovery" means and why continuous archiving matters as much as the backup itself.

Then confirm the two clusters are genuinely independent: the copy has its own Pod, its own claim, its own Services and its own credentials, and the original has been serving the entire time.`,
      instructions: `Read the restored cluster, over its own instance's socket:

\`\`\`
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM restore_proof;"
\`\`\`

The \`after-backup\` row is present. The base backup was taken before that table existed, so every byte of this came out of the WAL archive during recovery.

Compare the two clusters side by side:

\`\`\`
kubectl get cluster.postgresql.cnpg.io
kubectl get svc | grep pg-restored
kubectl get secret | grep pg-restored
\`\`\`

Its own \`-rw\`, \`-ro\` and \`-r\` Services, and its own generated credentials — pointing an application at the restored database means pointing it at \`pg-restored-rw\`.

And the original is exactly where you left it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO restore_proof (note) VALUES ('original-still-live') RETURNING *;"
\`\`\``,
      hint: `Read the restored cluster from its own Pod: the \`psql-client\` Pod holds the *original* cluster's credentials, and each cluster generates its own app password.`,
      solution: `kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM restore_proof;"
kubectl get cluster.postgresql.cnpg.io
kubectl get svc | grep pg-restored
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO restore_proof (note) VALUES ('original-still-live') RETURNING *;"`,
    },
  ],
}
