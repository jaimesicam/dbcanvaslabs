// Confirmed live against a real K3D + CloudNativePG deploy with a real CSI driver (server/csi.go,
// see LABORATORY.md): a Backup with method volumeSnapshot and online true completed in about 20
// seconds with the instance never leaving 1/1 Running, and its VolumeSnapshot carries a
// cnpg.io/backupLabelFile annotation whose decoded contents are a real backup_label (BACKUP
// METHOD: streamed, BACKUP FROM: primary) with the recorded control file reading `Database
// cluster state: in production`. The same Backup with online false fenced the instance — the
// Cluster carried cnpg.io/fencedInstances ["pg-cluster-1"] for the duration — took about 30
// seconds, and produced a snapshot with no backup label whose control file reads `shut down`.
// Recovering from the cold snapshot brought a new cluster up healthy in about 37 seconds with all
// 50 rows. One caution: .status.online reported true for both backups in this release, so the
// mode has to be read from .spec.online.
//
// Self-contained, like every lab here: the CSI driver, the operator, a single-instance cluster on
// a snapshot-capable StorageClass, a seeded table, a client Pod and two staged Backup manifests
// are this lab's starting state, built by its own provisioning. No reference to any other lab
// (see CLAUDE.md, "Lab content contract").

export const cnpgSnapshotModes = {
  id: 'cnpg-snapshot-modes',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real CSI driver that can take volume snapshots, and a real PostgreSQL cluster sitting on it, all thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: the snapshot API, its controller and the CSI driver are installed and waited for before the operator is, and the database is bootstrapped after that.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The csi-driver-host-path CSI driver with a VolumeSnapshotClass called csi-hostpath-snapclass, and the snapshot CRDs and controller Kubernetes needs for any of this to exist',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A single-instance Cluster named pg-cluster on the snapshot-capable StorageClass, pinned to the node the driver runs on, with a table called notes holding 50 rows',
      'Three manifests staged on the k3d-server node — /root/hot-backup.yaml, /root/cold-backup.yaml and /root/restore-cold.yaml — written, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A volume snapshot is an instant copy of a disk, and a disk holding a running database is a disk being written to. CloudNativePG offers two ways to deal with that, differing by one boolean: take the snapshot while PostgreSQL runs and record where recovery must start, or stop PostgreSQL first and snapshot something that is not moving. You will take one of each against the same database, find the difference recorded inside the snapshots themselves rather than in the documentation, and then recover from the colder of the two.',
  },

  tasks: [
    {
      id: 'hot-backup',
      title: 'Snapshot a running database',
      limitSec: 600,
      criteria: [
        'The hot backup completed',
        'It was taken online — spec.online is true',
        'Its VolumeSnapshot is ready to use',
        'And it carries a backup label, because the database was running throughout',
      ],
      brief: `The default is online, and it is the one you want almost always: the database keeps serving, and the snapshot is taken between \`pg_backup_start()\` and \`pg_backup_stop()\`.

Those two calls are what make a copy of a moving disk usable. The first forces a checkpoint and marks where recovery must begin; the second returns a small piece of text — the backup label — recording that starting point. CloudNativePG stores that label on the VolumeSnapshot itself, as an annotation, so the snapshot carries everything a recovery needs to know about where it came from.

Take one, watch the instance stay up while it happens, and then go and read what ended up attached to the snapshot.`,
      instructions: `Work in the **k3d-server** tab. Look at what you are about to copy:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pvc
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
cat /root/hot-backup.yaml
\`\`\`

\`method: volumeSnapshot\` and \`online: true\`. Apply it and watch both the backup and the instance at once:

\`\`\`
kubectl apply -f /root/hot-backup.yaml
for i in 1 2 3 4 5 6 7 8; do
  printf "%s " "$(date +%T)"
  kubectl get backup hot-backup --no-headers
  kubectl get pods -l cnpg.io/cluster=pg-cluster --no-headers
  sleep 5
done
\`\`\`

The backup goes \`started\` → \`completed\` in about twenty seconds, and the instance never leaves \`1/1 Running\`. Nothing was interrupted; a client connected throughout would not have noticed.

Now the snapshot it produced:

\`\`\`
kubectl get volumesnapshot
kubectl get volumesnapshot hot-backup \\
  -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,SIZE:.status.restoreSize
\`\`\`

\`readyToUse: true\` — the CSI driver has taken it and it can be restored from.

And here is where the mode is recorded. CloudNativePG annotates the snapshot with what it knew at the time:

\`\`\`
kubectl get volumesnapshot hot-backup -o yaml | grep "cnpg.io/" | cut -c1-46
\`\`\`

Among them, \`cnpg.io/backupLabelFile\` — base64, because it is a file. Decode it:

\`\`\`
kubectl get volumesnapshot hot-backup -o jsonpath='{.metadata.annotations.cnpg\\.io/backupLabelFile}' \\
  | base64 -d
\`\`\`

That is PostgreSQL's own backup label: the WAL location the backup started at, the checkpoint location, \`BACKUP METHOD: streamed\`, \`BACKUP FROM: primary\`, the start time and the label name. A recovery reading this snapshot knows exactly where to begin replaying.

The other annotation worth reading is the control file as it stood:

\`\`\`
kubectl get volumesnapshot hot-backup -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' \\
  | grep -E "Database cluster state|Latest checkpoint location"
\`\`\`

\`Database cluster state: in production\` — a database that was running when its disk was copied. Remember that line; the next objective produces a different one.

One field to distrust while you are here:

\`\`\`
kubectl get backup hot-backup -o custom-columns=NAME:.metadata.name,SPEC:.spec.online,STATUS:.status.online
\`\`\`

Read \`.spec.online\` — what was asked for. In this operator release \`.status.online\` reports \`true\` regardless, so it is not the field to check when you are trying to work out how a backup was actually taken.`,
      hint: `The annotations are on the VolumeSnapshot, not on the Backup — \`kubectl get volumesnapshot <name> -o yaml\` shows all of them at once if the jsonpath is fiddly.`,
      solution: `cat /root/hot-backup.yaml
kubectl apply -f /root/hot-backup.yaml
sleep 30
kubectl get backup
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get volumesnapshot
kubectl get volumesnapshot hot-backup -o jsonpath='{.metadata.annotations.cnpg\\.io/backupLabelFile}' | base64 -d
kubectl get volumesnapshot hot-backup -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' | grep -E "Database cluster state"
kubectl get backup hot-backup -o custom-columns=NAME:.metadata.name,SPEC:.spec.online,STATUS:.status.online`,
    },

    {
      id: 'cold-backup',
      title: 'Snapshot a database that is not running',
      limitSec: 600,
      criteria: [
        'The cold backup completed, with spec.online false',
        'Its snapshot is ready and carries no backup label — nothing was running to label',
        'The control file inside it says the database was shut down',
        'And nothing is fenced any more — the instance is Ready again',
      ],
      brief: `Set \`online: false\` and CloudNativePG takes a different route entirely: it fences the target instance, PostgreSQL shuts down cleanly, the snapshot is taken of a data directory that nobody is writing to, and the fence is lifted.

What you get is a copy of a database that was shut down properly — which needs no backup label, because there is no "where to start replaying": there is nothing in flight to replay. That is the appeal. The price is exactly what it sounds like: for the duration of the snapshot, that instance is not serving.

On a replicated cluster the default backup target is a standby, so a cold backup costs you a replica for half a minute. Here there is one instance, so watch carefully what it costs.`,
      instructions: `Read the manifest — it differs from the last one in a single word:

\`\`\`
diff /root/hot-backup.yaml /root/cold-backup.yaml
\`\`\`

Apply it and watch the Cluster, not just the Backup. The signal is an annotation the operator sets while it works:

\`\`\`
kubectl apply -f /root/cold-backup.yaml
for i in $(seq 1 10); do
  printf "%s " "$(date +%T)"
  kubectl get backup cold-backup --no-headers | tr '\\n' ' '
  printf "fenced="
  kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}'
  echo
  sleep 5
done
\`\`\`

While the backup runs, the Cluster carries \`cnpg.io/fencedInstances: ["pg-cluster-1"]\` — the operator has stopped PostgreSQL on that instance without deleting the Pod. When the backup completes, the annotation is gone. The whole thing takes about thirty seconds, a little longer than the online one, because stopping and starting a database is part of it.

Watch the readiness follow, a good half-minute behind:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster pg-cluster
\`\`\`

Now compare the two snapshots. First the backup label:

\`\`\`
kubectl get volumesnapshot cold-backup -o yaml | grep "cnpg.io/" | cut -c1-46
\`\`\`

No \`cnpg.io/backupLabelFile\` at all. There was no running server to bracket with \`pg_backup_start\` and \`pg_backup_stop\`, so there is nothing to label.

Then the control file, which is the clearest single line in this lab:

\`\`\`
for s in hot-backup cold-backup; do
  printf "%-12s " "$s"
  kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' \\
    | grep "Database cluster state"
done
\`\`\`

\`in production\` against \`shut down\`. Those two snapshots are copies of the same database taken a minute apart, and PostgreSQL's own control file inside each one records which of the two things was true when the copy was made.

Finally, the two Backup objects side by side:

\`\`\`
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,PHASE:.status.phase,STARTED:.status.startedAt,STOPPED:.status.stoppedAt
\`\`\`

Both completed, one online and one not, with the cold one taking longer between its start and stop timestamps.

So which should you use? Online, in almost every case: it costs nothing in availability and the label makes it perfectly restorable. Cold is for when you want a copy that needs no recovery at all — a clean shutdown copy to hand to somebody, or a snapshot taken from a standby you can afford to lose for a minute in exchange for the simplest possible restore. What you must not do is take a cold backup from a single-instance cluster in production without meaning to, which is exactly what you just did.`,
      hint: `The fencing annotation is only set while the backup is running, so the loop is the way to catch it — if you look afterwards it will already be gone, and the durable evidence is the control file inside the snapshot.`,
      solution: `diff /root/hot-backup.yaml /root/cold-backup.yaml
kubectl apply -f /root/cold-backup.yaml
for i in $(seq 1 10); do printf "%s " "$(date +%T)"; kubectl get backup cold-backup --no-headers | tr '\\n' ' '; printf "fenced="; kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}'; echo; sleep 5; done
kubectl get volumesnapshot cold-backup -o yaml | grep "cnpg.io/" | cut -c1-46
for s in hot-backup cold-backup; do printf "%-12s " "$s"; kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' | grep "Database cluster state"; done
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,PHASE:.status.phase,STARTED:.status.startedAt,STOPPED:.status.stoppedAt
kubectl get cluster pg-cluster`,
    },

    {
      id: 'restore-the-cold-one',
      title: 'Recover from the cold copy',
      limitSec: 600,
      criteria: [
        'A cluster named pg-restored reports healthy',
        'Its volume was created from the cold snapshot',
        'It carries all 50 rows',
        'And the cluster it was taken from is untouched',
      ],
      brief: `Whichever mode produced it, a snapshot is restored the same way: a new Cluster whose \`bootstrap.recovery\` names the VolumeSnapshot as its storage. The manifest does not mention hot or cold anywhere, because it does not need to — the snapshot carries what recovery needs.

Restore the cold one. It is the simpler of the two to reason about: the data directory it contains belongs to a database that was shut down cleanly, so starting it is an ordinary start rather than a recovery.

And confirm the obvious-but-worth-checking thing at the end: the cluster you took the snapshots from is still exactly where you left it. Backups that disturb the thing they are backing up are not backups.`,
      instructions: `Read the restore manifest:

\`\`\`
cat /root/restore-cold.yaml
\`\`\`

An ordinary Cluster, with \`bootstrap.recovery.volumeSnapshots.storage\` naming \`cold-backup\` as the source for its data volume. Apply it:

\`\`\`
kubectl apply -f /root/restore-cold.yaml
for i in $(seq 1 8); do
  sleep 12
  kubectl get cluster --no-headers
done
\`\`\`

Healthy in well under a minute. Where its storage came from is recorded on the claim:

\`\`\`
kubectl get pvc
kubectl get pvc pg-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
\`\`\`

\`{"apiGroup":"snapshot.storage.k8s.io","kind":"VolumeSnapshot","name":"cold-backup"}\` — the volume was not provisioned empty and filled, it was created *from* the snapshot by the CSI driver.

Check what is in it:

\`\`\`
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM notes;"
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -tAc "SELECT entry FROM notes ORDER BY id DESC LIMIT 3;"
\`\`\`

All fifty rows. And look at how it started:

\`\`\`
kubectl logs pg-restored-1 -c postgres 2>/dev/null | grep -iE "database system (was|is)" | head -4
\`\`\`

The log shows a database system that was shut down and is now ready — no crash recovery, no "consistent recovery state reached", because there was nothing in flight when the snapshot was taken.

Confirm the original is untouched, and that it has both snapshots to its name:

\`\`\`
kubectl get cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl get volumesnapshot
kubectl get cluster pg-cluster -o jsonpath='{.status.lastSuccessfulBackup}{"\\n"}'
\`\`\`

Two clusters, two snapshots, one original database that never stopped being the original.

A closing thought about which mode to schedule. Volume snapshots are attractive for large databases because the copy is instant regardless of size — but "instant" is a property of the storage, not of PostgreSQL, and everything about consistency is still yours to arrange. Online backups get that right by recording where to start; cold backups get it right by leaving nothing to start from. Both are correct. Only one of them keeps serving while you take it.`,
      hint: `\`pg-restored\` is pinned to the same node as the original, because the CSI driver in this environment runs there and its volumes cannot be attached anywhere else.`,
      solution: `cat /root/restore-cold.yaml
kubectl apply -f /root/restore-cold.yaml
sleep 60
kubectl get cluster
kubectl get pvc pg-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM notes;"
kubectl logs pg-restored-1 -c postgres 2>/dev/null | grep -iE "database system (was|is)" | head -4
kubectl get cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl get volumesnapshot`,
    },
  ],
}
