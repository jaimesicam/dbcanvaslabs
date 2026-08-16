// Every requirement and failure mode below was discovered by running this against a real
// K3D + CloudNativePG deploy (server/, see LABORATORY.md), and three of them are the reason
// the lab is shaped as it is: a subscription whose external cluster names a different
// database reports "publication does not exist" as a warning in the subscriber's log rather
// than an error on the resource; the certificate-authenticated streaming_replica role cannot
// be used, because the source's pg_hba only lets it reach the postgres database; and a role
// with REPLICATION but no SELECT applies cleanly and then fails the initial copy with
// "permission denied for table". A fourth was found while verifying this lab: logical
// replication does not carry DDL, so a Subscription against a table that does not yet exist
// on the subscriber reports applied:false with 'relation "public.orders" does not exist' —
// and the operator keeps reconciling, so creating the table heals it within a minute without
// re-applying anything. Grading reads the resources' applied status, the real publication and
// logical slot, and the rows on the subscriber.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, two healthy clusters, a client Pod,
// staged Publication and Subscription manifests and the toolbox are this lab's starting
// state, built by its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab
// content contract").

export const cnpgLogicalReplication = {
  id: 'cnpg-logical-replication',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running two real PostgreSQL clusters, thrown away when you finish. Nothing is simulated, which is why it takes longer than most: a 3-instance source and a separate single-instance destination are both bootstrapped before you get here, because logical replication needs somewhere to publish from and somewhere to subscribe to.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster — the publisher, already running with wal_level set to logical, which is the CloudNativePG default and needs no configuration',
      'A second healthy Cluster named pg-target with one instance — the subscriber, carrying an externalClusters entry called origin-app that points back at pg-cluster with the app role and its password Secret',
      'Publication and Subscription manifests staged at /root/publication.yaml and /root/subscription.yaml on the k3d-server node — written but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'Two separate databases exist and nothing flows between them. You will set up logical replication declaratively — a Publication on one, a Subscription on the other, both as Kubernetes resources rather than SQL — and get a table copying continuously from the first to the second. The interesting part is what has to be true before it works: logical replication is far pickier about privileges than streaming, and the failures are quiet. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'prepare-the-publisher',
      title: 'Make the publisher publishable',
      limitSec: 600,
      criteria: [
        'An orders table on the source holds at least 2 rows',
        'The app role has been granted REPLICATION on the source',
        'The app role can read the orders table',
      ],
      brief: `Logical replication sends rows, not WAL blocks. That means the subscriber connects as an ordinary client and reads your tables — so it needs privileges that a streaming standby never does.

Three things have to be true before anything will work, and getting them wrong produces failures that are quiet rather than loud.

There has to be a table with data. The role the subscriber connects as needs \`REPLICATION\`, or the publisher refuses the connection outright. And that same role needs \`SELECT\` on the published tables, or the subscription will apply perfectly, report itself healthy, and then never copy a single row.

Set all three up now. This objective is the part people skip and then spend an afternoon debugging.`,
      instructions: `Create the table as the **app** role, which is what an application would do — connect through the client Pod, which is already authenticated as \`app\`:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE orders (id serial primary key, item text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO orders (item) VALUES ('widget'), ('sprocket') RETURNING *;"
\`\`\`

Creating it as \`app\` matters more than it looks: the owner has \`SELECT\` on its own table automatically, which is one of the three requirements already satisfied. A table created as \`postgres\` would not be readable by \`app\`, and that is exactly the trap this lab is built around.

Confirm the role can read it:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -tAc \\
  "SELECT has_table_privilege('app', 'orders', 'SELECT');"
\`\`\`

Now the privilege that is *not* automatic. Look at the role first:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolreplication, rolcanlogin FROM pg_roles WHERE rolname IN ('app','streaming_replica') ORDER BY rolname;"
\`\`\`

\`app\` can log in but has no replication right; \`streaming_replica\` has it. So why not just use \`streaming_replica\`? Look at what the source will actually accept:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT type, database, user_name, auth_method FROM pg_hba_file_rules WHERE user_name IS NOT NULL;"
\`\`\`

\`streaming_replica\` is allowed by certificate into the \`postgres\` database and the replication pseudo-database, and nothing else. It cannot reach \`app\`, where your tables live. It is a role for shipping WAL, not for reading rows.

So grant the right to the role that *can* reach the data:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "ALTER ROLE app WITH REPLICATION;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolreplication FROM pg_roles WHERE rolname = 'app';"
\`\`\`

One more thing that needs no work at all, but is worth confirming rather than assuming:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SHOW wal_level;"
\`\`\`

\`logical\`. CloudNativePG sets that by default, so unlike almost every other PostgreSQL deployment you do not have to change it and restart.`,
      hint: `Create the table through \`psql-client\`, which connects as \`app\`. If you create it as \`postgres\` instead you will have to \`GRANT SELECT ON orders TO app\` yourself — which also works, and is worth knowing as the fix when you meet this on a table you did not create.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE orders (id serial primary key, item text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO orders (item) VALUES ('widget'), ('sprocket') RETURNING *;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -tAc "SELECT has_table_privilege('app', 'orders', 'SELECT');"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolreplication FROM pg_roles WHERE rolname IN ('app','streaming_replica') ORDER BY rolname;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "ALTER ROLE app WITH REPLICATION;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SHOW wal_level;"`,
    },

    {
      id: 'publish',
      title: 'Declare what is published',
      limitSec: 420,
      criteria: [
        'The Publication resource reports applied',
        'PostgreSQL really has a publication named orders_pub',
        'It publishes the orders table',
      ],
      brief: `A publication is the publisher's side of the arrangement: a named set of tables whose changes are offered to anyone who subscribes.

CloudNativePG gives you this as a Kubernetes resource. You describe the publication in a manifest, the operator runs the SQL, and the result is an ordinary PostgreSQL publication — the same object \`CREATE PUBLICATION\` would have made.

What you gain is that it is now part of the cluster's declared state rather than something someone typed once. What you must still check is that it actually applied: the resource carries a status, and a publication that failed to apply says so there rather than anywhere you would notice.`,
      instructions: `The manifest was staged on the **k3d-server** node. Read it from that tab:

\`\`\`
cat /root/publication.yaml
\`\`\`

Note the shape: \`spec.name\` is the PostgreSQL object's name (\`orders_pub\`) and \`metadata.name\` is the Kubernetes resource's (\`orders-pub\`) — they are allowed to differ, and confusing them is a common first mistake. \`dbname\` says which database inside the cluster, and \`target.objects\` lists what is published.

Apply it, then move back to the **toolbox** tab:

\`\`\`
kubectl apply -f /root/publication.yaml
kubectl get publication
\`\`\`

Check the status, which is the only place a failure would appear:

\`\`\`
kubectl get publication orders-pub -o json | jq .status
\`\`\`

\`"applied": true\`. If it were false there would be a \`message\` next to it with the SQL error — a publication naming a table that does not exist fails exactly this way, and nothing else in the cluster would look wrong.

Now confirm the real PostgreSQL object exists, rather than trusting the resource:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "\\dRp+"
\`\`\`

The publication, its owner, which operations it carries — inserts, updates, deletes, truncates — and the table it covers. That is a plain PostgreSQL publication; the operator built it and then stepped out of the way.

Nothing is subscribed yet, so nothing is being sent. Check the publisher for slots:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, slot_type FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

Only the physical slots for the source's own replicas. A publication on its own costs nothing — no slot, no retained WAL, no reader. It is an offer, and the next objective accepts it.`,
      hint: `\`spec.name\` and \`metadata.name\` are different names for different things — the PostgreSQL publication and the Kubernetes resource. Grading looks for the PostgreSQL one, \`orders_pub\`.`,
      solution: `cat /root/publication.yaml
kubectl apply -f /root/publication.yaml
kubectl get publication
kubectl get publication orders-pub -o json | jq .status
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "\\dRp+"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT slot_name, slot_type FROM pg_replication_slots ORDER BY slot_name;"`,
    },

    {
      id: 'subscribe',
      title: 'Subscribe from the other cluster',
      limitSec: 600,
      criteria: [
        'The Subscription resource reports applied',
        'A logical replication slot named orders_sub exists on the publisher',
        'The subscriber received the rows that already existed — the initial copy ran',
        'And a row inserted after subscribing arrived too — it is still streaming',
      ],
      brief: `Now the subscriber's side, on the second cluster.

Before anything else: **logical replication does not replicate DDL**. It sends row changes, not schema, so the table has to already exist on the subscriber with a matching shape. Create it there yourself — this is the step that catches people, because nothing warns you in advance.

A Subscription needs somewhere to connect to, and it does not take a connection string — it takes the *name* of an \`externalClusters\` entry on its own cluster. That entry already exists here, called \`origin-app\`, pointing at the publisher with the app role and its password.

One field in the manifest deserves attention: \`publicationDBName\`. The external cluster connects to a database; the publication lives in a database; those are allowed to differ and frequently do. When they do and you have not said so, the subscription connects successfully, reports itself applied, and then quietly does nothing — the only sign is a warning in the subscriber's log saying the publication does not exist.

Then watch two separate things happen: an initial copy of the rows that were already there, and streaming of everything after.`,
      instructions: `First, give the subscriber somewhere to put the rows. Logical replication carries data, not schema, so the table must already exist there:

\`\`\`
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c \
  "CREATE TABLE orders (id serial primary key, item text, at timestamptz default now()); ALTER TABLE orders OWNER TO app;"
\`\`\`

The shape has to match what is published. The owner matters too — the apply worker writes as the subscription's owner, so a table it cannot write to fails in the same quiet way a table it cannot read does on the other side.

Now read the staged manifest on the **k3d-server** node:

\`\`\`
cat /root/subscription.yaml
\`\`\`

\`externalClusterName: origin-app\` is how it finds the publisher, and \`publicationDBName: app\` is the field described in the briefing. Look at what \`origin-app\` actually is, on the subscriber's own spec:

\`\`\`
kubectl get cluster pg-target -o json | jq '.spec.externalClusters'
\`\`\`

The app role, its password from a Secret, and \`dbname: app\`. That is why the subscription can read tables at all — it is an ordinary client connection, not a replication-only one.

Apply it, then work from the **toolbox** tab:

\`\`\`
kubectl apply -f /root/subscription.yaml
sleep 25
kubectl get subscription orders-sub -o json | jq .status
\`\`\`

\`"applied": true\`. Now the evidence from the publisher's side — a subscription creates a *logical* slot there:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, slot_type, active FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

Alongside the physical slots, one named \`orders_sub\` with \`slot_type\` of \`logical\`. That slot is what makes the publisher retain WAL for this subscriber, exactly like a physical one, and is why an abandoned subscription is a real operational hazard rather than a tidy-up job.

Check the rows that existed before you subscribed:

\`\`\`
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM orders ORDER BY id;"
\`\`\`

Both of them, on a cluster they were never written to. That is the initial copy — logical replication synchronises existing data before it starts streaming, which is a real difference from physical replication where the standby had to be a clone to begin with.

Now prove it is ongoing rather than a one-off:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO orders (item) VALUES ('after-subscribe') RETURNING *;"
sleep 8
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM orders ORDER BY id;"
\`\`\`

Three rows. And the subscriber's own view of the arrangement:

\`\`\`
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c \\
  "SELECT subname, subenabled, subslotname FROM pg_subscription;"
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -x -c "SELECT * FROM pg_stat_subscription;"
\`\`\`

The last one is where you look when data is not arriving: \`received_lsn\` and \`latest_end_lsn\` tell you whether the subscriber is getting anything at all, which distinguishes "nothing is being sent" from "something is failing to apply".

Worth remembering, because it is the difference between logical and physical replication in one sentence: the subscriber is a fully writable database that happens to be receiving some tables. Nothing about it is read-only.`,
      hint: `If the Subscription reports \`applied: false\` with \`relation "public.orders" does not exist\`, the table is missing on the subscriber — create it and wait. The operator keeps reconciling, so it heals itself within a minute without re-applying the manifest. If instead it applies but no rows arrive, read the subscriber's log rather than the resource — \`kubectl logs pg-target-1 | jq -r 'select(.record.error_severity) | .record.message' | tail\`. "publication does not exist" means \`publicationDBName\` is wrong; "permission denied for table" means the connecting role cannot SELECT it.`,
      solution: `kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c "CREATE TABLE orders (id serial primary key, item text, at timestamptz default now()); ALTER TABLE orders OWNER TO app;"
cat /root/subscription.yaml
kubectl get cluster pg-target -o json | jq '.spec.externalClusters'
kubectl apply -f /root/subscription.yaml
sleep 25
kubectl get subscription orders-sub -o json | jq .status
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT slot_name, slot_type, active FROM pg_replication_slots ORDER BY slot_name;"
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM orders ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO orders (item) VALUES ('after-subscribe') RETURNING *;"
sleep 8
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM orders ORDER BY id;"
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c "SELECT subname, subenabled, subslotname FROM pg_subscription;"`,
    },
  ],
}
