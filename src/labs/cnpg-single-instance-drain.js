// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a
// single-instance cluster gets exactly one PodDisruptionBudget, <cluster>-primary, with
// minAvailable 1 over one Pod and therefore zero allowed disruptions. `kubectl drain` cordons
// the node and then never finishes: the eviction is refused for the whole timeout with `Cannot
// evict pod as it would violate the pod's disruption budget`, and the instance keeps running.
// Setting spec.enablePDB to false deleted both budgets, after which the same drain completed in
// seconds — and left the instance Pending with the read-write Service holding no endpoints at
// all, because a local-path volume cannot follow it to another node.
//
// Self-contained, like every lab here: the operator, a single-instance cluster pinned to a
// worker node and a client Pod are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgSingleInstanceDrain = {
  id: 'cnpg-single-instance-drain',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real, deliberately unreplicated PostgreSQL cluster, thrown away when you finish. Nothing is simulated: the node you drain is a real node, and the outage you cause is a real outage.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A Cluster named pg-cluster with exactly one instance — no replica, no second copy — pinned to one of the worker nodes and sitting on a local-path volume that belongs to that node',
      'One PodDisruptionBudget the operator maintains for it, which you have not been shown yet',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A single-instance database has no answer to "one of your nodes has to go away". Kubernetes knows this, and the disruption budget CloudNativePG maintains will refuse the eviction rather than take the database down — which turns a routine drain into a command that hangs, and an operator who does not know why into an operator who turns the protection off. You will run into that refusal deliberately, then switch the budget off and find out precisely what it was protecting you from.',
  },

  tasks: [
    {
      id: 'one-budget',
      title: 'One instance, one budget, no room',
      limitSec: 420,
      criteria: [
        'The cluster has exactly one instance',
        'And one PodDisruptionBudget, which allows no disruptions',
        '/root/instance-node.txt was written',
        'It names the node the instance is on',
      ],
      brief: `CloudNativePG maintains disruption budgets for every cluster it manages. On a replicated cluster there are two of them, and the one covering the replicas has room to give: with two healthy replicas and \`minAvailable: 1\`, one may be evicted.

Here there is only one instance, so there is only one budget — the one covering the primary — and its arithmetic has no slack at all. One healthy Pod, one required to remain available, zero disruptions allowed.

Read it, note which node the instance is on, and be clear about what that budget is really saying: this Pod may not be evicted by anybody, for any reason, while it is the only copy of your database.`,
      instructions: `Work in the **k3d-server** tab. Look at the cluster:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

One instance, and it is the primary because there is nothing else it could be. Now the budget:

\`\`\`
kubectl get poddisruptionbudgets
kubectl get pdb -o custom-columns=NAME:.metadata.name,MIN:.spec.minAvailable,SELECTOR:.spec.selector.matchLabels,ALLOWED:.status.disruptionsAllowed,HEALTHY:.status.currentHealthy
\`\`\`

Exactly one, \`pg-cluster-primary\`, selecting the Pod labelled \`cnpg.io/instanceRole: primary\`. \`minAvailable: 1\` over one healthy Pod leaves ALLOWED DISRUPTIONS at zero.

Record where the instance lives:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o jsonpath='{.items[0].spec.nodeName}{"\\n"}' > /root/instance-node.txt
cat /root/instance-node.txt
\`\`\`

And confirm the volume is tied to that same node, which is why moving the instance is not an option:

\`\`\`
kubectl get pvc
kubectl get pvc pg-cluster-1 -o jsonpath='{.metadata.annotations.volume\\.kubernetes\\.io/selected-node}{"\\n"}'
\`\`\`

Check the database is working, so there is no doubt later about what changed:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE IF NOT EXISTS uptime_proof (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO uptime_proof (note) VALUES ('before the drain') RETURNING *;"
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}{"\\n"}'
\`\`\`

One address behind the read-write Service. Watch that line — it is the clearest signal in this lab of whether the database exists as far as an application is concerned.`,
      hint: `ALLOWED DISRUPTIONS is computed, not configured: it is \`currentHealthy - minAvailable\`, which for one instance and \`minAvailable: 1\` can only ever be zero.`,
      solution: `kubectl get cluster pg-cluster
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get pdb -o custom-columns=NAME:.metadata.name,MIN:.spec.minAvailable,SELECTOR:.spec.selector.matchLabels,ALLOWED:.status.disruptionsAllowed,HEALTHY:.status.currentHealthy
kubectl get pods -l cnpg.io/cluster=pg-cluster -o jsonpath='{.items[0].spec.nodeName}{"\\n"}' > /root/instance-node.txt
cat /root/instance-node.txt
kubectl get pvc pg-cluster-1 -o jsonpath='{.metadata.annotations.volume\\.kubernetes\\.io/selected-node}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE IF NOT EXISTS uptime_proof (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO uptime_proof (note) VALUES ('before the drain') RETURNING *;"
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}{"\\n"}'`,
    },

    {
      id: 'drain-blocked',
      title: 'Drain the node and watch the command hang',
      limitSec: 600,
      criteria: [
        '/root/drain-error.txt records the eviction being refused',
        'The node is cordoned — a drain cordons first and evicts afterwards',
        'But the instance is still running, and the database is still up',
      ],
      brief: `Run the drain with a timeout, because otherwise it will wait forever and so will you.

Two things happen, in this order, and separating them is the whole point of the objective. The node is cordoned immediately — that part is not a request and cannot be refused. Then the eviction is attempted, refused by the budget, retried every five seconds, and refused again, until your timeout runs out.

Meanwhile the database is completely unaffected. This is the system working exactly as designed: it would rather leave a node half-drained and tell you so than take an unreplicated database offline because somebody typed a routine command.`,
      instructions: `Drain the node, keeping the output — this will take the full 60 seconds:

\`\`\`
NODE=$(cat /root/instance-node.txt)
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force --timeout=60s 2>&1 \\
  | tee /root/drain-error.txt
\`\`\`

Read what it printed. Among the retries is the sentence that matters:

\`Cannot evict pod as it would violate the pod's disruption budget.\`

and, at the end, the drain giving up: \`error when evicting pods/"pg-cluster-1": global timeout reached: 60s\`. The command failed. Nothing has been evicted.

Now look at what it did manage to do:

\`\`\`
kubectl get nodes
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster pg-cluster
\`\`\`

The node is \`Ready,SchedulingDisabled\` — cordoned, and it will stay cordoned after a failed drain, which is a detail worth remembering: a drain that did not finish still leaves the node unschedulable.

And the database:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO uptime_proof (note) VALUES ('during the blocked drain') RETURNING *;"
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}{"\\n"}'
\`\`\`

Still accepting writes, still one endpoint. From the application's point of view nothing has happened at all.

This is the moment where the trap is set. The node still needs to go away, the drain will not finish, and there is an obvious-looking setting that makes the obstacle disappear.`,
      hint: `Without \`--timeout\` the drain retries indefinitely; with it, the command gives up and returns, which is what you want here. The node stays cordoned either way — that is not undone by the failure.`,
      solution: `NODE=$(cat /root/instance-node.txt)
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force --timeout=60s 2>&1 | tee /root/drain-error.txt
kubectl get nodes
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO uptime_proof (note) VALUES ('during the blocked drain') RETURNING *;"
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}{"\\n"}'`,
    },

    {
      id: 'disable-the-budget',
      title: 'Remove the obstacle, and meet what it was hiding',
      limitSec: 720,
      criteria: [
        'PodDisruptionBudgets are switched off for this cluster',
        'And there are none left to refuse an eviction',
        '/root/outage.txt records the instance with nowhere to run',
        'And after uncordoning, the instance is back',
      ],
      brief: `\`spec.enablePDB: false\` tells the operator to stop maintaining disruption budgets for this cluster. The budgets are deleted, the eviction is no longer refused, and the drain finishes in seconds.

Then look at what you have. The instance is evicted; its volume is a directory on the node you have just cordoned; there is nowhere else it can run and no second copy to serve from. The Pod is Pending, the read-write Service has no endpoints, and the database is down until the node comes back.

That is what the budget was protecting. Not the node, not the drain — the fact that this cluster has exactly one copy of its data. Turning the protection off does not remove the problem; it removes the warning.`,
      instructions: `Switch the budgets off and watch them go:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"enablePDB":false}}'
sleep 10
kubectl get poddisruptionbudgets
\`\`\`

\`No resources found\`. Now the same drain that could not finish a moment ago:

\`\`\`
NODE=$(cat /root/instance-node.txt)
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force --timeout=60s
\`\`\`

Evicted, drained, done — in seconds. Look at the consequences immediately:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide | tee /root/outage.txt
kubectl get cluster pg-cluster
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}{"\\n"}'
\`\`\`

\`Pending\`, no node, no endpoints — the read-write Service resolves to nothing at all. And a client finds out the way clients always find out:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;" 2>&1 | head -3
\`\`\`

The database is down. Not degraded — down. It will stay down until the node it is pinned to accepts Pods again, because that is where its data is:

\`\`\`
PENDING=$(kubectl get pods -l cnpg.io/cluster=pg-cluster -o jsonpath='{.items[0].metadata.name}')
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=$PENDING
\`\`\`

Bring it back:

\`\`\`
kubectl uncordon $(cat /root/instance-node.txt)
sleep 30
kubectl get nodes
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM uptime_proof ORDER BY id;"
\`\`\`

Both rows are there — the outage cost availability, not data.

So what should you actually do when a single-instance cluster's node has to be drained? Three answers, in order of preference. Give the cluster a replica first, and the problem disappears: with two instances the budgets have slack, the operator moves the primary and the drain succeeds. Failing that, schedule the outage and accept it, which is exactly what the budget is asking you to decide. Turning \`enablePDB\` off is the third answer, and its only honest use is a cluster that is genuinely disposable — because the setting does not make the drain safe, it makes it quiet.`,
      hint: `The instance cannot be scheduled anywhere else while the node is cordoned, so nothing you do to the Cluster will bring it back before the uncordon — this is an availability problem with exactly one fix.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"enablePDB":false}}'
sleep 10
kubectl get poddisruptionbudgets
NODE=$(cat /root/instance-node.txt)
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force --timeout=60s
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide | tee /root/outage.txt
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;" 2>&1 | head -3
kubectl uncordon $(cat /root/instance-node.txt)
sleep 30
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM uptime_proof ORDER BY id;"`,
    },
  ],
}
