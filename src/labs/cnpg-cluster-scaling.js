// The join Pod, the slot and PVC lifecycle and the clone-not-replay behaviour are confirmed
// live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): patching
// spec.instances from 3 to 4 produced a transient pg-cluster-4-join-* Pod, then a fourth
// instance with its own PVC and a third replication slot; scaling back to 3 removed the
// instance, its PVC and its slot together. Grading reads the Cluster spec, the PVCs, the
// slots and the data on the new instance.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster, a client Pod and the
// toolbox are this lab's starting state, built by its own provisioning. No reference to any
// other lab (see CLAUDE.md, "Lab content contract").

export const cnpgClusterScaling = {
  id: 'cnpg-cluster-scaling',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, and the fourth you add will be bootstrapped the same way, in front of you.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", with one PersistentVolumeClaim per instance on the local-path storage class',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'This cluster has three instances because its manifest says three. You will change that number and watch what the operator does with it — a real new instance cloned from the primary, with its own volume and its own replication slot — then check that it genuinely carries the data it never saw being written, and finally scale back down and account for everything that was removed. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'scale-up',
      title: 'Add an instance by changing a number',
      limitSec: 600,
      criteria: [
        'spec.instances is 4',
        'The cluster is healthy with 4 of 4 ready',
        'pg-cluster-4 has a PersistentVolumeClaim of its own',
        'The primary holds a replication slot for the new instance',
      ],
      brief: `Scaling a CloudNativePG cluster is editing one integer. Everything that follows — a volume, a clone of the primary, a replication slot, a Pod — is the operator's work, not yours.

Before you change it, write a row. It matters for the next objective: the instance you are about to create did not exist when that row was written, and you are going to check it has it anyway.

Then set \`spec.instances\` to 4 and watch. There is a transient Pod worth catching if you are quick — a **join** Pod, which is the operator running \`pg_basebackup\` against the primary to build the new instance's data directory before the instance itself starts.`,
      instructions: `Write something first, so there is history the new instance never witnessed:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE scale_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO scale_demo (note) VALUES ('before-scale-up') RETURNING *;"
\`\`\`

Note what exists now:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
\`\`\`

Three instances, three PVCs. Now change the number:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"instances":4}}'
\`\`\`

Look immediately — the interesting Pod is short-lived:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster pg-cluster
\`\`\`

A Pod named something like \`pg-cluster-4-join-gp6w9\` and a cluster status of \`Creating a new replica\`. That join Pod is doing a base backup of the primary; the new instance cannot start until it has a data directory to start on.

Wait for it to finish:

\`\`\`
sleep 90
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Four instances, all ready, the join Pod gone. Now account for what was created alongside it — a volume:

\`\`\`
kubectl get pvc
\`\`\`

And a replication slot, which the operator added so the primary keeps WAL for the new instance:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

Three slots now, one per replica. One integer, four objects.`,
      hint: `The join Pod only exists while the base backup runs, so check for it in the first few seconds after patching. If you miss it, \`kubectl get events --sort-by=.lastTimestamp | tail\` still shows it having been created and completed.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE scale_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO scale_demo (note) VALUES ('before-scale-up') RETURNING *;"
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"instances":4}}'
kubectl get pods -l cnpg.io/cluster=pg-cluster
sleep 90
kubectl get cluster pg-cluster
kubectl get pvc
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;"`,
    },

    {
      id: 'verify-new-replica',
      title: 'Prove the new instance is a real replica',
      limitSec: 480,
      criteria: [
        'pg-cluster-4 is a standby, in recovery',
        'The primary is streaming to all 3 standbys',
        'It carries data written before it existed — it was cloned, not replayed from empty',
        '/root/instances.txt was written',
        'It records how many instances the cluster grew to',
      ],
      brief: `A Pod that is Running is not the same thing as a replica that is working. Check the three things that actually make it one.

It should be in recovery — that is what a standby is. The primary should be streaming to it. And it should hold the row you wrote before it existed, which is the interesting one: a new instance is cloned from the primary's current state, not built by replaying the database's whole history.

That distinction is why scaling up is quick on a small database and slow on a large one — the cost is copying the data directory, not replaying WAL.`,
      instructions: `Is it a standby?

\`\`\`
kubectl exec pg-cluster-4 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
\`\`\`

\`t\`. Is the primary feeding it?

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Three standbys streaming. Now the row that was written before this instance existed:

\`\`\`
kubectl exec pg-cluster-4 -c postgres -- psql -U postgres -d app -c "SELECT * FROM scale_demo ORDER BY id;"
\`\`\`

There it is, on an instance that was not running when it was inserted. The base backup copied the data directory as it stood, and streaming took over from that point.

Watch a new write reach it, which is the part that proves streaming rather than a one-off copy:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO scale_demo (note) VALUES ('after-scale-up') RETURNING *;"
sleep 5
kubectl exec pg-cluster-4 -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM scale_demo;"
\`\`\`

Both rows. Record the size the cluster reached:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.instances}' > /root/instances.txt
cat /root/instances.txt
\`\`\`

One more thing worth looking at — the read-only Service now has one more endpoint behind it, without anything being reconfigured:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-ro -o json \\
  | jq '[.items[].endpoints[].addresses[]] | length'
\`\`\`

Scaling up added read capacity to the \`-ro\` Service by adding an instance, which is the practical reason to do it.`,
      hint: `Query \`pg-cluster-4\` directly with \`kubectl exec\`, not through the \`-rw\` Service — the Service points at the primary, and the whole point is to read from the new instance itself.`,
      solution: `kubectl exec pg-cluster-4 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec pg-cluster-4 -c postgres -- psql -U postgres -d app -c "SELECT * FROM scale_demo ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO scale_demo (note) VALUES ('after-scale-up') RETURNING *;"
kubectl get cluster pg-cluster -o jsonpath='{.spec.instances}' > /root/instances.txt
cat /root/instances.txt`,
    },

    {
      id: 'scale-down',
      title: 'Scale back down and account for what left',
      limitSec: 480,
      criteria: [
        'spec.instances is back to 3',
        'The pg-cluster-4 Pod is gone',
        'Its PersistentVolumeClaim went with it',
        'And so did its replication slot',
      ],
      brief: `Scaling down is the same integer, and it is worth doing deliberately because of what it removes.

The operator drops the highest-numbered instance. Its Pod goes, and so does its PersistentVolumeClaim — the volume is not kept for later. Its replication slot is dropped from the primary too, which is the operator tidying up after itself: a slot for an instance that no longer exists would make the primary retain WAL forever, and that is exactly how a disk fills up quietly.

Check all three, because "the Pod is gone" is the easy half.`,
      instructions: `Note what you are about to remove:

\`\`\`
kubectl get pvc pg-cluster-4
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT slot_name FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

Scale down:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"instances":3}}'
sleep 40
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Three instances again, and the highest-numbered one is the one that left. Now the two things that are easy to forget:

\`\`\`
kubectl get pvc
\`\`\`

Three PVCs — \`pg-cluster-4\`'s volume was deleted with it, not orphaned.

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

Two slots. If that slot had been left behind, the primary would go on reserving WAL for an instance that is never coming back, and the first symptom would be a full volume rather than anything that looks like a replication problem.

Confirm the data is untouched by any of this:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM scale_demo ORDER BY id;"
kubectl get cluster pg-cluster
\`\`\`

Both rows, cluster healthy. Scaling a CloudNativePG cluster in either direction is a change to one number, and the operator does the bookkeeping — including the bookkeeping that is invisible until it goes wrong.`,
      hint: `The instance removed is always the highest-numbered one, not the newest or the least busy. If you need a specific instance gone, promote away from it or delete it and let the operator rebuild elsewhere — scaling down does not let you choose.`,
      solution: `kubectl get pvc pg-cluster-4
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"instances":3}}'
sleep 40
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM scale_demo ORDER BY id;"`,
    },
  ],
}
