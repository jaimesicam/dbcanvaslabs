// Confirmed live against a real K3D + CloudNativePG deploy with a real CSI driver (server/csi.go,
// see LABORATORY.md): `kubectl cnpg backup pg-cluster -m volumeSnapshot` created a Backup named
// pg-cluster-20260817011046 — the cluster name and a timestamp — which completed in about 13
// seconds with spec.online left unset, so the cluster's own default applied. Adding
// `--online=false --backup-name cold-by-plugin` produced a Backup with spec.online false that
// fenced the instance for the duration (cnpg.io/fencedInstances named it) and left a snapshot
// whose recorded control file reads `shut down` and which carries no backup label.
// `kubectl cnpg status` reports the First Point of Recoverability and the archiving state.
//
// Self-contained, like every lab here: the CSI driver, the operator, a single-instance cluster on
// a snapshot-capable StorageClass, the cnpg plugin, a seeded table and a client Pod are this
// lab's starting state, built by its own provisioning. No reference to any other lab (see
// CLAUDE.md, "Lab content contract").

export const cnpgPluginSnapshotBackup = {
  id: 'cnpg-plugin-snapshot-backup',
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
      'A single-instance Cluster named pg-cluster on the snapshot-capable StorageClass, with a table called notes holding 50 rows',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
      'No backup manifests staged anywhere — every object in this lab is created by a plugin command',
    ],
    yourJob:
      'Taking a backup right now, because somebody is about to do something frightening, is not a moment for writing YAML. The cnpg plugin has a command for it, and the interesting thing about that command is how little it hides: it builds an ordinary Backup object out of its flags and hands it to the operator, which does exactly what it would have done for a manifest. You will take one backup with no flags at all and one with the flag that stops the database first, and then read what the plugin actually created.',
  },

  tasks: [
    {
      id: 'plugin-backup',
      title: 'Take a backup with one command',
      limitSec: 480,
      criteria: [
        'The plugin created a volumeSnapshot Backup, and it completed',
        'It was taken online, which is what the plugin asks for by default',
        'Its VolumeSnapshot is ready to use',
        'And the cluster is healthy — nothing was interrupted',
      ],
      brief: `\`kubectl cnpg backup\` takes a cluster name and asks for a backup now. Everything else is a flag with a sensible default, and the defaults come from the Cluster's own \`spec.backup\` — so a command with no flags takes the kind of backup the cluster was configured to take.

Read the help before running it. Every flag maps to a field on the Backup resource, and knowing which is which is the difference between using the plugin and guessing at it.

Then run it, and watch the object appear. The name it chooses when you do not supply one is worth noticing: the cluster's name and a timestamp, which is exactly what you would have typed and exactly what makes two backups on the same day distinguishable.`,
      instructions: `Work in the **k3d-server** tab. Read what the command offers:

\`\`\`
kubectl cnpg backup --help
\`\`\`

The flags are a map of the Backup resource: \`-m/--method\` is \`spec.method\`, \`--online\` is \`spec.online\`, \`--backup-name\` is the object's name, \`-t/--backup-target\` overrides \`spec.backup.target\` on the cluster, and \`--immediate-checkpoint\` and \`--wait-for-archive\` set the two fields of \`spec.onlineConfiguration\`. The plugin validates them and builds the object; it does not do the backup itself.

Take one:

\`\`\`
kubectl cnpg backup pg-cluster -m volumeSnapshot
\`\`\`

It prints the name it chose — \`pg-cluster-\` followed by a timestamp. Watch it run:

\`\`\`
for i in $(seq 1 8); do
  kubectl get backup --no-headers
  kubectl get pods -l cnpg.io/cluster=pg-cluster --no-headers
  echo "---"
  sleep 6
done
\`\`\`

Completed in around fifteen seconds, and the instance never left \`1/1 Running\` — the default is an online backup, so PostgreSQL kept serving throughout.

Look at what was created:

\`\`\`
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,TARGET:.spec.target,PHASE:.status.phase
kubectl get volumesnapshot
\`\`\`

Two things worth noticing in that table. \`ONLINE\` is \`<none>\`: the plugin did not set \`spec.online\` at all, because you did not ask it to, so the Cluster's \`spec.backup.volumeSnapshot.online\` decides — which is what "defaults come from the cluster" means in practice. And \`TARGET\` is empty for the same reason.

Confirm the snapshot is real and usable:

\`\`\`
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,SIZE:.status.restoreSize
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\``,
      hint: `\`-m volumeSnapshot\` is required here because it overrides the backup method; without it the plugin asks for whatever method the cluster's \`spec.backup\` describes, and this cluster describes none.`,
      solution: `kubectl cnpg backup --help
kubectl cnpg backup pg-cluster -m volumeSnapshot
sleep 30
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,TARGET:.spec.target,PHASE:.status.phase
kubectl get volumesnapshot
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster pg-cluster`,
    },

    {
      id: 'cold-by-plugin',
      title: 'Ask for one with the database stopped',
      limitSec: 600,
      criteria: [
        'A Backup named cold-by-plugin completed',
        'The plugin asked for it offline — spec.online is false',
        'Its snapshot records a shut down database and carries no backup label',
        'And the instance is Ready again, with nothing fenced',
      ],
      brief: `Two flags this time. \`--backup-name\` names the object, which matters more than it sounds: a backup you may need to find under pressure should not be called \`pg-cluster-20260817011046\`. And \`--online=false\` asks for the snapshot to be taken with PostgreSQL stopped.

Watch the cluster while it runs, not just the Backup. An offline backup is implemented by fencing the target instance, and the fence is visible as an annotation on the Cluster for exactly as long as the backup takes.

Then look at the two snapshots side by side. The mode is not something you have to remember or write down — CloudNativePG records the state of the database inside each snapshot, and the two records disagree in a way that cannot be misread.`,
      instructions: `Ask for a cold backup with a name of your own:

\`\`\`
kubectl cnpg backup pg-cluster -m volumeSnapshot --online=false --backup-name cold-by-plugin
\`\`\`

Watch both the Backup and the Cluster's annotations while it runs:

\`\`\`
for i in $(seq 1 12); do
  printf "%s " "$(date +%T)"
  kubectl get backup cold-by-plugin --no-headers | tr '\\n' ' '
  printf "fenced="
  kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}'
  echo
  sleep 6
done
\`\`\`

While the backup is running, \`cnpg.io/fencedInstances\` names the instance: the operator has stopped PostgreSQL inside it without deleting the Pod. When the backup completes the annotation is gone and the instance comes back. About thirty seconds in total, a little longer than the online one, because stopping and starting a database is part of the work.

Now compare the two backups:

\`\`\`
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,PHASE:.status.phase
\`\`\`

The cold one says \`false\`; the first one still says \`<none>\`. That is the difference between "I asked for this explicitly" and "whatever the cluster does by default", and it is worth keeping in mind when reading somebody else's backups.

And compare the snapshots, which is where the evidence actually lives:

\`\`\`
for s in $(kubectl get volumesnapshot -o jsonpath='{.items[*].metadata.name}'); do
  printf "%-30s " "$s"
  kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' \\
    | grep "Database cluster state"
done
kubectl get volumesnapshot cold-by-plugin -o yaml | grep "cnpg.io/backupLabelFile" | wc -l
\`\`\`

One says \`in production\` and one says \`shut down\`, and the cold one has no backup label at all — there was no running server to bracket with \`pg_backup_start\` and \`pg_backup_stop\`, so there is nothing to label.

Check the database is back:

\`\`\`
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\`

Worth being clear about the cost you just paid. On a replicated cluster the default target is a standby, so an offline backup costs you a replica for half a minute. This cluster has one instance, so what it cost was the database — which is fine here and would not be at four in the afternoon.`,
      hint: `\`--online\` takes a value rather than being a switch: write \`--online=false\`. The plugin's help lists the accepted values as \`true|false|""\`.`,
      solution: `kubectl cnpg backup pg-cluster -m volumeSnapshot --online=false --backup-name cold-by-plugin
for i in $(seq 1 12); do printf "%s " "$(date +%T)"; kubectl get backup cold-by-plugin --no-headers | tr '\\n' ' '; printf "fenced="; kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}'; echo; sleep 6; done
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,PHASE:.status.phase
for s in $(kubectl get volumesnapshot -o jsonpath='{.items[*].metadata.name}'); do printf "%-30s " "$s"; kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' | grep "Database cluster state"; done
kubectl get cluster pg-cluster`,
    },

    {
      id: 'what-the-plugin-made',
      title: 'Read what the plugin left behind',
      limitSec: 480,
      criteria: [
        "Both of the plugin's Backups are ordinary Backup objects, and both completed",
        'One asked for online and the other did not',
        '/root/backups.txt lists what the plugin created',
        'And the cluster records when it was last backed up',
      ],
      brief: `The point of this objective is anticlimactic on purpose: there is nothing special about what the plugin made.

Both objects are ordinary \`Backup\` resources. You could have written either of them by hand, and anything reconciling your cluster from Git can read them, diff them or recreate them. The plugin is a way of typing less, not a separate mechanism — which is exactly what you want from a command you might run in a hurry.

Then look at the cluster itself, which keeps its own summary of when it was last backed up and how far back it could be recovered. That is the number worth putting on a dashboard, because it is the one that answers "when did this last work".`,
      instructions: `Dump one of the objects the plugin created and read it as YAML:

\`\`\`
kubectl get backup cold-by-plugin -o yaml | head -30
\`\`\`

A \`spec\` with \`cluster\`, \`method\` and \`online\`, and a \`status\` the operator filled in. Nothing the plugin did could not have been done by \`kubectl apply\`.

Record both names for later:

\`\`\`
kubectl get backup -o custom-columns=NAME:.metadata.name,ONLINE:.spec.online,PHASE:.status.phase | tee /root/backups.txt
\`\`\`

Now ask the cluster what it thinks about its backups:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.lastSuccessfulBackup}{"\\n"}'
kubectl get cluster pg-cluster -o jsonpath='{.status.firstRecoverabilityPoint}{"\\n"}'
kubectl get cluster pg-cluster -o jsonpath='{.status.lastSuccessfulBackupByMethod}{"\\n"}'
\`\`\`

Three summaries maintained by the operator: when the last backup succeeded, the earliest point you could recover to, and the same broken down by method — which matters on a cluster taking both object-store and snapshot backups.

The plugin has a view of the same thing, and it is the one you will actually type:

\`\`\`
kubectl cnpg status pg-cluster
\`\`\`

Under **Continuous Backup status** it reports the First Point of Recoverability, whether WAL archiving is working, and the last segment archived. Read that carefully against \`lastSuccessfulBackupByMethod\` above it: the only method listed is \`volumeSnapshot\`, so the recoverability point you are being shown comes from these two snapshots and nothing else.

That is the honest limit of what you have built in this lab. Two snapshots are two moments, and a database you can restore to *any* moment needs somewhere those WAL segments are kept and can be fetched from — an object store the cluster is configured to write to. The plugin has flags for that world too: \`--wait-for-archive\` exists precisely because an online backup normally waits for the WAL it needs to reach the archive before declaring itself complete.`,
      hint: `\`tee\` writes the listing to the file and still prints it. The check reads that file for the names of both backups.`,
      solution: `kubectl get backup cold-by-plugin -o yaml | head -30
kubectl get backup -o custom-columns=NAME:.metadata.name,ONLINE:.spec.online,PHASE:.status.phase | tee /root/backups.txt
kubectl get cluster pg-cluster -o jsonpath='{.status.lastSuccessfulBackup}{"\\n"}'
kubectl get cluster pg-cluster -o jsonpath='{.status.firstRecoverabilityPoint}{"\\n"}'
kubectl get cluster pg-cluster -o jsonpath='{.status.lastSuccessfulBackupByMethod}{"\\n"}'
kubectl cnpg status pg-cluster`,
    },
  ],
}
