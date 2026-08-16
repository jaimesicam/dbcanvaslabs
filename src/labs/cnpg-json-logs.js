// The log structure, the nested PostgreSQL CSV fields and the aggregation command are
// confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a
// failing query produced a record with error_severity ERROR and sql_state_code 22012, 500
// instance log lines parsed with `jq` without a single failure, and `kubectl cnpg logs
// cluster` wrote 120 lines covering all three instances. Grading greps the instance's own
// log for the same record.
//
// This lab is worked from the `toolbox` tab, because its subject is reading structured logs
// and the tool for that is jq — which the minimal k3s node image does not ship. The toolbox
// container (server/toolbox.go) does, and every attempt gets one.
//
// Self-contained, like every lab here: the operator, a healthy cluster, the cnpg plugin, a
// client Pod and the toolbox are this lab's starting state, built by its own provisioning.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgJSONLogs = {
  id: 'cnpg-json-logs',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real PostgreSQL cluster that is already logging in JSON, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here — and everything they logged on the way is there to read.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, whose instances and operator both log structured JSON to stdout — no logging configuration was applied, this is the default',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to provoke a log entry from',
    ],
    yourJob:
      "Nothing here needs configuring: CloudNativePG logs JSON by default, and PostgreSQL's own log lines arrive as structured records rather than text to regex. You will take the format apart, provoke a real database error and find it by its SQLSTATE rather than by its message, and then collect one stream of logs across all three instances. Work in the toolbox tab throughout — reading structured logs is what jq is for, and the k3s nodes do not carry it.",
  },

  tasks: [
    {
      id: 'read-the-structure',
      title: 'Take the log format apart',
      limitSec: 420,
      criteria: [
        'Every instance log line is a JSON object with level, logger and logging_pod',
        "The operator's own log is JSON in the same shape",
        '/root/loggers.txt was written',
        'It lists the distinct logger values, including postgres and instance-manager',
      ],
      brief: `Read one line of an instance's log carefully before reading a thousand.

Work in the **toolbox** tab for this lab. Its subject is structured logs, and the tool for those is jq — which the k3s nodes do not carry and the toolbox does.

Every line is a JSON object with the same envelope: a level, a timestamp, which subsystem emitted it, a message, and which Pod it came from. Several different subsystems share that envelope — the instance manager, PostgreSQL itself, the tools the operator runs — and the \`logger\` field is what tells them apart.

List the distinct \`logger\` values you can find and record them in \`/root/loggers.txt\`. That list is the map of what is actually talking to you in a CloudNativePG log.`,
      instructions: `Switch to the **toolbox** tab, and look at a single line first:

\`\`\`
kubectl logs pg-cluster-1 --tail=1 | jq
\`\`\`

One JSON object, pretty-printed. The envelope is always \`level\`, \`ts\`, \`logger\`, \`msg\` and \`logging_pod\` — so a collector can index every line the same way regardless of which subsystem produced it. Nested under \`record\` is PostgreSQL's own log line, which the next objective is about.

Something worth proving rather than assuming — that *every* line is JSON, with no plain-text lines mixed in:

\`\`\`
kubectl logs pg-cluster-1 --tail=500 | jq -c . > /dev/null; echo "exit=$?"
\`\`\`

Exit 0. Five hundred lines, not one of them unparseable, which is what makes the rest of this safe to pipe through a parser instead of a regex.

Now find out which subsystems there are:

\`\`\`
kubectl logs pg-cluster-1 --tail=500 | jq -r .logger | sort -u
\`\`\`

Four of them here: \`cluster-resource\`, \`instance-manager\`, \`pg_controldata\` and \`postgres\`. Record them:

\`\`\`
kubectl logs pg-cluster-1 --tail=500 | jq -r .logger | sort -u > /root/loggers.txt
cat /root/loggers.txt
\`\`\`

Fields combine, which is where a parser earns its keep over grep — who is talking, and how much:

\`\`\`
kubectl logs pg-cluster-1 --tail=500 | jq -r '[.level, .logger] | @tsv' | sort | uniq -c | sort -rn
\`\`\`

The operator logs the same way, which means one parser handles both:

\`\`\`
OPERATOR=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
kubectl -n cnpg-system logs $OPERATOR --tail=2 | jq -c '{level, logger, msg}'
\`\`\`

Same envelope, different loggers. Nothing was configured to make this happen — structured logging is the default, and there is no plain-text mode to fall back to.`,
      hint: `\`jq -r\` prints raw strings rather than quoted ones, which is what makes the output pipe cleanly into \`sort -u\`. If jq is not found, check which tab you are in — the k3s node tabs do not have it.`,
      solution: `kubectl logs pg-cluster-1 --tail=1 | jq
kubectl logs pg-cluster-1 --tail=500 | jq -c . > /dev/null; echo "exit=$?"
kubectl logs pg-cluster-1 --tail=500 | jq -r .logger | sort -u > /root/loggers.txt
cat /root/loggers.txt
kubectl logs pg-cluster-1 --tail=500 | jq -r '[.level, .logger] | @tsv' | sort | uniq -c | sort -rn
OPERATOR=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
kubectl -n cnpg-system logs $OPERATOR --tail=2 | jq -c '{level, logger, msg}'`,
    },

    {
      id: 'find-an-error',
      title: 'Provoke an error and find it by its SQLSTATE',
      limitSec: 420,
      criteria: [
        'The instance log carries the failed statement as structured JSON, with its SQLSTATE',
        '/root/sqlstate.txt was written',
        'It records the SQLSTATE the log reported',
      ],
      brief: `Run a query that fails, then find it in the log — not by grepping for its message, but by the field that identifies what kind of failure it was.

PostgreSQL's own log lines arrive nested under a \`record\` key, carrying the full CSV log field set as structured data: the user, the database, where the connection came from, the statement, the severity and the SQLSTATE.

That is the difference this format makes. \`sql_state_code\` is a stable five-character code — selecting on it finds every occurrence of that class of failure regardless of how the message is worded or localised, which is what you want in an alert.`,
      instructions: `Run something that fails, in a way you can recognise afterwards:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1/0;"
\`\`\`

\`ERROR: division by zero\`, and a non-zero exit. Now find it on the primary — selecting by severity, not searching for a message:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl logs $PRIMARY --tail=200 | jq 'select(.record.error_severity == "ERROR") | .record'
\`\`\`

Read that record properly. You get \`user_name\`, \`database_name\`, \`connection_from\` with the client's address and port, \`application_name\`, \`backend_type\`, the \`query\` that failed, \`error_severity\` and \`sql_state_code\`. None of it had to be parsed out of a message, because none of it was ever *in* the message.

Pull out the SQLSTATE and record it:

\`\`\`
kubectl logs $PRIMARY --tail=200 | jq -r 'select(.record.sql_state_code != "00000") | .record.sql_state_code' | tail -1 > /root/sqlstate.txt
cat /root/sqlstate.txt
\`\`\`

\`22012\` is the SQL standard's code for division by zero. Now count by code rather than by text, which is how you would actually alert on it:

\`\`\`
kubectl logs $PRIMARY --tail=500 | jq -r 'select(.record.sql_state_code) | .record.sql_state_code' | sort | uniq -c | sort -rn
\`\`\`

Mostly \`00000\`, which is PostgreSQL's "successful completion" — ordinary log lines carry a SQLSTATE too. The \`select\` is doing real work there: instance-manager lines have no \`record\` at all, and without it you would be counting nulls alongside codes.

Finally, the shape of a real alert query — every occurrence of one failure class, with who caused it:

\`\`\`
kubectl logs $PRIMARY --tail=500 | jq -r 'select(.record.sql_state_code == "22012") | [.record.log_time, .record.user_name, .record.query] | @tsv'
\`\`\`

One line per occurrence, with the timestamp, the user and the statement — and not a regex anywhere.`,
      hint: `The SQLSTATE for division by zero is \`22012\`. Record the code — the file needs to contain that number, and \`jq -r\` gives it to you unquoted.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1/0;"
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl logs $PRIMARY --tail=200 | jq 'select(.record.error_severity == "ERROR") | .record'
kubectl logs $PRIMARY --tail=200 | jq -r 'select(.record.sql_state_code != "00000") | .record.sql_state_code' | tail -1 > /root/sqlstate.txt
cat /root/sqlstate.txt
kubectl logs $PRIMARY --tail=500 | jq -r 'select(.record.sql_state_code) | .record.sql_state_code' | sort | uniq -c | sort -rn
kubectl logs $PRIMARY --tail=500 | jq -r 'select(.record.sql_state_code == "22012") | [.record.log_time, .record.user_name, .record.query] | @tsv'`,
    },

    {
      id: 'aggregate-across-pods',
      title: 'Collect one stream from every instance',
      limitSec: 420,
      criteria: [
        '/root/all-pods.txt was written',
        'It carries log lines from all 3 instances, in one stream',
        'The aggregated lines are still the same JSON records',
      ],
      brief: `\`kubectl logs\` reads one Pod. A cluster has three, and during a failover the interesting lines are spread across all of them — which is precisely when you least want to be running three commands and interleaving them by hand.

The cnpg plugin collects them into a single stream, tagged by \`logging_pod\`, and can follow new and recreated Pods as they appear.

Write that stream to a file and confirm all three instances are in it, still as the same JSON records — aggregating does not reformat anything, which is the property that makes the merged file exactly as parseable as its parts.`,
      instructions: `Collect the logs of every instance into one file:

\`\`\`
kubectl cnpg logs cluster pg-cluster --tail 40 -o /root/all-pods.txt
wc -l < /root/all-pods.txt
\`\`\`

Around 120 lines. Check which Pods contributed:

\`\`\`
jq -r .logging_pod /root/all-pods.txt | sort | uniq -c
\`\`\`

All three instances, in one stream — plus a couple of lines reported as \`null\`. Those are real, and worth looking at rather than filtering away:

\`\`\`
jq -c 'select(.logging_pod == null)' /root/all-pods.txt
\`\`\`

Instance-manager lines about acquiring the leader lease, emitted before the Pod's identity was attached to its logger. The envelope is *nearly* uniform, not perfectly so, which is exactly why selecting on a field beats assuming it is there.

Because every other line carries its own \`logging_pod\`, the merge loses nothing. You can split it back apart:

\`\`\`
jq -c 'select(.logging_pod == "pg-cluster-2") | {ts, logger, msg}' /root/all-pods.txt | tail -2
\`\`\`

Or cross-tabulate the whole cluster at once, which is the thing that is genuinely awkward with three separate \`kubectl logs\` invocations:

\`\`\`
jq -r '[.logging_pod, .logger] | @tsv' /root/all-pods.txt | sort | uniq -c
\`\`\`

Every instance against every subsystem, from one file. Look for \`wal-restore\` on the two replicas and not on the primary — replicas restore WAL and a primary does not, so a difference in role shows up as a difference in which subsystems are talking.

For watching a failover as it happens, the same command follows the cluster and picks up Pods that are recreated while it runs:

\`\`\`
kubectl cnpg logs cluster pg-cluster -f --tail 5
\`\`\`

(Interrupt that one with Ctrl-C when you have seen enough — it does not stop on its own.)`,
      hint: `\`-o <file>\` writes the collected stream to a file instead of stdout, and \`--tail\` limits how much history is taken from each Pod. Without \`--tail\` it collects everything each Pod has, which is a lot after a bootstrap. Leave the file exactly as written — it is JSON, and grading reads it.`,
      solution: `kubectl cnpg logs cluster pg-cluster --tail 40 -o /root/all-pods.txt
wc -l < /root/all-pods.txt
jq -r .logging_pod /root/all-pods.txt | sort | uniq -c
jq -c 'select(.logging_pod == null)' /root/all-pods.txt
jq -c 'select(.logging_pod == "pg-cluster-2") | {ts, logger, msg}' /root/all-pods.txt | tail -2
jq -r '[.logging_pod, .logger] | @tsv' /root/all-pods.txt | sort | uniq -c`,
    },
  ],
}
