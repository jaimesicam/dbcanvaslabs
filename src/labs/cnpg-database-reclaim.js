// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). Two
// Database objects on one cluster, one with `databaseReclaimPolicy: delete` and one with
// `retain`, both reported `APPLIED true` in about twelve seconds. Deleting the delete-policy
// object while a client held a connection to its database **blocked**: `kubectl delete` did not
// return, the object stayed listed with a `deletionTimestamp` and its `cnpg.io/deleteDatabase`
// finalizer, the database was still there, and there was no event and no message anywhere. The
// moment the session ended, the object went and the database was dropped. `ensure: absent` on
// the retain object dropped its database while the object stayed, still reporting
// `applied: true`.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client Pod
// and two staged manifests are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgDatabaseReclaim = {
  id: 'cnpg-database-reclaim',
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
      'Two manifests staged on the k3d-server node — /root/temp-db.yaml, which asks for the delete reclaim policy, and /root/keep-db.yaml, which asks for retain — written, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A database declared as a Kubernetes object raises a question the object cannot answer on its own: when the object is deleted, should the data go too? CloudNativePG makes that an explicit field with two values, and the difference between them is the difference between a tidy environment and an unrecoverable afternoon. You will run both policies side by side on the same cluster, delete both objects, and find the one thing that quietly stops a deletion from finishing.',
  },

  tasks: [
    {
      id: 'two-policies',
      title: 'Declare two databases with different endings',
      limitSec: 600,
      criteria: [
        'Both Database objects report applied',
        'Both databases exist in PostgreSQL',
        'tempdb is declared with the delete reclaim policy',
        'And keepdb with retain, so the two can be compared',
      ],
      brief: `\`databaseReclaimPolicy\` takes one of two values, and it governs exactly one moment: what happens to the PostgreSQL database when the Kubernetes object is deleted.

\`retain\`, the default, leaves the database alone. \`delete\` drops it. Nothing else about the two objects differs — same kind, same cluster, same reconciliation, same status.

Apply one of each so the rest of this lab has something to compare, and put a table in each so "the database is gone" means something you can see the loss of rather than an empty name disappearing from a list.`,
      instructions: `Work in the **k3d-server** tab. Read both manifests — they differ in one line:

\`\`\`
diff /root/temp-db.yaml /root/keep-db.yaml
kubectl apply -f /root/temp-db.yaml
kubectl apply -f /root/keep-db.yaml
sleep 12
kubectl get database
\`\`\`

Both \`APPLIED true\`. The reclaim policy has no effect at all while the object exists, which is why it is easy to set carelessly.

Confirm the databases are real, and give each one something to lose:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | head -9
kubectl exec psql-client -- psql -h pg-cluster-rw -d tempdb -c \\
  "CREATE TABLE work (id serial primary key, entry text); INSERT INTO work (entry) VALUES ('a'), ('b');"
kubectl exec psql-client -- psql -h pg-cluster-rw -d keepdb -c \\
  "CREATE TABLE work (id serial primary key, entry text); INSERT INTO work (entry) VALUES ('a'), ('b');"
\`\`\`

And read the policies back off the objects, since this is the field the whole lab turns on:

\`\`\`
kubectl get database -o custom-columns=OBJECT:.metadata.name,PGNAME:.spec.name,POLICY:.spec.databaseReclaimPolicy,ENSURE:.spec.ensure,APPLIED:.status.applied
\`\`\`

\`delete\` on one, \`retain\` on the other, \`present\` for both. Two fields that sound similar and are not: \`ensure\` is about the database *while the object exists*, and \`databaseReclaimPolicy\` is about what happens *when it stops existing*.`,
      hint: `Both files are already written — \`diff\` them to see the one field that differs, then apply both.`,
      solution: `diff /root/temp-db.yaml /root/keep-db.yaml
kubectl apply -f /root/temp-db.yaml
kubectl apply -f /root/keep-db.yaml
sleep 15
kubectl get database
kubectl exec psql-client -- psql -h pg-cluster-rw -d tempdb -c "CREATE TABLE work (id serial primary key, entry text); INSERT INTO work (entry) VALUES ('a'), ('b');"
kubectl exec psql-client -- psql -h pg-cluster-rw -d keepdb -c "CREATE TABLE work (id serial primary key, entry text); INSERT INTO work (entry) VALUES ('a'), ('b');"
kubectl get database -o custom-columns=OBJECT:.metadata.name,PGNAME:.spec.name,POLICY:.spec.databaseReclaimPolicy,ENSURE:.spec.ensure,APPLIED:.status.applied`,
    },

    {
      id: 'delete-takes-it-with-it',
      title: 'Delete the object while somebody is connected',
      limitSec: 720,
      criteria: [
        '/root/blocked.txt records the object waiting on its finalizer, with a deletionTimestamp',
        'The temp-db object is gone now that nothing is connected',
        'And tempdb went with it — that is what delete means',
        'While keepdb, on the other policy, is untouched',
      ],
      brief: `Deleting an object with the \`delete\` policy asks the operator to drop a PostgreSQL database, and PostgreSQL will not drop a database anybody is connected to.

So arrange exactly that. Hold one session open against \`tempdb\`, ask Kubernetes to delete the object, and watch what happens in between: the object does not go away. It sits there with a \`deletionTimestamp\` set and its \`cnpg.io/deleteDatabase\` finalizer still attached, which is Kubernetes waiting for the controller to say the cleanup is done.

The part worth remembering is how little tells you so. There is no event, no message in the status, and nothing in the operator's log naming the database. The only signals are that a plain \`kubectl delete\` sits there and that the object is still listed.

Let the session end and the whole thing completes on its own.`,
      instructions: `Hold a connection open to \`tempdb\` in the background, and confirm the server sees it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -d tempdb -c "SELECT pg_sleep(90);" &
sleep 5
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc \\
  "SELECT count(*) FROM pg_stat_activity WHERE datname = 'tempdb';"
\`\`\`

Now ask for the object to be deleted. Use \`--wait=false\` so your terminal comes back — a plain \`kubectl delete\` would sit there until the deletion finished, which is itself the symptom:

\`\`\`
kubectl delete database temp-db --wait=false
sleep 10
kubectl get database
\`\`\`

\`temp-db\` is still listed. Look at why:

\`\`\`
kubectl get database temp-db -o jsonpath='{"deletionTimestamp="}{.metadata.deletionTimestamp}{" finalizers="}{.metadata.finalizers}{"\\n"}' | tee /root/blocked.txt
kubectl get database temp-db -o jsonpath='{.status}{"\\n"}'
kubectl describe database temp-db | tail -4
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc \\
  "SELECT count(*) FROM pg_database WHERE datname = 'tempdb';"
\`\`\`

A deletion timestamp, the finalizer still in place, a status that still says \`applied: true\`, no events at all — and the database still there. Nothing here says *why*, and that is the honest shape of this failure: the only way to know is to remember that a database with a session on it cannot be dropped.

Wait for the session to end, and watch the deletion finish by itself:

\`\`\`
wait
sleep 10
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | head -8
\`\`\`

\`tempdb\` is gone, with its table and its rows, because that is what the policy asked for. And \`keepdb\` is exactly where it was.

The operational reading: with \`delete\`, removing the object is a destructive database operation wearing Kubernetes clothes, and it can hang indefinitely on something as ordinary as an idle connection from an application that has not been scaled down yet. Reach for it for genuinely disposable databases — a preview environment, a per-branch database, a test fixture — and not for anything you would miss.`,
      hint: `\`kubectl delete database temp-db --wait=false\` returns immediately and still sets the deletionTimestamp; \`kubectl get database temp-db -o jsonpath='{.metadata.deletionTimestamp}'\` is where the evidence is.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -d tempdb -c "SELECT pg_sleep(90);" &
sleep 5
kubectl delete database temp-db --wait=false
sleep 10
kubectl get database temp-db -o jsonpath='{"deletionTimestamp="}{.metadata.deletionTimestamp}{" finalizers="}{.metadata.finalizers}{"\\n"}' | tee /root/blocked.txt
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = 'tempdb';"
wait
sleep 15
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | head -8`,
    },

    {
      id: 'absent-is-not-the-same',
      title: 'Drop a database without deleting its object',
      limitSec: 600,
      criteria: [
        'The keep-db object now asks for the database to be absent',
        'keepdb has been dropped',
        'But the object is still there, and still reports applied',
        'And /root/absent.txt records the object outliving its database',
      ],
      brief: `There is a second way to make a database go away, and it is not the reclaim policy.

\`ensure: absent\` is a statement about the database *while the object exists*: it says this database should not be there. The operator drops it and goes on reconciling the object, which stays in the namespace reporting \`applied: true\` — a declaration that is being honoured, not a leftover.

The two fields are worth holding apart precisely because both end with a database gone. \`ensure\` is desired state and reversible in the ordinary way — change it back and the operator creates the database again, empty. \`databaseReclaimPolicy\` is a disposal instruction that only fires when the object is deleted, and by then there is nothing left to change your mind with.

Do it to the database whose policy is \`retain\`, which makes the point sharply: the policy said keep, and the database is gone anyway, because the policy was never the field being consulted.`,
      instructions: `\`keepdb\` still has its table. Ask for the database to be absent:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -d keepdb -tAc "SELECT count(*) FROM work;"
kubectl patch database keep-db --type=merge -p '{"spec":{"ensure":"absent"}}'
sleep 15
kubectl get database | tee /root/absent.txt
\`\`\`

The object is still listed, still \`APPLIED true\`, with no message. Now look at PostgreSQL:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | head -8
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc \\
  "SELECT count(*) FROM pg_database WHERE datname = 'keepdb';"
\`\`\`

Gone — on the object whose reclaim policy says \`retain\`. The policy was never consulted, because the object was never deleted.

Read the object once more to see what a fulfilled \`absent\` looks like:

\`\`\`
kubectl get database keep-db -o custom-columns=OBJECT:.metadata.name,PGNAME:.spec.name,ENSURE:.spec.ensure,POLICY:.spec.databaseReclaimPolicy,APPLIED:.status.applied
\`\`\`

\`ensure: absent\`, \`policy: retain\`, \`applied: true\`. All three are consistent: the operator has done what the object asks, and what the object asks is for the database not to exist.

So there are three separate decisions in this resource, and mixing them up is how data goes missing:

Whether the database exists right now is \`ensure\`. What happens to it if the object is deleted is \`databaseReclaimPolicy\`. And whether the operator is managing it at all is whether an object exists — which is why a database left behind by \`retain\` is invisible to Kubernetes until somebody declares it again.`,
      hint: `\`kubectl patch database keep-db --type=merge -p '{"spec":{"ensure":"absent"}}'\` — and do not delete the object, because the point is that it stays.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -d keepdb -tAc "SELECT count(*) FROM work;"
kubectl patch database keep-db --type=merge -p '{"spec":{"ensure":"absent"}}'
sleep 20
kubectl get database | tee /root/absent.txt
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = 'keepdb';"
kubectl get database keep-db -o custom-columns=OBJECT:.metadata.name,PGNAME:.spec.name,ENSURE:.spec.ensure,POLICY:.spec.databaseReclaimPolicy,APPLIED:.status.applied`,
    },
  ],
}
