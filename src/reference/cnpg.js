// CloudNativePG command reference.
//
// Every `run` here is a command one of the labs in src/labs/ actually gives the learner, and
// every `out` is that command's real output, captured from a real run against a real k3d +
// CloudNativePG cluster — the same rule the labs themselves follow (see CLAUDE.md, "Command
// reference contract"). Nothing on this page is illustrative or reconstructed. Object names,
// UUIDs, addresses and ages are whatever that run produced; they are examples of shape, not
// values to expect.
//
// Adding a command to a lab means adding it here, with its own real output, in the same
// change.

export const cnpgReference = {
  id: 'cnpg',
  title: 'CloudNativePG',
  blurb: 'The kubectl, cnpg plugin, psql and openssl commands the CloudNativePG labs teach.',
  intro: `Every command below appears in at least one lab, and every sample output is real — captured from a run against a real 3-node k3d cluster running CloudNativePG v1.30.0 with a 3-instance Cluster named \`pg-cluster\`.

Names, UUIDs, IP addresses and ages come from those runs, so treat them as examples of shape rather than values to expect. Which instance is primary in particular changes constantly, and every lab that matters asks the cluster rather than assuming.

Two environment-specific conventions show up throughout. \`kubectl\` runs **inside** a k3s node container, which is what a lab terminal gives you a shell on, and the nodes carry no \`openssl\` or \`psql\` — those live in the PostgreSQL image, so anything needing them runs inside a Pod.`,

  groups: [
    {
      id: 'survey',
      title: 'Surveying the cluster',
      blurb: 'Where every lab starts: what nodes exist, what is running, and which instance is primary right now.',
      commands: [
        {
          id: 'get-nodes',
          name: 'kubectl get nodes -o wide',
          summary:
            'Lists the Kubernetes nodes with their roles and versions. Exactly one node is control-plane; the labs address the three of them as k3d-server, k3d-agent-1 and k3d-agent-2, which are the terminal tab names, not the real container names kubectl prints.',
          usedIn: ['cnpg-operator-install'],
          examples: [
            {
              run: 'kubectl get nodes -o wide',
              out: `NAME                             STATUS   ROLES           AGE     VERSION        INTERNAL-IP   EXTERNAL-IP   OS-IMAGE           KERNEL-VERSION   CONTAINER-RUNTIME
k3d-dbol-510934af849e-agent-0    Ready    <none>          7m16s   v1.35.5+k3s1   172.19.0.4    <none>        K3s v1.35.5+k3s1   6.18.36-0-virt   containerd://2.2.3-k3s1
k3d-dbol-510934af849e-agent-1    Ready    <none>          7m17s   v1.35.5+k3s1   172.19.0.3    <none>        K3s v1.35.5+k3s1   6.18.36-0-virt   containerd://2.2.3-k3s1
k3d-dbol-510934af849e-server-0   Ready    control-plane   7m27s   v1.35.5+k3s1   172.19.0.2    <none>        K3s v1.35.5+k3s1   6.18.36-0-virt   containerd://2.2.3-k3s1`,
            },
          ],
          notes: [
            'The ROLES column reads `control-plane` for exactly one node and `<none>` for the others — there is no "worker" role in Kubernetes, only the absence of a control-plane label.',
          ],
        },
        {
          id: 'get-pods-role',
          name: 'kubectl get pods -o wide -L cnpg.io/instanceRole',
          summary:
            "Lists the Pods with an extra column for CloudNativePG's instance role label. Exactly one instance reads primary; that label is what the read-write Service selects on, and the operator moves it during a failover or switchover.",
          usedIn: [
            'cnpg-cluster-creation',
            'cnpg-persistent-volume',
            'cnpg-service-connectivity',
            'cnpg-failover',
            'cnpg-switchover',
            'cnpg-failover-endpoint-time',
          ],
          examples: [
            {
              run: 'kubectl get pods -o wide -L cnpg.io/instanceRole',
              out: `NAME           READY   STATUS    RESTARTS   AGE     IP          NODE                             NOMINATED NODE   READINESS GATES   INSTANCEROLE
pg-cluster-1   1/1     Running   0          57s     10.42.3.5   k3d-dbol-5ddf66b7e9f8-agent-0    <none>           <none>            replica
pg-cluster-2   1/1     Running   0          2m19s   10.42.1.6   k3d-dbol-5ddf66b7e9f8-agent-1    <none>           <none>            primary
pg-cluster-3   1/1     Running   0          97s     10.42.0.7   k3d-dbol-5ddf66b7e9f8-server-0   <none>           <none>            replica
psql-client    1/1     Running   0          83s     10.42.0.8   k3d-dbol-5ddf66b7e9f8-server-0   <none>           <none>`,
            },
          ],
          notes: [
            'The Pod named `pg-cluster-1` is not permanently the primary. This capture is from just after a failover — instance 1 was destroyed, instance 2 was promoted, and instance 1 came back as a replica.',
            '`-L <label>` adds a column for a label; `-l <label>=<value>` filters by one. The labs use both.',
          ],
        },
        {
          id: 'get-cluster',
          name: 'kubectl get cluster.postgresql.cnpg.io <name>',
          summary:
            "The operator's own summary of the database: how many instances it wants, how many are ready, the human-readable phase, and which instance is primary. This is the single most useful command in every lab.",
          usedIn: [
            'cnpg-cluster-creation',
            'cnpg-persistent-volume',
            'cnpg-failover',
            'cnpg-switchover',
            'cnpg-failover-endpoint-time',
            'cnpg-server-certificates',
          ],
          examples: [
            {
              run: 'kubectl get cluster.postgresql.cnpg.io pg-cluster',
              out: `NAME         AGE     INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   4m15s   3           3       Cluster in healthy state   pg-cluster-2`,
            },
            {
              run: `kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}'`,
              out: 'pg-cluster-2',
              note: 'The scriptable form. jsonpath prints no trailing newline, which is what makes it safe to redirect straight into a file.',
            },
          ],
          notes: [
            'The full resource name is needed because `cluster` is ambiguous with other CRDs; `kubectl get cluster` alone usually works but is not safe in a script.',
            'STATUS is a real state machine, not decoration: "Setting up primary", "Creating a new replica", "Waiting for the instances to become active", "Switchover in progress", "Failing over", "Cluster in healthy state".',
          ],
        },
        {
          id: 'object-metadata',
          name: 'kubectl get all,pvc,secret -l cnpg.io/cluster=<name>',
          summary:
            'Every object the operator generates for a Cluster carries the same label naming it, so one selector inventories the lot. The per-kind role labels beside it are what the Services select on — they are the routing, not documentation.',
          usedIn: ['cnpg-object-metadata'],
          examples: [
            {
              run: `kubectl get pod pg-cluster-1 -o json | jq -S '.metadata.labels'`,
              out: `{
  "app.kubernetes.io/component": "database",
  "app.kubernetes.io/instance": "pg-cluster",
  "app.kubernetes.io/managed-by": "cloudnative-pg",
  "app.kubernetes.io/name": "postgresql",
  "app.kubernetes.io/version": "18",
  "cnpg.io/cluster": "pg-cluster",
  "cnpg.io/instanceName": "pg-cluster-1",
  "cnpg.io/instanceRole": "primary",
  "cnpg.io/podRole": "instance",
  "role": "primary"
}`,
              note: 'Two families: the Kubernetes-wide recommended app.kubernetes.io/ labels, and the operator\'s own cnpg.io/ ones. `role` is the older unprefixed form of `cnpg.io/instanceRole`, still written for compatibility.',
            },
            {
              run: `kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/podRole,cnpg.io/instanceRole
kubectl get pvc -l cnpg.io/cluster=pg-cluster -L cnpg.io/pvcRole,cnpg.io/instanceRole
kubectl get secret pg-cluster-app -o json | jq -S -c '.metadata.labels'`,
              out: `NAME           READY   STATUS    RESTARTS   AGE    PODROLE    INSTANCEROLE
pg-cluster-1   1/1     Running   0          113s   instance   primary
pg-cluster-2   1/1     Running   0          75s    instance   replica
pg-cluster-3   1/1     Running   0          34s    instance   replica
NAME           STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   PVCROLE   INSTANCEROLE
pg-cluster-1   Bound    pvc-51f0f8b0-5536-40cf-8926-6a0dbb881eb0   1Gi        RWO            local-path     PG_DATA   primary
pg-cluster-2   Bound    pvc-fd738746-e698-4b98-8d44-e5006b606e3d   1Gi        RWO            local-path     PG_DATA   replica
pg-cluster-3   Bound    pvc-6d5057c8-57d4-436e-9ee3-360dacce52dd   1Gi        RWO            local-path     PG_DATA   replica
{"app.kubernetes.io/managed-by":"cloudnative-pg","cnpg.io/cluster":"pg-cluster","cnpg.io/reload":"true","cnpg.io/userType":"app"}`,
              note: 'The claims listing has its VOLUMEATTRIBUTESCLASS and AGE columns elided for width. `cnpg.io/reload=true` on the Secret is a request rather than a description — it asks the operator to reload the instances when the Secret changes.',
            },
            {
              run: `kubectl get pods -l cnpg.io/cluster=pg-cluster -o json \\
  | jq -r '.items[] | [.metadata.name, .metadata.annotations["cnpg.io/nodeSerial"], .metadata.annotations["cnpg.io/operatorVersion"]] | @tsv'
kubectl get pvc pg-cluster-1 -o json | jq -c '.metadata.annotations | {nodeSerial: ."cnpg.io/nodeSerial", pvcStatus: ."cnpg.io/pvcStatus"}'`,
              out: `pg-cluster-1	1	1.30.0
pg-cluster-2	2	1.30.0
pg-cluster-3	3	1.30.0
{"nodeSerial":"1","pvcStatus":"ready"}`,
              note: 'nodeSerial appears on both the Pod and its claim, which is how a rebuilt Pod finds the volume that belongs to it.',
            },
            {
              run: `kubectl label pod pg-cluster-2 cnpg.io/instanceRole=primary --overwrite
for i in $(seq 1 16); do printf "%s %s\\n" "$(date +%H:%M:%S.%2N)" "$(kubectl get pod pg-cluster-2 -o jsonpath='{.metadata.labels.cnpg\\.io/instanceRole}')"; sleep 0.25; done`,
              out: `pod/pg-cluster-2 labeled
17:50:43.43 primary
17:50:43.71 primary
17:50:43.98 primary
17:50:44.25 primary
17:50:44.52 replica
17:50:44.79 replica
17:50:45.06 replica
17:50:45.33 replica`,
              note: 'Output truncated after the change is reverted. The operator recomputes the role from the cluster\'s real state on every event, so the hand-written value survives about a second and the read-write Service never gains a second endpoint. A label of your own on the same Pod is left alone indefinitely.',
            },
          ],
          notes: [
            '`kubectl get all` does not include PersistentVolumeClaims or Secrets — ask for them by name in the same command.',
            'The Services are pure selectors: -rw on `cnpg.io/instanceRole=primary`, -ro on `=replica`, -r on `cnpg.io/podRole=instance`. A failover, from the Service\'s point of view, is a relabelling.',
            'Promotion is not something a label can do; the label is a consequence of the promotion. Use the operator\'s own mechanisms and keep your metadata under your own keys.',
          ],
        },
      ],
    },

    {
      id: 'operator',
      title: 'Installing and inspecting the operator',
      blurb: 'One manifest creates the namespace, the CRDs, the RBAC and the controller Deployment.',
      commands: [
        {
          id: 'apply-server-side',
          name: 'kubectl apply --server-side -f <release manifest>',
          summary:
            "Installs CloudNativePG from the release manifest that ships inside each tagged release — the method the project's own Quickstart and end-to-end tests use. Server-side apply is required, not optional.",
          usedIn: ['cnpg-operator-install'],
          examples: [
            {
              run: 'kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml',
              out: `namespace/cnpg-system serverside-applied
customresourcedefinition.apiextensions.k8s.io/backups.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/clusterimagecatalogs.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/clusters.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/databaseroles.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/databases.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/failoverquorums.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/imagecatalogs.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/poolers.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/publications.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/scheduledbackups.postgresql.cnpg.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/subscriptions.postgresql.cnpg.io serverside-applied
serviceaccount/cnpg-manager serverside-applied
clusterrole.rbac.authorization.k8s.io/cnpg-database-editor-role serverside-applied
clusterrole.rbac.authorization.k8s.io/cnpg-database-viewer-role serverside-applied
clusterrole.rbac.authorization.k8s.io/cnpg-manager serverside-applied
clusterrole.rbac.authorization.k8s.io/cnpg-publication-editor-role serverside-applied
clusterrole.rbac.authorization.k8s.io/cnpg-publication-viewer-role serverside-applied
clusterrole.rbac.authorization.k8s.io/cnpg-subscription-editor-role serverside-applied
clusterrole.rbac.authorization.k8s.io/cnpg-subscription-viewer-role serverside-applied
clusterrolebinding.rbac.authorization.k8s.io/cnpg-manager-rolebinding serverside-applied
configmap/cnpg-default-monitoring serverside-applied
service/cnpg-webhook-service serverside-applied
deployment.apps/cnpg-controller-manager serverside-applied
mutatingwebhookconfiguration.admissionregistration.k8s.io/cnpg-mutating-webhook-configuration serverside-applied
validatingwebhookconfiguration.admissionregistration.k8s.io/cnpg-validating-webhook-configuration serverside-applied`,
            },
          ],
          notes: [
            "Without `--server-side` the apply fails outright. A client-side apply stores the whole manifest back on the object in a `kubectl.kubernetes.io/last-applied-configuration` annotation, and CloudNativePG's CRDs are far larger than Kubernetes' 256 KB annotation limit.",
            'Applying it a second time reports `serverside-applied` for objects that were already there, so the install is safely repeatable.',
          ],
        },
        {
          id: 'get-crd-cnpg',
          name: 'kubectl get crd | grep cnpg.io',
          summary:
            'Lists the custom resource definitions the operator registered — 11 of them, all sharing one creation timestamp because they arrive in a single apply.',
          usedIn: ['cnpg-operator-install'],
          examples: [
            {
              run: 'kubectl get crd | grep cnpg.io',
              out: `backups.postgresql.cnpg.io                2026-08-15T07:16:55Z
clusterimagecatalogs.postgresql.cnpg.io   2026-08-15T07:16:55Z
clusters.postgresql.cnpg.io               2026-08-15T07:16:55Z
databaseroles.postgresql.cnpg.io          2026-08-15T07:16:55Z
databases.postgresql.cnpg.io              2026-08-15T07:16:55Z
failoverquorums.postgresql.cnpg.io        2026-08-15T07:16:55Z
imagecatalogs.postgresql.cnpg.io          2026-08-15T07:16:55Z
poolers.postgresql.cnpg.io                2026-08-15T07:16:55Z
publications.postgresql.cnpg.io           2026-08-15T07:16:55Z
scheduledbackups.postgresql.cnpg.io       2026-08-15T07:16:55Z
subscriptions.postgresql.cnpg.io          2026-08-15T07:16:55Z`,
            },
          ],
          notes: [
            'CRDs being registered is not the same as the operator being usable: every Cluster is validated through an admission webhook served by the operator Pod, so wait for the Pod, not the CRDs.',
          ],
        },
        {
          id: 'operator-pods',
          name: 'kubectl -n cnpg-system get pods',
          summary:
            'Shows the operator itself: a single-replica Deployment in its own namespace. This one Pod runs the reconciliation loop and serves the admission webhook.',
          usedIn: ['cnpg-operator-install'],
          examples: [
            {
              run: 'kubectl -n cnpg-system get pods',
              out: `NAME                                       READY   STATUS    RESTARTS   AGE
cnpg-controller-manager-695fcbbb85-xg2b9   1/1     Running   0          5m45s`,
            },
          ],
          notes: [
            'A Cluster applied before this Pod is Running fails with `no endpoints available for service "cnpg-webhook-service"`.',
          ],
        },
        {
          id: 'operator-image',
          name: 'kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath=…',
          summary:
            'Reads back the image the operator Deployment is actually running, which is the only trustworthy statement of which version is in charge — the file name you applied is not.',
          usedIn: ['cnpg-operator-install'],
          examples: [
            {
              run: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}'`,
              out: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0',
            },
          ],
        },
      ],
    },

    {
      id: 'cluster',
      title: 'Creating a Cluster and its storage',
      blurb: 'A five-line spec, and the Pods, PVCs, Services and Secrets the operator builds from it.',
      commands: [
        {
          id: 'apply-cluster',
          name: 'kubectl apply -f cluster.yaml',
          summary:
            'Creates the Cluster resource. Everything else — Pods, one PVC per instance, three Services, the credentials Secret, streaming replication — is generated by the operator from it.',
          usedIn: ['cnpg-cluster-creation'],
          examples: [
            {
              run: 'kubectl apply -f cluster.yaml',
              out: 'cluster.postgresql.cnpg.io/pg-cluster created',
            },
            {
              run: 'kubectl get cluster.postgresql.cnpg.io pg-cluster',
              out: `NAME         AGE   INSTANCES   READY   STATUS               PRIMARY
pg-cluster   25s   1                   Setting up primary`,
              note: '25 seconds in: one instance exists and initdb is still running on it. READY and PRIMARY stay empty until the primary is up.',
            },
          ],
          notes: [
            'Bootstrapping is serial by design: initdb on the primary, then a join per replica, so a 3-instance cluster takes minutes to reach "Cluster in healthy state".',
          ],
        },
        {
          id: 'get-pvc',
          name: 'kubectl get pvc',
          summary:
            'One PersistentVolumeClaim per instance, named identically to its Pod. On k3s these bind against the bundled local-path StorageClass.',
          usedIn: ['cnpg-persistent-volume', 'cnpg-switchover'],
          examples: [
            {
              run: 'kubectl get pvc',
              out: `NAME           STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
pg-cluster-1   Bound    pvc-3e68a5eb-503c-44fe-a045-328b10323bd6   1Gi        RWO            local-path     <unset>                 5m26s
pg-cluster-2   Bound    pvc-1b0ec56f-be5e-44ce-b46f-fbe0fcd603d6   1Gi        RWO            local-path     <unset>                 4m35s
pg-cluster-3   Bound    pvc-0ef694f3-dceb-4697-bcf6-c5ca3e4881ba   1Gi        RWO            local-path     <unset>                 3m54s`,
            },
          ],
          notes: [
            'The VOLUME column is the thing to watch across a failover or switchover: the same volume name and the same age means the instance reattached to its data, rather than being re-cloned.',
          ],
        },
        {
          id: 'storage-expansion',
          name: 'spec.storage.size (volume expansion)',
          summary:
            'Grows a running instance\'s volume in place — if the StorageClass allows it. Expansion is one-way, and the two numbers that tell you whether it has finished live in different places on the claim.',
          usedIn: ['cnpg-storage-expansion'],
          examples: [
            {
              run: `kubectl get storageclass -o custom-columns=NAME:.metadata.name,PROVISIONER:.provisioner,EXPANSION:.allowVolumeExpansion,BINDING:.volumeBindingMode
kubectl get pvc pg-cluster-1 -o custom-columns=NAME:.metadata.name,REQUESTED:.spec.resources.requests.storage,ACTUAL:.status.capacity.storage,VOLUME:.spec.volumeName`,
              out: `NAME              PROVISIONER             EXPANSION   BINDING
csi-hostpath-sc   hostpath.csi.k8s.io     true        WaitForFirstConsumer
local-path        rancher.io/local-path   <none>      WaitForFirstConsumer
NAME           REQUESTED   ACTUAL   VOLUME
pg-cluster-1   1Gi         1Gi      pvc-a97e1785-b950-4d2b-8922-43edee78f32a`,
              note: 'An absent allowVolumeExpansion means false. k3s\'s own local-path cannot grow a volume; the CSI driver\'s class can.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"storage":{"size":"2Gi"}}}'
kubectl get pvc pg-cluster-1 -o custom-columns=REQUESTED:.spec.resources.requests.storage,ACTUAL:.status.capacity.storage
kubectl describe pvc pg-cluster-1 | tail -4`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
REQUESTED   ACTUAL
2Gi         1Gi
  Normal  ExternalExpanding           40s   volume_expand                         waiting for an external controller to expand this PVC
  Normal  Resizing                    40s   external-resizer hostpath.csi.k8s.io  External resizer is resizing volume pvc-a97e1785-b950-4d2b-8922-43edee78f32a
  Normal  FileSystemResizeRequired    40s   external-resizer hostpath.csi.k8s.io  Require file system resize of volume on node
  Normal  FileSystemResizeSuccessful  66s   kubelet                               MountVolume.NodeExpandVolume succeeded for volume "pvc-a97e1785-b950-4d2b-8922-43edee78f32a"`,
              note: 'The request moves at once and the capacity follows a minute or so later — the gap is the resize in flight. The event columns are elided for width; the four events are the four handoffs, and a stuck resize is stuck at one of them.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"storage":{"size":"1Gi"}}}'
kubectl patch pvc scratch --type=merge -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}'`,
              out: `The Cluster "pg-cluster" is invalid: spec.storage: Invalid value: "1Gi": can't shrink existing storage from 2Gi to 1Gi
Error from server (Forbidden): persistentvolumeclaims "scratch" is forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize`,
              note: 'Two different refusals: the first from the operator\'s validating webhook, the second from the API server on a bound claim whose StorageClass does not allow expansion. Neither leaves anything half done.',
            },
          ],
          notes: [
            'The claim keeps its name across a rebuild, so the only way to tell an expansion from a replacement is `spec.volumeName` — the volume behind it.',
            'Nothing restarts: the Pod keeps its creation timestamp and PostgreSQL serves throughout.',
            '`resizeInUseVolumes` (default true) is CloudNativePG\'s willingness to grow claims that are currently mounted, which is the interesting case.',
          ],
        },
        {
          id: 'wal-storage',
          name: 'spec.walStorage',
          summary:
            'Gives the write-ahead log a volume of its own. Can be added to a running cluster, rearranges the data directory with a symbolic link, and cannot be removed afterwards.',
          usedIn: ['cnpg-wal-volume'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"walStorage":{"size":"1Gi"}}}'
kubectl get pvc
kubectl exec $PRIMARY -c postgres -- ls -ld /var/lib/postgresql/data/pgdata/pg_wal`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
NAME               STATUS   VOLUME                                     CAPACITY   STORAGECLASS   AGE
pg-cluster-1       Bound    pvc-6213e3fe-3c3b-49dc-abb1-d8cd23945aa6   1Gi        local-path     3m36s
pg-cluster-1-wal   Bound    pvc-3e04a2ca-042a-431e-9e68-b5c954a58f28   1Gi        local-path     59s
pg-cluster-2       Bound    pvc-d8626690-81e5-4ea3-83ce-6b62ac9c68a8   1Gi        local-path     2m44s
pg-cluster-2-wal   Bound    pvc-2b6ed6be-a0f4-461a-b51c-2355065056af   1Gi        local-path     59s
pg-cluster-3       Bound    pvc-4dfb0fe6-ac11-40df-9bb9-dfdc36ada660   1Gi        local-path     2m5s
pg-cluster-3-wal   Bound    pvc-54a0c331-58ae-43ad-9c81-f680dd25c1a0   1Gi        local-path     59s
lrwxrwxrwx 1 postgres tape 30 Aug 16 23:50 /var/lib/postgresql/data/pgdata/pg_wal -> /var/lib/postgresql/wal/pg_wal`,
              note: 'One -wal claim per instance, and the cluster rolls to mount them — replicas first, primary last, about 45 seconds for three. Claim columns elided for width. pg_wal is now a symlink out of the data volume.',
            },
            {
              run: `kubectl get pod $PRIMARY -o jsonpath='{range .spec.volumes[?(@.persistentVolumeClaim)]}{.name}{" -> "}{.persistentVolumeClaim.claimName}{"\\n"}{end}'
kubectl patch cluster pg-cluster --type=json -p '[{"op":"remove","path":"/spec/walStorage"}]'`,
              out: `pgdata -> pg-cluster-1
pg-wal -> pg-cluster-1-wal
The Cluster "pg-cluster" is invalid: spec.walStorage: Invalid value: null: walStorage cannot be disabled once configured`,
              note: 'Two claims mounted at two paths — and the field is a one-way door. The merge-patch form with `null` is refused by the same webhook with the same message.',
            },
          ],
          notes: [
            'The WAL claims are created on the *default* StorageClass unless `walStorage.storageClass` names one, which is a good way to accidentally put the log on slower storage than the data.',
            'Size it for `max_wal_size` plus whatever `wal_keep_size` and any replication slots retain — a WAL volume too small for that is a database that stops accepting writes.',
            'The size can still be grown later, exactly like the data volume, if the class allows expansion. The existence of the volume cannot be undone.',
          ],
        },
        {
          id: 'delete-pvc',
          name: 'kubectl delete pvc <instance>',
          summary:
            "Deleting a claim a running Pod is using appears to do nothing: a finalizer blocks it until the Pod releases it. Deleting the Pod completes the deletion for real, and the operator then provisions fresh storage and re-clones the instance.",
          usedIn: ['cnpg-pvc-deletion', 'cnpg-corrupted-pvc'],
          examples: [
            {
              run: `kubectl delete pvc pg-cluster-3 --wait=false
kubectl get pvc pg-cluster-3
kubectl get pvc pg-cluster-3 -o jsonpath='{.metadata.deletionTimestamp}{"  finalizers="}{.metadata.finalizers}{"\\n"}'`,
              out: `persistentvolumeclaim "pg-cluster-3" deleted from default namespace
NAME           STATUS        VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
pg-cluster-3   Terminating   pvc-cafe3740-29f8-4488-9e7c-0de576c01347   1Gi        RWO            local-path     <unset>                 69s
2026-08-15T08:26:14Z  finalizers=["kubernetes.io/pvc-protection"]`,
              note: 'The database carries on untouched while the claim sits in Terminating — this is protection, not a failure.',
            },
            {
              run: `kubectl delete pod pg-cluster-3 --wait=false
kubectl get pvc`,
              out: `pod "pg-cluster-3" deleted from default namespace
NAME           STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
pg-cluster-1   Bound    pvc-5e67b974-3cbf-4113-9628-18b90036f3da   1Gi        RWO            local-path     <unset>                 4m17s
pg-cluster-2   Bound    pvc-0cc19638-04c5-4380-ad87-9e5c45c5f2a0   1Gi        RWO            local-path     <unset>                 3m25s
pg-cluster-3   Bound    pvc-b7178013-a8bb-4b3e-b499-1edcfb51e35a   1Gi        RWO            local-path     <unset>                 74s`,
              note: 'Same claim name, different volume uuid: the storage was re-provisioned and the instance re-cloned from the primary.',
            },
          ],
          notes: [
            'The claim always comes back with the same name — instance claims are named after their instance — so the `pvc-<uuid>` volume name is the only thing that distinguishes rebuilt storage from reattached storage.',
          ],
        },
        {
          id: 'node-storage-path',
          name: 'ls /var/lib/rancher/k3s/storage/',
          summary:
            "Where local-path actually puts the data: a directory per claim on the node running its Pod, holding a real PostgreSQL data directory. Runs on the node itself, not in a Pod.",
          usedIn: ['cnpg-corrupted-pvc'],
          examples: [
            {
              run: `ls /var/lib/rancher/k3s/storage/
ls /var/lib/rancher/k3s/storage/pvc-9ddd3e44-da48-4d10-8b7f-3d0a2b6a0bb8_default_pg-cluster-3/pgdata`,
              out: `pvc-9ddd3e44-da48-4d10-8b7f-3d0a2b6a0bb8_default_pg-cluster-3
PG_VERSION
backup_label.old
backup_manifest
base
cnpg_initialized-pg-cluster-3
current_logfiles
custom.conf
global
override.conf
pg_commit_ts
pg_dynshmem
pg_hba.conf`,
              note: 'Truncated: the listing continues with the rest of a normal PGDATA.',
            },
          ],
          notes: [
            'The directory exists only on the node where that instance is running — check the NODE column of `kubectl get pods -o wide` and use that node\'s terminal tab.',
            'Directory names are `<volume>_<namespace>_<claim>`, so the volume uuid is visible in the path.',
          ],
        },
        {
          id: 'describe-pvc',
          name: 'kubectl describe pvc <instance>',
          summary:
            "Shows the annotation that decides where a local-path volume can ever live: `volume.kubernetes.io/selected-node`, written when the Pod was first scheduled. It is node-local hostPath storage, not a portable cloud volume.",
          usedIn: ['cnpg-persistent-volume'],
          examples: [
            {
              run: 'kubectl describe pvc pg-cluster-1',
              out: `Name:          pg-cluster-1
Namespace:     default
StorageClass:  local-path
Status:        Bound
Volume:        pvc-3e68a5eb-503c-44fe-a045-328b10323bd6
Labels:        app.kubernetes.io/component=database
               app.kubernetes.io/managed-by=cloudnative-pg
               app.kubernetes.io/name=postgresql
               cnpg.io/cluster=pg-cluster
               cnpg.io/instanceName=pg-cluster-1
               cnpg.io/instanceRole=primary
               cnpg.io/pvcRole=PG_DATA
               role=primary
Annotations:   cnpg.io/nodeSerial: 1
               cnpg.io/operatorVersion: 1.30.0
               cnpg.io/pvcStatus: ready
               pv.kubernetes.io/bind-completed: yes
               pv.kubernetes.io/bound-by-controller: yes`,
              note: 'Truncated to the first 18 lines; the selected-node annotation and the events follow below them.',
            },
          ],
        },
        {
          id: 'inherited-metadata-apply',
          name: 'spec.inheritedMetadata',
          summary:
            'Propagates your labels and annotations to the Pods, claims, Services and Secrets the operator creates. Applied within seconds, with nothing recreated — and with no protection against overwriting the operator\'s own keys.',
          usedIn: ['cnpg-inherited-metadata'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"team":"payments","cost-centre":"cc-4471"},"annotations":{"owner":"platform-db@example.com"}}}}'
