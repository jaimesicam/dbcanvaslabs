// The finalizer that holds a PVC in Terminating, and the re-provisioning that follows once
// the Pod is gone, are confirmed live against a real K3D + CloudNativePG deploy (server/,
// see LABORATORY.md): the claim came back bound to an entirely different volume and the
// instance was re-cloned from the primary. Grading compares the volume the learner recorded
// against the one the instance ended up on.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a
// client Pod are this lab's starting state, built by its own provisioning. No reference to
// any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgPVCDeletion = {
  id: 'cnpg-pvc-deletion',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster with real storage behind each instance, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here. It also means the storage you destroy is really destroyed.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — one primary and two replicas streaming from it',
      "Three PersistentVolumeClaims, one per instance and named after it, Bound on k3s's bundled local-path StorageClass",
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      "Nothing is broken yet, and the database is empty. You will destroy a replica's storage outright — not its Pod, its claim — and find out what Kubernetes does about a volume that is still in use, what it takes to actually complete that deletion, and how the operator rebuilds an instance whose data no longer exists anywhere.",
  },

  tasks: [
    {
      id: 'survey-and-write',
      title: "Record the volume you are about to destroy",
      limitSec: 420,
      criteria: [
        'All 3 PVCs are Bound',
        "A row noted 'before-pvc-deletion' exists",
        '/root/old-volume.txt was written',
        'It names the volume behind one of the two replicas',
      ],
      brief: `Find out exactly which piece of storage you are about to destroy, and write down its identity so the rebuild afterwards is provable rather than plausible.

Each instance has one PersistentVolumeClaim named after it, and each claim is bound to a PersistentVolume with a generated name. That volume name is the thing to record in \`/root/old-volume.txt\` — a claim can come back with the same name while pointing at completely different storage, so the claim's name proves nothing.

Pick a replica, not the primary. Write a row first, too: the data has to exist somewhere before you can show it was restored.`,
      instructions: `List the claims and the volumes behind them:

\`\`\`
kubectl get pvc
\`\`\`

Three claims, all Bound, each on the \`local-path\` StorageClass, each bound to a \`pvc-<uuid>\` volume. Find out which instance is a replica:

\`\`\`
kubectl get pods -o wide -L cnpg.io/instanceRole
\`\`\`

Write the row whose survival you will check at the end:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE pvc_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pvc_proof (note) VALUES ('before-pvc-deletion') RETURNING *;"
\`\`\`

Now record the volume name behind the replica you chose:

\`\`\`
kubectl get pvc pg-cluster-3 -o jsonpath='{.spec.volumeName}' > /root/old-volume.txt
cat /root/old-volume.txt
\`\`\`

That \`pvc-<uuid>\` string is the identity of the actual storage. If the instance comes back on a volume with a different uuid, its data was rebuilt from scratch rather than reattached.`,
      hint: `Record the volume of a Pod that \`kubectl get pods -L cnpg.io/instanceRole\` marks \`replica\`. It is the VOLUME column of \`kubectl get pvc\`, not the NAME column — the name is just the instance's.`,
      solution: `kubectl get pvc
kubectl get pods -o wide -L cnpg.io/instanceRole
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE pvc_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pvc_proof (note) VALUES ('before-pvc-deletion') RETURNING *;"
kubectl get pvc pg-cluster-3 -o jsonpath='{.spec.volumeName}' > /root/old-volume.txt
cat /root/old-volume.txt`,
    },

    {
      id: 'delete-pvc',
      title: 'Delete the claim, and find out why nothing happens',
      limitSec: 480,
      criteria: [
        'No PVC is backed by the old volume any more',
        'All 3 PVCs are Bound again, on 3 different volumes',
        'All 3 instances are running',
        'The cluster reports healthy with 3 of 3 ready',
      ],
      brief: `Delete that replica's PersistentVolumeClaim. The command will report it deleted, and then nothing will happen — the claim sits in \`Terminating\` and the instance carries on running perfectly.

That is Kubernetes protecting you. A finalizer on the claim blocks its deletion for as long as a Pod is using it, so storage cannot be pulled out from under a running workload. Look at the claim while it is stuck and you can see exactly which finalizer is holding it.

Deleting the Pod is what releases it. Then the deletion completes for real, and the operator — which still wants three instances — provisions a fresh claim, a fresh volume, and re-clones the instance from the primary.`,
      instructions: `Delete the claim:

\`\`\`
kubectl delete pvc pg-cluster-3 --wait=false
kubectl get pvc pg-cluster-3
\`\`\`

It reports \`Terminating\`, and stays there. The instance is unaffected:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

Find out what is holding it:

\`\`\`
kubectl get pvc pg-cluster-3 -o jsonpath='{.metadata.deletionTimestamp}{"  finalizers="}{.metadata.finalizers}{"\\n"}'
\`\`\`

The finalizer is \`kubernetes.io/pvc-protection\`: a deletion timestamp has been set, but the object cannot go while a Pod still mounts it. This is the mechanism that stops a careless \`kubectl delete pvc\` from destroying a running database's storage.

Now release it by deleting the Pod:

\`\`\`
kubectl delete pod pg-cluster-3 --wait=false
\`\`\`

Watch what follows:

\`\`\`
kubectl get pvc
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

The claim disappears, and a new one with the same name appears bound to a **different** volume. The operator noticed an instance it was supposed to have was gone, provisioned fresh storage, and re-cloned the instance from the primary — a real base backup over the network, not a reattach. Give it a minute to finish and report healthy again.`,
      hint: `Deleting the Pod is what completes the claim's deletion — until then the finalizer holds it. If the new claim is stuck \`Pending\`, its Pod has not been scheduled yet; \`local-path\` only binds once a Pod needs it.`,
      solution: `kubectl delete pvc pg-cluster-3 --wait=false
kubectl get pvc pg-cluster-3
kubectl get pvc pg-cluster-3 -o jsonpath='{.metadata.deletionTimestamp}{"  finalizers="}{.metadata.finalizers}{"\\n"}'
kubectl delete pod pg-cluster-3 --wait=false
kubectl get pvc
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster`,
    },

    {
      id: 'confirm-rebuild',
      title: 'Confirm the instance was rebuilt, not reattached',
      limitSec: 420,
      criteria: [
        'Two replicas are streaming from the primary',
        "The 'before-pvc-deletion' row is present on every instance",
        'The primary never changed',
      ],
      brief: `Prove the rebuild really is a rebuild, and that it cost nothing but time.

The replacement instance is streaming from the primary again, and it holds the row you wrote before any of this — which it can only have got by copying the database from the primary, because its own storage was destroyed and replaced.

Check the primary too. It never changed: destroying a replica's storage is not a reason to promote anyone, so there was no failover, no timeline change and no interruption to writes.`,
      instructions: `Confirm replication is back to full strength:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Two rows, both streaming, including the rebuilt instance. Now ask every instance what it holds:

\`\`\`
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT note FROM pvc_proof ORDER BY id;"; done
\`\`\`

The rebuilt instance has the row — copied from the primary during the rebuild, since its own copy was destroyed with its volume.

And confirm the volumes tell the story:

\`\`\`
cat /root/old-volume.txt
kubectl get pvc
\`\`\`

The volume you recorded is gone from the list entirely. Nothing reattached; the storage was re-provisioned and refilled.

Finally, the leadership question:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
\`\`\`

Same primary, still timeline 1 — no promotion happened, because none was needed.`,
      hint: `If the rebuilt instance reports "relation does not exist", the clone has not finished replaying yet — wait for \`kubectl get cluster.postgresql.cnpg.io pg-cluster\` to read 3/3 healthy and ask again.`,
      solution: `PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do echo "== $p"; kubectl exec $p -c postgres -- psql -U postgres -d app -tAc "SELECT note FROM pvc_proof ORDER BY id;"; done
cat /root/old-volume.txt
kubectl get pvc
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'`,
    },
  ],
}
