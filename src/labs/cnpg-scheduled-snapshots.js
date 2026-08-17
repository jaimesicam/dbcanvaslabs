// Confirmed live against a real K3D + CloudNativePG deploy with a real CSI driver (server/csi.go,
// see LABORATORY.md): a ScheduledBackup with method volumeSnapshot and `immediate: true` fired at
// once, producing a Backup named <schedule>-<timestamp> that completed and left a ready
// VolumeSnapshot, with status carrying lastCheckTime, lastScheduleTime and nextScheduleTime. The
// schedule field is a six-field cron — CloudNativePG counts seconds. The retention finding is the
// lab's spine and was measured twice: with the cluster's default
// `snapshotOwnerReference: none`, deleting a Backup leaves its VolumeSnapshot behind forever, and
// only after setting the field to `backup` does a new snapshot carry `ownerReferences:
// Backup/<name>` and disappear with it.
//
// Self-contained, like every lab here: the CSI driver, the operator, a single-instance cluster on
// a snapshot-capable StorageClass, a seeded table, a client Pod and two staged ScheduledBackup
// manifests are this lab's starting state, built by its own provisioning. No reference to any
// other lab (see CLAUDE.md, "Lab content contract").

export const cnpgScheduledSnapshots = {
  id: 'cnpg-scheduled-snapshots',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real CSI driver that can take volume snapshots, and a real PostgreSQL cluster sitting on it, all thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: the snapshot API, its controller and the CSI driver are installed and waited for before the operator is.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The csi-driver-host-path CSI driver with a VolumeSnapshotClass called csi-hostpath-snapclass, and the snapshot CRDs and controller Kubernetes needs for any of this to exist',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A single-instance Cluster named pg-cluster on the snapshot-capable StorageClass, with a table called notes holding 50 rows and no backups taken yet',
      'Two manifests staged on the k3d-server node — /root/scheduled-online.yaml and /root/scheduled-cold.yaml — written, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A backup you have to remember to take is not a backup. A ScheduledBackup turns the on-demand kind into a standing instruction, in the same declarative form as everything else — and it inherits the online/offline choice, so a schedule can quietly fence your database every night if you let it. You will run one of each, watch them fire, and then confront the part nobody mentions until the storage bill arrives: nothing deletes old volume snapshots, and whether deleting a backup takes its snapshot with it is a field you have to set.',
  },

  tasks: [
    {
      id: 'schedule-it',
      title: 'Turn a backup into a standing instruction',
      limitSec: 600,
      criteria: [
        'A ScheduledBackup exists, taking volume snapshots',
        'It runs online, so the database keeps serving on every run',
        'It has already produced at least one completed Backup',
        'With a VolumeSnapshot ready to use, and a recorded last schedule time',
      ],
      brief: `A \`ScheduledBackup\` is a Backup with a clock attached. Everything you would put on a one-off backup — the cluster, the method, whether it runs online — is here too, plus a schedule and a couple of fields about when to start.

Read the schedule carefully before assuming you know it. CloudNativePG's field has **six** fields rather than the five you know from crontab: it counts seconds first. A schedule written as a five-field expression will be accepted and will fire at a time you did not intend, which is a mistake with a long feedback loop.

\`immediate: true\` makes it run once as soon as it is created, which is both convenient here and a good habit in general — a schedule that has never run is a schedule nobody has tested.`,
      instructions: `Work in the **k3d-server** tab. Read the manifest:

\`\`\`
cat /root/scheduled-online.yaml
kubectl get backup
\`\`\`

No backups yet. The schedule reads \`"0 * * * * *"\` — six fields: second, minute, hour, day of month, month, day of week. That means *at second zero of every minute*, which for a lab is convenient and for production would be alarming.

Apply it:

\`\`\`
kubectl apply -f /root/scheduled-online.yaml
sleep 20
kubectl get scheduledbackup
kubectl get backup
\`\`\`

Because of \`immediate: true\` there is already a Backup, named after the schedule with a timestamp appended: \`every-minute-online-20260817010452\` in the run this lab was written from. It completed in a few seconds and the instance never stopped serving.

Look at what the schedule records about itself:

\`\`\`
kubectl get scheduledbackup every-minute-online -o jsonpath='{.status}{"\\n"}'
\`\`\`

Three timestamps: \`lastCheckTime\` (when the operator last looked), \`lastScheduleTime\` (when it last fired) and \`nextScheduleTime\` (when it will fire next). Those are what monitoring should watch — a schedule whose \`lastScheduleTime\` has stopped moving is a backup that has stopped happening, and nothing else in the cluster will say so.

Check the snapshot it produced:

\`\`\`
kubectl get volumesnapshot
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SIZE:.status.restoreSize
\`\`\`

Wait a minute and look again — a second backup will have appeared, and then a third:

\`\`\`
sleep 60
kubectl get backup
kubectl get volumesnapshot
\`\`\`

Every one of them is a real snapshot of the volume, and every one of them is still there.`,
      hint: `Six fields, not five. \`"0 * * * * *"\` is every minute on the second; \`"* * * * *"\` in this field would be rejected or would mean something quite different from what you intended.`,
      solution: `cat /root/scheduled-online.yaml
kubectl apply -f /root/scheduled-online.yaml
sleep 25
kubectl get scheduledbackup
kubectl get backup
kubectl get scheduledbackup every-minute-online -o jsonpath='{.status}{"\\n"}'
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SIZE:.status.restoreSize`,
    },

    {
      id: 'schedule-a-cold-one',
      title: 'Schedule one that stops the database',
      limitSec: 720,
      criteria: [
        'A second schedule exists, and it runs offline',
        'It has produced a completed Backup of its own',
        'Whose snapshot records a shut down database, with no backup label',
        'And the cluster is healthy again between runs',
      ],
      brief: `A schedule carries the same \`online\` field as a one-off backup, and the same consequence: \`online: false\` fences the target instance, waits for PostgreSQL to shut down, snapshots a data directory nobody is writing to, and lifts the fence.

Doing that once, deliberately, is a reasonable thing. Doing it on a schedule is a decision worth making with your eyes open — every run is a small outage on the instance being backed up, and if the cluster has one instance, that instance is your database.

Apply the second schedule, wait for it to fire, and then read the evidence inside the snapshot rather than trusting the manifest: the control file CloudNativePG records tells you what state the database was in when the copy was taken.`,
      instructions: `Read the difference between the two schedules first:

\`\`\`
diff /root/scheduled-online.yaml /root/scheduled-cold.yaml
\`\`\`

A different name, a two-minute schedule, no immediate run, and \`online: false\`. Apply it:

\`\`\`
kubectl apply -f /root/scheduled-cold.yaml
kubectl get scheduledbackup
\`\`\`

Now wait for it. It fires at second zero of every second minute, so this takes up to two minutes — watch the cluster's fencing annotation while you wait, because that is the visible cost:

\`\`\`
for i in $(seq 1 20); do
  printf "%s " "$(date +%T)"
  kubectl get backup --no-headers | grep every-two-minutes | tr '\\n' ' '
  printf "fenced="
  kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}'
  echo
  sleep 10
done
\`\`\`

When it runs, \`cnpg.io/fencedInstances\` names the instance for the duration and clears afterwards. On this single-instance cluster that is thirty seconds during which nothing can connect.

Both schedules fire at second zero, so on every second minute they collide — and if the online one lands while the cold one has the instance fenced, it fails outright: *while ensuring target pod is healthy: no status found for target pod pg-cluster-1 in cluster pg-cluster*. If you see a \`failed\` row, that is what it is, and it is the argument for staggering schedules rather than pointing several of them at the same second of the same minute.

Compare what the two schedules produced:

\`\`\`
kubectl get backup -o custom-columns=NAME:.metadata.name,ONLINE:.spec.online,PHASE:.status.phase
\`\`\`

And the evidence inside the snapshots:

\`\`\`
for s in $(kubectl get volumesnapshot -o jsonpath='{.items[*].metadata.name}'); do
  printf "%-40s " "$s"
  kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' \\
    | grep "Database cluster state"
done
\`\`\`

The online ones say \`in production\`; the cold one says \`shut down\`. And only the online ones carry a backup label:

\`\`\`
kubectl get volumesnapshot -o yaml | grep -c "cnpg.io/backupLabelFile"
kubectl get backup --no-headers | wc -l
\`\`\`

Confirm the database is fine between runs:

\`\`\`
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\``,
      hint: `The cold schedule has no \`immediate\`, so nothing happens until the clock reaches second zero of an even minute. If \`kubectl get backup\` shows nothing from it yet, the loop simply has not waited long enough.`,
      solution: `diff /root/scheduled-online.yaml /root/scheduled-cold.yaml
kubectl apply -f /root/scheduled-cold.yaml
for i in $(seq 1 20); do printf "%s " "$(date +%T)"; kubectl get backup --no-headers | grep every-two-minutes | tr '\\n' ' '; printf "fenced="; kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}'; echo; sleep 10; done
kubectl get backup -o custom-columns=NAME:.metadata.name,ONLINE:.spec.online,PHASE:.status.phase
for s in $(kubectl get volumesnapshot -o jsonpath='{.items[*].metadata.name}'); do printf "%-40s " "$s"; kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' | grep "Database cluster state"; done
kubectl get cluster pg-cluster`,
    },

    {
      id: 'nobody-prunes-these',
      title: 'Find out who deletes the old ones',
      limitSec: 720,
      criteria: [
        'Both schedules are suspended',
        'The cluster now asks for new snapshots to be owned by their Backup',
        '/root/orphan-snapshot.txt names a snapshot that outlived its Backup',
        'And the snapshots that accumulated are all still there',
      ],
      brief: `Count what you have made in the last few minutes, and then ask the obvious question: what removes them?

Nothing does. The retention policy you may have seen on an object store is a Barman feature and applies to what Barman writes; a VolumeSnapshot is a Kubernetes object created by the CSI driver, and CloudNativePG does not prune them. A schedule left running quietly turns into an unbounded number of point-in-time copies of your entire volume, each of them charged for.

What you *can* control is whether deleting the Backup takes its snapshot with it. That is \`spec.backup.volumeSnapshot.snapshotOwnerReference\`, it defaults to \`none\`, and the difference is worth proving rather than assuming: delete a Backup now and watch its snapshot survive, then set the field and watch the next one behave differently.

Finally, stop the schedules — with \`suspend\`, which is the field that exists for exactly this and does not require deleting anything.`,
      instructions: `Take stock:

\`\`\`
kubectl get backup --no-headers | wc -l
kubectl get volumesnapshot --no-headers | wc -l
kubectl get volumesnapshot --no-headers | wc -l > /root/snapshot-count.txt
kubectl get cluster pg-cluster -o jsonpath='{.spec.backup.volumeSnapshot.snapshotOwnerReference}{"\\n"}'
\`\`\`

One snapshot per backup, and \`snapshotOwnerReference\` is \`none\` — nothing owns these objects, so nothing cascades to them.

Prove it. Take the oldest scheduled Backup, note the name, delete it, and look for the snapshot afterwards:

\`\`\`
VICTIM=$(kubectl get backup --no-headers | grep every-minute-online | head -1 | awk '{print $1}')
echo "$VICTIM" | tee /root/orphan-snapshot.txt
kubectl get volumesnapshot $VICTIM \\
  -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}/{.name}{"\\n"}{end}'; echo "(no owner if blank)"
kubectl delete backup $VICTIM
sleep 10
kubectl get volumesnapshot | grep $VICTIM
\`\`\`

The Backup is gone and the snapshot is still there, with no owner and now nothing pointing at it — an orphan, and the kind that is only ever noticed by somebody reading a bill.

Now change the setting and take one more backup to see the difference:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"backup":{"volumeSnapshot":{"snapshotOwnerReference":"backup"}}}}'
kubectl apply -f - <<'YAML'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: owned-backup
  namespace: default
spec:
  cluster:
    name: pg-cluster
  method: volumeSnapshot
YAML
sleep 30
kubectl get volumesnapshot owned-backup \\
  -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}/{.name}{"\\n"}{end}'
\`\`\`

This one is owned by its Backup. Delete the Backup and the snapshot goes with it, by ordinary Kubernetes garbage collection:

\`\`\`
kubectl delete backup owned-backup
sleep 10
kubectl get volumesnapshot
\`\`\`

Gone — while the orphan from a minute ago is still sitting there.

Now stop the schedules before they make any more:

\`\`\`
kubectl patch scheduledbackup every-minute-online --type=merge -p '{"spec":{"suspend":true}}'
kubectl patch scheduledbackup every-two-minutes-cold --type=merge -p '{"spec":{"suspend":true}}'
kubectl get scheduledbackup -o custom-columns=NAME:.metadata.name,SUSPEND:.spec.suspend,LAST:.status.lastScheduleTime,NEXT:.status.nextScheduleTime
\`\`\`

\`suspend\` stops the clock without deleting the object or anything it has made, which is what you want during an incident, a migration, or any window where fencing the database would be unwelcome.

So the operational shape of scheduled snapshot backups is: decide online or offline deliberately, because the schedule will do it every time and never ask; watch \`lastScheduleTime\` rather than assuming; set \`snapshotOwnerReference\` if you want deletions to cascade; and own the retention yourself, because nothing here will do it for you.`,
      hint: `The scheduled Backup and its VolumeSnapshot share a name, which is what makes the orphan easy to find afterwards — record the name before deleting the Backup.`,
      solution: `kubectl get volumesnapshot --no-headers | wc -l > /root/snapshot-count.txt
VICTIM=$(kubectl get backup --no-headers | grep every-minute-online | head -1 | awk '{print $1}')
echo "$VICTIM" | tee /root/orphan-snapshot.txt
kubectl delete backup $VICTIM
sleep 10
kubectl get volumesnapshot | grep $VICTIM
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"backup":{"volumeSnapshot":{"snapshotOwnerReference":"backup"}}}}'
kubectl patch scheduledbackup every-minute-online --type=merge -p '{"spec":{"suspend":true}}'
kubectl patch scheduledbackup every-two-minutes-cold --type=merge -p '{"spec":{"suspend":true}}'
kubectl get scheduledbackup -o custom-columns=NAME:.metadata.name,SUSPEND:.spec.suspend,LAST:.status.lastScheduleTime,NEXT:.status.nextScheduleTime`,
    },
  ],
}
