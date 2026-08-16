// The operator's replacement and lease handover, and the fact that a cluster with no
// operator is neither repaired nor even accurately reported on, are confirmed live against
// a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): with the operator scaled
// to zero a deleted instance stayed missing while the Cluster still claimed 3 ready, and it
// was recreated within seconds of the operator returning.
//
// Self-contained, like every lab here: the operator, a healthy cluster and a client Pod are
// this lab's starting state, built by its own provisioning. No reference to any other lab
// (see CLAUDE.md, "Lab content contract").

export const cnpgOperatorPodDeletion = {
  id: 'cnpg-operator-pod-deletion',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real CloudNativePG operator and a real database for it to manage, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here. It also means the operator you switch off is really off.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built, holding a leader-election Lease',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" with 3 of 3 ready',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to keep querying from',
    ],
    yourJob:
      'Everything is healthy. The question this lab answers is what the operator is actually responsible for, and the way to find out is to take it away: you will delete its Pod and watch the database not care, then switch it off entirely and break something while it is gone — and find that nothing is repaired, and that the cluster is not even reporting the truth about itself until it comes back.',
  },

  tasks: [
    {
      id: 'delete-the-operator',
      title: 'Delete the operator Pod',
      limitSec: 420,
      criteria: [
        'A replacement operator Pod is running',
        'It holds the leader-election Lease',
        'The database is still serving',
        'All 3 instances are still ready',
      ],
      brief: `Delete the operator's Pod outright and watch what happens to the database: nothing.

The operator is a control loop, not a proxy. Nothing about a client's connection to PostgreSQL passes through it, so queries keep being served while it is gone, and the instance Pods are not restarted when it comes back.

What does change is which Pod holds the leader-election Lease. That Lease is how the operator guarantees only one replica reconciles at a time; watch the holder change to the new Pod's name.`,
      instructions: `Note who holds the lease, then delete the Pod:

\`\`\`
kubectl -n cnpg-system get lease
kubectl -n cnpg-system get pods
kubectl -n cnpg-system delete pod -l app.kubernetes.io/name=cloudnative-pg
\`\`\`

Immediately ask the database whether it noticed:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT now(), count(*) FROM pg_stat_activity;"
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

It answers, and the instance Pods are exactly as they were — same ages, restart counts still zero.

Wait a few seconds and look at the operator again:

\`\`\`
kubectl -n cnpg-system get pods
kubectl -n cnpg-system get lease
\`\`\`

A new Pod, with a new name, and the lease holder now names it. The Deployment replaced it, the new process took the lease, and reconciliation resumed — with no involvement from the database at all.`,
      hint: `The lease holder is a long string starting with the operator Pod's name. Compare it before and after — the identity changes because it is a new process.`,
      solution: `kubectl -n cnpg-system get lease
kubectl -n cnpg-system delete pod -l app.kubernetes.io/name=cloudnative-pg
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT now(), count(*) FROM pg_stat_activity;"
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl -n cnpg-system get pods
kubectl -n cnpg-system get lease`,
    },

    {
      id: 'scale-to-zero',
      title: 'Switch it off, then break something',
      limitSec: 480,
      criteria: [
        'The operator is scaled to zero',
        'One instance Pod is gone and nothing has replaced it',
        'The Cluster still claims 3 ready — no controller is left to notice',
      ],
      brief: `Deleting the Pod barely counts as an outage, because the Deployment replaces it in seconds. To see what the operator does for you, take it away properly: scale it to zero, and then delete an instance.

Nothing will repair it. The Pod stays gone, and the database runs on with two instances instead of three — degraded, and with nobody watching.

Look at the Cluster resource while you are there. It still says three of three ready, because the status is written by the operator, and the operator is not running. A resource's status is a report from a controller, not an observation of reality.`,
      instructions: `Scale the operator down and confirm it is really gone:

\`\`\`
kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=0
kubectl -n cnpg-system get pods
\`\`\`

Now delete an instance — a replica, so no promotion is involved:

\`\`\`
kubectl delete pod pg-cluster-3 --wait=false
\`\`\`

Wait, and watch nothing happen:

\`\`\`
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

Two Pods where there were three, and no sign of a replacement. And the Cluster still reports 3 ready in a healthy state — that line is the operator's last word on the subject, frozen at the moment it stopped.

The database itself is unaffected:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT count(*) FROM pg_stat_replication;"
\`\`\`

One replica streaming instead of two: really degraded, quietly, with a status resource that says otherwise.`,
      hint: `Delete a replica rather than the primary — with no operator running, a missing primary would leave the cluster with nothing to promote it, which is a different and much less recoverable demonstration.`,
      solution: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=0
kubectl -n cnpg-system get pods
kubectl delete pod pg-cluster-3 --wait=false
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT count(*) FROM pg_stat_replication;"`,
    },

    {
      id: 'restore-the-operator',
      title: 'Bring it back and watch the repair',
      limitSec: 480,
      criteria: [
        'The operator is running again',
        'The missing instance was recreated',
        'The cluster is healthy with 3 of 3 ready',
      ],
      brief: `Scale the operator back up and watch it notice, within one reconciliation, that the cluster it is responsible for is short an instance.

It recreates the missing Pod, reattaches it to the claim that was never deleted, and lets it catch up by replaying WAL. The status resource starts telling the truth again at the same time.

That is the whole value proposition in one observation: the operator is not on the data path, and losing it costs you no availability — it costs you *repair*. A cluster without one keeps serving and stops healing.`,
      instructions: `Bring the operator back:

\`\`\`
kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=1
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
\`\`\`

Then watch the cluster repair itself:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

The third instance is recreated within seconds of the operator starting, and rejoins as a replica. It is quick because only the Pod was ever gone — its PersistentVolumeClaim was untouched, so there is nothing to clone, just WAL to replay.

Confirm replication is back to full strength:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT count(*) FROM pg_stat_replication;"
kubectl get pvc
\`\`\`

Two replicas streaming again, three claims, all of the same age they have been throughout.`,
      hint: `If the Pod has not appeared, give the operator a few more seconds — it has to acquire the leader-election Lease before it starts reconciling anything.`,
      solution: `kubectl -n cnpg-system scale deploy cnpg-controller-manager --replicas=1
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl get pods -l cnpg.io/cluster=pg-cluster -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT count(*) FROM pg_stat_replication;"
kubectl get pvc`,
    },
  ],
}
