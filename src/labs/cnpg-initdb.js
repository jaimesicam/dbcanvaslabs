// Every behaviour below is confirmed live against a real K3D + CloudNativePG deploy (server/,
// see LABORATORY.md): a cluster bootstrapped with database `orders` owned by `shop`,
// `walSegmentSize: 32` (pg_settings reports 33554432), `dataChecksums: true`, and both
// post-init hooks running — postInitApplicationSQL created and seeded a table inside the
// application database, postInitSQL created a role in the postgres database.
//
// The lab's spine is what happened next: patching `database`, `walSegmentSize` and
// `dataChecksums` on the running cluster was **accepted** by the API server with no warning,
// leaving the spec saying `renamed`/64/false while the database was still `orders` with 32MB
// segments and checksums on. `bootstrap` is a one-shot instruction, not desired state.
//
// One detail worth not misreading: `data_checksums` is on even in a cluster that never asked
// for it, because PostgreSQL 18's own initdb enables checksums by default. CNPG's
// `dataChecksums: false` means "do not pass -k", not "turn them off".
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator and a staged manifest are this lab's
// starting state, built by its own provisioning. No reference to any other lab (see
// CLAUDE.md, "Lab content contract").

export const cnpgInitdb = {
  id: 'cnpg-initdb',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster with the CloudNativePG operator installed and, deliberately, no database at all. Nothing is simulated. Creating the database is the lab, and the choices you make in its manifest are ones that can never be changed afterwards.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A Cluster manifest staged at /root/initdb-cluster.yaml on the k3d-server node — a two-instance cluster named pg-init with a fully spelled-out bootstrap.initdb block, written but deliberately not applied',
      'No PostgreSQL cluster running at all — creating one is the first objective',
    ],
    yourJob:
      'Every PostgreSQL cluster begins with initdb, and a handful of the decisions initdb makes are written into the data directory permanently: the encoding, the collation, the WAL segment size, whether pages carry checksums. You will bootstrap a cluster that sets all of them deliberately, confirm each choice landed, and then discover what happens when you try to change your mind — which is not what the API server accepting your patch would lead you to believe. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'bootstrap-it',
      title: 'Bootstrap a cluster on your own terms',
      limitSec: 720,
      criteria: [
        'A Cluster named pg-init is healthy with both instances ready',
        'Its application database is orders, owned by shop',
        'postInitApplicationSQL ran — the seeded table exists in orders with its row',
        'postInitSQL ran — the auditor role exists',
      ],
      brief: `Left alone, CloudNativePG bootstraps a cluster with an application database called \`app\`, owned by a role called \`app\`, in UTF8. That is a default, not a law — \`bootstrap.initdb\` is where you say otherwise.

Two of its fields are hooks rather than settings, and they are worth knowing about: \`postInitSQL\` runs statements in the \`postgres\` database as superuser, and \`postInitApplicationSQL\` runs them inside the application database once it exists. Between them they let a cluster arrive with its roles and its schema already in place, without a migration step.

Apply the staged manifest and confirm all four things it asked for: the database, its owner, and the result of each hook.`,
      instructions: `The manifest was staged on the **k3d-server** node. Read it there first:

\`\`\`
cat /root/initdb-cluster.yaml
\`\`\`

Look at the \`bootstrap.initdb\` block as two groups. \`database\`, \`owner\` and \`encoding\` describe what to create. \`localeCollate\`, \`localeCType\`, \`dataChecksums\` and \`walSegmentSize\` are physical choices written into the data directory. Then the two SQL hooks at the end.

Apply it and move to the **toolbox** tab:

\`\`\`
kubectl apply -f /root/initdb-cluster.yaml
kubectl get cluster
\`\`\`

This is a real \`initdb\` followed by a real join of a second instance, so give it a couple of minutes:

\`\`\`
sleep 120
kubectl get cluster pg-init
kubectl get pods -l cnpg.io/cluster=pg-init
\`\`\`

Now check what it built. The databases, with their owners:

\`\`\`
kubectl exec pg-init-1 -c postgres -- psql -U postgres -c "\\l"
\`\`\`

\`orders\`, owned by \`shop\` — not the \`app\`/\`app\` pair a default bootstrap would have produced.

The application hook ran inside that database:

\`\`\`
kubectl exec pg-init-1 -c postgres -- psql -U postgres -d orders -c "SELECT * FROM seeded;"
\`\`\`

A table and a row, created before anybody connected. And the superuser hook ran in the \`postgres\` database:

\`\`\`
kubectl exec pg-init-1 -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('auditor','shop') ORDER BY rolname;"
\`\`\`

Both roles exist: \`shop\` can log in because it owns the application database, \`auditor\` cannot because the hook created it \`NOLOGIN\`.

The distinction between the two hooks is which database they run in, and it matters — putting a \`CREATE TABLE\` in \`postInitSQL\` would create it in \`postgres\`, which is almost never what anyone wants.`,
      hint: `The cluster is called \`pg-init\`, not \`pg-cluster\`, and its application database is \`orders\`, not \`app\` — so \`psql\` needs \`-d orders\` to see the seeded table.`,
      solution: `cat /root/initdb-cluster.yaml
kubectl apply -f /root/initdb-cluster.yaml
sleep 120
kubectl get cluster pg-init
kubectl exec pg-init-1 -c postgres -- psql -U postgres -c "\\l"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -d orders -c "SELECT * FROM seeded;"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('auditor','shop') ORDER BY rolname;"`,
    },

    {
      id: 'read-the-physical-choices',
      title: 'Read the decisions written into the data directory',
      limitSec: 480,
      criteria: [
        'The WAL segment size is 32MB, not the 16MB default',
        'Data checksums are on',
        '/root/initdb-settings.txt was written',
        'It records the segment size initdb chose',
      ],
      brief: `Some initdb options are settings you could change later. Two of them are not: the WAL segment size and whether data pages carry checksums are decided when the data directory is created and written into its very structure.

Read them back and record the segment size. A 32MB segment where PostgreSQL's default is 16MB is unambiguous proof that your manifest, and not a default, produced this cluster.

One reading here is a trap worth meeting: checksums are on, and they would have been on even if you had not asked. Find out why before assuming your setting is what did it.`,
      instructions: `Read the two physical choices:

\`\`\`
kubectl exec pg-init-1 -c postgres -- psql -U postgres -c \\
  "SELECT name, setting, unit FROM pg_settings WHERE name IN ('wal_segment_size','data_checksums','server_encoding') ORDER BY name;"
\`\`\`

Three rows. Collation is deliberately not among them: modern PostgreSQL keeps \`lc_collate\` and \`lc_ctype\` as properties of each *database* rather than as server settings, which is why they appeared in the database listing earlier and not here.

\`wal_segment_size\` is 33554432 — 32MB, twice PostgreSQL's 16MB default, exactly as the manifest asked. Record it:

\`\`\`
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc \\
  "SELECT setting FROM pg_settings WHERE name = 'wal_segment_size';" > /root/initdb-settings.txt
cat /root/initdb-settings.txt
\`\`\`

Now the trap. \`data_checksums\` is \`on\` — but that is not evidence your \`dataChecksums: true\` did anything, because **PostgreSQL 18 enables checksums by default** at initdb time. CloudNativePG's \`dataChecksums\` controls whether it passes \`-k\` to initdb; on this version the answer is on either way.

That is worth knowing in both directions. On PostgreSQL 17 and earlier the setting is what turns them on, and on 18 the thing you would actually have to ask for is turning them *off*.

The same file also records the choices from the other side — \`pg_controldata\` reads the control file directly:

\`\`\`
kubectl exec pg-init-1 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata \\
  | grep -E "Data page checksum|Bytes per WAL segment|Database block size"
\`\`\`

These are properties of the files on disk, which is exactly why the next objective is about how permanent they are.`,
      hint: `\`wal_segment_size\` is reported in bytes: 16777216 is the 16MB default and 33554432 is the 32MB this cluster was built with.`,
      solution: `kubectl exec pg-init-1 -c postgres -- psql -U postgres -c "SELECT name, setting, unit FROM pg_settings WHERE name IN ('wal_segment_size','data_checksums','server_encoding') ORDER BY name;"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc "SELECT setting FROM pg_settings WHERE name = 'wal_segment_size';" > /root/initdb-settings.txt
cat /root/initdb-settings.txt
kubectl exec pg-init-1 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep -E "Data page checksum|Bytes per WAL segment|Database block size"`,
    },

    {
      id: 'try-to-change-it',
      title: 'Change your mind, and find out you cannot',
      limitSec: 480,
      criteria: [
        'The spec now asks for a database called renamed',
        'The database is still orders — nothing was renamed',
        'And the WAL segment size is still 32MB, whatever the spec now says',
      ],
      brief: `Now the part that makes \`bootstrap\` different from every other section of a Cluster.

The rest of a Cluster spec is desired state: change \`instances\` and the operator adds one, change \`imageName\` and it rolls. \`bootstrap\` is not desired state. It is an instruction that was carried out once, when the cluster was created, and it is never consulted again.

What makes this worth meeting deliberately is how quietly it fails. Patch the database name and the API server accepts it. No webhook rejection, no warning, no condition. The spec simply becomes a description of something that is not true, permanently, and \`kubectl get cluster -o yaml\` will keep telling you the wrong thing for the life of that cluster.`,
      instructions: `Ask for a different database name:

\`\`\`
kubectl patch cluster pg-init --type=merge \\
  -p '{"spec":{"bootstrap":{"initdb":{"database":"renamed"}}}}'
\`\`\`

Accepted. Try the physical ones too:

\`\`\`
kubectl patch cluster pg-init --type=merge -p '{"spec":{"bootstrap":{"initdb":{"walSegmentSize":64}}}}'
kubectl patch cluster pg-init --type=merge -p '{"spec":{"bootstrap":{"initdb":{"dataChecksums":false}}}}'
\`\`\`

All accepted. Give the operator time to reconcile — it will not do anything, but wait long enough to be sure of that:

\`\`\`
sleep 30
kubectl get cluster pg-init
\`\`\`

Healthy, unchanged, no complaint. Now read the spec and the database side by side:

\`\`\`
kubectl get cluster pg-init -o json | jq -c '.spec.bootstrap.initdb | {database, walSegmentSize, dataChecksums}'
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc \\
  "SELECT datname FROM pg_database WHERE datname IN ('orders','renamed');"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc \\
  "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('wal_segment_size','data_checksums');"
\`\`\`

The spec says \`renamed\`, 64 and false. The database is \`orders\`, 33554432 and on. They will never agree again.

So two things to carry away. The first is practical: get the \`initdb\` block right before you apply, because the only way to change any of it afterwards is to build a new cluster and move the data — which for encoding or collation means a dump and restore, not a replica.

The second is about reading a Cluster at all. For most of the spec, what it says is what you have. For \`bootstrap\`, what it says is what somebody once asked for — and the only reliable answer to "what is this database actually like" comes from the database.`,
      hint: `Every patch here is *supposed* to succeed. The point of the objective is that succeeding and taking effect are different things, so do not go looking for an error message.`,
      solution: `kubectl patch cluster pg-init --type=merge -p '{"spec":{"bootstrap":{"initdb":{"database":"renamed"}}}}'
kubectl patch cluster pg-init --type=merge -p '{"spec":{"bootstrap":{"initdb":{"walSegmentSize":64}}}}'
kubectl patch cluster pg-init --type=merge -p '{"spec":{"bootstrap":{"initdb":{"dataChecksums":false}}}}'
sleep 30
kubectl get cluster pg-init -o json | jq -c '.spec.bootstrap.initdb | {database, walSegmentSize, dataChecksums}'
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datname IN ('orders','renamed');"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('wal_segment_size','data_checksums');"`,
    },
  ],
}
