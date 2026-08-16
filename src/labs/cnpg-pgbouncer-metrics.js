// The PgBouncer metrics port, the series names and the fact that a pool only appears once
// traffic has used it are confirmed live against a real K3D + CloudNativePG deploy (server/,
// see LABORATORY.md): a PgBouncer Pod served 51 cnpg_pgbouncer_ series on 9127, and the
// database="app" pool series appeared only after connections went through it. Grading
// scrapes the same endpoint.
//
// Scraped from the `toolbox` tab with curl, which the minimal k3s node image does not ship —
// the toolbox container (server/toolbox.go) does, and every attempt gets one.
//
// Self-contained, like every lab here: the operator, a healthy cluster, a client Pod, a
// staged Pooler manifest and the toolbox are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgPgBouncerMetrics = {
  id: 'cnpg-pgbouncer-metrics',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real PostgreSQL cluster, with a PgBouncer pooler left for you to create, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state"',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to generate traffic from',
      'A Pooler manifest staged at /root/pooler.yaml on the k3d-server node — written but deliberately not applied',
    ],
    yourJob:
      'There is no pooler in front of this database yet, and therefore nothing exporting pooler metrics. Working from the toolbox tab, you will create one, scrape the metrics its Pods export, and then send real traffic through it and watch a pool appear in the metrics that was not there before — which is the difference between a configured pool and a used one.',
  },

  tasks: [
    {
      id: 'apply-the-pooler',
      title: 'Create the pooler and find its metrics port',
      limitSec: 480,
      criteria: [
        'pooler.postgresql.cnpg.io/pg-cluster-pooler-rw exists',
        'Its PgBouncer Deployment reports 2 ready replicas',
        'Each PgBouncer Pod serves metrics on port 9127',
      ],
      brief: `A Pooler is declared, not deployed: the operator builds PgBouncer from it, and the Pods it creates export Prometheus metrics without anyone asking.

This objective spans two tabs, and the reason is worth knowing. The manifest was staged on the **k3d-server** node when this environment was built, so apply it from that tab — a file lives on one machine. Then move to the **toolbox** tab to scrape, because that is where curl is.

Apply the staged manifest, wait for the two PgBouncer Pods, and then look at what ports they listen on. The pooler's metrics live on a different port from a database instance's — worth knowing, because a scrape configuration that assumes one port silently misses the other.

Nothing about the metrics needs configuring. The endpoint is there the moment the Pod is.`,
      instructions: `In the **k3d-server** tab, where the manifest was staged, read it and apply it:

\`\`\`
cat /root/pooler.yaml
kubectl apply -f /root/pooler.yaml
kubectl get pooler
\`\`\`

Wait for the PgBouncer Pods:

\`\`\`
kubectl get deploy pg-cluster-pooler-rw
kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o wide
\`\`\`

Two Pods, on different nodes. Look at the container and its ports:

\`\`\`
POD=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $POD -o jsonpath='{range .spec.containers[*]}{.name}: {range .ports[*]}{.name}={.containerPort} {end}{"\\n"}{end}'
\`\`\`

\`pgbouncer=5432\` and \`metrics=9127\` — a different metrics port from an instance's 9187. Now switch to the **toolbox** tab and scrape it:

\`\`\`
IP=$(kubectl get pod $POD -o jsonpath='{.status.podIP}')
curl -s http://$IP:9127/metrics | head -10
\`\`\`

Every series is prefixed \`cnpg_pgbouncer_\`, so a single Prometheus job can scrape instances and poolers together and still tell them apart.`,
      hint: `Each PgBouncer Pod exports its own metrics — there is no aggregate endpoint, so a real scrape configuration collects from all of them and sums where it needs to.`,
      solution: `cat /root/pooler.yaml
kubectl apply -f /root/pooler.yaml
kubectl get pooler
kubectl get deploy pg-cluster-pooler-rw
POD=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $POD -o jsonpath='{range .spec.containers[*]}{.name}: {range .ports[*]}{.name}={.containerPort} {end}{"\\n"}{end}'
IP=$(kubectl get pod $POD -o jsonpath='{.status.podIP}')
curl -s http://$IP:9127/metrics | head -10`,
    },

    {
      id: 'scrape-the-pooler',
      title: 'Read what PgBouncer is reporting',
      limitSec: 420,
      criteria: [
        'cnpg_pgbouncer_last_collection_error is 0 — the exporter is talking to PgBouncer',
        '/root/pgbouncer-metric-count.txt was written',
        'It records how many cnpg_pgbouncer_ series you counted',
      ],
      brief: `Look at what the exporter actually publishes, and check its own health first.

\`cnpg_pgbouncer_last_collection_error\` is the metric that says whether the numbers below it mean anything: the exporter connects to PgBouncer's admin console to collect, and if that fails you get stale values rather than an obvious gap.

The rest divides into two families — \`lists_\` counters describing PgBouncer as a whole, and \`pools_\` gauges reported per database and user. Count the series and record the number.`,
      instructions: `Check the exporter's own health:

\`\`\`
POD=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
IP=$(kubectl get pod $POD -o jsonpath='{.status.podIP}')
curl -s http://$IP:9127/metrics | grep -E "^cnpg_pgbouncer_(last_collection_error|collections_total|collection_duration)"
\`\`\`

\`last_collection_error 0\` means the exporter reached PgBouncer's admin console. Now the two families:

\`\`\`
curl -s http://$IP:9127/metrics | grep "^cnpg_pgbouncer_lists_" | head -8
curl -s http://$IP:9127/metrics | grep "^cnpg_pgbouncer_pools_" | head -8
\`\`\`

The \`lists_\` series are process-wide counts — databases, users, pools, DNS entries. The \`pools_\` series carry \`database\` and \`user\` labels and describe one pool each: clients active and waiting, server connections active and idle, and how long the longest client has been waiting.

Note which pools exist right now. Count everything and record it:

\`\`\`
curl -s http://$IP:9127/metrics | grep -c "^cnpg_pgbouncer_" > /root/pgbouncer-metric-count.txt
cat /root/pgbouncer-metric-count.txt
\`\`\``,
      hint: `\`cl_\` prefixes are client-side counts and \`sv_\` prefixes are server-side — the gap between them is the pooling you are getting.`,
      solution: `POD=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
IP=$(kubectl get pod $POD -o jsonpath='{.status.podIP}')
curl -s http://$IP:9127/metrics | grep -E "^cnpg_pgbouncer_(last_collection_error|collections_total)"
curl -s http://$IP:9127/metrics | grep "^cnpg_pgbouncer_lists_" | head -8
curl -s http://$IP:9127/metrics | grep "^cnpg_pgbouncer_pools_" | head -8
curl -s http://$IP:9127/metrics | grep -c "^cnpg_pgbouncer_" > /root/pgbouncer-metric-count.txt
cat /root/pgbouncer-metric-count.txt`,
    },

    {
      id: 'correlate-with-traffic',
      title: 'Send traffic, and watch a pool appear',
      limitSec: 480,
      criteria: [
        "A row noted 'via-pooler' reached the database through PgBouncer",
        'A cnpg_pgbouncer_pools_ series now exists for the app database',
        'cnpg_pgbouncer_lists_databases counts the pooled databases',
      ],
      brief: `Send real traffic through the pooler and scrape again. A pool for the \`app\` database appears that was not in the previous scrape.

That is the detail worth taking away: PgBouncer reports pools it has actually served, not pools it has been configured to allow. Before any client connects, the only pool is PgBouncer's own admin database — so an alert written against a pool that has never been used will never fire, because the series does not exist yet.

Connect through the pooler, write a row, then look at the same endpoint.`,
      instructions: `Note what pools exist before you start:

\`\`\`
POD=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
IP=$(kubectl get pod $POD -o jsonpath='{.status.podIP}')
curl -s http://$IP:9127/metrics | grep "^cnpg_pgbouncer_pools_cl_active"
\`\`\`

Now send traffic through the pooler's Service, which load-balances across both Pods — so connect a few times to be sure the Pod you are scraping serves one of them:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "CREATE TABLE pool_metrics_proof (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "INSERT INTO pool_metrics_proof (note) VALUES ('via-pooler') RETURNING *;"
for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -tAc "SELECT 1;" >/dev/null; done
\`\`\`

Scrape both Pods and look for the app pool:

\`\`\`
for P in $(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{range .items[*]}{.status.podIP} {end}'); do
  echo "== $P"; curl -s http://$P:9127/metrics | grep 'database="app"' | head -4
done
\`\`\`

A \`database="app",user="app"\` pool now exists. And the process-wide count reflects it:

\`\`\`
curl -s http://$IP:9127/metrics | grep -E "^cnpg_pgbouncer_lists_(databases|pools|users)"
\`\`\`

Confirm the write really landed in PostgreSQL, not just in PgBouncer's bookkeeping:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pool_metrics_proof;"
\`\`\``,
      hint: `The pooler Service load-balances, so a pool may appear on one PgBouncer Pod and not the other — scrape both, which is what a real Prometheus job does anyway.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "CREATE TABLE pool_metrics_proof (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -c "INSERT INTO pool_metrics_proof (note) VALUES ('via-pooler') RETURNING *;"
for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -tAc "SELECT 1;" >/dev/null; done
for P in $(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{range .items[*]}{.status.podIP} {end}'); do
  echo "== $P"; curl -s http://$P:9127/metrics | grep 'database="app"' | head -4
done
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pool_metrics_proof;"`,
    },
  ],
}
