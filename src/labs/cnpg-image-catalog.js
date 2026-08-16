// The ImageCatalog schema and the catalog-driven roll are confirmed live against a real K3D
// + CloudNativePG deploy (server/, see LABORATORY.md): `spec.images` is the required list and
// its entries are {major, image}, while `spec.componentImages` is a separate optional list
// keyed by {key, image} for non-PostgreSQL components — putting `major` under the latter is
// rejected with a strict-decoding error. Pointing the Cluster at the catalog left
// `spec.imageName` null, and editing the catalog alone rolled the cluster: mid-roll one Pod
// ran 18.4 and was not ready while two still ran 18.3, with the Cluster object untouched.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster on the older image,
// the cnpg plugin, a client Pod, a staged catalog manifest and the toolbox are this lab's
// starting state, built by its own provisioning. No reference to any other lab (see
// CLAUDE.md, "Lab content contract").

export const cnpgImageCatalog = {
  id: 'cnpg-image-catalog',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster on a deliberately older image, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, and both image versions are pulled and pushed into every node so nothing waits on a download.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster running ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie, named directly in spec.imageName — one minor release behind, on purpose',
      'The newer image, ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie, already imported into all three nodes',
      'An ImageCatalog manifest staged at /root/catalog.yaml on the k3d-server node — written but deliberately not applied',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'This cluster names its PostgreSQL image directly, which means upgrading it is editing that cluster — and upgrading fifty of them is editing fifty. You will move it onto an ImageCatalog instead, so the image comes from a shared object, and then perform the upgrade by editing only that object while the Cluster is never touched at all. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'adopt-the-catalog',
      title: 'Move the cluster onto a catalog',
      limitSec: 480,
      criteria: [
        'An ImageCatalog named postgres-catalog exists',
        'It maps major 18 to the 18.3 image',
        'The Cluster references the catalog and no longer names an image of its own',
        'The cluster is still healthy, still on 18.3',
      ],
      brief: `An ImageCatalog is a lookup table from PostgreSQL major version to container image. A Cluster can name an image directly with \`spec.imageName\`, or point at a catalog with \`spec.imageCatalogRef\` and let the catalog decide.

The two are mutually exclusive, and swapping one for the other is the first objective. Done correctly it changes nothing observable: the catalog names the image the cluster is already running, so the cluster stays exactly where it is.

That is the point of this objective — adopting a catalog should be a no-op. The upgrade comes next, and it will come from somewhere else entirely.`,
      instructions: `The manifest was staged on the **k3d-server** node. Read it from that tab:

\`\`\`
cat /root/catalog.yaml
\`\`\`

Note the shape, because it is easy to get wrong. \`spec.images\` is the required list and its entries are \`major\` and \`image\`. There is also a \`spec.componentImages\` list, but that is a different thing — named images for non-PostgreSQL components such as PgBouncer, keyed by \`key\` rather than \`major\`. Put \`major\` under \`componentImages\` and the API server rejects the whole object with a strict-decoding error.

Apply it, then move to the **toolbox** tab:

\`\`\`
kubectl apply -f /root/catalog.yaml
kubectl get imagecatalog
kubectl get imagecatalog postgres-catalog -o json | jq .spec.images
\`\`\`

Now look at how the cluster currently gets its image:

\`\`\`
kubectl get cluster pg-cluster -o json | jq -c '{imageName: .spec.imageName, ref: .spec.imageCatalogRef}'
\`\`\`

An \`imageName\` and no reference. Swap them — remove the direct name and add the catalog reference in one patch, because a Cluster may not have both:

\`\`\`
kubectl patch cluster pg-cluster --type=json -p '[
  {"op":"remove","path":"/spec/imageName"},
  {"op":"add","path":"/spec/imageCatalogRef","value":{"apiGroup":"postgresql.cnpg.io","kind":"ImageCatalog","name":"postgres-catalog","major":18}}
]'
\`\`\`

Check what the cluster looks like now:

\`\`\`
kubectl get cluster pg-cluster -o json | jq -c '{imageName: .spec.imageName, ref: .spec.imageCatalogRef}'
sleep 20
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,CREATED:.metadata.creationTimestamp
\`\`\`

\`imageName\` is gone, the reference is there, and nothing rolled — the Pod ages carry on climbing. The cluster resolves its image through the catalog now, and the catalog named the image it was already running.

Leave a row behind for later:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE catalog_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO catalog_demo (note) VALUES ('before-catalog-bump') RETURNING *;"
\`\`\``,
      hint: `A Cluster may name an image *or* reference a catalog, never both — so the remove and the add have to be in one JSON patch. \`--type=json\` with a list of operations does that atomically.`,
      solution: `cat /root/catalog.yaml
kubectl apply -f /root/catalog.yaml
kubectl get imagecatalog postgres-catalog -o json | jq .spec.images
kubectl patch cluster pg-cluster --type=json -p '[{"op":"remove","path":"/spec/imageName"},{"op":"add","path":"/spec/imageCatalogRef","value":{"apiGroup":"postgresql.cnpg.io","kind":"ImageCatalog","name":"postgres-catalog","major":18}}]'
sleep 20
kubectl get cluster pg-cluster -o json | jq -c '{imageName: .spec.imageName, ref: .spec.imageCatalogRef}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE catalog_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO catalog_demo (note) VALUES ('before-catalog-bump') RETURNING *;"`,
    },

    {
      id: 'roll-via-the-catalog',
      title: 'Upgrade without touching the cluster',
      limitSec: 720,
      criteria: [
        'The catalog now maps major 18 to the 18.4 image',
        'All 3 instance Pods are running that image',
        'The Cluster still names no image of its own — only the catalog moved',
        'PostgreSQL reports the new server version',
      ],
      brief: `Now the upgrade, and the whole point of the feature: you are going to edit the **catalog**, not the cluster.

Change which image major 18 maps to, and every Cluster referencing that catalog for major 18 rolls onto it. Here that is one cluster; in a fleet it is all of them, from one object, in one change.

Watch it roll the same way an image change always does — replicas first, primary last, every Pod recreated. Then go back and look at the Cluster spec, which will still name no image at all.`,
      instructions: `Point the catalog at the newer image:

\`\`\`
kubectl patch imagecatalog postgres-catalog --type=merge \\
  -p '{"spec":{"images":[{"major":18,"image":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}]}}'
\`\`\`

Look immediately — the roll starts within seconds:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,READY:.status.containerStatuses[0].ready
kubectl get cluster pg-cluster
\`\`\`

A mixture of 18.3 and 18.4, and the cluster reporting "Waiting for the instances to become active" — an ordinary rolling update, triggered by an object that is not the Cluster.

The database keeps serving throughout. Check it while the roll is going:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now(), 'still serving';"
\`\`\`

Wait for it to finish:

\`\`\`
sleep 150
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image
\`\`\`

All three on 18.4. Now the part worth pausing on — what the Cluster object says:

\`\`\`
kubectl get cluster pg-cluster -o json | jq -c '{imageName: .spec.imageName, ref: .spec.imageCatalogRef}'
\`\`\`

Still no \`imageName\`, and the same reference it had before. Nothing about the Cluster changed; the upgrade came entirely from the catalog.

Confirm from inside the database:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT version();"
\`\`\`

There is a cluster-scoped variant too, \`ClusterImageCatalog\`, identical in shape but not namespaced — the same lever for clusters spread across namespaces.`,
      hint: `Patch the \`imagecatalog\` resource, not the cluster. If nothing rolls, check that the entry you edited still has \`major: 18\` — a merge patch replaces the whole \`images\` list, so dropping the major is an easy way to leave the cluster resolving nothing.`,
      solution: `kubectl patch imagecatalog postgres-catalog --type=merge -p '{"spec":{"images":[{"major":18,"image":"ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"}]}}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image,READY:.status.containerStatuses[0].ready
sleep 150
kubectl get cluster pg-cluster
kubectl get cluster pg-cluster -o json | jq -c '{imageName: .spec.imageName, ref: .spec.imageCatalogRef}'
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT version();"`,
    },

    {
      id: 'record-the-result',
      title: 'Account for what it cost',
      limitSec: 420,
      criteria: [
        'The row written before the catalog moved survived the roll',
        'Both replicas are streaming on the new image',
        '/root/catalog-image.txt was written',
        'It records the image the catalog now points at',
      ],
      brief: `Same accounting as any rolling update: the data, the ability to write, and replication.

The interesting difference is what you would have to audit afterwards in a fleet. With images named per Cluster, "what is everything running?" is a query across every Cluster object. With a catalog, it is one object — and the Clusters cannot drift from it, because they have no image of their own to drift with.

Record what the catalog points at, since that is now the authoritative answer.`,
      instructions: `The row from before the upgrade:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM catalog_demo ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO catalog_demo (note) VALUES ('after-catalog-bump') RETURNING *;"
\`\`\`

Replication, which had to rebuild as each instance was replaced:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Now record the authoritative answer to "what is this cluster running", which is no longer on the Cluster at all:

\`\`\`
kubectl get imagecatalog postgres-catalog -o jsonpath='{.spec.images[0].image}' > /root/catalog-image.txt
cat /root/catalog-image.txt
\`\`\`

And see the indirection from the other end — the Cluster's status still reports the image it resolved to, even though its spec does not name one:

\`\`\`
kubectl get cluster pg-cluster -o json | jq -c '{spec_image: .spec.imageName, ref: .spec.imageCatalogRef.name, pods: [.status.instanceNames]}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,IMAGE:.status.containerStatuses[0].image
\`\`\`

That gap between "what the spec says" and "what is running" is the thing to hold on to. With a catalog the spec deliberately does not answer the question — the catalog does, for every cluster that references it at once.`,
      hint: `\`jsonpath='{.spec.images[0].image}'\` reads the first entry; with more than one major in a catalog, filter on the major you care about rather than taking index 0.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM catalog_demo ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO catalog_demo (note) VALUES ('after-catalog-bump') RETURNING *;"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl get imagecatalog postgres-catalog -o jsonpath='{.spec.images[0].image}' > /root/catalog-image.txt
cat /root/catalog-image.txt`,
    },
  ],
}
