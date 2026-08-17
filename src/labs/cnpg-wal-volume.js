// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a
// cluster with no walStorage keeps pg_wal as an ordinary directory inside the data volume, and
// patching spec.walStorage.size onto the running cluster created one <instance>-wal claim per
// instance, rolled the three instances in about 45 seconds ("Primary instance is being restarted
// without a switchover") and left pg_wal a symlink to /var/lib/postgresql/wal/pg_wal on every
// one of them. Removing the field again is refused by the operator's webhook: `spec.walStorage:
// Invalid value: null: walStorage cannot be disabled once configured`. The WAL claims are
// created on the *default* StorageClass unless one is named, which is not necessarily the class
// the data volume is on.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster with a seeded
// table and a client Pod are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgWALVolume = {
  id: 'cnpg-wal-volume',
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
      'A healthy 3-instance Cluster named pg-cluster with one 1Gi volume per instance and no separate WAL storage — data and write-ahead log share a disk, as they do by default',
      'A table called notes in its application database, owned by the app user, holding 50 rows',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'PostgreSQL writes two very different streams to disk: the write-ahead log, which is sequential and must be durable before a commit can be acknowledged, and the data files, which are written in scattered blocks whenever a checkpoint gets round to them. Sharing one disk between them means they compete, and the one that loses is the one every commit waits for. You will give the WAL a volume of its own on a running cluster, watch what the operator does to the data directory to arrange it, and then discover that this particular decision cannot be taken back.',
  },

  tasks: [
    {
      id: 'where-the-wal-is',
      title: 'Find the write-ahead log',
      limitSec: 420,
      criteria: [
        'pg_wal is a directory inside the data volume, not a link to anywhere',
        'The cluster has one volume per instance and no more',
        '/root/wal-path.txt was written',
        'It names the pg_wal directory inside the data directory',
      ],
      brief: `Before moving something, know where it is. PostgreSQL keeps the write-ahead log in \`pg_wal\`, inside the data directory — one 16MB file per segment, written sequentially and fsynced on every commit.

Right now that directory is exactly what it looks like: a directory on the same volume as everything else. Both streams of writes go to the same disk, and a checkpoint flushing gigabytes of data blocks is competing with the commits.

Look at the layout as it stands and record the path, because the point of the next objective is that this path stops being a directory.`,
      instructions: `Work in the **k3d-server** tab. Start with what exists:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pvc
\`\`\`

Three instances, three claims — one volume each, nothing else. Now look inside an instance:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- ls -ld /var/lib/postgresql/data/pgdata/pg_wal
kubectl exec $PRIMARY -c postgres -- ls -l /var/lib/postgresql/data/pgdata/pg_wal | head -5
\`\`\`

A plain directory (\`d\` in the first column), holding 16MB segment files with names like \`000000010000000000000003\`. Record it:

\`\`\`
echo /var/lib/postgresql/data/pgdata/pg_wal > /root/wal-path.txt
cat /root/wal-path.txt
\`\`\`

See where the Pod's storage actually comes from:

\`\`\`
kubectl get pod $PRIMARY -o jsonpath='{range .spec.volumes[?(@.persistentVolumeClaim)]}{.name}{" -> "}{.persistentVolumeClaim.claimName}{"\\n"}{end}'
kubectl exec $PRIMARY -c postgres -- df -h /var/lib/postgresql/data
\`\`\`

One claim, called \`pgdata\`, mounted at \`/var/lib/postgresql/data\`. Everything the database writes goes through it.

And ask PostgreSQL how much WAL it intends to keep around, because that is the number that decides how big a separate volume needs to be:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT name, setting, unit FROM pg_settings WHERE name IN ('wal_segment_size','min_wal_size','max_wal_size','wal_keep_size');"
\`\`\`

\`max_wal_size\` is a target for how much WAL accumulates between checkpoints, not a hard limit, and \`wal_keep_size\` is extra retained for replicas. A WAL volume too small for the sum of those is a database that stops accepting writes — which is the failure this feature can cause if it is sized carelessly.`,
      hint: `\`ls -ld\` shows the directory itself rather than its contents, and the first character of the permissions tells you what it is: \`d\` for a directory, \`l\` for a symbolic link.`,
      solution: `kubectl get cluster pg-cluster
kubectl get pvc
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- ls -ld /var/lib/postgresql/data/pgdata/pg_wal
echo /var/lib/postgresql/data/pgdata/pg_wal > /root/wal-path.txt
cat /root/wal-path.txt
kubectl get pod $PRIMARY -o jsonpath='{range .spec.volumes[?(@.persistentVolumeClaim)]}{.name}{" -> "}{.persistentVolumeClaim.claimName}{"\\n"}{end}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT name, setting, unit FROM pg_settings WHERE name IN ('wal_segment_size','min_wal_size','max_wal_size','wal_keep_size');"`,
    },

    {
      id: 'give-it-a-volume',
      title: 'Give the WAL a disk of its own',
      limitSec: 600,
      criteria: [
        'The Cluster asks for a WAL volume',
        'Each instance has a second claim bound for it',
        'And pg_wal inside every data directory is now a link to it',
        'The cluster is healthy with all 3 instances, and the data is intact',
      ],
      brief: `One field — \`spec.walStorage\` — and the operator does the rest: a second claim per instance, a second volume mounted into every Pod, and the data directory rearranged so PostgreSQL writes its log there without knowing anything has changed.

It is a Pod change, so it rolls the cluster. Replicas first, primary last, and the primary is restarted rather than switched over.

Watch what the data directory looks like afterwards, because the mechanism is worth seeing: \`pg_wal\` is not moved as a configuration setting. It becomes a symbolic link, which is how PostgreSQL has always supported putting the log on separate storage.`,
      instructions: `Ask for the volume:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"walStorage":{"size":"1Gi"}}}'
\`\`\`

Watch the roll. This takes about a minute for three instances:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pvc
\`\`\`

Run those a few times. The claims appear almost at once — \`pg-cluster-1-wal\`, \`pg-cluster-2-wal\`, \`pg-cluster-3-wal\` — and the instances are then replaced one at a time to pick them up, with the cluster reporting *Primary instance is being restarted without a switchover* near the end.

When it settles there are six claims:

\`\`\`
kubectl get pvc
kubectl get cluster pg-cluster
\`\`\`

Now look at what happened inside an instance:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- ls -ld /var/lib/postgresql/data/pgdata/pg_wal
\`\`\`

\`pg_wal -> /var/lib/postgresql/wal/pg_wal\`. The directory is now a symbolic link pointing out of the data volume and into the new one. PostgreSQL is writing to the same path it always did; the filesystem is sending those writes somewhere else.

Confirm the Pod really has two volumes now, and that they are separate mounts:

\`\`\`
kubectl get pod $PRIMARY -o jsonpath='{range .spec.volumes[?(@.persistentVolumeClaim)]}{.name}{" -> "}{.persistentVolumeClaim.claimName}{"\\n"}{end}'
kubectl exec $PRIMARY -c postgres -- df -h /var/lib/postgresql/data /var/lib/postgresql/wal
kubectl exec $PRIMARY -c postgres -- ls /var/lib/postgresql/wal/pg_wal | head -3
\`\`\`

Two claims, \`pgdata\` and \`pg-wal\`, mounted at two paths, and the WAL segments are in the second one.

Check every instance, since the roll had to reach all three:

\`\`\`
for i in 1 2 3; do
  printf "pg-cluster-$i: "
  kubectl exec pg-cluster-$i -c postgres -- readlink /var/lib/postgresql/data/pgdata/pg_wal
done
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\`

One more thing worth looking at, because it is a trap in a real cluster:

\`\`\`
kubectl get pvc -o custom-columns=NAME:.metadata.name,CLASS:.spec.storageClassName,SIZE:.spec.resources.requests.storage
\`\`\`

The WAL claims were created on the **default** StorageClass, because \`walStorage\` named none. If your data volumes are on fast storage chosen deliberately and the default class is something else, you have just put the write-ahead log — the thing every commit waits for — on the slower disk. \`walStorage.storageClass\` is the field that avoids it.`,
      hint: `\`readlink\` prints where a symbolic link points and nothing at all when the argument is not a link, which makes it the quickest way to check all three instances in a loop.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"walStorage":{"size":"1Gi"}}}'
sleep 75
kubectl get pvc
kubectl get cluster pg-cluster
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- ls -ld /var/lib/postgresql/data/pgdata/pg_wal
kubectl get pod $PRIMARY -o jsonpath='{range .spec.volumes[?(@.persistentVolumeClaim)]}{.name}{" -> "}{.persistentVolumeClaim.claimName}{"\\n"}{end}'
for i in 1 2 3; do kubectl exec pg-cluster-$i -c postgres -- readlink /var/lib/postgresql/data/pgdata/pg_wal; done
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl get pvc -o custom-columns=NAME:.metadata.name,CLASS:.spec.storageClassName,SIZE:.spec.resources.requests.storage`,
    },

    {
      id: 'one-way-door',
      title: 'Try to take it back',
      limitSec: 480,
      criteria: [
        '/root/walstorage-error.txt records what happened when you tried to remove it',
        'The Cluster still has its WAL volume declared',
        'And all six claims are still bound',
        'The cluster is healthy',
      ],
      brief: `Adding the volume was a patch. Removing it is not.

The operator refuses, at admission, with a message that says exactly what it will not do. That is worth meeting deliberately, because it changes how the decision should be made: a separate WAL volume is not something to try on a production cluster to see whether it helps.

The reasoning behind the refusal is not arbitrary. Undoing it means moving live WAL back into the data directory while the database is running and depending on it — an operation with no safe automatic form. What the operator offers instead is what it offered in the first place: build the cluster the way you want it.`,
      instructions: `Try to remove the field:

\`\`\`
kubectl patch cluster pg-cluster --type=json -p '[{"op":"remove","path":"/spec/walStorage"}]' 2>&1 \\
  | tee /root/walstorage-error.txt
\`\`\`

\`walStorage cannot be disabled once configured\` — from the operator's validating webhook, before anything was stored. Try the other obvious phrasing too, and get the same answer:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"walStorage":null}}' 2>&1 | tail -2
\`\`\`

Confirm nothing moved:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.walStorage}{"\\n"}'
kubectl get pvc
kubectl get cluster pg-cluster
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- readlink /var/lib/postgresql/data/pgdata/pg_wal
\`\`\`

Six claims, the link still in place, the cluster healthy.

What you *can* still change is the size, exactly as for the data volume, provided the StorageClass allows expansion:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.walStorage}{"\\n"}'
\`\`\`

\`resizeInUseVolumes: true\` is there, defaulted in, on the WAL storage as much as on the data storage.

So the shape of the decision is this. A separate WAL volume is worth having when the two write patterns genuinely contend — a busy cluster where checkpoint writes and commit fsyncs are fighting over the same device — and it is worth having on storage chosen for latency rather than capacity. Decide it when the cluster is created, size it for \`max_wal_size\` plus whatever \`wal_keep_size\` and any replication slots will retain, and name the StorageClass explicitly. The one thing you cannot do is change your mind.`,
      hint: `Both patch styles are refused by the same webhook, so either one produces the message the check is looking for — \`tee\` writes it to the file while still showing it to you.`,
      solution: `kubectl patch cluster pg-cluster --type=json -p '[{"op":"remove","path":"/spec/walStorage"}]' 2>&1 | tee /root/walstorage-error.txt
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"walStorage":null}}' 2>&1 | tail -2
kubectl get cluster pg-cluster -o jsonpath='{.spec.walStorage}{"\\n"}'
kubectl get pvc
kubectl get cluster pg-cluster
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- readlink /var/lib/postgresql/data/pgdata/pg_wal`,
    },
  ],
}
