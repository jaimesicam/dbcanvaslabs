// The ConfigMap name the operator reads, the fact that it is only read at startup, and the
// propagation of inherited labels to Pods and PVCs are confirmed live against a real K3D +
// CloudNativePG deploy (server/, see LABORATORY.md): labels applied before the restart were
// ignored, and after it all three Pods and all three claims carried them. Grading compares
// the operator Pod's start time against the ConfigMap's creation time.
//
// Self-contained, like every lab here: the operator and a healthy cluster are this lab's
// starting state, built by its own provisioning. No reference to any other lab (see
// CLAUDE.md, "Lab content contract").

export const cnpgOperatorConfigMap = {
  id: 'cnpg-operator-configmap',
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
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built, started with --config-map-name=cnpg-controller-manager-config — a ConfigMap that does not exist yet',
      'A healthy 3-instance Cluster named pg-cluster, with three instance Pods and three PersistentVolumeClaims for the operator to apply its configuration to',
    ],
    yourJob:
      'The operator is running with its default behaviour because the ConfigMap it was told to read has never been created. You will create it, ask for labels on a Cluster to be inherited by everything the operator generates from it, and discover — deliberately — that nothing happens until the operator is restarted.',
  },

  tasks: [
    {
      id: 'create-config',
      title: 'Create the ConfigMap the operator was told to read',
      limitSec: 360,
      criteria: [
        'ConfigMap cnpg-controller-manager-config exists in cnpg-system',
        'It sets INHERITED_LABELS to include team',
      ],
      brief: `Operator-wide behaviour — as opposed to per-cluster settings — is configured in a single ConfigMap in the operator's own namespace, whose name the operator is given on its command line.

Look at that command line first. The operator is already asking for a ConfigMap called \`cnpg-controller-manager-config\`, and that ConfigMap does not exist, which is simply how a default installation runs.

Create it with \`INHERITED_LABELS\`, which tells the operator that labels with those keys on a Cluster should be copied onto everything it generates from that Cluster.`,
      instructions: `See what the operator was started with:

\`\`\`
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].args}{"\\n"}'
kubectl -n cnpg-system get cm
\`\`\`

It is asking for \`--config-map-name=cnpg-controller-manager-config\`, and no such ConfigMap exists — so every operator-wide setting is at its default. Create it:

\`\`\`
kubectl -n cnpg-system create configmap cnpg-controller-manager-config \\
  --from-literal=INHERITED_LABELS="team,environment"
kubectl -n cnpg-system get cm cnpg-controller-manager-config -o jsonpath='{.data}{"\\n"}'
\`\`\`

\`INHERITED_LABELS\` is a comma-separated list of label *keys*. Labels with those keys on a Cluster get copied onto the Pods, PVCs and Services the operator creates for it — which is how ownership, cost-centre or environment labelling gets applied consistently without anyone labelling generated objects by hand.

Nothing has changed yet. The operator has not read this.`,
      hint: `The ConfigMap goes in the operator's namespace, \`cnpg-system\`, and its name has to match the \`--config-map-name\` argument exactly.`,
      solution: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].args}{"\\n"}'
kubectl -n cnpg-system create configmap cnpg-controller-manager-config --from-literal=INHERITED_LABELS="team,environment"
kubectl -n cnpg-system get cm cnpg-controller-manager-config -o jsonpath='{.data}{"\\n"}'`,
    },

    {
      id: 'label-without-restart',
      title: 'Label the Cluster, and watch nothing happen',
      limitSec: 420,
      criteria: [
        'The Cluster carries the team label',
        'The instance Pods have not inherited it — the operator has not re-read its configuration',
      ],
      brief: `Label the Cluster with one of the keys you just asked to have inherited, and then look at the Pods.

They will not have it. This is the objective's real content: the operator reads that ConfigMap **once, at startup**, so a configuration change that has not been followed by a restart has no effect at all — even though everything looks correctly configured.

It is worth provoking on purpose, because the failure is silent. Nothing errors, nothing warns, and the ConfigMap sits there looking exactly right.`,
      instructions: `Put the label on the Cluster:

\`\`\`
kubectl label cluster.postgresql.cnpg.io pg-cluster team=payments --overwrite
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.metadata.labels}{"\\n"}'
\`\`\`

Now look at what the operator generated from that Cluster:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team
kubectl get pvc -L team
\`\`\`

The TEAM column is empty everywhere. The Cluster carries the label, the ConfigMap asks for it to be inherited, and nothing has been inherited.

Give it a moment and look again if you like — it will not change:

\`\`\`
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team
\`\`\`

The operator is reconciling this Cluster constantly; it simply does not know about the setting, because it read its configuration when it started and the ConfigMap did not exist then.`,
      hint: `\`-L team\` adds a column showing that label's value on each object. An empty column means the label is absent, which is what you are looking for here.`,
      solution: `kubectl label cluster.postgresql.cnpg.io pg-cluster team=payments --overwrite
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.metadata.labels}{"\\n"}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team
kubectl get pvc -L team`,
    },

    {
      id: 'restart-and-inherit',
      title: 'Restart the operator and watch it take effect',
      limitSec: 480,
      criteria: [
        'The operator was restarted after the ConfigMap was created',
        'All 3 instance Pods now carry the inherited label',
        'So do their PersistentVolumeClaims',
      ],
      brief: `Restart the operator so it reads the ConfigMap, and watch the same label you applied a moment ago propagate to every object it manages.

Nothing about the database restarts — the operator is a separate process, and rolling it has no effect on the running PostgreSQL instances. Watch that too: the instance Pods keep their ages and their restart counts stay at zero.

Once it comes back, the labels appear on the Pods and on the PersistentVolumeClaims, applied by reconciliation rather than by you.`,
      instructions: `Restart the operator and wait for it:

\`\`\`
kubectl -n cnpg-system rollout restart deploy cnpg-controller-manager
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
\`\`\`

Give it a few seconds to reconcile, then look again at the objects that had nothing before:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team,environment
kubectl get pvc -L team,environment
\`\`\`

The TEAM column is populated on all three Pods and all three claims. Nothing was recreated to achieve it — compare the AGE column with what you saw earlier, and the RESTARTS column is still zero.

Add the second key you listed, and watch it land without any further restart:

\`\`\`
kubectl label cluster.postgresql.cnpg.io pg-cluster environment=lab --overwrite
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team,environment
\`\`\`

The *configuration* needed a restart; the labels it enables do not. From here on, any label with one of those keys is inherited as soon as it is applied.`,
      hint: `\`rollout restart\` replaces the operator Pod; the database Pods are untouched. If the labels have not appeared, give reconciliation a few more seconds and look again.`,
      solution: `kubectl -n cnpg-system rollout restart deploy cnpg-controller-manager
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl label cluster.postgresql.cnpg.io pg-cluster environment=lab --overwrite
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team,environment
kubectl get pvc -L team,environment`,
    },
  ],
}
