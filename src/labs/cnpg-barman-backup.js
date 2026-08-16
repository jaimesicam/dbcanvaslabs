// The ObjectStore resource, the plugin wiring, the rollout it triggers and everything the
// bucket ends up containing are confirmed live against a real K3D + CloudNativePG +
// SeaweedFS deploy (server/, see LABORATORY.md): a real backup really was written to
// s3://cnpg-backups/pg-cluster/base/, and a ScheduledBackup really fired on its cron.
// Grading reads the object store itself, not just the resources that claim to have written
// to it.
//
// Self-contained, like every lab here: the operator, cert-manager, the Barman Cloud plugin,
// a healthy cluster and a reachable object store are this lab's starting state, built by its
// own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgBarmanBackup = {
  id: 'cnpg-barman-backup',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, a real S3-compatible object store beside it, and a real PostgreSQL cluster with nothing backed up yet, all thrown away when you finish. Nothing is simulated, which is why this is the longest build of the set: three PostgreSQL instances bootstrap one at a time, and cert-manager and the Barman Cloud plugin are installed and waited for before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) with an empty cnpg-backups bucket, published inside the cluster as the Service seaweedfs on port 8333 — its credentials are the access key seaweedfs and the secret seaweedfs_password',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'cert-manager v1.19.1, because the Barman Cloud plugin authenticates to the operator with certificates it issues',
      'The Barman Cloud plugin v0.14.0, installed and Running, with its ObjectStore CRD registered',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — with no backup configuration of any kind and WAL archiving switched off',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client with the app credentials in its environment, and three manifests staged on the k3d-server node at /root/objectstore.yaml, /root/backup.yaml and /root/scheduledbackup.yaml — written, but deliberately not applied',
    ],
    yourJob:
      'The database is healthy and completely unprotected: no WAL archive, no base backup, nothing in the bucket. You will describe the object store to CloudNativePG, make the cluster archive to it, take a backup and watch it land in the bucket for real, then put backups on a schedule and watch the schedule fire.',
  },

  tasks: [
    {
      id: 'wire-the-store',
      title: 'Describe the object store',
      limitSec: 420,
      criteria: [
        'Secret seaweedfs-creds holds the object store credentials',
        'objectstore.barmancloud.cnpg.io/seaweedfs-store exists',
        'It points at the s3://cnpg-backups/ bucket on http://seaweedfs:8333',
      ],
      brief: `Backups in CloudNativePG 1.30 are handled by a plugin, and the plugin needs to be told where the bucket is and how to authenticate to it. That description is a resource of its own: an \`ObjectStore\`.

Create the credentials as an ordinary Secret first — the ObjectStore references them by name rather than containing them, so the keys never appear in a resource that gets copied around. Then apply the staged ObjectStore and read what it says.

Nothing is backed up at the end of this objective, and the cluster does not yet know this store exists. You have described a destination, which is a separate thing from using it.`,
      instructions: `Look at what has been staged for you:

\`\`\`
cat /root/objectstore.yaml
\`\`\`

It names a bucket (\`s3://cnpg-backups/\`), the endpoint to reach it at (\`http://seaweedfs:8333\`, the Service this environment publishes the object store as), a retention policy, gzip compression for WAL files, and — importantly — *references* to credentials rather than the credentials themselves.

So create those first:

\`\`\`
kubectl create secret generic seaweedfs-creds \\
  --from-literal=ACCESS_KEY_ID=seaweedfs \\
  --from-literal=ACCESS_SECRET_KEY=seaweedfs_password
\`\`\`

Then apply the store:

\`\`\`
kubectl apply -f /root/objectstore.yaml
kubectl get objectstore
kubectl describe objectstore seaweedfs-store | head -30
\`\`\`

That resource is only a description. Nothing archives to it yet, the bucket is still empty, and the Cluster has not been told it exists — which is the next objective.`,
      hint: `The key names in the Secret have to match what the ObjectStore references — \`ACCESS_KEY_ID\` and \`ACCESS_SECRET_KEY\`. Read them out of \`/root/objectstore.yaml\` rather than guessing.`,
      solution: `cat /root/objectstore.yaml
kubectl create secret generic seaweedfs-creds --from-literal=ACCESS_KEY_ID=seaweedfs --from-literal=ACCESS_SECRET_KEY=seaweedfs_password
kubectl apply -f /root/objectstore.yaml
kubectl get objectstore`,
    },

    {
      id: 'enable-archiving',
      title: 'Make the cluster archive to it',
      limitSec: 600,
      criteria: [
        'The Cluster declares the barman-cloud plugin as its WAL archiver',
        'It names the seaweedfs-store object store',
        'The cluster is healthy again after the rollout',
        'The cluster reports ContinuousArchiving=True',
        'WAL files have appeared in the bucket',
      ],
      brief: `Now connect the cluster to that store, by declaring the plugin in the Cluster's own spec and marking it as the WAL archiver.

Two things follow. The operator rolls the instances to add the plugin's machinery, so watch the cluster leave and re-enter its healthy state — this is a real rolling change, not a configuration reload. And PostgreSQL starts archiving: every completed WAL segment is shipped to the bucket instead of being recycled.

Continuous archiving is the half of a backup strategy people forget. A base backup on its own only restores you to the moment it was taken; the WAL archive is what lets you roll forward from there.`,
      instructions: `Declare the plugin on the Cluster:

\`\`\`
kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"plugins":[{"name":"barman-cloud.cloudnative-pg.io","isWALArchiver":true,"parameters":{"barmanObjectName":"seaweedfs-store"}}]}}'
\`\`\`

\`isWALArchiver: true\` is what makes this plugin responsible for shipping WAL; \`barmanObjectName\` points at the ObjectStore you created.

Watch what the operator does about it:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

READY drops below 3 for a while: the instances are rolled to pick up the plugin. Wait for "Cluster in healthy state" and 3 of 3 again.

Then ask the cluster whether archiving is actually working:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\\n"}{end}'
\`\`\`

\`ContinuousArchiving=True\` is the operator confirming that a WAL file really made it to the bucket — it does not take the configuration's word for it either.

The plugin's own view is more readable:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\`

Look for the "Continuous Backup status (Barman Cloud Plugin)" section: the object store and server name, "Working WAL archiving: OK", and "WALs waiting to be archived: 0". Force a segment switch — which is superuser work, so it goes over the instance's own socket rather than through the Service — and watch that number stay at zero:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
kubectl cnpg status pg-cluster | grep -i "wal"
\`\`\``,
      hint: `If the condition never turns True, check \`kubectl describe objectstore seaweedfs-store\` and the Secret's key names — a wrong key or endpoint shows up as archiving failures rather than as an apply-time error.`,
      solution: `kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"plugins":[{"name":"barman-cloud.cloudnative-pg.io","isWALArchiver":true,"parameters":{"barmanObjectName":"seaweedfs-store"}}]}}'
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\\n"}{end}'
kubectl cnpg status pg-cluster
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"`,
    },

    {
      id: 'take-a-backup',
      title: 'Take a backup, and find it in the bucket',
      limitSec: 480,
      criteria: [
        'A Backup resource exists, taken with the plugin method',
        'It reports phase completed',
        'A base backup really exists in the bucket',
      ],
      brief: `Ask for a backup. In CloudNativePG a backup is a resource you create, not a command you run: you create a \`Backup\` naming the cluster and the method, and the operator carries it out.

Watch it move through its phases to \`completed\`, then read what it recorded — where it wrote, and the WAL range it covers. That range is the link between the base backup and the archive: restoring means restoring this base and then replaying WAL from where it ends.

Then confirm from the cluster's own reporting that the store now holds something, rather than trusting the resource that says it wrote it.`,
      instructions: `Look at the staged request and apply it:

\`\`\`
cat /root/backup.yaml
kubectl apply -f /root/backup.yaml
\`\`\`

Its \`method: plugin\` and \`pluginConfiguration.name\` are what route the work to the Barman Cloud plugin rather than to volume snapshots. Watch it run:

\`\`\`
kubectl get backup
kubectl get backup first-backup -o jsonpath='{.status.phase}{"\\n"}'
\`\`\`

It goes to \`completed\` in well under a minute for a database this size. Read what it recorded:

\`\`\`
kubectl get backup first-backup -o yaml | sed -n '/^status:/,$p'
\`\`\`

Four fields are worth reading closely. \`backupId\` is a timestamp, and it is the name of the directory this backup occupies in the bucket. \`beginWal\` and \`endWal\` bracket it — everything committed after \`endWal\` lives in the WAL archive rather than in this base backup, which is exactly how the two halves fit together. \`online: true\` says it was taken without stopping the database. And \`instanceID.podName\` names the instance that did the work: the operator prefers a standby, so a base backup normally costs the primary nothing at all.

Now the cluster's own view of the store:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\`

"First Point of Recoverability" now has a timestamp, and "Last Successful Backup" names the moment this backup finished. Before this objective, both were empty — that pair of fields is the honest summary of what you can and cannot recover to.`,
      hint: `A Backup is a request, not a command: apply it and watch \`kubectl get backup\`. If it sits in \`running\` for a long time, check the operator's view with \`kubectl describe backup first-backup\`.`,
      solution: `cat /root/backup.yaml
kubectl apply -f /root/backup.yaml
kubectl get backup
kubectl get backup first-backup -o yaml | sed -n '/^status:/,$p'
kubectl cnpg status pg-cluster`,
    },

    {
      id: 'schedule-backups',
      title: 'Put backups on a schedule',
      limitSec: 480,
      criteria: [
        'A ScheduledBackup exists for pg-cluster',
        'It has fired at least once',
        'A Backup it created has completed',
      ],
      brief: `A backup you have to remember to take is not a backup strategy. Create a \`ScheduledBackup\` and let the operator take them for you.

The schedule is a six-field cron expression — seconds first, which is unusual enough to catch people out. The staged manifest uses every two minutes, which is absurd for production and exactly right for watching it work.

Each firing creates an ordinary \`Backup\` resource, owned by the schedule and named after the moment it ran. Wait for one, and check it completed the same way the one you took by hand did.`,
      instructions: `Read the staged schedule and apply it:

\`\`\`
cat /root/scheduledbackup.yaml
kubectl apply -f /root/scheduledbackup.yaml
kubectl get scheduledbackup
\`\`\`

The \`schedule\` field is \`0 */2 * * * *\` — six fields, starting with seconds, so this is "at second zero of every second minute", not "every two hours". \`backupOwnerReference: self\` makes each created Backup owned by the schedule, so deleting the schedule cleans up after itself.

Now wait a couple of minutes and watch backups appear on their own:

\`\`\`
kubectl get backup
kubectl get scheduledbackup
\`\`\`

Each is named for the moment it fired, and the ScheduledBackup's own LAST BACKUP column tells you how long ago that was. Confirm one of them completed:

\`\`\`
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,PHASE:.status.phase,OWNER:.metadata.ownerReferences[0].kind
\`\`\`

The hand-made one has no owner; the scheduled ones are owned by a \`ScheduledBackup\`. And the store's recoverability window has moved forward:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\``,
      hint: `Six fields, not five — a five-field expression is rejected. If nothing has fired yet, check the ScheduledBackup's \`.status.lastScheduleTime\` and give it up to two minutes.`,
      solution: `cat /root/scheduledbackup.yaml
kubectl apply -f /root/scheduledbackup.yaml
kubectl get scheduledbackup
kubectl get backup
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,PHASE:.status.phase,OWNER:.metadata.ownerReferences[0].kind
kubectl cnpg status pg-cluster`,
    },
  ],
}