kubectl get pods,pvc,svc,secret -l cnpg.io/cluster=pg-cluster -L team,cost-centre`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
NAME               READY   STATUS    RESTARTS   AGE    TEAM       COST-CENTRE
pod/pg-cluster-1   1/1     Running   0          2m4s   payments   cc-4471
pod/pg-cluster-2   1/1     Running   0          87s    payments   cc-4471
pod/pg-cluster-3   1/1     Running   0          46s    payments   cc-4471

NAME                                 STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   TEAM       COST-CENTRE
persistentvolumeclaim/pg-cluster-1   Bound    pvc-a6362505-6a72-489d-b209-a5a0c00344a9   1Gi        RWO            local-path     payments   cc-4471

NAME                    TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE     TEAM       COST-CENTRE
service/pg-cluster-rw   ClusterIP   10.43.162.161   <none>        5432/TCP   2m48s   payments   cc-4471

NAME                    TYPE                       DATA   AGE     TEAM       COST-CENTRE
secret/pg-cluster-app   kubernetes.io/basic-auth   11     2m48s   payments   cc-4471`,
              note: 'Claims and Services elided to one row each for width. The Pod ages are unchanged from before the patch — this is a metadata update on live objects, not a rolling update.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"team":"platform"}}}}'
kubectl get cluster pg-cluster -o jsonpath='{.spec.inheritedMetadata}'; echo
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"cost-centre":null}}}}'
kubectl get cluster pg-cluster -o jsonpath='{.spec.inheritedMetadata}'; echo
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team,cost-centre`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched (no change)
{"annotations":{"owner":"platform-db@example.com"},"labels":{"cost-centre":"cc-4471","team":"platform"}}
cluster.postgresql.cnpg.io/pg-cluster patched
{"annotations":{"owner":"platform-db@example.com"},"labels":{"team":"platform"}}
NAME           READY   STATUS    RESTARTS   AGE     TEAM       COST-CENTRE
pg-cluster-1   1/1     Running   0          2m51s   platform   cc-4471
pg-cluster-2   1/1     Running   0          2m14s   platform   cc-4471
pg-cluster-3   1/1     Running   0          93s     platform   cc-4471`,
              note: 'Two separate lessons in one capture. A merge patch that omits a key does not remove it — "patched (no change)" — and removing it with an explicit null takes it out of the spec but leaves it on every object that already has it, permanently.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"cnpg.io/instanceRole":"primary"}}}}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "INSERT INTO meta_demo (note) VALUES ('during') RETURNING id;"`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
NAME           READY   STATUS    RESTARTS   AGE     INSTANCEROLE
pg-cluster-1   1/1     Running   0          3m38s   primary
pg-cluster-2   1/1     Running   0          3m1s    primary
pg-cluster-3   1/1     Running   0          2m20s   primary
10.42.2.4 10.42.1.7 10.42.0.7
ERROR:  cannot execute INSERT in a read-only transaction`,
              note: 'Inherited metadata is applied after the operator\'s own, so it wins. All three Pods now claim to be the primary, the read-write Service has three endpoints, and five of six writes through it landed on a replica. Removing the override restored the true roles within 20 seconds.',
            },
          ],
          notes: [
            'Labels are selectable across kinds (`kubectl get pods,pvc,svc,secret -l team=payments`); annotations are not, and are for information such as an owner or a ticket.',
            'Inherit keys in a namespace you own. `cnpg.io/` belongs to the operator on these objects, and so does `app.kubernetes.io/`.',
            'The operator re-asserts the keys its own routing depends on the moment an override is removed, and leaves everything else exactly where it is — which is why a stale cost-centre label outlives the spec that asked for it while a stale instanceRole does not.',
            'There is an operator-wide equivalent, `INHERITED_LABELS` and `INHERITED_ANNOTATIONS` in the operator ConfigMap, which applies to every cluster and is read only at operator startup. This field is per-cluster and takes effect immediately.',
          ],
        },
        {
          id: 'declare-tablespaces',
          name: 'spec.tablespaces (declarative tablespaces)',
          summary:
            'A tablespace is a directory PostgreSQL may put relations in; here it is a declaration that becomes one claim per instance, mounted and registered with the server.',
          usedIn: ['cnpg-tablespaces', 'cnpg-temporary-tablespaces'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"tablespaces": [
    {"name": "reporting", "storage": {"size": "1Gi"}, "owner": {"name": "app"}},
    {"name": "archive",   "storage": {"size": "1Gi"}}
  ]}}'
for i in $(seq 1 12); do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-cluster -o jsonpath='{.status.phase}|{range .status.tablespacesStatus[*]}{.name}={.state} {end}'
  echo
  sleep 10
done`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
04:35:34 Waiting for the instances to become active|reporting=pending archive=pending
04:35:44 Upgrading cluster|reporting=pending archive=pending
04:36:04 Primary instance is being restarted without a switchover|reporting=pending archive=pending
04:36:15 Cluster in healthy state|reconciled archive=reconciled`,
              note: 'Attaching volumes replaces the Pods, so declaring a tablespace rolls the cluster — about 50 seconds for three instances. Rows elided from the middle of the loop.',
            },
            {
              run: `kubectl get pvc
kubectl get pvc pg-cluster-1-tbs-reporting -o jsonpath='{.metadata.labels}{"\\n"}'`,
              out: `pg-cluster-1                 Bound   1Gi   RWO   local-path   6m28s
pg-cluster-1-tbs-archive     Bound   1Gi   RWO   local-path   3m32s
pg-cluster-1-tbs-reporting   Bound   1Gi   RWO   local-path   3m32s
pg-cluster-2-tbs-archive     Bound   1Gi   RWO   local-path   3m32s
pg-cluster-2-tbs-reporting   Bound   1Gi   RWO   local-path   3m32s
{"cnpg.io/cluster":"pg-cluster","cnpg.io/instanceName":"pg-cluster-1","cnpg.io/pvcRole":"PG_TABLESPACE","cnpg.io/tablespaceName":"reporting","cnpg.io/instanceRole":"primary"}`,
              note: 'One claim per instance per tablespace — three instances and two tablespaces is six volumes. Columns and the third instance elided; some labels elided from the second output.',
            },
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT spcname, pg_get_userbyid(spcowner) AS owner, pg_tablespace_location(oid) FROM pg_tablespace ORDER BY spcname;"
kubectl exec pg-cluster-1 -c postgres -- ls -l /var/lib/postgresql/data/pgdata/pg_tblspc/`,
              out: `  spcname   |  owner   |             pg_tablespace_location
------------+----------+------------------------------------------------
 archive    | app      | /var/lib/postgresql/tablespaces/archive/data
 pg_default | postgres |
 pg_global  | postgres |
 reporting  | app      | /var/lib/postgresql/tablespaces/reporting/data
(4 rows)

lrwxrwxrwx 1 postgres tape 46 Aug 17 04:36 16393 -> /var/lib/postgresql/tablespaces/reporting/data
lrwxrwxrwx 1 postgres tape 44 Aug 17 04:36 16394 -> /var/lib/postgresql/tablespaces/archive/data`,
              note: 'The symlink in pg_tblspc, named after the tablespace OID, is the whole implementation. Note that archive is owned by app although no owner was given — the webhook defaults it.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"tablespaces": [
    {"name": "reporting", "storage": {"size": "1Gi"}, "owner": {"name": "app"}}
  ]}}'`,
              out: 'The Cluster "pg-cluster" is invalid: spec.tablespaces[1]: Invalid value: […]: no tablespace can be deleted once created',
              note: 'Sending the list without a tablespace is refused at admission. The value in the message is the list you sent; elided here.',
            },
            {
              run: `kubectl get cluster pg-cluster -o jsonpath='{.spec.tablespaces}{"\\n"}'`,
              out: '[{"name":"reporting","owner":{"name":"app"},"storage":{"resizeInUseVolumes":true,"size":"1Gi"},"temporary":false},{"name":"archive","owner":{"name":"app"},"storage":{"resizeInUseVolumes":true,"size":"1Gi"},"temporary":false}]',
              note: 'What the cluster holds is not what you sent: owner, temporary and resizeInUseVolumes are defaulted in. A merge patch replaces the whole list, so every later change has to resend all of it.',
            },
          ],
          notes: [
            'A tablespace cannot be undeclared — `no tablespace can be deleted once created` — so adding one is a decision about every instance for as long as the cluster exists.',
            'Using one is ordinary SQL: `CREATE TABLE … TABLESPACE reporting`, and `pg_tables.tablespace` records it. Every replica has the same table in the same tablespace, in its own physical copy.',
            'Growing a tablespace on a StorageClass that cannot expand is accepted by the webhook and then fails in the storage layer, which wedges the reconcile loop: "error while changing PVC storage requirement", and later tablespaces stay `pending` behind it.',
            'Name a `storageClass` per tablespace to put relations on different storage; leave it out and the tablespace lands on the default class.',
          ],
        },
        {
          id: 'temporary-tablespace',
          name: 'spec.tablespaces[].temporary (temp_tablespaces)',
          summary:
            "Sends temporary objects and spilled sorts to a volume of their own instead of the one holding the database — one field, and PostgreSQL's temp_tablespaces does the rest.",
          usedIn: ['cnpg-temporary-tablespaces'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"tablespaces": [
    {"name": "scratch", "storage": {"size": "1Gi"}, "temporary": true}
  ]}}'
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  printf "%-14s " "$p"
  kubectl exec $p -c postgres -- psql -U postgres -tAc "SHOW temp_tablespaces;"
done`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
pg-cluster-1   scratch
pg-cluster-2   scratch
pg-cluster-3   scratch`,
              note: 'Every instance gets the setting, not just the primary — standbys spill too, and cannot borrow the disk the primary uses.',
            },
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TEMP TABLE scratch_demo AS SELECT g, repeat('x',200) AS pad FROM generate_series(1,200000) g;
   SELECT c.relname, t.spcname FROM pg_class c LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE c.relname = 'scratch_demo';"`,
              out: `SELECT 200000
   relname    | spcname
--------------+---------
 scratch_demo | scratch
(1 row)`,
              note: 'Both statements must be in one psql invocation: a temporary table does not outlive its session.',
            },
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "SET work_mem='64kB';
   CREATE TEMP TABLE spill AS SELECT g, repeat('y',300) AS pad FROM generate_series(1,300000) g ORDER BY md5(g::text);
   SELECT pg_sleep(25);" &
sleep 12
kubectl exec pg-cluster-1 -c postgres -- du -sh /var/lib/postgresql/tablespaces/scratch
kubectl exec pg-cluster-1 -c postgres -- sh -c 'du -sh /var/lib/postgresql/data/pgdata/base/pgsql_tmp; ls -1 /var/lib/postgresql/data/pgdata/base/pgsql_tmp | wc -l'
wait
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT temp_files, pg_size_pretty(temp_bytes) FROM pg_stat_database WHERE datname = 'app';"`,
              out: `99M	/var/lib/postgresql/tablespaces/scratch
4.0K	/var/lib/postgresql/data/pgdata/base/pgsql_tmp
0
 temp_files | pg_size_pretty
------------+----------------
          3 | 107 MB
(1 row)`,
              note: 'Mid-query: 99M in the tablespace, and base/pgsql_tmp present but empty. PostgreSQL creates that directory at startup either way, so emptiness is the evidence, not absence.',
            },
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-ro -c "SET work_mem='64kB'; SELECT count(*) FROM (SELECT g, md5(g::text) FROM generate_series(1,400000) g ORDER BY md5(g::text)) s;"
for p in pg-cluster-1 pg-cluster-2 pg-cluster-3; do
  printf "%-14s " "$p"
  kubectl exec $p -c postgres -- psql -U postgres -tAc "SELECT 'in_recovery=' || pg_is_in_recovery() || ' temp_files=' || temp_files || ' temp_bytes=' || pg_size_pretty(temp_bytes) FROM pg_stat_database WHERE datname = 'app';"
done`,
              out: `pg-cluster-1   in_recovery=false temp_files=5 temp_bytes=212 MB
pg-cluster-2   in_recovery=true temp_files=0 temp_bytes=0 bytes
pg-cluster-3   in_recovery=true temp_files=2 temp_bytes=22 MB`,
              note: 'The -ro Service sent the sort to one standby, and only that instance wrote temporary files. pg_stat_database is per-instance and is not replicated.',
            },
          ],
          notes: [
            '`temp_files` and `temp_bytes` are cumulative per instance and reset only by a restart — they are the metric that says a workload is spilling at all.',
            'The files are deleted when the query that owned them ends: the tablespace went back to 20K afterwards.',
            'A temporary tablespace is provisioned on every instance, so size it for the largest query any single instance might serve — and remember it is the one volume whose contents are worth nothing.',
          ],
        },
      ],
    },

    {
      id: 'services',
      title: 'Services and endpoints',
      blurb: 'Three Services per cluster, distinguished only by their selector — and how to see what each resolves to.',
      commands: [
        {
          id: 'get-svc',
          name: 'kubectl get svc -o wide',
          summary:
            'Shows the three Services the operator maintains and, in the SELECTOR column, the entire mechanism behind them: -rw selects the primary, -ro selects replicas, -r selects every instance.',
          usedIn: ['cnpg-service-connectivity', 'cnpg-pgbouncer', 'cnpg-failover-endpoint-time'],
          examples: [
            {
              run: 'kubectl get svc -o wide',
              out: `NAME                   TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE   SELECTOR
kubernetes             ClusterIP   10.43.0.1       <none>        443/TCP    30m   <none>
pg-cluster-pooler-rw   ClusterIP   10.43.28.241    <none>        5432/TCP   23m   cnpg.io/poolerName=pg-cluster-pooler-rw
pg-cluster-r           ClusterIP   10.43.195.42    <none>        5432/TCP   28m   cnpg.io/cluster=pg-cluster,cnpg.io/podRole=instance
pg-cluster-ro          ClusterIP   10.43.99.84     <none>        5432/TCP   28m   cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=replica
pg-cluster-rw          ClusterIP   10.43.125.165   <none>        5432/TCP   28m   cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=primary`,
              note: 'Captured with a PgBouncer Pooler also running, which is why a fourth database Service appears.',
            },
          ],
        },
        {
          id: 'endpointslices',
          name: 'kubectl get endpointslices -l kubernetes.io/service-name=<service>',
          summary:
            'The live membership of a Service — one address per ready Pod behind it. The write Service has exactly one, the read-only Service one per replica, the read Service one per instance.',
          usedIn: ['cnpg-service-connectivity', 'cnpg-failover', 'cnpg-failover-endpoint-time', 'cnpg-pgbouncer'],
          examples: [
            {
              run: 'kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw',
              out: `NAME                  ADDRESSTYPE   PORTS   ENDPOINTS   AGE
pg-cluster-rw-97fdv   IPv4          5432    10.42.3.4   2m35s`,
            },
            {
              run: `for s in rw ro r; do echo -n "$s: "; kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-$s -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo; done`,
              out: `rw: 10.42.2.4
ro: 10.42.0.7 10.42.1.8
r: 10.42.2.4 10.42.0.7 10.42.1.8`,
              note: 'The three Services side by side: one primary, two replicas, all three instances.',
            },
          ],
          notes: [
            'Use endpointslices rather than `kubectl get endpoints` — the older resource is deprecated from Kubernetes 1.33 and prints a warning across the output.',
            'During a failover the write endpoint goes briefly **empty** rather than stale, which is how Kubernetes stops traffic reaching a database with no primary.',
          ],
        },
      ],
    },

    {
      id: 'connect',
      title: 'Connecting and running SQL',
      blurb: 'From a client Pod through a Service, or straight into an instance as the superuser.',
      commands: [
        {
          id: 'exec-client',
          name: 'kubectl exec psql-client -- psql -h <service> -c "<sql>"',
          summary:
            'Runs SQL from a client Pod outside the database — the honest shape of an application connecting. The labs that provide this Pod set PGUSER, PGDATABASE and PGPASSWORD in its environment from the operator-generated Secret, so only the host has to be named.',
          usedIn: [
            'cnpg-service-connectivity',
            'cnpg-pgbouncer',
            'cnpg-failover',
            'cnpg-switchover',
            'cnpg-failover-endpoint-time',
            'cnpg-server-certificates',
          ],
          examples: [
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT inet_server_addr(), pg_is_in_recovery();"`,
              out: ` inet_server_addr | pg_is_in_recovery
------------------+-------------------
 10.42.0.6        | f
(1 row)`,
              note: 'Asked of the read-write Service: recovery is false, so this is the primary.',
            },
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-ro -c "INSERT INTO svc_proof (note) VALUES ('via-ro');"`,
              out: `ERROR:  cannot execute INSERT in a read-only transaction
