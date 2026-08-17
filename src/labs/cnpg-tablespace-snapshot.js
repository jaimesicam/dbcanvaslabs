// Confirmed live against a real K3D + CloudNativePG deploy with a snapshot-capable CSI driver
// and a tablespace (server/csi.go, see LABORATORY.md). A volumeSnapshot Backup of a
// single-instance cluster with one tablespace produced **two** VolumeSnapshots in about twelve
// seconds — `daily-snapshot` from the data claim and `daily-snapshot-tbs-reporting` from the
// tablespace claim, the second labelled `cnpg.io/tablespaceName: reporting` — both readyToUse.
// Recovering with only `volumeSnapshots.storage` mapped stalled silently: one Pending data claim,
// no tablespace claim, no Pod, no event, and the reason only in the operator's log —
// `cannot create primary instance PVCs: missing StorageSource for tablespace reporting PVC`.
// Mapping both under `tablespaceStorage` brought the cluster up healthy in about 40 seconds with
// both claims carrying the right `spec.dataSource` and all 500 rows still in the tablespace.
//
// One trap found the hard way and kept out of the lab by naming: a *cluster* called
// `pg-tbs-restored` broke tablespace discovery, because a tablespace's claim is named
// `<instance>-tbs-<tablespace>` and the operator read the cluster's own data claim as one. The
// restored cluster rolled its instance forever — "original and target PodSpec differ in volumes:
// element tbs-pgdata has been removed" — with the data correctly restored and the cluster never
// becoming ready. Renaming it `pg-restored`, nothing else changed, brought it up healthy in ~36s
// and it stayed healthy. Measured twice each way.
//
// Self-contained, like every lab here: the CSI driver, the operator, a single-instance cluster
// with a tablespace and a seeded table, a client Pod and three staged manifests are this lab's
// starting state, built by its own provisioning. No reference to any other lab (see CLAUDE.md,
// "Lab content contract").

