// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): one
// selector, cnpg.io/cluster=pg-cluster, finds the instance Pods, the join and initdb Jobs while
// they exist, the three PersistentVolumeClaims, the three Services and the generated app
// Secret. The Services select on cnpg.io/instanceRole (primary and replica) and cnpg.io/podRole
// (instance), which is the whole of CloudNativePG's traffic routing. Relabelling a replica's
// cnpg.io/instanceRole to primary by hand was reverted by the operator in about a second —
// measured twice with a quarter-second poll loop, the tampered value survived one reading in one
// run and four in the other — and the read-write Service never gained a second endpoint, while
// an ordinary label of the learner's own on the same Pod was left alone indefinitely.
//
// Worked from the `toolbox` tab, which carries jq (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client Pod
// and the toolbox are this lab's starting state, built by its own provisioning. No reference to
// any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgObjectMetadata = {
  id: 'cnpg-object-metadata',
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
      'A healthy 3-instance Cluster named pg-cluster — one object that the operator has turned into eleven',
      'Everything it generated: three instance Pods, three PersistentVolumeClaims, the pg-cluster-rw, -ro and -r Services and the pg-cluster-app Secret, every one of them labelled and annotated by the operator',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'The labels CloudNativePG writes on the objects it creates are not documentation. They are the mechanism: which Pod is the primary is a label, and the read-write Service is nothing more than a selector matching it. You will inventory an entire cluster through a single selector, read the routing table those labels form, and then try to move traffic by editing a label yourself — to find out, precisely, how long the operator lets you. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'one-selector',
      title: 'Find eleven objects with one selector',
      limitSec: 420,
      criteria: [
        '/root/cluster-label.txt was written',
        'It names the label every generated object carries',
        'The instance Pods and their claims all carry it',
        'So do the Services and the application Secret',
      ],
      brief: `You applied one object. The operator built the rest, and it is more than you would guess: Pods, one PersistentVolumeClaim per instance, three Services, a Secret holding the application credentials, and — while an instance is being created — a Job and its Pod.

Every one of them carries the same label naming the Cluster it came from. That single fact is what makes a CloudNativePG cluster operable: you can list it, describe it, watch it or delete it as a unit without knowing the naming convention for any of the kinds involved.

Find that label, use it across kinds, and then look at the second layer — the per-kind role labels that say what each object *is*. They are how the operator tells its own objects apart, and they are about to become important.`,
      instructions: `Work in the **toolbox** tab. Take one Pod apart first:

\`\`\`
kubectl get pod pg-cluster-1 -o json | jq -S '.metadata.labels'
\`\`\`

Two families. The \`app.kubernetes.io/\` ones are the Kubernetes-wide recommended labels — name, instance, component, version, managed-by — which is what makes a CloudNativePG database legible to tooling that has never heard of CloudNativePG. The \`cnpg.io/\` ones are the operator's own, and the first of them is the one that matters here: \`cnpg.io/cluster\`.

Use it across every kind at once:

\`\`\`
kubectl get all,pvc,secret -l cnpg.io/cluster=pg-cluster
\`\`\`

Pods, Services, claims and the generated Secret, in one listing. Record the label:

\`\`\`
echo "cnpg.io/cluster=pg-cluster" > /root/cluster-label.txt
cat /root/cluster-label.txt
\`\`\`

Now the role labels, which differ by kind. Each answers "what is this object for":

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/podRole,cnpg.io/instanceRole
kubectl get pvc -l cnpg.io/cluster=pg-cluster -L cnpg.io/pvcRole,cnpg.io/instanceRole
kubectl get secret pg-cluster-app -o json | jq -S -c '.metadata.labels'
\`\`\`

\`podRole=instance\` marks a database Pod as opposed to a Job's Pod; \`pvcRole=PG_DATA\` marks a claim as the data directory rather than a separate WAL volume; \`userType=app\` marks the Secret as the application's credentials rather than the superuser's. The Secret also carries \`cnpg.io/reload=true\`, which is a request to the operator rather than a description — it means "watch this and reload the instances when it changes".

Annotations carry the bookkeeping, not the identity:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json \\
  | jq -r '.items[] | [.metadata.name, .metadata.annotations["cnpg.io/nodeSerial"], .metadata.annotations["cnpg.io/operatorVersion"]] | @tsv'
kubectl get pvc pg-cluster-1 -o json | jq -c '.metadata.annotations | {nodeSerial: ."cnpg.io/nodeSerial", pvcStatus: ."cnpg.io/pvcStatus"}'
\`\`\`

\`nodeSerial\` is the number in the instance's name, and it appears on both the Pod and the claim — which is how a rebuilt Pod finds the volume that belongs to it. \`operatorVersion\` records which operator built this object. \`pvcStatus: ready\` is the operator's own note that this claim has been initialised and may be attached to an instance.`,
      hint: `\`kubectl get all\` does not really mean all — it misses PersistentVolumeClaims and Secrets, which is why they are listed explicitly above.`,
      solution: `kubectl get pod pg-cluster-1 -o json | jq -S '.metadata.labels'
kubectl get all,pvc,secret -l cnpg.io/cluster=pg-cluster
echo "cnpg.io/cluster=pg-cluster" > /root/cluster-label.txt
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/podRole,cnpg.io/instanceRole
kubectl get pvc -l cnpg.io/cluster=pg-cluster -L cnpg.io/pvcRole,cnpg.io/instanceRole
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json | jq -r '.items[] | [.metadata.name, .metadata.annotations["cnpg.io/nodeSerial"], .metadata.annotations["cnpg.io/operatorVersion"]] | @tsv'`,
    },

    {
      id: 'the-routing-table',
      title: 'Read the routing table',
      limitSec: 480,
      criteria: [
        '/root/rw-selector.txt was written',
        'It names the label the read-write Service selects on',
        'The read-write Service resolves to exactly one Pod, the current primary',
        'And the read-only Service to the two replicas',
      ],
      brief: `A Service in Kubernetes is a selector and a port. It has no idea what a primary is, cannot ask PostgreSQL anything, and does not talk to the operator.

So when \`pg-cluster-rw\` sends your writes to the primary, that is not the Service being clever. It is selecting on a label, and the operator's job is to make sure exactly one Pod carries that label at any moment. A failover is, from the Service's point of view, entirely a relabelling exercise.

Read the three Services' selectors side by side and the design becomes obvious in one look. Then check the endpoints and confirm that the Pod behind the writable Service really is the instance the cluster calls primary — not by trusting the name, but by comparing addresses.`,
      instructions: `Put the three selectors next to each other:

\`\`\`
kubectl get svc -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,SELECTOR:.spec.selector
\`\`\`

Three Services, three selectors, one design: \`-rw\` selects \`cnpg.io/instanceRole=primary\`, \`-ro\` selects \`cnpg.io/instanceRole=replica\`, and \`-r\` selects \`cnpg.io/podRole=instance\` — every instance, whatever its role. Record the one that carries writes:

\`\`\`
echo "cnpg.io/instanceRole=primary" > /root/rw-selector.txt
cat /root/rw-selector.txt
\`\`\`

Now look at which Pods carry which role, and who the cluster says is primary:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole,role
kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}'; echo
\`\`\`

Two columns saying the same thing: \`cnpg.io/instanceRole\` and a bare \`role\`. The unprefixed one is the older label, kept for compatibility with anything that was written against it — new work should select on the prefixed one.

Prove the Service really resolves to that Pod, by address rather than by name:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-ro \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
\`\`\`

One address behind \`-rw\`, and it is the IP of the Pod labelled primary. Two behind \`-ro\`. An EndpointSlice is maintained by Kubernetes itself from the selector and Pod readiness — nothing in CloudNativePG writes it.

Confirm from the client side, which is where it matters:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl exec psql-client -- psql -h pg-cluster-ro -tAc "SELECT inet_server_addr(), pg_is_in_recovery();"
\`\`\`

The writable Service answers from an instance that is not in recovery; the read-only Service answers from one that is. Two labels and a selector, doing the entire job.`,
      hint: `\`kubectl get endpoints\` is deprecated from Kubernetes 1.33 and prints a warning over the output on this cluster — \`endpointslices\` filtered by \`kubernetes.io/service-name\` is the current way to ask the same question.`,
      solution: `kubectl get svc -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,SELECTOR:.spec.selector
echo "cnpg.io/instanceRole=primary" > /root/rw-selector.txt
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole,role
kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}'; echo
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT inet_server_addr(), pg_is_in_recovery();"
kubectl exec psql-client -- psql -h pg-cluster-ro -tAc "SELECT inet_server_addr(), pg_is_in_recovery();"`,
    },

    {
      id: 'who-owns-the-labels',
      title: 'Try to move the traffic yourself',
      limitSec: 480,
      criteria: [
        'A label of your own is still on an instance Pod — the operator left it alone',
        'But cnpg.io/instanceRole agrees with the operator again',
        'And the read-write Service still resolves to the primary alone',
      ],
      brief: `If the writable Service is just a selector, then relabelling a replica as the primary should redirect writes to it. Try it.

The interesting result is not whether it works. It is **how long it lasts**. Reconciliation is not a periodic job that runs every minute; the operator watches these objects and computes the role labels from the cluster's actual state on every event, so an edit that disagrees with reality is corrected at machine speed. Poll fast enough and you can watch your own change disappear.

Then do the harmless version of the same experiment — put a label of your own on the same Pod — and find it untouched. The operator is not enforcing an exact copy of what it created. It is enforcing the specific keys it depends on, which is a narrower and much more useful promise.`,
      instructions: `Pick a replica and try to promote it with kubectl alone:

\`\`\`
REPLICA=$(kubectl get pods -l cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=replica \\
  -o jsonpath='{.items[0].metadata.name}')
echo "relabelling $REPLICA"
kubectl label pod $REPLICA cnpg.io/instanceRole=primary --overwrite
\`\`\`

Now watch that label four times a second — this is over quickly:

\`\`\`
for i in $(seq 1 16); do
  printf "%s %s\\n" "$(date +%H:%M:%S.%2N)" \\
    "$(kubectl get pod $REPLICA -o jsonpath='{.metadata.labels.cnpg\\.io/instanceRole}')"
  sleep 0.25
done
\`\`\`

The first reading or two says \`primary\`, and every reading after that says \`replica\`. Your edit survived about a second. The operator saw the Pod change, recomputed what its label should be from the cluster's real state, and wrote it back.

Check what that did to traffic, which is to say: nothing:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT pg_is_in_recovery();"
\`\`\`

Still one endpoint, still the primary, still writable. The label was corrected faster than the EndpointSlice controller acted on it.

Now the other half. Put a label the operator has no opinion about on the same Pod:

\`\`\`
kubectl label pod $REPLICA scratch=mine --overwrite
sleep 30
kubectl get pod $REPLICA -L scratch,cnpg.io/instanceRole
\`\`\`

Untouched, and it will stay that way for the life of the Pod. That is the boundary: the operator owns \`cnpg.io/\` on the objects it manages and will not let anything else write there, and it leaves everything else alone.

Two things follow. Promotion is not something you can do with a label — the label is a *consequence* of the promotion, and the operator has ways to be asked properly. And when you do want your own metadata on these objects, use your own keys, because anything in the operator's namespace is a value it recomputes rather than a value it stores.`,
      hint: `If every reading in the loop already says \`replica\`, you were simply too slow to catch it — run the \`kubectl label\` command again immediately before the loop. \`%2N\` gives hundredths of a second in the timestamp.`,
      solution: `REPLICA=$(kubectl get pods -l cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=replica -o jsonpath='{.items[0].metadata.name}')
kubectl label pod $REPLICA cnpg.io/instanceRole=primary --overwrite
for i in $(seq 1 16); do printf "%s %s\\n" "$(date +%H:%M:%S.%2N)" "$(kubectl get pod $REPLICA -o jsonpath='{.metadata.labels.cnpg\\.io/instanceRole}')"; sleep 0.25; done
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl label pod $REPLICA scratch=mine --overwrite
sleep 30
kubectl get pod $REPLICA -L scratch,cnpg.io/instanceRole`,
    },
  ],
}
