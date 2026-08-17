// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a
// Cluster nobody has touched already reads `podAntiAffinityType: preferred`, defaulted in by
// the operator, and its Pods carry a generated preferred anti-affinity term with weight 100 on
// `kubernetes.io/hostname`. Declaring `spec.affinity.nodeSelector` rolled the cluster and left
// the first replica it recreated Pending — `0/3 nodes are available: 1 node(s) didn't match
// PersistentVolume's node affinity, 2 node(s) didn't match Pod's node affinity/selector` —
// until the remaining nodes were labelled, after which it scheduled in about 25 seconds.
// Turning the anti-affinity into a requirement over a topology every node shares stranded an
// instance again, this time with `1 node(s) didn't match pod anti-affinity rules`.
//
// Worked from the `toolbox` tab, which carries jq (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster with one
// instance per node, a client Pod and the toolbox are this lab's starting state, built by its
// own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgNodeSelector = {
  id: 'cnpg-node-selector',
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
      'A healthy 3-instance Cluster named pg-cluster with one instance on each of the three nodes, and no node selector anywhere in its spec',
      'Each instance on a local-path PersistentVolumeClaim, which pins it to the node it was first scheduled to',
      'Three unlabelled nodes — nothing yet marks any of them as somewhere a database should run',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Nobody told this cluster where to run, and yet its three instances are spread neatly one per node. You will find the rule that did that — written by the operator, not by you — then take control of placement yourself: confine the cluster to nodes you choose with a node selector, and turn the operator\'s spreading preference into a hard requirement to see what each of them refuses. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'read-defaults',
      title: 'The placement rules nobody wrote',
      limitSec: 420,
      criteria: [
        'All 3 instances are Running, one on each node',
        'The Cluster asks for preferred anti-affinity — a value nobody wrote',
        '/root/topology-key.txt was written',
        'It names the topology key the generated rule spreads on',
      ],
      brief: `Three instances, three nodes, one each. That is not luck and it is not the scheduler being tidy — CloudNativePG asks for it.

Before changing any placement rule, read the one that is already there. Two things are worth separating: what the **Cluster** says, and what the **Pod** says. The Cluster carries a single word, \`preferred\`, that you never typed — the operator's admission webhook filled it in. The Pod carries the whole rule that word expands into, and that is where the interesting part lives: which label the spread is measured across.

That label is the topology key, and it decides what "spread out" even means. Spreading across hosts is a different promise from spreading across racks or zones. Record which one is in force.`,
      instructions: `Work in the **toolbox** tab. Start with where the instances actually are:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get nodes
\`\`\`

One instance per node. Now ask the Cluster what it asked for:

\`\`\`
kubectl get cluster pg-cluster -o json | jq -c '.spec.affinity'
\`\`\`

It says \`podAntiAffinityType\` is \`preferred\`. Nobody wrote that — the operator's webhook defaults it in when the Cluster is created, which is why placement behaves sensibly on a manifest that never mentions scheduling at all.

The rule itself is not in the Cluster. It is on the Pods, generated from that one word:

\`\`\`
kubectl get pod pg-cluster-1 -o json | jq '.spec.affinity'
\`\`\`

Read it slowly. It is a **preferred** anti-affinity term with a weight of 100, whose label selector matches the other instances of this same cluster, measured across \`topologyKey: kubernetes.io/hostname\`. In words: *try hard not to put two instances of pg-cluster on the same host.* A preference, not a rule — with only three nodes and three instances the scheduler can satisfy it completely, so it does.

Record the topology key, because the last objective changes it:

\`\`\`
kubectl get pod pg-cluster-1 -o json \\
  | jq -r '.spec.affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].podAffinityTerm.topologyKey' \\
  > /root/topology-key.txt
cat /root/topology-key.txt
\`\`\`

One last thing worth seeing before you start changing rules — where each instance's storage is:

\`\`\`
kubectl get pvc -o json | jq -r '.items[] | [.metadata.name, .metadata.annotations["volume.kubernetes.io/selected-node"]] | @tsv'
\`\`\`

Every claim names a node. These are \`local-path\` volumes, which live in a directory on one machine, so an instance is not free to move: it can only be scheduled where its data already is. Hold on to that — it is half the reason for everything that happens next.`,
      hint: `\`jq -c\` prints compact JSON on one line, which is enough for \`.spec.affinity\` on the Cluster. The Pod's rule is nested several levels deep — print it in full first, then reach for the exact path.`,
      solution: `kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get cluster pg-cluster -o json | jq -c '.spec.affinity'
kubectl get pod pg-cluster-1 -o json | jq '.spec.affinity'
kubectl get pod pg-cluster-1 -o json | jq -r '.spec.affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].podAffinityTerm.topologyKey' > /root/topology-key.txt
cat /root/topology-key.txt
kubectl get pvc -o json | jq -r '.items[] | [.metadata.name, .metadata.annotations["volume.kubernetes.io/selected-node"]] | @tsv'`,
    },

    {
      id: 'node-selector',
      title: 'Confine the cluster to nodes you choose',
      limitSec: 720,
      criteria: [
        'The Cluster declares a nodeSelector',
        'Every instance Pod carries it, written there by the operator',
        'The scheduler refused a Pod for not matching it',
        'All 3 instances are Running again and the cluster is healthy',
      ],
      brief: `A node selector is the bluntest placement tool there is: a set of labels a node must have before this workload may be scheduled onto it. No weights, no preferences, no fallback. Either the node matches or it is not a candidate.

Set one on the Cluster and the operator writes it onto every instance Pod it creates. That last part matters more than it sounds, because it means the change takes effect through a **rolling update** — the operator replaces each Pod so the new Pod carries the new rule.

Label one node, confine the cluster to it, and watch what happens to the first instance the operator recreates. It will not come back, and the scheduler will tell you exactly why in a sentence that names two different problems. Then fix it by changing the nodes rather than the database.`,
      instructions: `Label just the control-plane node as somewhere databases may run:

\`\`\`
SERVER=$(kubectl get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}')
kubectl label node $SERVER workload=database
kubectl get nodes -L workload
\`\`\`

One node labelled, two not. Now confine the cluster to nodes carrying that label:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"affinity": {"nodeSelector": {"workload": "database"}}}
}'
\`\`\`

The operator begins a rolling update, because the Pods it made no longer match the Pods it would make now. Watch it:

\`\`\`
sleep 45
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
\`\`\`

One instance is \`Pending\` with no node, and the rollout has stopped there — the operator will not take a second instance away while the cluster is short of one. Ask the scheduler why that Pod is stuck, naming the Pod so you get its reason and nobody else's:

\`\`\`
PENDING=$(kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  --field-selector status.phase=Pending -o jsonpath='{.items[0].metadata.name}')
echo "stuck: $PENDING"
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=$PENDING
\`\`\`

Two reasons across three nodes: two nodes **didn't match Pod's node affinity/selector** — they have no \`workload\` label — and one node **didn't match PersistentVolume's node affinity**, which is the labelled node, refusing this Pod because the instance's data lives elsewhere. The selector took away every node except the one its volume cannot use.

Confirm the operator really stamped the selector onto the Pod, since that is its doing and not yours:

\`\`\`
kubectl get pod $PENDING -o jsonpath='{.spec.nodeSelector}'; echo
\`\`\`

Now fix it from the other side. Nothing is wrong with the database; what is wrong is that not enough nodes are marked as places a database may run:

\`\`\`
kubectl label node -l '!node-role.kubernetes.io/control-plane' workload=database
kubectl get nodes -L workload
sleep 45
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
\`\`\`

The stranded Pod schedules within seconds of the label appearing, the rollout finishes, and the cluster is healthy again — with the node selector still in place. You did not relax the database's requirement; you satisfied it.`,
      hint: `The rolling update takes about a minute in total, and it deliberately stalls while an instance is Pending. If the cluster still reads "Waiting for the instances to become active" after you label the remaining nodes, give it another 30 seconds — the last Pod to roll is the primary.`,
      solution: `SERVER=$(kubectl get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}')
kubectl label node $SERVER workload=database
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"affinity":{"nodeSelector":{"workload":"database"}}}}'
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
PENDING=$(kubectl get pods -l cnpg.io/cluster=pg-cluster --field-selector status.phase=Pending -o jsonpath='{.items[0].metadata.name}')
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=$PENDING
kubectl get pod $PENDING -o jsonpath='{.spec.nodeSelector}'; echo
kubectl label node -l '!node-role.kubernetes.io/control-plane' workload=database
sleep 45
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase`,
    },

    {
      id: 'required-anti-affinity',
      title: 'Turn the preference into a requirement',
      limitSec: 720,
      criteria: [
        'Anti-affinity is a requirement now, not a preference',
        'The scheduler refused a Pod for not matching pod anti-affinity rules',
        'The topology key is back to kubernetes.io/hostname',
        'All 3 instances are Running again, one per node',
      ],
      brief: `\`preferred\` means the scheduler tries; \`required\` means it refuses. On a cluster with a node per instance the two behave identically, which is exactly why the difference is usually discovered at the worst possible moment.

Make the spread a requirement, and at the same time measure it across a topology every one of your nodes shares. That combination is not a contrived trap — it is what "spread my instances across availability zones" turns into when the cluster is single-zone, and it is one of the most common ways a production database ends up unable to place an instance.

There is only one domain, and only one instance may occupy a domain, so two of the three have nowhere to go. Read the scheduler's refusal, then put the topology key back and watch the same requirement become satisfiable again — because with hosts as the topology there are three domains rather than one.`,
      instructions: `Make it a requirement, and measure it across the operating system rather than the host:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"affinity": {"podAntiAffinityType": "required", "topologyKey": "kubernetes.io/os"}}
}'
\`\`\`

Every node in this cluster reports \`kubernetes.io/os=linux\`, so all three are one topology domain. Watch the rollout run into that:

\`\`\`
sleep 45
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
\`\`\`

The first instance the operator recreated is \`Pending\`, and this time the reason is different:

\`\`\`
PENDING=$(kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  --field-selector status.phase=Pending -o jsonpath='{.items[0].metadata.name}')
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=$PENDING
\`\`\`

**1 node(s) didn't match pod anti-affinity rules** — that is the node this instance's volume is on, refusing it because a sibling instance is already inside the same topology domain. The other two nodes refuse it for the storage reason you have already met.

Look at the rule on the Pod that is stuck, since it is the only one the operator has rebuilt so far:

\`\`\`
kubectl get pod $PENDING -o json | jq -c '.spec.affinity.podAntiAffinity | keys'
kubectl get pod $PENDING -o json \\
  | jq -c '.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution'
\`\`\`

The whole term has moved from the \`preferred…\` list to the \`required…\` list and lost its weight — there is nothing to weigh when the answer is yes or no — and its topology key is now \`kubernetes.io/os\`.

The two instances still running have not been rebuilt, so they are still carrying the old rule:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json \\
  | jq -r '.items[] | [.metadata.name, (.spec.affinity.podAntiAffinity | keys[0])] | @tsv'
\`\`\`

A mid-rollout cluster genuinely disagrees with itself about its own scheduling policy, and stays that way for as long as the rollout is stuck.

Now put the topology key back, keeping the requirement:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"affinity": {"topologyKey": "kubernetes.io/hostname"}}
}'
sleep 45
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
\`\`\`

Healthy again, one instance per node, and the anti-affinity is still a hard requirement — which is now satisfiable, because there are three host domains and three instances.

That is the judgement the setting asks for. \`required\` is the honest choice when co-locating two instances would defeat the point of having them, and it costs you the ability to run degraded on fewer nodes than you have instances. \`preferred\` keeps the database running through a node shortage and quietly gives up the spread when it has to. Neither is wrong; picking one without knowing which is.`,
      hint: `Both patches are merge patches on \`spec.affinity\`, so the second one only needs the field it changes — \`podAntiAffinityType\` stays \`required\` from the first.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"affinity":{"podAntiAffinityType":"required","topologyKey":"kubernetes.io/os"}}}'
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
PENDING=$(kubectl get pods -l cnpg.io/cluster=pg-cluster --field-selector status.phase=Pending -o jsonpath='{.items[0].metadata.name}')
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=$PENDING
kubectl get pod $PENDING -o json | jq -c '.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution'
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"affinity":{"topologyKey":"kubernetes.io/hostname"}}}'
sleep 45
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase`,
    },
  ],
}
