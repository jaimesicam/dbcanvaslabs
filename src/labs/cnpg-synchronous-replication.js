// The setting names, the quorum sync_state and the blocking behaviour are confirmed live
// against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): enabling
// `method: any, number: 1` turned synchronous_standby_names into
// ANY 1 ("pg-cluster-2","pg-cluster-3","pg-cluster-1"), raising it to 2 with one standby
// fenced parked an INSERT in wait_event SyncRep where statement_timeout did not interrupt
// it, and switching dataDurability to preferred rewrote the list to ANY 1 ("pg-cluster-2")
// and released the blocked write immediately. Grading reads the Cluster spec, the live
// setting and the data.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster, the cnpg plugin, a
// client Pod and the toolbox are this lab's starting state, built by its own provisioning.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgSynchronousReplication = {
  id: 'cnpg-synchronous-replication',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster replicating asynchronously, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", replicating asynchronously — synchronous_standby_names is empty and no synchronous settings were applied',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'This cluster acknowledges a commit as soon as the primary has written it, without waiting for any standby — which is fast, and means a lost primary can lose transactions. You will turn on synchronous replication, then deliberately take a standby away and find out what that costs, and finally choose the other side of the trade and watch the behaviour change. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'enable-sync',
      title: 'Make the primary wait for a standby',
      limitSec: 480,
      criteria: [
        'spec.postgresql.synchronous is set to method any',
        "PostgreSQL's synchronous_standby_names is no longer empty",
        'Both replicas report sync_state quorum',
        '/root/standby-names.txt was written',
        'It records the setting PostgreSQL is now running with',
      ],
      brief: `By default this cluster is asynchronous: the primary confirms a commit to the client as soon as it has written the WAL locally, and the standbys catch up when they catch up. If the primary is lost, anything the standbys had not received is gone.

Synchronous replication changes the deal. The primary waits for a standby to confirm it has the transaction before telling the client it committed.

CloudNativePG expresses this as \`method\` and \`number\`: how many standbys must acknowledge, and whether it is any of them or a ranked list. Turn it on with \`any\` and \`1\`, then look at what PostgreSQL itself is running — the operator writes the real setting for you.`,
      instructions: `First, see what asynchronous looks like, so the change is visible:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

The setting is empty and both standbys are \`async\`. Now ask for one acknowledgement from any standby:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":1}}}}'
sleep 20
\`\`\`

Look at what PostgreSQL is running now:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
\`\`\`

\`ANY 1 ("pg-cluster-2","pg-cluster-3","pg-cluster-1")\`. Two things about that string are worth pausing on. The operator generated it — you named a policy, not a list of servers, and it keeps the list correct as instances come and go. And the primary is *in its own list*: CloudNativePG names every instance, because any of them might be the primary later, and a primary never counts itself as a standby.

Now the standbys:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sync_state, sync_priority FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Both are \`quorum\` rather than \`sync\`. That is what \`any\` means: they are peers, and whichever answers first satisfies the requirement. With \`method: first\` you would get \`sync\` and \`potential\`, a ranked list instead of a pool.

Record the setting:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SHOW synchronous_standby_names;" > /root/standby-names.txt
cat /root/standby-names.txt
\`\`\`

Writes still work exactly as before, because a standby is there to answer:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE sync_demo (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO sync_demo (note) VALUES ('sync-on') RETURNING *;"
\`\`\``,
      hint: `\`method\` is \`any\` or \`first\` and \`number\` is how many acknowledgements are required — both are required fields under \`spec.postgresql.synchronous\`. Give the operator 15–20 seconds to reconcile before reading the setting back.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":1}}}}'
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state, sync_priority FROM pg_stat_replication ORDER BY application_name;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SHOW synchronous_standby_names;" > /root/standby-names.txt
cat /root/standby-names.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE sync_demo (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO sync_demo (note) VALUES ('sync-on') RETURNING *;"`,
    },

    {
      id: 'durability-required',
      title: 'Find out what synchronous costs',
      limitSec: 600,
      criteria: [
        'The cluster now requires 2 acknowledgements',
        'dataDurability is still required — the default',
        'Only one standby is streaming, so the quorum cannot be met',
        '/root/syncrep-wait.txt was written',
        'It records the wait event the blocked write was parked in',
      ],
      brief: `Synchronous replication is a promise about durability, and every promise about durability is also a promise about availability — in the other direction.

Ask for two acknowledgements, then take one of the two standbys away. The primary now cannot satisfy its own rule, and the honest thing for it to do is refuse to say "committed". So it waits.

Run a write and watch it hang. Then, from a second connection, find the backend and read what it is waiting on. The wait event is the answer, and the detail that catches people out is that \`statement_timeout\` will not rescue you from it: the transaction is already written locally and is waiting for acknowledgement, which is not a statement being executed.

Do not leave the hanging write worrying you — the next objective releases it.`,
      instructions: `Raise the requirement to two acknowledgements:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":2}}}}'
sleep 15
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
\`\`\`

\`ANY 2\`. Both standbys must answer. Now take one away:

\`\`\`
kubectl cnpg fencing on pg-cluster pg-cluster-3
sleep 25
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

One standby, and a rule that needs two. Now write, in the background so you keep your shell:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "INSERT INTO sync_demo (note) VALUES ('blocked');" &
sleep 10
\`\`\`

It does not come back. Find out why, from a separate connection:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -x -c \\
  "SELECT pid, state, wait_event_type, wait_event, left(query, 40) AS query FROM pg_stat_activity WHERE wait_event = 'SyncRep';"
\`\`\`

\`wait_event_type\` is \`IPC\` and \`wait_event\` is \`SyncRep\`. The backend has written the transaction and is parked waiting for standbys to confirm it. Record that:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT wait_event FROM pg_stat_activity WHERE wait_event = 'SyncRep' LIMIT 1;" > /root/syncrep-wait.txt
cat /root/syncrep-wait.txt
\`\`\`

Worth knowing before you meet this in production: \`statement_timeout\` does not end this wait. The statement finished executing; what is outstanding is the commit acknowledgement, and that is not covered by a statement timer. A client that sets a timeout and assumes it will always be rescued by it will hang here anyway.

Worth knowing too: this is not a bug or a misconfiguration. The database is doing exactly what it was told — you asked for two copies before acknowledging, and there is only one. The next objective is about deciding whether you meant it.`,
      hint: `Run the blocking write with a trailing \`&\` so it goes to the background and leaves you a usable shell. The diagnosis happens on a *different* connection — \`pg_stat_activity\` on the primary, filtered to \`wait_event = 'SyncRep'\`.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":2}}}}'
sleep 15
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl cnpg fencing on pg-cluster pg-cluster-3
sleep 25
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO sync_demo (note) VALUES ('blocked');" &
sleep 10
kubectl exec $PRIMARY -c postgres -- psql -U postgres -x -c "SELECT pid, state, wait_event_type, wait_event FROM pg_stat_activity WHERE wait_event = 'SyncRep';"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT wait_event FROM pg_stat_activity WHERE wait_event = 'SyncRep' LIMIT 1;" > /root/syncrep-wait.txt
cat /root/syncrep-wait.txt`,
    },

    {
      id: 'durability-preferred',
      title: 'Choose availability instead',
      limitSec: 480,
      criteria: [
        'dataDurability is set to preferred',
        'synchronous_standby_names now names only the standby that is actually there',
        "A row noted 'after-preferred' committed instead of blocking",
      ],
      brief: `There is a second setting that decides what happens when the standbys you asked for are not available, and it is the whole point of this lab.

\`dataDurability: required\` — the default, and what you have been running — means the rule is absolute. Not enough standbys, no acknowledged commits. You keep your durability guarantee and lose write availability.

\`dataDurability: preferred\` means the operator will shrink the list to the standbys that are actually reachable rather than let writes stop. You keep writing and lose the guarantee, quietly, exactly when things are already going wrong.

Switch to \`preferred\` and watch two things happen at once: the generated setting shrinks to name only the standby that is really there, and the write that has been hanging since the last objective completes.`,
      instructions: `The standby is still fenced and the write is still blocked. Change the policy:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":2,"dataDurability":"preferred"}}}}'
sleep 25
\`\`\`

Look at the generated setting:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
\`\`\`

\`ANY 1 ("pg-cluster-2")\`. You still asked for two; the operator has written one, naming only the instance that can answer. That rewrite is the entire behaviour of \`preferred\`.

The blocked write from the previous objective has completed by now — it was released the moment the rule became satisfiable. Confirm the cluster takes writes:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c \\
  "INSERT INTO sync_demo (note) VALUES ('after-preferred') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM sync_demo ORDER BY id;"
\`\`\`

Now bring the standby back and watch the setting return to what you asked for:

\`\`\`
kubectl cnpg fencing off pg-cluster pg-cluster-3
sleep 35
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Back to \`ANY 2\` with both standbys in quorum, without anyone changing the spec. The policy is what you declared; the generated setting is the operator's continuous answer to "what can that policy actually mean right now".

So the choice this lab is really about: \`required\` will stop your writes to keep its promise, and \`preferred\` will keep your writes by quietly relaxing the promise. Neither is the safe default — they are different definitions of safe.`,
      hint: `Keep \`number: 2\` in the patch. The point is that \`preferred\` changes what happens when the number cannot be met, not the number itself.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":2,"dataDurability":"preferred"}}}}'
sleep 25
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO sync_demo (note) VALUES ('after-preferred') RETURNING *;"
kubectl cnpg fencing off pg-cluster pg-cluster-3
sleep 35
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"`,
    },
  ],
}
