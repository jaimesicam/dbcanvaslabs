// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a
// Cluster whose bootstrap is `initdb.import` with `type: microservice` and one database in the
// list came up healthy in about 45 seconds with the imported table in its *application*
// database, renamed from orders to app and reassigned from the shop role to the new cluster's
// own app user. No shop or reporting role exists on the target, there is no database called
// orders, and a `pg-orders-app` Secret was generated whose password lets the client Pod read
// all 500 rows. The import is pg_dump piped into pg_restore, once — a row written on the source
// afterwards never appears on the copy.
//
// Self-contained, like every lab here: the operator, a healthy cluster carrying several
// application databases, a client Pod and a staged import manifest are this lab's starting
// state, built by its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab
// content contract").

export const cnpgImportMicroservice = {
  id: 'cnpg-import-microservice',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real PostgreSQL server with several application databases on it, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time and then seeded before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster standing in for the old shared server: besides its own app database it carries orders (500 rows in a lines table) and billing (200 invoices), both owned by a role called shop, plus a reporting role that cannot log in',
      'Superuser access switched on for that cluster, so the postgres password exists in a pg-cluster-superuser Secret — a logical import connects as a real PostgreSQL user over the network',
      'A manifest staged on the k3d-server node at /root/import.yaml describing a second Cluster called pg-orders that imports one database from the first — written, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'One server, several applications, one team that wants out. The microservice import takes exactly one database off a running PostgreSQL server and stands it up as a CloudNativePG cluster of its own — over the wire, with pg_dump and pg_restore, into a database the operator creates and owns. You will run it, check what arrived, and then check the two things that did not: the roles, and any change made after the copy started.',
  },

  tasks: [
    {
      id: 'survey-the-source',
      title: 'Survey the server you are moving off',
      limitSec: 420,
      criteria: [
        'The source server carries the orders and billing databases',
        'The orders database has 500 rows in lines',
        '/root/orders-rows.txt was written',
        'It records that row count',
      ],
      brief: `This is the shape almost every migration starts from: one PostgreSQL server that several applications happen to share, with a database each and roles spread across them.

Look at it as an operator would before touching anything — what databases exist, who owns them, how much is in the one you are moving — and then read the manifest that will do the move.

The manifest is short, and every line of it is worth understanding, because two words in it decide the entire outcome: \`type: microservice\` and the single entry in \`databases\`.`,
      instructions: `Work in the **k3d-server** tab. Take stock of the server:

\`\`\`
kubectl get cluster pg-cluster
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\l"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\du"
\`\`\`

Three application databases — \`app\`, \`orders\` and \`billing\` — with \`orders\` and \`billing\` owned by \`shop\`, and a \`reporting\` role that cannot log in at all. An ordinary, slightly grown-over server.

Look inside the one you are moving, and record its size:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -c "\\dt"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;" > /root/orders-rows.txt
cat /root/orders-rows.txt
\`\`\`

Five hundred rows, in a table owned by \`shop\`. Now read the manifest:

\`\`\`
cat /root/import.yaml
\`\`\`

\`bootstrap.initdb.import\` is the interesting part. This is still an \`initdb\` bootstrap — a brand-new, empty database is created first — and then the operator runs \`pg_dump\` against the source and pipes it into \`pg_restore\` locally. It is a **logical** copy: SQL, not files, which is why it can move a single database out of a server rather than all of it.

\`type: microservice\` says: exactly one database, imported into this new cluster's own application database. That is why \`databases\` has a single entry and why there is no \`roles\` list — a microservice import does not bring roles.

Finally, the connection. The \`externalClusters\` entry names the source's read-write Service and connects as \`postgres\`, with the password from the \`pg-cluster-superuser\` Secret:

\`\`\`
kubectl get secret pg-cluster-superuser
\`\`\`

It has to be a privileged user: \`pg_dump\` has to read every object in the database, including ones the application user does not own.`,
      hint: `\`\\l\` lists databases with their owners and \`\\du\` lists roles with their attributes — both are psql's own shortcuts, so they need \`-c\` and an interactive-style backslash command rather than SQL.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\l"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\du"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;" > /root/orders-rows.txt
cat /root/orders-rows.txt
cat /root/import.yaml
kubectl get secret pg-cluster-superuser`,
    },

    {
      id: 'import-it',
      title: 'Import the database',
      limitSec: 600,
      criteria: [
        'A new Cluster named pg-orders reports healthy',
        'Its application database holds the imported table, with all 500 rows',
        "And it belongs to the new cluster's application user",
        'The source is untouched and still serving',
      ],
      brief: `Apply it and watch a new cluster bootstrap itself out of another server's contents.

There is no separate job to watch for here the way there is with a physical copy — the import happens inside the instance's own initdb job, so the cluster goes from *Setting up primary* to healthy and the data is simply there when it arrives.

Two things to check when it is up, because they are the substance of what "microservice" means. The database is no longer called \`orders\`: it is the new cluster's application database, \`app\`. And the table inside it is no longer owned by \`shop\`: the operator reassigned it to the application user it manages. The copy has been rehomed, not just moved.`,
      instructions: `Apply the staged manifest:

\`\`\`
kubectl apply -f /root/import.yaml
kubectl get cluster
kubectl get pods
\`\`\`

Watch it come up — this takes well under a minute for a database this size, and would take as long as \`pg_dump\` and \`pg_restore\` need for a real one:

\`\`\`
sleep 45
kubectl get cluster
\`\`\`

Once \`pg-orders\` reads *Cluster in healthy state*, look at what it has:

\`\`\`
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -c "\\l"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -c "\\dt"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM lines;"
\`\`\`

All 500 rows, in a database called \`app\`, in a table owned by \`app\`. Both renamings are the import type doing its job: one database per cluster, owned by that cluster's own application user, which is the shape CloudNativePG expects and the shape its Secrets, Services and backups are built around.

Use it the way an application would — through the new cluster's Service, with the new cluster's credentials:

\`\`\`
PW=$(kubectl get secret pg-orders-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$PW" psql -h pg-orders-rw -U app -d app -tAc \\
  "SELECT count(*) FROM lines;"
kubectl get secret -l cnpg.io/cluster=pg-orders
\`\`\`

A generated application Secret, exactly as for any other CloudNativePG cluster. Nothing here knows it was born out of somebody else's server.

And the source is untouched — a logical import is a read:

\`\`\`
kubectl get cluster pg-cluster
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
\`\`\``,
      hint: `If \`pg-orders\` sits in *Setting up primary*, the import is still running inside the initdb job — \`kubectl logs job/pg-orders-1-initdb\` shows pg_dump and pg_restore working if you want to watch.`,
      solution: `kubectl apply -f /root/import.yaml
sleep 45
kubectl get cluster
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -c "\\l"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -c "\\dt"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM lines;"
PW=$(kubectl get secret pg-orders-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$PW" psql -h pg-orders-rw -U app -d app -tAc "SELECT count(*) FROM lines;"
kubectl get cluster pg-cluster`,
    },

    {
      id: 'what-it-left-behind',
      title: 'Find out what it did not bring',
      limitSec: 600,
      criteria: [
        'The imported cluster has no shop role — a microservice import brings no roles',
        'And no database called orders — it arrived as app',
        'A row written on the source after the import never reached it',
        'Both clusters are healthy',
      ],
      brief: `An import that has finished is easy to mistake for a migration that has finished. Two things stand between them, and both are on this objective.

The first is roles. The database's own tables came across; the role that owned them did not, and neither did the read-only role that had been granted access to them. Anything on the application side that connects as one of those roles has nowhere to connect to.

The second is time. \`pg_dump\` read the source once. Every commit after that moment exists only on the source, and nothing is going to fetch it. Prove that to yourself now, while it costs nothing, because the same fact is what makes a cutover a planned outage rather than a switch you flip.`,
      instructions: `Look for the roles that owned everything on the source:

\`\`\`
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -c "\\du"
\`\`\`

\`app\`, \`postgres\`, \`streaming_replica\` and the metrics exporter — the roles the operator creates for any cluster. No \`shop\`, no \`reporting\`. A microservice import copies the contents of one database; who was allowed to touch it on the old server is not part of that.

And the database itself:

\`\`\`
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -c "\\l"
\`\`\`

No \`orders\` here either. Every connection string, every \`search_path\` assumption and every dashboard that named that database has to be updated — which is a small job if you know about it and an outage if you find out during the cutover.

Now the part that matters most. Write to the source, as any application still pointed at it would:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -c \\
  "INSERT INTO lines (sku, qty) VALUES ('written-after-the-import', 999);"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
\`\`\`

The source has 501 rows. And the copy:

\`\`\`
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM lines;"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -tAc \\
  "SELECT count(*) FROM lines WHERE sku = 'written-after-the-import';"
\`\`\`

Five hundred, and none. Nothing is following the source — there is no replication slot, no WAL receiver, no subscription. The import ran once, at bootstrap, and is over.

That is the whole shape of a cutover with this tool: stop writing to the old database, import, verify, point the applications at the new Service with the new credentials, and only then start writing again. The window is however long the dump and restore take, which is why people measure it on a copy first. If that window is unacceptable, logical replication is the mechanism that closes it — this one does not.

Both clusters are fine, and will happily go on being two separate databases:

\`\`\`
kubectl get cluster
\`\`\``,
      hint: `The row has to go into the source's \`orders\` database, not into \`app\` — the check compares the two counts and expects the source to be ahead.`,
      solution: `kubectl exec pg-orders-1 -c postgres -- psql -U postgres -c "\\du"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -c "\\l"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -c "INSERT INTO lines (sku, qty) VALUES ('written-after-the-import', 999);"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM lines;"
kubectl get cluster`,
    },
  ],
}
