// Built on the same backup stack the object-storage labs use (server/, see LABORATORY.md):
// cert-manager, the Barman Cloud plugin v0.14.0, SeaweedFS exposed in-cluster, WAL archiving
// configured and a real base backup taken before the learner arrives. The manifest staged for
// them differs from an ordinary restore in one field — `replica.enabled` — which is what
// keeps the recovered cluster in recovery instead of promoting it.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, the backup stack, a healthy source
// cluster with a base backup already in the bucket, a client Pod, a staged replica manifest
// and the toolbox are this lab's starting state, built by its own provisioning. No reference
// to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgReplicaFromBackup = {
  id: 'cnpg-replica-from-backup',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real PostgreSQL cluster that is really archiving WAL to real object storage, with a real base backup already taken, thrown away when you finish. Nothing is simulated, which is why this one takes longer than most: the backup stack is installed and a full base backup runs before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the lab network, reachable in-cluster as http://seaweedfs:8333 with a cnpg-backups bucket',
      'cert-manager v1.19.1 and the CloudNativePG Barman Cloud Plugin v0.14.0, which the plugin requires for its webhook certificates',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, archiving WAL to the bucket through an ObjectStore, with one base backup already completed',
      'A replica-cluster manifest staged at /root/replica-cluster.yaml on the k3d-server node — written but deliberately not applied',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'There is a backup sitting in object storage and a manifest that has never been applied. You will bring up a second database cluster from that backup — not as a restore that becomes its own primary, but as a replica that stays in recovery and keeps following the source. The two will never speak to each other: everything that passes between them goes through the bucket, which is what makes this the shape you use across regions. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'recover-into-a-replica',
      title: 'Bring up a replica from the backup',
      limitSec: 900,
      criteria: [
        'A Cluster named pg-replica is healthy with its one instance ready',
        'It is in recovery — a standby, not a primary',
        'It carries the row the source wrote before it existed',
        'It refuses writes with a read-only transaction error',
      ],
      brief: `A restore from object storage normally produces a new, independent primary: it replays what is in the bucket, promotes itself, and starts its own timeline.

Adding one field changes that entirely. With \`replica.enabled\` set, the recovered cluster stays in recovery when the restore finishes and goes on replaying whatever the source archives — a replica cluster whose only link to its source is the bucket.

Read the staged manifest and find the two halves: \`bootstrap.recovery\` naming the external cluster to restore *from*, and \`replica\` naming the same external cluster to keep following.

This objective takes a few minutes: it is a real restore of a real base backup.`,
      instructions: `Write a row on the source first, so there is a fact to look for on the other side. The base backup was taken before this, so the WAL carrying it must be archived and replayed for the row to arrive:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE backup_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO backup_demo (note) VALUES ('before-backup') RETURNING *;"
\`\`\`

Force the current WAL segment out to the bucket, so the replica can actually find it:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT pg_switch_wal();"
sleep 15
\`\`\`

Read the manifest on the **k3d-server** node, where it was staged:

\`\`\`
cat /root/replica-cluster.yaml
\`\`\`

Three parts matter. \`bootstrap.recovery.source: origin\` says where to restore from. \`replica.enabled: true\` with \`replica.source: origin\` says to stay a replica afterwards. And \`externalClusters\` defines \`origin\` as the object store through the Barman plugin — a bucket and a server name, not a host and a port. There is no connection to the source cluster described anywhere in this file.

Apply it, then move to the **toolbox** tab:

\`\`\`
kubectl apply -f /root/replica-cluster.yaml
kubectl get cluster
\`\`\`

Watch it restore. This is a real base backup being fetched and replayed, so give it time:

\`\`\`
sleep 120
kubectl get cluster
kubectl get pods -l cnpg.io/cluster=pg-replica
\`\`\`

Once it is healthy, check what it is:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM backup_demo ORDER BY id;"
\`\`\`

In recovery, and holding the row — which came out of the archive, not off a wire.

Confirm it will not take writes:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO backup_demo (note) VALUES ('should-fail');"
\`\`\`

\`cannot execute INSERT in a read-only transaction\` — the whole instance is in recovery, so even the superuser is refused.`,
      hint: `The restore is genuinely slow — a base backup is fetched from the bucket and replayed. If the cluster is still "Setting up primary" after two minutes, give it another minute before assuming something is wrong, and check \`kubectl get pods\` for a \`*-full-recovery-*\` Job.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE backup_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO backup_demo (note) VALUES ('before-backup') RETURNING *;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT pg_switch_wal();"
cat /root/replica-cluster.yaml
kubectl apply -f /root/replica-cluster.yaml
sleep 120
kubectl get cluster
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM backup_demo ORDER BY id;"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO backup_demo (note) VALUES ('should-fail');"`,
    },

    {
      id: 'follow-the-archive',
      title: 'Prove it is following the bucket, not the source',
      limitSec: 720,
      criteria: [
        'A row written on the source after the backup reached the replica',
        'The source is not streaming to it — the two are coupled only through the object store',
        '/root/replica-lsn.txt was written',
        'It records how far the replica has replayed',
      ],
      brief: `Now the property that makes this shape different from a streaming replica cluster: the two databases have no connection to each other at all.

Write on the source, archive the WAL, and watch the row appear on the replica — then look at the source's \`pg_stat_replication\` and find nothing there for the replica. It is not a client of the primary. It is a client of a bucket.

That is the trade. Streaming gives you a replica that is seconds behind; the archive gives you one that is a WAL segment behind, and buys a replica that needs no network path to the source at all — which is the whole reason to run one in another region.`,
      instructions: `Write something new on the source:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO backup_demo (note) VALUES ('after-backup') RETURNING *;"
\`\`\`

It will not appear on the replica yet, because it is still in a WAL segment the source has not finished. Check, to see the lag for yourself:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM backup_demo ORDER BY id;"
\`\`\`

Now push the segment out to the bucket:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT pg_switch_wal();"
sleep 45
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM backup_demo ORDER BY id;"
\`\`\`

Both rows. The replica fetched the segment from object storage and replayed it — which is why the delay was a whole segment rather than a few milliseconds.

Now the point. Ask the source who is replicating from it:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Its own two standbys, and nothing else. \`pg-replica\` is not there and never was — there is no connection between the clusters to appear in that view.

Record how far the replica has replayed:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_last_wal_replay_lsn();" > /root/replica-lsn.txt
cat /root/replica-lsn.txt
\`\`\`

And see it from the replica's side — what it is waiting for:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -c \\
  "SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), pg_last_xact_replay_timestamp();"
\`\`\`

A replica cluster fed by an archive has no WAL *receiver*, so the receive position stays empty while the replay position advances — the clearest single view of the difference between the two shapes.`,
      hint: `\`pg_switch_wal()\` needs the postgres superuser, so run it inside an instance Pod rather than through the psql-client Pod, which connects as the application role.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO backup_demo (note) VALUES ('after-backup') RETURNING *;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT pg_switch_wal();"
sleep 45
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM backup_demo ORDER BY id;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_last_wal_replay_lsn();" > /root/replica-lsn.txt
cat /root/replica-lsn.txt`,
    },
  ],
}
