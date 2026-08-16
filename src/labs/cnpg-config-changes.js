// Every behaviour below is confirmed live against a real K3D + CloudNativePG deploy (server/,
// see LABORATORY.md): log_min_duration_statement applied with pending_restart false and no
// Pod restarted; max_connections set pending_restart true on the primary and the operator
// rolled the replicas first, then restarted PostgreSQL *inside* the primary's container
// (restartCount stayed 0 while pg_postmaster_start_time moved on); and the admission webhook
// refuses "fixed" parameters outright — listen_addresses, data_directory,
// shared_preload_libraries and hot_standby all come back "Can't set fixed configuration
// parameter", while wal_log_hints: off is refused with a message that reasons about the
// cluster ("must be set to `on` when `instances` > 1"). Grading reads the spec, pg_settings
// and the Pods.
//
// An earlier draft of this lab claimed wal_level: replica was silently overridden back to
// logical. That was wrong, and verifying it caught the error: wal_level is a
// restart-required parameter, the first reading was taken before the roll had applied it,
// and the value seen was simply the old default. Setting it to replica is honoured — the
// operator writes it into the cluster's own custom.conf like any other parameter.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster, the cnpg plugin, a
// client Pod and the toolbox are this lab's starting state, built by its own provisioning.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgConfigChanges = {
  id: 'cnpg-config-changes',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, each with the configuration the operator generated for them.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", running entirely on the configuration the operator generated — no parameters were set in its manifest',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'PostgreSQL configuration in Kubernetes is declared, not edited: you change the Cluster and the operator writes the configuration file. What that costs depends entirely on the parameter — some take effect on a reload, some force a restart of every instance in turn, and some are refused outright because they are the operator\u2019s to set. You will meet all three, and learn to tell which you are dealing with before you apply it rather than after. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'reload-only',
      title: 'Change something that only needs a reload',
      limitSec: 480,
      criteria: [
        'log_min_duration_statement is declared in spec.postgresql.parameters',
        'PostgreSQL is running with it — 250ms',
        'No restart is pending — it took effect on a reload',
        "The primary's container was never restarted",
      ],
      brief: `Start with the cheap kind of change. Most logging and planner parameters take effect on a reload: PostgreSQL rereads its configuration and the new value is live, with no interruption to anything.

Set \`log_min_duration_statement\` — log any statement slower than a threshold — and then check it four ways: what the spec says, what PostgreSQL is running, whether a restart is outstanding, and whether any container was recreated.

The column that answers the third question is \`pending_restart\` in \`pg_settings\`, and it is the single most useful thing to know about before making a configuration change in production.`,
      instructions: `Work in the **toolbox** tab. First look at what the cluster is running now — note that its manifest set no parameters at all, so everything here was generated:

\`\`\`
kubectl get cluster pg-cluster -o json | jq '.spec.postgresql.parameters'
\`\`\`

Empty. But PostgreSQL is certainly configured:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT name, setting FROM pg_settings WHERE name IN ('wal_level','max_connections','log_min_duration_statement') ORDER BY name;"
\`\`\`

Note the Pods' current ages, because you are going to compare against them:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Now declare a parameter:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"parameters":{"log_min_duration_statement":"250ms"}}}}'
sleep 25
\`\`\`

Check all four things:

\`\`\`
kubectl get cluster pg-cluster -o json | jq '.spec.postgresql.parameters'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT name, setting, unit, pending_restart FROM pg_settings WHERE name = 'log_min_duration_statement';"
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

The setting is \`250\` with a unit of \`ms\`, \`pending_restart\` is \`f\`, and the Pod ages have carried on climbing — nothing was restarted. The operator wrote the configuration file and signalled a reload.

See it working, which is more convincing than reading the setting back:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT pg_sleep(0.4);"
kubectl logs pg-cluster-1 --tail=50 | jq -r 'select((.record.message // "") | test("duration")) | .record.message' | tail -2
\`\`\`

The slow statement was logged, because the threshold you set is live.`,
      hint: `\`pending_restart\` in \`pg_settings\` is the column that tells you whether a change is already in effect or waiting for a restart. Check it *before* you plan a change, not after.`,
      solution: `kubectl get cluster pg-cluster -o json | jq '.spec.postgresql.parameters'
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"log_min_duration_statement":"250ms"}}}}'
sleep 25
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT name, setting, unit, pending_restart FROM pg_settings WHERE name = 'log_min_duration_statement';"
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT pg_sleep(0.4);"`,
    },

    {
      id: 'restart-required',
      title: 'Change something that forces a restart',
      limitSec: 600,
      criteria: [
        'max_connections is declared as 200',
        'PostgreSQL is running with 200 — the restart has happened',
        'pending_restart has cleared',
        'The cluster came back healthy with 3 of 3 ready',
        '/root/pending-restart.txt was written',
        'It captured the pending_restart state you saw',
      ],
      brief: `Now the expensive kind. \`max_connections\` is allocated at startup, so PostgreSQL cannot change it on a reload — it has to restart.

The operator handles that for you, and the order it chooses is the part worth watching: replicas first, one at a time, and the primary last. That keeps a working database available for as long as possible.

Capture \`pending_restart\` while it is still true — you have a short window between applying the change and the operator acting on it. Then watch the roll, and look carefully at what happens to the primary, because it is not what you would guess.`,
      instructions: `Apply the change and immediately look at the setting:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"parameters":{"log_min_duration_statement":"250ms","max_connections":"200"}}}}'
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT name, setting, pending_restart FROM pg_settings WHERE name = 'max_connections';"
\`\`\`

The setting still reads 100 and \`pending_restart\` is \`t\` — PostgreSQL knows what it has been asked for and knows it cannot do it yet. Record that, because it disappears once the restart happens:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT name || '=' || setting || ' pending_restart=' || pending_restart FROM pg_settings WHERE name = 'max_connections';" > /root/pending-restart.txt
cat /root/pending-restart.txt
\`\`\`

Now watch the roll:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster pg-cluster
\`\`\`

A replica has an age of a few seconds — it is being recreated — and the cluster reports itself not ready while it works through them. Wait it out:

\`\`\`
sleep 120
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Healthy again. Now the interesting part, which is what happened to the primary:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,CREATED:.metadata.creationTimestamp
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_postmaster_start_time();"
\`\`\`

Compare them. The replicas have new creation timestamps — their Pods were recreated. The primary's Pod was *not*: same timestamp, restart count still 0. But its \`pg_postmaster_start_time()\` is much later than its Pod's creation time, because the instance manager restarted PostgreSQL inside the running container.

That is the default \`primaryUpdateMethod\`, which is \`restart\`:

\`\`\`
kubectl get cluster pg-cluster -o json | jq '{primaryUpdateMethod: .spec.primaryUpdateMethod, primaryUpdateStrategy: .spec.primaryUpdateStrategy}'
\`\`\`

Both come back as defaults rather than values you set. The alternative is \`switchover\`, which promotes a replica and demotes the primary instead of restarting it — shorter write downtime, at the cost of moving the primary. Which one you want depends on whether your application minds a brief restart more than it minds a change of primary.

Confirm the new value took:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT name, setting, pending_restart FROM pg_settings WHERE name = 'max_connections';"
\`\`\``,
      hint: `Read \`pending_restart\` immediately after patching — within a few seconds, before the operator restarts anything. If you miss it, the file only needs to name the parameter, but the point is seeing the flag while it is true.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"log_min_duration_statement":"250ms","max_connections":"200"}}}}'
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT name || '=' || setting || ' pending_restart=' || pending_restart FROM pg_settings WHERE name = 'max_connections';" > /root/pending-restart.txt
cat /root/pending-restart.txt
sleep 120
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,CREATED:.metadata.creationTimestamp
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_postmaster_start_time();"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT name, setting, pending_restart FROM pg_settings WHERE name = 'max_connections';"`,
    },

    {
      id: 'rejected',
      title: 'Try to set something the operator will not allow',
      limitSec: 420,
      criteria: [
        'listen_addresses never reached the spec — the webhook refused it',
        '/root/rejected.txt was written',
        "It captured the webhook's refusal",
        'The parameters that were accepted are still in force',
      ],
      brief: `The last kind of change is the one that does not happen at all.

Some parameters are CloudNativePG's to set, not yours: the ones that decide how instances find each other, where the data lives, and what the operator loads into PostgreSQL. Ask for those and the admission webhook refuses the whole update before it reaches the API server's storage.

That is worth meeting deliberately, because it is a *good* failure — loud, immediate, and specific about which field is at fault. Compare it with a change that is accepted and then behaves differently from what you expected: this one cannot surprise you later.

There are two flavours of refusal, and the second is more interesting than the first.`,
      instructions: `Try to bind PostgreSQL to loopback only:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"parameters":{"listen_addresses":"127.0.0.1"}}}}'
\`\`\`

Refused: \`Can't set fixed configuration parameter\`. The update never happened — this is not a change that was applied and then reverted, it was rejected at admission.

Capture the message, since it is the artefact of this objective:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"parameters":{"listen_addresses":"127.0.0.1"}}}}' 2>&1 | tee /root/rejected.txt
\`\`\`

Confirm nothing landed:

\`\`\`
kubectl get cluster pg-cluster -o json | jq '.spec.postgresql.parameters'
\`\`\`

Your earlier parameters are all still there and \`listen_addresses\` is not. A rejected update is rejected whole.

The same happens for the others the operator owns:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"data_directory":"/tmp/x"}}}}' 2>&1 | tail -1
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"shared_preload_libraries":"pg_stat_statements"}}}}' 2>&1 | tail -1
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"hot_standby":"off"}}}}' 2>&1 | tail -1
\`\`\`

All \`Can't set fixed configuration parameter\`. Now the more interesting flavour — a parameter that is not fixed in general, but is fixed *for this cluster*:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"wal_log_hints":"off"}}}}' 2>&1 | tail -1
\`\`\`

\`wal_log_hints must be set to on when instances > 1\`. That is not a blanket ban; it is the webhook reasoning about the cluster you actually have. On a single-instance cluster the same request would be allowed, because the reason for the rule — \`pg_rewind\` needing those hints to re-attach a diverged instance — would not apply.

Finally, confirm that all this refusing left the working configuration alone:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT name, setting FROM pg_settings WHERE name IN ('max_connections','log_min_duration_statement') ORDER BY name;"
kubectl get cluster pg-cluster
\`\`\`

Still 200 and 250ms, cluster healthy. Nothing was rolled, nothing was restarted, and nothing needs undoing — which is the practical advantage of a check that happens at admission rather than at reconciliation.

So the three outcomes of a configuration change, in the order you would rather meet them: refused at admission, applied on a reload, or applied by restarting every instance in the cluster. Knowing which you are about to cause is the whole skill.`,
      hint: `\`tee\` writes the message to the file *and* shows it to you. The patch is expected to fail — the error text is the answer this objective is looking for.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"listen_addresses":"127.0.0.1"}}}}' 2>&1 | tee /root/rejected.txt
kubectl get cluster pg-cluster -o json | jq '.spec.postgresql.parameters'
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"data_directory":"/tmp/x"}}}}' 2>&1 | tail -1
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"wal_log_hints":"off"}}}}' 2>&1 | tail -1
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT name, setting FROM pg_settings WHERE name IN ('max_connections','log_min_duration_statement') ORDER BY name;"`,
    },
  ],
}
