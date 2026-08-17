// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md):
// spec.inheritedMetadata propagated two labels and an annotation to all three instance Pods,
// all three PersistentVolumeClaims, all three Services and the generated app Secret within
// seconds, with nothing recreated (Pod ages kept climbing). Changing a value rewrote it
// everywhere; removing a key from the spec — which needs an explicit null in a merge patch —
// left the old label on every object indefinitely. Inheriting cnpg.io/instanceRole=primary
// overrode the operator's own routing label on all three Pods, gave pg-cluster-rw three
// endpoints, and made five of six writes through it fail with `cannot execute INSERT in a
// read-only transaction`; removing the override saw the operator re-assert the true roles
// within 15 seconds.
//
// Worked from the `toolbox` tab, which carries jq (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client Pod
// and the toolbox are this lab's starting state, built by its own provisioning. No reference to
// any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgInheritedMetadata = {
  id: 'cnpg-inherited-metadata',
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
      'A healthy 3-instance Cluster named pg-cluster whose spec carries no inheritedMetadata at all',
      'Everything the operator generated from it: three instance Pods, three PersistentVolumeClaims, the pg-cluster-rw, -ro and -r Services and the pg-cluster-app Secret — none of them carrying a label of yours',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Your organisation labels things: an owner, a cost centre, a ticket. A Cluster is one object, but the operator turns it into a dozen, and labelling those by hand is both tedious and wrong the moment the operator makes another one. You will use the field that solves this, find out what it does when a value changes and what it refuses to do when a key is removed, and then use it to break your own database — because it will happily overwrite labels the operator is routing traffic on. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'inherit-them',
      title: 'Label one object, and label a dozen',
      limitSec: 480,
      criteria: [
        'The Cluster asks for two labels and an annotation to be inherited',
        'All 3 instance Pods carry both',
        'So do their PersistentVolumeClaims',
        'And the Services and the application Secret the operator generated',
      ],
      brief: `Putting a label on a Cluster labels the Cluster. It does not label the Pods, the volumes, the Services or the Secrets the operator built from it — and those are the objects your cost reporting, your ownership queries and your alert routing actually see.

\`spec.inheritedMetadata\` is the answer: labels and annotations declared once on the Cluster and copied by the operator onto everything it generates from it. It is per-cluster, it is part of the manifest, and it needs no privileges beyond editing the Cluster.

Declare two labels and one annotation, then go and find them on objects you never touched. Watch the Pod ages while you do — nothing about this is a rollout.`,
      instructions: `Work in the **toolbox** tab. First establish that nothing carries your labels yet:

\`\`\`
kubectl get pods,pvc,svc -l cnpg.io/cluster=pg-cluster -L team,cost-centre
\`\`\`

Empty TEAM and COST-CENTRE columns everywhere. Note the Pod ages, because the claim below is that they will not change.

Now declare the metadata on the Cluster:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {
    "inheritedMetadata": {
      "labels": {"team": "payments", "cost-centre": "cc-4471"},
      "annotations": {"owner": "platform-db@example.com"}
    }
  }
}'
\`\`\`

Give the operator a few seconds, then look at everything it generated:

\`\`\`
sleep 15
kubectl get pods,pvc,svc,secret -l cnpg.io/cluster=pg-cluster -L team,cost-centre
\`\`\`

Both labels, on all three Pods, all three claims, all three Services and the generated application Secret. And the ages are the ages you noted a moment ago — this is a metadata update on live objects, not a rolling update. Nothing restarted, nothing reconnected.

The annotation went the same way, though annotations get no column of their own:

\`\`\`
for o in pod/pg-cluster-1 pvc/pg-cluster-1 svc/pg-cluster-rw secret/pg-cluster-app; do
  printf "%-24s %s\\n" "$o" "$(kubectl get $o -o jsonpath='{.metadata.annotations.owner}')"
done
\`\`\`

Worth being clear about which of the two you want. A **label** is selectable — \`kubectl get pods -l team=payments\` works, and so does a NetworkPolicy or a monitoring rule that matches on it. An **annotation** is not selectable and is for information: an owner's address, a ticket reference, a link to a runbook. Costing tools and policy engines read labels; humans and integrations read annotations.

Confirm the labels really are usable as a selector across kinds:

\`\`\`
kubectl get pods,pvc,svc,secret -l team=payments
\`\`\``,
      hint: `A merge patch on \`spec.inheritedMetadata\` adds to what is there, so the labels and annotations blocks can be sent together in one patch as above.`,
      solution: `kubectl get pods,pvc,svc -l cnpg.io/cluster=pg-cluster -L team,cost-centre
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"team":"payments","cost-centre":"cc-4471"},"annotations":{"owner":"platform-db@example.com"}}}}'
sleep 15
kubectl get pods,pvc,svc,secret -l cnpg.io/cluster=pg-cluster -L team,cost-centre
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.owner}'; echo
kubectl get pods,pvc,svc,secret -l team=payments`,
    },

    {
      id: 'change-and-remove',
      title: 'Change one, remove one, and see the difference',
      limitSec: 480,
      criteria: [
        'The Cluster no longer asks for cost-centre to be inherited',
        'The Pods still carry it — nothing takes an inherited label back',
        "While the team label's new value reached every Pod and claim",
      ],
      brief: `Two edits that look symmetrical and are not.

Change a value and the operator rewrites it everywhere within seconds, because reconciliation applies what the spec currently says. Remove a key and… nothing happens to the objects at all. The label stays where it is, on every Pod, claim, Service and Secret, and no amount of waiting removes it.

Inheritance here is *additive*. The operator copies what the spec asks for; it does not maintain a record of what it once copied, so it cannot know that a label it is no longer being asked to apply was ever its doing rather than yours.

There is a second trap sitting on top of the first: a merge patch cannot remove a key by leaving it out. Meet both, in that order.`,
      instructions: `Start with the change, which behaves as you would expect:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"inheritedMetadata": {"labels": {"team": "platform"}}}
}'
sleep 15
kubectl get pods,pvc -l cnpg.io/cluster=pg-cluster -L team
\`\`\`

Every Pod and every claim now reads \`platform\`. One edit, applied everywhere, nothing recreated.

Now try to stop inheriting the cost centre the way most people try first — by patching the labels map without it:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"inheritedMetadata": {"labels": {"team": "platform"}}}
}'
kubectl get cluster pg-cluster -o jsonpath='{.spec.inheritedMetadata}'; echo
\`\`\`

The reply is \`patched (no change)\` and \`cost-centre\` is still in the spec. A merge patch **merges** maps: keys you omit are keys you did not mention, not keys you removed. To remove one you have to say so, with an explicit null:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"inheritedMetadata": {"labels": {"cost-centre": null}}}
}'
kubectl get cluster pg-cluster -o jsonpath='{.spec.inheritedMetadata}'; echo
\`\`\`

Gone from the spec. Now look at the objects:

\`\`\`
sleep 20
kubectl get pods,pvc -l cnpg.io/cluster=pg-cluster -L team,cost-centre
\`\`\`

Still there. Every Pod and every claim is still labelled \`cost-centre=cc-4471\`, and it will stay that way for as long as those objects exist. Wait longer if you like — reconciliation is running constantly and it will not remove it.

This is the property to remember, because it decides how you should use the field. An inherited label is a one-way door per object: it arrives when the spec asks for it, and it leaves when the object is replaced — on the next rolling update, or never.

If a stale label has to be gone sooner than that, removing it is your job rather than the operator's, one kind at a time with \`kubectl label\` and a trailing minus on the key. Which is exactly the hand-labelling of generated objects that inheritance existed to avoid — so it is worth deciding what belongs in \`inheritedMetadata\` before putting it there. (Leave the label where it is for now; the check for this objective is looking for it.)`,
      hint: `A merge patch never removes a map key by omission — send the key with a value of \`null\` to take it out. \`kubectl get cluster pg-cluster -o jsonpath='{.spec.inheritedMetadata}'\` shows what the spec currently asks for.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"team":"platform"}}}}'
sleep 15
kubectl get pods,pvc -l cnpg.io/cluster=pg-cluster -L team
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"cost-centre":null}}}}'
kubectl get cluster pg-cluster -o jsonpath='{.spec.inheritedMetadata}'; echo
sleep 20
kubectl get pods,pvc -l cnpg.io/cluster=pg-cluster -L team,cost-centre`,
    },

    {
      id: 'override-what-the-operator-owns',
      title: 'Inherit a label the operator was using',
      limitSec: 600,
      criteria: [
        '/root/readonly-error.txt was written',
        'The Cluster no longer inherits cnpg.io/instanceRole',
        'Exactly one Pod is labelled primary, and it is the real one',
        'The read-write Service is back to a single endpoint',
      ],
      brief: `\`inheritedMetadata\` has no guard rails. It copies the keys you name onto the objects the operator generates, and it does so **after** the operator has set its own — so if you name a key the operator is using, yours wins.

One of those keys is \`cnpg.io/instanceRole\`, which is how the read-write Service finds the primary. Inherit it as \`primary\` and every instance claims to be the primary. The Service is not clever about this: it selects on a label, three Pods now match, and writes start landing on read-only replicas.

Do it deliberately, capture the error a client gets, and then take the override away and watch the operator repair its own routing within seconds. This is not a lab about vandalism — it is about knowing which namespace of label keys belongs to the operator, and what the failure looks like when something in your platform starts writing into it.`,
      instructions: `First, a table to write into, and proof that writes work:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE IF NOT EXISTS meta_demo (id serial primary key, note text);"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "INSERT INTO meta_demo (note) VALUES ('before') RETURNING id;"
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
\`\`\`

One endpoint behind the read-write Service, and it is the primary. Now overwrite the label that decided that:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"inheritedMetadata": {"labels": {"cnpg.io/instanceRole": "primary"}}}
}'
sleep 15
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
\`\`\`

All three Pods claim to be primary, and the read-write Service now has three endpoints. Note what did *not* happen: the cluster is still healthy, replication is still fine, and PostgreSQL is completely unaware. Nothing is wrong with the database — only with the sign on the door.

Now be the application, several times, so you land on more than one instance:

\`\`\`
for i in 1 2 3 4 5 6; do
  kubectl exec psql-client -- psql -h pg-cluster-rw -tAc \\
    "INSERT INTO meta_demo (note) VALUES ('during') RETURNING id;" 2>&1 | head -1
done
\`\`\`

Most attempts fail with **cannot execute INSERT in a read-only transaction** — the connection was routed to a replica — and the occasional one succeeds because it happened to reach the real primary. An intermittent, load-balanced write failure, produced entirely by a label. Keep the error:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc \\
  "INSERT INTO meta_demo (note) VALUES ('during') RETURNING id;" 2>&1 | head -1 > /root/readonly-error.txt
cat /root/readonly-error.txt
\`\`\`

If that command happened to reach the primary and succeeded, run it again until it fails — the file has to hold the error.

Now put it back, by removing the override rather than by relabelling anything:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"inheritedMetadata": {"labels": {"cnpg.io/instanceRole": null}}}
}'
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw \\
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "INSERT INTO meta_demo (note) VALUES ('after') RETURNING id;"
\`\`\`

One primary, two replicas, one endpoint, writes working. And notice the difference from the previous objective: the \`cost-centre\` label you stopped inheriting is still on the Pods, but \`cnpg.io/instanceRole\` corrected itself the moment the override was gone. The operator does not clean up labels it has no opinion about — it re-asserts the ones it depends on, every reconcile, because its own routing is built on them.

So the rule for this field is simple to state and easy to forget: inherit keys in a namespace you own. \`cnpg.io/\` belongs to the operator, and so does \`app.kubernetes.io/\` on these objects. Your own domain — \`example.com/team\`, or an unprefixed key nobody else is using — cannot collide with anything.`,
      hint: `If every write in the loop succeeds, wait a few more seconds and try again — the endpoints take a moment to catch up with the labels, and you need more than one endpoint behind the Service for a write to land on a replica.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE IF NOT EXISTS meta_demo (id serial primary key, note text);"
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"cnpg.io/instanceRole":"primary"}}}}'
sleep 15
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "INSERT INTO meta_demo (note) VALUES ('during') RETURNING id;" 2>&1 | head -1 > /root/readonly-error.txt
cat /root/readonly-error.txt
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"inheritedMetadata":{"labels":{"cnpg.io/instanceRole":null}}}}'
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster -L cnpg.io/instanceRole
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo`,
    },
  ],
}
