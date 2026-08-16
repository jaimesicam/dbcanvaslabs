// Real object names, image tag, namespace and CRD count below are confirmed live
// against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md) — grading runs
// server-side, against the real cluster, via POST /api/attempts/{id}/check.
//
// Self-contained, like every lab here: it describes its own starting state and never
// refers to another lab (see CLAUDE.md, "Lab content contract").

export const cnpgOperatorInstall = {
  id: 'cnpg-operator-install',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  // Shown while the environment builds — what `server/attempts.go` really provisions for
  // this lab, and what it deliberately leaves undone.
  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, thrown away when you finish. Nothing is simulated: every command you type runs against real containers. Expect a few minutes, most of it spent pulling and side-loading container images.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 release source downloaded and unpacked to /root/cloudnative-pg on k3d-server — staged only, deliberately not applied',
      'The CNPG operator and PostgreSQL images pre-loaded into all three nodes, so nothing has to download them mid-lab',
    ],
    yourJob:
      'No PostgreSQL operator is installed, and no database is running. You will survey the cluster, install CloudNativePG yourself from the staged release manifest, and confirm what actually ended up running rather than what you asked for.',
  },

  tasks: [
    {
      id: 'survey',
      title: 'Survey the cluster before installing anything',
      limitSec: 300,
      criteria: [
        'All 3 nodes report Ready',
        'Exactly one node is control-plane',
        '/root/control-plane.txt was written',
        'It names the control-plane node',
      ],
      brief: `Get your bearings before you install anything: confirm the cluster is really up, and work out which of the three nodes is the control-plane.

Any terminal tab will do — all three nodes have \`kubectl\` and a kubeconfig. List the nodes, check that all three read Ready, then write the control-plane node's name to \`/root/control-plane.txt\`.

This is more than bookkeeping: k3d leaves its control-plane node schedulable, so PostgreSQL instances can and will land there too.`,
      instructions: `A fresh 3-node k3d cluster (1 control-plane + 2 workers) is up, running k3s — no operator installed yet. Before you install anything, confirm what you're working with.

Open a terminal on any of the three nodes and list them:

\`\`\`
kubectl get nodes -o wide
\`\`\`

All three should read **Ready**. Exactly one has the \`control-plane\` role — k3d control-plane nodes are still schedulable for ordinary pods (no taint), which matters later: CNPG will happily land an instance there too.

Record which node is control-plane, exactly as \`kubectl\` names it:

\`\`\`
echo <node-name> > /root/control-plane.txt
\`\`\`

Then move on to the next objective.`,
      hint: `The ROLES column reads \`control-plane\` for exactly one node and \`<none>\` for the other two. Copy the NAME column's value exactly — it's the real container name, not a shortened label.`,
      solution: `kubectl get nodes -o wide
echo $(kubectl get nodes -o jsonpath='{.items[?(@.metadata.labels.node-role\\.kubernetes\\.io/control-plane=="true")].metadata.name}') > /root/control-plane.txt`,
    },

    {
      id: 'install-operator',
      title: 'Install the CloudNativePG operator',
      limitSec: 480,
      criteria: [
        'clusters.postgresql.cnpg.io CRD is Established',
        'CNPG CRDs are registered (11 of 11)',
        'Operator pod is Running (1/1)',
      ],
      brief: `Install the CloudNativePG operator into the cluster, from the release manifest that was staged on **k3d-server** when this environment was built.

Switch to the \`k3d-server\` tab — that is the only node the source was unpacked on. Read the manifest, apply it with \`--server-side\`, then wait until the operator pod in the \`cnpg-system\` namespace reports **1/1 Running** before you check.

Registering CRDs is not the same as being usable: that one pod also serves the admission webhook every \`Cluster\` resource gets validated through.`,
      instructions: `CNPG's release source is already staged on the \`k3d-server\` node at \`/root/cloudnative-pg\` — the same tagged checkout the project's own Quickstart and e2e tests install from. Open the \`k3d-server\` terminal tab, and take a look at what you're about to apply:

\`\`\`
cat /root/cloudnative-pg/releases/cnpg-1.30.0.yaml | head -20
\`\`\`

Then apply it — this is the real, standard installation method (no Helm, no chart repo required):

\`\`\`
kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
\`\`\`

That creates the \`cnpg-system\` namespace, every \`postgresql.cnpg.io\` CRD, RBAC, and a single-replica operator Deployment named **cnpg-controller-manager**. Watch it come up:

\`\`\`
kubectl -n cnpg-system get pods
\`\`\`

Wait for **1/1 Running** before moving on — that same pod serves CNPG's admission webhook, and a \`Cluster\` applied before the webhook is actually serving fails outright with \`no endpoints available for service "cnpg-webhook-service"\`.`,
      hint: `If the pod is stuck in \`ContainerCreating\`, give it a few more seconds — it's still pulling \`ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0\`.`,
      solution: `kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
kubectl -n cnpg-system get pods`,
    },

    {
      id: 'verify-crds',
      title: 'Confirm every CNPG CRD registered',
      limitSec: 300,
      criteria: [
        'grep finds 11 cnpg.io CRDs',
        '/root/crd-count.txt was written',
        'It records the number 11',
      ],
      brief: `Confirm the install registered **every** CNPG custom resource definition, not just some of them.

List the CRDs in the \`cnpg.io\` API group, count them, and record the count in \`/root/crd-count.txt\`. There are 11 — anything less means the apply did not fully land.`,
      instructions: `The manifest installs 11 CRDs under the \`postgresql.cnpg.io\` API group — \`clusters\`, \`backups\`, \`scheduledbackups\`, \`poolers\`, and more. List them:

\`\`\`
kubectl get crd | grep cnpg.io
\`\`\`

Now count them:

\`\`\`
kubectl get crd | grep -c cnpg.io
\`\`\`

Record the count:

\`\`\`
kubectl get crd | grep -c cnpg.io > /root/crd-count.txt
\`\`\``,
      hint: `If you get fewer than 11, the install probably hasn't finished landing yet — re-check \`kubectl -n cnpg-system get pods\` first.`,
      solution: `kubectl get crd | grep -c cnpg.io > /root/crd-count.txt`,
    },

    {
      id: 'verify-version',
      title: 'Confirm the running operator version',
      limitSec: 300,
      criteria: [
        'Operator Deployment image is ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0',
        '/root/operator-image.txt was written',
      ],
      brief: `Confirm which operator build is really running — read it off the Deployment, not off the file name you applied.

Print the operator Deployment's container image and record the full reference — registry, repository and tag — in \`/root/operator-image.txt\`.

This is the check a promotion pipeline runs before trusting a cluster: the version you asked for and the version actually reconciling your databases are two separate facts.`,
      instructions: `Before pointing anyone at this cluster, confirm exactly which operator build is running rather than trusting the manifest version alone:

\`\`\`
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}'
\`\`\`

Record the full image reference it prints (registry, repo and tag):

\`\`\`
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}' > /root/operator-image.txt
\`\`\`

This is the same check a promotion pipeline would run before trusting a freshly-provisioned cluster — the manifest version you applied and the operator image tag actually running are worth confirming independently, not assumed to match.`,
      hint: `The image reference has three parts: registry (\`ghcr.io\`), repository (\`cloudnative-pg/cloudnative-pg\`) and tag (\`1.30.0\`) — write down all three, not just the tag.`,
      solution: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}' > /root/operator-image.txt`,
    },
  ],
}
