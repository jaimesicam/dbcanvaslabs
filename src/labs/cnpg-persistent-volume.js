// Real PVC/PV annotation text, storage-class behavior and the failover timing below are
// confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md).
// Grading runs server-side, against the real cluster.
//
// Self-contained, like every lab here: a healthy 3-instance cluster is this lab's
// starting state, built by its own provisioning, because the subject is what happens to
// the volume when that cluster breaks. No reference to any other lab (see CLAUDE.md,
// "Lab content contract").

export const cnpgPersistentVolume = {
  id: 'cnpg-persistent-volume',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster before you touch anything, and thrown away when you finish. Nothing is simulated. This is the longest build of the set: it installs the operator and waits for three PostgreSQL instances to bootstrap one at a time.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator already installed and Running in the cnpg-system namespace',
      'A healthy 3-instance Cluster named pg-cluster, already applied and reporting "Cluster in healthy state" — one primary and two streaming replicas, spread across the three nodes',
      'Three PersistentVolumeClaims, one per instance, Bound on k3s\'s bundled local-path StorageClass',
    ],
    yourJob:
      'Nothing is broken yet, and the database is empty. You will inspect the volume behind the primary, write a row you care about, delete the primary pod outright the way a crash would, and prove the recreated pod comes back on the same node with the same volume and the same data.',
  },

  tasks: [
    {
      id: 'inspect-pvc',
      title: "Inspect the primary's PVC",
      limitSec: 360,
      criteria: [
        'All 3 PVCs are Bound on the local-path StorageClass',
        '/root/pinned-node.txt was written',
        "It names the node the primary's volume is pinned to",
      ],
      brief: `Find out what is actually backing the primary's data directory, before you disturb anything.

List the PVCs — one per instance, all Bound on k3s's \`local-path\` class — find which pod is currently primary, then describe that pod's PVC and record the node its volume is pinned to in \`/root/pinned-node.txt\`.

That pin is the whole subject of this lab: \`local-path\` is node-local \`hostPath\` storage, not a portable cloud volume.`,
      instructions: `Every CNPG instance gets its own PVC, one per pod, named exactly like the pod:

\`\`\`
kubectl get pvc
\`\`\`

All three should read **Bound** on the \`local-path\` StorageClass — that's k3s's own bundled provisioner, not anything CNPG installs. First find the primary:

\`\`\`
kubectl get pods -L cnpg.io/instanceRole
\`\`\`

Then look closer at its PVC:

\`\`\`
kubectl describe pvc pg-cluster-1
\`\`\`

Note the \`volume.kubernetes.io/selected-node\` annotation. \`local-path\` is **node-local** storage — a \`hostPath\` under the hood, bound the moment the pod is first scheduled, to whichever node that happens to be. It is not portable the way a real cloud CSI volume is: if that node ever left the cluster, this PVC could never rebind. Record which node it's pinned to:

\`\`\`
echo <node-name> > /root/pinned-node.txt
\`\`\``,
      hint: `\`kubectl describe pvc pg-cluster-1\` — the node name is the value of the \`volume.kubernetes.io/selected-node\` annotation, not the STORAGECLASS column. Record it exactly as kubectl prints it — the real container name, not a shortened label.`,
      solution: `kubectl get pvc
kubectl get pods -L cnpg.io/instanceRole
kubectl describe pvc pg-cluster-1
echo $(kubectl get pvc pg-cluster-1 -o jsonpath='{.metadata.annotations.volume\\.kubernetes\\.io/selected-node}') > /root/pinned-node.txt`,
    },

    {
      id: 'write-proof',
      title: 'Write data before you break anything',
      limitSec: 360,
      criteria: ["A 'before-pod-deletion' row exists", 'It reads back identically on a replica'],
      brief: `Write the data whose survival is the thing you are actually testing. The database is empty right now.

Get the \`app\` user's operator-generated password from the \`pg-cluster-app\` Secret, create the \`pv_proof\` table on the primary, insert a row noted \`before-pod-deletion\`, and confirm a replica can already see it before you break anything.

Establishing the "before" state first is what makes the next objective a proof rather than a guess.`,
      instructions: `Get the \`app\` user's operator-generated password:

\`\`\`
export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
\`\`\`

Create a table on the primary:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "CREATE TABLE pv_proof (id serial primary key, note text, created_at timestamptz default now());"
\`\`\`

Then write the row that has to survive what comes next:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "INSERT INTO pv_proof (note) VALUES ('before-pod-deletion') RETURNING *;"
\`\`\`

Confirm it replicated before you touch anything:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof;"
\`\`\``,
      hint: `Use whichever pod name \`kubectl get pods -L cnpg.io/instanceRole\` currently marks \`primary\` — CREATE TABLE and INSERT both fail on a replica.`,
      solution: `export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "CREATE TABLE pv_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "INSERT INTO pv_proof (note) VALUES ('before-pod-deletion') RETURNING *;"
kubectl exec pg-cluster-2 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof;"`,
    },

    {
      id: 'kill-primary',
      title: 'Delete the primary pod and watch it recover',
      limitSec: 420,
      criteria: [
        'The original primary pod was deleted',
        'A different instance was promoted to primary',
        'The recreated pod reuses the exact same PVC/volume',
        'The recreated pod landed back on the same node',
        'Cluster is healthy again',
      ],
      brief: `Break it on purpose: delete the primary pod object outright — no cordon, no drain — the way a node crash or an OOM-kill would.

Watch CNPG promote a replica, then watch the deleted pod get recreated. Check the pods and the PVCs: the recreated pod has to land back on the **same** node, reusing the **same** volume, because a \`local-path\` volume physically cannot move.

Wait for the cluster to report healthy again before you check.`,
      instructions: `Not a cordon, not a drain — delete the primary pod object outright, the way a node-level crash or an OOM-kill would:

\`\`\`
kubectl delete pod pg-cluster-1
\`\`\`

Watch the pods react:

\`\`\`
kubectl get pods -o wide
\`\`\`

And watch the cluster's own view of it:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

CNPG promotes a healthy replica almost immediately — you do not need to trigger that yourself. In a real deploy this recovers in about 24 seconds. Once it's healthy again, confirm the PVC tells the real story:

\`\`\`
kubectl get pvc
\`\`\`

The PVC for \`pg-cluster-1\` should be the **same** volume, same age, as before you deleted anything — this is not CNPG failover magic, it's \`local-path\`'s \`WaitForFirstConsumer\` binding reasserting itself: the recreated pod can only schedule back onto the exact node its \`hostPath\` volume already lives on.`,
      hint: `If \`kubectl get pods\` still shows \`pg-cluster-1\` as \`PodInitializing\`, give it a few more seconds — it comes back as a **replica**, never as the primary again.`,
      solution: `kubectl delete pod pg-cluster-1
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -o wide
kubectl get pvc`,
    },

    {
      id: 'confirm-data',
      title: 'Confirm the data survived, and the new primary works',
      limitSec: 360,
      criteria: [
        "The 'before-pod-deletion' row still exists on the recreated pod",
        'A fresh write through the -rw Service reaches the new primary',
        'Every instance, including the recreated one, sees both rows',
      ],
      brief: `Prove the data survived, and that the newly-promoted primary takes writes.

Read \`pv_proof\` back from the pod you deleted — it is a replica now, but it is reading the same disk it always had. Then insert a second row through the \`pg-cluster-rw\` Service, which follows whichever pod is primary right now rather than the one you named earlier, and confirm every instance sees both rows.

An intact PVC name proves nothing on its own; the rows are the proof.`,
      instructions: `Read from the pod that was just recreated — it's a replica now, but it's reading the **same** disk it always had:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof;"
\`\`\`

The \`before-pod-deletion\` row should still be there — that's the actual proof, not just an unchanged PVC name. Now prove the **new** primary works too, by writing through the \`-rw\` Service (which always follows whichever pod is primary right now) instead of naming a pod directly:

\`\`\`
kubectl run pv-proof-client --image=ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie \\
  --env PGPASSWORD=$PGPASSWORD --command -- psql -h pg-cluster-rw -U app -d app -c \\
  "INSERT INTO pv_proof (note) VALUES ('after-failover-via-rw-service') RETURNING *;"
\`\`\`

Read what it did:

\`\`\`
kubectl logs pv-proof-client
\`\`\`

Then clean it up yourself:

\`\`\`
kubectl delete pod pv-proof-client
\`\`\`

(\`kubectl run ... --rm -i\` looks like the natural one-liner here, but its attach-and-clean-up-when-stdin-closes logic doesn't play well with a real interactive terminal's stdin, which never closes — it hangs and times out. Running it detached, reading \`kubectl logs\`, then deleting it yourself is the reliable way to do a one-off pod like this from an interactive shell.)

Then confirm every instance — including the one you deleted — agrees on both rows:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof ORDER BY id;"
\`\`\``,
      hint: `\`pg-cluster-rw\` always resolves to the current primary, whichever pod that is right now — that's the entire point of using the Service instead of a pod name after a failover. If \`$PGPASSWORD\` is empty (e.g. a new terminal tab), re-export it from the \`pg-cluster-app\` secret first.`,
      solution: `kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof;"
kubectl run pv-proof-client --image=ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie --env PGPASSWORD=$PGPASSWORD --command -- psql -h pg-cluster-rw -U app -d app -c "INSERT INTO pv_proof (note) VALUES ('after-failover-via-rw-service') RETURNING *;"
kubectl logs pv-proof-client
kubectl delete pod pv-proof-client
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof ORDER BY id;"`,
    },
  ],
}
