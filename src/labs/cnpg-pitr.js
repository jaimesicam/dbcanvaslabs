// The recoveryTarget block, the timestamp format PostgreSQL prints and CloudNativePG
// accepts, and the fact that recovery genuinely stops at the target are confirmed live
// against a real K3D + CloudNativePG + SeaweedFS deploy (server/, see LABORATORY.md): a
// recovery targeting a moment between two commits produced a cluster holding the first row
// and not the second. Grading parses the recorded timestamp, compares it against both
// commit times, and reads both databases.
//
// Self-contained, like every lab here: the operator, the Barman Cloud plugin, a cluster
// already archiving WAL and a base backup already in the bucket are this lab's starting
// state, built by its own provisioning. No reference to any other lab (see CLAUDE.md,
// "Lab content contract").

export const cnpgPITR = {
  id: 'cnpg-pitr',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster, a real S3-compatible object store holding a real base backup, and a real PostgreSQL cluster archiving its WAL there continuously. All of it is thrown away when you finish. Nothing is simulated, which is why this is one of the longest builds of the set: cert-manager and the Barman Cloud plugin are installed and waited for, the database is bootstrapped, archiving is switched on, and a base backup is taken before you arrive.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage), published inside the cluster as the Service seaweedfs on port 8333, with a cnpg-backups bucket',
      'The CloudNativePG v1.30.0 operator, cert-manager v1.19.1 and the Barman Cloud plugin v0.14.0, all installed and Running',
      'A healthy 3-instance Cluster named pg-cluster, already archiving WAL to the bucket through the plugin, with an ObjectStore named seaweedfs-store describing the destination',
      'A completed Backup named base-backup — a real base backup, taken while this environment was built',
      'The cnpg kubectl plugin v1.30.0 on all three nodes, a psql-client Pod with the app credentials, and a recovery template staged at /root/pitr.yaml.template with the target time left as a placeholder for you to fill in',
    ],
    yourJob:
      'Everything needed to recover is in place, and the interesting question is not whether you can restore but *to when*. You will make two changes a few seconds apart, note the moment between them, and then recover a cluster to exactly that moment — landing between the two, with the first change present and the second one gone.',
  },

  tasks: [
    {
      id: 'write-and-mark',
      title: 'Make two changes, and note the moment between them',
      limitSec: 480,
      criteria: [
        "A row noted 'first' exists",
        "A row noted 'second' exists, committed after it",
        '/root/target-time.txt was written',
        'It holds a moment between the two rows',
      ],
      brief: `Point-in-time recovery needs a point in time, so make one worth aiming at.

Write a row noted \`first\`, read the database's own clock and record it in \`/root/target-time.txt\`, then write a row noted \`second\`. The moment you recorded now sits strictly between two commits, which is what makes the recovery afterwards a proof rather than a coincidence.

Use the database's clock, not the node's. The recovery target is compared against commit timestamps inside the WAL, and PostgreSQL prints exactly the format the recovery target accepts.`,
      instructions: `Create the table and write the first row:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE pitr_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pitr_proof (note) VALUES ('first') RETURNING *;"
\`\`\`

Now take the timestamp from the database itself, and keep it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now();" > /root/target-time.txt
cat /root/target-time.txt
\`\`\`

It looks like \`2026-08-15 11:13:31.110651+00\` — the exact form a recovery target accepts, which is why taking it from PostgreSQL rather than from \`date\` is worth doing.

Wait a moment so the two commits are clearly separated, then write the second row:

\`\`\`
sleep 5
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pitr_proof (note) VALUES ('second') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pitr_proof ORDER BY id;"
\`\`\`

Both rows, with their commit times on either side of the moment you recorded. Push the WAL holding them into the archive so it is available to recover from:

\`\`\`
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"
kubectl cnpg status pg-cluster | grep -i "waiting to be archived"
\`\`\``,
      hint: `Take the timestamp *between* the two inserts — recorded before the first or after the second, it cannot separate them, and the recovery would prove nothing. \`-tAc\` gives the bare value with no headers or padding.`,
      solution: `kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE pitr_proof (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pitr_proof (note) VALUES ('first') RETURNING *;"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now();" > /root/target-time.txt
sleep 5
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO pitr_proof (note) VALUES ('second') RETURNING *;"
PRIMARY=$(kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT pg_switch_wal();"`,
    },

    {
      id: 'restore-to-target',
      title: 'Recover to that exact moment',
      limitSec: 600,
      criteria: [
        'cluster.postgresql.cnpg.io/pg-pitr exists',
        'Its bootstrap declares a recoveryTarget targetTime',
        'The targetTime is the moment you recorded',
        'The recovered cluster reports healthy',
      ],
      brief: `Now recover to that moment. The manifest is the same shape as any recovery — bootstrap from an external cluster backed by the object store — with one addition: a \`recoveryTarget\` giving the time to stop at.

It is staged as a template with the target left blank, because filling it in is the point of the exercise. Substitute the timestamp you recorded and apply the result.

PostgreSQL will fetch the base backup, replay WAL forward, and stop the moment it reaches a commit past your target. Everything after that instant is simply never applied.`,
      instructions: `Look at the template first:

\`\`\`
cat /root/pitr.yaml.template
\`\`\`

Everything is the same as an ordinary recovery except \`recoveryTarget.targetTime\`, which reads \`TARGET_TIME\`. Substitute the moment you recorded:

\`\`\`
sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr.yaml.template > /root/pitr.yaml
grep -A2 recoveryTarget /root/pitr.yaml
\`\`\`

Check that line reads back as the timestamp you took from the database, then apply it:

\`\`\`
kubectl apply -f /root/pitr.yaml
kubectl get cluster.postgresql.cnpg.io
\`\`\`

The recovery runs as a Job — fetching the base backup, then replaying WAL up to your target — and the cluster then reports "Cluster in healthy state" with 1 of 1 ready. The original is untouched throughout.

Confirm the target the operator recorded on the resource:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-pitr -o jsonpath='{.spec.bootstrap.recovery}{"\\n"}'
\`\`\``,
      hint: `\`sed\` writes the substituted manifest to a new file — apply \`/root/pitr.yaml\`, not the \`.template\`. If the apply is rejected, check the timestamp landed inside the quotes exactly as PostgreSQL printed it.`,
      solution: `cat /root/pitr.yaml.template
sed "s/TARGET_TIME/$(cat /root/target-time.txt)/" /root/pitr.yaml.template > /root/pitr.yaml
grep -A2 recoveryTarget /root/pitr.yaml
kubectl apply -f /root/pitr.yaml
kubectl get cluster.postgresql.cnpg.io
kubectl get cluster.postgresql.cnpg.io pg-pitr -o jsonpath='{.spec.bootstrap.recovery}{"\\n"}'`,
    },

    {
      id: 'verify-pitr',
      title: 'Land between the two changes',
      limitSec: 420,
      criteria: [
        "The recovered cluster contains the 'first' row",
        "The 'second' row is absent — recovery stopped at your target",
        'The original cluster still has both rows',
      ],
      brief: `Read the recovered database and count the rows. There should be exactly one.

The \`first\` row was committed before your target, so replay applied it. The \`second\` was committed after, so replay stopped short of it — the WAL containing it is sitting in the archive, perfectly intact, and was deliberately not applied.

That is the difference between a restore and a point-in-time recovery, and it is what makes PITR the tool for undoing a mistake: you recover to just before it, not to the last backup and not to now.`,
      instructions: `Read the recovered cluster:

\`\`\`
kubectl exec pg-pitr-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM pitr_proof ORDER BY id;"
\`\`\`

One row, \`first\`. Now the original, which has been running the whole time:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pitr_proof ORDER BY id;"
\`\`\`

Two rows. Nothing was lost anywhere: the archive still holds the WAL for the second row, and the original still holds the row itself. The recovered cluster is a deliberate view of one instant.

Look at what you ended up with:

\`\`\`
kubectl get cluster.postgresql.cnpg.io
kubectl get pods -o wide
\`\`\`

Two independent clusters — the running one and a copy of it as it was at the moment you chose.`,
      hint: `If the recovered cluster has both rows, the target was taken after the second insert; if it has neither, the target predates the first. The timestamp has to come from between them.`,
      solution: `kubectl exec pg-pitr-1 -c postgres -- psql -U postgres -d app -c "SELECT * FROM pitr_proof ORDER BY id;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT * FROM pitr_proof ORDER BY id;"
kubectl get cluster.postgresql.cnpg.io
kubectl get pods -o wide`,
    },
  ],
}
