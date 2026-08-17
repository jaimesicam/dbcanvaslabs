// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a
// Cluster whose bootstrap is `pg_basebackup` with no `replica` stanza runs a
// pg-clone-1-pgbasebackup-* Job, comes up as a read-write primary (pg_is_in_recovery() is f)
// carrying every database, role and row the source had, and is coupled to the source for
// exactly as long as the copy takes. Both clusters stay on timeline 1, the source's
// pg_stat_replication never mentions the clone, the clone has no WAL receiver, and the two
// diverge from the moment the copy finishes — the same id means a different row on each side.
// The operator resets the application user to the clone's own generated Secret, so the source's
// app password is refused on the copy with `password authentication failed for user "app"`.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster with seeded
// data, a client Pod and a staged clone manifest are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgBasebackupClone = {
  id: 'cnpg-basebackup-clone',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, and the copy you make will be a real base backup over a real network connection.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster — the server you are going to copy',
      'A table called notes in its application database, owned by the app user, holding 50 rows',
      'A manifest staged on the k3d-server node at /root/clone.yaml describing a second Cluster called pg-clone, which bootstraps with pg_basebackup from the first — written, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Somebody wants a copy of production to test against. Not a backup, not a standby — a full, writable, independent copy of the database as it is right now, that they can break without anybody noticing. CloudNativePG bootstraps one with a single stanza, and the interesting part is the field that is not there: leave out the replica setting and the copy stops following the original the moment it finishes, from which point the two are separate databases that merely look identical. You will make one, and then prove exactly how separate they are.',
  },

  tasks: [
    {
      id: 'read-the-source',
      title: 'Read the server you are about to copy',
      limitSec: 420,
      criteria: [
        'The source is healthy and the notes table has 50 rows',
        '/root/source-rows.txt was written',
        'It records the row count you read',
      ],
      brief: `Before copying anything, know what you are copying and read the manifest that will do it.

The staged Cluster is short, and almost all of it is the connection to the source: an \`externalClusters\` entry naming the read-write Service, the replication user, and the three Secrets that let it authenticate with a certificate instead of a password. The part that does the work is two lines — a \`bootstrap.pg_basebackup\` block naming that external cluster.

Read it and notice what is missing. There is no \`replica\` section, and that absence is the whole subject of this lab.`,
      instructions: `Work in the **k3d-server** tab. Look at the source:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\`

Fifty rows in the application database, on a healthy three-instance cluster. Record the count:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;" > /root/source-rows.txt
cat /root/source-rows.txt
\`\`\`

Now read the manifest that will copy it:

\`\`\`
cat /root/clone.yaml
\`\`\`

Three things are worth reading closely.

\`bootstrap.pg_basebackup.source: origin\` says: instead of running initdb and starting an empty database, connect to the cluster called \`origin\` and take a physical base backup of it. That is a byte-for-byte copy of the whole data directory — every database, every role, every setting, not just the application's tables.

The \`externalClusters\` entry says where \`origin\` is and how to authenticate: the \`pg-cluster-rw\` Service, the user \`streaming_replica\`, and the source's own certificates, mounted from the Secrets the operator generated for it. The copy is taken over the streaming replication protocol, which is why it uses the replication user and not the application one.

And there is no \`replica:\` block. A manifest that had one would keep the copy in recovery, following the source indefinitely. Without it, the copy starts up as its own primary as soon as the backup finishes.

Check the credentials the source is using, so the difference is visible later:

\`\`\`
kubectl get secret -l cnpg.io/cluster=pg-cluster
\`\`\``,
      hint: `\`psql-client\` already has the source's application credentials in its environment, so it needs no user or password — just \`-h\` and the Service name.`,
      solution: `kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;" > /root/source-rows.txt
cat /root/source-rows.txt
cat /root/clone.yaml
kubectl get secret -l cnpg.io/cluster=pg-cluster`,
    },

    {
      id: 'clone-it',
      title: 'Take the copy',
      limitSec: 720,
      criteria: [
        'A second Cluster named pg-clone reports healthy',
        'It is a read-write primary, not a standby',
        'It carries the 50 rows the source had when the copy was taken',
        'And its own application credentials — the source password is refused',
      ],
      brief: `Apply it and watch. The operator creates a Job whose only purpose is to run the base backup — you will see it as a Pod called \`pg-clone-1-pgbasebackup-…\` — and when it finishes, the instance starts on the copy it made.

The phase to watch for is *Setting up primary*, not *Creating a new replica*. This copy is nobody's standby: it comes up writable, and from that moment the source has no idea it exists.

Then check the credentials, which is where a physical copy surprises people. Every role came across with its password, because the roles are inside the data directory that was copied. But the operator manages an application user for each Cluster it owns, and it will make this one match the new Secret it generated — so the password that works against the source does not work here.`,
      instructions: `Apply the staged manifest:

\`\`\`
kubectl apply -f /root/clone.yaml
kubectl get cluster
kubectl get pods
\`\`\`

Within a few seconds there is a \`pg-clone-1-pgbasebackup-…\` Pod. That is the copy being taken; the cluster reports *Setting up primary* while it runs. Watch it through:

\`\`\`
sleep 60
kubectl get cluster
kubectl get pods
\`\`\`

Repeat that until \`pg-clone\` reads *Cluster in healthy state* — well under a minute on a quiet machine, longer if it is busy. The base-backup Pod stays behind as \`Completed\` once it has done its job.

Now the important question — is this a standby?

\`\`\`
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_stat_wal_receiver;"
\`\`\`

\`f\` and \`0\`: not in recovery, and nothing is streaming to it. It is a primary in its own right.

Look at what came with it:

\`\`\`
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM notes;"
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -c "\\du"
\`\`\`

Fifty rows, and every role the source had — including \`app\` and \`streaming_replica\`. A physical copy takes the whole cluster, not one database.

Now the credentials. The source's application password:

\`\`\`
SRC=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$SRC" psql -h pg-clone-rw -U app -d app -tAc "SELECT 1;"
\`\`\`

\`FATAL: password authentication failed for user "app"\`. The role arrived with the source's password, and then the operator reset it to the one in the Secret it generated for this cluster. Use that instead:

\`\`\`
NEW=$(kubectl get secret pg-clone-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$NEW" psql -h pg-clone-rw -U app -d app -tAc "SELECT count(*) FROM notes;"
\`\`\`

Fifty rows, through the clone's own read-write Service, with the clone's own credentials. Anything pointed at the copy needs repointing at both.`,
      hint: `If \`pg-clone\` sits at *Setting up primary* for a while, that is the base backup running — it is a real copy over a real connection. Give it another minute before worrying, and \`kubectl get pods\` will show the pgbasebackup Pod still working.`,
      solution: `kubectl apply -f /root/clone.yaml
sleep 90
kubectl get cluster
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM notes;"
SRC=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$SRC" psql -h pg-clone-rw -U app -d app -tAc "SELECT 1;"
NEW=$(kubectl get secret pg-clone-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$NEW" psql -h pg-clone-rw -U app -d app -tAc "SELECT count(*) FROM notes;"`,
    },

    {
      id: 'prove-independence',
      title: 'Prove the two have nothing to do with each other',
      limitSec: 600,
      criteria: [
        'The row you wrote on the clone is not on the source',
        'The row you wrote on the source is not on the clone',
        'Neither one is replicating to the other',
        'Both clusters are healthy',
      ],
      brief: `A copy that looks exactly like the original is a dangerous thing to have around, because everything about it invites you to treat it as the same database. It is not, and the cheapest way to internalise that is to watch them disagree.

Write a row on each side and look at what happens to the identifiers. Both tables have the same sequence at the same value, so both hand out the same next id — and now that id means two different rows, one on each cluster. Nothing will ever reconcile them.

Then confirm the coupling really is gone: nothing streams, nothing follows, and neither cluster's replication state mentions the other. The relationship lasted exactly as long as the copy took.`,
      instructions: `Write on the clone, using its own credentials:

\`\`\`
NEW=$(kubectl get secret pg-clone-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$NEW" psql -h pg-clone-rw -U app -d app -c \\
  "INSERT INTO notes (entry) VALUES ('written on the clone') RETURNING id, entry;"
\`\`\`

And on the source:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "INSERT INTO notes (entry) VALUES ('written on the source') RETURNING id, entry;"
\`\`\`

Look at the two id values. They are the same number, because both sequences were copied at the same point and have been handed out independently ever since. Now read both tables:

\`\`\`
echo "--- source:"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT id, entry FROM notes ORDER BY id DESC LIMIT 3;"
echo "--- clone:"
kubectl exec psql-client -- env PGPASSWORD="$NEW" psql -h pg-clone-rw -U app -d app -tAc \\
  "SELECT id, entry FROM notes ORDER BY id DESC LIMIT 3;"
\`\`\`

Each side has 50 rows in common and one row the other has never heard of, sharing an id. That is what "independent copy" means in practice, and it is why a clone is useless as a backup: there is no path back from here to a single consistent database.

Confirm nothing is connecting them:

\`\`\`
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_stat_wal_receiver;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

The clone has no WAL receiver, and the source is streaming only to its own two replicas. Neither knows the other exists.

One last thing worth checking, because it is the trap this shape sets:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.timelineID}{"\\n"}'
kubectl get cluster pg-clone -o jsonpath='{.status.timelineID}{"\\n"}'
\`\`\`

Both say **1**. A clone taken this way is not promoted — it simply starts up as a primary — so it does not begin a new timeline the way a standby that gets promoted does. Two databases, diverging, writing WAL under the same timeline id. Never point one of them at the other's WAL archive, and never let them share a backup destination: nothing in the file names would tell them apart.

Finally, both are healthy and neither is worse for the other's existence:

\`\`\`
kubectl get cluster
\`\`\``,
      hint: `The clone has its own \`pg-clone-app\` Secret, its own \`pg-clone-rw\` Service and its own certificates. Every connection to it needs the clone's password — the \`psql-client\` Pod's built-in credentials belong to the source.`,
      solution: `NEW=$(kubectl get secret pg-clone-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$NEW" psql -h pg-clone-rw -U app -d app -c "INSERT INTO notes (entry) VALUES ('written on the clone') RETURNING id, entry;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO notes (entry) VALUES ('written on the source') RETURNING id, entry;"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT id, entry FROM notes ORDER BY id DESC LIMIT 3;"
kubectl exec psql-client -- env PGPASSWORD="$NEW" psql -h pg-clone-rw -U app -d app -tAc "SELECT id, entry FROM notes ORDER BY id DESC LIMIT 3;"
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_stat_wal_receiver;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl get cluster pg-clone -o jsonpath='{.status.timelineID}{"\\n"}'
kubectl get cluster`,
    },
  ],
}
