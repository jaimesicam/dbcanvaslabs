// The namespace contents, webhook configurations, leader-election Lease and the API
// server's refusal when the webhook has no endpoints are confirmed live against a real K3D
// + CloudNativePG deploy (server/, see LABORATORY.md). Grading reads those objects and the
// error the learner captured.
//
// Self-contained, like every lab here: the operator and a healthy cluster are this lab's
// starting state, built by its own provisioning. No reference to any other lab (see
// CLAUDE.md, "Lab content contract").

export const cnpgOperatorDeployment = {
  id: 'cnpg-operator-deployment',
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
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built — with its Deployment, its webhook Service, its RBAC, its two admission webhook configurations and its leader-election Lease',
      'A healthy 3-instance Cluster named pg-cluster, so there is something for the operator to be managing while you take it apart',
    ],
    yourJob:
      'Nothing here needs installing or fixing. What you do not yet know is what an installed operator actually consists of, and which parts of it are load-bearing — so you will take an inventory of the deployment, read the admission webhooks that every Cluster passes through, find the lease that decides which replica is in charge, and then switch the operator off and watch the API server refuse a Cluster because of it.',
  },

  tasks: [
    {
      id: 'namespace-anatomy',
      title: 'Take an inventory of the operator',
      limitSec: 420,
      criteria: [
        'The operator Deployment reports 1 ready replica',
        'cnpg-webhook-service has exactly one endpoint',
        '/root/operator-pod.txt was written',
        'It names the running operator Pod',
      ],
      brief: `Start with what is actually deployed. The whole operator is one namespace with a handful of objects in it — a single-replica Deployment, a Service, a ServiceAccount and its RBAC.

Two of those matter more than the rest. The Deployment is the control loop that reconciles every Cluster in the whole cluster, and the Service in front of it is how the API server reaches its admission webhooks.

Record the name of the running operator Pod in \`/root/operator-pod.txt\`. Note that its name changes whenever it is replaced, which is exactly why nothing else refers to it by name.`,
      instructions: `Everything the operator is lives in one namespace:

\`\`\`
kubectl -n cnpg-system get all
\`\`\`

One Deployment, \`cnpg-controller-manager\`, with one Pod; one Service, \`cnpg-webhook-service\`, on port 443. That is the entire runtime footprint — one process watching every namespace in the cluster.

Look at what gives it permission to do that:

\`\`\`
kubectl get clusterrole cnpg-manager -o jsonpath='{.rules[0]}{"\\n"}'
kubectl get clusterrolebinding cnpg-manager-rolebinding -o jsonpath='{.subjects}{"\\n"}'
\`\`\`

A ClusterRole bound to the operator's ServiceAccount — cluster-scoped, because a Cluster resource can be created in any namespace.

Check the webhook Service really has something behind it:

\`\`\`
kubectl -n cnpg-system get endpointslices -l kubernetes.io/service-name=cnpg-webhook-service
\`\`\`

One endpoint: the operator Pod itself. Record its name:

\`\`\`
kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}' > /root/operator-pod.txt
cat /root/operator-pod.txt
\`\`\``,
      hint: `The operator Pod is the only Pod in \`cnpg-system\` with the label \`app.kubernetes.io/name=cloudnative-pg\`. Record just the Pod name.`,
      solution: `kubectl -n cnpg-system get all
kubectl get clusterrolebinding cnpg-manager-rolebinding -o jsonpath='{.subjects}{"\\n"}'
kubectl -n cnpg-system get endpointslices -l kubernetes.io/service-name=cnpg-webhook-service
kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}' > /root/operator-pod.txt
cat /root/operator-pod.txt`,
    },

    {
      id: 'webhooks',
      title: 'Read the admission webhooks',
      limitSec: 420,
      criteria: [
        'Both CNPG webhook configurations exist',
        'The validating configuration intercepts clusters.postgresql.cnpg.io',
        '/root/webhook-count.txt was written',
        'It records how many webhooks the validating configuration has',
      ],
      brief: `Every Cluster you create is intercepted twice before it is ever stored: once by a mutating webhook that fills in defaults, and once by a validating webhook that can reject it outright.

Those are cluster-scoped objects, not part of the namespace, and they point back at the operator's Service. Read them: which resources they cover, what happens when the webhook cannot be reached, and how many rules each one carries.

Record how many webhooks the validating configuration defines in \`/root/webhook-count.txt\`. The number is less interesting than what reading the list tells you — the operator is validating far more than just Clusters.`,
      instructions: `The two configurations are cluster-scoped:

\`\`\`
kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration | grep cnpg
\`\`\`

Look at what the validating one covers:

\`\`\`
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{range .webhooks[*]}{.name}{"  ->  "}{.rules[0].resources}{"\\n"}{end}'
\`\`\`

One entry per resource kind the operator validates — clusters, backups, scheduledbackups, poolers and more. Each names the Service it calls:

\`\`\`
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{.webhooks[0].clientConfig.service}{"\\n"}'
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{.webhooks[0].failurePolicy}{"\\n"}'
\`\`\`

\`failurePolicy: Fail\` is the important one: if the webhook cannot be reached, the API server refuses the request rather than letting it through unvalidated. That is what you will prove in the last objective.

Count them and record it:

\`\`\`
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{.webhooks[*].name}' | wc -w > /root/webhook-count.txt
cat /root/webhook-count.txt
\`\`\``,
      hint: `Count the entries under \`.webhooks[*]\` of the **validating** configuration — the mutating one has a different number.`,
      solution: `kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration | grep cnpg
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{range .webhooks[*]}{.name}{"  ->  "}{.rules[0].resources}{"\\n"}{end}'
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{.webhooks[0].failurePolicy}{"\\n"}'
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{.webhooks[*].name}' | wc -w > /root/webhook-count.txt
cat /root/webhook-count.txt`,
    },

    {
      id: 'prove-the-webhook',
      title: 'Switch the operator off and watch a Cluster be refused',
      limitSec: 480,
      criteria: [
        '/root/webhook-error.txt was written',
        'It captured the API server refusing the Cluster while no operator was running',
        'The operator is running again',
      ],
      brief: `Now prove the webhook is load-bearing rather than decorative.

Scale the operator to zero replicas, so the webhook Service has no endpoints, and then try to create a Cluster. The API server cannot reach the webhook, the failure policy says refuse, and the request is rejected before anything is written to etcd — capture that error.

This is the mechanism behind an error people meet by accident when they install the operator and immediately apply a Cluster. Seeing it deliberately, with the cause in your hand, is much cheaper than meeting it during a deployment.

Scale the operator back up when you are done; the existing database is unaffected throughout either way.`,
      instructions: `Scale the operator to zero and confirm the webhook has nothing behind it:

\`\`\`
kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=0
kubectl -n cnpg-system get pods
kubectl -n cnpg-system get endpointslices -l kubernetes.io/service-name=cnpg-webhook-service
\`\`\`

The running database does not care — it is PostgreSQL in Pods, and no operator is needed to keep serving:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Now try to create a *new* Cluster, and capture what happens. It has to be a new name: re-applying the existing Cluster unchanged is a no-op that never reaches admission, so it would succeed and prove nothing.

\`\`\`
sed "s/name: pg-cluster/name: pg-cluster-two/" /root/cluster.yaml | kubectl apply -f - --dry-run=server > /root/webhook-error.txt 2>&1
cat /root/webhook-error.txt
\`\`\`

The API server reports \`failed calling webhook "mcluster.cnpg.io" ... no endpoints available for service "cnpg-webhook-service"\` and refuses. Nothing was created, and nothing was silently let through unvalidated either — note that it is the *mutating* webhook that fails first, since defaulting happens before validation.

Put the operator back:

\`\`\`
kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=1
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
\`\`\``,
      hint: `\`--dry-run=server\` sends the request through admission without creating anything, which is exactly what you want here. Capture both streams with \`> file 2>&1\` — the rejection arrives on standard error.`,
      solution: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=0
kubectl -n cnpg-system get endpointslices -l kubernetes.io/service-name=cnpg-webhook-service
sed "s/name: pg-cluster/name: pg-cluster-two/" /root/cluster.yaml | kubectl apply -f - --dry-run=server > /root/webhook-error.txt 2>&1
cat /root/webhook-error.txt
kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=1
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager`,
    },
  ],
}