export const cnpgTablespaceSnapshot = {
  id: 'cnpg-tablespace-snapshot',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real CSI driver that can take volume snapshots, and a real PostgreSQL cluster with a real tablespace on it, all thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: the snapshot API, its controller and the CSI driver are installed and waited for before the database is even bootstrapped.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The csi-driver-host-path CSI driver with a VolumeSnapshotClass called csi-hostpath-snapclass, and the snapshot CRDs and controller Kubernetes needs for any of this to exist',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A single-instance Cluster named pg-cluster with both its data volume and its reporting tablespace on the snapshot-capable StorageClass, and a table called quarterly inside that tablespace holding 500 rows',
      'Three manifests staged on the k3d-server node: /root/snapshot-backup.yaml, and two recovery templates — /root/restore.yaml.template and /root/restore-half.yaml.template — with the snapshot names left blank for you',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A volume snapshot copies one volume. A cluster with a tablespace has more than one, so its snapshot backup is a set of snapshots rather than a thing — and recovery is a mapping you have to write, naming which snapshot restores which volume. You will take the backup and see what it really produced, try a recovery that maps only half of it and find out where the operator tells you so, and then write the mapping properly.',
  },

  tasks: [
    {
      id: 'snapshot-every-volume',
      title: 'Snapshot a cluster that has a tablespace',
      limitSec: 600,
      criteria: [
        'The volumeSnapshot backup completed',
        'It produced one VolumeSnapshot per volume, not one for the cluster',
        "The tablespace's snapshot says which tablespace it holds",
        'Both are ready to use, and the cluster never stopped serving',
      ],
      brief: `A \`Backup\` with \`method: volumeSnapshot\` asks the storage layer for a copy of the instance's volumes. On a cluster with no tablespaces that is one volume and one VolumeSnapshot, and it is easy to think of the backup as a single object.

Here there are two volumes, so there are two snapshots, and the names are worth reading carefully: the data volume's snapshot takes the Backup's name, and each tablespace's is that name with \`-tbs-<tablespace>\` appended. Labels say the same thing more reliably — the tablespace's snapshot carries \`cnpg.io/tablespaceName\`.

That naming convention is worth remembering for a reason beyond reading a listing: the operator parses \`<instance>-tbs-<tablespace>\` when it works out which claims are tablespaces, so a cluster whose own name contains \`-tbs-\` confuses it — the last objective comes back to that.`,
      instructions: `Work in the **k3d-server** tab. Look at the volumes this cluster has:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pvc
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
\`\`\`

Two claims — the data volume and \`pg-cluster-1-tbs-reporting\` — both on the snapshot-capable class, with the table living in the tablespace.

Take the backup:

\`\`\`
cat /root/snapshot-backup.yaml
kubectl apply -f /root/snapshot-backup.yaml
for i in $(seq 1 8); do
  kubectl get backup --no-headers
  kubectl get pods -l cnpg.io/cluster=pg-cluster --no-headers
  echo "---"
  sleep 6
done
\`\`\`

Completed in about twelve seconds, and the instance stayed \`1/1 Running\` throughout — this is an online backup, so PostgreSQL kept serving.

Now look at what it left behind:

\`\`\`
kubectl get volumesnapshot
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,TABLESPACE:'.metadata.labels.cnpg\\.io/tablespaceName'
\`\`\`

Two snapshots, not one. \`daily-snapshot\` came from the data claim; \`daily-snapshot-tbs-reporting\` came from the tablespace claim and is labelled with the tablespace it holds. Both \`readyToUse\`.

This is the fact the rest of the lab turns on: **a snapshot backup of a cluster with tablespaces is a set of snapshots, and nothing joins them together except a shared name and the labels.** There is no single object you can point a recovery at and have it work out the rest — you will have to name each one.

Check the source is unharmed, which it will be, because a snapshot is a storage operation:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"
kubectl get cluster pg-cluster
\`\`\``,
      hint: `\`kubectl get volumesnapshot\` lists both. The tablespace's snapshot is the one whose SOURCE is the \`-tbs-reporting\` claim.`,
      solution: `kubectl apply -f /root/snapshot-backup.yaml
sleep 30
kubectl get backup
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,TABLESPACE:'.metadata.labels.cnpg\\.io/tablespaceName'
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"`,
    },

    {
      id: 'forget-the-mapping',
      title: 'Recover with only half the mapping',
      limitSec: 720,
      criteria: [
        '/root/missing-source.txt records the operator refusing to create the claims',
        '/root/stalled.txt records the half-mapped cluster with nothing running',
        'The half-mapped cluster has been removed again',
        'And nothing was taken from the cluster you snapshotted',
      ],
      brief: `Recovery from snapshots is a block under \`bootstrap.recovery.volumeSnapshots\`: \`storage\` names the snapshot the data directory comes from, and \`tablespaceStorage\` is a map from tablespace name to the snapshot that holds it.

Leave the map out and the manifest is still valid — the cluster declares a tablespace, so the operator knows it needs one, and nothing at admission time compares that against the recovery block.

What happens next is the part worth seeing. Nothing does. No Pod, no tablespace claim, a data claim stuck \`Pending\`, and a Cluster with an empty phase. The reason exists in exactly one place — the operator's own log — and this objective is about knowing to look there when a recovery produces silence rather than an error.`,
      instructions: `Build the half-mapped manifest from the template, filling in only the data snapshot:

\`\`\`
sed "s/DATA_SNAPSHOT/daily-snapshot/" /root/restore-half.yaml.template > /root/restore-half.yaml
cat /root/restore-half.yaml
kubectl apply -f /root/restore-half.yaml
\`\`\`

Accepted without complaint. Watch it not happen:

\`\`\`
for i in $(seq 1 8); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-half --no-headers 2>/dev/null
  sleep 10
done
kubectl get pvc | grep half
kubectl get pods | grep half
\`\`\`

An empty phase, one claim \`Pending\` on *waiting for first consumer*, no tablespace claim at all, and no Pod that could become the consumer. Record it:

\`\`\`
kubectl get cluster pg-half --no-headers | tee /root/stalled.txt
kubectl get pvc | grep half | tee -a /root/stalled.txt
\`\`\`

Now look for a reason in the obvious places, and fail to find one:

\`\`\`
kubectl describe cluster pg-half | tail -6
kubectl get events --sort-by=.lastTimestamp | grep half | tail -4
\`\`\`

Events about creating a ServiceAccount and a PodDisruptionBudget, and nothing about what is wrong. The Cluster's own conditions even claim it has been bootstrapped.

The reason is in the operator:

\`\`\`
kubectl -n cnpg-system logs deploy/cnpg-controller-manager --since=5m \\
  | grep -o "cannot create primary instance PVCs: [^\\"]*" | tail -1 | tee /root/missing-source.txt
\`\`\`

*cannot create primary instance PVCs: missing StorageSource for tablespace reporting PVC*. The operator will not invent a source for a volume you did not map, and it will not start an instance with a tablespace missing — so it stops, and says so where only \`kubectl logs\` will find it.

Clean up. Nothing was created that matters:

\`\`\`
kubectl delete cluster pg-half
kubectl get cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"
\`\`\`

Worth generalising: when a CloudNativePG cluster does nothing at all — no Pod, no events, no phase — the operator log is the place the answer lives, because a controller that cannot proceed has nowhere else to write.`,
      hint: `The failure is not on the Cluster and not in its events. \`kubectl -n cnpg-system logs deploy/cnpg-controller-manager\` and grep for \`cannot create primary instance PVCs\`.`,
      solution: `sed "s/DATA_SNAPSHOT/daily-snapshot/" /root/restore-half.yaml.template > /root/restore-half.yaml
kubectl apply -f /root/restore-half.yaml
sleep 60
kubectl get cluster pg-half --no-headers | tee /root/stalled.txt
kubectl get pvc | grep half | tee -a /root/stalled.txt
kubectl -n cnpg-system logs deploy/cnpg-controller-manager --since=5m | grep -o "cannot create primary instance PVCs: [^\\"]*" | tail -1 | tee /root/missing-source.txt
kubectl delete cluster pg-half
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"`,
    },

    {
      id: 'map-them-back',
      title: 'Map every volume and recover',
      limitSec: 720,
      criteria: [
        'A cluster named pg-restored reports healthy',
        'Its data volume was created from the data snapshot',
        "And its tablespace volume from the tablespace's own snapshot",
        'With the quarterly table still in the reporting tablespace, all 500 rows',
      ],
      brief: `The full template has both halves: \`storage\` for the data directory and a \`tablespaceStorage\` entry keyed by tablespace name.

Substitute the two snapshot names you read earlier and apply it. The operator creates both claims from their snapshots, mounts them where PostgreSQL expects, and the instance starts on a data directory whose tablespace symlink already points at a volume with the right contents in it. It takes about forty seconds.

Then check the claims rather than the database. \`spec.dataSource\` on each one records the snapshot it was built from, which is the only artefact that proves the mapping did what you meant rather than something that happened to work.`,
      instructions: `Fill in both names and read the block you produced:

\`\`\`
kubectl get volumesnapshot --no-headers | awk '{print $1}'
sed -e "s/DATA_SNAPSHOT/daily-snapshot/" \\
    -e "s/REPORTING_SNAPSHOT/daily-snapshot-tbs-reporting/" \\
    /root/restore.yaml.template > /root/restore.yaml
grep -A 12 "volumeSnapshots:" /root/restore.yaml
kubectl apply -f /root/restore.yaml
\`\`\`

Watch it come up:

\`\`\`
for i in $(seq 1 8); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-restored --no-headers 2>/dev/null
  sleep 10
done
\`\`\`

*Setting up primary*, *Waiting for the instances to become active*, healthy — about forty seconds, with a \`pg-restored-1-snapshot-recovery-…\` Pod doing the work and then reporting Completed.

Now the proof, from the claims:

\`\`\`
kubectl get pvc | grep restored
kubectl get pvc pg-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
kubectl get pvc pg-restored-1-tbs-reporting -o jsonpath='{.spec.dataSource}{"\\n"}'
\`\`\`

Each claim names the snapshot it was created from — the data one from \`daily-snapshot\`, the tablespace one from \`daily-snapshot-tbs-reporting\`. That is the mapping you wrote, recorded by Kubernetes rather than by the operator.

And from the database:

\`\`\`
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c \\
  "SELECT count(*) FROM quarterly;"
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c \\
  "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
kubectl exec pg-restored-1 -c postgres -- ls -l /var/lib/postgresql/data/pgdata/pg_tblspc/
kubectl get cluster
\`\`\`

500 rows, still in \`reporting\`, with the \`pg_tblspc\` symlink rebuilt to point at the restored volume — and the cluster you snapshotted still serving alongside it.

Three things to take away. A snapshot backup of a cluster with tablespaces is only as restorable as your record of which snapshot is which, so keep the Backup name and let the convention do the rest. The mapping is manual and unchecked until the operator tries to build the claims.

And do not put \`-tbs-\` in the name of a cluster that has tablespaces. A tablespace's claim is named \`<instance>-tbs-<tablespace>\`, and the operator parses that shape to decide which claims are tablespaces — so a cluster called \`pg-tbs-restored\` had its own data claim read as a tablespace's. The symptom is nasty because everything looks right: the data restores correctly, both claims are bound, the rows are all there, and the cluster rolls its instance every twenty seconds forever, repeating *original and target PodSpec differ in volumes: element tbs-pgdata has been removed*. Renaming the cluster is the whole fix.`,
      hint: `Two substitutions: \`DATA_SNAPSHOT\` becomes the snapshot named after the backup, \`REPORTING_SNAPSHOT\` the one ending \`-tbs-reporting\`. \`grep -A 12 volumeSnapshots:\` before applying is the quickest way to be sure.`,
      solution: `sed -e "s/DATA_SNAPSHOT/daily-snapshot/" -e "s/REPORTING_SNAPSHOT/daily-snapshot-tbs-reporting/" /root/restore.yaml.template > /root/restore.yaml
kubectl apply -f /root/restore.yaml
sleep 70
kubectl get cluster
kubectl get pvc pg-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
kubectl get pvc pg-restored-1-tbs-reporting -o jsonpath='{.spec.dataSource}{"\\n"}'
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM quarterly;"
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"`,
    },
  ],
}
