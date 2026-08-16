// The maxParallel setting, and the fact that it makes a measurable difference to recovery
// time, are confirmed live against a real K3D + CloudNativePG + SeaweedFS deploy (server/,
// see LABORATORY.md): over archives of ~106-125 segments, three sequential restores took 81,
// 72 and 91 seconds and three with maxParallel: 8 took 61, 56 and 60. The lab has the learner
// take their own pair of measurements rather than quoting those, because the numbers depend
// on the machine.
//
// Self-contained, like every lab here: the operator, the Barman Cloud plugin, a cluster
// archiving WAL, a base backup and a deliberately large WAL archive are this lab's starting
// state, built by its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab
// content contract").

export const cnpgWALRestore = {
  id: 'cnpg-wal-restore',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real S3-compatible object store, a real PostgreSQL cluster archiving to it, and a deliberately large WAL archive to recover from. All of it is thrown away when you finish. Nothing is simulated, which is why this is the longest build of the set: on top of the backup stack, the environment writes several hundred megabytes of real data so that replaying its WAL takes long enough to measure.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage), published inside the cluster as the Service seaweedfs on port 8333, with a cnpg-backups bucket',
      'The CloudNativePG v1.30.0 operator, cert-manager v1.19.1 and the Barman Cloud plugin v0.14.0, all installed and Running',
      'A healthy 3-instance Cluster named pg-cluster archiving WAL through the plugin, an ObjectStore named seaweedfs-store with gzip compression and no maxParallel setting, and a completed base backup',
      'A table named bulk holding 720,000 rows, written after that base backup — which is what filled the archive with roughly a hundred WAL segments for a recovery to replay',
      'The cnpg kubectl plugin v1.30.0 on all three nodes, a psql-client Pod with the app credentials, and two identical recovery manifests staged at /root/restore-sequential.yaml and /root/restore-parallel.yaml',
    ],
    yourJob:
      'Recovery replays the WAL archive one segment at a time unless it is told otherwise, and with a hundred segments to fetch that is a lot of round trips spent waiting. You will time a recovery as it is, switch on parallel WAL prefetching, time an identical recovery again, and compare the two — then confirm the faster one produced exactly the same database.',
  },

  tasks: [
    {
      id: 'survey-the-archive',
      title: 'Measure what a recovery has to replay',
      limitSec: 420,
      criteria: [
        'The archive holds a substantial run of WAL segments',
        'The ObjectStore does not set maxParallel yet — restores fetch WAL one segment at a time',
        '/root/wal-count.txt was written',
        'It records a plausible count of the archive',
      ],
      brief: `Before timing anything, find out how much work a recovery here actually is.

A base backup restores in one go; the WAL archive is replayed segment by segment, and each segment is a separate fetch from the object store. The number of segments is therefore the thing that decides whether recovery is quick or slow — and this environment has deliberately made a lot of them.

Count them and record the number in \`/root/wal-count.txt\`. Then look at how the ObjectStore is configured: no \`maxParallel\`, which means one fetch at a time, each waiting for the last.`,
      instructions: `Ask the cluster what it has archived so far:

\`\`\`
kubectl cnpg status pg-cluster | grep -iE "archiv|recover"
\`\`\`

Then count the segments in the bucket itself, through the plugin's own view of the archive:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM bulk;"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT archived_count FROM pg_stat_archiver;"
\`\`\`

\`pg_stat_archiver.archived_count\` is PostgreSQL's own tally of segments shipped since the cluster started — which for this cluster is the size of the archive a recovery would replay. Record it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT archived_count FROM pg_stat_archiver;" > /root/wal-count.txt
cat /root/wal-count.txt
\`\`\`

Now look at how those segments will be fetched during a recovery:

\`\`\`
kubectl get objectstore seaweedfs-store -o jsonpath='{.spec.configuration.wal}{"\\n"}'
\`\`\`

Compression is set; \`maxParallel\` is not. Without it, recovery asks for one segment, waits for it, replays it, and asks for the next — which is the behaviour you are about to time.`,
      hint: `\`pg_stat_archiver\` is readable by the app user through the Service. The count only grows, so recording it slightly before you check is fine.`,
      solution: `kubectl cnpg status pg-cluster | grep -iE "archiv|recover"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM bulk;"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT archived_count FROM pg_stat_archiver;" > /root/wal-count.txt
cat /root/wal-count.txt
kubectl get objectstore seaweedfs-store -o jsonpath='{.spec.configuration.wal}{"\\n"}'`,
    },

    {
      id: 'time-sequential',
      title: 'Time a recovery as it is',
      limitSec: 600,
      criteria: [
        'The sequential restore completed and reports healthy',
        'It ran with maxParallel unset — one segment fetched at a time',
        '/root/sequential-seconds.txt was written',
        'It records how long that restore took',
      ],
      brief: `Take the baseline measurement: recover a cluster with the archive configured exactly as it is now, and time how long it takes to come up.

Run the apply and the timing loop as one block so the clock starts with the request. What you are measuring is the whole recovery — fetching the base backup, then replaying every segment in the archive one at a time — which is the number the next objective has to beat.

Nothing about the source cluster is touched. This is a second cluster built from the bucket.`,
      instructions: `Look at the manifest, which is an ordinary recovery from the object store:

\`\`\`
cat /root/restore-sequential.yaml
\`\`\`

Now run it and time it, in one block:

\`\`\`
START=$(date +%s)
kubectl apply -f /root/restore-sequential.yaml
while true; do
  P=$(kubectl get cluster.postgresql.cnpg.io pg-seq -o jsonpath='{.status.phase}' 2>/dev/null)
  [ "$P" = "Cluster in healthy state" ] && break
  sleep 5
done
echo $(( $(date +%s) - START )) > /root/sequential-seconds.txt
cat /root/sequential-seconds.txt
\`\`\`

Most of that time is not PostgreSQL starting up — it is the recovery fetching segments from the object store, one request at a time, with the replay waiting on each.

Confirm what you got:

\`\`\`
kubectl get cluster.postgresql.cnpg.io
kubectl exec pg-seq-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM bulk;"
\`\`\``,
      hint: `Run the block as a whole rather than piecemeal — the clock has to start at the apply. If the loop seems stuck, watch \`kubectl get cluster.postgresql.cnpg.io\` from another tab; a recovery Job runs first and the instance Pod only starts afterwards.`,
      solution: `cat /root/restore-sequential.yaml
START=$(date +%s)
kubectl apply -f /root/restore-sequential.yaml
while true; do
  P=$(kubectl get cluster.postgresql.cnpg.io pg-seq -o jsonpath='{.status.phase}' 2>/dev/null)
  [ "$P" = "Cluster in healthy state" ] && break
  sleep 5
done
echo $(( $(date +%s) - START )) > /root/sequential-seconds.txt
cat /root/sequential-seconds.txt`,
    },

    {
      id: 'time-parallel',
      title: 'Switch on parallel prefetching and time it again',
      limitSec: 600,
      criteria: [
        'The ObjectStore now sets maxParallel, so WAL is prefetched in parallel',
        'The parallel restore completed and reports healthy',
        '/root/parallel-seconds.txt was written',
        'It is shorter than the sequential run you timed',
      ],
      brief: `Now change one thing. Set \`maxParallel\` on the ObjectStore's WAL configuration, so that instead of fetching one segment and waiting, the plugin fetches several ahead of the replay.

Then run an identical recovery — the same manifest shape, the same archive, the same base backup — and time it the same way. The only difference between the two runs is that setting.

Expect a clear reduction, not a small one. How large depends on the machine and how far the object store is; on a busy host the gap narrows, which is worth knowing before quoting a figure to anyone.`,
      instructions: `Set the prefetch depth on the ObjectStore:

\`\`\`
kubectl patch objectstore.barmancloud.cnpg.io seaweedfs-store --type=merge \\
  -p '{"spec":{"configuration":{"wal":{"maxParallel":8}}}}'
kubectl get objectstore seaweedfs-store -o jsonpath='{.spec.configuration.wal}{"\\n"}'
\`\`\`

Both \`compression\` and \`maxParallel\` now. This is a property of the *archive*, not of any one cluster — anything recovering from this store picks it up.

Run the second recovery and time it identically:

\`\`\`
START=$(date +%s)
kubectl apply -f /root/restore-parallel.yaml
while true; do
  P=$(kubectl get cluster.postgresql.cnpg.io pg-par -o jsonpath='{.status.phase}' 2>/dev/null)
  [ "$P" = "Cluster in healthy state" ] && break
  sleep 5
done
echo $(( $(date +%s) - START )) > /root/parallel-seconds.txt
\`\`\`

Compare them:

\`\`\`
echo "sequential: $(cat /root/sequential-seconds.txt)s   parallel: $(cat /root/parallel-seconds.txt)s"
\`\`\`

The saving comes from removing round trips, not from doing less work: the same segments are fetched and the same records replayed, but several fetches are in flight at once instead of one.`,
      hint: `If the parallel run is not faster, the host was probably busy with the first restore's cluster still starting up — delete \`pg-par\`, wait for the cluster list to settle, and time it again. A comparison run while something else is churning measures the machine, not the setting.`,
      solution: `kubectl patch objectstore.barmancloud.cnpg.io seaweedfs-store --type=merge -p '{"spec":{"configuration":{"wal":{"maxParallel":8}}}}'
kubectl get objectstore seaweedfs-store -o jsonpath='{.spec.configuration.wal}{"\\n"}'
START=$(date +%s)
kubectl apply -f /root/restore-parallel.yaml
while true; do
  P=$(kubectl get cluster.postgresql.cnpg.io pg-par -o jsonpath='{.status.phase}' 2>/dev/null)
  [ "$P" = "Cluster in healthy state" ] && break
  sleep 5
done
echo $(( $(date +%s) - START )) > /root/parallel-seconds.txt
echo "sequential: $(cat /root/sequential-seconds.txt)s   parallel: $(cat /root/parallel-seconds.txt)s"`,
    },

    {
      id: 'verify-both',
      title: 'Confirm the faster one is not the poorer one',
      limitSec: 420,
      criteria: [
        'The sequentially restored cluster holds every row the source does',
        'So does the one restored with parallel WAL fetching',
        'The two restores produced identical databases — parallelism changed the speed, not the result',
      ],
      brief: `A faster recovery is only worth having if it recovers the same database, so check both.

Count the rows in the source and in each restored cluster. All three numbers should match: the same base backup, the same archive, the same replay — reordered fetches, identical result.

That is the reassuring property of this setting. \`maxParallel\` changes how many segments are in flight, never which records are applied or in what order they are replayed.`,
      instructions: `Count the rows in all three databases:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM bulk;"
kubectl exec pg-seq-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM bulk;"
kubectl exec pg-par-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM bulk;"
\`\`\`

The same number three times. Look at what you have running now:

\`\`\`
kubectl get cluster.postgresql.cnpg.io
\`\`\`

The source and two independent recoveries of it, one of which was materially quicker to build for a one-line configuration change on the archive.

Worth keeping in proportion: this matters in exact proportion to how much WAL there is to replay. A cluster backed up frequently has little to replay and will barely notice; one recovering across days of archive, or from an object store on the other side of a network, is where the round trips dominate and where prefetching earns its place.`,
      hint: `Read each restored cluster from its own Pod — each cluster generates its own app credentials, so the \`psql-client\` Pod can only reach the source.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM bulk;"
kubectl exec pg-seq-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM bulk;"
kubectl exec pg-par-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM bulk;"
kubectl get cluster.postgresql.cnpg.io`,
    },
  ],
}