command terminated with exit code 1`,
              note: 'Nothing is misrouted — the connection reached a real replica, and PostgreSQL refused the write.',
            },
          ],
          notes: [
            'The `--` matters: without it kubectl parses `-h` and `-c` as its own flags.',
            'The error arrives on standard error, so capturing it needs `> file 2>&1`.',
          ],
        },
        {
          id: 'exec-superuser',
          name: 'kubectl exec <instance> -c postgres -- psql -U postgres -c "<sql>"',
          summary:
            'Runs SQL inside an instance Pod as the local postgres superuser, over the unix socket with peer authentication — no password anywhere. Needed for anything the application role cannot see.',
          usedIn: [
            'cnpg-failover',
            'cnpg-switchover',
            'cnpg-client-certificates',
            'cnpg-server-certificates',
            'cnpg-persistent-volume',
          ],
          examples: [
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication ORDER BY application_name;"`,
              out: ` application_name |   state   | sync_state | replay_lag
------------------+-----------+------------+------------
 pg-cluster-2     | streaming | async      |
 pg-cluster-3     | streaming | async      |
(2 rows)`,
            },
          ],
          notes: [
            'As the `app` role the same query returns rows with the state columns NULL, and `pg_hba_file_rules` is refused outright — both need superuser or `pg_read_all_stats`.',
            'Add `-d app` to reach the application database; without it you land in the `postgres` database.',
          ],
        },
        {
          id: 'run-one-off',
          name: 'kubectl run <name> --image=… --command -- psql …',
          summary:
            'Runs a one-off client Pod for a single statement, then reads what it did from its logs and deletes it. Useful when a lab has no long-lived client Pod to work from.',
          usedIn: ['cnpg-persistent-volume'],
          examples: [
            {
              run: `kubectl run pv-proof-client --image=ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie --env PGPASSWORD=$PGPASSWORD --command -- psql -h pg-cluster-rw -U app -d app -c "INSERT INTO pv_proof (note) VALUES ('after-failover-via-rw-service') RETURNING *;"
kubectl logs pv-proof-client
kubectl get pod pv-proof-client
kubectl delete pod pv-proof-client`,
              out: `pod/pv-proof-client created
 id |             note              |          created_at
----+-------------------------------+-------------------------------
  3 | after-failover-via-rw-service | 2026-08-15 07:43:26.021179+00
(1 row)

INSERT 0 1
NAME              READY   STATUS      RESTARTS      AGE
pv-proof-client   0/1     Completed   2 (19s ago)   20s
pod "pv-proof-client" deleted from default namespace`,
            },
          ],
          notes: [
            "`kubectl run ... --rm -i` looks like the natural one-liner, but its attach-and-clean-up-when-stdin-closes logic does not suit an interactive terminal, whose stdin never closes — it hangs. Running it detached, reading the logs and deleting it yourself is the reliable shape.",
            'The Pod reports `Completed` with a restart count, because the default restart policy retries the command until Kubernetes sees it exit cleanly.',
          ],
        },
        {
          id: 'app-password',
          name: 'kubectl get secret <cluster>-app -o jsonpath=… | base64 -d',
          summary:
            'Reads the application role password the operator generated. Used to export PGPASSWORD when connecting from somewhere that has no credentials in its environment.',
          usedIn: ['cnpg-persistent-volume', 'cnpg-client-certificates', 'cnpg-server-certificates'],
          examples: [
            {
              run: `export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)`,
              note: 'Deliberately shown as an assignment: the point is not to print a password onto a shared terminal.',
            },
          ],
          notes: [
            'The Secret is of type `kubernetes.io/basic-auth` and also carries the username, database name and ready-made connection URIs.',
            'PGPASSWORD has to be part of the command that runs *inside* the Pod — `kubectl exec <pod> -- env PGPASSWORD=$PGPASSWORD psql …` — because an environment variable set on the kubectl client never reaches the container.',
          ],
        },
        {
          id: 'psql-conninfo',
          name: 'psql "host=… user=… sslmode=… sslrootcert=…"',
          summary:
            'The connection-string form of psql, which is the only way to set TLS options. The whole string is a single argument in the position where psql expects a database name.',
          usedIn: ['cnpg-client-certificates', 'cnpg-server-certificates'],
          examples: [
            {
              run: `export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
psql "host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/root/tls/ca.crt" -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"`,
              out: ` ssl | version
-----+---------
 t   | TLSv1.3
(1 row)`,
              note: 'From the `toolbox` tab, where the CA file is. The password comes from the operator-generated Secret, since nothing outside a Pod has it in its environment.',
            },
            {
              run: `CONN="host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/etc/tls/ca/ca.crt sslcert=/etc/tls/client/tls.crt sslkey=/etc/tls/client/tls.key"
kubectl exec psql-client -- psql "$CONN" -tAc "SELECT ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid();"`,
              out: 't|TLSv1.3',
              note: 'The certificate-authentication form, run inside a Pod where the Secrets are mounted — `sslcert`/`sslkey` present a client identity rather than a password.',
            },
          ],
          notes: [
            '`sslmode=require` encrypts but verifies nothing; `verify-ca` checks the signature; `verify-full` also checks that the host name dialled matches the certificate. Only the last of those detects an impostor.',
            'libpq here does not negotiate TLS by default — without an explicit `sslmode` the connection is made in the clear, which matters when reasoning about which `pg_hba` rule a connection matches.',
          ],
        },
      ],
    },

    {
      id: 'sql',
      title: "Reading PostgreSQL's own state",
      blurb: 'The queries the labs grade against — replication, timelines, TLS sessions and backends.',
      commands: [
        {
          id: 'pg-stat-replication',
          name: 'SELECT … FROM pg_stat_replication',
          summary:
            'One row per streaming replica, from the primary. Empty on a replica, which makes it a quick way to confirm which instance is really the primary.',
          usedIn: ['cnpg-failover', 'cnpg-switchover'],
          examples: [
            {
              run: `kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"`,
              out: ` application_name |   state   | sync_state
------------------+-----------+------------
 pg-cluster-1     | streaming | async
 pg-cluster-3     | streaming | async
(2 rows)`,
              note: 'After a failover: the instance that was destroyed, pg-cluster-1, has rejoined and is streaming from the instance that replaced it.',
            },
          ],
          notes: [
            '`sync_state` reads `async` on these clusters: a commit returns as soon as the primary has flushed it locally, without waiting for any replica.',
          ],
        },
        {
          id: 'pg-control-checkpoint',
          name: 'SELECT timeline_id FROM pg_control_checkpoint()',
          summary:
            "PostgreSQL's own view of the timeline. A promotion always starts a new one, so this is the most honest single number for telling a real promotion from a Pod that merely restarted.",
          usedIn: ['cnpg-failover'],
          examples: [
            {
              run: `kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -c "SELECT timeline_id FROM pg_control_checkpoint();"`,
              out: ` timeline_id
-------------
           2
(1 row)`,
            },
            {
              run: `kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'`,
              out: '2',
              note: "The operator's copy of the same fact, and the scriptable one.",
            },
          ],
          notes: [
            'Ask the *primary*: on a replica this reports the timeline of its last local checkpoint, which can lag the cluster.',
          ],
        },
        {
          id: 'pg-stat-ssl',
          name: 'SELECT … FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
          summary:
            "The server's own account of the current session's TLS: whether it is encrypted, which protocol version, and the distinguished name read from the client certificate. The strongest available proof of how a connection authenticated.",
          usedIn: ['cnpg-client-certificates', 'cnpg-server-certificates'],
          examples: [
            {
              run: `kubectl exec cert-client -- psql "$CONN" -c "SELECT current_user, ssl, version, client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid();"`,
              out: ` current_user | ssl | version | client_dn
--------------+-----+---------+-----------
 app          | t   | TLSv1.3 | /CN=app
(1 row)`,
            },
          ],
          notes: [
            '`client_dn` is empty for a password-authenticated session, so a non-empty value is what distinguishes certificate authentication from a connection that merely happened to be encrypted.',
          ],
        },
        {
          id: 'pg-hba-file-rules',
          name: 'SELECT … FROM pg_hba_file_rules',
          summary:
            'The host-based authentication rules as PostgreSQL has them on disk, in order. Superuser only.',
          usedIn: ['cnpg-client-certificates'],
          examples: [
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rule_number, type, database, user_name, auth_method FROM pg_hba_file_rules ORDER BY rule_number;"`,
              out: ` rule_number |  type   |   database    |        user_name        |  auth_method
-------------+---------+---------------+-------------------------+---------------
           1 | local   | {all}         | {cnpg_metrics_exporter} | peer
           2 | local   | {all}         | {all}                   | peer
           3 | hostssl | {postgres}    | {streaming_replica}     | cert
           4 | hostssl | {replication} | {streaming_replica}     | cert
           5 | hostssl | {all}         | {cnpg_pooler_pgbouncer} | cert
           6 | hostssl | {app}         | {app}                   | cert
           7 | host    | {all}         | {all}                   | scram-sha-256
(7 rows)`,
              note: 'Rule 6 is a user-added rule; the operator writes the others, and always appends the password fallback last.',
            },
          ],
          notes: [
            'First match wins, so a rule added after the trailing `scram-sha-256` catch-all would never be reached. Rules declared in the Cluster spec are inserted before it.',
            'This view reflects the file, which the operator rewrites and reloads. It is not proof that a specific session used a specific rule.',
          ],
        },
        {
          id: 'pg-backend-pid',
          name: 'SELECT pg_backend_pid()',
          summary:
            'The process ID of the backend serving this session. Comparing it across several separate connections is how the PgBouncer lab measures pooling.',
          usedIn: ['cnpg-pgbouncer'],
          examples: [
            {
              run: `for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-pooler-rw -tAc "SELECT pg_backend_pid();"; done`,
              out: `758
767
767
767
758
758`,
              note: 'Six client connections through a two-instance pooler share two server backends — one per PgBouncer Pod.',
            },
            {
              run: `for i in 1 2 3 4 5 6; do kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT pg_backend_pid();"; done`,
              out: `768
769
770
771
772
773`,
              note: 'The same six connections made directly: six separate backends, each forked and torn down.',
            },
          ],
        },
      ],
    },

    {
      id: 'tls',
      title: 'TLS, CAs and certificates',
      blurb: 'What the cluster generates for itself, how to issue your own, and how to prove which is being served.',
      commands: [
        {
          id: 'get-secrets-tls',
          name: 'kubectl get secrets',
          summary:
            'A CloudNativePG cluster is its own certificate authority. Alongside the application credentials it generates a CA, a server certificate and a client certificate for replication.',
          usedIn: ['cnpg-client-certificates', 'cnpg-server-certificates'],
          examples: [
            {
              run: 'kubectl get secrets',
              out: `NAME                     TYPE                       DATA   AGE
pg-cluster-app           kubernetes.io/basic-auth   11     2m27s
pg-cluster-ca            Opaque                     2      2m27s
pg-cluster-replication   kubernetes.io/tls          2      2m27s
pg-cluster-server        kubernetes.io/tls          2      2m27s`,
            },
          ],
          notes: [
            '`pg-cluster-ca` holds `ca.crt` **and** `ca.key` — it is a working CA, not just a trust anchor, which is what lets the operator issue further certificates from it.',
          ],
        },
        {
          id: 'openssl-s-client',
          name: 'openssl s_client -starttls postgres -connect <host>:5432',
          summary:
            "Opens a real TLS handshake against PostgreSQL and shows the certificate the server actually presents — the only way to answer what is being served, as opposed to what is stored in a Secret.",
          usedIn: ['cnpg-client-certificates', 'cnpg-server-certificates'],
          examples: [
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- sh -c "openssl s_client -starttls postgres -connect pg-cluster-rw:5432 </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName"`,
              out: `subject=CN=pg-cluster-rw
issuer=OU=default, CN=pg-cluster
X509v3 Subject Alternative Name:
    DNS:pg-cluster-rw, DNS:pg-cluster-rw.default, DNS:pg-cluster-rw.default.svc, DNS:pg-cluster-rw.default.svc.cluster.local, DNS:pg-cluster-r, DNS:pg-cluster-r.default, DNS:pg-cluster-r.default.svc, DNS:pg-cluster-r.default.svc.cluster.local, DNS:pg-cluster-ro, DNS:pg-cluster-ro.default, DNS:pg-cluster-ro.default.svc, DNS:pg-cluster-ro.default.svc.cluster.local`,
              note: "The operator's own certificate: issued for the read-write Service name, with alternative names covering all three Services.",
            },
          ],
          notes: [
            'The whole pipeline has to run inside the Pod: a pipe typed outside `sh -c "…"` runs on your terminal\'s own machine instead, which is not where the connection was made.',
            '`-starttls postgres` is required: PostgreSQL negotiates TLS through its own protocol handshake rather than expecting TLS from the first byte.',
          ],
        },
        {
          id: 'cnpg-certificate',
          name: 'kubectl cnpg certificate <secret> --cnpg-cluster <cluster> --cnpg-user <role>',
          summary:
            "Issues a client certificate for a PostgreSQL role, signed by the cluster's own CA, and stores it as a TLS Secret. The certificate's common name is the role name — that is the identity PostgreSQL reads.",
          usedIn: ['cnpg-client-certificates'],
          examples: [
            {
              run: 'kubectl cnpg certificate app-client-cert --cnpg-cluster pg-cluster --cnpg-user app',
              out: 'secret/app-client-cert created',
            },
            {
              run: `kubectl get secret app-client-cert -o jsonpath='{.data.tls\\.crt}' | base64 -d > /tmp/app.crt
kubectl exec -i pg-cluster-1 -c postgres -- openssl x509 -noout -subject -issuer -dates < /tmp/app.crt`,
              out: `subject=CN=app
issuer=OU=default, CN=pg-cluster
notBefore=Aug 15 06:25:11 2026 GMT
notAfter=Nov 13 06:25:11 2026 GMT`,
              note: 'Valid for 90 days. Piping a file into `kubectl exec -i` is how to use the Pod\'s openssl on a file that lives on the node.',
            },
          ],
          notes: [
            'The flags are `--cnpg-cluster` and `--cnpg-user`; the shorter `--cluster` and `--user` belong to kubectl itself and select a kubeconfig context.',
            'Issuing the certificate changes nothing on its own — PostgreSQL still has to be told to accept one, with a `hostssl … cert` rule.',
          ],
        },
        {
          id: 'openssl-make-ca',
          name: 'openssl req -x509 … (create a CA, then sign a server certificate)',
          summary:
            'Creates a self-signed CA and issues a server certificate from it. In OpenSSL 3 the second command generates the key, builds the request and signs it in one step, with the subject alternative names passed inline.',
          usedIn: ['cnpg-server-certificates'],
          examples: [
            {
              run: `mkdir -p /root/tls && cd /root/tls
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \\
  -keyout ca.key -out ca.crt \\
  -subj "/CN=dbcanvas-labs-ca/O=DBCanvas Labs" 2>/dev/null`,
              note: 'The CA. Run from the `toolbox` tab, so these are ordinary local files. The `2>/dev/null` swallows a page of key-generation dots.',
            },
            {
              run: `openssl req -x509 -nodes -newkey rsa:2048 -days 365 \\
  -CA ca.crt -CAkey ca.key \\
  -keyout server.key -out server.crt \\
  -subj "/CN=pg-cluster-rw" \\
  -addext "subjectAltName=DNS:pg-cluster-rw,DNS:pg-cluster-rw.default,DNS:pg-cluster-rw.default.svc,DNS:pg-cluster-ro,DNS:pg-cluster-ro.default,DNS:pg-cluster-ro.default.svc,DNS:pg-cluster-r,DNS:pg-cluster-r.default,DNS:pg-cluster-r.default.svc" 2>/dev/null`,
              note: 'The server certificate, signed by that CA in the same command.',
            },
            {
              run: `ls -l /root/tls
openssl x509 -in server.crt -noout -subject -issuer -ext subjectAltName
openssl verify -CAfile ca.crt server.crt`,
              out: `total 16
-rw-r--r-- 1 root root 1196 Aug 15 17:49 ca.crt
-rw------- 1 root root 1704 Aug 15 17:49 ca.key
-rw-r--r-- 1 root root 1444 Aug 15 17:49 server.crt
-rw------- 1 root root 1708 Aug 15 17:49 server.key
subject=CN = pg-cluster-rw
issuer=CN = dbcanvas-labs-ca, O = DBCanvas Labs
X509v3 Subject Alternative Name: 
    DNS:pg-cluster-rw, DNS:pg-cluster-rw.default, DNS:pg-cluster-rw.default.svc, DNS:pg-cluster-ro, DNS:pg-cluster-ro.default, DNS:pg-cluster-ro.default.svc, DNS:pg-cluster-r, DNS:pg-cluster-r.default, DNS:pg-cluster-r.default.svc
server.crt: OK`,
              note: 'openssl gives the two private keys mode 600 and the certificates 644, without being asked.',
            },
          ],
          notes: [
            'The common name must be the read-write Service name, and the alternative names must cover every Service a client might dial — a certificate naming only one Service silently breaks clients connecting through another, at connection time.',
            'Newer OpenSSL has a `-quiet` flag that suppresses the dots instead of redirecting them, but it arrived in 3.2 and the toolbox ships 3.0.13 (Ubuntu 24.04). The PostgreSQL image has 3.5.6, so the same command behaves differently depending on where you run it.',
          ],
        },
        {
          id: 'create-secret-tls',
          name: 'kubectl create secret generic|tls',
          summary:
            'Loads certificate material into Kubernetes. The CA goes into an ordinary Secret under the key `ca.crt`, because that is the key the operator reads; the certificate and its key go into a purpose-built TLS Secret.',
          usedIn: ['cnpg-server-certificates'],
          examples: [
            {
              run: `cd /root/tls
kubectl create secret generic pg-server-ca --from-file=ca.crt=ca.crt
kubectl create secret tls pg-server-cert --cert=server.crt --key=server.key
kubectl get secret pg-server-ca pg-server-cert`,
              out: `secret/pg-server-ca created
secret/pg-server-cert created
NAME             TYPE                DATA   AGE
pg-server-ca     Opaque              1      0s
pg-server-cert   kubernetes.io/tls   2      0s`,
            },
          ],
          notes: [
            'In `--from-file=ca.crt=ca.crt` the part after the `=` is the file read and the part before it is the key stored. They match here by coincidence; the key name is the half the operator cares about.',
            '`create secret tls` verifies that the key matches the certificate before creating anything, which makes it a free sanity check on the pair.',
            "The CA's private key is never uploaded — the operator has no use for it, and it is the one file that could issue further certificates for this database.",
          ],
        },
        {
          id: 'patch-certificates',
          name: 'kubectl patch cluster … spec.certificates',
          summary:
            "Hands user-supplied server certificates to the operator. Both Secrets are named together because the replicas verify the primary's certificate against the same CA.",
          usedIn: ['cnpg-server-certificates'],
          examples: [
            {
              run: `kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"certificates":{"serverCASecret":"pg-server-ca","serverTLSSecret":"pg-server-cert"}}}'`,
              out: 'cluster.postgresql.cnpg.io/pg-cluster patched',
            },
            {
              run: `openssl s_client -starttls postgres -connect pg-cluster-rw:5432 </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer`,
              out: `subject=CN = pg-cluster-rw
issuer=CN = dbcanvas-labs-ca, O = DBCanvas Labs`,
              note: 'Run from the `toolbox` tab, which resolves the Service name and dials it as any client would. The server now presents the user-issued certificate.',
            },
            {
              run: `export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
psql "host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/root/tls/ca.crt" -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
kubectl get secret pg-cluster-ca -o jsonpath='{.data.ca\\.crt}' | base64 -d > /root/tls/operator-ca.crt
psql "host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/root/tls/operator-ca.crt" -c "SELECT 1;"`,
              out: ` ssl | version
-----+---------
 t   | TLSv1.3
(1 row)

psql: error: connection to server at "pg-cluster-rw" (10.43.9.234), port 5432 failed: SSL error: certificate verify failed`,
              note: "A client trusting only the operator's original CA is now turned away — the trust anchor has moved.",
            },
          ],
          notes: [
            'No instance restarts: the operator swaps the mounted material and has PostgreSQL reload. Restart counts stay at zero and replication keeps streaming.',
          ],
        },
        {
          id: 'patch-pg-hba',
          name: 'kubectl patch cluster … spec.postgresql.pg_hba',
          summary:
            'Adds host-based authentication rules declaratively. The operator writes them into every instance\'s pg_hba.conf and reloads PostgreSQL — never edit that file by hand, it is reconciled away.',
          usedIn: ['cnpg-client-certificates'],
          examples: [
            {
              run: `kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"postgresql":{"pg_hba":["hostssl app app all cert"]}}}'`,
              out: 'cluster.postgresql.cnpg.io/pg-cluster patched',
            },
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql "host=pg-cluster-rw user=app dbname=app sslmode=require" -c "SELECT 1;"`,
              out: `psql: error: connection to server at "pg-cluster-rw" (10.43.114.84), port 5432 failed: FATAL:  connection requires a valid client certificate
command terminated with exit code 2`,
              note: 'After the rule is in place, a correct password over TLS is no longer sufficient.',
            },
          ],
          notes: [
            'A reload, not a restart — the rule takes effect without downtime.',
          ],
        },
      ],
    },

    {
      id: 'pooling',
      title: 'Connection pooling',
      blurb: 'A Pooler resource, the PgBouncer the operator builds from it, and its own admin console.',
      commands: [
        {
          id: 'apply-pooler',
          name: 'kubectl apply -f pooler.yaml && kubectl get pooler',
          summary:
            'Declares a PgBouncer in front of the cluster. The operator creates the Deployment, its Pods and a Service named after the Pooler; you never deploy PgBouncer yourself.',
          usedIn: ['cnpg-pgbouncer'],
          examples: [
            {
              run: `kubectl apply -f /root/pooler.yaml
kubectl get pooler
kubectl get deploy pg-cluster-pooler-rw
kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o wide`,
              out: `pooler.postgresql.cnpg.io/pg-cluster-pooler-rw created
NAME                   AGE   CLUSTER      TYPE   PHASE
pg-cluster-pooler-rw   60s   pg-cluster   rw     active
NAME                   READY   UP-TO-DATE   AVAILABLE   AGE
pg-cluster-pooler-rw   2/2     2            2           58s
NAME                                  READY   STATUS    RESTARTS   AGE   IP          NODE                             NOMINATED NODE   READINESS GATES
pg-cluster-pooler-rw-6f68bfbd-9d6fh   1/1     Running   0          58s   10.42.1.8   k3d-dbol-8a1eeda4eaee-agent-1    <none>           <none>
pg-cluster-pooler-rw-6f68bfbd-np68w   1/1     Running   0          58s   10.42.0.7   k3d-dbol-8a1eeda4eaee-server-0   <none>           <none>`,
            },
          ],
          notes: [
            '`type: rw` makes the pooler a client of the read-write Service, which is how it follows a failover without knowing anything about one.',
            'Authentication is wired up for you: the operator creates a `cnpg_pooler_pgbouncer` role and gives PgBouncer a client certificate, so there is no userlist to maintain.',
          ],
        },
        {
          id: 'pgbouncer-admin',
          name: 'psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW POOLS;"',
          summary:
            "PgBouncer's own admin console, reachable over a unix socket inside each PgBouncer Pod. It answers in SQL: pools, their client and server connection counts, and where each points.",
          usedIn: ['cnpg-pgbouncer'],
          examples: [
            {
              run: `POOLER=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POOLER -c pgbouncer -- psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW POOLS;"`,
              out: ` database  |         user          | cl_active | cl_waiting | … | sv_active | sv_idle | … | pool_mode
-----------+-----------------------+-----------+------------+---+-----------+---------+---+-----------
 app       | app                   |         0 |          0 | … |         0 |       1 | … | session
 pgbouncer | pgbouncer             |         1 |          0 | … |         0 |       0 | … | statement
 postgres  | cnpg_pooler_pgbouncer |         0 |          0 | … |         1 |       0 | … | session
(3 rows)`,
              note: 'Columns elided for width; the real output carries 18 of them.',
            },
            {
              run: `kubectl exec $POOLER -c pgbouncer -- psql -h /controller/run -U pgbouncer pgbouncer -c "SHOW DATABASES;"`,
              out: `   name    |     host      | port | database  | force_user | pool_size | … | current_connections | …
-----------+---------------+------+-----------+------------+-----------+---+---------------------+---
 app       | pg-cluster-rw | 5432 | app       |            |         5 | … |                   1 | …
 pgbouncer |               | 5432 | pgbouncer | pgbouncer  |         2 | … |                   0 | …
 postgres  | pg-cluster-rw | 5432 | postgres  |            |         5 | … |                   1 | …
(3 rows)`,
              note: 'The host column is the read-write Service — PgBouncer is itself just another client of it.',
            },
          ],
          notes: [
            'A pool only exists on the Pod that has served a connection for it, and the Service load-balances, so an idle Pod may show fewer pools than its sibling.',
          ],
        },
      ],
    },

    {
      id: 'replication',
      title: 'Replication and scaling',
      blurb: 'The slots the operator manages for you, the two ways to ask for synchronous commits, and what changing one integer actually creates.',
      commands: [
        {
          id: 'replication-slots',
          name: 'SELECT … FROM pg_replication_slots',
          summary:
            'CloudNativePG manages high-availability replication slots by default: a healthy cluster already holds one physical slot per replica, prefixed `_cnpg_`, that nobody configured. `restart_lsn` is the oldest WAL the slot still needs, and the primary will not recycle past it.',
          usedIn: ['cnpg-replication-slots', 'cnpg-cluster-scaling'],
          examples: [
            {
              run: `kubectl get cluster pg-cluster -o json | jq .spec.replicationSlots`,
              out: `{
  "highAvailability": {
    "enabled": true,
    "slotPrefix": "_cnpg_"
  },
  "synchronizeReplicas": {
    "enabled": true
  },
  "updateInterval": 30
}`,
              note: 'All of it is the operator default — nothing in the lab manifest asked for slots.',
            },
            {
              run: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -x -c "SELECT slot_name, slot_type, active, restart_lsn FROM pg_replication_slots ORDER BY slot_name;"`,
              out: `-[ RECORD 1 ]-------------------
slot_name   | _cnpg_pg_cluster_2
slot_type   | physical
active      | t
restart_lsn | 0/7000110
-[ RECORD 2 ]-------------------
slot_name   | _cnpg_pg_cluster_3
slot_type   | physical
active      | t
restart_lsn | 0/7000110`,
              note: 'Read as `-U postgres` inside the Pod: an ordinary application role sees the rows but not `restart_lsn`. The slot name is the prefix plus the instance name with its dashes flattened.',
            },
          ],
          notes: [
            'A slot carries no data. Streaming works without one — turn `highAvailability.enabled` off and replication stays healthy. What the slot adds is the guarantee that WAL a *disconnected* standby still needs will not be recycled.',
            'The standbys carry matching slots too, kept in step by the operator, so whichever instance is promoted already holds the slots the others need.',
            'A slot left behind for an instance that no longer exists makes the primary reserve WAL forever; the first symptom is a full volume, which looks nothing like a replication problem.',
          ],
        },
        {
          id: 'synchronous-replication',
          name: 'spec.postgresql.synchronous (method, number, dataDurability)',
          summary:
            'Declares a synchronous-commit policy rather than a list of servers. The operator generates PostgreSQL\'s `synchronous_standby_names` from it and keeps that correct as instances come and go.',
          usedIn: ['cnpg-synchronous-replication'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":1}}}}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, sync_state, sync_priority FROM pg_stat_replication ORDER BY application_name;"`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
              synchronous_standby_names
------------------------------------------------------
 ANY 1 ("pg-cluster-2","pg-cluster-3","pg-cluster-1")
(1 row)

 application_name | sync_state | sync_priority
------------------+------------+---------------
 pg-cluster-2     | quorum     |             1
 pg-cluster-3     | quorum     |             1
(2 rows)`,
              note: 'The primary appears in its own generated list, because any instance may be primary later and a primary never counts itself as a standby. With `method: any` the standbys are `quorum` — a pool, not a ranked list.',
            },
            {
              run: `kubectl exec $PRIMARY -c postgres -- psql -U postgres -x -c "SELECT pid, state, wait_event_type, wait_event FROM pg_stat_activity WHERE wait_event = 'SyncRep';"`,
              out: `-[ RECORD 1 ]---+---------
pid             | 1173
state           | active
wait_event_type | IPC
wait_event      | SyncRep`,
              note: 'What a blocked write looks like with `number: 2` and only one standby reachable. `statement_timeout` does NOT end this wait — the statement has finished executing; what is outstanding is the commit acknowledgement.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"synchronous":{"method":"any","number":2,"dataDurability":"preferred"}}}}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SHOW synchronous_standby_names;"`,
              out: ` synchronous_standby_names
---------------------------
 ANY 1 ("pg-cluster-2")
(1 row)`,
              note: 'Still `number: 2` in the spec. `preferred` lets the operator shrink the generated list to the standbys that can actually answer, so writes continue and the durability guarantee quietly relaxes.',
            },
          ],
          notes: [
            '`dataDurability: required` is the default and makes the rule absolute: not enough standbys, no acknowledged commits. Neither setting is the safe one — they are different definitions of safe.',
            'The older `minSyncReplicas`/`maxSyncReplicas` fields still exist; `spec.postgresql.synchronous` is the current API and the one that expresses `any` versus `first`.',
          ],
        },
        {
          id: 'replica-cluster',
          name: 'spec.replica + bootstrap.pg_basebackup (a replica Cluster)',
          summary:
            'Stands up a whole separate Cluster that follows another one — its own name, Services and Secrets — rather than one more instance inside the same Cluster. `pg_basebackup` clones the source once; `replica.enabled` is what keeps it a standby afterwards.',
          usedIn: ['cnpg-replica-cluster'],
          examples: [
            {
              run: `kubectl apply -f /root/replica-cluster.yaml
kubectl get cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"`,
              out: `cluster.postgresql.cnpg.io/pg-replica created
NAME         AGE     INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   8m56s   3           3       Cluster in healthy state   pg-cluster-1
pg-replica   70s     1           1       Cluster in healthy state   pg-replica-1
 application_name |   state   | sync_state
------------------+-----------+------------
 pg-cluster-2     | streaming | async
 pg-cluster-3     | streaming | async
 pg-replica       | streaming | async
(3 rows)`,
              note: 'To PostgreSQL the replica cluster is simply one more streaming standby, named after the cluster. Everything that makes it a *cluster* is on the Kubernetes side — it gets its own -rw/-ro/-r Services.',
            },
            {
              run: `kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO replica_demo (note) VALUES ('should-fail');"`,
              out: `ERROR:  cannot execute INSERT in a read-only transaction
command terminated with exit code 1`,
              note: 'A read-only transaction error, not a permissions error — the superuser is refused too, because the whole instance is in recovery.',
            },
            {
              run: `kubectl patch cluster pg-replica --type=merge -p '{"spec":{"replica":{"enabled":false}}}'
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();"`,
              out: `cluster.postgresql.cnpg.io/pg-replica patched
f
2`,
              note: 'Detaching promotes it. The timeline goes 1 → 2 — a new lineage, which is why detaching is not reversible: the histories diverge and streaming can never merge them back.',
            },
          ],
          notes: [
            'The externalClusters entry uses `streaming_replica` with certificates from the source\'s own Secrets, and connects to `dbname: postgres` — it has to, because the source\'s generated pg_hba admits that role only to the postgres and replication databases.',
            'After detaching, the source stops streaming to it: `pg_stat_replication` drops back to the source\'s own instances.',
          ],
        },
        {
          id: 'logical-replication',
          name: 'Publication and Subscription (declarative logical replication)',
          summary:
            'Logical replication sends row changes rather than WAL blocks, so the subscriber is a fully writable database that happens to receive some tables. CloudNativePG exposes both sides as Kubernetes resources whose `status.applied` is the only place a failure shows.',
          usedIn: ['cnpg-logical-replication'],
          examples: [
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolreplication, rolcanlogin FROM pg_roles WHERE rolname IN ('app','streaming_replica') ORDER BY rolname;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "ALTER ROLE app WITH REPLICATION;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SHOW wal_level;"`,
              out: `      rolname      | rolreplication | rolcanlogin
-------------------+----------------+-------------
 app               | f              | t
 streaming_replica | t              | t
(2 rows)

ALTER ROLE
logical`,
              note: '`streaming_replica` has REPLICATION but the source\'s pg_hba only admits it to the postgres database, so it cannot read user tables. The password role gets the grant instead. `wal_level` is already logical — the CloudNativePG default.',
            },
            {
              run: `kubectl apply -f /root/publication.yaml
kubectl get publication orders-pub -o json | jq .status
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "\\dRp+"`,
              out: `publication.postgresql.cnpg.io/orders-pub created
{
  "applied": true,
  "observedGeneration": 1
}
                                     Publication orders_pub
  Owner   | All tables | Inserts | Updates | Deletes | Truncates | Generated columns | Via root
----------+------------+---------+---------+---------+-----------+-------------------+----------
 postgres | f          | t       | t       | t       | t         | none              | f
Tables:
    "public.orders"`,
              note: '`spec.name` is the PostgreSQL object and `metadata.name` the Kubernetes resource; they may differ. A publication on its own creates no slot and retains no WAL — it is only an offer.',
            },
            {
              run: `kubectl apply -f /root/subscription.yaml
kubectl get subscription orders-sub -o json | jq .status`,
              out: `subscription.postgresql.cnpg.io/orders-sub created
{
  "applied": false,
  "message": "while creating subscription: ERROR: relation \\"public.orders\\" does not exist (SQLSTATE 42P01)"
}`,
              note: 'What a missing table on the subscriber looks like. Logical replication does not carry DDL — create the table there first. The operator keeps reconciling, so creating it heals this within a minute with nothing re-applied.',
            },
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT slot_name, slot_type, active FROM pg_replication_slots ORDER BY slot_name;"
kubectl exec pg-target-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM orders ORDER BY id;"`,
              out: `     slot_name      | slot_type | active
--------------------+-----------+--------
 _cnpg_pg_cluster_2 | physical  | t
 _cnpg_pg_cluster_3 | physical  | t
 orders_sub         | logical   | t
(3 rows)

 id |      item       |              at
----+-----------------+-------------------------------
  1 | widget          | 2026-08-15 20:37:53.359178+00
  2 | sprocket        | 2026-08-15 20:37:53.359178+00
  3 | after-subscribe | 2026-08-15 20:38:51.822336+00
(3 rows)`,
              note: 'A working subscription appears on the publisher as a *logical* slot. Rows 1 and 2 predate the subscription — logical replication synchronises existing data before it starts streaming.',
            },
          ],
          notes: [
            '`publicationDBName` bridges the case where the external cluster connects to one database and the publication lives in another. Get it wrong and the subscription applies, reports healthy and does nothing, with "publication does not exist" appearing only as a warning in the subscriber\'s log.',
            'The connecting role needs REPLICATION *and* SELECT on the published tables. With REPLICATION but no SELECT the subscription applies cleanly and the initial copy fails with "permission denied for table" — a table created by the app role avoids this, since the owner can read its own table.',
            'A subscription creates a logical slot on the publisher that retains WAL exactly as a physical one does, so an abandoned subscription is an operational hazard rather than a tidy-up job.',
            '`pg_stat_subscription` on the subscriber is where to look when rows are not arriving: received_lsn and latest_end_lsn separate "nothing is being sent" from "something is failing to apply".',
          ],
        },
        {
          id: 'scale-cluster',
          name: 'kubectl patch cluster … spec.instances',
          summary:
            'Scaling is editing one integer. The operator creates the PersistentVolumeClaim, clones the primary with a short-lived join Pod, adds a replication slot and starts the instance — and removes all of it again on the way down.',
          usedIn: ['cnpg-cluster-scaling'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"instances":4}}'
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
NAME         AGE   INSTANCES   READY   STATUS                   PRIMARY
pg-cluster   16m   4           3       Creating a new replica   pg-cluster-1
NAME                      READY   STATUS     RESTARTS   AGE
pg-cluster-1              1/1     Running    0          16m
pg-cluster-2              1/1     Running    0          15m
pg-cluster-3              1/1     Running    0          7m1s
pg-cluster-4-join-gp6w9   0/1     Init:0/1   0          5s`,
              note: 'The join Pod is the operator running pg_basebackup against the primary to build the new data directory. It is short-lived — check within a few seconds of patching.',
            },
            {
              run: `kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT slot_name, active FROM pg_replication_slots ORDER BY 1;"
kubectl get pvc`,
              out: `_cnpg_pg_cluster_2|t
_cnpg_pg_cluster_3|t
_cnpg_pg_cluster_4|t
NAME           STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
pg-cluster-1   Bound    pvc-5b644f30-c407-43e6-845c-92557a8c7abd   1Gi        RWO            local-path     18m
pg-cluster-2   Bound    pvc-09f2f200-21ff-4628-87bd-dbbbf8b3bd02   1Gi        RWO            local-path     17m
pg-cluster-3   Bound    pvc-73500c24-d11e-46ca-a88b-d48c4701ac4a   1Gi        RWO            local-path     17m
pg-cluster-4   Bound    pvc-f0badd03-dcdb-46a5-9b03-3fe6fbfd125f   1Gi        RWO            local-path     105s`,
              note: 'A slot and a volume appear alongside the instance. VOLUMEATTRIBUTESCLASS elided for width.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"instances":3}}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT slot_name, active FROM pg_replication_slots ORDER BY 1;"
kubectl get pvc --no-headers | wc -l`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
_cnpg_pg_cluster_2|t
_cnpg_pg_cluster_3|t
3`,
              note: 'Scaling down removes the highest-numbered instance, its PVC and its slot together. The volume is deleted rather than orphaned.',
            },
          ],
          notes: [
            'A new instance is cloned from the primary, not replayed from empty — it carries rows written before it existed, and the cost of scaling up is copying the data directory rather than replaying history.',
            'You do not get to choose which instance leaves: it is always the highest-numbered one.',
          ],
        },
      ],
    },

    {
      id: 'observability',
      title: 'Metrics and logs',
      blurb: 'The Prometheus endpoints every instance and pooler already serves, and the structured logs they already write.',
      commands: [
        {
          id: 'scrape-instance-metrics',
          name: 'curl -s http://<pod-ip>:9187/metrics',
          summary:
            'Every instance Pod serves Prometheus metrics on 9187 with nothing installed to collect them. The toolbox routes to Pod addresses, so a scrape by hand is one curl — no port-forward, no Service.',
          usedIn: ['cnpg-metrics'],
          examples: [
            {
              run: `kubectl get pod pg-cluster-1 -o jsonpath='{range .spec.containers[*]}{.name}: {range .ports[*]}{.name}={.containerPort} {end}{"\\n"}{end}'
IP=$(kubectl get pod pg-cluster-1 -o jsonpath='{.status.podIP}')
curl -s http://$IP:9187/metrics | grep -E "^cnpg_(collector_up|collector_last_collection_error)"
curl -s http://$IP:9187/metrics | grep -c "^cnpg_"`,
              out: `postgres: postgresql=5432 metrics=9187 status=8000
cnpg_collector_last_collection_error 0
cnpg_collector_up{cluster="pg-cluster"} 1
463`,
              note: 'Check the collector before trusting the collection: a dashboard of stale values with collector_up 0 behind it is worse than no dashboard.',
            },
            {
              run: `curl -s http://$IP:9187/metrics | grep "^cnpg_backends_total"
curl -s http://$IP:9187/metrics | grep "^cnpg_pg_replication_slots_active"`,
              out: `cnpg_backends_total{application_name="cnpg_metrics_exporter",datname="app",state="active",usename="cnpg_metrics_exporter"} 1
cnpg_backends_total{application_name="pg-cluster-2",datname="",state="active",usename="streaming_replica"} 1
cnpg_backends_total{application_name="pg-cluster-3",datname="",state="active",usename="streaming_replica"} 1
cnpg_pg_replication_slots_active{database="",slot_name="_cnpg_pg_cluster_2",slot_type="physical"} 1
cnpg_pg_replication_slots_active{database="",slot_name="_cnpg_pg_cluster_3",slot_type="physical"} 1`,
              note: 'Both describe the replication topology and can be confirmed straight from pg_stat_replication and pg_replication_slots.',
            },
          ],
          notes: [
            'Run this from the `toolbox` tab, not inside a Pod — the PostgreSQL image ships neither curl nor wget. The k3s nodes can reach the endpoint but have only wget.',
            'Scrape the primary for replication series: replicas have nothing streaming from them.',
          ],
        },
        {
          id: 'custom-metric-query',
          name: 'spec.monitoring.customQueriesConfigMap',
          summary:
            'Metrics about your data, rather than about PostgreSQL, come from SQL you supply: a query in a ConfigMap that the operator runs on the collection interval and exports as a series.',
          usedIn: ['cnpg-metrics'],
          examples: [
            {
              run: `kubectl apply -f /root/custom-queries.yaml
kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"monitoring":{"customQueriesConfigMap":[{"name":"lab-queries","key":"queries"}]}}}'
curl -s http://$IP:9187/metrics | grep -A2 cnpg_lab_rows_total`,
              out: `configmap/lab-queries created
cluster.postgresql.cnpg.io/pg-cluster patched
# HELP cnpg_lab_rows_total Number of user tables in this database
# TYPE cnpg_lab_rows_total gauge
cnpg_lab_rows_total 0`,
              note: 'The family name and column from the ConfigMap become cnpg_<family>_<column>, carrying the description you wrote as HELP text. It reads 0 because the database has no user tables yet — create one and the next collection reports 1.',
            },
          ],
          notes: [
            'Because the metric *is* the query, its value and the database always agree — `SELECT count(*) FROM pg_stat_user_tables` returns the same 1.',
          ],
        },
        {
          id: 'scrape-pooler-metrics',
          name: 'curl -s http://<pooler-pod-ip>:9127/metrics',
          summary:
            'PgBouncer Pods export on a different port from database instances — 9127, not 9187 — and every series is prefixed cnpg_pgbouncer_.',
          usedIn: ['cnpg-pgbouncer-metrics'],
          examples: [
            {
              run: `POD=$(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $POD -o jsonpath='{range .spec.containers[*]}{.name}: {range .ports[*]}{.name}={.containerPort} {end}{"\\n"}{end}'
IP=$(kubectl get pod $POD -o jsonpath='{.status.podIP}')
curl -s http://$IP:9127/metrics | grep -E "^cnpg_pgbouncer_(last_collection_error|collections_total)"
curl -s http://$IP:9127/metrics | grep -c "^cnpg_pgbouncer_"`,
              out: `pgbouncer: pgbouncer=5432 metrics=9127
cnpg_pgbouncer_collections_total 1
cnpg_pgbouncer_last_collection_error 0
51`,
            },
            {
              run: `for P in $(kubectl get pods -l cnpg.io/poolerName=pg-cluster-pooler-rw -o jsonpath='{range .items[*]}{.status.podIP} {end}'); do
  echo "== $P"; curl -s http://$P:9127/metrics | grep 'database="app"' | head -3
done`,
              out: `== 10.42.2.5
cnpg_pgbouncer_pools_cl_active{database="app",user="app"} 0
cnpg_pgbouncer_pools_cl_active_cancel_req{database="app",user="app"} 0
== 10.42.0.8
cnpg_pgbouncer_pools_cl_active{database="app",user="app"} 0
cnpg_pgbouncer_pools_cl_active_cancel_req{database="app",user="app"} 0`,
              note: 'The app pool series exist only after traffic has used them — before any client connects, the only pool is PgBouncer\'s own admin database.',
            },
          ],
          notes: [
            '`cl_` counts are client-side and `sv_` are server-side; the gap between them is the pooling you are getting, and a rising `maxwait` means the pool is too small.',
            'There is no aggregate endpoint: a real scrape collects from every PgBouncer Pod.',
            'Scrape from the `toolbox` tab — the pooler manifest is staged on the k3d-server node, so the apply happens there and the scrape happens where curl is.',
          ],
        },
        {
          id: 'json-logs',
          name: 'kubectl logs (structured JSON) and kubectl cnpg logs cluster',
          summary:
            "CloudNativePG logs JSON by default with no plain-text mode. PostgreSQL's own CSV log fields arrive nested under `record`, so failures are found by SQLSTATE rather than by grepping messages.",
          usedIn: ['cnpg-json-logs'],
          examples: [
            {
              run: `kubectl logs pg-cluster-1 --tail=500 | jq -c . > /dev/null; echo "exit=$?"
kubectl logs pg-cluster-1 --tail=500 | jq -r .logger | sort -u
kubectl logs pg-cluster-1 --tail=500 | jq -r '[.level, .logger] | @tsv' | sort | uniq -c | sort -rn`,
              out: `exit=0
cluster-resource
instance-manager
pg_controldata
postgres
     56 info	instance-manager
     24 info	cluster-resource
     19 info	postgres
      1 info	pg_controldata`,
              note: 'The first command is the one worth running before trusting a parser: 500 lines, every one valid JSON, no plain-text lines mixed in. One envelope — level, ts, logger, msg, logging_pod — shared by every subsystem, with `logger` telling them apart.',
            },
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1/0;"
kubectl logs $PRIMARY --tail=200 | jq 'select(.record.error_severity == "ERROR") | .record'`,
              out: `ERROR:  division by zero
command terminated with exit code 1
{
  "log_time": "2026-08-15 16:52:43.591 UTC",
  "user_name": "app",
  "database_name": "app",
  "process_id": "847",
  "connection_from": "10.42.1.7:46204",
  "command_tag": "SELECT",
  "error_severity": "ERROR",
  "sql_state_code": "22012",
  "message": "division by zero",
  "query": "SELECT 1/0;",
  "application_name": "psql",
  "backend_type": "client backend"
}`,
              note: 'Session and transaction id fields elided for width. Selecting on `error_severity` rather than searching for the message text is the point — none of these fields was ever *in* the message.',
            },
            {
              run: `kubectl logs $PRIMARY --tail=500 | jq -r 'select(.record.sql_state_code) | .record.sql_state_code' | sort | uniq -c | sort -rn
kubectl logs $PRIMARY --tail=500 | jq -r 'select(.record.sql_state_code == "22012") | [.record.log_time, .record.user_name, .record.query] | @tsv'`,
              out: `     13 00000
      3 22012
2026-08-15 16:52:43.591 UTC	app	SELECT 1/0;
2026-08-15 16:52:52.822 UTC	app	SELECT 1/0;
2026-08-15 16:55:46.659 UTC	app	SELECT 1/0;`,
              note: '`00000` is "successful completion" — ordinary log lines carry a SQLSTATE too. The `select` is load-bearing: instance-manager lines have no `record` at all, so without it you count nulls alongside codes.',
            },
            {
              run: `kubectl cnpg logs cluster pg-cluster --tail 40 -o /root/all-pods.txt
jq -r .logging_pod /root/all-pods.txt | sort | uniq -c
jq -r '[.logging_pod, .logger] | @tsv' /root/all-pods.txt | sort | uniq -c`,
              out: `Successfully written logs to "/root/all-pods.txt"
      2 null
     38 pg-cluster-1
     40 pg-cluster-2
     40 pg-cluster-3
      2 	instance-manager
     22 pg-cluster-1	cluster-resource
      2 pg-cluster-1	instance-manager
     14 pg-cluster-1	postgres
     13 pg-cluster-2	cluster-resource
      2 pg-cluster-2	instance-manager
      1 pg-cluster-2	pg_controldata
     23 pg-cluster-2	postgres
      1 pg-cluster-2	wal-restore
      6 pg-cluster-3	cluster-resource
     13 pg-cluster-3	instance-manager
     20 pg-cluster-3	postgres
      1 pg-cluster-3	wal-restore`,
              note: 'One stream across every instance, still tagged per Pod so it can be split back apart or cross-tabulated. `wal-restore` on the two replicas and not on the primary (pg-cluster-1 here) is a difference in role showing up as a difference in which subsystems talk. `-f` follows Pods created while it runs, which is what makes it usable during a failover.',
            },
          ],
          notes: [
            'The `null` logging_pod lines are real: instance-manager lines about acquiring the leader lease, emitted before the Pod identity is attached to its logger. The envelope is nearly uniform, not perfectly so — which is why `select(.field)` beats assuming the field is there.',
            'Run these from the `toolbox` tab. The k3s node image ships no jq, and neither does the PostgreSQL image; the toolbox container every lab environment gets does.',
          ],
        },
      ],
    },

    {
      id: 'lifecycle',
      title: 'Fencing, hibernation and configuration',
      blurb: 'Stopping an instance without destroying it, shutting a whole cluster down without deleting it, and the three different things a configuration change can cost.',
      commands: [
        {
          id: 'cnpg-fencing-lifecycle',
          name: 'kubectl cnpg fencing on|off <cluster> <instance>',
          summary:
            'Stops PostgreSQL on an instance while leaving the Pod, the container and the volume in place. The interface is an annotation — the plugin is a convenience over `kubectl annotate`.',
          usedIn: ['cnpg-fencing', 'cnpg-corrupted-pvc'],
          examples: [
            {
              run: `kubectl cnpg fencing on pg-cluster pg-cluster-3
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/fencedInstances"]'`,
              out: `pg-cluster-3 fenced
"[\\"pg-cluster-3\\"]"`,
            },
            {
              run: `kubectl get pod pg-cluster-3 -o json | jq -r '.status.conditions[] | [.type, .status] | @tsv'
kubectl exec pg-cluster-3 -c postgres -- ps aux
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -c "SELECT 1;"`,
              out: `PodReadyToStartContainers	True
Initialized	True
Ready	False
ContainersReady	False
PodScheduled	True
USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
postgres       1  0.2  0.2 1319928 64460 ?       Ssl  22:54   0:01 /controller/manager instance run --status-port-tls --log-level=info
psql: error: connection to server on socket "/controller/run/.s.PGSQL.5432" failed: No such file or directory`,
              note: 'The container is up with restartCount 0 and only the instance manager inside it — no postgres process at all. Ready goes false about 30 seconds after fencing, which is what removes it from the Services.',
            },
          ],
          notes: [
            'Fencing preserves the data directory exactly as it was when PostgreSQL stopped, which is the reason to use it before inspecting an instance you suspect is damaged — deleting the Pod would give you a fresh instance and destroy the evidence.',
            'Unfencing needs no rebuild: the instance restarts, reconnects and replays WAL from the replication slot the cluster kept for it.',
            'There is no timeout and no automatic failover out of a fence. A cluster fenced by mistake stays down until somebody removes the annotation.',
          ],
        },
        {
          id: 'cnpg-hibernate',
          name: 'kubectl cnpg hibernate on|off <cluster>',
          summary:
            'Shuts a cluster down without deleting it: every instance Pod goes, every PersistentVolumeClaim stays, and the Cluster object remains as the record of what to bring back.',
          usedIn: ['cnpg-hibernation'],
          examples: [
            {
              run: `kubectl cnpg hibernate on pg-cluster
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/hibernation"]'
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc --no-headers | wc -l`,
              out: `"on"
No resources found in default namespace.
3`,
              note: 'No Pods, three volumes still bound. The Services still exist but have no endpoints, so a connection is refused — a hibernated cluster is genuinely off, not idling.',
            },
            {
              run: `kubectl cnpg hibernate off pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc --no-headers`,
              out: `NAME           READY   STATUS    RESTARTS   AGE
pg-cluster-1   1/1     Running   0          90s
pg-cluster-2   1/1     Running   0          79s
pg-cluster-3   1/1     Running   0          76s
pg-cluster-1   Bound   pvc-600a89f0-…   1Gi   RWO   local-path   10m
pg-cluster-2   Bound   pvc-ae9a40ea-…   1Gi   RWO   local-path   9m15s
pg-cluster-3   Bound   pvc-ca3058d5-…   1Gi   RWO   local-path   8m38s`,
              note: 'Volume names elided for width. The age mismatch is the mechanism in one screen: Pods 90 seconds old on volumes 10 minutes old — new compute, old storage.',
            },
          ],
          notes: [
            'Not the same as scaling to zero, which a CloudNativePG Cluster has no setting for, nor as deleting the Cluster, which would take the volumes with it.',
            'Waking is neither a restore nor a rebuild: instances start on the data directories they already had, so the primary comes up on its own volume.',
          ],
        },
        {
          id: 'hibernation-annotation',
          name: 'cnpg.io/hibernation (declarative)',
          summary:
            'The annotation the hibernation plugin command sets, applied directly. Removes every instance Pod, keeps every volume — and leaves a cluster that goes on describing itself as healthy.',
          usedIn: ['cnpg-declarative-hibernation'],
          examples: [
            {
              run: `kubectl annotate cluster pg-cluster cnpg.io/hibernation=on
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
kubectl get cluster pg-cluster`,
              out: `cluster.postgresql.cnpg.io/pg-cluster annotated
No resources found in default namespace.
NAME           STATUS   VOLUME                                     CAPACITY   STORAGECLASS   AGE
pg-cluster-1   Bound    pvc-063373a9-6bc1-4fd4-b666-8917edf22e2d   1Gi        local-path     2m39s
pg-cluster-2   Bound    pvc-ee88f990-7c7c-4784-95f4-22b191c81f36   1Gi        local-path     115s
pg-cluster-3   Bound    pvc-4187ea1e-bb84-4c76-bf8d-a09645a4174f   1Gi        local-path     72s
NAME         AGE     INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   2m41s   3                   Cluster in healthy state   pg-cluster-1`,
              note: 'Pods gone in about ten seconds, claims untouched — and STATUS still reads healthy with a blank READY column. Claim columns elided for width.',
            },
            {
              run: `kubectl get cluster pg-cluster \
  -o jsonpath='{range .status.conditions[*]}{.type}{"\\t"}{.status}{"\\t"}{.reason}{"\\n"}{end}'`,
              out: `Initialized	True	BootstrapCompleted
ConsistentSystemID	False	NotFound
Ready	True	ClusterIsReady
ContinuousArchiving	True	ContinuousArchivingSuccess
cnpg.io/hibernation	True	Hibernated`,
              note: 'The condition is the honest signal, and it is removed rather than set to False on waking — so alerting has to treat absent as awake. ConsistentSystemID goes False because no instance is left to report one.',
            },
            {
              run: `for s in pg-cluster-rw pg-cluster-ro pg-cluster-r; do
  printf "%-14s " "$s"
  kubectl get endpointslices -l kubernetes.io/service-name=$s -o jsonpath='{.items[*].endpoints[*].addresses[*]}'
  echo
done
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;"`,
              out: `pg-cluster-rw  
pg-cluster-ro  
pg-cluster-r   
psql: error: connection to server at "pg-cluster-rw" (10.43.31.180), port 5432 failed: Connection refused`,
              note: 'The Services survive with no endpoints, so a client gets connection refused rather than a name that does not resolve — which fools any check that treats DNS as liveness.',
            },
            {
              run: `kubectl annotate cluster pg-cluster cnpg.io/hibernation=off --overwrite
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp
kubectl get pvc -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp`,
              out: `cluster.postgresql.cnpg.io/pg-cluster annotated
NAME           CREATED
pg-cluster-1   2026-08-17T00:08:25Z
pg-cluster-2   2026-08-17T00:08:36Z
pg-cluster-3   2026-08-17T00:08:40Z
NAME           CREATED
pg-cluster-1   2026-08-17T00:05:24Z
pg-cluster-2   2026-08-17T00:06:08Z
pg-cluster-3   2026-08-17T00:06:51Z`,
              note: 'Back in about thirty seconds, and every Pod is younger than the claim it is using — new processes on old disks, which is what proves nothing was copied.',
            },
          ],
          notes: [
            'The Cluster stays an ordinary editable object while it sleeps: a parameter changed with no instances running is simply in force when they start again.',
            '`--overwrite` is required to change an annotation that already exists.',
            'It is not a backup. The volumes are still the only copy, and a hibernated cluster is one whose replication and backups have stopped.',
          ],
        },
        {
          id: 'node-drain-pdb',
          name: 'kubectl drain + PodDisruptionBudgets',
          summary:
            'A drain cordons a node and then asks its Pods to leave. What answers is the pair of budgets CloudNativePG maintains — one over the replicas with room for one disruption, one over the primary with room for none.',
          usedIn: ['cnpg-node-drain', 'cnpg-single-instance-drain'],
          examples: [
            {
              run: `kubectl get pdb -o custom-columns=NAME:.metadata.name,MIN:.spec.minAvailable,SELECTOR:.spec.selector.matchLabels,ALLOWED:.status.disruptionsAllowed,HEALTHY:.status.currentHealthy`,
              out: `NAME                 MIN   SELECTOR                                                       ALLOWED   HEALTHY
pg-cluster           1     map[cnpg.io/cluster:pg-cluster cnpg.io/instanceRole:replica]   1         2
pg-cluster-primary   1     map[cnpg.io/cluster:pg-cluster cnpg.io/instanceRole:primary]   0         1`,
              note: 'ALLOWED DISRUPTIONS is computed as currentHealthy − minAvailable, so the primary\'s budget can never allow one. A single-instance cluster gets only the second of these.',
            },
            {
              run: `kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=pg-cluster-2`,
              out: `node/k3d-dbol-186682b7bc52-agent-0 cordoned
Warning: deleting Pods that declare no controller: default/psql-client; ignoring DaemonSet-managed Pods: metallb-system/speaker-nrnjs
evicting pod default/pg-cluster-2
evicting pod default/psql-client
pod/pg-cluster-2 evicted
pod/psql-client evicted
node/k3d-dbol-186682b7bc52-agent-0 drained
LAST SEEN   TYPE      REASON             OBJECT             MESSAGE
50s         Warning   FailedScheduling   pod/pg-cluster-2   0/3 nodes are available: 1 node(s) were unschedulable, 2 node(s) didn't match PersistentVolume's node affinity.`,
              note: 'The replica is evicted and then stranded: its local-path volume is on the node that was just cordoned. Note the warning about Pods with no controller — a bare Pod is deleted and never comes back.',
            },
            {
              run: `# a single-instance cluster: the eviction is refused for the whole timeout
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force --timeout=60s`,
              out: `node/k3d-dbol-1c4b277ef95c-agent-0 cordoned
evicting pod default/pg-cluster-1
error when evicting pods/"pg-cluster-1" -n "default" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
evicting pod default/pg-cluster-1
error when evicting pods/"pg-cluster-1" -n "default" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.`,
              note: 'Without --timeout this retries forever. The node stays cordoned after a failed drain, and the database keeps serving throughout — which is the budget doing its job.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"enablePDB":false}}'
kubectl get pdb
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --force --timeout=60s
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;"`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
No resources found in default namespace.
pod/pg-cluster-1 evicted
node/k3d-dbol-1c4b277ef95c-agent-0 drained
NAME           READY   STATUS    RESTARTS   AGE   IP       NODE
pg-cluster-1   0/1     Pending   0          10s   <none>   <none>
psql: error: connection to server at "pg-cluster-rw" (10.43.47.120), port 5432 failed: Connection refused`,
              note: 'Turning the budget off does not make the drain safe, it makes it quiet: the instance has nowhere to go and the database is down until the node is uncordoned.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"nodeMaintenanceWindow":{"inProgress":true,"reusePVC":false}}}'`,
              out: `Warning: Consider using \`.spec.enablePDB\` instead of the node maintenance window feature
cluster.postgresql.cnpg.io/pg-cluster patched`,
              note: 'reusePVC:false tells the operator to stop waiting for the drained node: the stranded claim is deleted and the instance is rebuilt elsewhere with pg_basebackup, about a minute for a small database. The API server points at the newer lever as it accepts the patch.',
            },
          ],
          notes: [
            'A drain cordons first and evicts second, and the cordon is not undone when the eviction fails — a failed drain still leaves the node unschedulable.',
            'Draining the primary\'s node is refused once by the primary budget; the operator responds by moving the primary, after which the same eviction succeeds.',
            'All of this is sharp only because the storage is node-local. With volumes that follow the Pod, an evicted instance simply starts somewhere else.',
          ],
        },
        {
          id: 'postgres-parameters',
          name: 'spec.postgresql.parameters',
          summary:
            'Declares PostgreSQL configuration. The operator writes it into the cluster\'s own custom.conf (included from postgresql.conf), so editing the file by hand is pointless — it is reconciled away.',
          usedIn: ['cnpg-config-changes'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"log_min_duration_statement":"250ms"}}}}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT name, setting, unit, pending_restart FROM pg_settings WHERE name = 'log_min_duration_statement';"`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
            name            | setting | unit | pending_restart
