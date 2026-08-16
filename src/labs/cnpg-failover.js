// Promotion behaviour, timeline numbers and replication state below are confirmed live
// against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). Grading runs
// server-side, against the real cluster, comparing what is true now against the primary
// this environment was built with.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a
// client Pod are this lab's starting state, built by its own provisioning, because the
// subject is what the operator does when that primary dies. No reference to any other lab
// (see CLAUDE.md, "Lab content contract").

export const cnpgFailover = {
  id: 'cnpg-failover',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster with real streaming replication, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here. It also means the failure you cause is real, and the recovery you watch is the operator genuinely reacting to it.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — one primary and two replicas streaming from it asynchronously, on timeline 1, spread across the three nodes',
      'The pg-cluster-rw, pg-cluster-ro and pg-cluster-r Services the operator maintains for it',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client, outside the database, to connect from',
    ],
    yourJob:
      'Nothing is broken yet, and the database is empty. You will map the replication topology as it stands, write a row whose survival matters, then destroy the primary outright the way a node failure would — and watch an unplanned promotion happen without you asking for one, on a new timeline, with the other replica re-attaching to a primary it was never told about.',
  },

  tasks: [
    {
      id: 'map-replication',
      title: 'Map the replication topology',
      limitSec: 360,
      criteria: [
        'Two replicas are streaming from the primary',
        '/root/pre-failover-primary.txt was written',
        'It names the instance that is primary',
      ],
      brief: `Before breaking anything, write down what "working" looks like, so the change is measurable rather than impressive.

Find which instance is primary, and ask that instance who is streaming from it. Both replicas should be present and streaming, asynchronously. Record the primary's name in \`/root/pre-failover-primary.txt\`.

Note also which timeline the cluster is on. A timeline is PostgreSQL's record of the line of succession, and a promotion always starts a new one — so it is the most honest single number for telling whether a failover has actually happened.`,
      instructions: `Find the primary. The operator labels exactly one instance Pod with the role:

\`\`\`
kubectl get pods -L cnpg.io/instanceRole -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

Ask the primary who is replicating from it. Replication statistics are privileged, so connect as the superuser over the Pod's own local socket rather than as the application user:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Two rows, both \`streaming\`, both \`async\`. Those are the two replicas, and either of them is a candidate to be promoted if the primary disappears.

Note the timeline the cluster is on:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
\`\`\`

It is 1: nothing has ever been promoted here. Record which instance is primary:

\`\`\`
echo pg-cluster-1 > /root/pre-failover-primary.txt
\`\`\``,
      hint: `Use the pod that \`kubectl get pods -L cnpg.io/instanceRole\` marks \`primary\` — \`pg_stat_replication\` is empty on a replica, because a replica has nobody streaming from it.`,
      solution: `kubectl get pods -L cnpg.io/instanceRole -o wide
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication ORDER BY application_name;"
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}' > /root/pre-failover-primary.txt`,
    },

    {
      id: 'write-before',
      title: 'Write something worth losing',
      limitSec: 360,
      criteria: ["A row noted 'before-failover' exists on the primary", 'Both replicas have already replicated it'],
      brief: `Write the data whose survival is the actual subject here. The database is empty right now, and a failover that loses committed data is not a failover anyone wants.

Create a table through the read-write Service, insert a row noted \`before-failover\`, and then confirm both replicas have it before you go any further.

Checking both, rather than one, matters: whichever replica gets promoted has to already hold this row, because after promotion there is nowhere else for it to come from.`,
      instructions: `The \`psql-client\` Pod already has the app credentials in its environment, so name a host and go:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE failover_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO failover_proof (note) VALUES ('before-failover') RETURNING *;"
\`\`\`

Now confirm it has reached both replicas — not through a Service, which would pick one for you, but by asking each instance directly:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -c "SELECT * FROM failover_proof;"
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM failover_proof;"
\`\`\`

Both have the row. Replication here is asynchronous, so this is worth stating precisely: the row is on both replicas because they are caught up, not because the commit waited for them. A commit on this cluster returns as soon as the primary has flushed it locally.`,
      hint: `Write through \`pg-cluster-rw\`, and read from the instance Pods by name. A write sent to a replica fails with "cannot execute INSERT in a read-only transaction".`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE failover_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO failover_proof (note) VALUES ('before-failover') RETURNING *;"
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -c "SELECT * FROM failover_proof;"
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM failover_proof;"`,
    },

    {
      id: 'kill-primary',
      title: 'Destroy the primary and watch the promotion',
      limitSec: 480,
      criteria: [
        'A different instance was promoted to primary',
        'pg-cluster-rw now points at the newly-promoted primary',
        'The instance you deleted has rejoined the cluster',
        'Cluster reports healthy again',
      ],
      brief: `Now cause a real, unplanned failure: delete the primary Pod outright, with no grace period, the way an out-of-memory kill or a lost node would take it.

Nothing about this asks the operator for a failover. It notices the primary is gone, picks a replica, promotes it, and repoints the read-write Service — all without you naming a successor.

Then keep watching. The Pod you deleted is recreated and rejoins the cluster, but as a replica: the instance that was promoted keeps the role. Wait for the cluster to report healthy again before you check your work.`,
      instructions: `Delete the primary Pod. No cordon, no drain, no grace period — this is meant to look like a crash:

\`\`\`
kubectl delete pod pg-cluster-1 --grace-period=0 --force
\`\`\`

Immediately watch the cluster's own account of it:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole -o wide
\`\`\`

Within seconds one of the replicas is labelled \`primary\` — the operator saw the instance go away, chose a successor, and promoted it. You did not choose it and you did not have to be watching.

Check where the read-write Service points now:

\`\`\`
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw
\`\`\`

That address belongs to the newly-promoted Pod. A client holding the Service name needs no configuration change; a client that had been told a Pod name would now be pointing at nothing.

Keep watching until the deleted instance comes back:

\`\`\`
kubectl get pods -L cnpg.io/instanceRole -o wide
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

It is recreated, rejoins as a replica, and the cluster returns to "Cluster in healthy state" with 3 of 3 ready. It does not take its old role back.`,
      hint: `If the cluster still reads "Failing over" or shows 2/3 ready, give it a few more seconds — the promotion is quick, but the deleted instance being recreated and catching up takes longer.`,
      solution: `kubectl delete pod pg-cluster-1 --grace-period=0 --force
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -L cnpg.io/instanceRole -o wide
kubectl get endpointslices -l kubernetes.io/service-name=pg-cluster-rw`,
    },

    {
      id: 'verify-timeline',
      title: 'Confirm the new line of succession',
      limitSec: 420,
      criteria: [
        'The promoted primary is on a new timeline',
        'Two replicas are streaming from the new primary',
        "The 'before-failover' row survived the failover",
        '/root/new-timeline.txt was written',
        "It records the cluster's current timeline",
      ],
      brief: `A promotion is not only a change of labels — it starts a new timeline, and every other instance has to follow the new one or be left behind.

Read the cluster's timeline: it was 1 before, and it is 2 now. Ask the new primary who is streaming from it, and you should find both other instances, including the one you destroyed. Then read your row back, because an intact cluster that lost the data would be no comfort at all.

Record the current timeline in \`/root/new-timeline.txt\`. It is the number that says a promotion really happened, as opposed to a Pod merely having been restarted.`,
      instructions: `Read the timeline the cluster is on now:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
\`\`\`

It is 2. When PostgreSQL promotes a standby it starts a new timeline, so the history of the database forks at the moment of promotion — that is what makes it impossible for two instances to quietly diverge along the same line.

Ask PostgreSQL itself, on the new primary:

\`\`\`
kubectl get pods -L cnpg.io/instanceRole
kubectl exec <new-primary> -c postgres -- psql -U postgres -c "SELECT timeline_id FROM pg_control_checkpoint();"
kubectl exec <new-primary> -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Two rows again, both streaming — and one of them is the instance you deleted. It came back, found the cluster on a new timeline, and followed it without being re-cloned from scratch.

Now the part that matters most:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM failover_proof;"
\`\`\`

The \`before-failover\` row is there, served by an instance that was a replica a minute ago. Record the timeline:

\`\`\`
echo 2 > /root/new-timeline.txt
\`\`\``,
      hint: `Substitute the Pod that \`kubectl get pods -L cnpg.io/instanceRole\` now marks \`primary\` — it is one of the two instances you did not delete.`,
      solution: `kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}'
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT timeline_id FROM pg_control_checkpoint();"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM failover_proof;"
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.timelineID}' > /root/new-timeline.txt`,
    },
  ],
}
