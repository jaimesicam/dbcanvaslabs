// The slot names, the default-on behaviour and the catch-up-from-slot result are confirmed
// live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): a healthy
// 3-instance cluster already carried _cnpg_pg_cluster_2 and _cnpg_pg_cluster_3 as active
// physical slots with no configuration applied, and a fenced instance rejoined and had the
// rows written during its outage. Grading reads pg_replication_slots on the primary and the
// data on the instance that was away.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster, the cnpg plugin, a
// client Pod and the toolbox are this lab's starting state, built by its own provisioning.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgReplicationSlots = {
  id: 'cnpg-replication-slots',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster that is already replicating through slots, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, and the slots are created as each replica joins.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", with high-availability replication slots already active — nothing was configured to switch them on',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'Nothing here needs switching on: CloudNativePG manages replication slots for you by default, and two of them already exist. You will find them and work out what they are for, then take a standby away and prove that its slot is what lets it rejoin by catching up rather than being rebuilt from scratch — and finally turn the feature off and watch what the cluster loses. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'find-the-slots',
      title: 'Find the slots nobody created',
      limitSec: 420,
      criteria: [
        'High-availability replication slots are enabled on the Cluster',
        'The primary holds one physical slot per replica, named with the _cnpg_ prefix',
        '/root/slots.txt was written',
        'It names the slots the primary is holding',
      ],
      brief: `A replication slot is PostgreSQL's way of letting a standby say "do not throw away WAL I have not read yet". Without one, a primary recycles WAL on its own schedule and a standby that falls too far behind can never catch up — it has to be rebuilt.

CloudNativePG creates and manages these for you, and it is on by default. Two slots already exist on this cluster and nobody asked for them.

Find them, and record their names in \`/root/slots.txt\`. Work in the **toolbox** tab, which has jq and psql.`,
      instructions: `Start with what the Cluster says about slots — this is the configuration nobody wrote:

\`\`\`
kubectl get cluster pg-cluster -o json | jq .spec.replicationSlots
\`\`\`

\`highAvailability\` is enabled with a \`slotPrefix\` of \`_cnpg_\`, \`synchronizeReplicas\` is enabled, and there is an \`updateInterval\`. All of it is the operator's default.

Now the slots themselves, on the primary. Read them as the superuser over the Pod's own socket, because \`restart_lsn\` is not visible to an ordinary application role:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
echo "primary: $PRIMARY"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, slot_type, active, restart_lsn FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

Two slots, both \`physical\`, both \`active\`, one named after each replica. The name is the prefix plus the instance name with its dashes flattened — so \`pg-cluster-2\` is held by \`_cnpg_pg_cluster_2\`.

\`restart_lsn\` is the important column: it is the oldest WAL position that slot still needs, and the primary will not recycle anything past it. That single number is the whole mechanism.

Record the names:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT slot_name FROM pg_replication_slots ORDER BY slot_name;" > /root/slots.txt
cat /root/slots.txt
\`\`\`

One last thing worth seeing — the slots exist on the *primary*, and the standbys each have their own view:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

A standby carries slots too, kept in step by the operator, so that whichever instance is promoted already has the slots the others need. That is what \`highAvailability\` means here: the slots survive a change of primary.`,
      hint: `Read the slots as \`-U postgres\` from inside an instance Pod. A connection as the application role sees the rows but not \`restart_lsn\`, which is the column that matters.`,
      solution: `kubectl get cluster pg-cluster -o json | jq .spec.replicationSlots
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT slot_name, slot_type, active, restart_lsn FROM pg_replication_slots ORDER BY slot_name;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT slot_name FROM pg_replication_slots ORDER BY slot_name;" > /root/slots.txt
cat /root/slots.txt
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -c "SELECT slot_name, active FROM pg_replication_slots ORDER BY slot_name;"`,
    },

    {
      id: 'slot-holds-wal',
      title: 'Take a standby away and watch its slot hold the line',
      limitSec: 600,
      criteria: [
        "A row noted 'during-fence' was written on the primary while pg-cluster-3 was away",
        'pg-cluster-3 is streaming again',
        'It caught up from the WAL its slot retained — the row is on pg-cluster-3',
        '/root/slot-lsn.txt was written',
        'It records the restart_lsn the slot was holding',
      ],
      brief: `Now prove what the slot is actually doing, by taking a standby away and writing while it is gone.

Fencing an instance stops PostgreSQL on it without deleting anything — the Pod stays, the data stays, and the instance simply stops replicating. That is a clean stand-in for a node that has gone away for maintenance.

While it is down, watch its slot: it goes inactive but keeps its \`restart_lsn\`, and the primary stops recycling WAL past that point. Then bring the instance back and check the row you wrote in the meantime is there.

The thing to take away is what did *not* happen: no rebuild, no re-clone, no \`pg_basebackup\`. It read the WAL that was kept for it.`,
      instructions: `Set up something to write into, and take a starting point:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE slot_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO slot_demo (note) VALUES ('before-fence');"
\`\`\`

Now take \`pg-cluster-3\` away:

\`\`\`
kubectl cnpg fencing on pg-cluster pg-cluster-3
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

One standby left. Look at what happened to its slot:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, active, restart_lsn, wal_status FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

\`_cnpg_pg_cluster_3\` is now \`active = f\` — nothing is connected to it — but it still has a \`restart_lsn\`, and \`wal_status\` is \`reserved\`. The primary is holding WAL for an instance that is not there.

Record that position, because it is the promise being made:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT restart_lsn FROM pg_replication_slots WHERE slot_name = '_cnpg_pg_cluster_3';" > /root/slot-lsn.txt
cat /root/slot-lsn.txt
\`\`\`

Write while it is away, so there is something it must catch up on:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO slot_demo (note) VALUES ('during-fence') RETURNING *;"
\`\`\`

Now bring it back:

\`\`\`
kubectl cnpg fencing off pg-cluster pg-cluster-3
sleep 30
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Streaming again. And the row written while it was gone:

\`\`\`
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM slot_demo ORDER BY id;"
\`\`\`

Both rows, on an instance that was switched off when the second one was written. Check the Pod as well — same Pod, no restarts, nothing re-created:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\``,
      hint: `Give the fence 20 seconds or so to take effect before reading \`pg_stat_replication\`, and about 30 after unfencing before expecting the row — PostgreSQL has to start, reconnect and replay.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE slot_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO slot_demo (note) VALUES ('before-fence');"
kubectl cnpg fencing on pg-cluster pg-cluster-3
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT slot_name, active, restart_lsn, wal_status FROM pg_replication_slots ORDER BY slot_name;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT restart_lsn FROM pg_replication_slots WHERE slot_name = '_cnpg_pg_cluster_3';" > /root/slot-lsn.txt
cat /root/slot-lsn.txt
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO slot_demo (note) VALUES ('during-fence') RETURNING *;"
kubectl cnpg fencing off pg-cluster pg-cluster-3
sleep 30
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM slot_demo ORDER BY id;"`,
    },

    {
      id: 'disable-ha-slots',
      title: 'Turn the feature off and see what is lost',
      limitSec: 420,
      criteria: [
        'highAvailability.enabled is set to false on the Cluster',
        'The _cnpg_ slots are gone from the primary',
        'Both replicas are still streaming without them',
      ],
      brief: `Finish by turning high-availability slots off, which is the quickest way to see what they were contributing.

The slots disappear, and — this is the part worth noticing — replication carries on perfectly well without them. Streaming does not need a slot. What a slot adds is the *guarantee* that the WAL a standby still needs will not be recycled while it is disconnected.

So the cost of switching this off is not visible on a healthy day. It shows up on the day a standby is away long enough for the primary to move on without it, and the standby comes back to find the WAL it needed is gone.`,
      instructions: `Turn it off:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"replicationSlots":{"highAvailability":{"enabled":false}}}}'
kubectl get cluster pg-cluster -o json | jq .spec.replicationSlots.highAvailability
\`\`\`

Give the operator a moment to reconcile, then look:

\`\`\`
sleep 20
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT slot_name, slot_type, active FROM pg_replication_slots ORDER BY slot_name;"
\`\`\`

Empty. The operator dropped the slots it had been managing.

Now the part that surprises people — check replication:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state, sent_lsn, replay_lsn FROM pg_stat_replication ORDER BY application_name;"
kubectl get cluster pg-cluster
\`\`\`

Both standbys still streaming, cluster still healthy. Nothing broke, because a streaming standby holds its connection open and the primary feeds it directly; the slot was never what carried the data.

Write something and watch it arrive anyway:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO slot_demo (note) VALUES ('no-slots') RETURNING *;"
sleep 5
kubectl exec pg-cluster-2 -c postgres -- psql -U postgres -d app -c "SELECT count(*) FROM slot_demo;"
\`\`\`

That is the whole trade. Slots cost you disk — WAL that cannot be recycled while a standby is behind — and buy you the certainty that a standby which comes back late can still catch up. Turning them off gives the disk back and takes the certainty away.`,
      hint: `The patch is a merge patch on \`spec.replicationSlots.highAvailability.enabled\`. Give the operator 15–20 seconds to reconcile before reading \`pg_replication_slots\` — the slots are dropped by the operator, not by the API server.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"replicationSlots":{"highAvailability":{"enabled":false}}}}'
kubectl get cluster pg-cluster -o json | jq .spec.replicationSlots.highAvailability
sleep 20
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT slot_name, slot_type, active FROM pg_replication_slots ORDER BY slot_name;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO slot_demo (note) VALUES ('no-slots') RETURNING *;"`,
    },
  ],
}
