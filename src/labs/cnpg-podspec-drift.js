// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): every
// instance Pod carries the generated spec the operator built it from in the `cnpg.io/podSpec`
// annotation, with `terminationGracePeriodSeconds` 1800. Patching `spec.resources` rolled all
// three instances in under 50 seconds — replicas first at 15-second intervals, the primary
// last, each Pod replaced rather than restarted (restartCount stayed 0, creationTimestamps all
// moved) — while the cluster reported "Primary instance is being restarted without a
// switchover" and pg-cluster-1 remained primary throughout. Overwriting one Pod's recorded
// annotation with junk had the operator delete and rebuild that Pod within 3 seconds and write
// the real spec back; a label of the learner's own on the same Pod was left untouched.
//
// Worked from the `toolbox` tab, which carries jq (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client Pod
// and the toolbox are this lab's starting state, built by its own provisioning. No reference to
// any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgPodSpecDrift = {
  id: 'cnpg-podspec-drift',
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
      'A healthy 3-instance Cluster named pg-cluster on ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie, whose spec requests no CPU or memory at all',
      'Three instance Pods each carrying the operator\'s own record of the Pod spec it generated them from',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'The operator does not diff your Pods against your Cluster. It writes down the Pod spec it generated, keeps that record on the Pod itself, and rolls anything whose record no longer matches what it would generate today. You will read that record, change a field that has nothing to do with the PostgreSQL image and watch the whole cluster roll for it, and then corrupt one Pod\'s record by hand to prove which of the two the operator is really comparing. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'read-the-record',
      title: 'Find the operator\'s record of what it built',
      limitSec: 420,
      criteria: [
        'All 3 instance Pods carry the cnpg.io/podSpec annotation',
        '/root/grace-period.txt was written',
        'It names the shutdown grace period the operator recorded',
      ],
      brief: `A controller that manages Pods needs an answer to one question on every reconcile: is this Pod still the Pod I would make today?

CloudNativePG answers it by writing down what it generated. Each instance Pod carries an annotation, \`cnpg.io/podSpec\`, holding the complete Pod spec the operator produced when it created that Pod. Reconciliation compares that record with a freshly generated spec, and any difference is **drift** — which is what triggers a rolling update.

Read the record before you disturb it. It is longer than you might expect, and most of what is in it is not in the Cluster manifest at all: volumes, probes, the instance manager's own arguments, and a shutdown grace period measured in half-hours rather than seconds. Take that last number out and keep it.`,
      instructions: `Work in the **toolbox** tab. Look at what the operator writes on every instance Pod:

\`\`\`
kubectl get pod pg-cluster-1 -o json | jq -S '.metadata.annotations | keys'
\`\`\`

Four annotations, and one of them is the whole story: \`cnpg.io/podSpec\`. The others are bookkeeping — which instance number this is, which operator version made it, and a hash of its environment.

The annotation's value is JSON inside a string, so it needs unwrapping before it can be read:

\`\`\`
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' | jq . | head -40
\`\`\`

That is a complete Pod spec — volumes, init containers, the postgres container with its probes and command line, service account, security context. None of it appears in the Cluster you were given; all of it was generated from it.

Pull out the parts worth comparing later:

\`\`\`
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' \\
  | jq -c '{grace: .terminationGracePeriodSeconds, resources: .containers[0].resources, image: .containers[0].image}'
\`\`\`

\`resources\` is an empty object — this cluster requests no CPU and no memory, which is the default and a bad idea in production for reasons that are somebody else's lab. The grace period is 1800 seconds: half an hour for PostgreSQL to shut down cleanly before Kubernetes kills it, because a database that is killed mid-checkpoint pays for it on the way back up.

Record the grace period:

\`\`\`
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' \\
  | jq -r '.terminationGracePeriodSeconds' > /root/grace-period.txt
cat /root/grace-period.txt
\`\`\`

And confirm all three instances carry a record, not just the one you looked at:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json \\
  | jq -r '.items[] | [.metadata.name, (.metadata.annotations["cnpg.io/podSpec"] | length)] | @tsv'
\`\`\``,
      hint: `In a jsonpath the dots inside an annotation key have to be escaped: \`{.metadata.annotations.cnpg\\.io/podSpec}\`. If you would rather not escape anything, \`-o json | jq -r '.metadata.annotations["cnpg.io/podSpec"]'\` gets the same string.`,
      solution: `kubectl get pod pg-cluster-1 -o json | jq -S '.metadata.annotations | keys'
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' | jq . | head -40
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' | jq -c '{grace: .terminationGracePeriodSeconds, resources: .containers[0].resources, image: .containers[0].image}'
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' | jq -r '.terminationGracePeriodSeconds' > /root/grace-period.txt
cat /root/grace-period.txt`,
    },

    {
      id: 'cause-drift',
      title: 'Change one field and watch everything roll',
      limitSec: 600,
      criteria: [
        'The Cluster asks for 512Mi of memory',
        'All 3 instance Pods are running with it',
        'The recorded podSpec was rewritten to match',
        'The same instance is still primary — the roll never switched over',
      ],
      brief: `Give the cluster a memory request. It is an ordinary, unglamorous change — nothing to do with the PostgreSQL version, the configuration or the data — and it rolls every instance in the cluster, because a container's resources cannot be changed without replacing the Pod.

Watch the order. The operator takes the replicas first, one at a time, and leaves the primary until last, so the cluster is never short of more than one instance and the writable endpoint moves as late as possible.

Then watch what does **not** happen. The phase says the primary is *restarted without a switchover*: the same instance that was primary before is primary after. The Pod carrying it is a new Pod, but the role never moved — which is the difference between a rolling update and a failover.`,
      instructions: `Note who is primary now, because the claim at the end is about this:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}'; echo
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
\`\`\`

Now ask for memory:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"resources": {"requests": {"cpu": "100m", "memory": "512Mi"}, "limits": {"memory": "1Gi"}}}
}'
\`\`\`

Watch it roll. Run this a few times over the next minute rather than waiting for it to finish:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,READY:.status.containerStatuses[0].ready
\`\`\`

Mid-roll the creation timestamps disagree — some Pods are minutes old and some are seconds old — and one may vanish from the listing entirely for a moment, because it has been deleted and its replacement has not been created yet. Near the end the phase reads **Primary instance is being restarted without a switchover**.

When it settles, read the timestamps as a sequence:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json \\
  | jq -r '.items[] | [.metadata.name, .metadata.creationTimestamp, (.metadata.labels["cnpg.io/instanceRole"])] | @tsv' | sort -k2
kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}'; echo
\`\`\`

The primary's Pod is the youngest of the three, and it is the *same instance* that was primary before you started. Every Pod was replaced; the role never moved.

Confirm the change reached both places it has to:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json \\
  | jq -r '.items[] | [.metadata.name, .spec.containers[0].resources.requests.memory] | @tsv'
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' \\
  | jq -c '.containers[0].resources'
\`\`\`

The live Pod requests 512Mi, and so does the operator's record of it. Those two agreeing is the definition of *not drifted* — and the reason nothing rolls again on the next reconcile, or the thousand after that.`,
      hint: `The whole roll takes well under a minute here, with roughly 15 seconds between instances. If you check too late you will see a healthy cluster and three young Pods, which is the outcome but not the sequence — the timestamps still tell you the order.`,
      solution: `kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}'; echo
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"resources":{"requests":{"cpu":"100m","memory":"512Mi"},"limits":{"memory":"1Gi"}}}}'
sleep 60
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json | jq -r '.items[] | [.metadata.name, .metadata.creationTimestamp, (.metadata.labels["cnpg.io/instanceRole"])] | @tsv' | sort -k2
kubectl get pods -l cnpg.io/cluster=pg-cluster -o json | jq -r '.items[] | [.metadata.name, .spec.containers[0].resources.requests.memory] | @tsv'
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' | jq -c '.containers[0].resources'`,
    },

    {
      id: 'tamper',
      title: 'Corrupt the record and see what is really compared',
      limitSec: 600,
      criteria: [
        'The replica you tampered with was rebuilt',
        'Its cnpg.io/podSpec annotation is a generated Pod spec again',
        'The cluster is healthy, with all 3 instances back',
      ],
      brief: `Drift is a comparison, and a comparison has two sides. So far you have changed one side — the Cluster — and watched the Pods follow. Now change the *other* side and see whether the operator notices.

Overwrite one replica's \`cnpg.io/podSpec\` annotation with nonsense. Nothing about the running container changes: same image, same resources, same process. Only the operator's record of it is now wrong.

If drift were computed by comparing the Cluster to the live Pod, nothing would happen. Watch what actually happens, and how quickly. Then do the opposite experiment on the same Pod — put a label of your own on it — and find that the operator does not mind at all. What it defends is the record it keeps, not the object as a whole.`,
      instructions: `Pick a replica, so the experiment does not go anywhere near the writable instance:

\`\`\`
REPLICA=$(kubectl get pods -l cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=replica \\
  -o jsonpath='{.items[0].metadata.name}')
echo "tampering with $REPLICA"
kubectl get pod $REPLICA -o jsonpath='{.metadata.creationTimestamp}'; echo
\`\`\`

Overwrite the operator's record of it:

\`\`\`
kubectl annotate pod $REPLICA 'cnpg.io/podSpec={"tampered":true}' --overwrite
\`\`\`

Now watch that Pod for a few seconds. Do not wait — this is quick:

\`\`\`
for i in 1 2 3 4 5 6; do
  kubectl get pod $REPLICA --no-headers \\
    -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,PHASE:.status.phase
  sleep 3
done
\`\`\`

The creation timestamp changes within a few seconds. The Pod was deleted and rebuilt — not restarted, rebuilt — because the record said it was a Pod the operator would never have made. Drift detection is a comparison against **the annotation**, not against the live object.

The new Pod carries a real record again, written by the operator:

\`\`\`
kubectl get pod $REPLICA -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' \\
  | jq -c '{grace: .terminationGracePeriodSeconds, resources: .containers[0].resources}'
kubectl get cluster pg-cluster
\`\`\`

Now the opposite experiment. Put a label of your own on the same Pod and leave it alone:

\`\`\`
kubectl label pod $REPLICA scratch=mine --overwrite
sleep 20
kubectl get pod $REPLICA --no-headers \\
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,SCRATCH:.metadata.labels.scratch
\`\`\`

Untouched. Same Pod, same age, label still there. The operator is not enforcing an identical copy of the object it created — it is enforcing the specific things it recorded and the specific labels it routes on.

That distinction is worth carrying out of here. It is why an admission controller or a policy engine that mutates CloudNativePG's Pods causes an endless rolling update: every Pod the operator creates is modified by somebody else, so the record never matches what the operator would generate, so it rebuilds the Pod, which is modified again. The fix is never to make the operator less strict — it is to stop the mutation from applying to these Pods.`,
      hint: `If the replacement Pod is slow to become Ready, that is a real instance starting PostgreSQL, not a failure. The check wants the cluster back at three ready instances, so give it a moment before running it.`,
      solution: `REPLICA=$(kubectl get pods -l cnpg.io/cluster=pg-cluster,cnpg.io/instanceRole=replica -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $REPLICA -o jsonpath='{.metadata.creationTimestamp}'; echo
kubectl annotate pod $REPLICA 'cnpg.io/podSpec={"tampered":true}' --overwrite
for i in 1 2 3 4 5 6; do kubectl get pod $REPLICA --no-headers -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,PHASE:.status.phase; sleep 3; done
kubectl get pod $REPLICA -o jsonpath='{.metadata.annotations.cnpg\\.io/podSpec}' | jq -c '{grace: .terminationGracePeriodSeconds, resources: .containers[0].resources}'
kubectl label pod $REPLICA scratch=mine --overwrite
sleep 20
kubectl get pod $REPLICA --no-headers -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,SCRATCH:.metadata.labels.scratch
kubectl get cluster pg-cluster`,
    },
  ],
}