----------------------------+---------+------+-----------------
 log_min_duration_statement | 250     | ms   | f
(1 row)`,
              note: 'A reload-only parameter: pending_restart is false and no container is touched.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"max_connections":"200"}}}}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT name || '=' || setting || ' pending_restart=' || pending_restart FROM pg_settings WHERE name = 'max_connections';"`,
              out: `max_connections=100 pending_restart=true`,
              note: 'Read it within a few seconds of patching. pending_restart true means PostgreSQL knows what it has been asked for and cannot do it yet; the operator then rolls the cluster, replicas first.',
            },
            {
              run: `kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,CREATED:.metadata.creationTimestamp
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_postmaster_start_time();"`,
              out: `NAME           RESTARTS   CREATED
pg-cluster-1   0          2026-08-15T23:43:06Z
pg-cluster-2   0          2026-08-15T23:51:09Z
pg-cluster-3   0          2026-08-15T23:50:57Z
   pg_postmaster_start_time
-------------------------------
 2026-08-15 23:51:20.706359+00
(1 row)`,
              note: "The replicas' Pods were recreated; the primary's was not. Its postmaster started eight minutes after its Pod with restartCount still 0 — the default primaryUpdateMethod of `restart` restarts PostgreSQL *inside* the running container.",
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"listen_addresses":"127.0.0.1"}}}}'
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"wal_log_hints":"off"}}}}'`,
              out: `The Cluster "pg-cluster" is invalid: spec.postgresql.parameters.listen_addresses: Invalid value: "127.0.0.1": Can't set fixed configuration parameter
The Cluster "pg-cluster" is invalid: spec.postgresql.parameters.wal_log_hints: Invalid value: "off": \`wal_log_hints\` must be set to \`on\` when \`instances\` > 1`,
              note: 'Two flavours of refusal from the admission webhook. The first is a blanket ban — data_directory, shared_preload_libraries and hot_standby behave the same way. The second reasons about the cluster you actually have, and would be allowed on a single-instance cluster.',
            },
          ],
          notes: [
            'The operator writes its values to `custom.conf` in the data directory, included from `postgresql.conf` — that is the file to read when the spec and the running value seem to disagree.',
            'A rejected update is rejected whole and changes nothing, which is the practical advantage of a check at admission rather than at reconciliation.',
          ],
        },
        {
          id: 'initdb-import',
          name: 'spec.bootstrap.initdb.import',
          summary:
            'Bootstraps a cluster out of an existing PostgreSQL server with pg_dump and pg_restore. The `type` decides whether you get one application database or a whole server: microservice renames and reassigns, monolith keeps everything as it was.',
          usedIn: ['cnpg-import-microservice', 'cnpg-import-monolith'],
          examples: [
            {
              run: `# type: microservice — one database, restored into the new cluster's own app database
kubectl apply -f /root/import.yaml
kubectl get cluster
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -c "\\\\l"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -c "\\\\dt"`,
              out: `cluster.postgresql.cnpg.io/pg-orders created
NAME         AGE    INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   3m3s   3           3       Cluster in healthy state   pg-cluster-1
pg-orders    30s    1           1       Cluster in healthy state   pg-orders-1
   Name    |  Owner   | Encoding | Locale Provider | Collate | Ctype
-----------+----------+----------+-----------------+---------+-------
 app       | app      | UTF8     | libc            | C       | C
 postgres  | postgres | UTF8     | libc            | C       | C
 template0 | postgres | UTF8     | libc            | C       | C
 template1 | postgres | UTF8     | libc            | C       | C
         List of tables
 Schema | Name  | Type  | Owner
--------+-------+-------+-------
 public | lines | table | app`,
              note: 'The source database was called orders and its table was owned by shop. A microservice import restores it into the new cluster\'s application database and reassigns ownership to the app user — the database listing has its trailing columns elided for width.',
            },
            {
              run: `# type: monolith with "*" — every database and every role, names and owners kept
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -c "\\\\l"
kubectl exec pg-estate-1 -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname NOT LIKE 'pg\\\\_%' ORDER BY rolname;"
kubectl exec psql-client -- env PGPASSWORD=shop_pw psql -h pg-estate-rw -U shop -d orders -tAc "SELECT count(*) FROM lines;"
kubectl get secret`,
              out: `   Name    |  Owner   | Encoding | Locale Provider | Collate | Ctype
-----------+----------+----------+-----------------+---------+-------
 app       | app      | UTF8     | libc            | C       | C
 billing   | shop     | UTF8     | libc            | C       | C
 orders    | shop     | UTF8     | libc            | C       | C
 postgres  | postgres | UTF8     | libc            | C       | C
        rolname        | rolcanlogin | rolsuper
-----------------------+-------------+----------
 app                   | t           | f
 cnpg_metrics_exporter | t           | f
 postgres              | t           | t
 reporting             | f           | f
 shop                  | t           | f
 streaming_replica     | t           | f
500
NAME                     TYPE                       DATA   AGE
pg-cluster-app           kubernetes.io/basic-auth   11     3m29s
pg-cluster-ca            Opaque                     2      3m29s
pg-cluster-replication   kubernetes.io/tls          2      3m29s
pg-cluster-server        kubernetes.io/tls          2      3m29s
pg-cluster-superuser     kubernetes.io/basic-auth   11     68s
pg-estate-ca             Opaque                     2      48s
pg-estate-replication    kubernetes.io/tls          2      48s
pg-estate-server         kubernetes.io/tls          2      48s`,
              note: 'Databases keep their names and owners, roles keep their attributes, and the role password came across in the dump — shop logs in on the copy with the password it had on the source. Note what is missing from the Secret list: there is no pg-estate-app, because a monolith import creates no application database for the operator to manage.',
            },
            {
              run: `kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -c \\
  "INSERT INTO lines (sku, qty) VALUES ('written-after-the-import', 999);"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d orders -tAc "SELECT count(*) FROM lines;"
kubectl exec pg-orders-1 -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM lines;"`,
              out: `INSERT 0 1
501
500`,
              note: 'The import is pg_dump read once at bootstrap. Nothing follows the source afterwards — no slot, no WAL receiver, no subscription — which is what makes a cutover a planned outage the length of the dump and restore.',
            },
          ],
          notes: [
            'The connection is an ordinary PostgreSQL connection described by an `externalClusters` entry, and it must be made as a superuser: pg_dump has to read objects the application user does not own, and a monolith import also runs `pg_dumpall --roles-only`. On a CloudNativePG source that means `spec.enableSuperuserAccess: true`, which creates a `<cluster>-superuser` Secret.',
            'microservice takes exactly one database and imports no roles at all. If something connected as the role that owned those tables, it has nowhere to connect to after the move.',
            '`schemaOnly: true` restores only the pre-data and post-data sections, which is how you rehearse the structural half of a migration without moving the rows.',
            'The work happens inside the new instance\'s initdb Job, so there is nothing extra to watch: `kubectl logs job/<cluster>-1-initdb` is where pg_dump and pg_restore report progress.',
          ],
        },
        {
          id: 'basebackup-clone',
          name: 'spec.bootstrap.pg_basebackup (without a replica stanza)',
          summary:
            'Copies a running cluster physically, over the streaming replication protocol, and starts the copy as its own primary. The same block with a `replica` stanza would produce a standby; without one it produces an independent database.',
          usedIn: ['cnpg-basebackup-clone'],
          examples: [
            {
              run: `kubectl apply -f /root/clone.yaml
kubectl get pods | grep clone
kubectl get cluster`,
              out: `cluster.postgresql.cnpg.io/pg-clone created
pg-clone-1-pgbasebackup-k8xnx   0/1     Completed   0          18s
NAME         AGE    INSTANCES   READY   STATUS                     PRIMARY
pg-clone     36s    1           1       Cluster in healthy state   pg-clone-1
pg-cluster   3m8s   3           3       Cluster in healthy state   pg-cluster-1`,
              note: 'The copy runs in its own Job — the pgbasebackup Pod — and the cluster reports "Setting up primary" rather than "Creating a new replica" while it does. Thirty-six seconds for a small database on a quiet machine.',
            },
            {
              run: `kubectl exec pg-clone-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-clone-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_stat_wal_receiver;"
SRC=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec psql-client -- env PGPASSWORD="$SRC" psql -h pg-clone-rw -U app -d app -tAc "SELECT 1;"`,
              out: `f
0
psql: error: connection to server at "pg-clone-rw" (10.43.11.95), port 5432 failed: FATAL:  password authentication failed for user "app"`,
              note: 'Not in recovery and receiving nothing — a primary in its own right. Every role arrived with the source\'s password inside the copied data directory, and then the operator reset the application user to the clone\'s own generated Secret.',
            },
            {
              run: `kubectl exec psql-client -- env PGPASSWORD="$NEW" psql -h pg-clone-rw -U app -d app -c "INSERT INTO notes (entry) VALUES ('written on the clone') RETURNING id, entry;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO notes (entry) VALUES ('written on the source') RETURNING id, entry;"
kubectl get cluster pg-cluster -o jsonpath='{.status.timelineID}{"\\n"}'
kubectl get cluster pg-clone -o jsonpath='{.status.timelineID}{"\\n"}'`,
              out: ` id |        entry
----+----------------------
 51 | written on the clone
 id |         entry
----+-----------------------
 51 | written on the source
1
1`,
              note: 'Both sequences were copied at the same value, so the same id now means two different rows on two different clusters. And both are still on timeline 1: a clone is never promoted, it simply starts as a primary — so never let two of these share a WAL archive.',
            },
          ],
          notes: [
            'The copy is taken over the streaming replication protocol, so the `externalClusters` entry authenticates as `streaming_replica` with the source\'s certificates rather than with an application password.',
            'Physical means whole: every database, every role and every setting come across, not one application\'s tables.',
            'A clone is useless as a backup. From the moment it finishes there are two databases diverging independently, and no path back to one consistent copy.',
          ],
        },
        {
          id: 'bootstrap-initdb',
          name: 'spec.bootstrap.initdb',
          summary:
            'The one chance to decide how a cluster is built: its application database and owner, encoding and locale, checksums, WAL segment size, and SQL to run once the database exists. None of it can be changed afterwards.',
          usedIn: ['cnpg-initdb'],
          examples: [
            {
              run: `kubectl apply -f /root/initdb-cluster.yaml
kubectl exec pg-init-1 -c postgres -- psql -U postgres -c "\\l"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -d orders -c "SELECT * FROM seeded;"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('auditor','shop') ORDER BY rolname;"`,
              out: `cluster.postgresql.cnpg.io/pg-init created
   Name    |  Owner   | Encoding | Locale Provider | Collate | Ctype
-----------+----------+----------+-----------------+---------+-------
 orders    | shop     | UTF8     | libc            | C       | C
 postgres  | postgres | UTF8     | libc            | C       | C

 id |            note
----+-----------------------------
  1 | from postInitApplicationSQL
(1 row)

 rolname | rolcanlogin
---------+-------------
 auditor | f
 shop    | t
(2 rows)`,
              note: 'Columns elided for width. `postInitApplicationSQL` runs inside the application database; `postInitSQL` runs in `postgres` as superuser — which one you use decides where your objects land.',
            },
            {
              run: `kubectl exec pg-init-1 -c postgres -- psql -U postgres -c "SELECT name, setting, unit FROM pg_settings WHERE name IN ('wal_segment_size','data_checksums','server_encoding') ORDER BY name;"
kubectl exec pg-init-1 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep -E "Data page checksum|Bytes per WAL segment"`,
              out: `       name       | setting  | unit
------------------+----------+------
 data_checksums   | on       |
 server_encoding  | UTF8     |
 wal_segment_size | 33554432 | B
(3 rows)

Bytes per WAL segment:                33554432
Data page checksum version:           1`,
              note: '33554432 is the 32MB asked for, against a 16MB default. `lc_collate`/`lc_ctype` are not here — modern PostgreSQL keeps them as per-database properties, visible in the database listing instead.',
            },
            {
              run: `kubectl patch cluster pg-init --type=merge -p '{"spec":{"bootstrap":{"initdb":{"database":"renamed","walSegmentSize":64,"dataChecksums":false}}}}'
kubectl get cluster pg-init -o json | jq -c '.spec.bootstrap.initdb | {database, walSegmentSize, dataChecksums}'
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datname IN ('orders','renamed');"
kubectl exec pg-init-1 -c postgres -- psql -U postgres -tAc "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('wal_segment_size','data_checksums');"`,
              out: `cluster.postgresql.cnpg.io/pg-init patched
{"database":"renamed","walSegmentSize":64,"dataChecksums":false}
orders
data_checksums=on
wal_segment_size=33554432`,
              note: 'Accepted, and completely without effect. The spec now describes a database that does not exist, permanently and with no warning anywhere — `bootstrap` was carried out once at creation and is never consulted again.',
            },
          ],
          notes: [
            '`data_checksums` is on even when nothing asked for it, because PostgreSQL 18\'s own initdb enables checksums by default. CNPG\'s `dataChecksums` controls whether `-k` is passed, so on 18 the thing you would have to ask for is turning them *off*.',
            'Changing encoding or collation after the fact means a dump and restore into a new cluster — not a replica, which copies the data directory as it stands.',
            'For most of a Cluster spec, what it says is what you have. For `bootstrap`, it is what somebody once asked for; only the database can answer what is actually there.',
          ],
        },
        {
          id: 'taints-tolerations',
          name: 'kubectl taint + spec.affinity.tolerations',
          summary:
            'Taints mark a node unsuitable and tolerations are how a workload answers. `NoSchedule` governs placement only — it never evicts what is already running.',
          usedIn: ['cnpg-taints-tolerations'],
          examples: [
            {
              run: `NODE=$(kubectl get pod pg-cluster-2 -o jsonpath='{.spec.nodeName}')
kubectl taint node $NODE maintenance=planned:NoSchedule
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase`,
              out: `node/k3d-dbol-4858c15bdc24-agent-1 tainted
NAME           NODE                             STATUS
pg-cluster-1   k3d-dbol-4858c15bdc24-agent-0    Running
pg-cluster-2   k3d-dbol-4858c15bdc24-agent-1    Running
pg-cluster-3   k3d-dbol-4858c15bdc24-server-0   Running`,
              note: 'Nothing moved. NoSchedule is consulted when the scheduler places a Pod, and nobody is placing these. `NoExecute` is the effect that removes what is already there.',
            },
            {
              run: `kubectl delete pod pg-cluster-2 --wait=false
kubectl get events --field-selector reason=FailedScheduling --sort-by=.lastTimestamp | tail -1
kubectl get pvc pg-cluster-2 -o json | jq -r '.metadata.annotations["volume.kubernetes.io/selected-node"]'`,
              out: `pod "pg-cluster-2" deleted from default namespace
49s  Warning  FailedScheduling  pod/pg-cluster-2  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match PersistentVolume's node affinity.
k3d-dbol-4858c15bdc24-agent-1`,
              note: 'Two reasons across three nodes. The taint rules out one; the local-path volume\'s node pinning rules out the other two — and the node it is pinned to is the tainted one. Neither fact alone would strand it.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"affinity":{"tolerations":[{"key":"maintenance","operator":"Equal","value":"planned","effect":"NoSchedule"}]}}}'
kubectl get pod pg-cluster-2 -o json | jq -c '.spec.tolerations[] | select(.key=="maintenance")'
kubectl get node $NODE -o json | jq -c '.spec.taints'`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
{"effect":"NoSchedule","key":"maintenance","operator":"Equal","value":"planned"}
[{"effect":"NoSchedule","key":"maintenance","value":"planned"}]`,
              note: 'The operator writes the toleration onto the Pod verbatim, and the instance schedules back onto the node — which is still tainted. Nothing about the node changed; what changed is who is willing to run there.',
            },
          ],
          notes: [
            '`operator: Equal` with a `value` matches that exact taint; `operator: Exists` with just the key tolerates any value for it.',
            '`kubectl taint node <name> key=value:Effect` adds one; the same command with a trailing `-` removes it.',
            'Tolerating a taint is right when a node is reserved for a purpose and your database is that purpose — and wrong when the taint means maintenance, where it amounts to insisting on running exactly where somebody said not to.',
          ],
        },
        {
          id: 'node-selector-affinity',
          name: 'spec.affinity (nodeSelector, podAntiAffinityType, topologyKey)',
          summary:
            'Where instances may run and how hard the operator tries to spread them. A Cluster nobody has touched already carries a defaulted anti-affinity preference; the rule it expands into is only visible on the Pods.',
          usedIn: ['cnpg-node-selector'],
          examples: [
            {
              run: `kubectl get cluster pg-cluster -o json | jq -c '.spec.affinity'
kubectl get pod pg-cluster-1 -o json | jq '.spec.affinity'`,
              out: `{"podAntiAffinityType":"preferred"}
{
  "podAntiAffinity": {
    "preferredDuringSchedulingIgnoredDuringExecution": [
      {
        "podAffinityTerm": {
          "labelSelector": {
            "matchExpressions": [
              {
                "key": "cnpg.io/cluster",
                "operator": "In",
                "values": [
                  "pg-cluster"
                ]
              },
              {
                "key": "cnpg.io/podRole",
                "operator": "In",
                "values": [
                  "instance"
                ]
              }
            ]
          },
          "topologyKey": "kubernetes.io/hostname"
        },
        "weight": 100
      }
    ]
  }
}`,
              note: 'The single word in the Cluster is defaulted in by the operator\'s webhook. The topology key it spreads across appears nowhere in the Cluster spec until you set one — read it off a Pod.',
            },
            {
              run: `SERVER=$(kubectl get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}')
kubectl label node $SERVER workload=database
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"affinity":{"nodeSelector":{"workload":"database"}}}}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=pg-cluster-2`,
              out: `node/k3d-dbol-0678aad72171-server-0 labeled
cluster.postgresql.cnpg.io/pg-cluster patched
NAME           NODE                             STATUS
pg-cluster-1   k3d-dbol-0678aad72171-agent-1    Running
pg-cluster-2   <none>                           Pending
pg-cluster-3   k3d-dbol-0678aad72171-server-0   Running
LAST SEEN   TYPE      REASON             OBJECT             MESSAGE
28s         Warning   FailedScheduling   pod/pg-cluster-2   0/3 nodes are available: 1 node(s) didn't match PersistentVolume's node affinity, 2 node(s) didn't match Pod's node affinity/selector. no new claims to deallocate, preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.`,
              note: 'Changing the selector rolls the cluster, and the first Pod rebuilt cannot be placed: two nodes lack the label, and the one that has it is not the node holding this instance\'s local-path volume. Labelling the remaining nodes scheduled it within seconds, with no change to the Cluster.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"affinity":{"podAntiAffinityType":"required","topologyKey":"kubernetes.io/os"}}}'
kubectl get events --field-selector reason=FailedScheduling,involvedObject.name=pg-cluster-3
kubectl get pod pg-cluster-3 -o json | jq -c '.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution'`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
LAST SEEN   TYPE      REASON             OBJECT             MESSAGE
47s         Warning   FailedScheduling   pod/pg-cluster-3   0/3 nodes are available: 1 node(s) didn't match pod anti-affinity rules, 2 node(s) didn't match PersistentVolume's node affinity. no new claims to deallocate, preemption: 0/3 nodes are available: 1 No preemption victims found for incoming pod, 2 Preemption is not helpful for scheduling.
[{"labelSelector":{"matchExpressions":[{"key":"cnpg.io/cluster","operator":"In","values":["pg-cluster"]},{"key":"cnpg.io/podRole","operator":"In","values":["instance"]}]},"topologyKey":"kubernetes.io/os"}]`,
              note: 'Every node reports the same kubernetes.io/os, so a required spread across it has one domain and only one instance may occupy it. The generated term moves out of the preferred list and loses its weight.',
            },
          ],
          notes: [
            'A nodeSelector is a hard filter with no weights and no fallback, and the operator writes it onto every instance Pod — so changing it triggers a rolling update rather than taking effect on the running Pods.',
            'The rollout deliberately stalls while an instance is Pending: the operator will not take a second one away while the cluster is degraded. Mid-stall the Pods disagree about their own scheduling policy, since only the rebuilt one carries the new rule.',
            'The single-zone trap: a `required` spread over `topology.kubernetes.io/zone` in a one-zone cluster leaves every instance after the first unschedulable, and the message names the anti-affinity rule rather than the zone.',
            'Tolerations live under this same `spec.affinity` block, which is a slightly surprising place for them — they are about taints, not affinity.',
          ],
        },
        {
          id: 'podspec-drift',
          name: 'cnpg.io/podSpec (drift detection)',
          summary:
            'The operator\'s own record of the Pod spec it generated, kept as an annotation on each instance Pod. Reconciliation compares that record with a freshly generated spec, and any difference rolls the Pod.',
          usedIn: ['cnpg-podspec-drift'],
          examples: [
            {
              run: `kubectl get pod pg-cluster-1 -o json | jq -S '.metadata.annotations | keys'
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' \\
  | jq -c '{grace: .terminationGracePeriodSeconds, resources: .containers[0].resources, image: .containers[0].image}'`,
              out: `[
  "cnpg.io/nodeSerial",
  "cnpg.io/operatorVersion",
  "cnpg.io/podEnvHash",
  "cnpg.io/podSpec"
]
{"grace":1800,"resources":{},"image":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}`,
              note: 'The annotation\'s value is a whole Pod spec as a JSON string, so it needs unwrapping before jq can read it. 1800 seconds is the shutdown grace period the operator gives PostgreSQL.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"resources":{"requests":{"cpu":"100m","memory":"512Mi"},"limits":{"memory":"1Gi"}}}}'
kubectl get cluster pg-cluster --no-headers
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json | jq -r '.items[] | [.metadata.name, .metadata.creationTimestamp, .metadata.labels["cnpg.io/instanceRole"]] | @tsv' | sort -k2`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
pg-cluster   3m18s   3     2     Primary instance is being restarted without a switchover   pg-cluster-1
pg-cluster-3	2026-08-16T17:34:59Z	replica
pg-cluster-2	2026-08-16T17:35:12Z	replica
pg-cluster-1	2026-08-16T17:35:25Z	primary`,
              note: 'A resources change replaces every Pod — replicas first at roughly 15-second intervals, primary last, the whole roll under a minute. The primary\'s Pod is new; the primary instance is the same one it was.',
            },
            {
              run: `kubectl annotate pod pg-cluster-2 'cnpg.io/podSpec={"tampered":true}' --overwrite
for i in 1 2 3 4 5 6; do kubectl get pod pg-cluster-2 --no-headers -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,PHASE:.status.phase; sleep 3; done`,
              out: `pod/pg-cluster-2 annotated
pg-cluster-2   2026-08-16T17:35:12Z   Running
pg-cluster-2   2026-08-16T17:36:13Z   Pending
pg-cluster-2   2026-08-16T17:36:13Z   Running
pg-cluster-2   2026-08-16T17:36:13Z   Running
pg-cluster-2   2026-08-16T17:36:13Z   Running
pg-cluster-2   2026-08-16T17:36:13Z   Running`,
              note: 'Nothing about the container changed — only the operator\'s record of it — and the Pod was deleted and rebuilt within about three seconds, with the real spec written back. Drift is measured against the annotation.',
            },
          ],
          notes: [
            'A label of your own on the same Pod survives untouched: the operator enforces the record it keeps and the labels it routes on, not an identical copy of the object it created.',
            'This is why a mutating admission webhook or policy engine that rewrites CloudNativePG\'s Pods produces an endless rolling update. Exclude those Pods from the mutation rather than trying to make the operator less strict.',
            '`cnpg.io/podEnvHash` differs per instance and `cnpg.io/nodeSerial` is the number in the instance name — neither is part of the drift comparison.',
          ],
        },
        {
          id: 'image-catalog',
          name: 'ImageCatalog + spec.imageCatalogRef',
          summary:
            'Moves the PostgreSQL image out of the Cluster and into a shared lookup from major version to image, so an upgrade is an edit to one object rather than to every cluster that should follow it.',
          usedIn: ['cnpg-image-catalog'],
          examples: [
            {
              run: `kubectl apply -f /root/catalog.yaml
kubectl patch cluster pg-cluster --type=json -p '[{"op":"remove","path":"/spec/imageName"},{"op":"add","path":"/spec/imageCatalogRef","value":{"apiGroup":"postgresql.cnpg.io","kind":"ImageCatalog","name":"postgres-catalog","major":18}}]'
kubectl get cluster pg-cluster -o json | jq -c '{imageName: .spec.imageName, ref: .spec.imageCatalogRef}'`,
              out: `imagecatalog.postgresql.cnpg.io/postgres-catalog created
cluster.postgresql.cnpg.io/pg-cluster patched
{"imageName":null,"ref":{"apiGroup":"postgresql.cnpg.io","kind":"ImageCatalog","major":18,"name":"postgres-catalog"}}`,
              note: 'A Cluster may name an image or reference a catalog, never both — so the remove and the add have to be one atomic JSON patch. Adopting a catalog that names the running image rolls nothing.',
            },
            {
              run: `kubectl patch imagecatalog postgres-catalog --type=merge -p '{"spec":{"images":[{"major":18,"image":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}]}}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,READY:.status.containerStatuses[0].ready`,
              out: `imagecatalog.postgresql.cnpg.io/postgres-catalog patched
NAME           IMAGE                                                  READY
pg-cluster-1   ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie   true
pg-cluster-2   ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie   true
pg-cluster-3   ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie   false`,
              note: 'The cluster rolls — replicas first — from an edit to the catalog. Afterwards the Cluster spec still names no image at all.',
            },
          ],
          notes: [
            '`spec.images` is the required list and its entries are {major, image}. `spec.componentImages` is a *separate* optional list keyed by {key, image} for non-PostgreSQL components such as PgBouncer — putting `major` there is rejected with a strict-decoding error.',
            '`ClusterImageCatalog` is the cluster-scoped variant, identical in shape but not namespaced.',
            'A merge patch replaces the whole `images` list, so dropping the major by accident leaves the cluster resolving nothing.',
          ],
        },
        {
          id: 'hot-standby-params',
          name: 'pg_controldata (hot-standby-sensitive parameters)',
          summary:
            'Five settings a standby may not hold below its primary. It learns the primary\'s values from the WAL and records them in its control file — which is why pg_controldata on a standby reports numbers that are not its own configuration.',
          usedIn: ['cnpg-hot-standby-params'],
          examples: [
            {
              run: `kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep -E "max_connections|max_worker_processes|max_wal_senders|max_prepared_xacts|max_locks_per_xact"`,
              out: `max_connections setting:              100
max_worker_processes setting:         32
max_wal_senders setting:              10
max_prepared_xacts setting:           0
max_locks_per_xact setting:           64`,
              note: 'Run on a *standby*, these are the primary\'s values, updated from the WAL\'s parameter-change record. Two are abbreviated: max_prepared_xacts and max_locks_per_xact.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"max_connections":"200"}}}}'
for POD in pg-cluster-1 pg-cluster-2 pg-cluster-3; do printf "%s " $POD; kubectl exec $POD -c postgres -- psql -U postgres -tAc "SHOW max_connections;"; done
kubectl exec pg-cluster-2 -c postgres -- pg_controldata -D /var/lib/postgresql/data/pgdata | grep "max_connections setting:"`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
pg-cluster-1 200
pg-cluster-2 200
pg-cluster-3 200
max_connections setting:              200`,
              note: 'The operator rolls the standbys first, which is what an increase requires: a standby below its primary refuses to start hot standby. The control file follows through the WAL.',
            },
          ],
          notes: [
            'PostgreSQL\'s rule is that the standby\'s own setting must be >= the control-file value, so equal is fine and lower is fatal.',
            'The roll order does *not* reverse for a decrease, even though lowering is the safe direction — one order is safe both ways.',
            'Inside a CloudNativePG cluster you never hand-manage these; where the rule bites is a standby built by hand, or a restore onto a machine configured more modestly than its source.',
          ],
        },
        {
          id: 'replica-from-backup',
          name: 'bootstrap.recovery + replica.enabled (replica from an object store)',
          summary:
            'Turns a restore into a replica. Without `replica.enabled` a recovered cluster promotes itself and starts its own timeline; with it, the cluster stays in recovery and keeps replaying what the source archives.',
          usedIn: ['cnpg-replica-from-backup'],
          examples: [
            {
              run: `kubectl apply -f /root/replica-cluster.yaml
kubectl get cluster
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"`,
              out: `cluster.postgresql.cnpg.io/pg-replica created
NAME         AGE     INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   9m51s   3           3       Cluster in healthy state   pg-cluster-1
pg-replica   2m11s   1           1       Cluster in healthy state   pg-replica-1
t`,
              note: 'The manifest names no host, port or credential for the source — only a bucket and a server name through the Barman plugin.',
            },
            {
              run: `kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -x -c "SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"`,
              out: ` application_name |   state
------------------+-----------
 pg-cluster-2     | streaming
 pg-cluster-3     | streaming
(2 rows)

-[ RECORD 1 ]-----------+----------
pg_is_in_recovery       | t
pg_last_wal_receive_lsn |
pg_last_wal_replay_lsn  | 0/9000000`,
              note: 'The clearest evidence of the shape: the source does not list the replica at all, and the replica has no WAL *receiver* — receive stays empty while replay advances. It is a client of a bucket, not of the primary.',
            },
          ],
          notes: [
            'Latency is a WAL segment rather than milliseconds: a row does not appear until the segment carrying it is archived. `SELECT pg_switch_wal()` on the primary forces that immediately.',
            '`pg_switch_wal()` needs the superuser, so run it inside an instance Pod rather than through an application-role client.',
          ],
        },
        {
          id: 'replica-from-snapshot',
          name: 'VolumeSnapshot + bootstrap.recovery.volumeSnapshots',
          summary:
            'Seeds a new cluster from a storage-layer snapshot instead of copying files, then keeps it current by streaming — the practical way to add a replica to a large database.',
          usedIn: ['cnpg-replica-from-snapshot'],
          examples: [
            {
              run: `kubectl apply -f /root/snapshot.yaml
kubectl get volumesnapshot pg-cluster-snapshot -o json | jq '{readyToUse: .status.readyToUse, restoreSize: .status.restoreSize, content: .status.boundVolumeSnapshotContentName}'`,
              out: `volumesnapshot.snapshot.storage.k8s.io/pg-cluster-snapshot created
{
  "readyToUse": true,
  "restoreSize": "1Gi",
  "content": "snapcontent-3d38d0a3-be80-4276-a959-27dbbce0ce1f"
}`,
              note: 'The VolumeSnapshot names a PVC and a VolumeSnapshotClass and says nothing about PostgreSQL. `readyToUse` is what says the copy exists rather than just the request; the VolumeSnapshotContent behind it is the cluster-scoped half.',
            },
            {
              run: `kubectl apply -f /root/replica-cluster.yaml
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -x -c "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"`,
              out: `cluster.postgresql.cnpg.io/pg-replica created
 application_name |   state
------------------+-----------
 pg-replica       | streaming
(1 row)

-[ RECORD 1 ]-----------+----------
pg_last_wal_receive_lsn | 0/3000A78
pg_last_wal_replay_lsn  | 0/3000A78`,
              note: 'Pairing the snapshot bootstrap with `replica.enabled` and a streaming externalCluster gives a replica that has a WAL receiver — unlike one fed from an archive, both LSNs advance and new rows arrive in seconds.',
            },
          ],
          notes: [
            'k3s\'s default `local-path` class cannot snapshot at all; this needs a CSI driver that supports it plus the external-snapshotter CRDs.',
            'Nothing quiesces the database first, so the copy is crash-consistent — usable precisely because recovering from a crash is what PostgreSQL does on every start.',
            'A snapshot is a moment, not a stream: without a following mechanism you get a cluster frozen at the instant it was taken.',
          ],
        },
        {
          id: 'image-rolling-update',
          name: 'spec.imageName (rolling minor-version update)',
          summary:
            'Changing the PostgreSQL image rolls the new one through the cluster instance by instance — replicas first, primary last — while the database keeps serving.',
          usedIn: ['cnpg-rolling-update'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,READY:.status.containerStatuses[0].ready
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT 'still serving';"`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
NAME           IMAGE                                                  READY
pg-cluster-1   ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie   true
pg-cluster-2   ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie   true
pg-cluster-3   ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie   false
NAME         AGE     INSTANCES   READY   STATUS                                       PRIMARY
pg-cluster   8m19s   3           2       Waiting for the instances to become active   pg-cluster-1
still serving`,
              note: 'The mixed state is a roll in progress, not a broken cluster — and the database answers throughout. Read the image a Pod is *running* from .status.containerStatuses[0].image, not from its spec.',
            },
            {
              run: `kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,CREATED:.metadata.creationTimestamp
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT current_setting('server_version');"`,
              out: `NAME           IMAGE                                                  CREATED
pg-cluster-1   ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie   2026-08-16T00:21:03Z
pg-cluster-2   ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie   2026-08-16T00:20:39Z
pg-cluster-3   ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie   2026-08-16T00:20:05Z
18.4 (Debian 18.4-1.pgdg13+1)`,
              note: 'The creation timestamps give the order away: pg-cluster-3 first, then pg-cluster-2, then the primary last. Every Pod is new, because a container must be recreated to run a different image.',
            },
          ],
          notes: [
            'A minor release needs no data migration — the on-disk format is compatible, so an instance starts on the same data directory with a newer binary and the PersistentVolumeClaims are never touched.',
            'This is where an image change differs from a configuration change: a config change can restart PostgreSQL inside the primary\'s existing container, an image change cannot.',
            'The default primaryUpdateMethod is `restart`, which keeps the primary\'s role and recreates its Pod last. `switchover` promotes an already-upgraded replica instead — less write downtime, but the primary moves.',
            'None of this applies to a *major* version upgrade, which changes the on-disk format and is a different operation entirely.',
          ],
        },
        {
          id: 'multi-arch-images',
          name: 'Reading a multi-arch image from the registry (curl + jq)',
          summary:
            'A tag usually names an index listing one image per platform, not an image. Following it down to the config blob is how you find out what an image was really built for — and it is exactly what the container runtime does when it pulls.',
          usedIn: ['cnpg-multi-arch'],
          examples: [
            {
              run: `kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture,OS:.status.nodeInfo.operatingSystem
kubectl exec pg-cluster-1 -c postgres -- uname -m
kubectl exec pg-cluster-1 -c postgres -- dpkg --print-architecture
kubectl -n cnpg-system logs deploy/cnpg-controller-manager | grep "Kubernetes system metadata" | tail -1`,
              out: `NAME                             ARCH    OS
k3d-dbol-a2fee4093894-agent-0    arm64   linux
k3d-dbol-a2fee4093894-agent-1    arm64   linux
k3d-dbol-a2fee4093894-server-0   arm64   linux
aarch64
arm64
{"level":"info","ts":"2026-08-16T17:47:36.621208781Z","logger":"setup","msg":"Kubernetes system metadata","haveSCC":false,"haveVolumeSnapshot":false,"availableArchitectures":[{"GoArch":"amd64"},{"GoArch":"arm64"}]}`,
              note: 'Three vocabularies for one fact: the kernel says aarch64, Debian says arm64, and Kubernetes uses Debian\'s word. The operator logs which architectures it can supply an instance manager binary for — both of them, from one image.',
            },
            {
              run: `REPO=cloudnative-pg/postgresql
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" \\
     -H "Accept: application/vnd.oci.image.index.v1+json" \\
     "https://ghcr.io/v2/$REPO/manifests/18.4-system-trixie" | jq '{mediaType, manifests: [.manifests[] | {digest, platform}]}'`,
              out: `{
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {
      "digest": "sha256:e6e1f467b52112f7e08aa380de81473106ff54b1834d90bcb4265a2a018e1921",
      "platform": {
        "architecture": "amd64",
        "os": "linux"
      }
    },
    {
      "digest": "sha256:96b1695c6fc629bbc809ec49946349cfbd4785d18c7dbeeb5bfb9d9892b807e0",
      "platform": {
        "architecture": "arm64",
        "os": "linux"
      }
    },
    {
      "digest": "sha256:e296f47170cba3643907e8dc8f070d85646113cb03db9e89a00391d181167ef1",
      "platform": {
        "architecture": "unknown",
        "os": "unknown"
      }
    },
    {
      "digest": "sha256:4dfa63ca6e96c20c4c51fed924bcb4555cb09d18c8ab377d034f11f7402f4994",
      "platform": {
        "architecture": "unknown",
        "os": "unknown"
      }
    }
  ]
}`,
              note: 'A public image still needs an anonymous pull token. The two unknown/unknown entries are the build attestations — signed provenance and an SBOM — not images; a runtime skips them by matching on platform.',
            },
            {
              run: `DIGEST=sha256:96b1695c6fc629bbc809ec49946349cfbd4785d18c7dbeeb5bfb9d9892b807e0
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.manifest.v1+json" \\
     "https://ghcr.io/v2/$REPO/manifests/$DIGEST" | jq '{mediaType, config: .config, layers: (.layers | length)}'
CONFIG=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://ghcr.io/v2/$REPO/manifests/$DIGEST" | jq -r .config.digest)
curl -sL -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/$REPO/blobs/$CONFIG" | jq -c '{architecture, os, variant, created}'`,
              out: `{
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:5abb9e6a008e689578b7e3ebe8f8959ab41f5681708b1ba8daa8afcae5c9779a",
    "size": 6382
  },
  "layers": 5
}
{"architecture":"arm64","os":"linux","variant":null,"created":"2026-08-13T07:46:34.613794085Z"}`,
              note: 'The manifest at a platform digest has no `manifests` list — a config and some layers, one image. The config blob is where the image itself states its architecture, and it comes from the /blobs/ endpoint with -L, because registries redirect blob downloads to storage.',
            },
          ],
          notes: [
            'Both index and manifest media types have to be offered in `Accept`. Without them a registry may answer with an older single-platform conversion instead.',
            '`kubernetes.io/arch` is a standard node label, so restricting a workload to one architecture is an ordinary node selector rather than a special mechanism.',
            'Pinning by an *index* digest keeps the multi-architecture property; pinning by a single image\'s digest ties the manifest to one architecture and fails to schedule anywhere else.',
            'A Pod\'s `imageID` will not match the index entry in this environment, because the images are side-loaded into the k3d nodes rather than pulled — the local re-pack has its own digest.',
          ],
        },
        {
          id: 'managed-roles',
          name: 'spec.managed.roles (declaring a database role)',
          summary:
            'Puts a role in the Cluster definition instead of in somebody’s shell history: name, ensure, attributes, and a Secret holding the password. The operator makes the database match.',
          usedIn: ['cnpg-managed-roles'],
          examples: [
            {
              run: `kubectl create secret generic analyst-password \\
  --from-literal=username=analyst --from-literal=password=analyst_pw
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true,
     "comment": "read-only reporting account",
     "passwordSecret": {"name": "analyst-password"}}
  ]}}}'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolcanlogin, rolcreatedb, rolconnlimit FROM pg_roles WHERE rolname = 'analyst';"`,
              out: `secret/analyst-password created
cluster.postgresql.cnpg.io/pg-cluster patched
 rolname | rolcanlogin | rolcreatedb | rolconnlimit
---------+-------------+-------------+--------------
 analyst | t           | f           |           -1
(1 row)`,
              note: 'The role appeared within about fifteen seconds. `rolconnlimit -1` is the default: no limit.',
            },
            {
              run: `kubectl exec psql-client -- env PGPASSWORD=analyst_pw \\
  psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user, session_user;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT shobj_description(oid, 'pg_authid') FROM pg_roles WHERE rolname = 'analyst';"`,
              out: `analyst|analyst
read-only reporting account`,
              note: 'The password never appears in a manifest, and `COMMENT ON ROLE` is part of what the operator maintains.',
            },
            {
              run: `kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'`,
              out: '{"byStatus":{"not-managed":["app"],"reconciled":["analyst"],"reserved":["postgres","cnpg_metrics_exporter","streaming_replica"]},"passwordStatus":{"analyst":{"resourceVersion":"1348","transactionID":757}}}',
              note: '`reserved` are the operator’s own roles, which it will not let you manage; `not-managed` exists but has not been asked for; `passwordStatus` records the Secret version and the transaction the password was set in.',
            },
          ],
          notes: [
            'The Secret needs both a `username` and a `password` key, and `username` must equal the role name — otherwise the operator declines to use it.',
            '`spec.managed.roles` is a list, so a merge patch replaces it wholesale: an entry re-sent without its `login` or its `passwordSecret` loses them.',
            'Other fields the operator maintains: `createdb`, `createrole`, `superuser`, `inherit`, `bypassrls`, `connectionLimit`, `inRoles`, `validUntil` and `disablePassword`.',
          ],
        },
        {
          id: 'managed-roles-drift',
          name: 'status.managedRolesStatus (drift and cannotReconcile)',
          summary:
            'The two edges of managed roles: a change made in SQL is not reverted, and an ensure: absent PostgreSQL refuses is reported rather than retried into oblivion.',
          usedIn: ['cnpg-managed-roles'],
          examples: [
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "ALTER ROLE analyst NOLOGIN;"
for i in $(seq 1 10); do
  printf "%s " "$(date +%T)"
  kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'analyst';"
  sleep 6
done
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'`,
              out: `ALTER ROLE
01:18:46 f
01:18:53 f
01:18:59 f
01:19:05 f
01:19:11 f
{"byStatus":{"not-managed":["app"],"reconciled":["analyst"],"reserved":["postgres","cnpg_metrics_exporter","streaming_replica"]},"passwordStatus":{"analyst":{"resourceVersion":"1283","transactionID":759}}}`,
              note: 'Elided: it stayed `f` for a further three minutes. The status goes on saying `reconciled` while the database and the spec disagree.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"createdb":true,"connectionLimit":10,"comment":"read-only reporting account","passwordSecret":{"name":"analyst-password"}}]}}}'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolcanlogin, rolcreatedb, rolconnlimit FROM pg_roles WHERE rolname = 'analyst';"`,
              out: ` rolname | rolcanlogin | rolcreatedb | rolconnlimit
---------+-------------+-------------+--------------
 analyst | t           | t           |           10
(1 row)`,
              note: 'Any change to the entry makes the operator apply the whole role again, so LOGIN comes back alongside the limit that was actually asked for.',
            },
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "CREATE TABLE reports (id serial primary key, title text); ALTER TABLE reports OWNER TO analyst;"
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"absent"}]}}}'
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'
kubectl get cluster pg-cluster`,
              out: `CREATE TABLE
