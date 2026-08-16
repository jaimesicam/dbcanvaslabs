// The metrics port, the series names and the custom-query mechanism are confirmed live
// against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): an instance served
// 463 cnpg_ series on 9187, and a ConfigMap query surfaced as cnpg_lab_rows_total, reading 0
// until a table was created and 1 afterwards. Grading scrapes the same endpoint and compares
// the custom metric against the database.
//
// Scraped from the `toolbox` tab with curl, which the minimal k3s node image does not ship —
// the toolbox container (server/toolbox.go) does, and every attempt gets one.
//
// Self-contained, like every lab here: the operator, a healthy cluster, a client Pod and the
// toolbox are this lab's starting state, built by its own provisioning. No reference to any
// other lab (see CLAUDE.md, "Lab content contract").

export const cnpgMetrics = {
  id: 'cnpg-metrics',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real PostgreSQL cluster whose instances are already exporting Prometheus metrics, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster whose instance Pods each expose a metrics port on 9187 — no Prometheus, no ServiceMonitor, just the raw endpoint',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to connect from',
    ],
    yourJob:
      'The metrics are already being exported and nothing has ever read them. Working from the toolbox tab, you will scrape an instance by hand, read values that you can check against the database itself, and then add a metric of your own — a SQL query in a ConfigMap that the operator turns into a Prometheus series.',
  },

  tasks: [
    {
      id: 'scrape-the-instance',
      title: 'Scrape an instance by hand',
      limitSec: 420,
      criteria: [
        'The instance serves CloudNativePG metrics on port 9187',
        'cnpg_collector_up reports the exporter is healthy',
        '/root/metric-count.txt was written',
        'It records how many cnpg_ series you counted',
      ],
      brief: `Every CloudNativePG instance exports Prometheus metrics whether or not anything is collecting them. Before reaching for a monitoring stack, look at the raw endpoint.

Work in the **toolbox** tab. It routes straight to Pod addresses like the nodes do, and it carries curl, which the minimal k3s node image does not.

Each instance Pod listens on port 9187 and serves \`/metrics\`, so a single curl is enough — no port-forward, no Service, no Prometheus.

Count the \`cnpg_\` series and record the number in \`/root/metric-count.txt\`. The exact figure is less interesting than the scale of it: this is a few hundred series per instance, before you add any of your own.`,
      instructions: `Find the metrics port on an instance Pod:

\`\`\`
kubectl get pod pg-cluster-1 -o jsonpath='{range .spec.containers[*]}{.name}: {range .ports[*]}{.name}={.containerPort} {end}{"\\n"}{end}'
\`\`\`

\`postgresql=5432\`, \`metrics=9187\` and a status port. Now scrape it. The toolbox routes to Pod addresses directly, so take the Pod's IP and fetch:

\`\`\`
IP=$(kubectl get pod pg-cluster-1 -o jsonpath='{.status.podIP}')
echo "pod ip: $IP"
curl -s http://$IP:9187/metrics | head -12
\`\`\`

Standard Prometheus exposition format — a HELP line, a TYPE line, then one line per label combination. Check the exporter's own health first, which is the metric to alert on before any of the others:

\`\`\`
curl -s http://$IP:9187/metrics | grep -E "^cnpg_(collector_up|collector_last_collection_error)"
\`\`\`

\`cnpg_collector_up{cluster="pg-cluster"} 1\` and \`cnpg_collector_last_collection_error 0\` — the exporter is connected to PostgreSQL and its last collection succeeded. A dashboard full of stale values with \`collector_up 0\` behind it is the classic misleading monitoring failure.

Count what is on offer and record it:

\`\`\`
curl -s http://$IP:9187/metrics | grep -c "^cnpg_" > /root/metric-count.txt
cat /root/metric-count.txt
\`\`\``,
      hint: `Scrape from the toolbox tab, not from inside a Pod — the PostgreSQL image ships neither curl nor wget, so there is nothing to fetch with in there. \`grep -c "^cnpg_"\` counts series lines while skipping the HELP and TYPE comments.`,
      solution: `kubectl get pod pg-cluster-1 -o jsonpath='{range .spec.containers[*]}{.name}: {range .ports[*]}{.name}={.containerPort} {end}{"\\n"}{end}'
IP=$(kubectl get pod pg-cluster-1 -o jsonpath='{.status.podIP}')
curl -s http://$IP:9187/metrics | head -12
curl -s http://$IP:9187/metrics | grep -E "^cnpg_(collector_up|collector_last_collection_error)"
curl -s http://$IP:9187/metrics | grep -c "^cnpg_" > /root/metric-count.txt
cat /root/metric-count.txt`,
    },

    {
      id: 'read-real-values',
      title: 'Read values you can check against the database',
      limitSec: 420,
      criteria: [
        'cnpg_backends_total shows both replicas connected as streaming_replica',
        'cnpg_pg_replication_slots_active shows a slot per replica',
        '/root/replica-backends.txt was written',
        'It records the number 2',
      ],
      brief: `Metrics are only worth trusting if you can tie them back to something you can see another way, so pick series whose values you can verify with SQL.

Two good ones: the backends connected as \`streaming_replica\`, which should be one per replica, and the active replication slots, likewise. Both describe the replication topology, and both can be confirmed straight from \`pg_stat_replication\`.

Record how many streaming-replica backends the metrics report in \`/root/replica-backends.txt\`, then check the same number from the database.`,
      instructions: `Scrape the primary and look at the backends it reports:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
IP=$(kubectl get pod $PRIMARY -o jsonpath='{.status.podIP}')
curl -s http://$IP:9187/metrics | grep "^cnpg_backends_total"
\`\`\`

One series per application name: the metrics exporter's own connection, and one for each replica connected as \`streaming_replica\`. Count the replica ones and record it:

\`\`\`
curl -s http://$IP:9187/metrics | grep "^cnpg_backends_total" | grep -c 'usename="streaming_replica"' > /root/replica-backends.txt
cat /root/replica-backends.txt
\`\`\`

Now the replication slots, which describe the same relationship from the other side:

\`\`\`
curl -s http://$IP:9187/metrics | grep "^cnpg_pg_replication_slots_active"
\`\`\`

One slot per replica, named after the instance it feeds. Confirm both against PostgreSQL itself:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

The same two replicas, the same two slots. The metrics are a projection of these views, which is exactly why they are worth alerting on: a slot going inactive shows up here before anyone notices lag.`,
      hint: `Scrape the **primary** — replicas report no backends of their own for streaming replication, because nothing streams from them.`,
      solution: `PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
IP=$(kubectl get pod $PRIMARY -o jsonpath='{.status.podIP}')
curl -s http://$IP:9187/metrics | grep "^cnpg_backends_total"
curl -s http://$IP:9187/metrics | grep "^cnpg_backends_total" | grep -c 'usename="streaming_replica"' > /root/replica-backends.txt
curl -s http://$IP:9187/metrics | grep "^cnpg_pg_replication_slots_active"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"`,
    },

    {
      id: 'custom-query',
      title: 'Export a metric of your own',
      limitSec: 480,
      criteria: [
        'ConfigMap lab-queries defines a lab_rows query',
        'The Cluster references it under spec.monitoring',
        'The metric cnpg_lab_rows_total is exposed',
        'Its value matches the number of user tables in the database',
      ],
      brief: `The built-in metrics describe PostgreSQL. Anything about *your* data — queue depth, unprocessed rows, tenants over quota — has to come from a query you supply.

CloudNativePG takes those as SQL in a ConfigMap: a name, a query, and a description of the columns it returns. The operator runs it on the collection interval and exports the result as a Prometheus series, prefixed \`cnpg_\`.

Write one, wire it into the Cluster, and then change the thing it measures and watch the number follow.`,
      instructions: `Write the query as a ConfigMap:

\`\`\`
cat > /root/custom-queries.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: lab-queries
  namespace: default
data:
  queries: |
    lab_rows:
      query: "SELECT count(*) AS total FROM pg_stat_user_tables"
      metrics:
        - total:
            usage: "GAUGE"
            description: "Number of user tables in this database"
EOF
kubectl apply -f /root/custom-queries.yaml
\`\`\`

The structure is: a metric family name, the SQL, and one entry per returned column saying what kind of metric it is. Now tell the Cluster to use it:

\`\`\`
kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge \\
  -p '{"spec":{"monitoring":{"customQueriesConfigMap":[{"name":"lab-queries","key":"queries"}]}}}'
\`\`\`

Give the collector a moment, then look for it:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
IP=$(kubectl get pod $PRIMARY -o jsonpath='{.status.podIP}')
curl -s http://$IP:9187/metrics | grep -A2 "cnpg_lab_rows_total"
\`\`\`

The family name became \`cnpg_lab_rows_total\`, carrying the description you wrote as its HELP text. Now change what it measures:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE metric_demo (id serial primary key);"
sleep 20
curl -s http://$IP:9187/metrics | grep "^cnpg_lab_rows_total"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM pg_stat_user_tables;"
\`\`\`

The metric and the query agree, because the metric *is* the query.`,
      hint: `The metric name is the family name from the ConfigMap plus the column, prefixed with \`cnpg_\` — \`lab_rows\` and \`total\` become \`cnpg_lab_rows_total\`. If it does not appear, give the collector 15–20 seconds and check \`cnpg_collector_last_collection_error\` is still 0.`,
      solution: `cat > /root/custom-queries.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: lab-queries
  namespace: default
data:
  queries: |
    lab_rows:
      query: "SELECT count(*) AS total FROM pg_stat_user_tables"
      metrics:
        - total:
            usage: "GAUGE"
            description: "Number of user tables in this database"
EOF
kubectl apply -f /root/custom-queries.yaml
kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"monitoring":{"customQueriesConfigMap":[{"name":"lab-queries","key":"queries"}]}}}'
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE metric_demo (id serial primary key);"
sleep 20
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
IP=$(kubectl get pod $PRIMARY -o jsonpath='{.status.podIP}')
curl -s http://$IP:9187/metrics | grep "^cnpg_lab_rows_total"`,
    },
  ],
}
