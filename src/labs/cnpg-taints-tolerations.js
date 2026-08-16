// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md):
// tainting a node NoSchedule left the instance already running on it untouched; deleting that
// instance left it Pending with the scheduler reporting `0/3 nodes are available: 1 node(s)
// had untolerated taint(s), 2 node(s) didn't match PersistentVolume's node affinity` — both
// halves mattering, because a local-path volume pins the instance to the very node that is
// now tainted. Adding a toleration under spec.affinity.tolerations scheduled it back onto the
// still-tainted node within a minute, and the operator wrote the toleration onto the Pod
// verbatim.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster with one
// instance per node, the cnpg plugin, a client Pod and the toolbox are this lab's starting
// state, built by its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab
// content contract").

export const cnpgTaintsTolerations = {
  id: 'cnpg-taints-tolerations',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, one instance per node, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster with one instance on each of the three nodes, and no tolerations declared anywhere in its spec',
      'Each instance on a local-path PersistentVolumeClaim, which pins it to the node it was first scheduled to',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Taints are how a node says who is allowed to run on it, and tolerations are how a workload answers. You will taint a node out of the scheduling pool and find that the database already on it carries on regardless, then delete that instance and watch it become genuinely unschedulable — for two reasons at once, only one of which is the taint. Then you will grant the cluster a toleration and get it back. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'taint-a-node',
      title: 'Take a node out of the pool',
      limitSec: 480,
      criteria: [
        'A node carries a maintenance taint with the NoSchedule effect',
        'All 3 instances are still Running — NoSchedule does not evict anything',
        '/root/tainted-node.txt was written',
        'It names the node you tainted',
      ],
      brief: `A taint marks a node as unsuitable, and the effect decides how strongly. \`NoSchedule\` refuses *new* placements and does nothing else — it is a statement about the future, not an eviction order. \`NoExecute\` is the one that removes what is already running.

That distinction is the first thing to prove, because reaching for a taint expecting a node to drain is a common and expensive misunderstanding.

Taint the node hosting \`pg-cluster-2\` with \`NoSchedule\`, then look at the Pods and find all three still Running, including the one on the node you just marked. Record which node you chose.`,
      instructions: `Work in the **toolbox** tab. Find out which node each instance is on:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get nodes
\`\`\`

One instance per node. Take the node holding \`pg-cluster-2\` and taint it:

\`\`\`
NODE=$(kubectl get pod pg-cluster-2 -o jsonpath='{.spec.nodeName}')
echo "tainting $NODE"
kubectl taint node $NODE maintenance=planned:NoSchedule
\`\`\`

Record it, because the later objectives refer back to it:

\`\`\`
echo $NODE > /root/tainted-node.txt
cat /root/tainted-node.txt
\`\`\`

Now look at what that did to the running database:

\`\`\`
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get cluster pg-cluster
\`\`\`

Nothing. All three instances Running, the cluster healthy, and \`pg-cluster-2\` still sitting on the node you just declared unsuitable. \`NoSchedule\` is only consulted when the scheduler is placing a Pod, and nobody is placing this one.

See the taint on the node itself:

\`\`\`
kubectl get node $NODE -o json | jq -c '.spec.taints'
kubectl describe node $NODE | grep -A2 Taints
\`\`\`

Confirm the database has not noticed either:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE taint_demo (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO taint_demo (note) VALUES ('after-taint') RETURNING *;"
\`\`\``,
      hint: `\`kubectl taint node <name> key=value:Effect\` adds one; the same command with a trailing \`-\` (\`maintenance=planned:NoSchedule-\`) removes it. Do not remove it yet — the next objective needs it.`,
      solution: `kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
NODE=$(kubectl get pod pg-cluster-2 -o jsonpath='{.spec.nodeName}')
kubectl taint node $NODE maintenance=planned:NoSchedule
echo $NODE > /root/tainted-node.txt
cat /root/tainted-node.txt
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get node $NODE -o json | jq -c '.spec.taints'
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE taint_demo (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO taint_demo (note) VALUES ('after-taint') RETURNING *;"`,
    },

    {
      id: 'strand-an-instance',
      title: 'Strand an instance, and read why',
      limitSec: 600,
      criteria: [
        'Exactly one instance is Pending, unable to be scheduled',
        'The scheduler blames an untolerated taint',
        'The cluster is degraded but still serving on 2 of 3',
      ],
      brief: `The taint costs nothing until something needs placing. Delete the instance on the tainted node and it needs placing.

Watch it go Pending and stay there, then read the scheduler's own explanation rather than guessing at it. The message names **two** reasons across the three nodes, and the second is the more interesting one: the other nodes are refused not by any taint but by the volume.

That is the interaction worth understanding. A \`local-path\` claim pins its instance to the node the volume was created on. So this Pod may only go to one node — and that is precisely the node you have just declared unsuitable. Neither fact alone would strand it; together they do.`,
      instructions: `Delete the instance on the tainted node:

\`\`\`
kubectl delete pod pg-cluster-2 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
\`\`\`

\`pg-cluster-2\` is \`Pending\` with no node assigned. Ask the scheduler why:

\`\`\`
kubectl get events --field-selector reason=FailedScheduling --sort-by=.lastTimestamp | tail -3
\`\`\`

Read that message carefully:

\`0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match PersistentVolume's node affinity.\`

Three nodes, and every one of them refused — for two different reasons. One node is out because of your taint. The other two are out because the PersistentVolume this instance needs exists only on the tainted node, and a \`local-path\` volume cannot be attached anywhere else.

See the pinning for yourself:

\`\`\`
kubectl get pvc pg-cluster-2 -o json | jq -r '.metadata.annotations["volume.kubernetes.io/selected-node"]'
\`\`\`

The same node you tainted. That annotation is the whole story of why moving on is not an option.

Now look at what it costs the database:

\`\`\`
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO taint_demo (note) VALUES ('while-stranded') RETURNING *;"
\`\`\`

Two of three ready and still taking writes. Degraded, not down — the cluster is short of redundancy and completely functional, which is exactly the state a node under maintenance should produce.`,
      hint: `The Pending Pod is the expected result, not a failure on your part. If \`kubectl get events\` shows nothing, give the scheduler a few more seconds — it records the failure after its first placement attempt.`,
      solution: `kubectl delete pod pg-cluster-2 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get events --field-selector reason=FailedScheduling --sort-by=.lastTimestamp | tail -3
kubectl get pvc pg-cluster-2 -o json | jq -r '.metadata.annotations["volume.kubernetes.io/selected-node"]'
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO taint_demo (note) VALUES ('while-stranded') RETURNING *;"`,
    },

    {
      id: 'tolerate-it',
      title: 'Grant a toleration and get it back',
      limitSec: 600,
      criteria: [
        'The Cluster declares a toleration for the maintenance taint',
        'The node is still tainted — the toleration is what changed, not the node',
        'All 3 instances are scheduled and the cluster is healthy again',
      ],
      brief: `A toleration is the workload's side of the conversation: this taint does not apply to me.

Declare one on the Cluster under \`spec.affinity.tolerations\` and the operator writes it onto every instance Pod it creates. The stranded instance is scheduled onto the node it was always pinned to, and the cluster returns to healthy.

The detail to check at the end is that the node is *still tainted*. Nothing about it changed — what changed is who is prepared to run there. That is the whole point of the mechanism: the node keeps its warning, and a workload that knows what it is doing may ignore it.`,
      instructions: `Give the cluster a toleration matching the taint you set:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {
    "affinity": {
      "tolerations": [
        {"key":"maintenance","operator":"Equal","value":"planned","effect":"NoSchedule"}
      ]
    }
  }
}'
\`\`\`

Wait for the operator to recreate the Pod with it:

\`\`\`
sleep 60
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get cluster pg-cluster
\`\`\`

Scheduled and healthy again — onto the tainted node, because that is where its volume lives.

Confirm the toleration reached the Pod, since that is the operator's job rather than yours:

\`\`\`
kubectl get pod pg-cluster-2 -o json | jq -c '.spec.tolerations[] | select(.key=="maintenance")'
\`\`\`

Written verbatim from the Cluster spec. And check the node:

\`\`\`
NODE=$(cat /root/tainted-node.txt)
kubectl get node $NODE -o json | jq -c '.spec.taints'
\`\`\`

Still tainted. You did not fix the node; you gave one workload permission to ignore it.

Confirm the data came through all of this untouched:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM taint_demo ORDER BY id;"
\`\`\`

Worth being clear about what this pattern is and is not for. A toleration is right when a node is reserved for a purpose and your database is that purpose. It is the wrong answer to a node marked for maintenance — there, tolerating the taint means insisting on running exactly where somebody has said not to. Which node your instance can actually move to is a separate question entirely, and on \`local-path\` volumes the answer is none.`,
      hint: `\`operator: Equal\` with a \`value\` matches that exact taint; \`operator: Exists\` with just the key tolerates any value for it. Match the taint you actually set.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"affinity":{"tolerations":[{"key":"maintenance","operator":"Equal","value":"planned","effect":"NoSchedule"}]}}}'
sleep 60
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get cluster pg-cluster
kubectl get pod pg-cluster-2 -o json | jq -c '.spec.tolerations[] | select(.key=="maintenance")'
NODE=$(cat /root/tainted-node.txt)
kubectl get node $NODE -o json | jq -c '.spec.taints'
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM taint_demo ORDER BY id;"`,
    },
  ],
}
