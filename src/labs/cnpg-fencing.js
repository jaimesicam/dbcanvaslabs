// What fencing does and does not do is confirmed live against a real K3D + CloudNativePG
// deploy (server/, see LABORATORY.md): `kubectl cnpg fencing on` sets the annotation
// cnpg.io/fencedInstances to ["pg-cluster-3"], the Pod stays with restartCount 0 but goes
// Ready=False, only /controller/manager is left running inside it (no postgres process at
// all) and psql over the Pod's socket fails with "No such file or directory". Unfencing
// brings it back and it catches up. Grading reads the annotation, the Pod's conditions, the
// socket and the data.
//
// Worked from the `toolbox` tab, which carries jq and psql (server/toolbox.go).
//
// Self-contained, like every lab here: the operator, a healthy cluster, the cnpg plugin, a
// client Pod and the toolbox are this lab's starting state, built by its own provisioning.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgFencing = {
  id: 'cnpg-fencing',
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
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", with all three instances streaming',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes and in the toolbox, so kubectl cnpg works from any terminal tab',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment — a real application client to write from',
    ],
    yourJob:
      'Fencing is the operation you reach for when an instance has to stop being part of the cluster without being destroyed — before surgery on its data, or to stop a suspect instance serving. You will fence one, work out precisely what was stopped and what was left alone, keep writing to the rest of the cluster while it is out, and then bring it back. Work in the toolbox tab.',
  },

  tasks: [
    {
      id: 'fence-an-instance',
      title: 'Fence an instance and find out what stopped',
      limitSec: 480,
      criteria: [
        'The cluster carries a cnpg.io/fencedInstances annotation naming pg-cluster-3',
        'Its Pod is still there, but not Ready — so it is out of the Services',
        'PostgreSQL inside it is stopped — the socket is gone',
        '/root/fenced.txt was written',
        'It records which instance was fenced',
      ],
      brief: `Fencing stops PostgreSQL on an instance while leaving everything around it in place. It is not a delete, not a scale-down, and not a drain.

The distinction matters because those other operations destroy something. Fencing is what you want when the instance must stop *serving* but its data must stay exactly where it is — before you inspect a corrupt data directory, or when you suspect an instance is returning wrong answers and want it out of the read Services immediately.

Fence one instance, then work out what actually changed. Look at three places: the annotation on the Cluster, the Pod's readiness, and what processes are left inside the container. The answer to the third is the one that explains the other two.`,
      instructions: `Work in the **toolbox** tab. Note the healthy starting point:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Now fence one instance:

\`\`\`
kubectl cnpg fencing on pg-cluster pg-cluster-3
\`\`\`

The plugin is a convenience, not a mechanism. Look at what it actually did:

\`\`\`
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/fencedInstances"]'
\`\`\`

An annotation, \`["pg-cluster-3"]\`. That is the whole interface — you could have written it with \`kubectl annotate\` and got the same result, which is worth knowing when the plugin is not to hand.

Record it:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}' > /root/fenced.txt
cat /root/fenced.txt
\`\`\`

Give the operator a moment — the readiness probe takes a little under a minute to notice — then look at the Pod:

\`\`\`
sleep 45
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pod pg-cluster-3 -o json | jq -r '.status.conditions[] | [.type, .status] | @tsv'
\`\`\`

The Pod is still \`Running\` — but \`Ready\` is \`False\`. That is what takes it out of the Services: endpoints only carry ready Pods, so nothing is routed to it any more.

Now the part that explains everything. Look inside:

\`\`\`
kubectl exec pg-cluster-3 -c postgres -- ps aux
\`\`\`

One process: \`/controller/manager instance run\`. The instance manager is alive — that is why the container is still up and why the operator can still talk to it — and PostgreSQL is simply not running. Confirm from the other side:

\`\`\`
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -c "SELECT 1;"
\`\`\`

\`No such file or directory\` on the socket. There is no server to connect to.

And the primary has stopped feeding it:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\``,
      hint: `The \`kubectl exec ... psql\` against a fenced instance is *supposed* to fail — the missing socket is the evidence that PostgreSQL is stopped, not a mistake on your part.`,
      solution: `kubectl cnpg fencing on pg-cluster pg-cluster-3
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/fencedInstances"]'
kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/fencedInstances}' > /root/fenced.txt
cat /root/fenced.txt
sleep 45
kubectl get pod pg-cluster-3 -o json | jq -r '.status.conditions[] | [.type, .status] | @tsv'
kubectl exec pg-cluster-3 -c postgres -- ps aux
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -c "SELECT 1;"`,
    },

    {
      id: 'data-survives',
      title: 'Confirm nothing was destroyed',
      limitSec: 420,
      criteria: [
        'The fenced Pod was never restarted — fencing is not a delete',
        'Its PersistentVolumeClaim is still bound',
        'The rest of the cluster kept serving writes while it was fenced',
      ],
      brief: `Now account for what fencing left alone, because that is the reason to use it rather than deleting the Pod.

The Pod was not recreated — check its restart count and its age. The PersistentVolumeClaim is untouched, which means the data directory is exactly as it was at the moment PostgreSQL stopped. That is precisely the state you want for inspecting a suspect instance: stopped, but preserved.

Meanwhile the rest of the cluster carried on. Write to it and confirm, because a fencing operation that took the whole cluster down with it would be no use at all.`,
      instructions: `The Pod, and what happened to it:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp
\`\`\`

\`pg-cluster-3\` has a restart count of 0 and the same creation timestamp as before — the container was never recreated, PostgreSQL was simply stopped inside it.

Its volume:

\`\`\`
kubectl get pvc
\`\`\`

Still bound. The data directory is intact and frozen. This is why fencing is the right tool before you go and look at a data directory you suspect is damaged — a delete would have given you a fresh instance and destroyed the evidence.

Now check the cluster is still a working database. Write to it:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE fence_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO fence_demo (note) VALUES ('while-fenced') RETURNING *;"
\`\`\`

Accepted. Two of three instances is still a quorum of exactly nothing — PostgreSQL has no quorum requirement here — but more usefully, the primary is untouched and one standby is still streaming, so the cluster is doing its job with reduced redundancy.

Look at how the cluster reports itself:

\`\`\`
kubectl get cluster pg-cluster
kubectl cnpg status pg-cluster | head -20
\`\`\`

Read that carefully rather than skimming: the cluster reports fewer instances than it wants, and the fenced instance is called out by name. A cluster in this state is working but not healthy, and it will not heal on its own — fencing is a decision, and it stays until it is reversed.`,
      hint: `Compare the creation timestamps rather than the ages: the fenced Pod's timestamp is unchanged from before you fenced it, which is the direct evidence that nothing was recreated.`,
      solution: `kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp
kubectl get pvc
kubectl exec psql-client -- psql -h pg-cluster-rw -c "CREATE TABLE fence_demo (id serial primary key, note text, at timestamptz default now());"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO fence_demo (note) VALUES ('while-fenced') RETURNING *;"
kubectl get cluster pg-cluster
kubectl cnpg status pg-cluster | head -20`,
    },

    {
      id: 'unfence',
      title: 'Bring it back',
      limitSec: 480,
      criteria: [
        'pg-cluster-3 is no longer in the fencedInstances annotation',
        'Its Pod is Ready again, so it is back in the Services',
        'It is streaming from the primary again',
        'And it caught up on everything written while it was away',
      ],
      brief: `Unfencing removes the annotation, the instance manager starts PostgreSQL again, and the instance rejoins.

Watch what it does *not* need: no rebuild, no base backup, no manual resynchronisation. It starts, connects to the primary, and replays the WAL it missed — which is available because the cluster keeps a replication slot for it.

The row you wrote while it was fenced is the test. If it appears without anything being copied by hand, the instance genuinely caught up rather than being reconstructed.`,
      instructions: `Remove the fence:

\`\`\`
kubectl cnpg fencing off pg-cluster pg-cluster-3
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/fencedInstances"]'
\`\`\`

The annotation is cleared. Give it time to start and rejoin — this is a real PostgreSQL startup and catch-up:

\`\`\`
sleep 40
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get cluster pg-cluster
\`\`\`

Ready again, and the cluster is back to healthy. Check the process that was missing:

\`\`\`
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -tAc "SELECT 1;"
\`\`\`

Answers now. And the primary is feeding it again:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c \\
  "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Now the row written while it was away:

\`\`\`
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM fence_demo ORDER BY id;"
\`\`\`

There it is, on an instance whose PostgreSQL was not running when it was written. Nothing was copied by hand. The instance replayed WAL the primary had kept for it, which is the same mechanism that makes a brief node outage a non-event.

One last thing worth knowing, since it is the operational trap. Fencing the *primary* is allowed:

\`\`\`
kubectl cnpg fencing on pg-cluster pg-cluster-1 --dry-run=client 2>/dev/null || echo "(not attempting it — see the hint)"
\`\`\`

Do not actually do it here. Fencing every instance, or the primary without a plan, leaves a cluster with nothing able to accept writes and no automatic way out — the operator will not fail over to escape a fence, because the fence is an instruction from you.`,
      hint: `Fencing is a decision the operator will not overrule. There is no timeout and no automatic failover out of it, so a cluster fenced by mistake stays down until someone unfences it — which is exactly why the annotation is worth recognising on sight.`,
      solution: `kubectl cnpg fencing off pg-cluster pg-cluster-3
kubectl get cluster pg-cluster -o json | jq '.metadata.annotations["cnpg.io/fencedInstances"]'
sleep 40
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -tAc "SELECT 1;"
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state FROM pg_stat_replication ORDER BY application_name;"
kubectl exec pg-cluster-3 -c postgres -- psql -U postgres -d app -c "SELECT * FROM fence_demo ORDER BY id;"`,
    },
  ],
}
