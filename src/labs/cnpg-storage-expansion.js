// Confirmed live against a real K3D + CloudNativePG deploy with a real CSI driver (server/csi.go,
// see LABORATORY.md): patching spec.storage.size from 1Gi to 2Gi moved the claim's request
// immediately and its status.capacity a minute or so later, with the PVC's events reading
// ExternalExpanding → Resizing → FileSystemResizeRequired → FileSystemResizeSuccessful, the
// instance never restarted and the volume behind the claim unchanged. Shrinking is refused by the
// operator's webhook — `spec.storage: Invalid value: "1Gi": can't shrink existing storage from
// 2Gi to 1Gi` — and a bound claim on k3s's own local-path class is refused by the API server:
// `only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc
// must support resize`.
//
// Self-contained, like every lab here: the CSI driver, the operator, a single-instance cluster on
// an expandable StorageClass, a seeded table and a client Pod are this lab's starting state,
// built by its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content
// contract").

export const cnpgStorageExpansion = {
  id: 'cnpg-storage-expansion',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real CSI driver whose volumes can actually be grown, and a real PostgreSQL cluster sitting on it, all thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: the CSI driver is installed and waited for before the operator is, and the database is bootstrapped after that.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The csi-driver-host-path CSI driver, with a StorageClass called csi-hostpath-sc that allows volume expansion — alongside k3s\'s own local-path class, which does not',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A single-instance Cluster named pg-cluster on csi-hostpath-sc with a 1Gi volume, pinned to the node the CSI driver runs on',
      'A table called notes in its application database, owned by the app user, holding 50 rows',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A database that has filled its disk is not a database any more, and the fix has to happen without moving the data. Kubernetes can grow a volume under a running Pod — but only if the StorageClass it came from says so, and only in one direction. You will find out which of this cluster\'s two classes allows it, grow a running PostgreSQL instance\'s volume from 1Gi to 2Gi and watch the resize travel from the operator to the claim to the filesystem, and then walk into both of the walls this feature has.',
  },

  tasks: [
    {
      id: 'read-the-classes',
      title: 'Find out whether you can grow anything at all',
      limitSec: 420,
      criteria: [
        'Only one of the two StorageClasses allows volume expansion',
        "The cluster's volume is 1Gi on the class that allows it",
        '/root/expandable-class.txt was written',
        'It names the class that allows expansion',
      ],
      brief: `Expanding a volume is not a database feature, and CloudNativePG cannot do it on its own. It asks Kubernetes, Kubernetes asks the storage driver, and the driver either can or cannot.

Whether it can is written down in one field on the StorageClass: \`allowVolumeExpansion\`. If it is absent or false, the request is refused before anything reaches the driver, and no amount of patching the Cluster will change that.

This environment has two classes, deliberately: the CSI driver's, which allows expansion, and k3s's own \`local-path\`, which does not. Read both, find which one the database is actually on, and write that class name down.`,
      instructions: `Work in the **k3d-server** tab. Start with the classes:

\`\`\`
kubectl get storageclass
kubectl get storageclass -o custom-columns=NAME:.metadata.name,PROVISIONER:.provisioner,EXPANSION:.allowVolumeExpansion,BINDING:.volumeBindingMode
\`\`\`

\`csi-hostpath-sc\` says \`true\`; \`local-path\` says nothing at all, and an absent value means false. That single field decides everything else in this lab.

Now the database's own storage:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pvc
kubectl get cluster pg-cluster -o jsonpath='{.spec.storage}{"\\n"}'
\`\`\`

One instance, one claim, 1Gi, on \`csi-hostpath-sc\`. Note \`resizeInUseVolumes: true\` in the Cluster's storage block — that is CloudNativePG saying it is willing to grow claims that are currently mounted, which is the interesting case and the default.

Look at the claim in more detail, because the two numbers that matter live in different places:

\`\`\`
kubectl get pvc pg-cluster-1 \\
  -o custom-columns=NAME:.metadata.name,REQUESTED:.spec.resources.requests.storage,ACTUAL:.status.capacity.storage,VOLUME:.spec.volumeName
\`\`\`

\`spec.resources.requests.storage\` is what has been asked for. \`status.capacity.storage\` is what the volume actually is. Right now they agree; the whole of the next objective is the gap between them while a resize is in flight.

Record the class that can be grown:

\`\`\`
kubectl get pvc pg-cluster-1 -o jsonpath='{.spec.storageClassName}{"\\n"}' > /root/expandable-class.txt
cat /root/expandable-class.txt
\`\`\`

And check the data you will be confirming is still there at the end:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\``,
      hint: `\`allowVolumeExpansion\` is a field on the StorageClass, not on the claim or the Cluster — \`kubectl get storageclass -o yaml\` shows it in full if the custom-columns view is ambiguous.`,
      solution: `kubectl get storageclass -o custom-columns=NAME:.metadata.name,PROVISIONER:.provisioner,EXPANSION:.allowVolumeExpansion,BINDING:.volumeBindingMode
kubectl get cluster pg-cluster
kubectl get pvc
kubectl get cluster pg-cluster -o jsonpath='{.spec.storage}{"\\n"}'
kubectl get pvc pg-cluster-1 -o custom-columns=NAME:.metadata.name,REQUESTED:.spec.resources.requests.storage,ACTUAL:.status.capacity.storage,VOLUME:.spec.volumeName
kubectl get pvc pg-cluster-1 -o jsonpath='{.spec.storageClassName}{"\\n"}' > /root/expandable-class.txt
cat /root/expandable-class.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"`,
    },

    {
      id: 'expand-it',
      title: 'Grow the volume under a running database',
      limitSec: 600,
      criteria: [
        'The Cluster asks for 2Gi',
        'And the claim has actually grown to 2Gi',
        'On the same volume it started on — nothing was recreated',
        'The cluster is healthy and the 50 rows are still there',
      ],
      brief: `One field on the Cluster, and the request travels a long way: the operator writes the new size onto the claim, the resize controller notices, the CSI driver grows the volume, and finally the kubelet grows the filesystem on top of it while the Pod keeps running.

You can watch every step of that in the claim's events, which is worth doing once — when a resize gets stuck in the real world, it is stuck at one of those handoffs, and the events tell you which.

The thing to prove at the end is that this was an expansion and not a replacement. The claim keeps its name either way; the volume behind it does not.`,
      instructions: `Note the volume the claim is bound to before you start, because that is the identity that matters:

\`\`\`
kubectl get pvc pg-cluster-1 -o jsonpath='{.spec.volumeName}{"\\n"}'
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
\`\`\`

Now ask for more room:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"storage":{"size":"2Gi"}}}'
\`\`\`

Watch the two numbers separate and then meet again — run this a few times over the next minute or two:

\`\`\`
kubectl get pvc pg-cluster-1 \\
  -o custom-columns=NAME:.metadata.name,REQUESTED:.spec.resources.requests.storage,ACTUAL:.status.capacity.storage
\`\`\`

The request becomes 2Gi at once; the capacity follows a minute or so later. In between, the claim is telling you the truth: somebody has asked for a bigger volume and it is not one yet.

Read how it happened:

\`\`\`
kubectl describe pvc pg-cluster-1 | tail -12
\`\`\`

Four events, in order: **ExternalExpanding** (Kubernetes hands the request to the driver), **Resizing** (the driver grows the volume), **FileSystemResizeRequired** (the volume is bigger but the filesystem on it is not), and **FileSystemResizeSuccessful** from the kubelet on the node (the filesystem now uses the space). That last step is why an offline resize is sometimes needed on other drivers — the filesystem has to be grown where it is mounted.

Confirm nothing was replaced or restarted:

\`\`\`
kubectl get pvc pg-cluster-1 -o jsonpath='{.spec.volumeName}{"\\n"}'
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
kubectl get cluster pg-cluster
\`\`\`

Same volume, same Pod, same creation timestamp, no restarts, cluster healthy. PostgreSQL was serving throughout:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO notes (entry) VALUES ('written while the volume grew') RETURNING id;"
\`\`\``,
      hint: `If the ACTUAL column is still 1Gi, give it another minute and look again — the resize is asynchronous and passes through three different components before the number changes. The last step, the filesystem resize, is done by the kubelet and took about a minute in this environment.`,
      solution: `kubectl get pvc pg-cluster-1 -o jsonpath='{.spec.volumeName}{"\\n"}'
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"storage":{"size":"2Gi"}}}'
sleep 90
kubectl get pvc pg-cluster-1 -o custom-columns=NAME:.metadata.name,REQUESTED:.spec.resources.requests.storage,ACTUAL:.status.capacity.storage
kubectl describe pvc pg-cluster-1 | tail -12
kubectl get pvc pg-cluster-1 -o jsonpath='{.spec.volumeName}{"\\n"}'
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"`,
    },

    {
      id: 'the-limits',
      title: 'Walk into both walls',
      limitSec: 600,
      criteria: [
        '/root/shrink-error.txt records the refusal',
        'The Cluster still asks for 2Gi — the refusal changed nothing',
        '/root/no-expansion-error.txt records what a class without expansion says',
        'The cluster is healthy and still on its original volume',
      ],
      brief: `Two things this cannot do, and both of them are refusals rather than failures — which is the good kind, because nothing is half done afterwards.

The first is shrinking. Kubernetes has no mechanism for making a volume smaller, and CloudNativePG's admission webhook refuses the request before the API server stores it, naming both sizes so you know exactly what it thought you were asking for.

The second is expansion on a class that does not support it. That refusal comes from the API server itself, on the claim, and it is worth provoking once so you recognise the sentence: it is the one that appears when somebody tries this in production on a class nobody checked.`,
      instructions: `Try to give the space back:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"storage":{"size":"1Gi"}}}' 2>&1 \\
  | tee /root/shrink-error.txt
\`\`\`

\`can't shrink existing storage from 2Gi to 1Gi\` — from the operator's validating webhook, before anything was written. Confirm nothing changed:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.storage.size}{"\\n"}'
kubectl get pvc pg-cluster-1 -o custom-columns=REQUESTED:.spec.resources.requests.storage,ACTUAL:.status.capacity.storage
\`\`\`

Still 2Gi on both counts. A rejected patch is rejected whole.

Now the other wall. Make an ordinary claim on the class that does not allow expansion, and give it a Pod so it actually binds — a claim with \`volumeBindingMode: WaitForFirstConsumer\` stays Pending until something mounts it, and Kubernetes will not discuss resizing a claim that is not bound:

\`\`\`
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: scratch
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: scratch-user
spec:
  containers:
  - name: c
    image: ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie
    command: ["sleep", "infinity"]
    volumeMounts: [{name: v, mountPath: /scratch}]
  volumes:
  - name: v
    persistentVolumeClaim: {claimName: scratch}
YAML
sleep 25
kubectl get pvc scratch
\`\`\`

Once it is \`Bound\`, ask for it to grow:

\`\`\`
kubectl patch pvc scratch --type=merge -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}' 2>&1 \\
  | tee /root/no-expansion-error.txt
\`\`\`

\`only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize\`. That is the API server, not the operator and not the driver — the request never gets far enough for anybody else to have an opinion.

Tidy up and confirm the database is exactly where you left it:

\`\`\`
kubectl delete pod scratch-user --wait=false
kubectl delete pvc scratch --wait=false
kubectl get cluster pg-cluster
kubectl get pvc pg-cluster-1 -o custom-columns=NAME:.metadata.name,ACTUAL:.status.capacity.storage,VOLUME:.spec.volumeName
\`\`\`

Two practical conclusions to leave with. Choosing a StorageClass is choosing whether your databases can ever be grown in place, and it is not a decision you can revisit later on volumes that already exist. And because expansion is one-way, the size you pick is a floor rather than a target — the cost of asking for too much is money, and the cost of asking for too little is a migration.`,
      hint: `\`tee\` writes the output to the file *and* shows it to you, which is what both of these steps want — the error message is the artifact.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"storage":{"size":"1Gi"}}}' 2>&1 | tee /root/shrink-error.txt
kubectl get cluster pg-cluster -o jsonpath='{.spec.storage.size}{"\\n"}'
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: scratch
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: scratch-user
spec:
  containers:
  - name: c
    image: ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie
    command: ["sleep", "infinity"]
    volumeMounts: [{name: v, mountPath: /scratch}]
  volumes:
  - name: v
    persistentVolumeClaim: {claimName: scratch}
YAML
sleep 25
kubectl patch pvc scratch --type=merge -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}' 2>&1 | tee /root/no-expansion-error.txt
kubectl delete pod scratch-user --wait=false
kubectl delete pvc scratch --wait=false
kubectl get cluster pg-cluster`,
    },
  ],
}
