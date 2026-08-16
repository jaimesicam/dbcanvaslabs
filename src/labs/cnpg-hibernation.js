// The hibernation round-trip is confirmed live against a real K3D + CloudNativePG deploy
// (server/, see LABORATORY.md): `kubectl cnpg hibernate on` annotated the Cluster
// cnpg.io/hibernation: on, removed all three instance Pods and kept all three
// PersistentVolumeClaims bound; `hibernate off` brought three Pods back in about 75 seconds
// with the data intact and the annotation flipped to off. Grading reads the annotation, the
// Pods, the PVCs and the data.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster, the cnpg plugin, a
// client Pod and the toolbox are this lab's starting state, built by its own provisioning.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgHibernation = {
  id: 'cnpg-hibernation',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", with one PersistentVolumeClaim per instance',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'A database nobody is using still costs what it costs: three Pods, their CPU and their memory, running to serve no one. Hibernation is the answer for an environment that is dormant rather than finished — a review app, a staging copy between releases, a demo between demos. You will hibernate this cluster, account for exactly what is released and what is kept, and then wake it and prove nothing was lost. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'hibernate',
      title: 'Put the cluster to sleep',
      limitSec: 480,
      criteria: [
        'The cluster is annotated cnpg.io/hibernation: on',
        'Every instance Pod is gone',
        'All 3 PersistentVolumeClaims are still bound — the data is kept',
        '/root/hibernated.txt was written',
        'It records how many volumes were kept',
      ],
      brief: `Hibernation shuts a cluster down without deleting it: the Pods go, the volumes stay, and the Cluster object remains so it can be brought back exactly as it was.

That combination is what makes it different from the two things it is easy to confuse it with. Scaling to zero is not available — a CloudNativePG Cluster has no such setting. Deleting the Cluster would take the volumes with it.

Write a row first, so there is something to look for on the other side. Then hibernate, and count what is left: the Pods, the volumes and the Cluster object itself.`,
      instructions: `Work in the **toolbox** tab. Leave something behind to find later:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE hibernate_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO hibernate_demo (note) VALUES ('before-hibernation') RETURNING *;"
\`\`\`

Note what is running:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
\`\`\`

Now hibernate:

\`\`\`
kubectl cnpg hibernate on pg-cluster
\`\`\`

As with fencing, the plugin sets an annotation and the operator does the work:

\`\`\`
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/hibernation"]'
\`\`\`

Give it a moment, then count what is left:

\`\`\`
sleep 30
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
kubectl get cluster pg-cluster
\`\`\`

No Pods at all. Three PersistentVolumeClaims, all still bound. And the Cluster object itself is still there, reporting no ready instances — it is the record of what to rebuild.

That is the trade: you stop paying for compute and go on paying for storage. For a staging database between releases that is exactly the right shape, and it is why hibernation is not the same as deleting and restoring from backup — there is no backup involved and no restore to get wrong.

Record what was kept:

\`\`\`
kubectl get pvc -l cnpg.io/cluster=pg-cluster --no-headers | wc -l > /root/hibernated.txt
cat /root/hibernated.txt
\`\`\`

Confirm the obvious consequence — there is no database to talk to:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;"
\`\`\`

The Service still exists but has no endpoints behind it, so the connection has nowhere to go. A hibernated cluster is genuinely off, not idling.`,
      hint: `The failing \`psql\` at the end is expected — it is the evidence that the cluster is really down. \`kubectl get endpoints pg-cluster-rw\` shows the same thing from the Kubernetes side.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE hibernate_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO hibernate_demo (note) VALUES ('before-hibernation') RETURNING *;"
kubectl cnpg hibernate on pg-cluster
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/hibernation"]'
sleep 30
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
kubectl get pvc -l cnpg.io/cluster=pg-cluster --no-headers | wc -l > /root/hibernated.txt
cat /root/hibernated.txt`,
    },

    {
      id: 'wake-up',
      title: 'Wake it up and check nothing was lost',
      limitSec: 600,
      criteria: [
        'The hibernation annotation reads off',
        'The cluster is healthy again with 3 of 3 ready',
        'The row written before hibernation is still there',
      ],
      brief: `Waking a hibernated cluster is the same command with \`off\`. The operator recreates the Pods and attaches the volumes that were waiting for them.

What to watch for is how it comes back. This is not a restore and not a rebuild: the instances start on the data directories they already had, so the primary comes up on its own volume rather than being bootstrapped from anywhere.

Expect it to take about a minute. Then check the row you wrote before, which is the only proof that matters.`,
      instructions: `Wake it:

\`\`\`
kubectl cnpg hibernate off pg-cluster
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/hibernation"]'
\`\`\`

Watch it come back — this is real PostgreSQL startup on three instances:

\`\`\`
sleep 75
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Three instances, healthy. Note the ages: these are brand-new Pods, created seconds ago, because hibernation really did delete them.

Now the volumes they came back on:

\`\`\`
kubectl get pvc
\`\`\`

The same three PersistentVolumeClaims, with their original ages — minutes older than the Pods using them. That mismatch is the whole mechanism in one screen: new compute, old storage.

And the data:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM hibernate_demo ORDER BY id;"
\`\`\`

The row is there. Write another to prove it is a working database again, not just a readable one:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO hibernate_demo (note) VALUES ('after-waking') RETURNING *;"
\`\`\`

Finally, confirm replication rebuilt itself:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl cnpg status pg-cluster | head -12
\`\`\`

Both standbys streaming. The cluster is exactly what it was before it slept, which is the point — hibernation is reversible in a way that deleting and restoring never quite is.`,
      hint: `Give it a full 60–90 seconds. All three instances start at once rather than one at a time, since none of them needs bootstrapping — but PostgreSQL startup and the operator's readiness probes still take time.`,
      solution: `kubectl cnpg hibernate off pg-cluster
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/hibernation"]'
sleep 75
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM hibernate_demo ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO hibernate_demo (note) VALUES ('after-waking') RETURNING *;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"`,
    },
  ],
}
