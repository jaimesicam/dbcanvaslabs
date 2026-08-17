// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): the
// nodes of this environment are whatever the host is (the run this was written from was arm64,
// and nothing in the lab assumes it). ghcr.io's index for the pinned PostgreSQL tag lists four
// manifests — linux/amd64, linux/arm64 and two whose platform is unknown/unknown, which are the
// build attestations rather than images — and following the arm64 digest to its manifest and
// then to its config blob returned {"architecture":"arm64","os":"linux"}. The operator reports
// the same fact about itself on startup, logging availableArchitectures amd64 and arm64.
//
// Worked from the `toolbox` tab, the only place with curl and jq (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client Pod
// and the toolbox are this lab's starting state, built by its own provisioning. No reference to
// any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgMultiArch = {
  id: 'cnpg-multi-arch',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes, and it is why the architecture you are about to investigate is genuinely whatever the machine underneath happens to be.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and has a route out to the internet',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster on ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie — one tag, whatever architecture these nodes turn out to be',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A container image tag does not name an image. It names a list, and the container runtime picks the entry matching the machine it is running on — which is the entire reason one CloudNativePG manifest runs unmodified on an Intel server and an Arm laptop. You will find out what these nodes are, ask the registry directly what the pinned PostgreSQL tag really contains, and then follow the chain down to the file where an image finally states which processor it was built for. Work in the toolbox tab, which is the only one with curl and jq.',
  },

  tasks: [
    {
      id: 'what-you-run',
      title: 'Find out what you are actually running on',
      limitSec: 420,
      criteria: [
        'All 3 nodes report the same architecture',
        'The PostgreSQL image running on them reports it too',
        '/root/arch.txt was written',
        "It names your nodes' architecture",
      ],
      brief: `Nothing in this lab tells you which processor architecture you are on, because nothing should have to. This environment was built on whatever machine is hosting it, and the same CloudNativePG manifests were applied either way.

Start by establishing the fact everything else will be compared against. Kubernetes puts it in two places — a label every node carries, and the node's reported system information — and the database container will tell you a third time, from inside the image itself.

That the three agree is not interesting on its own. It becomes interesting in the next objective, when you find that the tag those containers were started from contains an image for the *other* architecture as well.`,
      instructions: `Work in the **toolbox** tab. Ask the nodes:

\`\`\`
kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture,OS:.status.nodeInfo.operatingSystem,KERNEL:.status.nodeInfo.kernelVersion
kubectl get nodes -L kubernetes.io/arch,kubernetes.io/os
\`\`\`

\`kubernetes.io/arch\` is a standard label the kubelet sets on itself, which means it can be used in a node selector — scheduling a workload only onto nodes of one architecture is an ordinary label match, not a special mechanism.

Keep the answer in a variable, because everything below uses it:

\`\`\`
ARCH=$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.architecture}')
echo "these nodes are linux/$ARCH"
\`\`\`

Now ask the running database, from inside the container:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- uname -m
kubectl exec pg-cluster-1 -c postgres -- dpkg --print-architecture
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -tAc "SELECT version();"
\`\`\`

Three answers to the same question in three vocabularies. The kernel's \`uname -m\` uses the machine name, Debian's \`dpkg\` uses the Debian port name, and PostgreSQL's own \`version()\` string carries the full build target it was compiled for. Only the middle one matches the word Kubernetes uses.

The operator agrees, and says so out loud when it starts:

\`\`\`
kubectl -n cnpg-system logs deploy/cnpg-controller-manager \\
  | grep "Kubernetes system metadata" | tail -1
\`\`\`

\`availableArchitectures\` lists **both** amd64 and arm64. That is the operator reporting which architectures it is able to hand an instance manager binary to — a single operator image can manage instances on either.

Record what your nodes are:

\`\`\`
echo $ARCH > /root/arch.txt
cat /root/arch.txt
\`\`\``,
      hint: `\`dpkg --print-architecture\` is the one that speaks the same language as Kubernetes: \`arm64\` or \`amd64\`. \`uname -m\` says \`aarch64\` or \`x86_64\` for the same machines.`,
      solution: `kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture,OS:.status.nodeInfo.operatingSystem
ARCH=$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.architecture}')
echo "these nodes are linux/$ARCH"
kubectl exec pg-cluster-1 -c postgres -- uname -m
kubectl exec pg-cluster-1 -c postgres -- dpkg --print-architecture
kubectl -n cnpg-system logs deploy/cnpg-controller-manager | grep "Kubernetes system metadata" | tail -1
echo $ARCH > /root/arch.txt
cat /root/arch.txt`,
    },

    {
      id: 'ask-the-registry',
      title: 'Ask the registry what the tag really is',
      limitSec: 600,
      criteria: [
        '/root/image-digest.txt was written',
        'It is a digest the registry publishes for this tag',
        'And it is the one built for your architecture',
      ],
      brief: `A tag like \`18.4-system-trixie\` looks like it names an image. It does not. On a modern registry it usually names an **index**: a small document listing one image per platform, each identified by its own digest.

When a node pulls that tag, the container runtime fetches the index, looks for the entry whose platform matches itself, and pulls that. Nothing anywhere in the Cluster manifest mentions an architecture, and nothing has to.

Fetch the index yourself and read it. Two of the entries will not be images at all — their platform is \`unknown/unknown\` — and knowing what those are saves an afternoon the first time you meet them. Then pick out the digest for your own architecture and write it down.`,
      instructions: `Registries need a token even for public images. Get an anonymous pull token first:

\`\`\`
REPO=cloudnative-pg/postgresql
TAG=18.4-system-trixie
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull" | jq -r .token)
echo "token length: \${#TOKEN}"
\`\`\`

Now ask for the tag, telling the registry you understand index documents. That \`Accept\` header is the whole trick — without it a registry may convert the answer into something older and single-platform:

\`\`\`
curl -s -H "Authorization: Bearer $TOKEN" \\
     -H "Accept: application/vnd.oci.image.index.v1+json" \\
     "https://ghcr.io/v2/$REPO/manifests/$TAG" | jq '{mediaType, manifests: [.manifests[] | {digest, platform}]}'
\`\`\`

Four entries. Two are real images — \`linux/amd64\` and \`linux/arm64\` — and two have the platform \`unknown/unknown\`. Those two are not images: they are the build **attestations**, the signed provenance and software bill of materials that the build published alongside the images. A runtime ignores them by matching on platform, which is exactly what you are about to do.

Take the digest for your own architecture and record it:

\`\`\`
ARCH=$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.architecture}')
DIGEST=$(curl -s -H "Authorization: Bearer $TOKEN" \\
     -H "Accept: application/vnd.oci.image.index.v1+json" \\
     "https://ghcr.io/v2/$REPO/manifests/$TAG" \\
  | jq -r ".manifests[] | select(.platform.os==\\"linux\\" and .platform.architecture==\\"$ARCH\\") | .digest")
echo "$DIGEST"
echo "$DIGEST" > /root/image-digest.txt
\`\`\`

That digest is what "the image" means, precisely. The tag is a name that can be moved; the digest is the content. It is also why pinning by digest and pinning by tag are different promises — and why an index digest and an image digest are different things, which is the trap in the next objective.

The operator publishes the same way. Look at its own tag:

\`\`\`
curl -s "https://ghcr.io/token?scope=repository:cloudnative-pg/cloudnative-pg:pull" | jq -r .token > /tmp/optoken
curl -s -H "Authorization: Bearer $(cat /tmp/optoken)" \\
     -H "Accept: application/vnd.oci.image.index.v1+json" \\
     "https://ghcr.io/v2/cloudnative-pg/cloudnative-pg/manifests/1.30.0" \\
  | jq -c '.manifests[] | select(.platform.os=="linux") | {digest, platform}'
\`\`\`

Same shape, same two platforms. The whole stack — operator, PostgreSQL images, the instance manager inside them — is published for both.`,
      hint: `If the response comes back with a \`manifests\` key you have the index; if it comes back with \`layers\` you have a single image and the \`Accept\` header did not reach the registry. Check the quoting on the curl line.`,
      solution: `REPO=cloudnative-pg/postgresql
TAG=18.4-system-trixie
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/$REPO/manifests/$TAG" | jq '{mediaType, manifests: [.manifests[] | {digest, platform}]}'
ARCH=$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.architecture}')
DIGEST=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/$REPO/manifests/$TAG" | jq -r ".manifests[] | select(.platform.os==\\"linux\\" and .platform.architecture==\\"$ARCH\\") | .digest")
echo "$DIGEST" > /root/image-digest.txt
cat /root/image-digest.txt`,
    },

    {
      id: 'follow-the-digest',
      title: 'Follow it down to where the image says what it is',
      limitSec: 600,
      criteria: [
        '/root/config-digest.txt was written',
        'The manifest for your architecture names it as its config blob',
        'And that blob says the image was built for your architecture',
      ],
      brief: `The index said an entry is for your architecture. That is the index's claim about the image, made by whoever assembled the index.

The image makes the claim itself, one level further down. Fetching the digest you recorded gives a manifest — a list of layers plus one small JSON blob called the **config**. That blob is where an image records its entrypoint, its environment, its layer history, and two fields named \`architecture\` and \`os\`.

Walk those two steps and read it. What you end up holding is the same document the container runtime read when it decided this image would run on this node, and it is the final authority: not the tag, not the index entry, but the image's own config.`,
      instructions: `Pick up where the last objective left off:

\`\`\`
REPO=cloudnative-pg/postgresql
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull" | jq -r .token)
DIGEST=$(cat /root/image-digest.txt)
echo "following $DIGEST"
\`\`\`

Fetch the manifest **at that digest** — not at the tag. This is a single-platform document, so ask for the manifest media type:

\`\`\`
curl -s -H "Authorization: Bearer $TOKEN" \\
     -H "Accept: application/vnd.oci.image.manifest.v1+json" \\
     "https://ghcr.io/v2/$REPO/manifests/$DIGEST" \\
  | jq '{mediaType, config: .config, layers: (.layers | length)}'
\`\`\`

No \`manifests\` list this time — a config, and a count of layers. This is one image.

Take the config blob's digest and record it:

\`\`\`
CONFIG=$(curl -s -H "Authorization: Bearer $TOKEN" \\
     -H "Accept: application/vnd.oci.image.manifest.v1+json" \\
     "https://ghcr.io/v2/$REPO/manifests/$DIGEST" | jq -r .config.digest)
echo "$CONFIG"
echo "$CONFIG" > /root/config-digest.txt
\`\`\`

A config is a blob rather than a manifest, so it comes from a different endpoint — and it may redirect, which is what \`-L\` is for:

\`\`\`
curl -sL -H "Authorization: Bearer $TOKEN" \\
     "https://ghcr.io/v2/$REPO/blobs/$CONFIG" | jq -c '{architecture, os, variant, created}'
\`\`\`

\`architecture\` and \`os\`, straight from the image. Compare with what your nodes said:

\`\`\`
cat /root/arch.txt
\`\`\`

They match, and now you know why: the runtime read the index, matched that field against this node, and pulled this manifest and no other.

For a last look at the same blob, the environment and entrypoint the image ships with are in there too:

\`\`\`
curl -sL -H "Authorization: Bearer $TOKEN" \\
     "https://ghcr.io/v2/$REPO/blobs/$CONFIG" | jq -c '.config | {Entrypoint, Cmd, User, Env: (.Env | length)}'
\`\`\`

Two practical consequences are worth leaving with. A tag that resolves to an index will run on any architecture it publishes, which is why nothing in a CloudNativePG manifest ever mentions one — and pinning an image to an index digest keeps that property, while pinning it to a single image digest quietly ties the manifest to one architecture and will fail to schedule on the other.`,
      hint: `The blob endpoint is \`/v2/<repo>/blobs/<digest>\`, not \`/manifests/\`, and it needs \`-L\` because registries commonly redirect blob downloads to storage.`,
      solution: `REPO=cloudnative-pg/postgresql
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull" | jq -r .token)
DIGEST=$(cat /root/image-digest.txt)
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://ghcr.io/v2/$REPO/manifests/$DIGEST" | jq '{mediaType, config: .config, layers: (.layers | length)}'
CONFIG=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://ghcr.io/v2/$REPO/manifests/$DIGEST" | jq -r .config.digest)
echo "$CONFIG" > /root/config-digest.txt
curl -sL -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/$REPO/blobs/$CONFIG" | jq -c '{architecture, os, variant, created}'
cat /root/arch.txt`,
    },
  ],
}
