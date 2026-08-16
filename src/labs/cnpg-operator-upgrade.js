// The upgrade path 1.29.2 → 1.30.0, the CRD that appears with it, and the fact that no
// PostgreSQL instance is restarted are confirmed live against a real K3D + CloudNativePG
// deploy (server/, see LABORATORY.md): during a real upgrade the instance Pods' ages kept
// climbing and their restart counts stayed at zero, while the CRD count went from 10 to 11
// with failoverquorums appearing. Grading reads the running image, the CRDs and the
// instances' restart counts.
//
// Self-contained, like every lab here: an operator on the *previous* minor release, a
// healthy cluster and the newer release staged on disk are this lab's starting state, built
// by its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content
// contract").

export const cnpgOperatorUpgrade = {
  id: 'cnpg-operator-upgrade',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a deliberately *older* CloudNativePG operator and a real database it has been managing, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: the previous release is installed and three PostgreSQL instances are bootstrapped by it, one at a time, before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.29.2 operator — the previous minor release — installed and Running in the cnpg-system namespace, with the 10 CRDs that version ships',
      'A healthy 3-instance Cluster named pg-cluster, bootstrapped by that older operator and reporting "Cluster in healthy state"',
      'The v1.30.0 release manifest staged on the k3d-server node at /root/cloudnative-pg/releases/cnpg-1.30.0.yaml — downloaded, but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to keep querying from',
    ],
    yourJob:
      'The operator running here is a minor release behind, and the newer manifest is already on disk. You will record exactly what is running now, apply the upgrade, and then answer the question that decides whether an operator upgrade is a maintenance window or a Tuesday afternoon: what happened to the databases while the thing managing them was replaced.',
  },

  tasks: [
    {
      id: 'survey-the-old-operator',
      title: 'Record what is running before you touch it',
      limitSec: 420,
      criteria: [
        'The operator Deployment is running 1.29.2',
        '10 CNPG CRDs are registered',
        "A row noted 'before-upgrade' exists",
        '/root/before-version.txt was written',
        'It records the version you started on',
      ],
      brief: `An upgrade is only verifiable if you wrote down what you started from, so begin there.

Record three things: which operator image is actually running, how many CloudNativePG CRDs are registered, and the ages and restart counts of the instance Pods. The last one is the baseline for the claim you will test at the end.

Write a row noted \`before-upgrade\` as well. Upgrading the operator should be invisible to the data, and this is what you will check that against.`,
      instructions: `Read the running image — not the manifest you think was applied, the image the Deployment is actually using:

\`\`\`
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl -n cnpg-system get pods
\`\`\`

Record it:

\`\`\`
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}' > /root/before-version.txt
cat /root/before-version.txt
\`\`\`

Count the CRDs this release registered — an operator upgrade is partly an API upgrade, and the count is the simplest way to see that:

\`\`\`
kubectl get crd | grep -c postgresql.cnpg.io
kubectl get crd -o name | grep postgresql.cnpg.io
\`\`\`

Ten of them. Note the instance Pods' ages and restart counts, which is the baseline that matters most:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

And write the row whose survival you will check:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE upgrade_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_proof (note) VALUES ('before-upgrade') RETURNING *;"
\`\`\``,
      hint: `Read the image from the Deployment rather than assuming it from the manifest that was applied — those can differ, and what is running is the only thing that counts.`,
      solution: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}' > /root/before-version.txt
kubectl get crd | grep -c postgresql.cnpg.io
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE upgrade_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_proof (note) VALUES ('before-upgrade') RETURNING *;"`,
    },

    {
      id: 'upgrade',
      title: 'Apply the newer release',
      limitSec: 480,
      criteria: [
        'The operator Deployment is now running 1.30.0',
        '11 CNPG CRDs are registered — the upgrade added one',
        'The upgraded operator Pod is Running',
      ],
      brief: `Upgrading the operator is applying the newer release manifest over the older one. There is no separate upgrade procedure and no migration step.

Server-side apply is what makes that work: it reconciles field ownership on the API server rather than diffing against a stored copy of what was applied last time, so the same command that installs also upgrades.

Watch two things change — the Deployment's image, and the set of CRDs. A minor release usually brings new API surface, and this one adds a CRD that did not exist before.`,
      instructions: `The newer manifest is already on the node. Apply it exactly as you would to install:

\`\`\`
kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
\`\`\`

Every object reports \`serverside-applied\` — the CRDs, the RBAC, the webhook configurations and the Deployment. Watch the operator roll:

\`\`\`
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl -n cnpg-system get pods
\`\`\`

The image is now 1.30.0 and a new operator Pod is serving. Now the API surface:

\`\`\`
kubectl get crd | grep -c postgresql.cnpg.io
kubectl get crd -o name | grep postgresql.cnpg.io
\`\`\`

Eleven, where there were ten. Compare the lists and the newcomer is \`failoverquorums.postgresql.cnpg.io\` — a 1.30 feature whose API had to exist before anything could use it. This is why an operator upgrade is an API upgrade too, and why the CRDs are applied before the Deployment rolls.`,
      hint: `\`--server-side\` is not optional for CloudNativePG: the CRDs are far too large for a client-side apply's last-applied annotation, which fails outright at 256 KB.`,
      solution: `kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl get crd | grep -c postgresql.cnpg.io
kubectl get crd -o name | grep postgresql.cnpg.io`,
    },

    {
      id: 'verify-no-disruption',
      title: 'Find out what it cost the databases',
      limitSec: 420,
      criteria: [
        'The cluster is healthy with 3 of 3 ready',
        'No instance container was restarted by the upgrade',
        "The 'before-upgrade' row is intact",
        'A row written after the upgrade succeeded',
      ],
      brief: `Now the question the whole lab exists to answer: what happened to the PostgreSQL instances while the operator managing them was replaced?

Nothing. Compare the instance Pods' ages against the baseline you took — they kept climbing straight through the upgrade — and their restart counts are still zero. No Pod was recreated, no instance was failed over, no connection was dropped.

That is the consequence of the operator not being on the data path. Upgrading it is a change to the control plane only, which is what makes minor-version operator upgrades routine rather than a scheduled outage.`,
      instructions: `Look at the instances, and at their ages in particular:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

Ages that predate the upgrade and RESTARTS still at 0 — these are the same containers that were running before you applied anything.

Check the data survived and that writes still work:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM upgrade_proof;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_proof (note) VALUES ('after-upgrade') RETURNING *;"
\`\`\`

Both rows, and the new one accepted by the same primary as before.

Confirm the new operator is genuinely managing the old cluster, not merely coexisting with it — give it something to do:

\`\`\`
kubectl delete pod pg-cluster-3 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

Recreated and healthy again: a cluster created by 1.29.2 is being reconciled by 1.30.0 without anything having been migrated by hand.`,
      hint: `The RESTARTS column is the evidence, and it should read 0. A restart count above zero on an instance would mean the upgrade rolled the databases, which is exactly the claim being tested.`,
      solution: `kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM upgrade_proof;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO upgrade_proof (note) VALUES ('after-upgrade') RETURNING *;"
kubectl delete pod pg-cluster-3 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster`,
    },
  ],
}
