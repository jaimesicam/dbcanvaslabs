// Confirmed live against a real K3D + CloudNativePG deploy carrying both stacks — the CSI
// hostpath driver for snapshots and the Barman Cloud plugin for the WAL archive (server/csi.go,
// server/cnpg.go, see LABORATORY.md). A hot and a cold volumeSnapshot Backup were taken back to
// back (the second waited `pending` while the first ran), then two rows were written four seconds
// apart with a target time recorded between them. Recovery clusters bootstrapped from each
// snapshot with `recoveryTarget.targetTime` came up healthy in about 40 seconds carrying the
// first row and not the second — from the cold snapshot exactly as from the hot one, because the
// snapshot is only where the replay starts.
//
// Self-contained, like every lab here: the CSI driver, the Barman Cloud plugin, an object store
// with WAL archiving already working, a single-instance cluster, a client Pod and four staged
// manifests are this lab's starting state, built by its own provisioning. No reference to any
// other lab (see CLAUDE.md, "Lab content contract").

export const cnpgSnapshotPITR = {
  id: 'cnpg-snapshot-pitr',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real CSI driver that can take volume snapshots, a real S3-compatible object store receiving this database\'s WAL, and a real PostgreSQL cluster sitting on top of both, all thrown away when you finish. Nothing is simulated, which is why this one takes longer than most: two storage stacks are installed and waited for before the database is even bootstrapped.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'The csi-driver-host-path CSI driver with a VolumeSnapshotClass called csi-hostpath-snapclass, plus the snapshot CRDs and controller Kubernetes needs for any of this to exist',
      'cert-manager v1.19.1 and the Barman Cloud plugin v0.14.0, which is how CloudNativePG 1.30 archives WAL to object storage',
      'A SeaweedFS container published in-cluster as seaweedfs:8333, with an ObjectStore describing its cnpg-backups bucket',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A single-instance Cluster named pg-cluster on the snapshot-capable StorageClass, already archiving its WAL to that bucket, with a table called notes holding 50 rows',
      'Four manifests staged on the k3d-server node: /root/hot-backup.yaml, /root/cold-backup.yaml, and /root/pitr-hot.yaml.template and /root/pitr-cold.yaml.template with the recovery target left blank for you',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A volume snapshot restores you to the instant it was taken and no further — which is rarely the instant you want. Point-in-time recovery pairs the snapshot with the WAL archive: the snapshot supplies the data directory, the archive supplies everything that happened afterwards, and a target time says where to stop. You will take one snapshot of a running database and one of a stopped one, write on both sides of a moment you record, and then recover to that moment from each — proving that where you can recover *to* has nothing to do with how the snapshot was taken.',
  },

  tasks: [
    {
      id: 'take-both-snapshots',
      title: 'Take two snapshots and mark a moment after them',
      limitSec: 720,
      criteria: [
        'WAL archiving is working — the archive is what makes a target time reachable',
        'Both backups completed, one online and one not',
        'And both snapshots are ready to use',
        '/root/target-time.txt holds a moment between two rows',
      ],
      brief: `A point-in-time recovery needs three things: a starting point, a stream of changes, and a target. This objective creates all three in that order.

The starting points are two volume snapshots of the same database — one taken while PostgreSQL runs, one with the instance fenced and shut down. They are taken *first*, because a snapshot can only ever be a floor: recovery starts there and moves forward.

The stream is already running. This cluster archives its WAL to an object store, which is what will carry the changes made after the snapshots.

The target is a moment you choose. Write a row, ask the database for the time, write another row — and the moment you recorded now sits strictly between two commits, which is what turns the recovery into a proof.`,
      instructions: `Work in the **k3d-server** tab. Check the archive first, since nothing else here works without it:

\`\`\`
kubectl get cluster pg-cluster
kubectl get cluster pg-cluster \\
  -o jsonpath='{range .status.conditions[?(@.type=="ContinuousArchiving")]}{.type}{"\\t"}{.status}{"\\t"}{.reason}{"\\n"}{end}'
kubectl get objectstore
\`\`\`

\`ContinuousArchiving\` is True: every WAL segment this database fills is being shipped to the bucket described by the ObjectStore.

Now take both snapshots. Read the manifests first — they differ in one word:

\`\`\`
diff /root/hot-backup.yaml /root/cold-backup.yaml
kubectl apply -f /root/hot-backup.yaml
kubectl apply -f /root/cold-backup.yaml
\`\`\`

Watch them. The second one waits — CloudNativePG runs one backup at a time per cluster, so the cold one sits in \`pending\` until the hot one is finished:

\`\`\`
for i in $(seq 1 12); do
  kubectl get backup --no-headers
  echo "---"
  sleep 8
done
\`\`\`

When both read \`completed\`, check the snapshots exist and are usable:

\`\`\`
kubectl get volumesnapshot
kubectl get backup -o custom-columns=NAME:.metadata.name,ONLINE:.spec.online,PHASE:.status.phase
\`\`\`

Now make a moment worth aiming at. Write a row:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "CREATE TABLE pitr_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "INSERT INTO pitr_proof (note) VALUES ('first') RETURNING *;"
\`\`\`

Take the timestamp from the database's own clock — not from the node's, which is a different clock and not the one recovery compares against:

\`\`\`
sleep 2
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now();" > /root/target-time.txt
cat /root/target-time.txt
sleep 2
\`\`\`

And write the row that must *not* survive the recovery:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "INSERT INTO pitr_proof (note) VALUES ('second') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT note, at FROM pitr_proof ORDER BY id;"
\`\`\`

Finally, close the current WAL segment so everything you just wrote is in the archive rather than sitting in a partial segment nobody has shipped:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
kubectl get cluster pg-cluster -o jsonpath='{.status.lastSuccessfulBackup}{"\\n"}'
\`\`\``,
      hint: `Take the timestamp *between* the two inserts. Recorded before the first or after the second it cannot separate them, and the recovery would prove nothing.`,
      solution: `kubectl get cluster pg-cluster -o jsonpath='{range .status.conditions[?(@.type=="ContinuousArchiving")]}{.type}{"\\t"}{.status}{"\\n"}{end}'
kubectl apply -f /root/hot-backup.yaml
kubectl apply -f /root/cold-backup.yaml
sleep 60
kubectl get backup
kubectl get volumesnapshot
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE pitr_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pitr_proof (note) VALUES ('first') RETURNING *;"
sleep 2
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now();" > /root/target-time.txt
sleep 2
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pitr_proof (note) VALUES ('second') RETURNING *;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
cat /root/target-time.txt`,
    },

    {
      id: 'recover-from-the-hot-one',
      title: 'Recover past the snapshot, to your moment',
      limitSec: 720,
      criteria: [
        'A cluster named pg-hot-pitr reports healthy',
        'Its volume was created from the hot-backup snapshot',
        'It carries the row written before your target time',
        'And not the one written after it',
      ],
      brief: `The recovery manifest has three parts worth reading separately, because between them they are the whole idea.

\`bootstrap.recovery.volumeSnapshots\` says where the data directory comes from: a copy of a disk, restored by the CSI driver into a new volume.

\`bootstrap.recovery.source\` names an \`externalClusters\` entry pointing at the object store through the Barman Cloud plugin. That is where the WAL comes from — everything committed after the snapshot was taken.

\`recoveryTarget.targetTime\` says when to stop replaying. Substitute the moment you recorded, apply it, and the arithmetic does the rest: the row written before that moment is there, the one written after it is not.`,
      instructions: `Read the template, and note that it is a template:

\`\`\`
cat /root/pitr-hot.yaml.template
\`\`\`

Everything is ordinary except two lines: \`recoveryTarget.targetTime\` reads \`TARGET_TIME\`, and \`source: origin\` ties the recovery to the external cluster below, which is the object store. Substitute your moment:

\`\`\`
sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr-hot.yaml.template > /root/pitr-hot.yaml
grep -A 2 recoveryTarget /root/pitr-hot.yaml
kubectl apply -f /root/pitr-hot.yaml
\`\`\`

Watch it build. There is a Job doing the work, and it is worth catching while it exists:

\`\`\`
kubectl get pods | grep pitr
kubectl get cluster
\`\`\`

The Pod called \`pg-hot-pitr-1-snapshot-recovery-…\` is the recovery itself: it restores the snapshot into a new volume and replays WAL out of the bucket until it reaches your target. Keep looking until \`pg-hot-pitr\` reports healthy — around 40 seconds for a database this size:

\`\`\`
sleep 45
kubectl get cluster
kubectl get pvc
\`\`\`

Where its storage came from is recorded on the claim:

\`\`\`
kubectl get pvc pg-hot-pitr-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
\`\`\`

Now the proof:

\`\`\`
echo "--- source:"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT note, at FROM pitr_proof ORDER BY id;"
echo "--- recovered:"
kubectl exec pg-hot-pitr-1 -c postgres -- psql -U postgres -d app -tAc "SELECT note, at FROM pitr_proof ORDER BY id;"
cat /root/target-time.txt
\`\`\`

The source has both rows. The recovered cluster has \`first\` and stops — its last row is older than the moment you recorded, and \`second\` never happened as far as this database is concerned.

Two things are worth being explicit about. Neither row existed when the snapshot was taken, so everything you are looking at came out of the WAL archive; the snapshot supplied only the starting point. And the recovered cluster is a *new* cluster with its own name, Services and credentials — recovery in CloudNativePG never overwrites the thing you are recovering from.`,
      hint: `The substituted file must contain a real timestamp, not the word TARGET_TIME — \`grep -A 2 recoveryTarget /root/pitr-hot.yaml\` is the quickest way to be sure before applying it.`,
      solution: `cat /root/pitr-hot.yaml.template
sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr-hot.yaml.template > /root/pitr-hot.yaml
grep -A 2 recoveryTarget /root/pitr-hot.yaml
kubectl apply -f /root/pitr-hot.yaml
sleep 60
kubectl get cluster
kubectl get pvc pg-hot-pitr-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
kubectl exec pg-hot-pitr-1 -c postgres -- psql -U postgres -d app -tAc "SELECT note, at FROM pitr_proof ORDER BY id;"`,
    },

    {
      id: 'recover-from-the-cold-one',
      title: 'Do it again from the cold snapshot',
      limitSec: 720,
      criteria: [
        'A cluster named pg-cold-pitr reports healthy',
        'Its volume was created from the cold-backup snapshot',
        'It carries the row written before your target time',
        'And not the one written after it',
        'And the cluster all three came from is untouched',
      ],
      brief: `Now the same recovery from the other snapshot — the one taken with the database shut down — aimed at the same moment.

The result is identical, and that is the point of the objective. How a snapshot was taken decides what has to happen when it is opened: an online snapshot carries a backup label saying where replay must begin, a cold one is a clean shutdown that needs nothing. Neither decides *how far forward you can go*. That is the archive's job.

Which means the choice between hot and cold is about what the backup costs you when you take it — a fenced instance or an uninterrupted one — and not about what it can do for you afterwards.`,
      instructions: `Same substitution, same target, different snapshot:

\`\`\`
diff /root/pitr-hot.yaml.template /root/pitr-cold.yaml.template
sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr-cold.yaml.template > /root/pitr-cold.yaml
kubectl apply -f /root/pitr-cold.yaml
\`\`\`

The two templates differ only in the name of the cluster and the name of the snapshot. Watch it come up:

\`\`\`
sleep 45
kubectl get cluster
kubectl get pvc pg-cold-pitr-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
\`\`\`

And read all three databases side by side:

\`\`\`
for c in pg-cluster pg-hot-pitr pg-cold-pitr; do
  printf "%-14s " "$c"
  kubectl exec \${c}-1 -c postgres -- psql -U postgres -d app -tAc \\
    "SELECT string_agg(note, ',' ORDER BY id) FROM pitr_proof;"
done
\`\`\`

The source has \`first,second\`; both recovered clusters have \`first\`. Two different backup modes, one archive, one target time, one answer.

Confirm the original is exactly where you left it — three clusters now share one node's storage and nothing has been taken from the first:

\`\`\`
kubectl get cluster
kubectl get volumesnapshot
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\`

A last thought on what this shape is actually for. A volume snapshot is attractive because taking it is instant however large the database is, and restoring it is a storage operation rather than a copy — which for a database of any size is the difference between minutes and hours. What it cannot do on its own is give you a choice of *when*. Pairing it with a WAL archive is what turns "a copy of last night" into "the database as it was at 09:41, before somebody ran that statement" — and that second thing is what people mean when they ask whether you have backups.`,
      hint: `Both recovery clusters and the original are pinned to the same node, because the CSI driver in this environment runs there and its volumes cannot be attached anywhere else.`,
      solution: `sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr-cold.yaml.template > /root/pitr-cold.yaml
kubectl apply -f /root/pitr-cold.yaml
sleep 60
kubectl get cluster
kubectl get pvc pg-cold-pitr-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
for c in pg-cluster pg-hot-pitr pg-cold-pitr; do printf "%-14s " "$c"; kubectl exec \${c}-1 -c postgres -- psql -U postgres -d app -tAc "SELECT string_agg(note, ',' ORDER BY id) FROM pitr_proof;"; done
kubectl get volumesnapshot
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"`,
    },
  ],
}
