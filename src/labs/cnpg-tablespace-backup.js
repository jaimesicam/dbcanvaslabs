// Confirmed live against a real K3D + CloudNativePG deploy carrying the Barman Cloud plugin and
// a tablespace (server/cnpg.go, see LABORATORY.md). A plugin backup of a cluster with a
// tablespace completed in about six seconds, recording `beginWal: 000000010000000000000008` and
// a backup label reading `BACKUP FROM: standby`. Two failures were measured before the recovery
// worked, and both are in the lab because both are ordinary. Restoring immediately failed with
// `checking the presence of first needed WAL in the archive: object storage or file not found
// 000000010000000000000008: WAL not found` — the segment the backup begins in was still open on
// an idle database. And restoring into a cluster that declared no tablespaces failed with
// `Barman cloud restore exception: [Errno 30] Read-only file system:
// '/var/lib/postgresql/tablespaces'`, retried forever, with the cluster stuck at `Setting up
// primary`. Declaring the tablespace in the recovery cluster brought it up healthy in ~40s with
// its own `pg-restored-1-tbs-reporting` claim and all 500 rows still in the tablespace.
//
// Self-contained, like every lab here: the operator, the plugin, an object store with WAL
// archiving already working, a 3-instance cluster with a tablespace and a seeded table, a client
// Pod and two staged recovery manifests are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgTablespaceBackup = {
  id: 'cnpg-tablespace-backup',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real S3-compatible object store receiving this database\'s WAL, and a real PostgreSQL cluster with a real tablespace on top of it, all thrown away when you finish. Nothing is simulated, which is why this one takes longer than most: the backup plugin and its certificate stack are installed, the tablespace is attached (which rolls the cluster), and WAL archiving is waited for before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'cert-manager v1.19.1 and the Barman Cloud plugin v0.14.0, which is how CloudNativePG 1.30 archives WAL to object storage',
      'A SeaweedFS container published in-cluster as seaweedfs:8333, with an ObjectStore describing its cnpg-backups bucket',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, already archiving its WAL to that bucket, carrying a tablespace called reporting — one 1Gi volume per instance — with a table named quarterly inside it holding 500 rows',
      'No backups at all: the bucket has WAL in it and nothing else',
      'Two recovery manifests staged on the k3d-server node: /root/restore-without-tablespaces.yaml and /root/restore-with-tablespaces.yaml, differing in one block',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A base backup of a cluster with tablespaces contains the tablespaces, and restoring it needs somewhere to put them. In Kubernetes that somewhere is a volume, and a volume has to be asked for — so a recovery manifest that forgets the tablespaces has nowhere to unpack half the backup. You will take the backup, try the restore that forgets, read the failure it produces, and then do it properly.',
  },

  tasks: [
    {
      id: 'take-a-backup',
      title: 'Back up a cluster that has a tablespace',
      limitSec: 720,
      criteria: [
        'A backup of the cluster completed',
        'It records the WAL segment it begins from',
        '/root/first-wal.txt names that segment',
        'And the database has moved past it, so the archive has the whole segment',
      ],
      brief: `Taking the backup is the easy part: a \`Backup\` object with \`method: plugin\`, and the Barman Cloud plugin copies the data directory — tablespaces included — into the bucket. It finishes in seconds on a database this size.

The part worth doing carefully is what makes it restorable. A base backup begins somewhere inside a WAL segment, and recovery needs that whole segment from the archive before it can replay anything. On a busy database the segment fills and ships by itself; on an idle one it stays open indefinitely, and the backup that looks complete cannot actually be restored.

So take the backup, read the segment it begins from out of its own status, and then close that segment deliberately. It is one statement, and it is the difference between a backup and a backup you can use.`,
      instructions: `Work in the **k3d-server** tab. Look at what you are backing up:

\`\`\`
kubectl get cluster pg-cluster
kubectl get cluster pg-cluster -o jsonpath='{range .status.tablespacesStatus[*]}{.name}={.state} {end}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
kubectl get objectstore
kubectl get backup
\`\`\`

A tablespace called \`reporting\` with the \`quarterly\` table inside it, an object store, and no backups yet.

Ask for one:

\`\`\`
kubectl apply -f - <<'YAML'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: first-backup
  namespace: default
spec:
  cluster:
    name: pg-cluster
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
YAML
for i in $(seq 1 10); do
  kubectl get backup --no-headers
  sleep 6
done
\`\`\`

Completed in seconds. Now read what it wrote about itself:

\`\`\`
kubectl get backup first-backup -o jsonpath='{.status.beginWal}{"\\n"}' | tee /root/first-wal.txt
kubectl get backup first-backup -o jsonpath='{.status.beginLSN} {.status.endLSN} {.status.online}{"\\n"}'
kubectl get backup first-backup -o jsonpath='{.status.instanceID.podName}{"\\n"}'
\`\`\`

Three things in that output. \`beginWal\` is the segment recovery must start from. The begin and end LSNs are only a few kilobytes apart, because almost nothing happened while the copy ran. And the Pod named is a *standby* — the plugin's default target is \`prefer-standby\`, so the backup was taken without touching the primary at all.

Now make sure that first segment is really in the bucket. An idle database is still writing into it:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT pg_walfile_name(pg_current_wal_lsn());"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
sleep 10
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT pg_walfile_name(pg_current_wal_lsn());"
kubectl get cluster pg-cluster -o jsonpath='{range .status.conditions[?(@.type=="ContinuousArchiving")]}{.type}={.status}{"\\n"}{end}'
\`\`\`

Before the switch the primary was still writing into the very segment the backup begins in. After it, the primary has moved on, that segment is complete, and the archiver has shipped it.

This is worth taking seriously rather than treating as lab hygiene. A backup taken on a quiet database and never followed by a WAL switch fails at restore time with *checking the presence of first needed WAL in the archive: object storage or file not found … WAL not found* — a message that arrives weeks later, when somebody actually needs it.`,
      hint: `\`kubectl get backup first-backup -o jsonpath='{.status.beginWal}'\` is the segment; \`SELECT pg_switch_wal()\` on the primary closes it so the archiver ships it.`,
      solution: `kubectl apply -f - <<'YAML'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: first-backup
  namespace: default
spec:
  cluster:
    name: pg-cluster
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
YAML
sleep 40
kubectl get backup
kubectl get backup first-backup -o jsonpath='{.status.beginWal}{"\\n"}' | tee /root/first-wal.txt
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
sleep 10
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT pg_walfile_name(pg_current_wal_lsn());"`,
    },

    {
      id: 'forget-the-tablespaces',
      title: 'Recover it into a cluster with nowhere to put them',
      limitSec: 720,
      criteria: [
        '/root/forgot.txt records the restore failing on a read-only /var/lib/postgresql/tablespaces',
        '/root/forgot-phase.txt shows it stuck at Setting up primary, never becoming an instance',
        'The failed cluster has been removed again',
        'And the cluster it was recovering from never noticed',
      ],
      brief: `Recovery in CloudNativePG creates a *new* cluster from the manifest you give it. Whatever that manifest declares is what the recovered cluster gets — and if it declares no tablespaces, no tablespace volumes are created for it.

The backup, meanwhile, contains them. So the restore job unpacks the data directory, reaches the tablespace, and tries to write to \`/var/lib/postgresql/tablespaces\` — a path that exists inside the image but has no volume mounted over it, on a container whose root filesystem is read-only.

Watch how that failure presents, because it is not obvious from the outside: the Cluster sits at *Setting up primary* indefinitely while Job Pods appear, fail and are replaced. Nothing in the Cluster's own status says why. The reason is in the logs of a Pod that is already gone by the time you look for it, which is exactly why it is worth doing once on purpose.`,
      instructions: `Read the manifest that forgets, and apply it:

\`\`\`
cat /root/restore-without-tablespaces.yaml
kubectl apply -f /root/restore-without-tablespaces.yaml
\`\`\`

Watch what happens for a couple of minutes:

\`\`\`
for i in $(seq 1 10); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-forgot --no-headers 2>/dev/null
  sleep 10
done
kubectl get pods | grep forgot
\`\`\`

*Setting up primary*, forever, and a growing collection of \`pg-forgot-1-full-recovery-…\` Pods in \`Error\`. Each one is the restore being retried; each one fails the same way.

The reason is only in the Pod's log, and it has to be a Pod that has already failed — the newest one may not have got that far yet:

\`\`\`
P=$(kubectl get pods --no-headers | grep "forgot.*full-recovery" | grep Error | head -1 | awk '{print $1}')
kubectl logs $P --all-containers 2>&1 | grep -i "tablespace" | tail -2 | tee /root/forgot.txt
\`\`\`

*Barman cloud restore exception: [Errno 30] Read-only file system: '/var/lib/postgresql/tablespaces'*. The restore was reconstructing a data directory that contains a tablespace, and the directory it needed to write into is not a volume on this cluster — because nothing asked for one.

Record the state it is stuck in, too:

\`\`\`
kubectl get cluster pg-forgot -o jsonpath='{.status.phase}|{.status.phaseReason}{"\\n"}' | tee /root/forgot-phase.txt
\`\`\`

Now clean it up. Nothing here is salvageable, and a cluster that never had a running instance leaves nothing behind but its claims:

\`\`\`
kubectl delete cluster pg-forgot
kubectl get cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"
\`\`\`

The cluster you backed up never noticed any of this — recovery only ever reads the bucket.

The lesson is one line long and easy to lose: **a recovery manifest has to declare the same tablespaces as the cluster the backup came from.** Nothing warns you, because the operator has no way to know what is inside a backup until the restore job opens it.`,
      hint: `The Job Pods are named \`pg-forgot-1-full-recovery-…\`. \`kubectl logs <pod> --all-containers | grep -i tablespace\` is where the real error is; the Cluster's own status never says.`,
      solution: `kubectl apply -f /root/restore-without-tablespaces.yaml
sleep 90
kubectl get cluster pg-forgot
P=$(kubectl get pods --no-headers | grep "forgot.*full-recovery" | grep Error | head -1 | awk '{print $1}')
kubectl logs $P --all-containers 2>&1 | grep -i "tablespace" | tail -2 | tee /root/forgot.txt
kubectl get cluster pg-forgot -o jsonpath='{.status.phase}|{.status.phaseReason}{"\\n"}' | tee /root/forgot-phase.txt
kubectl delete cluster pg-forgot
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"`,
    },

    {
      id: 'recover-with-them',
      title: 'Declare the tablespace and recover properly',
      limitSec: 720,
      criteria: [
        'A cluster named pg-restored reports healthy',
        'It has a volume of its own for the reporting tablespace',
        'The quarterly table is there, still in that tablespace, with its 500 rows',
        'And the cluster it was recovered from is untouched',
      ],
      brief: `The second manifest differs from the first by one block: a \`tablespaces\` list naming \`reporting\` and asking for storage for it.

That is enough. The operator creates the tablespace claim before the restore job runs, mounts it where the backup expects it, and barman unpacks into a directory that is now a real volume. The cluster comes up healthy in well under a minute.

Look at the result from two directions afterwards. Inside PostgreSQL the table is where it always was, in the tablespace it was created in — recovery does not move relations around. Outside, the restored cluster has its own claim, its own volume and its own copy of the data, and the cluster the backup came from has not been touched at all.`,
      instructions: `See the difference between the two manifests first — it is the whole objective:

\`\`\`
diff /root/restore-without-tablespaces.yaml /root/restore-with-tablespaces.yaml
\`\`\`

A name and a \`tablespaces\` block. Apply it:

\`\`\`
kubectl apply -f /root/restore-with-tablespaces.yaml
for i in $(seq 1 10); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-restored --no-headers 2>/dev/null
  sleep 10
done
\`\`\`

Healthy in about forty seconds — *Setting up primary*, then *Waiting for the instances to become active*, then done.

Look at the storage it was given:

\`\`\`
kubectl get pvc | grep restored
kubectl exec pg-restored-1 -c postgres -- ls -l /var/lib/postgresql/data/pgdata/pg_tblspc/
\`\`\`

Two claims: the data volume and \`pg-restored-1-tbs-reporting\`. Inside the data directory the \`pg_tblspc\` symlink has been recreated, pointing at the mount — the same shape the original has, rebuilt from the backup.

And the data:

\`\`\`
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c \\
  "SELECT count(*) FROM quarterly;"
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c \\
  "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
kubectl get cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"
\`\`\`

500 rows, still in \`reporting\`, on a cluster that did not exist five minutes ago — and the original still serving alongside it.

Two things to carry away from the pair of attempts. A tablespace is part of the backup and part of the recovery manifest, and the two have to agree by name; nothing checks that for you until the restore job runs. And the recovery cluster does not have to match the original in *size* — this one is a single instance recovering a three-instance cluster's backup, and it only needed one volume per tablespace because it only has one instance.`,
      hint: `The tablespace names in the recovery manifest must match the ones in the backup. The size and storage class are yours to choose; the names are not.`,
      solution: `diff /root/restore-without-tablespaces.yaml /root/restore-with-tablespaces.yaml
kubectl apply -f /root/restore-with-tablespaces.yaml
sleep 90
kubectl get cluster
kubectl get pvc | grep restored
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM quarterly;"
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"`,
    },
  ],
}
