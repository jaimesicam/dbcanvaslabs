// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): the
// operator maintains two PodDisruptionBudgets per cluster — one over the replicas, allowing one
// disruption, and one over the primary, allowing none. Draining a node holding a replica evicted
// it (and the bare psql-client Pod, which had no controller to bring it back) and left the
// instance Pending: `0/3 nodes are available: 1 node(s) were unschedulable, 2 node(s) didn't
// match PersistentVolume's node affinity`. Declaring spec.nodeMaintenanceWindow with
// reusePVC:false had the operator delete that claim and rebuild the instance on another node in
// about 45 seconds — and the API server answered the patch with `Warning: Consider using
// '.spec.enablePDB' instead of the node maintenance window feature`.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster with one
// instance per node and a client Pod are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgNodeDrain = {
  id: 'cnpg-node-drain',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, one instance per node, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here — and the node you drain is a real node with real Pods on it.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster with one instance on each of the three nodes, each on a local-path volume that pins it to the node it was first scheduled to',
      'Two PodDisruptionBudgets the operator maintains for it, which you have not been shown yet',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — and no controller behind it, which will matter',
    ],
    yourJob:
      'Somebody needs to reboot a node. The Kubernetes answer is to drain it, and the drain will ask every Pod on it to leave — including a database instance whose storage is on that node and cannot follow it anywhere. You will read the disruption budgets the operator maintains to keep that request from taking your database down, drain a node for real and watch what gets stranded, and then use the field that tells CloudNativePG a drain is deliberate rather than an accident.',
  },

  tasks: [
    {
      id: 'read-the-budgets',
      title: 'Read the budgets that stand between you and an outage',
      limitSec: 420,
      criteria: [
        'The operator maintains two PodDisruptionBudgets for this cluster',
        "The primary's budget allows no disruptions at all",
        '/root/drain-target.txt was written',
        'It names a node holding a replica, not the primary',
      ],
      brief: `A drain is a request, not an order. It cordons the node so nothing new is scheduled there, then evicts the Pods — and an eviction can be refused.

What refuses it is a PodDisruptionBudget: an object saying how many Pods of a set may be unavailable at once. CloudNativePG maintains two of them for every cluster, and their asymmetry is the whole design. One covers the replicas and permits a single disruption, so a drain can take one at a time. The other covers the primary and permits none at all, so the writable instance is never evicted while it is the writable instance.

Read both, work out which node you are going to drain, and choose a node holding a replica — the primary's node is a different story, and one this lab points at rather than walks into.`,
      instructions: `Work in the **k3d-server** tab. Look at the budgets:

\`\`\`
kubectl get poddisruptionbudgets
\`\`\`

Two of them: \`pg-cluster\` and \`pg-cluster-primary\`. The ALLOWED DISRUPTIONS column is the number that matters — one for the replicas, zero for the primary. See what each one selects on:

\`\`\`
kubectl get pdb -o custom-columns=NAME:.metadata.name,MIN:.spec.minAvailable,SELECTOR:.spec.selector.matchLabels,ALLOWED:.status.disruptionsAllowed,HEALTHY:.status.currentHealthy
\`\`\`

The first selects \`cnpg.io/instanceRole: replica\` with \`minAvailable: 1\`; two replicas are healthy, so one may go. The second selects \`cnpg.io/instanceRole: primary\` with \`minAvailable: 1\` over a single Pod, which arithmetically allows nothing.

That second budget is what makes a drain of the primary's node interesting: the eviction is refused, and CloudNativePG responds by moving the primary elsewhere, after which the same eviction succeeds. This lab drains a replica's node instead, because that is the ordinary case and it has plenty to teach.

Find where everything is:

\`\`\`
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl get nodes
\`\`\`

One instance per node, and the \`psql-client\` Pod on one of them too. Pick a node holding a **replica** and write it down:

\`\`\`
REPLICA=$(kubectl get pods -l cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=replica \\
  -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $REPLICA -o jsonpath='{.spec.nodeName}{"\\n"}' > /root/drain-target.txt
echo "$REPLICA is on $(cat /root/drain-target.txt)"
\`\`\`

And check what that instance's storage is tied to, because it is the reason the next objective ends the way it does:

\`\`\`
kubectl get pvc $REPLICA -o jsonpath='{.metadata.annotations.volume\\.kubernetes\\.io/selected-node}{"\\n"}'
\`\`\`

The same node. A \`local-path\` volume is a directory on one machine, so this instance can only ever run there.`,
      hint: `\`kubectl get pdb\` is the short form. The ALLOWED DISRUPTIONS column is computed from \`minAvailable\` and how many Pods are currently healthy, so it changes as the cluster does.`,
      solution: `kubectl get poddisruptionbudgets
kubectl get pdb -o custom-columns=NAME:.metadata.name,MIN:.spec.minAvailable,SELECTOR:.spec.selector.matchLabels,ALLOWED:.status.disruptionsAllowed,HEALTHY:.status.currentHealthy
kubectl get pods -o wide -L cnpg.io/instanceRole
REPLICA=$(kubectl get pods -l cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=replica -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $REPLICA -o jsonpath='{.spec.nodeName}{"\\n"}' > /root/drain-target.txt
cat /root/drain-target.txt
kubectl get pvc $REPLICA -o jsonpath='{.metadata.annotations.volume\\.kubernetes\\.io/selected-node}{"\\n"}'`,
    },

    {
      id: 'drain-a-node',
      title: 'Drain it, and see what cannot follow',
      limitSec: 600,
      criteria: [
        'The node you drained will take no new Pods',
        'The instance that was on it is Pending, with nowhere to go',
        'The scheduler says so itself',
        'The cluster is degraded but still serving on 2 of 3',
      ],
      brief: `Run the drain and read its output carefully — it is unusually chatty and every line of it is telling you something you would want to know before doing this in production.

The replica is evicted, permitted by its budget. That much is the system working. What happens next is the interesting part: the Pod cannot come back, because its volume is a directory on the node you have just told Kubernetes not to use.

Watch for the other casualty too. A Pod with no controller behind it is deleted by a drain and never returns, and the drain warns you about it in one line that is very easy to scroll past.`,
      instructions: `Drain the node you recorded. \`--ignore-daemonsets\` is needed because DaemonSet Pods are managed per node and a drain cannot evict them meaningfully:

\`\`\`
NODE=$(cat /root/drain-target.txt)
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force
\`\`\`

Read the output. It cordons first, then evicts — the database replica, the operator's own Pod if it happened to be there, MetalLB's controller, and \`psql-client\`. That last one comes with a warning: **deleting Pods that declare no controller**. A Deployment's Pod is recreated elsewhere; a bare Pod is simply gone. It will not come back at the end of this lab either, which is a small demonstration of a large operational rule.

Now look at the cluster:

\`\`\`
kubectl get nodes
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster pg-cluster
\`\`\`

The node reads \`Ready,SchedulingDisabled\`. The evicted instance is \`Pending\` with no node assigned, and the cluster is two of three — degraded, still serving reads and writes from the other two.

Ask the scheduler why it cannot place it:

\`\`\`
PENDING=$(kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  --field-selector status.phase=Pending -o jsonpath='{.items[0].metadata.name}')
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=$PENDING
\`\`\`

\`0/3 nodes are available: 1 node(s) were unschedulable, 2 node(s) didn't match PersistentVolume's node affinity.\` Two reasons, and neither of them can be fixed by waiting. The one node that has this instance's data is the node you cordoned; the other two are ruled out by the volume.

This is the state a drain leaves a CloudNativePG cluster in when its storage is node-local: not broken, but stuck — and it will stay stuck for exactly as long as the node is cordoned. Which is fine if you are rebooting a node for ten minutes, and not fine at all if you are decommissioning it.`,
      hint: `\`--delete-emptydir-data\` and \`--force\` are what the drain asks for when it meets Pods with emptyDir volumes or no controller; without them it refuses to start at all and tells you which flag it wants.`,
      solution: `NODE=$(cat /root/drain-target.txt)
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force
kubectl get nodes
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster pg-cluster
PENDING=$(kubectl get pods -l cnpg.io/cluster=pg-cluster --field-selector status.phase=Pending -o jsonpath='{.items[0].metadata.name}')
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=$PENDING`,
    },

    {
      id: 'maintenance-window',
      title: 'Tell the operator the drain was deliberate',
      limitSec: 720,
      criteria: [
        '/root/maintenance-warning.txt records what the API server said about this field',
        'No instance is left on the node you drained',
        'Every node is schedulable again',
        'And the cluster is healthy with all 3 instances',
      ],
      brief: `The operator's default is patience: an instance whose node has gone away is left alone, because the node is probably coming back and its data is on it.

\`spec.nodeMaintenanceWindow\` is how you say otherwise. \`inProgress: true\` declares that a maintenance operation is happening, and \`reusePVC: false\` answers the question that follows — should the operator wait for that volume, or give up on it and build the instance again somewhere else, from the copies that are still running?

Set both and watch it choose. Then read the warning the API server sends back with your patch, because it points at where this feature has gone: the disruption budgets you read in the first objective now do most of what this field was invented for.`,
      instructions: `Declare the window, and keep what the API server says about it:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"nodeMaintenanceWindow":{"inProgress":true,"reusePVC":false}}}' 2>&1 \\
  | tee /root/maintenance-warning.txt
\`\`\`

\`Warning: Consider using '.spec.enablePDB' instead of the node maintenance window feature\`. The patch is accepted, and the operator tells you plainly that this is the older lever.

Watch what it does with the stranded instance:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get pvc
\`\`\`

Run those a few times over the next minute. The old claim is deleted, a new one is created on another node, a \`pg-cluster-N-join-*\` Pod runs \`pg_basebackup\` from the primary, and the instance comes back — on different storage, on a different node, with a full copy of the data. The cluster returns to three of three.

That is what \`reusePVC: false\` means in practice: the copy on the drained node is written off, and redundancy is restored by rebuilding rather than by waiting. The cost is a full re-clone over the network; the benefit is that a node can be decommissioned without the cluster staying degraded until somebody notices.

Now finish the maintenance properly. Bring the node back:

\`\`\`
kubectl uncordon $(cat /root/drain-target.txt)
kubectl get nodes
\`\`\`

And put the window away, because leaving it declared means the next unexpected node failure will be treated as planned maintenance:

\`\`\`
kubectl patch cluster pg-cluster --type=json -p '[{"op":"remove","path":"/spec/nodeMaintenanceWindow"}]'
kubectl get cluster pg-cluster -o jsonpath='{.spec.nodeMaintenanceWindow}{"\\n"}'
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
\`\`\`

Three instances, all Running, none of them on the node you drained — nothing moves back on its own, and nothing needs to.

Two things to take away. The modern lever is \`spec.enablePDB\`, and the budgets it controls are what make a drain safe by default; the maintenance window remains for the case those budgets cannot express, which is "this node is not coming back, stop waiting for it". And the reason any of this is delicate here is the storage: with node-local volumes an instance cannot move, so every drain is a choice between waiting and re-cloning. On network storage that follows the Pod, the same drain is unremarkable.`,
      hint: `The rebuild takes about a minute, most of it \`pg_basebackup\` copying the database. If the cluster still reads two of three, look for a \`-join-\` Pod in \`kubectl get pods\` — that is the copy in progress.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"nodeMaintenanceWindow":{"inProgress":true,"reusePVC":false}}}' 2>&1 | tee /root/maintenance-warning.txt
sleep 60
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get pvc
kubectl uncordon $(cat /root/drain-target.txt)
kubectl patch cluster pg-cluster --type=json -p '[{"op":"remove","path":"/spec/nodeMaintenanceWindow"}]'
kubectl get nodes
kubectl get cluster pg-cluster`,
    },
  ],
}
