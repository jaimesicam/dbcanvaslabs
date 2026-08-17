// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md).
// Declaring two tablespaces on a running 3-instance cluster rolled it and reported both
// `reconciled` about 50 seconds later, having created one PVC per instance per tablespace —
// `pg-cluster-1-tbs-reporting` and friends, labelled `cnpg.io/pvcRole: PG_TABLESPACE` and
// `cnpg.io/tablespaceName`. PostgreSQL's own view agrees: `pg_tablespace_location` reads
// `/var/lib/postgresql/tablespaces/<name>/data`, and inside the data directory
// `pg_tblspc/16389` is a symlink to it. The webhook fills in what you leave out — `owner: app`,
// `temporary: false`, `resizeInUseVolumes: true`. And removing one is refused outright:
// `no tablespace can be deleted once created`.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a client
// Pod are this lab's starting state, built by its own provisioning. No reference to any other
// lab (see CLAUDE.md, "Lab content contract").

export const cnpgTablespaces = {
  id: 'cnpg-tablespaces',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, on k3s\'s own local-path storage, with one 1Gi volume per instance and no tablespaces at all',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A tablespace in PostgreSQL is a directory the server may put relations in — the mechanism behind "keep the reports on the cheap disk". In Kubernetes a directory is a volume, so CloudNativePG makes a tablespace a declaration: name it in the Cluster and the operator creates a claim for it on every instance, mounts it, and issues the CREATE TABLESPACE. You will declare two, put a table inside one and follow it down to the file, and then find the one thing this mechanism will not let you do.',
  },

  tasks: [
    {
      id: 'declare-them',
      title: 'Declare two tablespaces',
      limitSec: 720,
      criteria: [
        'The Cluster declares the reporting and archive tablespaces',
        'Both report reconciled, on a healthy cluster',
        'Every instance has its own volume for each of them',
        'And PostgreSQL knows about both, with their own locations',
      ],
      brief: `A tablespace here is an entry under \`spec.tablespaces\`: a name and a storage block, and optionally an owner.

What the operator does with it is more than a \`CREATE TABLESPACE\`. Each instance needs its own copy of the directory — a standby replays the primary's writes into its own files — so declaring one tablespace on a three-instance cluster creates three PersistentVolumeClaims, mounts each into its instance, and only then tells PostgreSQL about it.

Attaching a volume means the Pods are replaced, so expect a rolling update, and watch two different things while it happens: the cluster's phase, and \`status.tablespacesStatus\`, which is where each tablespace reports its own progress from \`pending\` to \`reconciled\`.`,
      instructions: `Work in the **k3d-server** tab. Look at the storage this cluster has before you start:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pvc
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\db"
\`\`\`

One volume per instance, and PostgreSQL's own two built-in tablespaces, \`pg_default\` and \`pg_global\`, which are not directories you chose.

Declare two of your own. \`reporting\` names an owner; \`archive\` deliberately does not, so you can see what the webhook does about that:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"tablespaces": [
    {"name": "reporting", "storage": {"size": "1Gi"}, "owner": {"name": "app"}},
    {"name": "archive",   "storage": {"size": "1Gi"}}
  ]}}'
\`\`\`

Now watch. This takes about a minute, and both halves of the output are worth following:

\`\`\`
for i in $(seq 1 12); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-cluster -o jsonpath='{.status.phase}|{range .status.tablespacesStatus[*]}{.name}={.state} {end}'
  echo
  sleep 10
done
\`\`\`

The phase goes through *Waiting for the instances to become active* and *Primary instance is being restarted without a switchover* — the roll that attaches the volumes — while the tablespaces move from \`pending\` to \`reconciled\`.

Look at what was created:

\`\`\`
kubectl get pvc
kubectl get pvc pg-cluster-1-tbs-reporting -o jsonpath='{.metadata.labels}{"\\n"}'
\`\`\`

Six new claims, named \`<instance>-tbs-<tablespace>\`, each labelled \`cnpg.io/pvcRole: PG_TABLESPACE\` and \`cnpg.io/tablespaceName\`. Three instances, two tablespaces, six volumes — a tablespace is not one shared directory, it is one directory per instance.

And ask PostgreSQL what it thinks it has:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT spcname, pg_get_userbyid(spcowner) AS owner, pg_tablespace_location(oid) FROM pg_tablespace ORDER BY spcname;"
kubectl exec pg-cluster-1 -c postgres -- ls -l /var/lib/postgresql/tablespaces/
\`\`\`

Both are real, each at \`/var/lib/postgresql/tablespaces/<name>/data\`, and both are owned by \`app\` — including the one you gave no owner, which is the webhook filling in the application user for you.`,
      hint: `\`spec.tablespaces\` is a list, so both entries go in one patch. Give each a \`name\` and a \`storage.size\`; everything else has a default.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"tablespaces":[{"name":"reporting","storage":{"size":"1Gi"},"owner":{"name":"app"}},{"name":"archive","storage":{"size":"1Gi"}}]}}'
sleep 90
kubectl get cluster pg-cluster -o jsonpath='{.status.phase}|{range .status.tablespacesStatus[*]}{.name}={.state} {end}'; echo
kubectl get pvc
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT spcname, pg_get_userbyid(spcowner) AS owner, pg_tablespace_location(oid) FROM pg_tablespace ORDER BY spcname;"`,
    },

    {
      id: 'put-a-table-in-one',
      title: 'Put a table in one and follow it to the disk',
      limitSec: 600,
      criteria: [
        'A table called quarterly lives in the reporting tablespace',
        'It holds 1000 rows',
        'Its files really are under /var/lib/postgresql/tablespaces/reporting on the primary',
        'And every replica has the same rows in its own copy of the tablespace',
      ],
      brief: `Using a tablespace is ordinary SQL: \`CREATE TABLE ... TABLESPACE reporting\`. Nothing about Kubernetes appears in the statement, which is the point — the declaration arranged the storage, and PostgreSQL is unchanged.

Then follow the table down to the filesystem. Inside the data directory there is a \`pg_tblspc\` directory holding one symlink per tablespace, named after its OID and pointing at the mount. That symlink is the whole implementation, and seeing it is what makes the abstraction stop being magic.

Finally, check a replica. Each instance has its own volume for this tablespace, filled by replaying the primary's WAL — so the rows are there, in a different physical copy, on a different node.`,
      instructions: `Create the table and fill it, through the read-write Service:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "CREATE TABLE quarterly (id serial primary key, entry text) TABLESPACE reporting;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "INSERT INTO quarterly (entry) SELECT 'row-'||g FROM generate_series(1,1000) g;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
\`\`\`

\`pg_tables\` says \`reporting\`. Now find it on disk:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SHOW data_directory;"
kubectl exec pg-cluster-1 -c postgres -- ls -l /var/lib/postgresql/data/pgdata/pg_tblspc/
kubectl exec pg-cluster-1 -c postgres -- du -sh /var/lib/postgresql/tablespaces/reporting
\`\`\`

\`pg_tblspc\` holds a symlink named after the tablespace's OID, pointing at \`/var/lib/postgresql/tablespaces/reporting/data\` — the volume the operator mounted. Every relation you put in that tablespace is written through that link, onto that claim, and not onto the instance's main data volume.

Now check a replica has its own copy:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -c \\
  "SELECT count(*) FROM quarterly;"
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -c \\
  "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
kubectl exec pg-cluster-2 -c postgres -- ls -l /var/lib/postgresql/data/pgdata/pg_tblspc/
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM quarterly;"
\`\`\`

Same rows, same tablespace, a different volume on a different node. The standby did not copy a directory from the primary — it replayed the WAL into storage of its own, which is why every instance needed a claim before any of them could have the tablespace.

Worth being clear about what this does and does not buy you. Tablespaces let you put relations on storage with different characteristics — a different StorageClass per tablespace, if you name one. What they are *not* is a way to share a disk between instances, and they are not free: every tablespace multiplies your volume count by the number of instances.`,
      hint: `The \`TABLESPACE\` clause goes at the end of \`CREATE TABLE\`. If you forget it, drop the table and create it again — an existing table can be moved with \`ALTER TABLE ... SET TABLESPACE\`, but that rewrites it.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE quarterly (id serial primary key, entry text) TABLESPACE reporting;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO quarterly (entry) SELECT 'row-'||g FROM generate_series(1,1000) g;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT tablename, tablespace FROM pg_tables WHERE tablename = 'quarterly';"
kubectl exec pg-cluster-1 -c postgres -- ls -l /var/lib/postgresql/data/pgdata/pg_tblspc/
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM quarterly;"
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM quarterly;"`,
    },

    {
      id: 'no-taking-it-back',
      title: 'Try to take one away',
      limitSec: 600,
      criteria: [
        '/root/no-delete.txt records the operator refusing to remove one',
        'Both tablespaces are still declared, and still reconciled',
        'The owner the webhook filled in is on the tablespace nobody gave one to',
        'And the table inside one of them is still readable',
      ],
      brief: `Declaring a tablespace is easy. Undeclaring one is not allowed at all.

Take \`archive\` out of the list and apply it. The request never reaches the cluster: the operator's admission webhook rejects it, in one sentence, before anything is written.

That is a deliberate refusal rather than a missing feature. A tablespace may hold relations, and the operator has no way to know what dropping it would cost you — so removing it is left to you and PostgreSQL, and the Cluster resource will not do it on your behalf. Which makes a declared tablespace a decision you should expect to live with.

While you are reading the spec, notice what else is in it that you never wrote.`,
      instructions: `Try to remove \`archive\` by sending the list without it, and keep what comes back:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"tablespaces": [
    {"name": "reporting", "storage": {"size": "1Gi"}, "owner": {"name": "app"}}
  ]}}' 2>&1 | tee /root/no-delete.txt
\`\`\`

*no tablespace can be deleted once created*. Nothing was written — this is admission control, so the Cluster is exactly as it was:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{range .status.tablespacesStatus[*]}{.name}={.state} {end}{"\\n"}'
kubectl get pvc | grep tbs
\`\`\`

Now read the spec as the operator stores it:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.tablespaces}{"\\n"}'
\`\`\`

Three things are there that you never typed: \`owner: {name: app}\` on the tablespace you gave no owner, \`temporary: false\`, and \`resizeInUseVolumes: true\` inside the storage block. Defaulting happens at admission, so what you sent and what the cluster holds are not the same document — worth remembering when a later patch has to send the whole list back.

Confirm nothing was disturbed by the attempt:

\`\`\`
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"
\`\`\`

Two practical consequences to take away. Because the list is replaced wholesale by a merge patch and shrinking it is refused, every later change has to resend every tablespace you already have. And because a tablespace cannot be undeclared, adding one is a decision about the shape of every instance in the cluster, for as long as the cluster exists — the storage stays attached even if you drop everything in it.`,
      hint: `Send the patch with \`archive\` left out and let it fail — the refusal is the thing to capture. \`2>&1 | tee /root/no-delete.txt\` keeps the message and still shows it to you.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"tablespaces":[{"name":"reporting","storage":{"size":"1Gi"},"owner":{"name":"app"}}]}}' 2>&1 | tee /root/no-delete.txt
kubectl get cluster pg-cluster -o jsonpath='{.spec.tablespaces}{"\\n"}'
kubectl get cluster pg-cluster -o jsonpath='{range .status.tablespacesStatus[*]}{.name}={.state} {end}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM quarterly;"`,
    },
  ],
}
