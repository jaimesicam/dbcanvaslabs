// Pooler object names, the PgBouncer admin console socket, pool modes and the observed
// backend reuse below are confirmed live against a real K3D + CloudNativePG deploy
// (server/, see LABORATORY.md). Grading runs server-side: it opens its own connections
// through the pooler and reads PgBouncer's own admin console.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client
// Pod and a staged Pooler manifest are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgPgBouncer = {
  id: 'cnpg-pgbouncer',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster and a real client to connect from, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — one primary and two streaming replicas, reachable directly through the pg-cluster-rw, pg-cluster-ro and pg-cluster-r Services',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
      'A Pooler manifest staged at /root/pooler.yaml on the k3d-server node — written but deliberately not applied',
    ],
    yourJob:
      'There is no connection pooler in front of this database yet: every client that connects gets a PostgreSQL backend process of its own, which is exactly the behaviour that falls over under a few thousand short-lived connections. You will apply the staged Pooler, watch the operator build PgBouncer from it, route real traffic through the pooled Service, and measure the reuse it buys you.',
  },

  tasks: [
    {
      id: 'apply-pooler',
      title: 'Apply the Pooler and watch PgBouncer appear',
      limitSec: 420,
      criteria: [
        'pooler.postgresql.cnpg.io/pg-cluster-pooler-rw exists',
        'Its PgBouncer Deployment reports 2 ready replicas',
        'Service pg-cluster-pooler-rw has 2 endpoints',
      ],
      brief: `A pooler in CloudNativePG is not something you deploy yourself — it is a resource you declare, and the operator builds the PgBouncer behind it.

Read the staged manifest first: it names the cluster to sit in front of, how many PgBouncer instances to run, whether it follows the primary or the replicas, and how PgBouncer should pool. Then apply it and watch what appears — a Deployment, its Pods, and a Service of its own.

Two instances rather than one is the point worth noticing: a pooler is on the path of every connection, so a single one would be a new single point of failure in front of a highly available database.`,
      instructions: `Read what has been staged for you:

\`\`\`
cat /root/pooler.yaml
\`\`\`

Four fields carry all the meaning. \`cluster.name\` says which database this pooler fronts. \`type: rw\` says it follows the primary — the pooler will point at whichever instance is primary, the same way the read-write Service does. \`instances: 2\` asks for two PgBouncer Pods. And \`pgbouncer.poolMode: session\` decides when a server connection is handed back to the pool.

Apply it:

\`\`\`
kubectl apply -f /root/pooler.yaml
\`\`\`

Then watch the operator act on it:

\`\`\`
kubectl get pooler
kubectl get deploy pg-cluster-pooler-rw
kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o wide
\`\`\`

The Pooler reports phase \`active\`, a Deployment appears with two ready replicas, and its Pods land on different nodes. Note the image they run — \`ghcr.io/cloudnative-pg/pgbouncer:1.25.1\`, the build this operator version ships with — and that you never named it.

A Service was created too, named after the Pooler:

\`\`\`
kubectl get svc pg-cluster-pooler-rw
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-pooler-rw
\`\`\`

Two endpoints, one per PgBouncer Pod. That name is what applications will connect to from here on.`,
      hint: `If the Deployment sits at 0/2 for a while, check \`kubectl describe pooler pg-cluster-pooler-rw\` and the Pod events — the PgBouncer image is small but it is the one image in this environment that is fetched on demand.`,
      solution: `cat /root/pooler.yaml
kubectl apply -f /root/pooler.yaml
kubectl get pooler
kubectl get deploy pg-cluster-pooler-rw
kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o wide
kubectl get svc pg-cluster-pooler-rw
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-pooler-rw`,
    },

    {
      id: 'connect-through-pooler',
      title: 'Route real traffic through the pooler',
      limitSec: 360,
      criteria: [
        "A row noted 'via-pgbouncer' exists in pool_proof",
        'A connection to pg-cluster-pooler-rw really lands on the primary',
      ],
      brief: `Connect to the pooler's Service exactly as you would to the database's own, and write through it.

Nothing about the client changes: same user, same database, same password, a different host name. That is the whole migration path for an application — swap the host, keep everything else.

Ask the session which server address answered, too. The reply comes from PostgreSQL itself, through PgBouncer, and it is the primary's address — proving the pooler is a transparent path to the same database rather than something new in between.`,
      instructions: `The \`psql-client\` Pod already carries the app credentials, so only the host name changes. Create a table and write a row through the pooler:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "CREATE TABLE pool_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "INSERT INTO pool_proof (note) VALUES ('via-pgbouncer') RETURNING *;"
\`\`\`

Ask who actually served that connection:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

The address is the primary Pod's, and recovery is false: a \`type: rw\` pooler follows the primary. Read the row back the direct way, so you can see it is one database and not a copy:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pool_proof;"
\`\`\`

Notice what you did *not* have to do: no separate PgBouncer credentials, no \`userlist.txt\`, no auth query to configure. The operator wired PgBouncer's own authentication to the cluster using a certificate for a dedicated \`cnpg_pooler_pgbouncer\` role when it created the Pooler.`,
      hint: `Connect from the \`psql-client\` Pod rather than from inside a database Pod: the point is a client outside the database dialling a Service name. \`kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "<sql>"\`.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "CREATE TABLE pool_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "INSERT INTO pool_proof (note) VALUES ('via-pgbouncer') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pool_proof;"`,
    },

    {
      id: 'inspect-pool',
      title: "Read PgBouncer's own admin console",
      limitSec: 360,
      criteria: [
        "PgBouncer's own admin console reports a pool for the app database",
        '/root/pool-mode.txt was written',
        'It records the pool mode this Pooler is running',
      ],
      brief: `PgBouncer keeps its own bookkeeping, and it answers questions in SQL — connect to its admin console and ask it what it is doing.

Inside each PgBouncer Pod there is an admin database reachable over a local socket. Ask it to show its pools and its databases: you will see one pool per database and user pair, the counts of client connections versus server connections, and where each pool is pointed.

Record the pool mode it reports in \`/root/pool-mode.txt\`. That setting is the one with real consequences for applications, and the next objective is where you see why.`,
      instructions: `Pick either PgBouncer Pod and connect to its admin console over the socket the operator sets up inside the container:

\`\`\`
POOLER=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POOLER -c pgbouncer -- psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW POOLS;"
\`\`\`

There is a row per database and user pair. The one to read is \`app / app\`: \`cl_active\` counts the client connections PgBouncer is holding, \`sv_active\` and \`sv_idle\` count the PostgreSQL connections behind them, and \`pool_mode\` says \`session\`.

Ask where those pools point, and how big they are allowed to get:

\`\`\`
kubectl exec $POOLER -c pgbouncer -- psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW DATABASES;"
\`\`\`

The host is \`pg-cluster-rw\` — PgBouncer is itself a client of the read-write Service, which is how it follows the primary without knowing anything about failover. \`pool_size\` is 5, from the parameters in the manifest.

Record the pool mode:

\`\`\`
echo session > /root/pool-mode.txt
\`\`\`

Session pooling returns a server connection to the pool only when the client disconnects. Transaction pooling returns it at the end of every transaction, which multiplies the reuse but breaks anything that relies on session state — prepared statements, session-level advisory locks, temporary tables, LISTEN and NOTIFY.`,
      hint: `The admin console listens on a unix socket, not on the network: \`-h /controller/run -U pgbouncer pgbouncer\` — that last \`pgbouncer\` is the database name. Add \`-c pgbouncer\` to kubectl exec so it picks the PgBouncer container.`,
      solution: `POOLER=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POOLER -c pgbouncer -- psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW POOLS;"
kubectl exec $POOLER -c pgbouncer -- psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW DATABASES;"
echo session > /root/pool-mode.txt`,
    },

    {
      id: 'prove-reuse',
      title: 'Measure the reuse you actually get',
      limitSec: 420,
      criteria: [
        'Six fresh connections through the pooler land on no more than 2 backends',
        '/root/pooled-backends.txt was written',
        'It records how many distinct backends those connections shared — one per PgBouncer Pod at most',
      ],
      brief: `Now measure the thing a pooler exists for. Open six separate client connections through the pooler, asking each one for the process ID of the PostgreSQL backend serving it, and count how many distinct answers you get.

Then do exactly the same six connections directly against the read-write Service, and count again. The contrast is the lesson, and it is stark.

Record the number of distinct backends the pooled connections shared in \`/root/pooled-backends.txt\`. Expect one per PgBouncer Pod: each Pod keeps its own pool, and the Service spreads your connections across both.`,
      instructions: `Six connections through the pooler, each asking which backend process is serving it:

\`\`\`
for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -tAc "SELECT pg_backend_pid();"; done
\`\`\`

Six separate client connections, and only two distinct process IDs come back — one per PgBouncer Pod, because each Pod holds its own idle server connection and hands it to the next client that arrives.

Now the same six connections, straight to the database:

\`\`\`
for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT pg_backend_pid();"; done
\`\`\`

Six connections, six different process IDs. Every one of them was a fork of the postmaster with its own memory, and every one was torn down again a moment later. That cost is what a pooler removes.

Record what you counted through the pooler:

\`\`\`
echo 2 > /root/pooled-backends.txt
\`\`\`

Watch the pool settle from PgBouncer's side, too:

\`\`\`
POOLER=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POOLER -c pgbouncer -- psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW POOLS;"
\`\`\`

The app pool shows no active clients and an idle server connection kept ready — which is precisely the state that makes the next client's connection cheap.`,
      hint: `Each \`kubectl exec ... psql\` is one whole client connection: it opens, runs the query, and closes. The distinct count is over the values that came back, not the number of commands you ran.`,
      solution: `for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -tAc "SELECT pg_backend_pid();"; done
for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT pg_backend_pid();"; done
echo 2 > /root/pooled-backends.txt`,
    },
  ],
}
