// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). A
// Database object reported `APPLIED true` about twelve seconds after it was applied, having
// created the database owned by app; the webhook fills in `databaseReclaimPolicy: retain` and
// `ensure: present`, and the object carries the finalizer `cnpg.io/deleteDatabase`. A second
// object naming the same PostgreSQL database was refused into its own status —
// `applied: false`, `"reporting" is already managed by object "reporting-db"` — with the first
// object untouched. Deleting the retain object left the database and its rows exactly where they
// were, and re-applying an identical object adopted the existing database, `applied: true`,
// data intact.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client Pod
// and two staged manifests are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgDeclarativeDatabases = {
  id: 'cnpg-declarative-databases',
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
      'A healthy 3-instance Cluster named pg-cluster, holding only the databases the operator makes: app, postgres and the two templates',
      'Two manifests staged on the k3d-server node — /root/reporting-db.yaml and /root/reporting-dup.yaml — written, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A CloudNativePG cluster arrives with exactly one application database, and the usual way a second one appears is somebody running CREATE DATABASE and telling nobody. The Database resource makes it an object in Kubernetes instead: a manifest that can be reviewed, versioned and reconciled. You will create one, find out what the operator does when two objects claim the same database, and then delete the object and see what that does — and does not — do to the data.',
  },

  tasks: [
    {
      id: 'declare-a-database',
      title: 'Declare a database',
      limitSec: 600,
      criteria: [
        'A Database object called reporting-db reports applied',
        'The reporting database exists in PostgreSQL, owned by app',
        'Its reclaim policy is retain — the default nobody wrote',
        'And the object carries the cnpg.io/deleteDatabase finalizer',
      ],
      brief: `A \`Database\` is a namespaced resource with a small spec: which Cluster hosts it, what the database is called in PostgreSQL, and who owns it. The object's own name and the database's name are separate fields, which is what lets two clusters in one namespace both have a \`reporting\`.

Apply it and the operator issues the \`CREATE DATABASE\` for you, then reports back in the object's status rather than in a log somewhere: \`applied\`, and a \`message\` when it could not.

Read what comes back carefully. There are fields in the stored object that you never wrote — a reclaim policy, an \`ensure\`, and a finalizer — and each of them decides something about what happens later.`,
      instructions: `Work in the **k3d-server** tab. See what databases exist first:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l"
kubectl get database
\`\`\`

\`app\`, \`postgres\` and the two templates — and no Database objects at all.

Read the manifest and apply it:

\`\`\`
cat /root/reporting-db.yaml
kubectl apply -f /root/reporting-db.yaml
sleep 12
kubectl get database
\`\`\`

The table \`kubectl\` prints has the columns that matter: the cluster, the PostgreSQL name, whether it was applied, and a message if not. \`APPLIED\` is \`true\` within a few seconds.

Confirm it in the database itself, which is the only thing that settles it:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | head -8
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT current_database(), current_user;"
\`\`\`

Owned by \`app\`, and reachable through the ordinary read-write Service — nothing about the connection is special, because there is nothing special about the database.

Now read the object as the cluster stores it:

\`\`\`
kubectl get database reporting-db -o jsonpath='{.spec}{"\\n"}'
kubectl get database reporting-db -o jsonpath='{.status}{"\\n"}'
kubectl get database reporting-db -o jsonpath='{.metadata.finalizers}{"\\n"}'
\`\`\`

Three things arrived without you: \`ensure: present\`, \`databaseReclaimPolicy: retain\`, and the finalizer \`cnpg.io/deleteDatabase\`. The status carries \`applied: true\` and an \`observedGeneration\`, which is how you tell a status about the spec you just sent from a status about the one before it.

The finalizer is the one to notice. It is there so that deleting this object is not just a Kubernetes deletion — the operator gets to decide what happens to the PostgreSQL database first, and the reclaim policy is how you tell it what you want.`,
      hint: `\`kubectl get database\` prints the PG NAME, APPLIED and MESSAGE columns; \`-o jsonpath='{.spec}'\` shows what the webhook filled in that the manifest never said.`,
      solution: `cat /root/reporting-db.yaml
kubectl apply -f /root/reporting-db.yaml
sleep 15
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | head -8
kubectl get database reporting-db -o jsonpath='{.spec}{"\\n"}'
kubectl get database reporting-db -o jsonpath='{.metadata.finalizers}{"\\n"}'`,
    },

    {
      id: 'one-object-owns-it',
      title: 'Find out who owns the database',
      limitSec: 600,
      criteria: [
        '/root/already-managed.txt records the second object being turned away',
        'The duplicate object has been removed again',
        'The original is still applied, with nothing to report',
        'And the table you created inside the database holds 3 rows',
      ],
      brief: `If a database is an object, the obvious question is what happens when two objects claim the same one — by accident, in two directories, in the same namespace.

Apply the second manifest and read its status rather than expecting an error from \`kubectl\`. The apply succeeds: the object is valid, and this is not something admission can decide. The operator resolves it afterwards, refuses the newcomer, and says exactly why in that object's own \`message\`.

What matters is what happens to the *first* object while that goes on. Nothing does — it stays applied, the database is not touched, and the conflict is contained inside the object that caused it.`,
      instructions: `Put something in the database first, so you can tell later whether anything was disturbed:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -c \\
  "CREATE TABLE ledger (id serial primary key, entry text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -c \\
  "INSERT INTO ledger (entry) VALUES ('one'), ('two'), ('three');"
\`\`\`

Now apply the second manifest, which is a different object naming the same database:

\`\`\`
diff /root/reporting-db.yaml /root/reporting-dup.yaml
kubectl apply -f /root/reporting-dup.yaml
sleep 12
kubectl get database | tee /root/already-managed.txt
\`\`\`

The apply is accepted and the reconciliation is not. \`reporting-dup\` reads \`APPLIED false\` with the message *"reporting" is already managed by object "reporting-db"*, while \`reporting-db\` is unchanged.

Look at the loser's status directly:

\`\`\`
kubectl get database reporting-dup -o jsonpath='{.status}{"\\n"}'
kubectl get database reporting-db -o jsonpath='{.status}{"\\n"}'
\`\`\`

One object owns one database, and ownership goes to whoever got there first. That is a better answer than either alternative — two controllers fighting over the same \`ALTER DATABASE\`, or a webhook refusing an object because of something that may since have been deleted.

Clean up the duplicate, and confirm the database never noticed any of it:

\`\`\`
kubectl delete database reporting-dup
kubectl get database
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT count(*) FROM ledger;"
\`\`\`

Three rows, one object, and a \`message\` that is empty again.

A note on that deletion, which you will want to think about before doing it in earnest: the duplicate object also carried the delete finalizer, and deleting it did *not* drop the database — because its reclaim policy was the default, and because the operator knew it was never the object managing it.`,
      hint: `\`kubectl apply\` will succeed for the duplicate. The refusal lives in \`kubectl get database\` — the MESSAGE column — and in that object's \`.status\`.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -c "CREATE TABLE ledger (id serial primary key, entry text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -c "INSERT INTO ledger (entry) VALUES ('one'), ('two'), ('three');"
kubectl apply -f /root/reporting-dup.yaml
sleep 15
kubectl get database | tee /root/already-managed.txt
kubectl get database reporting-dup -o jsonpath='{.status}{"\\n"}'
kubectl delete database reporting-dup
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT count(*) FROM ledger;"`,
    },

    {
      id: 'delete-the-object-keep-the-database',
      title: 'Delete the object, keep the database',
      limitSec: 600,
      criteria: [
        '/root/retained.txt records the database still there after the object went',
        'The reporting database survived the deletion',
        'With its table and rows untouched',
        'And a Database object declaring it again has adopted it',
      ],
      brief: `Now the field nobody wrote: \`databaseReclaimPolicy\`, which defaults to \`retain\`.

It decides one thing — what happens to the PostgreSQL database when the Kubernetes object is deleted. Under \`retain\`, the answer is nothing at all: the finalizer is removed, the object goes, and the database and everything in it stay exactly where they were.

That default is chosen the way it is for the obvious reason. An object can be deleted by a mistaken \`kubectl delete\`, by a namespace being cleaned up, or by a reconciler pruning something it no longer sees in Git, and none of those should be able to drop a database.

Then do the thing that makes retain genuinely useful: declare it again, and watch the operator adopt what is already there rather than fail because it exists.`,
      instructions: `Delete the object, and look at both sides afterwards:

\`\`\`
kubectl delete database reporting-db
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | grep reporting | tee /root/retained.txt
\`\`\`

No objects, and the database is still listed. The deletion was a Kubernetes event; PostgreSQL was never asked to do anything.

Check the contents are genuinely untouched:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT count(*) FROM ledger;"
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -c "SELECT * FROM ledger ORDER BY id;"
\`\`\`

Now declare it again, with the same manifest you started from:

\`\`\`
kubectl apply -f /root/reporting-db.yaml
sleep 12
kubectl get database
kubectl get database reporting-db -o jsonpath='{.status}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT count(*) FROM ledger;"
\`\`\`

\`APPLIED true\`, with the rows still there. The operator did not fail because the database already existed and it did not recreate it — it adopted it, and from that moment the object manages it again.

That adoption is what makes the retain default workable rather than merely safe. A database that outlives its object can be brought back under management by re-applying the manifest, which is exactly what you want after a namespace was rebuilt, a manifest was moved between repositories, or an object was deleted by somebody who did not mean it.

Two cautions to carry away. Adoption is by *name*: an object pointed at an existing database it was never meant to manage will happily take it over, and the only protection is that a second object claiming the same one is refused. And retain means what it says — a database left behind by a deleted object keeps its storage, its connections and its cost, and nothing in Kubernetes will remind you it is there.`,
      hint: `Apply exactly the same manifest again — \`/root/reporting-db.yaml\` — and read the status. Adoption is not a separate command.`,
      solution: `kubectl delete database reporting-db
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | grep reporting | tee /root/retained.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT count(*) FROM ledger;"
kubectl apply -f /root/reporting-db.yaml
sleep 15
kubectl get database
kubectl get database reporting-db -o jsonpath='{.status}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT count(*) FROM ledger;"`,
    },
  ],
}
