// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md).
// Declaring one tablespace with `temporary: true` rolled the cluster, reported `reconciled` in
// about 60 seconds, created one PVC per instance, and set `temp_tablespaces` to `scratch` on
// every instance. A temporary table's `reltablespace` reads `scratch`; a sort with
// `work_mem = 64kB` over 300k rows grew `/var/lib/postgresql/tablespaces/scratch` to **99M**
// while it ran — into a `pgsql_tmp` of the tablespace's own — while `base/pgsql_tmp` inside the
// data directory stayed at 4.0K and zero entries, taking the app database's counters from
// `1 / 2734 kB` to `3 / 107 MB`. A read-only sort through the -ro Service spilled
// on the standby that served it — `pg-cluster-2` reported 2 files / 22 MB and `pg-cluster-3`
// nothing — which is per-instance stats and per-instance storage doing exactly what they say.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a client
// Pod are this lab's starting state, built by its own provisioning. No reference to any other
// lab (see CLAUDE.md, "Lab content contract").

export const cnpgTemporaryTablespaces = {
  id: 'cnpg-temporary-tablespaces',
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
      'A healthy 3-instance Cluster named pg-cluster, on k3s\'s own local-path storage, with one 1Gi volume per instance, no tablespaces, and an empty temp_tablespaces setting',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A query that needs more memory than it is allowed writes the difference to disk, and by default that disk is the one holding your database. A sort large enough can therefore fill the data volume and stop the server — which is why PostgreSQL lets you send temporary files somewhere else, and why CloudNativePG makes that a one-word declaration. You will declare a temporary tablespace, watch a query spill into it rather than into the data directory, and then find out what the standbys do with theirs.',
  },

  tasks: [
    {
      id: 'declare-a-temporary-one',
      title: 'Declare a tablespace for temporary files',
      limitSec: 720,
      criteria: [
        'The Cluster declares scratch as a temporary tablespace',
        'It reports reconciled, on a healthy cluster',
        'Every instance has its own volume for it',
        'And temp_tablespaces names it on every instance, not just the primary',
      ],
      brief: `\`spec.tablespaces\` takes a list of names and storage blocks, and one of the fields on each entry is \`temporary\`.

Set it and two things happen. The tablespace is created exactly like any other — a claim per instance, mounted, then \`CREATE TABLESPACE\` — and its name is also written into PostgreSQL's \`temp_tablespaces\` setting, which is the list the server consults whenever it needs somewhere to put a temporary object or a spilled sort.

Attaching a volume means the instances are replaced, so this rolls the cluster. Watch \`status.tablespacesStatus\` for the tablespace's own progress, and check the setting on more than one instance afterwards: every instance runs its own PostgreSQL with its own copy of the configuration.`,
      instructions: `Work in the **k3d-server** tab. See where temporary files go today:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SHOW temp_tablespaces;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\db"
kubectl get pvc
\`\`\`

The setting is empty, which means "the default tablespace" — the same volume as the database itself.

Declare one for them:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"tablespaces": [
    {"name": "scratch", "storage": {"size": "1Gi"}, "temporary": true}
  ]}}'
\`\`\`

Watch it arrive. This takes about a minute, because every instance is replaced to mount the new volume:

\`\`\`
for i in $(seq 1 12); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-cluster -o jsonpath='{.status.phase}|{range .status.tablespacesStatus[*]}{.name}={.state} {end}'
  printf "| temp_tablespaces="
  kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SHOW temp_tablespaces;" 2>/dev/null | tr -d '\\n'
  echo
  sleep 10
done
\`\`\`

The tablespace goes \`pending\` → \`reconciled\` while the cluster rolls, and \`temp_tablespaces\` becomes \`scratch\`.

Check what was created, and that every instance agrees:

\`\`\`
kubectl get pvc | grep scratch
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  printf "%-14s " "$p"
  kubectl exec $p -c postgres -- psql -U postgres -tAc "SHOW temp_tablespaces;"
done
\`\`\`

Three claims and three instances that all know about it. That matters more than it looks: a standby serves read-only queries, those queries spill too, and a standby with nowhere else to put its temporary files would put them on its data volume.`,
      hint: `\`temporary: true\` goes on the tablespace entry itself, next to \`name\` and \`storage\` — there is no separate field elsewhere in the Cluster.`,
      solution: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SHOW temp_tablespaces;"
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"tablespaces":[{"name":"scratch","storage":{"size":"1Gi"},"temporary":true}]}}'
sleep 100
kubectl get cluster pg-cluster -o jsonpath='{.status.phase}|{range .status.tablespacesStatus[*]}{.name}={.state} {end}'; echo
kubectl get pvc | grep scratch
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do printf "%-14s " "$p"; kubectl exec $p -c postgres -- psql -U postgres -tAc "SHOW temp_tablespaces;"; done`,
    },

    {
      id: 'where-temp-objects-go',
      title: 'Make a query spill, and find where it went',
      limitSec: 720,
      criteria: [
        '/root/temp-table.txt shows a temporary table landing in scratch',
        'The primary has written temporary files for the app database',
        'And enough of them that the sort really spilled to disk',
        "While the data directory's own pgsql_tmp stayed empty",
      ],
      brief: `Two kinds of thing follow \`temp_tablespaces\`, and it is worth seeing both.

Temporary *objects* — a \`CREATE TEMP TABLE\` — are relations like any other, so they get a tablespace, and \`pg_class.reltablespace\` records which. That is the easy half to observe, because you can simply ask.

Temporary *files* are what a query writes when it exceeds \`work_mem\`: sort runs, hash batches, materialised results. Nothing in the catalogue records them, so the way to watch is to make a query big enough to spill, look at the directory while it runs, and read the counters in \`pg_stat_database\` afterwards.

Do both against a deliberately tiny \`work_mem\`, and then check the place those files would otherwise have gone.`,
      instructions: `Start with a temporary table, and ask PostgreSQL where it put it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "CREATE TEMP TABLE scratch_demo AS SELECT g, repeat('x',200) AS pad FROM generate_series(1,200000) g;
   SELECT c.relname, t.spcname FROM pg_class c LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
   WHERE c.relname = 'scratch_demo';" | tee /root/temp-table.txt
\`\`\`

\`scratch\`. Both statements have to be in one \`psql\` invocation, because a temporary table belongs to its session and disappears the moment the connection closes.

Now the counters, before you spill anything:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT temp_files, pg_size_pretty(temp_bytes) FROM pg_stat_database WHERE datname = 'app';"
\`\`\`

Run a sort that cannot fit in memory, in the background, and look at the tablespace while it is running:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "SET work_mem='64kB';
   CREATE TEMP TABLE spill AS SELECT g, repeat('y',300) AS pad FROM generate_series(1,300000) g ORDER BY md5(g::text);
   SELECT pg_sleep(25);" &
sleep 12
kubectl exec pg-cluster-1 -c postgres -- du -sh /var/lib/postgresql/tablespaces/scratch
kubectl exec pg-cluster-1 -c postgres -- sh -c \\
  'du -sh /var/lib/postgresql/data/pgdata/base/pgsql_tmp; ls -1 /var/lib/postgresql/data/pgdata/base/pgsql_tmp | wc -l'
kubectl exec pg-cluster-1 -c postgres -- find /var/lib/postgresql/tablespaces/scratch -name pgsql_tmp
wait
\`\`\`

Mid-query the scratch volume holds tens of megabytes — 99M in the run this lab was written from — while \`base/pgsql_tmp\` inside the data directory holds **nothing**: 4.0K and zero entries. That directory is where PostgreSQL would put these files if no temporary tablespace were set, and PostgreSQL makes it at startup either way, so its emptiness is the evidence rather than its absence. The files themselves are in a \`pgsql_tmp\` of the tablespace's own, one level inside the version directory.

Afterwards, the counters and the directory both settle:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT temp_files, pg_size_pretty(temp_bytes) FROM pg_stat_database WHERE datname = 'app';"
kubectl exec pg-cluster-1 -c postgres -- du -sh /var/lib/postgresql/tablespaces/scratch
\`\`\`

\`temp_files\` and \`temp_bytes\` are cumulative — they went from 1 and 2734 kB to 3 and 107 MB — and the directory drops back to almost nothing, because the files are deleted when the query that owned them ends.

Those two counters are the ones to alert on. They tell you a workload is spilling at all, which is usually a \`work_mem\` conversation rather than a storage one — but until you have somewhere else to put the spill, it is also a conversation about the volume your database lives on.`,
      hint: `The \`CREATE TEMP TABLE\` and the query that reads \`pg_class\` must run in the *same* psql invocation, separated by a semicolon — a temporary table does not outlive its session.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TEMP TABLE scratch_demo AS SELECT g, repeat('x',200) AS pad FROM generate_series(1,200000) g; SELECT c.relname, t.spcname FROM pg_class c LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE c.relname = 'scratch_demo';" | tee /root/temp-table.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SET work_mem='64kB'; CREATE TEMP TABLE spill AS SELECT g, repeat('y',300) AS pad FROM generate_series(1,300000) g ORDER BY md5(g::text); SELECT pg_sleep(25);" &
sleep 12
kubectl exec pg-cluster-1 -c postgres -- du -sh /var/lib/postgresql/tablespaces/scratch
wait
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT temp_files, pg_size_pretty(temp_bytes) FROM pg_stat_database WHERE datname = 'app';"`,
    },

    {
      id: 'the-standbys-spill-too',
      title: 'Send a big read to a standby',
      limitSec: 720,
      criteria: [
        "/root/replica-spill.txt records a standby's own temporary-file counters",
        'A standby has written temporary files of its own',
        'Each standby has its own scratch volume to write them to',
        'And the cluster is healthy throughout',
      ],
      brief: `Read-only queries spill exactly like writes do. A reporting query pointed at a standby to keep it off the primary still needs somewhere to put its sort runs, and a standby cannot borrow the primary's disk.

That is the reason a temporary tablespace is created on every instance rather than only where the writes happen. Send a large sort through the read-only Service and then read the counters *on each instance separately* — \`pg_stat_database\` is per-instance and is not replicated, so the numbers themselves tell you which standby served the query.

The result is a small, useful piece of operational knowledge: the temporary storage you provision has to be sized for the queries each instance might serve, not for the ones the primary serves.`,
      instructions: `The read-only Service load-balances across the standbys. Run a sort through it, in the background, and watch both standbys while it runs:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-ro -c \\
  "SET work_mem='64kB';
   SELECT count(*) FROM (SELECT g, md5(g::text) FROM generate_series(1,400000) g ORDER BY md5(g::text)) s;
   SELECT pg_sleep(15);" &
sleep 8
kubectl exec pg-cluster-2 -c postgres -- du -sh /var/lib/postgresql/tablespaces/scratch
kubectl exec pg-cluster-3 -c postgres -- du -sh /var/lib/postgresql/tablespaces/scratch
wait
\`\`\`

Now find out which one did the work, and record it:

\`\`\`
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  printf "%-14s " "$p"
  kubectl exec $p -c postgres -- psql -U postgres -tAc \\
    "SELECT 'in_recovery=' || pg_is_in_recovery() || ' temp_files=' || temp_files || ' temp_bytes=' || pg_size_pretty(temp_bytes) FROM pg_stat_database WHERE datname = 'app';"
done | tee /root/replica-spill.txt
\`\`\`

One standby has temporary files and the other has none — 2 files and 22 MB against nothing, in the run this lab was written from. The Service chose one connection's worth of traffic, and only that instance did any work.

Two things follow from that output. \`pg_is_in_recovery()\` is true on the instance that spilled, so the files were written by a server that cannot write to the database at all — temporary files are not part of the database and are never replicated. And the counters differ between instances because statistics are local: there is no cluster-wide view of this, so monitoring has to scrape every instance.

Confirm the cluster is exactly as healthy as it was:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pvc | grep scratch
\`\`\`

So a temporary tablespace is one declaration that provisions storage on every instance, and every instance uses its own. Size it for the largest query any single instance might serve, and remember that unlike the database volume, nothing in it is worth backing up — it is scratch space by definition, and it is empty again the moment the query ends.`,
      hint: `Use \`pg-cluster-ro\`, not \`pg-cluster-rw\` — the read-only Service is the one that routes to standbys. Then read \`pg_stat_database\` on each instance separately.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-ro -c "SET work_mem='64kB'; SELECT count(*) FROM (SELECT g, md5(g::text) FROM generate_series(1,400000) g ORDER BY md5(g::text)) s; SELECT pg_sleep(15);" &
sleep 8
kubectl exec pg-cluster-2 -c postgres -- du -sh /var/lib/postgresql/tablespaces/scratch
wait
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do printf "%-14s " "$p"; kubectl exec $p -c postgres -- psql -U postgres -tAc "SELECT 'in_recovery=' || pg_is_in_recovery() || ' temp_files=' || temp_files || ' temp_bytes=' || pg_size_pretty(temp_bytes) FROM pg_stat_database WHERE datname = 'app';"; done | tee /root/replica-spill.txt
kubectl get cluster pg-cluster`,
    },
  ],
}
