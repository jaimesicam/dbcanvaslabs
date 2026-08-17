// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). A
// 3-instance PostgreSQL 17.11 cluster was upgraded to 18.4 by editing `spec.imageName` alone.
// The phase read `Upgrading Postgres major version` while a Job called
// `pg-cluster-1-major-upgrade` ran for ~31s. Its Pod is three containers: init
// `bootstrap-controller` (the operator image), init `prepare` (the **17** image, which copies
// /usr/lib/postgresql/17/{bin,lib} and /usr/share/postgresql/17 into /controller/old and writes a
// bindir.txt), and main `major-upgrade` (the **18** image). Both replicas were then rebuilt from
// scratch with `pg-cluster-N-join` Jobs. Healthy again in about two minutes with all 50 rows.
// `status.pgDataImageInfo` moved from `{image: …17-system-trixie, majorVersion: 17}` to
// `{…18.4-system-trixie, majorVersion: 18}`, and the primary kept its PVC (age 7m10s) while the
// replicas got new ones (3m17s and 2m39s).
//
// Three findings shape the objectives. Going back is refused at admission: `spec.imageName:
// Invalid value: "17": can't downgrade from major 18 to 17`. Optimizer statistics do not survive —
// `reltuples` read `-1` and `pg_stats` held nothing for the table until ANALYZE, after which
// reltuples was 50 and two columns had statistics. And the upgraded cluster reports
// `data_checksums off` while a cluster freshly bootstrapped from the same 18 image reports `on`,
// because pg_upgrade carries PostgreSQL 17's initdb decisions forward rather than adopting 18's.
//
// Self-contained, like every lab here: the operator, a 3-instance cluster on PostgreSQL 17, a
// seeded table and a client Pod are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgMajorUpgrade = {
  id: 'cnpg-major-upgrade',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: two PostgreSQL major versions are pre-loaded into every node before three instances are bootstrapped one at a time.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster running PostgreSQL 17 (the ghcr.io/cloudnative-pg/postgresql:17-system-trixie image, which resolves to 17.11), with a table called notes holding 50 rows',
      'The PostgreSQL 18 image (18.4-system-trixie) already pulled into all three nodes, so the upgrade is not waiting on a download',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A minor upgrade is a restart on a new binary; a major upgrade rewrites the catalogue, and PostgreSQL has a separate program for it. CloudNativePG makes that program a consequence of editing one field: change the image to a new major and the operator stops the database, runs pg_upgrade against the same data directory, and rebuilds the replicas from the upgraded primary. You will do it, watch what the operator does while it happens, and then find the three things the upgrade leaves you to deal with afterwards.',
  },

  tasks: [
    {
      id: 'change-the-image',
      title: 'Change one field and watch a pg_upgrade happen',
      limitSec: 900,
      criteria: [
        'The primary really is running PostgreSQL 18 now',
        'And the operator records the data directory as major 18',
        '/root/upgrade-job.txt shows the upgrade job carrying both PostgreSQL versions',
        'The 50 rows came across, on a healthy 3-instance cluster',
      ],
      brief: `The interface for a major upgrade is \`spec.imageName\`, exactly as it is for a minor one. What makes it a different operation is the operator noticing that the major version has changed — it keeps the image that last ran on the data directory in \`status.pgDataImageInfo\`, and compares.

When they differ it does not roll the cluster. It stops the database, and runs a Job named \`<primary>-major-upgrade\` that calls \`pg_upgrade\` against the existing data directory in place.

That Job is the thing to catch while it exists, because it answers the obvious question: \`pg_upgrade\` needs the *old* binaries as well as the new ones, and the new image only carries PostgreSQL 18. Look at what the Pod is made of — its containers and its log — and you will see how the operator arranges that.

The phase says so too, while it runs: **Upgrading Postgres major version**.

Afterwards the replicas are useless — their data directories are still the old major — so the operator throws them away and clones them again from the upgraded primary.`,
      instructions: `Work in the **k3d-server** tab. Establish where you are starting:

\`\`\`
kubectl get cluster pg-cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT version();"
kubectl get cluster pg-cluster -o jsonpath='{.status.image}|{.status.pgDataImageInfo}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl get pvc
\`\`\`

PostgreSQL 17.11, three instances, 50 rows, and one volume each. Note \`pgDataImageInfo\`: the operator is recording which image last ran on this data directory, and its \`majorVersion\` is 17.

Now start a loop that will catch the upgrade Job, because it is deleted as soon as it succeeds:

\`\`\`
( for i in $(seq 1 60); do
    if kubectl get job pg-cluster-1-major-upgrade >/dev/null 2>&1; then
      kubectl get job pg-cluster-1-major-upgrade \\
        -o jsonpath='{range .spec.template.spec.initContainers[*]}INIT {.name} {.image}{"\\n"}{end}{range .spec.template.spec.containers[*]}MAIN {.name} {.image}{"\\n"}{end}' \\
        | tee /root/upgrade-job.txt
      kubectl logs job/pg-cluster-1-major-upgrade --all-containers 2>/dev/null | tail -12 >> /root/upgrade-job.txt
      break
    fi
    sleep 2
  done ) &
\`\`\`

Then change the image:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}}'
\`\`\`

And watch the whole thing. This takes about two minutes:

\`\`\`
for i in $(seq 1 18); do
  printf "%s | " "$(date +%T)"
  kubectl get cluster pg-cluster --no-headers
  kubectl get pods --no-headers | grep -v psql-client
  echo
  sleep 8
done
\`\`\`

The sequence is worth reading rather than skimming. All three instance Pods go away and the phase becomes *Upgrading Postgres major version*. A \`pg-cluster-1-major-upgrade-…\` Pod appears, runs for about thirty seconds and reports Completed. The primary comes back — a new Pod, on the new image, on the same volume. Then \`pg-cluster-2-join-…\` and \`pg-cluster-3-join-…\` Jobs run one after the other, the same Jobs that build a brand-new replica, while the cluster reports *Creating a new replica*. Then healthy again, about two minutes after the patch.

Read what you caught:

\`\`\`
cat /root/upgrade-job.txt
\`\`\`

Three containers, and the middle one is the answer. An init container called \`prepare\` runs the **old** image and copies PostgreSQL 17's installation aside — the log lines say it: *Copying the PostgreSQL installation to the destination /controller/old*, then \`/usr/lib/postgresql/17/bin\`, \`/usr/lib/postgresql/17/lib\`, \`/usr/share/postgresql/17\`, and a \`bindir.txt\` recording where they went. The main container then runs the **new** image with those old binaries available to it, which is exactly what \`pg_upgrade\` needs: one installation to read the old cluster with and one to write the new catalogue.

That has a consequence worth remembering: the old image must still be pullable when you upgrade. A tag you have deleted from your registry is a tag you cannot upgrade away from.

Now confirm the result:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT version();"
kubectl get cluster pg-cluster -o jsonpath='{.status.image}|{.status.pgDataImageInfo}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl get cluster pg-cluster
\`\`\`

PostgreSQL 18.4, \`majorVersion: 18\`, the same 50 rows, three instances ready. One field, and a catalogue rewrite.`,
      hint: `Start the Job-watching loop *before* the patch — the Job is deleted as soon as it completes, and on a database this small that is under a minute.`,
      solution: `kubectl get cluster pg-cluster -o jsonpath='{.status.image}|{.status.pgDataImageInfo}{"\\n"}'
( for i in $(seq 1 60); do
    if kubectl get job pg-cluster-1-major-upgrade >/dev/null 2>&1; then
      kubectl get job pg-cluster-1-major-upgrade -o jsonpath='{range .spec.template.spec.initContainers[*]}INIT {.name} {.image}{"\\n"}{end}{range .spec.template.spec.containers[*]}MAIN {.name} {.image}{"\\n"}{end}' | tee /root/upgrade-job.txt
      kubectl logs job/pg-cluster-1-major-upgrade --all-containers 2>/dev/null | tail -12 >> /root/upgrade-job.txt
      break
    fi
    sleep 2
  done ) &
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}}'
sleep 150
kubectl get cluster pg-cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT version();"
cat /root/upgrade-job.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"`,
    },

    {
      id: 'kept-and-rebuilt',
      title: 'Find out which volumes survived, and try to go back',
      limitSec: 720,
      criteria: [
        "/root/volumes.txt records what happened to each instance's volume",
        "The replica volumes are younger than the primary's — they were rebuilt, it was not",
        '/root/no-downgrade.txt records the refusal to go back',
        'And both replicas are streaming from the upgraded primary',
      ],
      brief: `A major upgrade is asymmetric, and the volumes show it.

\`pg_upgrade\` runs against the primary's existing data directory, so the primary keeps its volume: the same claim, the same PersistentVolume, upgraded in place. The replicas cannot be upgraded that way at all — their data directories were written by the old major and there is no primary to replay from during the upgrade — so the operator deletes them and clones them again.

Ages are the evidence. Compare the claims and you will find one old volume and two young ones, on a cluster whose instances are all the same age.

Then try the thing everyone thinks about afterwards, and read the refusal carefully: it comes from admission, before anything happens, and it is the reason a major upgrade needs a backup rather than a rollback plan.`,
      instructions: `Look at the volumes and the instances side by side:

\`\`\`
kubectl get pvc -o custom-columns=NAME:.metadata.name,AGE:.metadata.creationTimestamp,VOLUME:.spec.volumeName | tee /root/volumes.txt
kubectl get pvc
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

The primary's claim is as old as the environment; the replicas' claims are minutes old, created after the upgrade. Nothing about the primary's storage was replaced — \`pg_upgrade\` rewrote the catalogue inside the data directory it was already using.

Check what is on it now, which is less than you might expect:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- sh -c 'ls /var/lib/postgresql/data/; du -sh /var/lib/postgresql/data/pgdata'
\`\`\`

One \`pgdata\` directory. There is no copy of the old cluster left behind to reclaim — and equally, nothing to go back to.

Which makes the next result the important one. Try to return to PostgreSQL 17:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:17-system-trixie"}}' 2>&1 | tee /root/no-downgrade.txt
\`\`\`

*spec.imageName: Invalid value: "17": can't downgrade from major 18 to 17*. This is admission control, so nothing was written and the cluster is untouched — but it also means the upgrade has no undo. The only route back to 17 is a backup taken before it, restored into a cluster that still names the old image.

Confirm the cluster is genuinely whole again:

\`\`\`
kubectl get cluster pg-cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec psql-client -- psql -h pg-cluster-ro -tAc "SELECT count(*) FROM notes;"
\`\`\`

Two replicas streaming, and the read-only Service answering from one of them.

So the operational shape of this: the upgrade is an outage on the primary for as long as \`pg_upgrade\` takes, followed by a full rebuild of every replica — which on a real database is the part that takes the time, since each one is a fresh \`pg_basebackup\`. Take the backup first, because admission will not let you change your mind.`,
      hint: `\`kubectl get pvc -o custom-columns=…creationTimestamp\` is the quickest way to see which volumes are new. The downgrade patch is meant to fail — capture what it says.`,
      solution: `kubectl get pvc -o custom-columns=NAME:.metadata.name,AGE:.metadata.creationTimestamp,VOLUME:.spec.volumeName | tee /root/volumes.txt
kubectl exec pg-cluster-1 -c postgres -- sh -c 'ls /var/lib/postgresql/data/'
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:17-system-trixie"}}' 2>&1 | tee /root/no-downgrade.txt
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
kubectl get cluster pg-cluster`,
    },

    {
      id: 'what-it-left-behind',
      title: 'Deal with what the upgrade did not bring',
      limitSec: 900,
      criteria: [
        '/root/no-stats.txt records the table with no statistics after the upgrade',
        'ANALYZE has given the planner its numbers back',
        'A freshly bootstrapped PostgreSQL 18 cluster has data checksums on',
        'While the upgraded cluster still has them off, as PostgreSQL 17 created it',
      ],
      brief: `The data came across. Two things did not, and both are the kind of difference that shows up later as a mystery rather than an error.

The first is optimizer statistics. \`pg_upgrade\` does not carry them, so every table starts out unanalysed — \`reltuples\` reads \`-1\` and \`pg_stats\` has nothing to say about any column. The database works; the planner is guessing. Running \`ANALYZE\` is the last step of the upgrade, not an optional tidy-up.

The second is subtler and worth knowing about: an upgraded cluster keeps the decisions \`initdb\` made under the *old* version. It does not adopt the new major's defaults, because no \`initdb\` ever ran. Data checksums are the clearest case — PostgreSQL 18's \`initdb\` turns them on and 17's did not — so the way to see it is to stand a fresh 18 cluster next to the upgraded one and ask both the same question.

Do that. Two clusters, the same image, two different answers.`,
      instructions: `Ask the planner what it knows about the table you carried across:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c \\
  "SELECT relname, reltuples, (SELECT count(*) FROM pg_stats WHERE tablename = c.relname) AS stat_columns
   FROM pg_class c WHERE relname = 'notes';" | tee /root/no-stats.txt
\`\`\`

\`reltuples\` is \`-1\` — PostgreSQL's way of saying "never analysed" — and no column has statistics. The rows are all there; nothing knows anything about them.

Fix it, which is one statement:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "ANALYZE notes;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c \\
  "SELECT relname, reltuples, (SELECT count(*) FROM pg_stats WHERE tablename = c.relname) AS stat_columns
   FROM pg_class c WHERE relname = 'notes';"
\`\`\`

50 rows and statistics on both columns. On a real database this is \`vacuumdb --analyze-in-stages\` across everything, and it is the difference between a database that is up and a database that performs.

Now the other one. Stand a fresh PostgreSQL 18 cluster next to the upgraded one:

\`\`\`
kubectl apply -f - <<'YAML'
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-fresh
  namespace: default
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie
  storage:
    size: 1Gi
YAML
for i in $(seq 1 10); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-fresh --no-headers 2>/dev/null
  sleep 10
done
\`\`\`

Healthy in about half a minute. Now ask both the same two questions:

\`\`\`
for c in pg-cluster-1 pg-fresh-1; do
  printf "%-14s " "$c"
  kubectl exec $c -c postgres -- psql -U postgres -tAc \\
    "SELECT 'server_version=' || current_setting('server_version') || ' data_checksums=' || current_setting('data_checksums');"
done
\`\`\`

The same PostgreSQL 18.4, and \`data_checksums\` **on** for the fresh cluster and **off** for the upgraded one. Nothing is broken — the upgraded cluster is exactly as PostgreSQL 17's \`initdb\` made it, and \`pg_upgrade\` had no reason to change that. But it means "we are on 18 now" does not imply "we have what 18 would have given us", and checksums in particular can only be turned on later with the database shut down.

So the three things to plan around a declarative major upgrade: an outage while \`pg_upgrade\` runs and a full rebuild of every replica afterwards; no way back, because admission refuses a downgrade and no copy of the old cluster is kept; and a database that needs \`ANALYZE\` before it performs, carrying whatever \`initdb\` decided under the version you started on.`,
      hint: `\`reltuples = -1\` is the value to capture — it is PostgreSQL's marker for "never analysed", not a count. Then \`ANALYZE notes;\` and ask again.`,
      solution: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "SELECT relname, reltuples, (SELECT count(*) FROM pg_stats WHERE tablename = c.relname) AS stat_columns FROM pg_class c WHERE relname = 'notes';" | tee /root/no-stats.txt
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "ANALYZE notes;"
kubectl apply -f - <<'YAML'
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-fresh
  namespace: default
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie
  storage:
    size: 1Gi
YAML
sleep 60
kubectl get cluster
for c in pg-cluster-1 pg-fresh-1; do printf "%-14s " "$c"; kubectl exec $c -c postgres -- psql -U postgres -tAc "SELECT 'server_version=' || current_setting('server_version') || ' data_checksums=' || current_setting('data_checksums');"; done`,
    },
  ],
}
