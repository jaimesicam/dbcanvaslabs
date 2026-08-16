// The fencing behaviour, the on-node storage path and every error message below are
// confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md):
// with the instance fenced, overwriting global/pg_control really does leave PostgreSQL
// unable to start, with pg_controldata reporting a CRC mismatch and the instance stuck at
// 0/1 ready. Grading reads the instance's own log for that error.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, the cnpg
// plugin and a client Pod are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgCorruptedPVC = {
  id: 'cnpg-corrupted-pvc',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster whose data directories are real directories on the real nodes you get a shell on, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here. It also means the damage you do is real damage to a real database.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      "A healthy 3-instance Cluster named pg-cluster, reporting \"Cluster in healthy state\", each instance's data directory living on its node's filesystem under the local-path StorageClass",
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      "Nothing is broken yet. Storage does fail, and when it does the damage is on disk where no amount of restarting will help. You will find a replica's data directory on the node that holds it, stop that instance cleanly, destroy its control file, and start it again — then read PostgreSQL's own refusal to open a database it cannot trust, and repair it the only way this can be repaired.",
  },

  tasks: [
    {
      id: 'locate-the-data',
      title: 'Find a real data directory on a real node',
      limitSec: 480,
      criteria: [
        "A row noted 'before-corruption' exists",
        '/root/pgdata-path.txt was written',
        'It names a real PostgreSQL data directory on one of the nodes',
        'The directory belongs to one of the two replicas',
      ],
      brief: `Everything in this lab depends on knowing where an instance's data physically lives, so start there.

The \`local-path\` StorageClass is a directory on a node, and your terminal tabs are root shells on those nodes — so an instance's PostgreSQL data directory is a directory you can list, and later damage, from outside Kubernetes entirely. Find the one belonging to a replica and record its path in \`/root/pgdata-path.txt\`.

Write a row first as well. What you are going to break is a copy of the database, and the point at the end is that the copy can be rebuilt from the ones that are still intact.`,
      instructions: `Write the row whose survival you will check at the end:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE corruption_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO corruption_proof (note) VALUES ('before-corruption') RETURNING *;"
\`\`\`

Now find a replica, the volume behind it, and the node it is on:

\`\`\`
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get pvc
\`\`\`

Switch to the terminal tab for the node your chosen replica runs on — the data is on that node's filesystem and nowhere else. Look at what \`local-path\` created there:

\`\`\`
ls /var/lib/rancher/k3s/storage/
\`\`\`

One directory per claim on this node, named \`<volume>_<namespace>_<instance>\`. Inside it is the PostgreSQL data directory:

\`\`\`
ls /var/lib/rancher/k3s/storage/<volume>_default_pg-cluster-3/pgdata
\`\`\`

That is a real PostgreSQL data directory — \`PG_VERSION\`, \`base\`, \`global\`, \`pg_wal\` and the rest, owned by uid 26, sitting on the node where any process with root could touch it. Record its path:

\`\`\`
echo /var/lib/rancher/k3s/storage/<volume>_default_pg-cluster-3/pgdata > /root/pgdata-path.txt
\`\`\``,
      hint: `The directory only exists on the node where that instance's Pod is running — check the NODE column of \`kubectl get pods -o wide\` and use that node's terminal tab. Record the path ending in \`/pgdata\`, and choose a \`replica\`, not the primary.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE corruption_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO corruption_proof (note) VALUES ('before-corruption') RETURNING *;"
kubectl get pods -o wide -L cnpg.io/instanceRole
ls /var/lib/rancher/k3s/storage/
echo /var/lib/rancher/k3s/storage/$(kubectl get pvc pg-cluster-3 -o jsonpath='{.spec.volumeName}')_default_pg-cluster-3/pgdata > /root/pgdata-path.txt
cat /root/pgdata-path.txt
ls $(cat /root/pgdata-path.txt)`,
    },

    {
      id: 'fence-and-corrupt',
      title: 'Stop the instance and destroy its control file',
      limitSec: 600,
      criteria: [
        'The corrupted instance is not ready',
        'Its log shows PostgreSQL refusing to start on the corrupt control file',
        'The cluster reports 2 of 3 instances ready',
        'The primary is unaffected — pg-cluster-rw still answers',
      ],
      brief: `Now do the damage — but stop PostgreSQL first, and that ordering is the whole trick.

Corrupting the data directory of a *running* instance achieves nothing: PostgreSQL rewrites its control file on a clean shutdown, so the damage is undone the moment the Pod restarts. Fencing solves this. It stops the PostgreSQL process while leaving the Pod in place, so the files sit on disk with nothing running to repair or rewrite them.

With the instance fenced, overwrite \`global/pg_control\` — the small file that records the state of the whole cluster, which PostgreSQL reads before it will open anything. Then unfence and watch it refuse to start. The other two instances carry on untouched.`,
      instructions: `Fence the replica you chose. This stops PostgreSQL inside the Pod without deleting anything:

\`\`\`
kubectl cnpg fencing on pg-cluster pg-cluster-3
\`\`\`

Confirm PostgreSQL is really gone from the Pod — only the instance manager should be left:

\`\`\`
kubectl exec pg-cluster-3 -c postgres -- ps ax
\`\`\`

Now, in the terminal tab for the node holding that data directory, overwrite the control file with random bytes:

\`\`\`
dd if=/dev/urandom of=$(cat /root/pgdata-path.txt)/global/pg_control bs=8192 count=1 conv=notrunc
\`\`\`

The file keeps its size and its permissions; only its contents are now nonsense. Start the instance again:

\`\`\`
kubectl cnpg fencing off pg-cluster pg-cluster-3
\`\`\`

Then watch what happens to it:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

The Pod is \`Running\` but \`0/1\` — the container is up, PostgreSQL inside it is not — and READY drops to 2. Read why, from PostgreSQL itself:

\`\`\`
kubectl logs pg-cluster-3 --tail=200 | grep -iE "pg_control|CRC|FATAL"
\`\`\`

\`pg_controldata: warning: calculated CRC checksum does not match value stored in control file\`, followed by \`FATAL: database files are incompatible with server\` — the control file's checksum does not match its contents, so PostgreSQL will not guess at what the database state might be.

Meanwhile the cluster is still perfectly usable:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT count(*) FROM corruption_proof;"
\`\`\``,
      hint: `Fence **before** corrupting: a running instance rewrites \`pg_control\` when it shuts down, which would quietly undo the damage. The \`dd\` runs on the node's own filesystem, in the terminal tab for the node that holds the directory — not inside a Pod.`,
      solution: `kubectl cnpg fencing on pg-cluster pg-cluster-3
kubectl exec pg-cluster-3 -c postgres -- ps ax
dd if=/dev/urandom of=$(cat /root/pgdata-path.txt)/global/pg_control bs=8192 count=1 conv=notrunc
kubectl cnpg fencing off pg-cluster pg-cluster-3
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl logs pg-cluster-3 --tail=200 | grep -iE "pg_control|CRC|FATAL"`,
    },

    {
      id: 'repair',
      title: 'Repair it the only way corruption can be repaired',
      limitSec: 480,
      criteria: [
        'The instance is on a different volume than the one you corrupted',
        'All 3 instances are ready again',
        'The rebuilt instance is streaming from the primary',
        "The 'before-corruption' row is present on the rebuilt instance",
      ],
      brief: `There is no repairing a corrupt control file, and nothing in the cluster will try. Restarting the Pod will not help: the damage is on disk, and the disk is exactly what a restart reattaches to.

The fix is to stop treating that copy of the database as salvageable. Delete the claim and the Pod, and the operator provisions fresh storage and re-clones the instance from the primary — which is intact, and has been serving the whole time.

That is the shape of every storage-corruption recovery in a replicated database: you do not repair the damaged copy, you discard it and take a new one from a copy you trust.`,
      instructions: `Confirm first that a plain restart is not a fix:

\`\`\`
kubectl delete pod pg-cluster-3 --wait=false
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

It comes back, fails the same way, and this time Kubernetes gives up on restarting it: \`CrashLoopBackOff\`. The corrupted file is still there, because the Pod reattached to the same volume.

So discard the storage. Delete the claim, then the Pod that is holding its deletion open:

\`\`\`
kubectl delete pvc pg-cluster-3 --wait=false
kubectl delete pod pg-cluster-3 --wait=false
\`\`\`

Now watch the operator rebuild it:

\`\`\`
kubectl get pvc
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

A new claim appears, bound to a **different** volume than the one you corrupted, and the instance is re-cloned from the primary over the network. Compare it against what you recorded:

\`\`\`
cat /root/pgdata-path.txt
kubectl get pvc pg-cluster-3 -o jsonpath='{.spec.volumeName}{"\\n"}'
\`\`\`

Different uuid, so this is genuinely new storage — the corrupted directory is gone along with the volume that held it.

Finally, confirm the rebuilt instance is a full member again, with the data:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM corruption_proof;"
\`\`\``,
      hint: `Deleting the Pod alone is not enough — the claim's \`kubernetes.io/pvc-protection\` finalizer holds its deletion until no Pod mounts it, and a Pod that reattaches to the same volume hits the same corrupt file.`,
      solution: `kubectl delete pvc pg-cluster-3 --wait=false
kubectl delete pod pg-cluster-3 --wait=false
kubectl get pvc
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM corruption_proof;"`,
    },
  ],
}
