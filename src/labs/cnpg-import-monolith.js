// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a
// Cluster whose bootstrap is `initdb.import` with `type: monolith` and `"*"` for both databases
// and roles came up healthy in well under a minute carrying app, orders and billing with their
// original names and owners, plus the shop and reporting roles with their attributes. The role
// passwords came across in the dump, so shop logs in on the new cluster with the password it
// had on the old one. No application database, user or `-app` Secret is created for a monolith
// import — only ca, replication and server Secrets exist — and nothing replicates afterwards.
//
// Self-contained, like every lab here: the operator, a healthy cluster carrying several
// application databases and roles, a client Pod and a staged import manifest are this lab's
// starting state, built by its own provisioning. No reference to any other lab (see CLAUDE.md,
// "Lab content contract").

export const cnpgImportMonolith = {
  id: 'cnpg-import-monolith',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real PostgreSQL server with several application databases and roles on it, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time and then seeded before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster standing in for the old server: an app database, an orders database with 500 rows in a lines table, a billing database with 200 invoices, both owned by a role called shop with a login password, and a reporting role that cannot log in',
      'Superuser access switched on for that cluster, so the postgres password exists in a pg-cluster-superuser Secret — dumping every database and the roles requires it',
      'A manifest staged on the k3d-server node at /root/import.yaml describing a second Cluster called pg-estate that imports every database and every role from the first — written, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Sometimes the unit being moved is not a database but a server: several applications, several roles, one machine that has to be gone by the end of the quarter. The monolith import lifts all of it into a CloudNativePG cluster in one operation, keeping the database names, the ownership and the roles as they were. You will run it, verify what arrived down to the login passwords, and then look carefully at what you have been handed — because a cluster imported this way is missing something every other CloudNativePG cluster has.',
  },

  tasks: [
    {
      id: 'survey-the-server',
      title: 'Take inventory of the whole server',
      limitSec: 420,
      criteria: [
        'The server carries three application databases, with two owners between them',
        'And the roles that own them, including one that cannot log in',
        '/root/databases.txt was written',
        'It lists the databases you are about to move',
      ],
      brief: `A server-level migration begins with an inventory, because everything you fail to write down is something you find out about from an application at three in the morning.

There are two lists that matter: the databases with their owners, and the roles with their attributes. Take both, and note that the roles are not all alike — one of them is a login role that applications authenticate as, and one cannot log in at all and exists only to be granted things.

Then read the manifest, which asks for all of it with two asterisks.`,
      instructions: `Work in the **k3d-server** tab. Start with the databases:

\`\`\`
kubectl get cluster pg-cluster
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\l"
\`\`\`

Three application databases and two owners: \`app\` owns \`app\`, and \`shop\` owns both \`orders\` and \`billing\`. Record them:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;" > /root/databases.txt
cat /root/databases.txt
\`\`\`

Now the roles, which are the half of a server that a per-database dump would miss entirely:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\du"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname;"
\`\`\`

\`shop\` can log in; \`reporting\` cannot. That distinction survives the move, and so does the grant \`reporting\` holds on the orders table:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -c "\\dp lines"
\`\`\`

And the data itself, so there is a number to check against later:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d billing -tAc "SELECT count(*) FROM invoices;"
\`\`\`

Finally the manifest:

\`\`\`
cat /root/import.yaml
\`\`\`

\`type: monolith\`, with \`"*"\` in both \`databases\` and \`roles\` — every database and every role on the source. You could name them individually instead, and would if you were splitting a server rather than moving it. The connection is the same as any logical import: the source's read-write Service, as \`postgres\`, with the password from the \`pg-cluster-superuser\` Secret. Dumping roles needs superuser; there is no way around it.`,
      hint: `\`datistemplate = false\` filters out template0 and template1, which are PostgreSQL's own and are never part of an import.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\l"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;" > /root/databases.txt
cat /root/databases.txt
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\du"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d billing -tAc "SELECT count(*) FROM invoices;"
cat /root/import.yaml`,
    },

    {
      id: 'import-everything',
      title: 'Move the whole server',
      limitSec: 600,
      criteria: [
        'A new Cluster named pg-estate reports healthy',
        'It has the same databases, with the same names and owners',
        'And the roles, including the one that cannot log in',
        'The data came with them — 500 order lines and 200 invoices',
      ],
      brief: `Apply it and watch a new cluster build itself out of another server's entire contents. The work happens inside the new instance's initdb job: the roles are dumped first, then each database in turn, and the cluster reports healthy once the last one is restored.

What arrives is deliberately not rearranged. The databases keep their names, their owners keep owning them, the login role keeps its password and the role that cannot log in still cannot. That is the difference between moving a server and extracting an application from one: nothing here is renamed to fit a convention.

Check all of it. A migration is only finished when somebody has looked.`,
      instructions: `Apply the staged manifest:

\`\`\`
kubectl apply -f /root/import.yaml
kubectl get cluster
\`\`\`

Give it a moment — this is a dump and restore of three databases plus the roles, which for data this size is quick and for a real server is however long it is:

\`\`\`
sleep 45
kubectl get cluster
\`\`\`

Once \`pg-estate\` reads *Cluster in healthy state*, compare it against the inventory you took:

\`\`\`
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -c "\\l"
cat /root/databases.txt
\`\`\`

The same databases, under the same names, owned by the same roles. Nothing was renamed and nothing was reassigned.

Now the roles:

\`\`\`
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname;"
\`\`\`

\`shop\` and \`reporting\` are both here with the attributes they had, alongside the four roles the operator creates for any cluster of its own. And the grants came too:

\`\`\`
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -d orders -c "\\dp lines"
\`\`\`

Finally, the data:

\`\`\`
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -d billing -tAc "SELECT count(*) FROM invoices;"
\`\`\`

Five hundred and two hundred, matching the source. The server has moved.`,
      hint: `If \`pg-estate\` is still *Setting up primary* after a minute, the import is running inside the initdb job — \`kubectl logs job/pg-estate-1-initdb\` shows what pg_dump and pg_restore are doing.`,
      solution: `kubectl apply -f /root/import.yaml
sleep 45
kubectl get cluster
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -c "\\l"
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname;"
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -d billing -tAc "SELECT count(*) FROM invoices;"`,
    },

    {
      id: 'what-you-own-now',
      title: 'Look at what you have been handed',
      limitSec: 600,
      criteria: [
        'The imported roles kept their passwords — shop still logs in with the old one',
        'The operator created no application user for this cluster',
        'And nothing is replicating — the copy stopped when the import finished',
        'Both clusters are healthy',
      ],
      brief: `A monolith import gives you a PostgreSQL server, faithfully. It does not give you a CloudNativePG *application* cluster, and the difference is worth understanding before you hand the address to anybody.

Three things to establish. The login roles came across with their passwords, which is convenient and also means the old credentials are now valid in a second place. There is no application user or generated Secret, because the operator was not asked to create a database — so the credentials your applications will use are the imported ones, managed by you, not rotated by the operator. And nothing is following the source, exactly as with any other import.

That is not a criticism of the shape; it is the shape. Knowing it decides what the next ticket says.`,
      instructions: `First, the passwords. Connect to the new cluster as \`shop\`, with the password that role had on the old server:

\`\`\`
kubectl exec psql-client -- env PGPASSWORD=shop_pw psql -h pg-estate-rw -U shop -d orders -tAc \\
  "SELECT count(*) FROM lines;"
\`\`\`

Five hundred rows. \`pg_dumpall --roles-only\` carries the password hashes, so a login role works on the copy exactly as it did on the original. Plan for that: after a cutover the same credentials open two databases, and only one of them is the one people think they are talking to.

Now look at the Secrets the operator generated:

\`\`\`
kubectl get secret
\`\`\`

The new cluster has \`pg-estate-ca\`, \`pg-estate-replication\` and \`pg-estate-server\` — the certificates it needs to run — and no \`pg-estate-app\`, while the source next to it has one. A monolith import does not create an application database, so there is no application user for the operator to manage or rotate. Every credential in this cluster came out of the dump and is yours to look after.

Check that the same is true of the superuser:

\`\`\`
kubectl get cluster pg-estate -o jsonpath='{.spec.enableSuperuserAccess}{"\\n"}'
\`\`\`

Nothing — so \`postgres\` on the new cluster has no password at all and can only be reached the way you have been reaching it, through \`kubectl exec\` and peer authentication on the local socket. That is the default for a CloudNativePG cluster and it is a good one; it is just not what the old server was doing.

Finally, confirm the two are not connected:

\`\`\`
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_stat_wal_receiver;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl get cluster
\`\`\`

No WAL receiver on the copy, and the source is streaming only to its own two replicas. The import read the source once and finished.

So the remaining work after an import like this one is a checklist rather than a mystery: repoint every application at the new Services, decide which imported roles should keep the passwords they arrived with, and — if you want the operator to manage an application user the way it does everywhere else — create one yourself. What you have is the old server, intact, in a new place.`,
      hint: `\`shop_pw\` is the password that role was created with on the source. If the connection is refused, check you are connecting to \`pg-estate-rw\` and to the \`orders\` database.`,
      solution: `kubectl exec psql-client -- env PGPASSWORD=shop_pw psql -h pg-estate-rw -U shop -d orders -tAc "SELECT count(*) FROM lines;"
kubectl get secret
kubectl get cluster pg-estate -o jsonpath='{.spec.enableSuperuserAccess}{"\\n"}'
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_stat_wal_receiver;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl get cluster`,
    },
  ],
}