ALTER TABLE
cluster.postgresql.cnpg.io/pg-cluster patched
{"byStatus":{"not-managed":["app"],"pending-reconciliation":["analyst"],"reserved":["postgres","cnpg_metrics_exporter","streaming_replica"]},"cannotReconcile":{"analyst":["could not perform DELETE on role analyst: 2 objects in database app"]},"passwordStatus":{"analyst":{"resourceVersion":"1348","transactionID":772}}}
NAME         AGE     INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   4m33s   3           3       Cluster in healthy state   pg-cluster-1`,
              note: 'Two objects, not one: the table and the sequence behind its `serial` column. The cluster stays healthy while the request goes unfulfilled.',
            },
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "DROP TABLE reports;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname = 'analyst';"
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"absent","comment":"retired"}]}}}'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname = 'analyst';"`,
              out: `DROP TABLE
1
cluster.postgresql.cnpg.io/pg-cluster patched
0`,
              note: 'Clearing the obstacle is not enough on its own — the role went only after the spec was touched again.',
            },
          ],
          notes: [
            'Alert on `status.managedRolesStatus.cannotReconcile` rather than on the cluster’s phase: this is a class of failure that leaves the cluster perfectly healthy.',
            'Reassign or drop what a role owns before asking for it to be absent — `REASSIGN OWNED BY` and `DROP OWNED BY` are the SQL for a real retirement.',
            'The mental model is "applied on change", not "enforced continuously". Managed roles are not an audit control.',
          ],
        },
        {
          id: 'declarative-database',
          name: 'kind: Database (declarative databases)',
          summary:
            'A database as a namespaced object: which Cluster hosts it, what it is called in PostgreSQL, who owns it. The operator issues the CREATE DATABASE and reports in the object’s status.',
          usedIn: ['cnpg-declarative-databases', 'cnpg-database-reclaim'],
          examples: [
            {
              run: `cat /root/reporting-db.yaml
kubectl apply -f /root/reporting-db.yaml
kubectl get database`,
              out: `apiVersion: postgresql.cnpg.io/v1
kind: Database
metadata:
  name: reporting-db
  namespace: default
spec:
  cluster:
    name: pg-cluster
  name: reporting
  owner: app
database.postgresql.cnpg.io/reporting-db created
NAME           AGE   CLUSTER      PG NAME     APPLIED   MESSAGE
reporting-db   13s   pg-cluster   reporting   true`,
              note: 'The object’s name and the database’s name are separate fields. APPLIED turned true in about twelve seconds.',
            },
            {
              run: `kubectl get database reporting-db -o jsonpath='{.spec}{"\\n"}'
kubectl get database reporting-db -o jsonpath='{.status}{"\\n"}'
kubectl get database reporting-db -o jsonpath='{.metadata.finalizers}{"\\n"}'`,
              out: `{"cluster":{"name":"pg-cluster"},"databaseReclaimPolicy":"retain","ensure":"present","name":"reporting","owner":"app"}
{"applied":true,"observedGeneration":1}
["cnpg.io/deleteDatabase"]`,
              note: 'Three things the manifest never said: ensure, databaseReclaimPolicy and the finalizer that lets the operator decide what happens to the database when the object is deleted.',
            },
            {
              run: `kubectl apply -f /root/reporting-dup.yaml
kubectl get database
kubectl get database reporting-dup -o jsonpath='{.status}{"\\n"}'`,
              out: `database.postgresql.cnpg.io/reporting-dup created
NAME            AGE   CLUSTER      PG NAME     APPLIED   MESSAGE
reporting-db    35s   pg-cluster   reporting   true
reporting-dup   13s   pg-cluster   reporting   false     "reporting" is already managed by object "reporting-db"
{"applied":false,"message":"\\"reporting\\" is already managed by object \\"reporting-db\\""}`,
              note: 'The apply succeeds — this is not something admission can settle. The refusal lands in the newcomer’s own status, and the first object is untouched.',
            },
            {
              run: `kubectl delete database reporting-db
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | grep reporting
kubectl apply -f /root/reporting-db.yaml
kubectl get database reporting-db -o jsonpath='{.status}{"\\n"}'
kubectl exec psql-client -- psql -h pg-cluster-rw -d reporting -tAc "SELECT count(*) FROM ledger;"`,
              out: `database.postgresql.cnpg.io "reporting-db" deleted from default namespace
No resources found in default namespace.
 reporting | app      | UTF8     | libc            | C       | C
database.postgresql.cnpg.io/reporting-db created
{"applied":true,"observedGeneration":1}
3`,
              note: 'Under the default retain policy the database and its rows survive the object, and re-applying the same manifest adopts what is already there rather than failing or recreating it.',
            },
          ],
          notes: [
            'Adoption is by name: an object pointed at an existing database it was never meant to manage will take it over, and the only protection is that a second claim on the same database is refused.',
            'Other alterable fields the operator maintains: `allowConnections` (a client then gets `FATAL: database "reporting" is not currently accepting connections`) and `connectionLimit` (`datconnlimit`).',
            'A database left behind by a deleted object keeps its storage and its cost, with nothing in Kubernetes to remind you it is there.',
          ],
        },
        {
          id: 'database-reclaim-policy',
          name: 'databaseReclaimPolicy and ensure (ending a declared database)',
          summary:
            'Two different fields that both end with a database gone: one fires when the object is deleted, the other while it still exists.',
          usedIn: ['cnpg-database-reclaim'],
          examples: [
            {
              run: `kubectl get database -o custom-columns=OBJECT:.metadata.name,PGNAME:.spec.name,POLICY:.spec.databaseReclaimPolicy,ENSURE:.spec.ensure,APPLIED:.status.applied`,
              out: `OBJECT    PGNAME   POLICY   ENSURE    APPLIED
keep-db   keepdb   retain   present   true
temp-db   tempdb   delete   present   true`,
              note: 'The policy has no effect at all while the object exists, which is why it is easy to set carelessly.',
            },
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-rw -d tempdb -c "SELECT pg_sleep(90);" &
kubectl delete database temp-db --wait=false
kubectl get database
kubectl get database temp-db -o jsonpath='{"deletionTimestamp="}{.metadata.deletionTimestamp}{" finalizers="}{.metadata.finalizers}{"\\n"}'
kubectl describe database temp-db | tail -4
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = 'tempdb';"`,
              out: `database.postgresql.cnpg.io "temp-db" deleted from default namespace
NAME      AGE   CLUSTER      PG NAME   APPLIED   MESSAGE
keep-db   36s   pg-cluster   keepdb    true
temp-db   36s   pg-cluster   tempdb    true
deletionTimestamp=2026-08-17T04:57:54Z finalizers=["cnpg.io/deleteDatabase"]
Status:
  Applied:              true
  Observed Generation:  1
Events:                 <none>
1`,
              note: 'PostgreSQL will not drop a database with a session on it, so the deletion waits on the finalizer. No event, no message, status still applied: true — and a plain kubectl delete would simply not return.',
            },
            {
              run: `wait
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "\\l" | head -6`,
              out: `NAME      AGE    CLUSTER      PG NAME   APPLIED   MESSAGE
keep-db   2m3s   pg-cluster   keepdb    true
   Name    |  Owner   | Encoding | Locale Provider | Collate | Ctype
-----------+----------+----------+-----------------+---------+-------
 app       | app      | UTF8     | libc            | C       | C
 keepdb    | app      | UTF8     | libc            | C       | C`,
              note: 'The session ended, the object went, and tempdb went with it. keepdb, on the other policy, is untouched. Columns elided.',
            },
            {
              run: `kubectl patch database keep-db --type=merge -p '{"spec":{"ensure":"absent"}}'
kubectl get database
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = 'keepdb';"
kubectl get database keep-db -o custom-columns=OBJECT:.metadata.name,ENSURE:.spec.ensure,POLICY:.spec.databaseReclaimPolicy,APPLIED:.status.applied`,
              out: `database.postgresql.cnpg.io/keep-db patched
NAME      AGE     CLUSTER      PG NAME   APPLIED   MESSAGE
keep-db   2m30s   pg-cluster   keepdb    true
0
OBJECT    ENSURE   POLICY   APPLIED
keep-db   absent   retain   true`,
              note: 'ensure: absent dropped the database on an object whose reclaim policy says retain — the policy was never consulted, because the object was never deleted.',
            },
          ],
          notes: [
            'Three separate decisions: `ensure` is whether the database exists now, `databaseReclaimPolicy` is what happens if the object is deleted, and having an object at all is whether the operator manages it.',
            '`ensure` is reversible in the ordinary way — set it back to present and the operator creates the database again, empty. A reclaim policy only fires when there is no object left to change your mind with.',
            'With `delete`, removing the object is a destructive database operation wearing Kubernetes clothes, and it can hang indefinitely on an idle connection from an application nobody has scaled down.',
          ],
        },
        {
          id: 'major-upgrade',
          name: 'spec.imageName across a major version (declarative pg_upgrade)',
          summary:
            'The same field a minor upgrade uses. A changed major has the operator stop the database, run pg_upgrade in place on the primary, and rebuild every replica from it.',
          usedIn: ['cnpg-major-upgrade'],
          examples: [
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT version();"
kubectl get cluster pg-cluster -o jsonpath='{.status.image}|{.status.pgDataImageInfo}{"\\n"}'`,
              out: `PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
ghcr.io/cloudnative-pg/postgresql:17-system-trixie|{"image":"ghcr.io/cloudnative-pg/postgresql:17-system-trixie","majorVersion":17}`,
              note: '`status.pgDataImageInfo` is what the operator compares against to notice a major change at all — the image that last ran on this data directory.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}}'
for i in $(seq 1 18); do
  printf "%s | " "$(date +%T)"
  kubectl get cluster pg-cluster --no-headers
  kubectl get pods --no-headers | grep -v psql-client
  echo
  sleep 8
done`,
              out: `07:04:45 | pg-cluster 2m55s 3   Upgrading Postgres major version pg-cluster-1
pg-cluster-1-major-upgrade-qght8 1/1 Running 0 6s
07:05:09 | pg-cluster 3m20s 3   Upgrading Postgres major version pg-cluster-1
pg-cluster-1-major-upgrade-qght8 0/1 Completed 0 31s
07:05:26 | pg-cluster 3m36s 2 1 Creating a new replica pg-cluster-1
pg-cluster-1 1/1 Running 0 14s
pg-cluster-2-join-p85ph 0/1 Pending 0 2s`,
              note: 'All three instances stop, the upgrade Job runs ~31s, the primary comes back on the new image, then each replica is rebuilt by an ordinary join Job. Rows elided; healthy again about two minutes after the patch.',
            },
            {
              run: `kubectl get job pg-cluster-1-major-upgrade -o jsonpath='{range .spec.template.spec.initContainers[*]}INIT {.name} {.image}{"\\n"}{end}{range .spec.template.spec.containers[*]}MAIN {.name} {.image}{"\\n"}{end}'
kubectl logs job/pg-cluster-1-major-upgrade --all-containers | tail -6`,
              out: `INIT bootstrap-controller ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0
INIT prepare ghcr.io/cloudnative-pg/postgresql:17-system-trixie
MAIN major-upgrade ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie
{"msg":"Copying the PostgreSQL installation to the destination","destination":"/controller/old"}
{"msg":"Creating the bindir.txt file","file":"/controller/old/bindir.txt"}
{"msg":"Copying the files","source":"/usr/lib/postgresql/17/bin","destination":"/controller/old/usr/lib/postgresql/17/bin"}
{"msg":"Copying the files","source":"/usr/share/postgresql/17","destination":"/controller/old/usr/share/postgresql/17"}`,
              note: 'The `prepare` init container runs the *old* image and copies its installation to /controller/old — that is pg_upgrade’s --old-bindir. Catch the Job in a loop: it is deleted as soon as it succeeds. Log timestamps and levels elided.',
            },
            {
              run: `kubectl get pvc -o custom-columns=NAME:.metadata.name,AGE:.metadata.creationTimestamp,VOLUME:.spec.volumeName
kubectl exec pg-cluster-1 -c postgres -- sh -c 'ls /var/lib/postgresql/data/'`,
              out: `NAME           AGE                    VOLUME
pg-cluster-1   2026-08-17T07:01:52Z   pvc-e0824a14-8e5f-4dbb-9ea0-78f7bbff714a
pg-cluster-2   2026-08-17T07:05:24Z   pvc-61e05835-ee69-425e-8e3d-c8a493be316c
pg-cluster-3   2026-08-17T07:06:07Z   pvc-22cab4b0-b69f-428c-b210-b19c9513e9e0
pgdata`,
              note: 'The primary’s claim predates the upgrade; the replicas’ were created during it. One pgdata directory on the volume — no copy of the old cluster is kept.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"imageName":"ghcr.io/cloudnative-pg/postgresql:17-system-trixie"}}'`,
              out: 'The Cluster "pg-cluster" is invalid: spec.imageName: Invalid value: "17": can\'t downgrade from major 18 to 17',
              note: 'Refused at admission, so nothing is written — and nothing is reversible. The route back is a backup taken before the upgrade.',
            },
            {
              run: `kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "SELECT relname, reltuples, (SELECT count(*) FROM pg_stats WHERE tablename = c.relname) AS stat_columns FROM pg_class c WHERE relname = 'notes';"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "ANALYZE notes;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "SELECT relname, reltuples, (SELECT count(*) FROM pg_stats WHERE tablename = c.relname) AS stat_columns FROM pg_class c WHERE relname = 'notes';"`,
              out: ` relname | reltuples | stat_columns
---------+-----------+--------------
 notes   |        -1 |            0
(1 row)

ANALYZE
 relname | reltuples | stat_columns
---------+-----------+--------------
 notes   |        50 |            2
(1 row)`,
              note: 'pg_upgrade does not carry optimizer statistics: reltuples -1 is "never analysed". ANALYZE — vacuumdb --analyze-in-stages on a real database — is the last step of the upgrade.',
            },
            {
              run: `for c in pg-cluster-1 pg-fresh-1; do
  printf "%-14s " "$c"
  kubectl exec $c -c postgres -- psql -U postgres -tAc "SELECT 'server_version=' || current_setting('server_version') || ' data_checksums=' || current_setting('data_checksums');"
done`,
              out: `pg-cluster-1   server_version=18.4 (Debian 18.4-1.pgdg13+1) data_checksums=off
pg-fresh-1     server_version=18.4 (Debian 18.4-1.pgdg13+1) data_checksums=on`,
              note: 'Same image, two answers: the upgraded cluster keeps what PostgreSQL 17’s initdb decided, because no initdb ever ran on it. pg-fresh is a single-instance cluster bootstrapped from the 18 image for the comparison.',
            },
          ],
          notes: [
            'The old image must still be pullable at upgrade time — the `prepare` init container runs it to stage the old binaries.',
            'The replica rebuild, not pg_upgrade, is what takes the time on a real database: each one is a fresh pg_basebackup.',
            'Plan the upgrade as an outage on the primary plus a full replica rebuild, with a backup taken first, because admission will not let you change your mind.',
          ],
        },
        {
          id: 'role-password-rotation',
          name: 'Rotating a managed role password (kubectl patch secret + cnpg.io/reload)',
          summary:
            'The password lives in a Secret, so rotation is a patch on the Secret — but only if that Secret carries the label that puts it in the operator\'s watch set. Without it, nothing happens and nothing complains.',
          usedIn: ['cnpg-role-passwords'],
          examples: [
            {
              run: `kubectl patch secret analyst-password -p '{"stringData":{"password":"analyst_2026"}}'
kubectl get secret analyst-password -o jsonpath='{.data.password}' | base64 -d; echo
for i in $(seq 1 6); do
  printf "%s new=" "$(date +%T)"
  kubectl exec psql-client -- env PGPASSWORD=analyst_2026 psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  printf " old="
  kubectl exec psql-client -- env PGPASSWORD=analyst_pw psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  echo
  sleep 8
done`,
              out: `secret/analyst-password patched
analyst_2026
03:36:08 new= old=1
03:36:16 new= old=1
03:36:24 new= old=1
03:36:33 new= old=1
03:36:41 new= old=1
03:36:49 new= old=1`,
              note: 'The Secret holds the new password and the database keeps taking the old one. Watched for six minutes in a separate run with the same result — this does not resolve itself.',
            },
            {
              run: `kubectl get secret analyst-password -o jsonpath='{.metadata.resourceVersion}{"\\n"}'
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus.analyst.resourceVersion}{"\\n"}'`,
              out: `1385
1342`,
              note: 'The one-line diagnosis: where the Secret is now, against the version of it the operator acted on.',
            },
            {
              run: `kubectl get secret pg-cluster-app --show-labels
kubectl get secret analyst-password --show-labels`,
              out: `pg-cluster-app     kubernetes.io/basic-auth   11   3m46s   app.kubernetes.io/managed-by=cloudnative-pg,cnpg.io/cluster=pg-cluster,cnpg.io/reload=true,cnpg.io/userType=app
analyst-password   Opaque                     2    70s     <none>`,
              note: 'The operator labels its own Secrets `cnpg.io/reload=true`. A Secret you create by hand has no labels, which is why the mechanism is easy to miss.',
            },
            {
              run: `kubectl label secret analyst-password cnpg.io/reload=true
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus}{"\\n"}'`,
              out: `secret/analyst-password labeled
{"analyst":{"resourceVersion":"1460","transactionID":770}}`,
              note: 'Applied about eight seconds after the label: the new password connects, the old one is refused, and the applied version now matches the Secret.',
            },
            {
              run: `kubectl annotate secret analyst-password lab/rotated-at="$(date +%s)" --overwrite
kubectl get secret analyst-password -o jsonpath='{.metadata.resourceVersion}{"\\n"}'
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus}{"\\n"}'`,
              out: `secret/analyst-password annotated
1678
{"analyst":{"resourceVersion":"1678","transactionID":772}}`,
              note: 'Forcing a re-apply without changing the password: any change to the Secret moves its resourceVersion, which is all the operator watches.',
            },
          ],
          notes: [
            'A password changed with `ALTER ROLE ... PASSWORD` is not reverted — measured over two minutes, with the role reported `reconciled` throughout. Touch the Secret and the operator overwrites it on the next poll.',
            'The label is `cnpg.io/reload: "true"` on the Secret, not on the Cluster, and it is what makes any hand-made Secret visible to the operator.',
            '`stringData` in a merge patch writes a plain value without base64; the API server encodes it into `data`.',
          ],
        },
        {
          id: 'role-password-end',
          name: 'validUntil and disablePassword (ending a password)',
          summary:
            'Two ways to stop a password working without dropping the role: an expiry date written through to PostgreSQL, and removing the password altogether.',
          usedIn: ['cnpg-role-passwords'],
          examples: [
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"comment":"reporting account","validUntil":"2026-01-01T00:00:00Z","passwordSecret":{"name":"analyst-password"}}]}}}'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rolname, rolvaliduntil FROM pg_roles WHERE rolname = 'analyst';"
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;"`,
              out: ` rolname |     rolvaliduntil
---------+------------------------
 analyst | 2026-01-01 00:00:00+00
(1 row)

psql: error: connection to server at "pg-cluster-rw" (10.43.151.224), port 5432 failed: FATAL:  password authentication failed for user "analyst"`,
              note: 'PostgreSQL does not tell the client the password expired — this is the same sentence a wrong password produces.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"comment":"reporting account","disablePassword":true,"passwordSecret":{"name":"analyst-password"}}]}}}'`,
              out: 'The Cluster "pg-cluster" is invalid: spec.managed.roles: Invalid value: "analyst": This role both sets and disables a password',
              note: 'Refused at admission, so nothing was written and there is nothing to undo.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"comment":"reporting account","disablePassword":true}]}}}'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rolname, (rolpassword IS NULL) AS no_password, rolvaliduntil FROM pg_authid WHERE rolname = 'analyst';"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus}{"\\n"}'`,
              out: ` rolname | no_password | rolvaliduntil
---------+-------------+---------------
 analyst | t           | infinity
(1 row)

{"analyst":{"transactionID":775}}`,
              note: 'The password is NULL, the expiry is back to `infinity` because the re-applied entry no longer asks for one, and `passwordStatus` keeps only a transaction id — there is no Secret being tracked any more.',
            },
          ],
          notes: [
            'The role may still log in after `disablePassword` — it simply has nothing to log in with, which is what you want for a role that authenticates by certificate or by peer.',
            'The operator re-applies the whole role entry, so a field dropped from the entry is reset in the database, not left alone.',
            'Through expiry and disabling the role stays under `byStatus.reconciled` and the cluster stays healthy: none of this is a failure, it is what was asked for.',
          ],
        },
      ],
    },

    {
      id: 'backup',
      title: 'Backups on object storage',
      blurb:
        'The Barman Cloud plugin: describing a bucket, archiving WAL to it, taking base backups and scheduling them.',
      commands: [
        {
          id: 'snapshot-classes',
          name: 'kubectl get storageclass / volumesnapshotclass',
          summary:
            "Whether snapshots are possible at all is a property of the storage. k3s's own local-path has no CSI driver behind it and cannot snapshot; a VolumeSnapshotClass names the driver that will do the work.",
          usedIn: ['cnpg-volume-snapshots'],
          examples: [
            {
              run: `kubectl get storageclass
kubectl get volumesnapshotclass
kubectl get pvc`,
              out: `NAME                   PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION   AGE
csi-hostpath-sc        hostpath.csi.k8s.io     Delete          WaitForFirstConsumer   true                   2m49s
local-path (default)   rancher.io/local-path   Delete          WaitForFirstConsumer   false                  4m56s
NAME                     DRIVER                DELETIONPOLICY   AGE
csi-hostpath-snapclass   hostpath.csi.k8s.io   Delete           2m49s
NAME           STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS      VOLUMEATTRIBUTESCLASS   AGE
pg-cluster-1   Bound    pvc-bbe34ce1-b03f-4a4d-82e2-4d29985ba296   1Gi        RWO            csi-hostpath-sc   <unset>                 82s`,
              note: 'The default class is the one that cannot snapshot — the cluster is deliberately on the other.',
            },
            {
              run: `kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.spec.backup.volumeSnapshot}{"\\n"}'`,
              out: '{"className":"csi-hostpath-snapclass","online":true,"onlineConfiguration":{"immediateCheckpoint":false,"waitForArchive":true},"snapshotOwnerReference":"none"}',
              note: '`online: true` means the snapshot is taken hot — PostgreSQL is put into backup mode rather than shut down.',
            },
          ],
        },
        {
          id: 'volumesnapshot-backup',
          name: 'Backup with method: volumeSnapshot',
          summary:
            'The same Backup resource as any other method, but what it leaves behind is a VolumeSnapshot object owned by the storage layer. Nothing can be restored from it until readyToUse turns true.',
          usedIn: ['cnpg-volume-snapshots'],
          examples: [
            {
              run: `kubectl apply -f /root/snapshot-backup.yaml
kubectl get backup
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,CLASS:.spec.volumeSnapshotClassName`,
              out: `backup.postgresql.cnpg.io/snapshot-backup created
NAME              AGE     CLUSTER      METHOD           PHASE       ERROR
snapshot-backup   2m16s   pg-cluster   volumeSnapshot   completed
NAME              READY   SOURCE         CLASS
snapshot-backup   true    pg-cluster-1   csi-hostpath-snapclass`,
              note: 'Seconds, not minutes: the storage layer clones the volume rather than copying a database through a client.',
            },
          ],
          notes: [
            'CloudNativePG decides whether it supports this method by looking for the VolumeSnapshot CRD **at operator startup**. Install the snapshot API afterwards and every such Backup is rejected with `Cannot use volumeSnapshot backup method due to missing VolumeSnapshot CRD ... please restart it`.',
          ],
        },
        {
          id: 'snapshot-online-cold',
          name: 'spec.online on a volumeSnapshot Backup',
          summary:
            'One boolean choosing between a snapshot taken while PostgreSQL runs, bracketed by pg_backup_start/stop, and one taken with the instance fenced and shut down. The difference is recorded inside the snapshot.',
          usedIn: ['cnpg-snapshot-modes'],
          examples: [
            {
              run: `kubectl apply -f /root/cold-backup.yaml
for i in $(seq 1 10); do
  printf "%s " "$(date +%T)"; kubectl get backup cold-backup --no-headers | tr '\\n' ' '
  printf "fenced="; kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}'; echo
  sleep 5
done`,
              out: `backup.postgresql.cnpg.io/cold-backup created
00:13:55 cold-backup   0s    pg-cluster   volumeSnapshot   started    fenced=["pg-cluster-1"]
00:14:05 cold-backup   10s   pg-cluster   volumeSnapshot   started    fenced=["pg-cluster-1"]
00:14:15 cold-backup   20s   pg-cluster   volumeSnapshot   started    fenced=["pg-cluster-1"]
00:14:25 cold-backup   30s   pg-cluster   volumeSnapshot   completed    fenced=
00:14:35 cold-backup   40s   pg-cluster   volumeSnapshot   completed    fenced=`,
              note: 'Output thinned to every other line. The Cluster carries cnpg.io/fencedInstances for the duration — the operator has stopped PostgreSQL without deleting the Pod — and clears it when the backup completes.',
            },
            {
              run: `for s in hot-backup cold-backup; do
  printf "%-12s " "$s"
  kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' | grep "Database cluster state"
done
kubectl get volumesnapshot cold-backup -o yaml | grep "cnpg.io/backupLabelFile" | wc -l
kubectl get volumesnapshot hot-backup -o jsonpath='{.metadata.annotations.cnpg\\.io/backupLabelFile}' | base64 -d`,
              out: `hot-backup   Database cluster state:               in production
cold-backup  Database cluster state:               shut down
0
START WAL LOCATION: 0/3000028 (file 000000010000000000000003)
CHECKPOINT LOCATION: 0/3000080
BACKUP METHOD: streamed
BACKUP FROM: primary
START TIME: 2026-08-17 00:13:10 UTC
LABEL: hot-backup
START TIMELINE: 1`,
              note: 'The evidence is inside the snapshots. The online one records a running database and carries PostgreSQL\'s own backup label; the cold one records a clean shutdown and has no label, because there was nothing in flight to replay.',
            },
            {
              run: `kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,PHASE:.status.phase,STARTED:.status.startedAt,STOPPED:.status.stoppedAt`,
              out: `NAME          METHOD           ONLINE   PHASE       STARTED                STOPPED
cold-backup   volumeSnapshot   false    completed   2026-08-17T00:13:55Z   2026-08-17T00:14:21Z
hot-backup    volumeSnapshot   true     completed   2026-08-17T00:13:10Z   2026-08-17T00:13:22Z`,
              note: 'Read .spec.online, which is what was asked for. In this operator release .status.online reported true for both, so it is not the field to check.',
            },
          ],
          notes: [
            'Restoring is identical either way — a Cluster whose `bootstrap.recovery.volumeSnapshots` names the snapshot. A cold copy starts without recovery: its log reads "database system was shut down" and then "ready to accept connections".',
            'The default backup target is `prefer-standby`, so on a replicated cluster a cold backup costs you a replica for half a minute. On a single-instance cluster it costs you the database.',
            '`spec.backup.volumeSnapshot.online` sets the cluster-wide default; `spec.online` on an individual Backup overrides it.',
          ],
        },
        {
          id: 'restore-from-snapshot',
          name: 'bootstrap.recovery.volumeSnapshots (restore)',
          summary:
            'Restoring does not rewind the existing cluster — it creates a new one whose storage is cloned from the snapshot, while the original keeps serving untouched.',
          usedIn: ['cnpg-volume-snapshots'],
          examples: [
            {
              run: `kubectl apply -f /root/restored-cluster.yaml
kubectl get cluster.postgresql.cnpg.io
kubectl get pvc pg-cluster-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'`,
              out: `cluster.postgresql.cnpg.io/pg-cluster-restored created
NAME                  AGE     INSTANCES   READY   STATUS                     PRIMARY
pg-cluster            9m16s   1           1       Cluster in healthy state   pg-cluster-1
pg-cluster-restored   4m52s   1           1       Cluster in healthy state   pg-cluster-restored-1
{"apiGroup":"snapshot.storage.k8s.io","kind":"VolumeSnapshot","name":"snapshot-backup"}`,
              note: "The `dataSource` on the claim is the proof: an ordinary claim has none, and its database would be empty.",
            },
            {
              run: `kubectl exec pg-cluster-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM snap_proof ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM snap_proof ORDER BY id;"`,
              out: ` id |      note       |          created_at
----+-----------------+-------------------------------
  1 | before-snapshot | 2026-08-15 10:40:07.232146+00
(1 row)

 id |      note       |          created_at
----+-----------------+-------------------------------
  1 | before-snapshot | 2026-08-15 10:40:07.232146+00
  2 | after-snapshot  | 2026-08-15 10:43:06.547118+00
(2 rows)`,
              note: 'The copy stops at the instant the snapshot was taken; the row committed afterwards exists only in the cluster that kept running.',
            },
          ],
          notes: [
            'The restored cluster is a separate cluster: its own Pod, claim, credentials and `-rw`/`-ro`/`-r` Services. Using the copy means pointing an application at the new cluster\'s Service.',
          ],
        },
        {
          id: 'objectstore',
          name: 'kubectl apply -f objectstore.yaml && kubectl get objectstore',
          summary:
            "An ObjectStore describes a backup destination — bucket, endpoint, credentials by reference, retention and WAL compression. It is inert on its own: creating one backs nothing up.",
          usedIn: ['cnpg-barman-backup'],
          examples: [
            {
              run: `kubectl create secret generic seaweedfs-creds --from-literal=ACCESS_KEY_ID=seaweedfs --from-literal=ACCESS_SECRET_KEY=seaweedfs_password
kubectl apply -f /root/objectstore.yaml
kubectl get objectstore`,
              out: `secret/seaweedfs-creds created
objectstore.barmancloud.cnpg.io/seaweedfs-store created
NAME              AGE
seaweedfs-store   37m`,
            },
          ],
          notes: [
            'The key names in the Secret have to match the ones the ObjectStore references — a mismatch surfaces later as archiving failures, not as an apply-time error.',
            'CloudNativePG 1.30 still accepts the in-tree `spec.backup.barmanObjectStore`, but every use of it returns a deprecation warning and it is removed in 1.31.',
          ],
        },
        {
          id: 'enable-archiving',
          name: 'kubectl patch cluster … spec.plugins (WAL archiving)',
          summary:
            'Declares the Barman Cloud plugin as the cluster\'s WAL archiver and points it at an ObjectStore. The operator rolls the instances to apply it, then PostgreSQL ships every completed WAL segment to the bucket.',
          usedIn: ['cnpg-barman-backup'],
          examples: [
            {
              run: `kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"plugins":[{"name":"barman-cloud.cloudnative-pg.io","isWALArchiver":true,"parameters":{"barmanObjectName":"seaweedfs-store"}}]}}'
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}'`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
Initialized=True ConsistentSystemID=True Ready=True ContinuousArchiving=True`,
              note: 'ContinuousArchiving turns True only once a WAL file has actually reached the bucket — it is a statement about the storage, not about the configuration.',
            },
          ],
          notes: [
            'This is a rolling change, not a reload: READY drops below 3 while the instances are replaced.',
          ],
        },
        {
          id: 'backup-resource',
          name: 'kubectl apply -f backup.yaml && kubectl get backup',
          summary:
            'A Backup is a request, not a command: create one naming the cluster and `method: plugin`, and the operator performs it and records what it took.',
          usedIn: ['cnpg-barman-backup'],
          examples: [
            {
              run: `kubectl apply -f /root/backup.yaml
kubectl get backup`,
              out: `backup.postgresql.cnpg.io/first-backup created
NAME           AGE    CLUSTER      METHOD   PHASE       ERROR
first-backup   2m4s   pg-cluster   plugin   completed`,
            },
            {
              run: "kubectl get backup first-backup -o yaml | sed -n '/^status:/,$p'",
              out: `status:
  backupId: 20260815T091416
  backupName: backup-20260815091416
  beginLSN: 0/7000028
  beginWal: "000000010000000000000007"
  endLSN: 0/8000060
  endWal: "000000010000000000000008"
  instanceID:
    podName: pg-cluster-2
  majorVersion: 18
  method: plugin
  online: true
  phase: completed`,
              note: 'Elided to the fields worth reading. `backupId` is the directory name in the bucket; `podName` shows the backup was taken from a standby, which is the operator\'s default preference.',
            },
          ],
          notes: [
            '`beginWal` and `endWal` bracket the base backup — everything committed after `endWal` lives in the WAL archive, which is how the two halves combine into a recovery window.',
          ],
        },
        {
          id: 'scheduled-backup',
          name: 'kubectl apply -f scheduledbackup.yaml && kubectl get scheduledbackup',
          summary:
            'Creates Backups on a cron schedule. The expression has six fields, starting with seconds — a five-field expression is rejected.',
          usedIn: ['cnpg-barman-backup'],
          examples: [
            {
              run: `kubectl apply -f /root/scheduledbackup.yaml
kubectl get scheduledbackup
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,PHASE:.status.phase,OWNER:.metadata.ownerReferences[0].kind`,
              out: `scheduledbackup.postgresql.cnpg.io/every-two-minutes created
NAME                AGE   CLUSTER      LAST BACKUP
every-two-minutes   29m   pg-cluster   10m
NAME                               METHOD   PHASE       OWNER
every-two-minutes-20260815091800   plugin   completed   ScheduledBackup
every-two-minutes-20260815092000   plugin   completed   ScheduledBackup
every-two-minutes-20260815092200   plugin   completed   ScheduledBackup
first-backup                       plugin   completed   <none>`,
              note: 'Backups made by the schedule are owned by it; the hand-made one has no owner. Elided: the schedule had fired ten times by then.',
            },
          ],
          notes: [
            '`backupOwnerReference: self` makes each Backup owned by the schedule, so deleting the schedule cleans up after itself.',
          ],
        },
        {
          id: 'recover-from-store',
          name: 'bootstrap.recovery + externalClusters (restore from object storage)',
          summary:
            'Recovery is a bootstrap method: a new Cluster whose database is assembled from the bucket. `serverName` says whose backups to read, since one bucket routinely holds several clusters.',
          usedIn: ['cnpg-barman-restore', 'cnpg-pitr', 'cnpg-wal-restore'],
          examples: [
            {
              run: `cat /root/restore.yaml
kubectl apply -f /root/restore.yaml
kubectl get cluster.postgresql.cnpg.io`,
              out: `  bootstrap:
    recovery:
      source: origin
  externalClusters:
  - name: origin
    plugin:
      name: barman-cloud.cloudnative-pg.io
      parameters:
        barmanObjectName: seaweedfs-store
        serverName: pg-cluster
cluster.postgresql.cnpg.io/pg-restored created
NAME          AGE     INSTANCES   READY   STATUS                     PRIMARY
pg-cluster    9m21s   3           3       Cluster in healthy state   pg-cluster-1
pg-restored   5m6s    1           1       Cluster in healthy state   pg-restored-1`,
              note: 'Manifest elided to the two blocks that matter. The original is untouched throughout — a restore reads the bucket.',
            },
            {
              run: `kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM restore_proof;"`,
              out: ` id |     note     |              at
----+--------------+-------------------------------
  1 | after-backup | 2026-08-15 12:32:55.738431+00
(1 row)`,
              note: 'This row was committed *after* the base backup was taken, so it can only have arrived by replaying the WAL archive.',
            },
          ],
          notes: [
            'A recovery Job runs first and is garbage-collected when it finishes; the instance Pod then starts on the volume it produced.',
          ],
        },
        {
          id: 'recovery-target',
          name: 'recoveryTarget.targetTime (point-in-time recovery)',
          summary:
            'Adds a stopping condition to a recovery: replay halts at the first commit past the target, leaving everything after it in the archive unapplied.',
          usedIn: ['cnpg-pitr'],
          examples: [
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now();" > /root/target-time.txt
sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr.yaml.template > /root/pitr.yaml
grep -A2 recoveryTarget /root/pitr.yaml
kubectl apply -f /root/pitr.yaml`,
              out: `      recoveryTarget:
        targetTime: "2026-08-15 12:45:19.667558+00"
  externalClusters:
cluster.postgresql.cnpg.io/pg-pitr created`,
              note: '`SELECT now()` prints exactly the format a recovery target accepts, on the same clock the WAL commit timestamps were written against.',
            },
            {
              run: `kubectl exec pg-pitr-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM pitr_proof ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pitr_proof ORDER BY id;"`,
              out: ` id | note  |              at
----+-------+-------------------------------
  1 | first | 2026-08-15 12:45:19.597592+00
(1 row)

 id |  note  |              at
----+--------+-------------------------------
  1 | first  | 2026-08-15 12:45:19.597592+00
  2 | second | 2026-08-15 12:45:24.766193+00
(2 rows)`,
              note: 'Recovered to a moment between the two commits: the copy holds the first row only, while the original still holds both.',
            },
          ],
          notes: [
            'Targets can also be an LSN, a transaction id, a named restore point, or `targetImmediate` to stop as soon as the restored backup is consistent.',
          ],
        },
        {
          id: 'wal-maxparallel',
          name: 'wal.maxParallel (parallel WAL restore)',
          summary:
            'Recovery fetches WAL one segment at a time by default, each request a round trip to the object store. maxParallel prefetches several ahead of the replay.',
          usedIn: ['cnpg-wal-restore'],
          examples: [
            {
              run: `kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT archived_count FROM pg_stat_archiver;"
kubectl get objectstore seaweedfs-store -o jsonpath='{.spec.configuration.wal}{"\\n"}'`,
              out: `130
{"compression":"gzip"}`,
              note: 'How many segments a recovery would replay, and how it would fetch them — one at a time, with no maxParallel set.',
            },
            {
              run: `kubectl patch objectstore.barmancloud.cnpg.io seaweedfs-store --type=merge -p '{"spec":{"configuration":{"wal":{"maxParallel":8}}}}'
kubectl get objectstore seaweedfs-store -o jsonpath='{.spec.configuration.wal}{"\\n"}'`,
              out: `objectstore.barmancloud.cnpg.io/seaweedfs-store patched
{"compression":"gzip","maxParallel":8}`,
              note: 'A property of the archive, not of any one cluster: everything recovering from this store inherits it.',
            },
            {
              run: `echo "sequential: $(cat /root/sequential-seconds.txt)s   parallel: $(cat /root/parallel-seconds.txt)s"`,
              out: 'sequential: 91s   parallel: 60s',
              note: 'One measured pair over a ~125-segment archive. Across three pairs on this environment: 81/72/91 sequential against 61/56/60 parallel. The size of the gap depends on the machine and the distance to the store.',
            },
          ],
          notes: [
            'It changes how many fetches are in flight, never which records are applied or in what order — both restores produce identical databases.',
            'It matters in proportion to how much WAL there is to replay: a frequently-backed-up cluster has little, one recovering across days of archive has a lot.',
          ],
        },
        {
          id: 'cnpg-status-backup',
          name: 'kubectl cnpg status <cluster> (continuous backup section)',
          summary:
            "The recovery window in two lines: how far back you can restore to, and when the last successful backup was — plus whether WAL archiving is currently working at all.",
          usedIn: ['cnpg-barman-backup'],
          examples: [
            {
              run: 'kubectl cnpg status pg-cluster',
              out: `Continuous Backup status (Barman Cloud Plugin)
ObjectStore / Server name:      seaweedfs-store/pg-cluster
First Point of Recoverability:  2026-08-15 09:14:21 UTC
Last Successful Backup:         2026-08-15 09:46:13 UTC
Last Failed Backup:             -
Working WAL archiving:          OK
WALs waiting to be archived:    0
Last Archived WAL:              000000010000000000000008   @   2026-08-15T09:19:07.010865Z`,
              note: 'Only the backup section; the command prints the cluster summary and replication status above it.',
            },
          ],
          notes: [
            'Before any base backup exists, both recoverability fields read `-` even though WAL archiving is already working — the archive needs a base to replay onto.',
            '"WALs waiting to be archived" climbing is the early warning that a bucket has become unreachable, long before anyone tries to restore.',
          ],
        },
        {
          id: 'cnpg-backup-command',
          name: 'kubectl cnpg backup <cluster> [-m volumeSnapshot] [--online=false] [--backup-name <name>]',
          summary:
            'Builds an ordinary Backup resource out of its flags and applies it. Nothing about the result is special: the operator does exactly what it would have done for a manifest, which is why this is safe to reach for in a hurry.',
          usedIn: ['cnpg-plugin-snapshot-backup'],
          examples: [
            {
              run: `kubectl cnpg backup pg-cluster -m volumeSnapshot
kubectl get backup -o custom-columns=NAME:.metadata.name,METHOD:.spec.method,ONLINE:.spec.online,TARGET:.spec.target,PHASE:.status.phase
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,SIZE:.status.restoreSize`,
              out: `backup/pg-cluster-20260817015306 created
NAME                        METHOD           ONLINE   TARGET   PHASE
pg-cluster-20260817015306   volumeSnapshot   <none>   <none>   completed
NAME                        READY   SOURCE         SIZE
pg-cluster-20260817015306   true    pg-cluster-1   1Gi`,
              note: 'With no `--backup-name` the plugin composes one from the cluster name and a timestamp. `ONLINE` and `TARGET` read `<none>` because the flags were not given — the Cluster’s own `spec.backup` decides.',
            },
            {
              run: `kubectl cnpg backup pg-cluster -m volumeSnapshot --online=false --backup-name cold-by-plugin
kubectl get backup cold-by-plugin --no-headers
kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}{"\\n"}'`,
              out: `backup/cold-by-plugin created
cold-by-plugin   6s    pg-cluster   volumeSnapshot   started
["pg-cluster-1"]`,
              note: 'While an offline backup runs, the Cluster carries `cnpg.io/fencedInstances` naming the instance whose PostgreSQL has been stopped. It cleared about 31 seconds in, when the backup completed.',
            },
            {
              run: 'kubectl cnpg backup --help',
              out: `Flags:
      --backup-name string            The name of the Backup resource that will be created, defaults to "CLUSTER-CURRENT_TIMESTAMP"
  -t, --backup-target string          If present, will override the backup target defined in cluster, valid values are primary and prefer-standby.
      --immediate-checkpoint string   Set the '.spec.onlineConfiguration.immediateCheckpoint' field of the Backup resource. …
  -m, --method string                 If present, will override the backup method defined in backup resource, valid values are: barmanObjectStore, volumeSnapshot, plugin.
      --online string                 Set the '.spec.online' field of the Backup resource. … Accepted values: true|false|"".
      --wait-for-archive string       Set the '.spec.onlineConfiguration.waitForArchive' field of the Backup resource. …`,
              note: 'Elided: the plugin-method flags and the global kubectl flags. Every flag here names the field of the Backup resource it sets.',
            },
          ],
          notes: [
            '`--online` takes a value rather than being a switch: `--online=false`. Its accepted values are `true|false|""`.',
            'An empty `spec.online` and an explicit `false` can produce the same backup today and different ones tomorrow — the first follows the Cluster, the second does not.',
            'The object it creates is an ordinary Backup: `kubectl get backup <name> -o yaml` shows a spec with `cluster`, `method` and `online`, and anything reconciling from Git can read or recreate it.',
          ],
        },
        {
          id: 'snapshot-pitr',
          name: 'bootstrap.recovery.volumeSnapshots + recoveryTarget.targetTime (PITR from a snapshot)',
          summary:
            'The snapshot supplies the data directory and an externalClusters entry supplies the WAL, so recovery can stop at a chosen moment rather than at the instant the snapshot was taken.',
          usedIn: ['cnpg-snapshot-pitr'],
          examples: [
            {
              run: `sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr-hot.yaml.template > /root/pitr-hot.yaml
grep -A 2 recoveryTarget /root/pitr-hot.yaml
kubectl apply -f /root/pitr-hot.yaml
kubectl get pods | grep pitr`,
              out: `        targetTime: "2026-08-17 01:44:22.066635+00"
  externalClusters:
cluster.postgresql.cnpg.io/pg-hot-pitr created
pg-hot-pitr-1-snapshot-recovery-qvp7x   0/2     PodInitializing   0          12s`,
              note: 'The `…-snapshot-recovery-…` Pod is the recovery itself: it restores the snapshot into a new volume and replays WAL from the object store until it reaches the target.',
            },
            {
              run: `kubectl get pvc pg-hot-pitr-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
kubectl get pvc pg-cold-pitr-1 -o jsonpath='{.spec.dataSource}{"\\n"}'`,
              out: `{"apiGroup":"snapshot.storage.k8s.io","kind":"VolumeSnapshot","name":"hot-backup"}
{"apiGroup":"snapshot.storage.k8s.io","kind":"VolumeSnapshot","name":"cold-backup"}`,
              note: 'Where each recovered volume came from is recorded on the claim, not on the Cluster.',
            },
            {
              run: `for c in pg-cluster pg-hot-pitr pg-cold-pitr; do
  printf "%-14s " "$c"
  kubectl exec \${c}-1 -c postgres -- psql -U postgres -d app -tAc "SELECT string_agg(note, ',' ORDER BY id) FROM pitr_proof;"
done`,
              out: `pg-cluster     first,second
pg-hot-pitr    first
pg-cold-pitr   first`,
              note: 'One target time, two snapshots taken in different modes, the same answer: the row committed before the target survives and the one after it does not.',
            },
          ],
          notes: [
            'Take the target time from the database — `SELECT now()` — not from a node. They are different clocks, and recovery compares against the transaction log.',
            'Neither recovered row existed when the snapshots were taken; everything after the snapshot came out of the WAL archive. Without an `externalClusters` entry to fetch WAL from, a snapshot restore can only reach the instant it was taken.',
            'Backups on one cluster serialize: a second Backup applied immediately sits in `pending` until the first finishes.',
            'Recovery never overwrites its source — each recovered cluster is a new Cluster with its own name, Services and credentials, while the original keeps serving.',
          ],
        },
        {
          id: 'scheduled-snapshot',
          name: 'ScheduledBackup with method: volumeSnapshot (and spec.suspend)',
          summary:
            'A Backup with a clock attached. The same online/offline choice applies on every firing, and the status timestamps are what monitoring should watch.',
          usedIn: ['cnpg-scheduled-snapshots'],
          examples: [
            {
              run: `cat /root/scheduled-online.yaml
kubectl apply -f /root/scheduled-online.yaml
kubectl get scheduledbackup
kubectl get backup`,
              out: `apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: every-minute-online
  namespace: default
spec:
  schedule: "0 * * * * *"
  immediate: true
  backupOwnerReference: self
  cluster:
    name: pg-cluster
  method: volumeSnapshot
  online: true
scheduledbackup.postgresql.cnpg.io/every-minute-online created
NAME                  AGE   CLUSTER      LAST BACKUP
every-minute-online   25s   pg-cluster   25s
NAME                                 AGE   CLUSTER      METHOD           PHASE       ERROR
every-minute-online-20260817015843   25s   pg-cluster   volumeSnapshot   completed`,
              note: '`immediate: true` fired it at creation; the Backup is named after the schedule with a timestamp appended.',
            },
            {
              run: `kubectl get scheduledbackup every-minute-online -o jsonpath='{.status}{"\\n"}'`,
              out: '{"lastCheckTime":"2026-08-17T01:58:43Z","lastScheduleTime":"2026-08-17T01:58:43Z","nextScheduleTime":"2026-08-17T01:59:00Z"}',
              note: 'A schedule whose `lastScheduleTime` has stopped moving is a backup that has stopped happening, and nothing else in the cluster will say so.',
            },
            {
              run: `kubectl get backup -o custom-columns=NAME:.metadata.name,ONLINE:.spec.online,PHASE:.status.phase
for s in $(kubectl get volumesnapshot -o jsonpath='{.items[*].metadata.name}'); do
  printf "%-40s " "$s"
  kubectl get volumesnapshot $s -o jsonpath='{.metadata.annotations.cnpg\\.io/pgControldata}' | grep "Database cluster state"
done`,
              out: `NAME                                    ONLINE   PHASE
every-minute-online-20260817015843      true     completed
every-minute-online-20260817015900      true     completed
every-minute-online-20260817020000      true     completed
every-two-minutes-cold-20260817020000   false    completed
every-minute-online-20260817015843       Database cluster state:               in production
every-minute-online-20260817015900       Database cluster state:               in production
every-minute-online-20260817020000       Database cluster state:               in production
every-two-minutes-cold-20260817020000    Database cluster state:               shut down`,
              note: 'Each run records the state of the database inside the snapshot it takes, so the mode a schedule uses is verifiable after the fact.',
            },
            {
              run: `kubectl patch scheduledbackup every-minute-online --type=merge -p '{"spec":{"suspend":true}}'
kubectl get scheduledbackup -o custom-columns=NAME:.metadata.name,SUSPEND:.spec.suspend,LAST:.status.lastScheduleTime,NEXT:.status.nextScheduleTime`,
              out: `scheduledbackup.postgresql.cnpg.io/every-minute-online patched
NAME                     SUSPEND   LAST                   NEXT
every-minute-online      true      2026-08-17T02:02:00Z   2026-08-17T02:03:00Z
every-two-minutes-cold   true      2026-08-17T02:02:00Z   2026-08-17T02:04:00Z`,
              note: '`suspend` stops the clock without deleting the schedule or anything it has made — the right tool during an incident or a migration.',
            },
          ],
          notes: [
            'The schedule has six fields, seconds first: `"0 * * * * *"` is second zero of every minute.',
            'An `online: false` schedule fences the target instance on every single run. On a single-instance cluster that is a small outage of the database, repeated on a timer, with nobody asked again.',
            'The cold schedule in this lab had no `immediate`, so nothing happened until the clock reached second zero of an even minute.',
            'Schedules contend. With one firing every minute and another every second minute, both at second zero, an online run that lands while the cold one has the instance fenced fails: `while ensuring target pod is healthy: no status found for target pod pg-cluster-1 in cluster pg-cluster`. Stagger the seconds.',
          ],
        },
        {
          id: 'snapshot-owner-reference',
          name: 'spec.backup.volumeSnapshot.snapshotOwnerReference',
          summary:
            'Decides whether deleting a Backup takes its VolumeSnapshot with it. It defaults to none, which means nothing owns the snapshots and nothing removes them.',
          usedIn: ['cnpg-scheduled-snapshots'],
          examples: [
            {
              run: `kubectl get cluster pg-cluster -o jsonpath='{.spec.backup.volumeSnapshot.snapshotOwnerReference}{"\\n"}'
VICTIM=$(kubectl get backup --no-headers | grep every-minute-online | head -1 | awk '{print $1}')
kubectl get volumesnapshot $VICTIM -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}/{.name}{"\\n"}{end}'; echo "(no owner if blank)"
kubectl delete backup $VICTIM
kubectl get volumesnapshot | grep $VICTIM`,
              out: `none
(no owner if blank)
backup.postgresql.cnpg.io "every-minute-online-20260817015843" deleted from default namespace
every-minute-online-20260817015843   true    pg-cluster-1   1Gi   csi-hostpath-snapclass   snapcontent-c9bf0967-9793-4e3e-a766-b5dc79bb5c7b   36s   36s`,
              note: 'The Backup is gone and its snapshot is still there, with no owner and now nothing pointing at it. Columns elided from the snapshot listing.',
            },
            {
              run: `kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"backup":{"volumeSnapshot":{"snapshotOwnerReference":"backup"}}}}'
kubectl apply -f /tmp/owned-backup.yaml
kubectl get volumesnapshot owned-backup -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}/{.name}{"\\n"}{end}'
kubectl delete backup owned-backup
kubectl get volumesnapshot --no-headers | grep -c owned-backup`,
              out: `cluster.postgresql.cnpg.io/pg-cluster patched
backup.postgresql.cnpg.io/owned-backup created
Backup/owned-backup
backup.postgresql.cnpg.io "owned-backup" deleted from default namespace
0`,
              note: 'With the field set to `backup`, the next snapshot carries an ownerReference and disappears with its Backup through ordinary Kubernetes garbage collection.',
            },
          ],
          notes: [
            'The setting applies to snapshots taken *after* it is changed. Snapshots already on disk keep whatever ownership they were created with.',
            'Nothing prunes VolumeSnapshots. Retention policies belong to Barman and apply to what Barman writes to an object store; a snapshot is a Kubernetes object created by the CSI driver, and CloudNativePG does not delete them.',
            'The third value is `cluster`, which ties a snapshot’s life to the Cluster rather than to its Backup.',
          ],
        },
        {
          id: 'tablespace-recovery',
          name: 'Recovering a cluster that has tablespaces (object storage)',
          summary:
            'The backup contains the tablespaces; the recovery manifest has to declare them, or the restore job has nowhere to unpack them and retries forever.',
          usedIn: ['cnpg-tablespace-backup'],
          examples: [
            {
              run: `kubectl get backup first-backup -o jsonpath='{.status.beginWal}{"\\n"}'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT pg_walfile_name(pg_current_wal_lsn());"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT pg_walfile_name(pg_current_wal_lsn());"`,
              out: `000000010000000000000008
000000010000000000000008
 pg_switch_wal
---------------
 0/8000EF8
(1 row)

000000010000000000000009`,
              note: 'Before the switch the primary was still writing the segment the backup begins in, so the archive did not have it. Recovery needs that whole segment.',
            },
            {
              run: `kubectl apply -f /root/restore-without-tablespaces.yaml
kubectl get cluster pg-forgot --no-headers
kubectl get pods | grep forgot`,
              out: `cluster.postgresql.cnpg.io/pg-forgot created
pg-forgot   80s   1     Setting up primary
pg-forgot-1-full-recovery-6wzm6   0/2   Init:1/2   0   1s
pg-forgot-1-full-recovery-8v4l9   0/2   Error      0   45s
pg-forgot-1-full-recovery-kgbrd   0/2   Error      0   69s`,
              note: 'Stuck at Setting up primary indefinitely, with Job Pods failing and being replaced. The Cluster’s own status never says why.',
            },
            {
              run: `P=$(kubectl get pods --no-headers | grep "forgot.*full-recovery" | grep Error | head -1 | awk '{print $1}')
kubectl logs $P --all-containers 2>&1 | grep -i tablespace | tail -1`,
              out: `{"level":"info","logger":"barman-cloud-restore","msg":"ERROR: Barman cloud restore exception: [Errno 30] Read-only file system: '/var/lib/postgresql/tablespaces'","pipe":"stderr","logging_pod":"pg-forgot-1-full-recovery"}`,
              note: 'The path exists in the image but has no volume mounted over it, on a container whose root filesystem is read-only. Timestamps elided.',
            },
            {
              run: `diff /root/restore-without-tablespaces.yaml /root/restore-with-tablespaces.yaml
kubectl apply -f /root/restore-with-tablespaces.yaml
kubectl get cluster pg-restored --no-headers
kubectl get pvc | grep restored
kubectl exec pg-restored-1 -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM quarterly;"`,
              out: `cluster.postgresql.cnpg.io/pg-restored created
pg-restored   40s   1   1   Cluster in healthy state   pg-restored-1
pg-restored-1                 Bound   1Gi   RWO   local-path   98s
pg-restored-1-tbs-reporting   Bound   1Gi   RWO   local-path   98s
 count
-------
   500
(1 row)`,
              note: 'One tablespaces block is the whole difference. The recovered cluster is a single instance recovering a three-instance backup, so it needs one volume per tablespace. diff output and PVC columns elided.',
            },
          ],
          notes: [
            'The tablespace *names* in the recovery manifest must match the backup; the size, storage class and instance count are yours to choose.',
            'Nothing checks the match until the restore job opens the backup — there is no admission-time validation for it.',
            'A plugin backup targets a standby by default: `status.instanceID.podName` named pg-cluster-2 and the backup label read `BACKUP FROM: standby`.',
          ],
        },
        {
          id: 'tablespace-snapshot-recovery',
          name: 'volumeSnapshots.tablespaceStorage (snapshot recovery with tablespaces)',
          summary:
            'A snapshot backup of a cluster with tablespaces is one snapshot per volume, and recovery is a map from tablespace name to snapshot that you write by hand.',
          usedIn: ['cnpg-tablespace-snapshot'],
          examples: [
            {
              run: `kubectl apply -f /root/snapshot-backup.yaml
kubectl get volumesnapshot -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName,TABLESPACE:'.metadata.labels.cnpg\\.io/tablespaceName'`,
              out: `backup.postgresql.cnpg.io/daily-snapshot created
NAME                           READY   SOURCE                       TABLESPACE
daily-snapshot                 true    pg-cluster-1                 <none>
daily-snapshot-tbs-reporting   true    pg-cluster-1-tbs-reporting   reporting`,
              note: 'Two volumes, two snapshots. The data volume takes the Backup’s name; each tablespace gets `-tbs-<tablespace>` appended and a label naming it.',
            },
            {
              run: `sed "s/DATA_SNAPSHOT/daily-snapshot/" /root/restore-half.yaml.template > /root/restore-half.yaml
kubectl apply -f /root/restore-half.yaml
kubectl get cluster pg-half --no-headers
kubectl get pvc | grep half
kubectl get pods | grep half`,
              out: `cluster.postgresql.cnpg.io/pg-half created
pg-half   71s   1
pg-half-1   Pending   csi-hostpath-sc   69s`,
              note: 'With the tablespace unmapped: an empty phase, one Pending claim, no tablespace claim, and no Pod at all. `kubectl get pods` printed nothing.',
            },
            {
              run: `kubectl -n cnpg-system logs deploy/cnpg-controller-manager --since=5m | grep -o "cannot create primary instance PVCs: [^\\"]*" | tail -1`,
              out: 'cannot create primary instance PVCs: missing StorageSource for tablespace reporting PVC',
              note: 'The only place the reason exists. kubectl describe shows nothing, the events are about ServiceAccounts, and the conditions claim the cluster has been bootstrapped.',
            },
            {
              run: `sed -e "s/DATA_SNAPSHOT/daily-snapshot/" -e "s/REPORTING_SNAPSHOT/daily-snapshot-tbs-reporting/" /root/restore.yaml.template > /root/restore.yaml
kubectl apply -f /root/restore.yaml
kubectl get cluster pg-restored --no-headers
kubectl get pvc pg-restored-1 -o jsonpath='{.spec.dataSource}{"\\n"}'
kubectl get pvc pg-restored-1-tbs-reporting -o jsonpath='{.spec.dataSource}{"\\n"}'`,
              out: `cluster.postgresql.cnpg.io/pg-restored created
pg-restored   36s   1   1   Cluster in healthy state   pg-restored-1
{"apiGroup":"snapshot.storage.k8s.io","kind":"VolumeSnapshot","name":"daily-snapshot"}
{"apiGroup":"snapshot.storage.k8s.io","kind":"VolumeSnapshot","name":"daily-snapshot-tbs-reporting"}`,
              note: 'Each claim records the snapshot it was built from — the artefact that proves the mapping was what you meant.',
            },
          ],
          notes: [
            'Do not put `-tbs-` in the name of a cluster that has tablespaces. A tablespace claim is `<instance>-tbs-<tablespace>`, and a cluster called pg-tbs-restored had its own data claim read as a tablespace’s: the data restored correctly, both claims bound, and the instance then rolled every twenty seconds forever with "original and target PodSpec differ in volumes: element tbs-pgdata has been removed". Renaming the cluster was the whole fix.',
            'Both the data volume and the tablespace volumes have to be on a snapshot-capable StorageClass, or the backup has a hole in it.',
            'An online snapshot restored cleanly here with no WAL archive configured — the tablespace mapping, not the backup mode, is what this recovery turns on.',
          ],
        },
      ],
    },

    {
      id: 'operator-runtime',
      title: 'The operator itself',
      blurb:
        'What an installed operator consists of, how it is configured, and what stops working when it is not running.',
      commands: [
        {
          id: 'operator-inventory',
          name: 'kubectl -n cnpg-system get all',
          summary:
            'The operator\'s entire runtime footprint: a single-replica Deployment and a Service on port 443 for its admission webhooks. One process watches every namespace, which is why its RBAC is cluster-scoped.',
          usedIn: ['cnpg-operator-deployment'],
          examples: [
            {
              run: `kubectl -n cnpg-system get all
kubectl -n cnpg-system get endpointslices -l kubernetes.io/service-name=cnpg-webhook-service`,
              out: `NAME                                           READY   STATUS    RESTARTS   AGE
pod/cnpg-controller-manager-695fcbbb85-lfprr   1/1     Running   0          2m44s

NAME                           TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)   AGE
service/cnpg-webhook-service   ClusterIP   10.43.10.186   <none>        443/TCP   2m44s

NAME                                      READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/cnpg-controller-manager   1/1     1            1           2m45s
NAME                         ADDRESSTYPE   PORTS   ENDPOINTS   AGE
cnpg-webhook-service-bfvd5   IPv4          9443    10.42.1.2   2m45s`,
            },
            {
              run: `kubectl get clusterrolebinding cnpg-manager-rolebinding -o jsonpath='{.subjects}{"\\n"}'`,
              out: '[{"kind":"ServiceAccount","name":"cnpg-manager","namespace":"cnpg-system"}]',
            },
          ],
          notes: [
            'A second Deployment appears in this namespace when the Barman Cloud plugin is installed; the operator itself is only ever the one.',
          ],
        },
        {
          id: 'webhook-configs',
          name: 'kubectl get validatingwebhookconfiguration / mutatingwebhookconfiguration',
          summary:
            'Every Cluster, Backup, ScheduledBackup, Pooler and Database is intercepted before it is stored — mutating first to apply defaults, validating second to accept or reject.',
          usedIn: ['cnpg-operator-deployment'],
          examples: [
            {
              run: 'kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration | grep cnpg',
              out: `validatingwebhookconfiguration.admissionregistration.k8s.io/cnpg-validating-webhook-configuration   5          16m
mutatingwebhookconfiguration.admissionregistration.k8s.io/cnpg-mutating-webhook-configuration   4          16m`,
              note: 'Five validating webhooks and four mutating ones — cluster-scoped objects, not part of the operator namespace.',
            },
            {
              run: `kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{range .webhooks[*]}{.name}{"  ->  "}{.rules[0].resources}{"\\n"}{end}'
kubectl get validatingwebhookconfiguration cnpg-validating-webhook-configuration -o jsonpath='{.webhooks[0].failurePolicy}{"\\n"}'`,
              out: `vbackup.cnpg.io  ->  ["backups"]
vcluster.cnpg.io  ->  ["clusters"]
vdatabase.cnpg.io  ->  ["databases"]
vpooler.cnpg.io  ->  ["poolers"]
vscheduledbackup.cnpg.io  ->  ["scheduledbackups"]
Fail`,
            },
            {
              run: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=0
sed "s/name: pg-cluster/name: pg-cluster-two/" /root/cluster.yaml | kubectl apply -f - --dry-run=server`,
              out: `deployment.apps/cnpg-controller-manager scaled
Error from server (InternalError): error when creating "STDIN": Internal error occurred: failed calling webhook "mcluster.cnpg.io": failed to call webhook: Post "https://cnpg-webhook-service.cnpg-system.svc:443/mutate-postgresql-cnpg-io-v1-cluster?timeout=10s": no endpoints available for service "cnpg-webhook-service"`,
              note: '`failurePolicy: Fail` in action. It has to be a *new* name — re-applying an unchanged object never reaches admission and appears to succeed.',
            },
          ],
          notes: [
            'This is the mechanism behind the error people meet when they install the operator and apply a Cluster immediately: wait for the operator Pod, not for the CRDs.',
          ],
        },
        {
          id: 'operator-configmap',
          name: 'Configuring the operator (cnpg-controller-manager-config)',
          summary:
            'Operator-wide settings live in one ConfigMap in its namespace, named on its command line. It is read **at startup only**, so a change without a restart silently does nothing.',
          usedIn: ['cnpg-operator-configmap'],
          examples: [
            {
              run: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].args}{"\\n"}'`,
              out: '["controller","--leader-elect","--max-concurrent-reconciles=10","--config-map-name=cnpg-controller-manager-config","--secret-name=cnpg-controller-manager-config","--webhook-port=9443"]',
              note: 'A default installation points at a ConfigMap that does not exist — which is simply how it runs with defaults.',
            },
            {
              run: `kubectl -n cnpg-system create configmap cnpg-controller-manager-config --from-literal=INHERITED_LABELS="team,environment"
kubectl label cluster.postgresql.cnpg.io pg-cluster team=payments --overwrite
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team`,
              out: `configmap/cnpg-controller-manager-config created
cluster.postgresql.cnpg.io/pg-cluster labeled
NAME           READY   STATUS    RESTARTS   AGE     TEAM
pg-cluster-1   1/1     Running   0          2m20s
pg-cluster-2   1/1     Running   0          100s
pg-cluster-3   1/1     Running   0          50s`,
              note: 'The TEAM column is empty: the ConfigMap exists and is correct, and the operator has not read it.',
            },
            {
              run: `kubectl -n cnpg-system rollout restart deploy cnpg-controller-manager
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl get pods -l cnpg.io/cluster=pg-cluster -L team,environment
kubectl get pvc -L team,environment`,
              out: `deployment "cnpg-controller-manager" successfully rolled out
NAME           READY   STATUS    RESTARTS   AGE     TEAM       ENVIRONMENT
pg-cluster-1   1/1     Running   0          3m13s   payments   lab
pg-cluster-2   1/1     Running   0          2m33s   payments   lab
pg-cluster-3   1/1     Running   0          103s    payments   lab
NAME           STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE     TEAM       ENVIRONMENT
pg-cluster-1   Bound    pvc-53a899ae-22c2-43d1-8d6f-eea52b4974f9   1Gi        RWO            local-path     3m48s   payments   lab`,
              note: 'Applied by reconciliation — nothing was recreated, and the instance ages and restart counts are unchanged. PVC listing elided to one row.',
            },
          ],
          notes: [
            'Restarting the operator does not restart or disturb any PostgreSQL instance: it is not on the data path.',
          ],
        },
        {
          id: 'operator-eviction',
          name: 'kubectl create --raw …/pods/<pod>/eviction',
          summary:
            'Eviction is a request the API server can refuse, and it is what `kubectl drain` issues for every Pod on a node. There is no `kubectl evict`, so it goes to the subresource directly.',
          usedIn: ['cnpg-operator-eviction'],
          examples: [
            {
              run: `POD=$(kubectl -n cnpg-system get pods -l app.kubernetes.io/name=cloudnative-pg -o jsonpath='{.items[0].metadata.name}')
cat > /tmp/evict.json <<EOF
{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"$POD","namespace":"cnpg-system"}}
EOF
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json`,
              out: '{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success","code":201}',
              note: 'Permitted, because no PodDisruptionBudget covers the Pod.',
            },
            {
              run: `kubectl -n cnpg-system get pdb
kubectl create --raw /api/v1/namespaces/cnpg-system/pods/$POD/eviction -f /tmp/evict.json`,
              out: `NAME                MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
cnpg-operator-pdb   1               N/A               0                     0s
Error from server (TooManyRequests): Cannot evict pod as it would violate the pod's disruption budget.`,
              note: '`minAvailable: 1` over a single replica permits zero disruptions — the trap that hangs a node drain indefinitely.',
            },
            {
              run: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=2
kubectl -n cnpg-system get pdb`,
              out: `deployment.apps/cnpg-controller-manager scaled
NAME                MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
cnpg-operator-pdb   1               N/A               1                     18s`,
              note: 'The fix is to give the budget something to spare, not to delete the budget.',
            },
          ],
          notes: [
            'Deletion ignores PodDisruptionBudgets entirely, which is exactly why drains use eviction.',
          ],
        },
        {
          id: 'operator-upgrade',
          name: 'kubectl apply --server-side (operator upgrade)',
          summary:
            'Upgrading CloudNativePG is applying the newer release manifest over the older one — the same command that installs. A minor release usually brings new CRDs with it.',
          usedIn: ['cnpg-operator-upgrade'],
          examples: [
            {
              run: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl get crd | grep -c postgresql.cnpg.io
kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl get crd | grep -c postgresql.cnpg.io`,
              out: `ghcr.io/cloudnative-pg/cloudnative-pg:1.29.2
10
deployment "cnpg-controller-manager" successfully rolled out
ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0
11`,
              note: 'Apply output elided. The eleventh CRD is failoverquorums.postgresql.cnpg.io, a 1.30 feature whose API has to exist before anything can use it.',
            },
            {
              run: 'kubectl get pods -l cnpg.io/cluster=pg-cluster',
              out: `NAME           READY   STATUS    RESTARTS   AGE
pg-cluster-1   1/1     Running   0          2m29s
pg-cluster-2   1/1     Running   0          109s
pg-cluster-3   1/1     Running   0          67s`,
              note: 'Taken after the upgrade: ages that predate it and restart counts still at 0 — a minor operator upgrade does not roll the databases.',
            },
          ],
          notes: [
            'Read the running image from the Deployment rather than assuming it from the manifest that was applied.',
          ],
        },
        {
          id: 'in-place-instance-manager',
          name: 'ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES',
          summary:
            'A binary from the operator image — the instance manager — runs as PID 1 in every postgres container. This setting lets the operator replace it inside a running Pod instead of replacing the Pod.',
          usedIn: ['cnpg-in-place-upgrade'],
          examples: [
            {
              run: `kubectl get pod pg-cluster-1 -o jsonpath='{.spec.containers[0].command}{"\\n"}'
kubectl exec pg-cluster-1 -c postgres -- ps -o pid,args -p 1
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount`,
              out: `["/controller/manager","instance","run","--status-port-tls","--log-level=info"]
    PID COMMAND
      1 /controller/manager instance run --status-port-tls --log-level=info
NAME           VERSION   CREATED                RESTARTS
pg-cluster-1   1.29.2    2026-08-16T18:07:18Z   0
pg-cluster-2   1.29.2    2026-08-16T18:07:58Z   0
pg-cluster-3   1.29.2    2026-08-16T18:08:38Z   0`,
              note: 'PostgreSQL is a child of the instance manager, not the other way round. `cnpg.io/operatorVersion` is which version of the operator is running inside that Pod — a second version number beside the controller\'s.',
            },
            {
              run: `kubectl -n cnpg-system create configmap cnpg-controller-manager-config \\
  --from-literal=ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true
kubectl -n cnpg-system rollout restart deploy cnpg-controller-manager
kubectl -n cnpg-system logs deploy/cnpg-controller-manager | grep "Operator configuration loaded" | tail -1`,
              out: `configmap/cnpg-controller-manager-config created
deployment.apps/cnpg-controller-manager restarted
{"level":"info","ts":"2026-08-16T17:21:54.515629546Z","logger":"setup","msg":"Operator configuration loaded","configuration":{"webhookCertDir":"","metricsCertDir":"","pluginSocketDir":"/plugins","watchNamespace":"","operatorNamespace":"cnpg-system","operatorPullSecretName":"cnpg-pull-secret","operatorImageName":"ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0","postgresImageName":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie","pgbouncerImageName":"ghcr.io/cloudnative-pg/pgbouncer:1.25.1","inheritedAnnotations":null,"inheritedLabels":null,"monitoringQueriesConfigmap":"cnpg-default-monitoring","monitoringQueriesSecret":"","enableInstanceManagerInplaceUpdates":true,"certificateDuration":90,"expiringCheckThreshold":7,"createAnyService":false,"clustersRolloutDelay":0,"instancesRolloutDelay":0,"includePlugins":"","standbyTcpUserTimeout":null,"kubernetesClusterDomain":"cluster.local","enableWebhookNamespaceSuffix":false,"drainTaints":["node.kubernetes.io/unschedulable","ToBeDeletedByClusterAutoscaler","karpenter.sh/disrupted","karpenter.sh/disruption"],"manageWebhookConfigurations":true}}`,
              note: 'The whole loaded configuration is logged at startup, which is the only reliable way to confirm the setting took: `enableInstanceManagerInplaceUpdates` must read true. The key is INPLACE, one word — spelling it IN_PLACE is silently ignored and this line reads false.',
            },
            {
              run: `kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now() - pg_postmaster_start_time() AS uptime;"`,
              out: `deployment "cnpg-controller-manager" successfully rolled out
NAME           VERSION   CREATED                RESTARTS
pg-cluster-1   1.30.0    2026-08-16T18:07:18Z   0
pg-cluster-2   1.30.0    2026-08-16T18:07:58Z   0
pg-cluster-3   1.30.0    2026-08-16T18:08:38Z   0
00:04:00.320662`,
              note: 'The apply\'s own output is elided. The version moves within about ten seconds while every creation timestamp stays where it was and PostgreSQL\'s uptime spans the upgrade — the binary was replaced inside containers that were never restarted.',
            },
          ],
          notes: [
            'Without this setting the instance manager can only be changed by replacing the Pod, so an operator upgrade rolls every instance of every cluster it manages.',
            'The operator reads its ConfigMap only at startup, so the setting does nothing until the operator has been restarted — and an unrecognised key in that ConfigMap produces no error, no warning and no event.',
            'The trade is real: an in-place update swaps a running agent\'s binary underneath itself. That is why the conservative behaviour is the default and this is opt-in.',
          ],
        },
        {
          id: 'operator-leader-election',
          name: 'kubectl -n cnpg-system get lease (leader election)',
          summary:
            'The operator runs with --leader-elect and takes a Lease even as a single replica. Scale it out and only the Lease holder reconciles; the others wait.',
          usedIn: ['cnpg-operator-ha', 'cnpg-operator-pod-deletion'],
          examples: [
            {
              run: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=3
kubectl -n cnpg-system get pods -o wide
kubectl -n cnpg-system get lease -o jsonpath='{range .items[*]}{.metadata.name}{" -> "}{.spec.holderIdentity}{"\\n"}{end}'`,
              out: `cnpg-controller-manager-695fcbbb85-4fbgm   1/1     Running   0   7s      10.42.3.5   k3d-dbol-575690557321-agent-0
cnpg-controller-manager-695fcbbb85-gfhmc   1/1     Running   0   7s      10.42.0.9   k3d-dbol-575690557321-server-0
cnpg-controller-manager-695fcbbb85-l8gfb   1/1     Running   0   3m27s   10.42.1.3   k3d-dbol-575690557321-agent-1
db9c8771.cnpg.io -> cnpg-controller-manager-695fcbbb85-l8gfb_eb865372-d044-4e21-bc11-3a41bc54abad`,
              note: 'Three replicas on three nodes, one holder. The suffix after the underscore identifies the process, so a restarted Pod of the same name is a new holder.',
            },
            {
              run: `LEADER=$(cat /root/leader.txt)
START=$(date +%s)
kubectl -n cnpg-system delete pod $LEADER --wait=false
while true; do
  H=$(kubectl -n cnpg-system get lease -o jsonpath='{.items[0].spec.holderIdentity}' 2>/dev/null | cut -d_ -f1)
  if [ -n "$H" ] && [ "$H" != "$LEADER" ]; then echo "new leader: $H"; break; fi
  sleep 2
done
echo $(( $(date +%s) - START ))`,
              out: `new leader: cnpg-controller-manager-695fcbbb85-gfhmc
2`,
              note: 'Two seconds: a clean shutdown releases the Lease rather than letting it expire. The non-empty guard matters — the field is briefly blank mid-handover.',
            },
            {
              run: 'kubectl -n cnpg-system logs $FOLLOWER --tail=1',
              out: '{"level":"info","ts":"2026-08-15T15:11:14.295329099Z","msg":"Attempting to acquire leader lease...","lock":"cnpg-system/db9c8771.cnpg.io"}',
              note: 'What a non-leader is doing: waiting, and nothing else.',
            },
          ],
        },
        {
          id: 'operator-outage',
          name: 'kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=0',
          summary:
            'With no operator running the database keeps serving and nothing gets repaired — and the Cluster status stops being true, because a status is a report written by a controller.',
          usedIn: ['cnpg-operator-pod-deletion'],
          examples: [
            {
              run: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=0
kubectl delete pod pg-cluster-3 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster`,
              out: `deployment.apps/cnpg-controller-manager scaled
pod "pg-cluster-3" deleted from default namespace
NAME           READY   STATUS    RESTARTS   AGE
pg-cluster-1   1/1     Running   0          3m35s
pg-cluster-2   1/1     Running   0          2m49s
NAME         AGE    INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   4m6s   3           3       Cluster in healthy state   pg-cluster-1`,
              note: 'Two Pods, and a status still claiming three ready — frozen at the operator\'s last word on the subject.',
            },
            {
              run: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=1
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl get pods -l cnpg.io/cluster=pg-cluster`,
              out: `deployment "cnpg-controller-manager" successfully rolled out
NAME           READY   STATUS    RESTARTS   AGE
pg-cluster-1   1/1     Running   0          4m42s
pg-cluster-2   1/1     Running   0          3m56s
pg-cluster-3   1/1     Running   0          61s`,
              note: 'Recreated within seconds of the operator returning, reattached to the claim that was never deleted.',
            },
          ],
          notes: [
            'The leader-election Lease in `cnpg-system` names the Pod holding it; deleting the operator Pod changes the holder identity, which is the handover made visible.',
            'An operator outage costs repair, not availability.',
          ],
        },
      ],
    },

    {
      id: 'failover',
      title: 'Failover, switchover and timing',
      blurb: 'Breaking the primary on purpose, handing the role over deliberately, and measuring how fast the endpoint follows.',
      commands: [
        {
          id: 'delete-primary',
          name: 'kubectl delete pod <primary> --grace-period=0 --force',
          summary:
            'Destroys the primary the way a node failure would — no cordon, no drain, no graceful shutdown. Nothing about it asks for a failover; the operator notices and promotes a replica on its own.',
          usedIn: ['cnpg-failover', 'cnpg-persistent-volume', 'cnpg-failover-endpoint-time'],
          examples: [
            {
              run: 'kubectl delete pod pg-cluster-1 --grace-period=0 --force',
              out: `Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.
pod "pg-cluster-1" force deleted from default namespace`,
            },
            {
              run: 'kubectl get cluster.postgresql.cnpg.io pg-cluster',
              out: `NAME         AGE     INSTANCES   READY   STATUS                                       PRIMARY
pg-cluster   3m13s   3           2       Waiting for the instances to become active   pg-cluster-2`,
              note: 'Seconds later: a replica has already been promoted, and the destroyed instance is being recreated.',
            },
          ],
          notes: [
            'The recreated instance rejoins as a **replica**; the promoted one keeps the role.',
            'Use `--wait=false` instead when timing a failover — the default blocks until the Pod is gone, which is after the interesting part has begun.',
          ],
        },
        {
          id: 'cnpg-promote',
          name: 'kubectl cnpg promote <cluster> <instance>',
          summary:
            'Performs a planned switchover: the current primary is shut down cleanly first, then the named instance is promoted. Returns immediately — the work is the operator\'s.',
          usedIn: ['cnpg-switchover', 'cnpg-switchover-endpoint-time'],
          examples: [
            {
              run: 'kubectl cnpg promote pg-cluster pg-cluster-2',
              out: 'Node pg-cluster-2 in cluster pg-cluster will be promoted',
            },
            {
              run: `OLD=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
kubectl cnpg promote pg-cluster pg-cluster-2
START=$(date +%s)
while true; do
  IP=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
  [ -n "$IP" ] && [ "$IP" != "$OLD" ] && break
  sleep 1
done
echo $(( $(date +%s) - START ))
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.targetPrimaryTimestamp}{"\\n"}{.status.currentPrimaryTimestamp}{"\\n"}'`,
              out: `Node pg-cluster-2 in cluster pg-cluster will be promoted
7
2026-08-15T08:41:47.292348Z
2026-08-15T08:41:49.838839Z`,
              note: "Seven seconds from the request to the write endpoint naming the new instance, of which 2.5 were the promotion itself — the rest is the old primary shutting down cleanly, which is why a switchover's budget (20s) is looser than a failover's (10s).",
            },
            {
              run: 'kubectl get pods -L cnpg.io/instanceRole -o wide',
              out: `NAME           READY   STATUS    RESTARTS      AGE     IP          NODE                             NOMINATED NODE   READINESS GATES   INSTANCEROLE
pg-cluster-1   1/1     Running   1 (44s ago)   2m53s   10.42.2.5   k3d-dbol-2be935a07b40-agent-0    <none>           <none>            replica
pg-cluster-2   1/1     Running   0             2m9s    10.42.0.6   k3d-dbol-2be935a07b40-server-0   <none>           <none>            primary
pg-cluster-3   1/1     Running   0             91s     10.42.4.6   k3d-dbol-2be935a07b40-agent-1    <none>           <none>            replica`,
              note: 'The demoted instance shows one restart and keeps its own volume — it was demoted, not re-cloned.',
            },
          ],
          notes: [
            'Argument order is cluster first, then instance.',
            'Underneath, the plugin sets the cluster\'s target primary and the operator reconciles to match — which is why the cluster reports "Switchover in progress" while it happens.',
          ],
        },
        {
          id: 'cnpg-status',
          name: 'kubectl cnpg status <cluster>',
          summary:
            'The whole cluster in one screen: primary, promotion time, phase, write LSN and timeline, per-replica replication lag, and each instance\'s role and node.',
          usedIn: ['cnpg-switchover'],
          examples: [
            {
              run: 'kubectl cnpg status pg-cluster',
              out: `Cluster Summary
Name                     default/pg-cluster
System ID:               7674144727686922264
PostgreSQL Image:        ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie
Primary instance:        pg-cluster-1
Primary promotion time:  2026-08-15 06:41:04 +0000 UTC (1m55s)
Status:                  Cluster in healthy state
Instances:               3
Ready instances:         3
Size:                    128M
Current Write LSN:       0/6000060 (Timeline: 1 - WAL File: 000000010000000000000006)

Continuous Backup not configured

Streaming Replication status
Replication Slots Enabled
Name          Sent LSN   Write LSN  Flush LSN  Replay LSN  Write Lag  Flush Lag  Replay Lag  State      Sync State  Sync Priority  Replication Slot
----          --------   ---------  ---------  ----------  ---------  ---------  ----------  -----      ----------  -------------  ----------------
pg-cluster-2  0/6000060  0/6000060  0/6000060  0/6000060   00:00:00   00:00:00   00:00:00    streaming  async       0              active
pg-cluster-3  0/6000060  0/6000060  0/6000060  0/6000060   00:00:00   00:00:00   00:00:00    streaming  async       0              active`,
              note: 'Truncated before the per-instance section that follows.',
            },
          ],
          notes: [
            'Matching LSNs across all four columns with zero lag is what "safe to hand over" looks like before a switchover.',
          ],
        },
        {
          id: 'promotion-timestamps',
          name: 'kubectl get cluster … targetPrimaryTimestamp / currentPrimaryTimestamp',
          summary:
            "The operator's own stopwatch: when it decided there should be a new primary, and when that instance actually became one. The gap between them is the promotion, measured by the cluster rather than by a human.",
          usedIn: ['cnpg-failover-endpoint-time'],
          examples: [
            {
              run: `kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.targetPrimaryTimestamp}{"\\n"}{.status.currentPrimaryTimestamp}{"\\n"}'`,
              out: `2026-08-15T06:48:52.845202Z
2026-08-15T06:48:53.383453Z`,
              note: 'A real unplanned failover: 0.5 seconds between the decision and the promotion.',
            },
          ],
          notes: [
            'These are also non-zero after the initial bootstrap, where the gap is the minutes instance 1 took to come up — so a low value alone does not prove a failover happened, only that the last promotion was fast.',
          ],
        },
        {
          id: 'cnpg-fencing',
          name: 'kubectl cnpg fencing on|off <cluster> <instance>',
          summary:
            'Stops PostgreSQL inside an instance Pod while leaving the Pod running. The instance manager stays up; the database does not. Unfencing starts it again against whatever is on disk.',
          usedIn: ['cnpg-corrupted-pvc'],
          examples: [
            {
              run: `kubectl cnpg fencing on pg-cluster pg-cluster-3
kubectl exec pg-cluster-3 -c postgres -- ps ax`,
              out: `pg-cluster-3 fenced
    PID TTY      STAT   TIME COMMAND
      1 ?        Ssl    0:00 /controller/manager instance run --status-port-tls --log-level=info
    170 ?        Rs     0:00 ps ax`,
              note: 'Only the instance manager is left — no postmaster, no backends.',
            },
            {
              run: 'kubectl cnpg fencing off pg-cluster pg-cluster-3',
              out: 'pg-cluster-3 unfenced',
            },
          ],
          notes: [
            'This is the only reliable way to touch an instance\'s files: a running PostgreSQL rewrites its control file on a clean shutdown, so changes made under a live instance are undone when its Pod restarts.',
            'The underlying mechanism is a `cnpg.io/fencedInstances` annotation on the Cluster, which the plugin sets for you.',
          ],
        },
        {
          id: 'corrupt-control-file',
          name: 'dd if=/dev/urandom of=<pgdata>/global/pg_control …',
          summary:
            "Overwrites the 8 KB file recording the state of the whole database cluster. PostgreSQL reads it before opening anything, verifies its CRC, and refuses to start when it does not match.",
          usedIn: ['cnpg-corrupted-pvc'],
          examples: [
            {
              run: 'dd if=/dev/urandom of=$(cat /root/pgdata-path.txt)/global/pg_control bs=8192 count=1 conv=notrunc',
              out: `1+0 records in
1+0 records out
8192 bytes (8.2 kB, 8.0 KiB) copied, 3.1042e-05 s, 264 MB/s`,
            },
            {
              run: 'kubectl logs pg-cluster-3 --tail=200 | grep -iE "pg_control|CRC|FATAL"',
              out: `pg_controldata: warning: calculated CRC checksum does not match value stored in control file
FATAL:  database files are incompatible with server`,
              note: 'The Pod stays Running at 0/1 and the Cluster reports 2 of 3 ready; a plain Pod restart reproduces the same failure and ends in CrashLoopBackOff.',
            },
          ],
          notes: [
            '`conv=notrunc` keeps the file its original size — the damage is to the contents, which is what corruption looks like in practice.',
            'Fence the instance first, or a clean shutdown will rewrite the file and undo it.',
          ],
        },
        {
          id: 'data-page-corruption',
          name: 'pg_checksums --check + pg_stat_database.checksum_failures',
          summary:
            'Finding damage inside a table rather than in the files that stop a server from starting. A bad page is refused at read time, counted in the statistics, and invisible to everything else in the stack.',
          usedIn: ['cnpg-data-corruption'],
          examples: [
            {
              run: `kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT name, setting FROM pg_settings WHERE name IN ('data_checksums','ignore_checksum_failure');"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -tAc "SELECT pg_relation_filepath('ledger');"`,
              out: `          name           | setting
-------------------------+---------
 data_checksums          | on
 ignore_checksum_failure | off
(2 rows)

base/16385/16390`,
              note: '`data_checksums` is decided at initdb and cannot be changed on a running database. `pg_relation_filepath` must be run inside the database holding the table, and returns a path relative to the data directory.',
            },
            {
              run: `# with the instance stopped (kubectl cnpg fencing on), after 256 bytes were overwritten in page 3
kubectl exec pg-cluster-1 -c postgres -- pg_checksums --check -D /var/lib/postgresql/data/pgdata`,
              out: `pg_checksums: error: checksum verification failed in file "/var/lib/postgresql/data/pgdata/base/16385/16390", block 3: calculated checksum C058 but block contains BDD5
Checksum operation completed
Files scanned:   1254
Blocks scanned:  3943
Bad checksums:  1
Data checksum version: 1`,
              note: 'The only tool here that goes looking for damage rather than waiting to trip over it. It refuses to run against a live server, so the instance has to be stopped — fencing does that without destroying the Pod.',
            },
            {
              run: `kubectl get cluster pg-cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM ledger;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT datname, checksum_failures, checksum_last_failure FROM pg_stat_database WHERE datname='app';"
for i in 1 2 3; do kubectl exec pg-cluster-$i -c postgres -- psql -U postgres -d app -tAc "SELECT count(*) FROM ledger;" 2>&1 | head -1; done`,
              out: `NAME         AGE    INSTANCES   READY   STATUS                     PRIMARY
pg-cluster   4m4s   3           3       Cluster in healthy state   pg-cluster-1
ERROR:  invalid page in block 3 of relation "base/16385/16390"
 datname | checksum_failures |     checksum_last_failure
---------+-------------------+-------------------------------
 app     |                 2 | 2026-08-16 20:05:51.395672+00
ERROR:  invalid page in block 3 of relation "base/16385/16390"
2000
2000`,
              note: 'Everything says healthy and one query is an error. The counter is a count of failed *reads*, not of broken pages — it starts at zero after a restart and moves when something touches the block. The other two instances are fine: replication ships WAL records, not pages.',
            },
            {
              run: `kubectl cnpg promote pg-cluster pg-cluster-3
kubectl cnpg destroy pg-cluster 1
kubectl get pvc
kubectl delete pod pg-cluster-1 --wait=false
kubectl get pvc`,
              out: `Node pg-cluster-3 in cluster pg-cluster will be promoted
Instance pg-cluster-1 of cluster pg-cluster is destroyed
NAME           STATUS        VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
pg-cluster-1   Terminating   pvc-12e9382b-1fc7-470e-ad48-bcd8745673fa   1Gi        RWO            local-path     4m49s
pod "pg-cluster-1" deleted from default namespace
NAME           STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
pg-cluster-1   Bound    pvc-45818290-afb4-45a9-9e3e-62f17bfcd3d6   1Gi        RWO            local-path     58s`,
              note: 'Move the writes first, then discard the storage. `destroy` takes the instance *number*. The claim usually sits Terminating because the operator has already recreated the Pod that mounts it — deleting that Pod once lets the deletion finish, and the instance comes back on a new volume, re-cloned from a good copy.',
            },
          ],
          notes: [
            'Nothing scans your data on its own. Alerting on `checksum_failures` catches the damage the moment a query trips over it; a periodic `pg_checksums --check` against a stopped copy is what catches it before one does.',
            'A page corrupted on one instance is not replicated, which is the whole reason a replica can save you here. A statement that deletes the wrong rows *is* replicated, within milliseconds — that one needs a backup and a point in time.',
            '`ignore_checksum_failure = on` turns the error into a warning and hands back whatever the block contains; `zero_damaged_pages = on` reads past the page and loses the rows in it. Both are last resorts for when the damaged copy is the only copy.',
          ],
        },
        {
          id: 'degraded-watch',
          name: 'Timing a cluster back to full redundancy',
          summary:
            'Deletes a replica and polls the cluster until it reports three of three ready again. The loop waits for the status to actually report degraded first, because it takes a moment to catch up with a deletion that has already happened.',
          usedIn: ['cnpg-degraded-recovery'],
          examples: [
            {
              run: `TARGET=$(cat /root/degraded-target.txt)
START=$(date +%s); DEGRADED=""
kubectl delete pod $TARGET --wait=false
while true; do
  R=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.readyInstances}')
  P=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.phase}')
  NOW=$(date +%s)
  [ "$R" != "3" ] && [ -z "$DEGRADED" ] && DEGRADED=1 && echo "degraded after $((NOW-START))s: ready=$R phase=$P"
  [ -n "$DEGRADED" ] && [ "$R" = "3" ] && [ "$P" = "Cluster in healthy state" ] && break
  sleep 2
done
echo $(( $(date +%s) - START ))`,
              out: `pod "pg-cluster-3" deleted from default namespace
degraded after 2s: ready=2 phase=Waiting for the instances to become active
15`,
              note: 'Fifteen seconds from destroying a replica to full redundancy, against an end-to-end budget of sixty — and with no promotion: the primary and the timeline are unchanged throughout.',
            },
          ],
          notes: [
            'It is fast because only the Pod was deleted: the replacement reattaches to the same PersistentVolumeClaim and replays the WAL it missed, rather than being re-cloned.',
          ],
        },
        {
          id: 'endpoint-watch',
          name: 'Timing the write endpoint across a failover',
          summary:
            'Deletes the primary and polls the write Service once a second until it names a different address. Doing both in one shell is what makes the number a measurement of the cluster rather than of the person at the keyboard.',
          usedIn: ['cnpg-failover-endpoint-time'],
          examples: [
            {
              run: `OLD=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
kubectl delete pod $(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}') --wait=false
START=$(date +%s)
while true; do
  IP=$(kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}')
  [ -n "$IP" ] && [ "$IP" != "$OLD" ] && break
  sleep 1
done
echo $(( $(date +%s) - START )) > /root/rw-switch-seconds.txt
cat /root/rw-switch-seconds.txt`,
              out: `pod "pg-cluster-1" deleted from default namespace
3`,
              note: "Three seconds from destroying the primary to the write endpoint naming a different Pod — against CloudNativePG's own end-to-end budget of ten.",
            },
          ],
          notes: [
            'The loop waits for a non-empty address that differs from the old one, because the endpoint set goes briefly empty in between.',
          ],
        },
      ],
    },
  ],
}
