// Everything below is confirmed live against a real K3D + CloudNativePG deploy with a real
// CSI driver (server/csi.go, see LABORATORY.md): the snapshot really was taken, the restored
// cluster's claim really carries `dataSource: VolumeSnapshot`, and the row written after the
// snapshot really is absent from the copy. Grading reads the claim's dataSource and both
// clusters' data.
//
// Self-contained, like every lab here: the snapshot-capable CSI driver, the operator and a
// single-instance cluster on that driver are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgVolumeSnapshots = {
  id: 'cnpg-volume-snapshots',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, a real CSI driver that can take snapshots, and a real PostgreSQL cluster sitting on it, all thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: the snapshot API, its controller and the CSI driver are installed and waited for before the operator is, and the database is bootstrapped after that.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The VolumeSnapshot API (external-snapshotter v8.2.0): its three CRDs and the snapshot-controller — k3s does not ship them',
      'The CSI hostpath driver v1.17.0, running and registered, with a StorageClass named csi-hostpath-sc and a VolumeSnapshotClass named csi-hostpath-snapclass — k3s\'s own local-path StorageClass cannot take snapshots at all',
      'The CloudNativePG v1.30.0 operator, installed after the snapshot API so that it starts with volume-snapshot backups enabled',
      'A healthy single-instance Cluster named pg-cluster on csi-hostpath-sc, told to use csi-hostpath-snapclass for its backups, and pinned to the k3d-server node — the CSI driver registers on one node only, so its volumes can exist nowhere else',
      'A Pod named psql-client with the app credentials already in its environment, and two manifests staged on the k3d-server node at /root/snapshot-backup.yaml and /root/restored-cluster.yaml — written, but deliberately not applied',
    ],
    yourJob:
      'The database is healthy and nothing has been backed up. You will write a row, take a snapshot backup of the volume underneath it, write a second row afterwards, then restore the snapshot into a brand-new cluster beside the original — and find exactly one of those two rows in the copy.',
  },

  tasks: [
    {
      id: 'survey-the-driver',
      title: 'See what makes snapshots possible',
      limitSec: 420,
      criteria: [
        "The cluster's volume is Bound on the csi-hostpath-sc StorageClass",
        'A VolumeSnapshotClass named csi-hostpath-snapclass exists',
        "A row noted 'before-snapshot' exists",
      ],
      brief: `Snapshots are not a database feature here — they are a storage feature, and most storage cannot do them. Start by looking at what is underneath this cluster.

Compare the two StorageClasses in this environment: k3s's own \`local-path\`, which every other kind of cluster would use, and \`csi-hostpath-sc\`, backed by a real CSI driver that implements the snapshot calls. Only the second can be snapshotted, and this cluster is deliberately on it.

Then write a row noted \`before-snapshot\`. It is the thing you are about to freeze in time.`,
      instructions: `Look at what storage exists, and what this cluster is using:

\`\`\`
kubectl get storageclass
kubectl get pvc
\`\`\`

Two classes. \`local-path\` is what k3s ships, and it has no snapshot support at all — no CSI driver behind it, nothing to call. \`csi-hostpath-sc\` is backed by a real CSI driver, and the cluster's claim is bound on it.

The snapshot half of that driver is declared separately:

\`\`\`
kubectl get volumesnapshotclass
kubectl get csidrivers
\`\`\`

A \`VolumeSnapshotClass\` is to snapshots what a StorageClass is to volumes: it names the driver that will do the work. The cluster already points at it:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.spec.backup.volumeSnapshot}{"\\n"}'
\`\`\`

Now write the row that this lab is about:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE snap_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snap_proof (note) VALUES ('before-snapshot') RETURNING *;"
\`\`\``,
      hint: `The cluster is a single instance pinned to the \`k3d-server\` node, because the CSI driver registers on that node only — a volume from this driver cannot exist anywhere else.`,
      solution: `kubectl get storageclass
kubectl get pvc
kubectl get volumesnapshotclass
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.spec.backup.volumeSnapshot}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE snap_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snap_proof (note) VALUES ('before-snapshot') RETURNING *;"`,
    },

    {
      id: 'take-snapshot',
      title: 'Snapshot the volume, then change the database',
      limitSec: 480,
      criteria: [
        'A Backup with method volumeSnapshot completed',
        "A VolumeSnapshot exists for the cluster's volume",
        'It reports readyToUse: true',
        "A row noted 'after-snapshot' was written to the original cluster",
      ],
      brief: `Take the backup. It is the same kind of \`Backup\` resource any other method uses, with \`method: volumeSnapshot\` — and what it produces is not a file somewhere, it is a \`VolumeSnapshot\` object owned by the storage layer.

Watch for \`readyToUse\` on that object. A snapshot exists as a request first and becomes usable when the driver says so, and only then can anything be restored from it.

Then, deliberately, write a second row noted \`after-snapshot\` to the original cluster. That row is the control in the experiment: it exists in the running database and cannot possibly exist in a snapshot taken before it.`,
      instructions: `Read the staged request and apply it:

\`\`\`
cat /root/snapshot-backup.yaml
kubectl apply -f /root/snapshot-backup.yaml
\`\`\`

Watch it run, and watch what it creates:

\`\`\`
kubectl get backup
kubectl get volumesnapshot
\`\`\`

The Backup reaches \`completed\`, and a \`VolumeSnapshot\` named after it appears — with the cluster's claim as its source, the snapshot class you looked at earlier, and \`READYTOUSE\` true. The snapshot is taken hot, without stopping the database: \`online: true\` in the cluster's backup settings means PostgreSQL is put into backup mode for the duration rather than shut down.

Look at what the snapshot actually references:

\`\`\`
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,CLASS:.spec.volumeSnapshotClassName
\`\`\`

Now change the database, so that the copy and the original are provably different:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snap_proof (note) VALUES ('after-snapshot') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM snap_proof ORDER BY id;"
\`\`\`

Two rows in the running cluster. The snapshot, taken before the second one, still holds one.`,
      hint: `If the Backup is rejected with "missing VolumeSnapshot CRD", the snapshot API arrived after the operator started — this environment installs it first for exactly that reason, so that error should not appear here.`,
      solution: `cat /root/snapshot-backup.yaml
kubectl apply -f /root/snapshot-backup.yaml
kubectl get backup
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,CLASS:.spec.volumeSnapshotClassName
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snap_proof (note) VALUES ('after-snapshot') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM snap_proof ORDER BY id;"`,
    },

    {
      id: 'restore',
      title: 'Restore the snapshot into a new cluster',
      limitSec: 600,
      criteria: [
        'cluster.postgresql.cnpg.io/pg-cluster-restored exists',
        'Its volume was created from the VolumeSnapshot',
        'The restored cluster reports healthy',
      ],
      brief: `Restoring does not put data back into the existing cluster. It creates a *new* cluster whose storage is cloned from the snapshot — which is the shape of every safe restore: the original keeps running, untouched, while you bring the copy up beside it.

The staged manifest is an ordinary Cluster with one addition: a bootstrap section naming the VolumeSnapshot as the source of its storage. The operator asks the storage layer for a volume cloned from that snapshot, then starts PostgreSQL on it.

The claim it creates is where the proof lives. A normal claim has no \`dataSource\`; this one names the snapshot it came from.`,
      instructions: `Read the manifest, and look at the bootstrap section in particular:

\`\`\`
cat /root/restored-cluster.yaml
\`\`\`

\`bootstrap.recovery.volumeSnapshots.storage\` names the VolumeSnapshot to clone. Everything else is a normal Cluster.

Apply it and watch both clusters at once:

\`\`\`
kubectl apply -f /root/restored-cluster.yaml
kubectl get cluster.postgresql.cnpg.io
\`\`\`

The original stays healthy the whole time — nothing about a restore touches it. The new one goes through its own bootstrap and reaches "Cluster in healthy state" with 1 of 1 ready.

Now look at where its storage came from:

\`\`\`
kubectl get pvc
kubectl get pvc pg-cluster-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
\`\`\`

The claim carries a \`dataSource\` naming the VolumeSnapshot. That is the difference between a restored cluster and a freshly initialised one: a new cluster's claim has no dataSource at all, and its database would be empty.`,
      hint: `The restored cluster is pinned to the same node as the original, because the CSI driver only exists there. If its claim sits \`Pending\`, check that the snapshot reports \`readyToUse\` — a clone cannot start from a snapshot that is not finished.`,
      solution: `cat /root/restored-cluster.yaml
kubectl apply -f /root/restored-cluster.yaml
kubectl get cluster.postgresql.cnpg.io
kubectl get pvc
kubectl get pvc pg-cluster-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'`,
    },

    {
      id: 'verify-restore',
      title: 'Find exactly one of the two rows',
      limitSec: 420,
      criteria: [
        "The 'before-snapshot' row is present in the restored cluster",
        "The 'after-snapshot' row is absent — the copy stops at the snapshot",
        'The restored cluster has its own -rw, -ro and -r Services',
      ],
      brief: `Now read both databases and compare them. This is the whole point of the lab.

The restored cluster holds \`before-snapshot\` and does not hold \`after-snapshot\`. That is not a bug — it is what a snapshot *is*: a copy of the volume as it stood at one instant, with everything committed afterwards living only in the original.

It is also worth seeing that the copy is a real, independent cluster: its own Pod, its own claim, its own three Services, its own credentials. Restoring a database in Kubernetes produces another database, not a rewound one.`,
      instructions: `Read the restored cluster directly, over its own instance's socket:

\`\`\`
kubectl exec pg-cluster-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM snap_proof ORDER BY id;"
\`\`\`

One row: \`before-snapshot\`. Now the original, for comparison:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM snap_proof ORDER BY id;"
\`\`\`

Two rows. The second was written after the snapshot was taken, so it exists in the running database and nowhere else — a snapshot restores you to an instant, not to the present.

Finally, confirm the copy is genuinely its own cluster rather than a view of the original:

\`\`\`
kubectl get svc
kubectl get pods -o wide
kubectl get cluster.postgresql.cnpg.io
\`\`\`

Two clusters, each with its own instance, its own claim and its own \`-rw\`, \`-ro\` and \`-r\` Services. An application would be pointed at \`pg-cluster-restored-rw\` to use the copy, and the original would carry on serving as if nothing had happened.`,
      hint: `Read the restored cluster from its own Pod: the \`psql-client\` Pod's credentials belong to the original cluster, and each cluster generates its own app password.`,
      solution: `kubectl exec pg-cluster-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM snap_proof ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM snap_proof ORDER BY id;"
kubectl get svc
kubectl get pods -o wide
kubectl get cluster.postgresql.cnpg.io`,
    },
  ],
}
