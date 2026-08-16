// The Eviction API's responses — accepted with no budget, `TooManyRequests` under a
// PodDisruptionBudget that cannot spare the only replica, accepted again once a second
// replica exists — are confirmed live against a real K3D + CloudNativePG deploy (server/,
// see LABORATORY.md). Grading reads the budget's own disruptionsAllowed and the responses
// the learner captured.
//
// Self-contained, like every lab here: the operator, a healthy cluster and a client Pod are
// this lab's starting state, built by its own provisioning. No reference to any other lab
// (see CLAUDE.md, "Lab content contract").

export const cnpgOperatorEviction = {
  id: 'cnpg-operator-eviction',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real CloudNativePG operator and a real database for it to manage, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace as a single replica, with no PodDisruptionBudget of its own',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state"',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to keep querying from',
    ],
    yourJob:
      'Eviction is not deletion: it is a request that the cluster may refuse, and it is what a node drain issues for every Pod on a node. You will evict the operator through that API and watch it be allowed, then add a PodDisruptionBudget and watch the same request be refused — the trap that leaves a single-replica operator blocking a node drain indefinitely — and finally make it evictable again without weakening the budget.',
  },

  tasks: [
    {
      id: 'evict-the-operator',
      title: 'Evict the operator through the API that drains use',
      limitSec: 420,
      criteria: [
        '/root/eviction-result.txt was written',
        'It shows the API server accepting the eviction',
        'A replacement operator Pod is running',
        'The database was untouched — it is still serving',
      ],
      brief: `Evicting a Pod is not the same as deleting one. Deletion is unconditional; eviction is a *request* to the API server, which consults any PodDisruptionBudget covering that Pod and may refuse.

It matters because eviction is what \`kubectl drain\` issues for every Pod on a node. Understanding what the API answers is how you predict whether a drain will complete or hang.

There is no budget here yet, so this first request will be accepted: capture the response in \`/root/eviction-result.txt\`, then watch the Deployment replace the Pod while the database carries on.`,
      instructions: `There is no \`kubectl evict\`, so the request goes to the Pod's eviction subresource directly. Build it for the operator Pod:

\`\`\`
POD=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
echo "operator pod: $POD"
cat > /tmp/evict.json <<EOF
{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"$POD","namespace":"cnpg-system"}}
EOF
\`\`\`

Send it, and keep the answer:

\`\`\`
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json > /root/eviction-result.txt 2>&1
cat /root/eviction-result.txt
\`\`\`

The API server replies \`{"kind":"Status", ... "status":"Success","code":201}\` — the eviction was permitted, and the Pod is now terminating.

Watch what follows, and what does not:

\`\`\`
kubectl -n cnpg-system get pods
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT count(*) FROM pg_stat_activity;"
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

A new operator Pod within seconds, and a database that never noticed — the operator is not on the data path.`,
      hint: `The eviction subresource is \`/api/v1/namespaces/<ns>/pods/<pod>/eviction\`, and \`kubectl create --raw\` is how to POST to it. Capture both streams with \`> file 2>&1\`.`,
      solution: `POD=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
cat > /tmp/evict.json <<EOF
{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"$POD","namespace":"cnpg-system"}}
EOF
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json > /root/eviction-result.txt 2>&1
cat /root/eviction-result.txt
kubectl -n cnpg-system get pods
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT count(*) FROM pg_stat_activity;"`,
    },

    {
      id: 'block-it-with-a-pdb',
      title: 'Add a budget, and watch the same request be refused',
      limitSec: 420,
      criteria: [
        'A PodDisruptionBudget named cnpg-operator-pdb exists',
        'It reports 0 allowed disruptions — the single operator replica cannot be spared',
        '/root/eviction-refused.txt was written',
        'It captured the API server refusing the eviction',
      ],
      brief: `Now add the protection people reach for, and see what it actually does.

A PodDisruptionBudget saying \`minAvailable: 1\` over a Deployment that runs exactly one replica is a contradiction in practice: keeping one available and taking one away cannot both happen, so the budget permits zero disruptions. Look at the budget's own \`ALLOWED DISRUPTIONS\` column and it says so plainly.

Send the identical eviction request again and capture the refusal. This is the failure mode worth recognising: a node drain that never finishes, blocked on a Pod that is protected into immobility.`,
      instructions: `Create the budget over the operator's own label:

\`\`\`
cat > /root/pdb.yaml <<'EOF'
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cnpg-operator-pdb
  namespace: cnpg-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: cloudnative-pg
EOF
kubectl apply -f /root/pdb.yaml
kubectl -n cnpg-system get pdb
\`\`\`

Read the ALLOWED DISRUPTIONS column: **0**. With one replica and a floor of one, nothing can be taken away.

Send the same request as before:

\`\`\`
POD=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
cat > /tmp/evict.json <<EOF
{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"$POD","namespace":"cnpg-system"}}
EOF
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json > /root/eviction-refused.txt 2>&1
cat /root/eviction-refused.txt
\`\`\`

\`Error from server (TooManyRequests): Cannot evict pod as it would violate the pod's disruption budget.\`

The Pod is untouched:

\`\`\`
kubectl -n cnpg-system get pods
\`\`\`

A drain of this node would now retry that eviction forever. Deleting the Pod outright would still work — deletion ignores budgets entirely — which is exactly why drains use eviction and not deletion.`,
      hint: `The PDB has to select the operator Pod: \`app.kubernetes.io/name: cloudnative-pg\` in the \`cnpg-system\` namespace. Check \`kubectl -n cnpg-system get pdb\` shows a non-zero number under CURRENT before trying the eviction.`,
      solution: `cat > /root/pdb.yaml <<'EOF'
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cnpg-operator-pdb
  namespace: cnpg-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: cloudnative-pg
EOF
kubectl apply -f /root/pdb.yaml
kubectl -n cnpg-system get pdb
POD=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
cat > /tmp/evict.json <<EOF
{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"$POD","namespace":"cnpg-system"}}
EOF
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json > /root/eviction-refused.txt 2>&1
cat /root/eviction-refused.txt`,
    },

    {
      id: 'make-it-evictable',
      title: 'Make it evictable without weakening the budget',
      limitSec: 420,
      criteria: [
        'The operator now runs more than one replica',
        'The PodDisruptionBudget now allows a disruption',
        '/root/eviction-allowed.txt was written',
        'An eviction succeeded with the budget still in place, and the database never noticed',
      ],
      brief: `The instinct at this point is to delete the budget. Do the other thing instead: give it something to spare.

Scale the operator to two replicas and the same \`minAvailable: 1\` becomes satisfiable — one can be evicted while one remains. Watch \`ALLOWED DISRUPTIONS\` change from 0 to 1 without touching the budget at all.

Then evict again, with the budget still in force, and see it accepted. That is the resolution of the trap: the budget was never the problem, the single replica was.`,
      instructions: `Scale the operator up:

\`\`\`
kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=2
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get pods -o wide
\`\`\`

Look at the budget again — unchanged, but now satisfiable:

\`\`\`
kubectl -n cnpg-system get pdb
\`\`\`

ALLOWED DISRUPTIONS has become 1. Send the same eviction request one more time:

\`\`\`
POD=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
cat > /tmp/evict.json <<EOF
{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"$POD","namespace":"cnpg-system"}}
EOF
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json > /root/eviction-allowed.txt 2>&1
cat /root/eviction-allowed.txt
\`\`\`

Accepted. And the database, throughout all three objectives:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;"
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Untouched, with restart counts still at zero.`,
      hint: `Re-read the Pod name after scaling: the one you evicted earlier no longer exists, and evicting a Pod that is already gone returns a not-found error rather than a budget refusal.`,
      solution: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=2
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get pdb
POD=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
cat > /tmp/evict.json <<EOF
{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"$POD","namespace":"cnpg-system"}}
EOF
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json > /root/eviction-allowed.txt 2>&1
cat /root/eviction-allowed.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;"`,
    },
  ],
}
