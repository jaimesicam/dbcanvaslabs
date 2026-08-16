// The bootstrap, the read-only enforcement and the promotion are confirmed live against a
// real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a 1-instance replica cluster
// bootstrapped from a 3-instance source in about 60 seconds, appeared on the source's
// pg_stat_replication as an application named pg-replica, refused an INSERT with "cannot
// execute INSERT in a read-only transaction", and on detaching left recovery, accepted
// writes and moved to timeline 2 while the source stopped streaming to it. Grading reads the
// Cluster spec, pg_is_in_recovery(), the control file's timeline and the data.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy source cluster, a client Pod,
// a staged replica-cluster manifest and the toolbox are this lab's starting state, built by
// its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgReplicaCluster = {
  id: 'cnpg-replica-cluster',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes. The second database cluster you are about to create is real too, and will be bootstrapped from the first in front of you.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state" — the source, with its own CA and replication certificates in the pg-cluster-ca and pg-cluster-replication Secrets',
      'A replica-cluster manifest staged at /root/replica-cluster.yaml on the k3d-server node — written but deliberately not applied',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'There is one database cluster here and a manifest for a second one that has never been applied. You will stand up that second cluster as a replica of the first — a whole separate Cluster object that streams from another, rather than one more instance inside the same one — prove it is genuinely read-only, and then detach it and watch it become a database in its own right. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'create-replica-cluster',
      title: 'Stand up a cluster that follows another',
      limitSec: 600,
      criteria: [
        'A second Cluster named pg-replica exists',
        'It is healthy with its one instance ready',
        'The source cluster is streaming to it',
      ],
      brief: `A replica *cluster* is not the same thing as a replica *instance*. Adding an instance to a cluster gives you another Pod inside the same Cluster object, managed as one unit. A replica cluster is a separate Cluster — its own name, its own Services, its own Secrets, its own lifecycle — that happens to be following another one.

That is the shape you use across namespaces, across Kubernetes clusters, or across regions, and it is the foundation of a disaster-recovery topology.

Read the staged manifest before you apply it. Two fields do the work: \`bootstrap.pg_basebackup\` clones the source once to get a starting data directory, and \`replica.enabled\` is what keeps it a standby afterwards instead of letting it promote itself the moment the clone finishes.`,
      instructions: `The manifest was staged on the **k3d-server** node, so read it from that tab:

\`\`\`
cat /root/replica-cluster.yaml
\`\`\`

Look at \`externalClusters\` before anything else, because it is where the interesting constraint lives. The connection uses the user \`streaming_replica\` with \`sslmode: verify-full\`, and its key, certificate and CA come from the *source* cluster's own Secrets. No password appears anywhere — the source authenticates this connection with a certificate it issued itself.

Notice it connects to \`dbname: postgres\`. That is not arbitrary: the source's generated \`pg_hba.conf\` only lets \`streaming_replica\` reach the \`postgres\` database and the replication pseudo-database, and nothing else. It is a role for streaming, not for reading your data.

Apply it:

\`\`\`
kubectl apply -f /root/replica-cluster.yaml
kubectl get cluster
\`\`\`

Now switch to the **toolbox** tab and watch it build:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-replica
sleep 60
kubectl get cluster
\`\`\`

Two Cluster objects, both healthy. The new one took about a minute: a base backup of the source, then start and stream.

Now look at it from the source's side:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Three connections: \`pg-cluster-2\`, \`pg-cluster-3\` — the source's own instances — and \`pg-replica\`. The replica cluster is, to PostgreSQL, just another streaming standby. What makes it a *cluster* is entirely on the Kubernetes side: a separate object with its own Services.

\`\`\`
kubectl get svc | grep pg-replica
\`\`\`

Its own \`-rw\`, \`-ro\` and \`-r\` Services, which is the practical point — applications reach it by its own names, not the source's.`,
      hint: `The manifest is on the **k3d-server** node, where it was staged; a file lives on one machine. Apply it from that tab, then use the toolbox for the rest.`,
      solution: `cat /root/replica-cluster.yaml
kubectl apply -f /root/replica-cluster.yaml
kubectl get cluster
sleep 60
kubectl get cluster
kubectl get pods -l cnpg.io/cluster=pg-replica
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl get svc | grep pg-replica`,
    },

    {
      id: 'verify-read-only',
      title: 'Prove it is really a follower',
      limitSec: 480,
      criteria: [
        'pg-replica-1 is in recovery — it is a standby, not a primary',
        'It carries the row written on the source before it was created',
        'It refuses writes: a read-only transaction error, not a permissions error',
        '/root/replica-state.txt was written',
        'It records that the replica was in recovery',
      ],
      brief: `Three questions decide whether this is really a replica, and the third is the one people skip.

Is it in recovery? Does it have the source's data? And does it refuse to be written to?

That last one matters because a replica cluster which quietly accepted writes would be the worst possible outcome — two databases diverging while both look healthy. Try the write and read the error carefully. It should be a *read-only transaction* error, which is PostgreSQL refusing on principle, not a permissions error, which would mean it accepted the idea and only objected to who you are.`,
      instructions: `Write a row on the source first, so there is something to look for:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE replica_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO replica_demo (note) VALUES ('before-replica') RETURNING *;"
sleep 6
\`\`\`

Is the replica a standby?

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
\`\`\`

\`t\`. Record it:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();" > /root/replica-state.txt
cat /root/replica-state.txt
\`\`\`

Does it have the data?

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM replica_demo ORDER BY id;"
\`\`\`

The row is there, on a cluster that did not exist when it was written — the base backup brought the past and streaming brought the rest.

Now the important one. Try to write to it:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO replica_demo (note) VALUES ('should-fail');"
\`\`\`

\`ERROR: cannot execute INSERT in a read-only transaction\`. Note what that error is *not*: it is not about privileges. This is the superuser being refused, because the whole instance is in recovery and recovery does not accept writes from anyone.

Watch a change flow through while you are here:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO replica_demo (note) VALUES ('streamed') RETURNING *;"
sleep 6
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM replica_demo;"
\`\`\`

Two rows. It is following continuously, not holding a snapshot.`,
      hint: `The failing INSERT is the point of the objective, so run it and read the message — a command that returns an error is the expected result here, not a mistake.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE replica_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO replica_demo (note) VALUES ('before-replica') RETURNING *;"
sleep 6
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();" > /root/replica-state.txt
cat /root/replica-state.txt
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM replica_demo ORDER BY id;"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO replica_demo (note) VALUES ('should-fail');"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO replica_demo (note) VALUES ('streamed') RETURNING *;"`,
    },

    {
      id: 'detach',
      title: 'Detach it and make it a database of its own',
      limitSec: 480,
      criteria: [
        'replica.enabled is set to false on pg-replica',
        'pg-replica-1 has been promoted out of recovery',
        "It is on a new timeline — its own lineage, not the source's",
        "A row noted 'after-detach' was accepted, so it takes writes now",
      ],
      brief: `Detaching is the operation this topology exists for. It is what you do when the source is gone and the replica has to take over, and it is one field.

Set \`replica.enabled\` to false. The operator promotes the instance out of recovery and the cluster becomes an ordinary, writable database.

The detail worth watching for is the timeline. PostgreSQL numbers each lineage of a database's history, and a promotion starts a new one. Before the detach this cluster is on timeline 1 — the source's history, copied. After it, timeline 2: its own history, which from this moment diverges from the source's and can never be merged back by streaming.

That is why detaching is not reversible. You are not pausing the relationship, you are ending it.`,
      instructions: `Note the timeline before you touch anything:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();"
\`\`\`

\`1\`. Now detach:

\`\`\`
kubectl patch cluster pg-replica --type=merge -p '{"spec":{"replica":{"enabled":false}}}'
sleep 40
kubectl get cluster
\`\`\`

Both clusters healthy, and no longer related. Check the promotion:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();"
\`\`\`

\`f\` and \`2\`. Out of recovery, and on a lineage of its own.

It takes writes now:

\`\`\`
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO replica_demo (note) VALUES ('after-detach') RETURNING *;"
\`\`\`

The same statement that was refused a moment ago. And the source has stopped feeding it:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Back to two connections — its own instances. Prove the divergence is real by writing to the source and finding it does not arrive:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO replica_demo (note) VALUES ('source-only') RETURNING *;"
sleep 8
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM replica_demo ORDER BY id;"
\`\`\`

The detached cluster has its own \`after-detach\` row and not the source's \`source-only\` row. Two databases, one shared history, and separate futures.`,
      hint: `Give the promotion 30–40 seconds. It is a real PostgreSQL promotion — the instance leaves recovery, writes a new timeline into its control file and reopens for writes.`,
      solution: `kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();"
kubectl patch cluster pg-replica --type=merge -p '{"spec":{"replica":{"enabled":false}}}'
sleep 40
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT pg_is_in_recovery();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();"
kubectl exec pg-replica-1 -c postgres -- psql -U postgres -d app -c "INSERT INTO replica_demo (note) VALUES ('after-detach') RETURNING *;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO replica_demo (note) VALUES ('source-only') RETURNING *;"`,
    },
  ],
}
