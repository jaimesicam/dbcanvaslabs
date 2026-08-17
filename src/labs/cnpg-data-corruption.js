// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md):
// overwriting 256 bytes inside one 8KB block of a table's file leaves the instance running and
// the cluster reporting "Cluster in healthy state" with 3/3 ready, while `pg_checksums --check`
// on the stopped instance reports `block 3: calculated checksum C058 but block contains BDD5`
// and `Bad checksums: 1`. A read of that table then fails with `ERROR: invalid page in block 3
// of relation "base/16385/16390"`, pg_stat_database.checksum_failures climbs — only when
// something reads the block — and the other two instances return all 2000 rows, because
// physical replication ships WAL records, not pages. `kubectl cnpg promote` moved the writes in
// well under a minute; `kubectl cnpg destroy` left the claim Terminating until the Pod the
// operator had already recreated was deleted, after which the instance came back on a new
// volume with the data intact.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster with a seeded
// table, the cnpg plugin and a client Pod are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgDataCorruption = {
  id: 'cnpg-data-corruption',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster whose data files are real files on the real nodes you get a shell on, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes — and it means the damage you are about to do is real damage to a real database.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster with data checksums enabled, each instance on a local-path volume that is an ordinary directory on the node holding it',
      'A table called ledger in the application database, owned by the app user, holding 2000 rows — written, read once and checkpointed while this environment was built, so every page is settled on disk',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Storage lies. A disk that returns the wrong bytes without saying so is the failure mode that page checksums exist to catch, and catching it is not the same as noticing it — nothing in Kubernetes, and nothing in the operator, scans your data for damage. You will corrupt a single 8KB page inside a real table on the instance that is taking writes, watch the whole cluster continue to report itself perfectly healthy, find the damage with the tool that looks for it, and then recover the only way corruption can be recovered from.',
  },

  tasks: [
    {
      id: 'find-the-page',
      title: 'Find the page you are going to destroy',
      limitSec: 480,
      criteria: [
        'Data checksums are on',
        'All 3 instances return every row of the ledger table',
        '/root/ledger-path.txt was written',
        'It names the file the table lives in',
      ],
      brief: `A PostgreSQL table is a file, split into 8KB pages, and with data checksums enabled every page carries a checksum of its own contents. When a page is read, the checksum is recomputed and compared; a mismatch means the bytes on disk are not the bytes that were written, and PostgreSQL refuses the page rather than handing you a plausible-looking answer built out of garbage.

That protection costs a little CPU and, more importantly, it only applies **when something reads the page**. Nothing walks your files looking for damage. This is the whole reason corruption gets discovered months late, by a query nobody had run before.

Start by establishing what is true now: checksums are on, all three instances agree on the contents of the ledger table, and the table lives in a file whose path you can name. Record that path — it is the string that appears in the error message later, and it is what you will overwrite.`,
      instructions: `Work in the **k3d-server** tab. Find the instance taking writes:

\`\`\`
kubectl get cluster pg-cluster
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
echo "primary: $PRIMARY"
\`\`\`

Confirm the protection is switched on, and that it will not be quietly ignored:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT name, setting FROM pg_settings WHERE name IN ('data_checksums','ignore_checksum_failure');"
\`\`\`

\`data_checksums\` is \`on\` — it was chosen when the database was created and cannot be changed on a running one. \`ignore_checksum_failure\` is \`off\`, which is the setting that decides whether a bad page is an error or a warning. Leave it alone.

Now the data, on every instance, so there is no argument later about what was there:

\`\`\`
for i in 1 2 3; do
  printf "pg-cluster-$i: "
  kubectl exec pg-cluster-$i -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM ledger;"
done
\`\`\`

Two thousand rows, three times. Ask PostgreSQL which file that table is:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -tAc "SELECT pg_relation_filepath('ledger');" \\
  > /root/ledger-path.txt
cat /root/ledger-path.txt
\`\`\`

A path like \`base/16385/16428\` — the database's directory, then the table's file, both named by object id rather than by anything human. Now work out where that file is on a node:

\`\`\`
VOL=$(kubectl get pvc $PRIMARY -o jsonpath='{.spec.volumeName}')
NODE=$(kubectl get pvc $PRIMARY -o jsonpath='{.metadata.annotations.volume\\.kubernetes\\.io/selected-node}')
echo "node:  $NODE"
echo "file:  /var/lib/rancher/k3s/storage/\${VOL}_default_\${PRIMARY}/pgdata/$(cat /root/ledger-path.txt)"
\`\`\`

Copy both of those lines somewhere — the next objective needs them from a different terminal tab, where these variables will not exist.

The node name is the real container name, and the tab names are shorter: the one ending \`-server-0\` is **k3d-server**, \`-agent-0\` is **k3d-agent-1** and \`-agent-1\` is **k3d-agent-2**. Have a look at the file before you damage it:

\`\`\`
kubectl exec $PRIMARY -c postgres -- ls -l /var/lib/postgresql/data/pgdata/$(cat /root/ledger-path.txt)
\`\`\`

Ninety thousand bytes or so — eleven 8KB pages and a bit. You are going to ruin one of them.`,
      hint: `\`pg_relation_filepath\` must be run inside the database that holds the table, which is \`app\` — hence \`-d app\`. The path it returns is relative to the data directory, \`/var/lib/postgresql/data/pgdata\` inside the Pod.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT name, setting FROM pg_settings WHERE name IN ('data_checksums','ignore_checksum_failure');"
for i in 1 2 3; do kubectl exec pg-cluster-$i -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM ledger;"; done
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -tAc "SELECT pg_relation_filepath('ledger');" > /root/ledger-path.txt
cat /root/ledger-path.txt
VOL=$(kubectl get pvc $PRIMARY -o jsonpath='{.spec.volumeName}')
NODE=$(kubectl get pvc $PRIMARY -o jsonpath='{.metadata.annotations.volume\\.kubernetes\\.io/selected-node}')
echo "node:  $NODE"
echo "file:  /var/lib/rancher/k3s/storage/\${VOL}_default_\${PRIMARY}/pgdata/$(cat /root/ledger-path.txt)"`,
    },

    {
      id: 'corrupt-and-count',
      title: 'Damage one page, and watch nobody notice',
      limitSec: 720,
      criteria: [
        'The instance you damaged cannot read the block',
        'Its checksum failure counter has recorded it',
        'The cluster still reports healthy — nothing else noticed',
        'The other two instances still return every row',
      ],
      brief: `Stop PostgreSQL first. Not because the file cannot be written while it is running — it can — but because a page already in shared memory would be served from there, and a clean shutdown followed by a clean start is what guarantees the page is read back from the disk you damaged.

Fencing is how you stop an instance without losing the Pod: PostgreSQL exits, the container keeps running, and nothing is rescheduled or rebuilt. With it stopped, overwrite 256 bytes in the middle of one page, and then run the one tool that goes looking for this kind of damage on purpose — \`pg_checksums\`, which can only run against a stopped server, and which will name the exact block and both checksums.

Then start it again and take stock. The instance is Ready, the cluster says healthy, the operator is content, and one query is an error. That gap is the entire point of the objective.`,
      instructions: `In the **k3d-server** tab, stop the instance you are about to damage:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl cnpg fencing on pg-cluster $PRIMARY
sleep 40
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster pg-cluster
\`\`\`

Give it half a minute or so: that Pod goes \`0/1\` while still Running: the container is up, PostgreSQL inside it is not. Note that the cluster keeps calling itself healthy while its writable instance is stopped, which is worth remembering the next time a dashboard is reassuring.

Now switch to the terminal tab for the node you noted, and overwrite part of the file. \`seek\` is where to start writing in bytes: 8192 bytes per page, so 3 × 8192 + 100 lands 100 bytes into page 3, well past the page header and into the rows themselves:

\`\`\`
F=<the file path you copied in the previous objective>
ls -l $F
dd if=/dev/urandom of=$F bs=1 seek=24676 count=256 conv=notrunc
ls -l $F
\`\`\`

Same size, different contents. Nothing anywhere has been told.

Back in the **k3d-server** tab, go looking for the damage with the tool built for it. It refuses to run against a live server, which is exactly why the instance is fenced:

\`\`\`
kubectl exec $PRIMARY -c postgres -- pg_checksums --check -D /var/lib/postgresql/data/pgdata
\`\`\`

It scans every block of every file and reports the one that does not match, with the checksum it calculated and the checksum the block claims — then ends with **Bad checksums: 1**. That is what a real verification pass looks like, and it is the only thing in this environment that would have found the damage without being asked for that specific table.

Start PostgreSQL again:

\`\`\`
kubectl cnpg fencing off pg-cluster $PRIMARY
sleep 35
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster pg-cluster
\`\`\`

Ready, healthy, 3 of 3. Now read the table:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM ledger;"
\`\`\`

\`ERROR: invalid page in block 3 of relation "base/16385/16428"\` — the file you recorded in the previous objective, and the page you overwrote. PostgreSQL will not guess.

Look at what the database recorded about it:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT datname, checksum_failures, checksum_last_failure FROM pg_stat_database WHERE datname='app';"
\`\`\`

The counter is 1, and it became 1 when you ran the query — not when the damage happened. It is a record of reads that failed, not of pages that are broken, and it is the number worth alerting on precisely because nothing else will tell you.

Finally, the good news:

\`\`\`
for i in 1 2 3; do
  printf "pg-cluster-$i: "
  kubectl exec pg-cluster-$i -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM ledger;" 2>&1 | head -1
done
\`\`\`

The other two instances return all 2000 rows. Physical replication ships **WAL records**, not pages, so damage that happens on one instance's disk is not copied anywhere. Every replica is an independent copy of the same history, which is why one of them can now save you.`,
      hint: `The \`dd\` command must run in the terminal tab for the node holding that instance's volume — the file does not exist on the other two. If \`dd\` reports "No such file or directory", check the path against the one you printed, including the \`_default_\` in the middle.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl cnpg fencing on pg-cluster $PRIMARY
sleep 40
# in the tab for the node holding that instance's volume:
#   dd if=/dev/urandom of=<file> bs=1 seek=24676 count=256 conv=notrunc
kubectl exec $PRIMARY -c postgres -- pg_checksums --check -D /var/lib/postgresql/data/pgdata
kubectl cnpg fencing off pg-cluster $PRIMARY
sleep 35
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM ledger;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT datname, checksum_failures, checksum_last_failure FROM pg_stat_database WHERE datname='app';"
for i in 1 2 3; do kubectl exec pg-cluster-$i -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM ledger;" 2>&1 | head -1; done`,
    },

    {
      id: 'discard-the-copy',
      title: 'Recover from a copy you trust',
      limitSec: 720,
      criteria: [
        'A different instance is primary now',
        'The damaged instance is on a different volume',
        'All 3 instances are ready and the cluster is healthy',
        'Every row is back, on all three instances',
      ],
      brief: `There is no command that repairs a corrupt page. There are ways to read past one and lose the rows it held, which is what you are reduced to when the damaged copy is the only copy — and this is not that situation.

You have two intact copies, so the recovery is to stop trusting the damaged one. Do it in the right order. First move the writes: while that instance is the primary, everything new is being written to the disk you have just proved is not telling the truth. Then throw its storage away and let the operator build the instance again from a copy that is good.

The order matters more than the commands. And note what you are *not* doing: you are not trying to work out which other blocks on that disk might also be wrong. \`pg_checksums\` told you about the blocks it scanned, at the moment it scanned them; a disk that returned wrong bytes once has no credit left.`,
      instructions: `Move the writes off the damaged instance. Pick either of the healthy ones:

\`\`\`
DAMAGED=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
echo "damaged: $DAMAGED"
kubectl get pvc $DAMAGED -o jsonpath='{.spec.volumeName}{"\\n"}'
kubectl cnpg promote pg-cluster pg-cluster-3
\`\`\`

(If \`pg-cluster-3\` is the damaged one, promote \`pg-cluster-2\` instead.) Watch it happen:

\`\`\`
sleep 30
kubectl get cluster pg-cluster
\`\`\`

A planned switchover: the old primary shuts down cleanly, a healthy instance is promoted, and the read-write Service follows within seconds. Writes are now going to a disk you have no reason to doubt.

Now discard the damaged copy. The plugin has one command for it:

\`\`\`
kubectl cnpg destroy pg-cluster ${'${DAMAGED##*-}'}
kubectl get pvc
\`\`\`

That deletes the instance **and** asks for its claim to go with it. Look at the claim: it is very likely still there, with a deletion timestamp on it, because the operator has already recreated the Pod and a claim cannot be deleted while a Pod mounts it. Let go of it:

\`\`\`
kubectl delete pod $DAMAGED --wait=false
\`\`\`

Now watch the instance be built again from scratch — new claim, new volume, a fresh copy taken from the current primary over the network:

\`\`\`
sleep 60
kubectl get pvc
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Compare the volume behind the rebuilt instance with the one you printed a minute ago: a different uuid, so this is genuinely different storage and the damaged bytes are gone with the directory that held them.

Confirm the database is whole:

\`\`\`
for i in 1 2 3; do
  printf "pg-cluster-$i: "
  kubectl exec pg-cluster-$i -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM ledger;"
done
kubectl exec $DAMAGED -c postgres -- psql -U postgres -c \\
  "SELECT datname, checksum_failures FROM pg_stat_database WHERE datname='app';"
\`\`\`

Two thousand rows on all three, and the rebuilt instance's failure counter is back to zero — a new counter on a new copy, which is the only honest way to get one.

Worth being clear about the boundary of what just saved you. Replication protects against a disk that damages what it stores; it does not protect against a statement that deletes the wrong rows, because that is faithfully replicated to every copy within milliseconds. Damage from below is survived with a replica. Damage from above is survived with a backup you can restore to a moment before it happened, and nothing else.`,
      hint: `\`kubectl cnpg destroy\` takes the cluster name and the instance *number*, not the full Pod name — \`kubectl cnpg destroy pg-cluster 1\`. If the rebuilt instance comes up on the same volume, the claim was never released: delete the Pod once more so the deletion can complete.`,
      solution: `DAMAGED=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl get pvc $DAMAGED -o jsonpath='{.spec.volumeName}{"\\n"}'
kubectl cnpg promote pg-cluster pg-cluster-3
sleep 30
kubectl cnpg destroy pg-cluster ${'${DAMAGED##*-}'}
kubectl delete pod $DAMAGED --wait=false
sleep 60
kubectl get pvc
kubectl get cluster pg-cluster
for i in 1 2 3; do kubectl exec pg-cluster-$i -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM ledger;"; done`,
    },
  ],
}
