// Built on the same CSI snapshot stack the volume-snapshot backup lab uses (server/csi.go,
// see LABORATORY.md): csi-driver-host-path v1.17.0 with external-snapshotter v8.2.0, the only
// snapshot-capable class that works in this Docker VM. Two consequences from that file are
// visible in this lab and are not incidental: the driver is a single-replica StatefulSet, so
// both clusters here are single-instance and pinned to the server node.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the snapshot stack, the operator, a healthy
// single-instance source cluster on the snapshot-capable storage class, a client Pod, staged
// VolumeSnapshot and replica manifests and the toolbox are this lab's starting state, built
// by its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content
// contract").

export const cnpgReplicaFromSnapshot = {
  id: 'cnpg-replica-from-snapshot',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster with a real snapshot-capable CSI driver installed and a real PostgreSQL cluster on it, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: k3s ships no storage class that can snapshot, so a real CSI driver and the snapshot controller are installed before the database is.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'csi-driver-host-path v1.17.0 with the external-snapshotter v8.2.0 CRDs and snapshot controller, plus a csi-hostpath-sc storage class and a VolumeSnapshotClass — because k3s\'s own local-path class cannot snapshot at all',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy single-instance Cluster named pg-cluster on the snapshot-capable storage class, pinned to the k3d-server node — single-instance and pinned because the hostpath driver is a single-replica StatefulSet living on that node',
      'VolumeSnapshot and replica-cluster manifests staged at /root/snapshot.yaml and /root/replica-cluster.yaml on the k3d-server node — written but deliberately not applied',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Cloning a database by copying its files is slow in proportion to its size. A volume snapshot is not — the storage layer makes one almost instantly, however large the volume. You will take a snapshot of a running database, bring up a second cluster whose data directory *is* that snapshot, and then have it follow the original by streaming, so the snapshot is only the seed rather than the whole story. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'take-the-snapshot',
      title: 'Snapshot a running database',
      limitSec: 600,
      criteria: [
        'A VolumeSnapshot named pg-cluster-snapshot exists',
        'It reports readyToUse — the CSI driver has taken it',
      ],
      brief: `A VolumeSnapshot is a Kubernetes object that asks the storage driver for a point-in-time copy of a PersistentVolumeClaim. What it costs depends entirely on the driver: for one that supports it natively, a snapshot is a metadata operation rather than a copy, so it completes in about the same time whether the volume holds a megabyte or a terabyte.

k3s's default \`local-path\` class cannot do it at all, which is why this environment installs a real CSI driver first.

Write something you can look for later, then take the snapshot and watch \`readyToUse\` flip. Until it does, the object exists but the copy does not.`,
      instructions: `Work in the **toolbox** tab. Leave a fact behind first:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE snapshot_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snapshot_demo (note) VALUES ('before-snapshot') RETURNING *;"
\`\`\`

Look at what makes snapshots possible here at all:

\`\`\`
kubectl get storageclass
kubectl get volumesnapshotclass
kubectl get pvc
\`\`\`

The database's volume is on \`csi-hostpath-sc\`, not \`local-path\`. That is the whole reason the rest of this lab can happen.

Read the staged manifest on the **k3d-server** node:

\`\`\`
cat /root/snapshot.yaml
\`\`\`

It names a source PersistentVolumeClaim and a VolumeSnapshotClass — nothing about PostgreSQL. The storage layer does not know or care that this volume holds a database.

Apply it, then watch it become usable:

\`\`\`
kubectl apply -f /root/snapshot.yaml
kubectl get volumesnapshot
sleep 20
kubectl get volumesnapshot pg-cluster-snapshot -o json | jq '{readyToUse: .status.readyToUse, restoreSize: .status.restoreSize, boundContent: .status.boundVolumeSnapshotContentName}'
\`\`\`

\`readyToUse: true\` and a \`restoreSize\`. There is also a \`VolumeSnapshotContent\` object behind it — the cluster-scoped half that represents the actual snapshot in the storage system:

\`\`\`
kubectl get volumesnapshotcontent
\`\`\`

Worth knowing what this snapshot is *not*: nothing quiesced the database. It is a crash-consistent copy of the volume, exactly like pulling the power — which PostgreSQL is designed to survive, because recovery from a crash is a thing it does on every start. That is why a snapshot of a running database is usable at all.`,
      hint: `\`readyToUse\` takes a few seconds. If it stays false, look at the VolumeSnapshotContent and the snapshot-controller Pod in kube-system — the error surfaces on the content object rather than on the snapshot.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE snapshot_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snapshot_demo (note) VALUES ('before-snapshot') RETURNING *;"
kubectl get storageclass
kubectl get volumesnapshotclass
cat /root/snapshot.yaml
kubectl apply -f /root/snapshot.yaml
sleep 20
kubectl get volumesnapshot pg-cluster-snapshot -o json | jq '{readyToUse: .status.readyToUse, restoreSize: .status.restoreSize}'
kubectl get volumesnapshotcontent`,
    },

    {
      id: 'bootstrap-from-it',
      title: 'Grow a replica out of the snapshot',
      limitSec: 900,
      criteria: [
        'A Cluster named pg-replica is healthy with its one instance ready',
        'It is in recovery — a standby, not a primary',
        'It carries the row the source wrote before it existed',
        'It refuses writes with a read-only transaction error',
        'The source is streaming to it — the snapshot was the seed, streaming keeps it current',
      ],
      brief: `Now use the snapshot as a data directory.

The manifest bootstraps from the VolumeSnapshot rather than by copying anything, so the new cluster starts with the source's files already in place — no \`pg_basebackup\`, no restore, no time proportional to the size of the database.

But a snapshot is a moment, not a stream. On its own it would leave you with a cluster frozen at the instant it was taken. So the manifest also declares \`replica.enabled\` with a streaming \`externalClusters\` entry: the snapshot supplies the starting point, and streaming replication carries it forward from there.

That combination is the practical way to add a replica to a large database — seed from a snapshot in seconds, then catch up the small remainder over the wire.`,
      instructions: `Read the manifest on the **k3d-server** node:

\`\`\`
cat /root/replica-cluster.yaml
\`\`\`

Two mechanisms, side by side. \`bootstrap.recovery.volumeSnapshots.storage\` names the snapshot to start from. \`replica.enabled\` with \`replica.source: origin\`, plus an \`externalClusters\` entry using the source's own \`streaming_replica\` certificates, is what keeps it following afterwards.

Note the \`affinity.nodeSelector\` too — this cluster is pinned to the same node as the source, because the hostpath CSI driver runs there and its volumes cannot move.

Apply it, then move to the **toolbox** tab:

\`\`\`
kubectl apply -f /root/replica-cluster.yaml
kubectl get cluster
sleep 90
kubectl get cluster
kubectl get pods -l cnpg.io/cluster=pg-replica
\`\`\`

Check what came up:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM snapshot_demo ORDER BY id;"
\`\`\`

In recovery, with the row that was written before the snapshot — that row arrived inside the volume, not over a connection.

Confirm it is read-only:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO snapshot_demo (note) VALUES ('should-fail');"
\`\`\`

Now the half that makes it a *replica* rather than a stale clone — ask the source who is connected:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

\`pg-replica\` is there, streaming. Prove it is live by writing something new:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snapshot_demo (note) VALUES ('after-snapshot') RETURNING *;"
sleep 8
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM snapshot_demo ORDER BY id;"
\`\`\`

Both rows, and the second one arrived in seconds rather than waiting for a WAL segment to be archived — because this replica has a WAL receiver:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -c \\
  "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), pg_last_xact_replay_timestamp();"
\`\`\`

A receive position as well as a replay position. That is the difference from a replica fed by an archive, which has only the latter.`,
      hint: `Bootstrapping from a snapshot is fast, but the instance still has to start PostgreSQL and run crash recovery on the snapshotted files, so allow a minute or two. If the Pod is stuck Pending, check that it landed on the same node as the driver — a hostpath volume cannot be attached anywhere else.`,
      solution: `cat /root/replica-cluster.yaml
kubectl apply -f /root/replica-cluster.yaml
sleep 90
kubectl get cluster
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM snapshot_demo ORDER BY id;"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO snapshot_demo (note) VALUES ('should-fail');"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO snapshot_demo (note) VALUES ('after-snapshot') RETURNING *;"
sleep 8
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM snapshot_demo ORDER BY id;"`,
    },
  ],
}
