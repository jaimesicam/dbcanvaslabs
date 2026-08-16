// Real phase strings and timings are confirmed live against a real K3D + CloudNativePG
// deploy (server/, see LABORATORY.md). Grading runs server-side.
//
// Self-contained, like every lab here: the operator is installed by this lab's own
// provisioning because the subject is the Cluster resource, not the operator install.
// No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgClusterCreation = {
  id: 'cnpg-cluster-creation',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, with the CloudNativePG operator installed and waiting, thrown away when you finish. Nothing is simulated. Expect a few minutes, most of it spent pulling images and installing the operator for real.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator already installed and Running in the cnpg-system namespace, with all 11 postgresql.cnpg.io CRDs registered — done for you here, because this lab is about the Cluster resource, not the operator install',
      'A 3-instance Cluster manifest written to /root/cluster.yaml on k3d-server — staged only, deliberately not applied',
      'The PostgreSQL image pre-loaded into all three nodes, so instances start without downloading ~1.2 GB each',
    ],
    yourJob:
      'No PostgreSQL is running yet. You will apply the Cluster manifest yourself, watch the operator bootstrap three instances and pick a primary, then prove with real SQL that a write on the primary reaches a replica.',
  },

  tasks: [
    {
      id: 'apply',
      title: 'Apply the Cluster manifest',
      limitSec: 300,
      criteria: ['cluster.postgresql.cnpg.io/pg-cluster exists', 'The primary instance has started coming up'],
      brief: `Ask the operator for a PostgreSQL cluster by applying a \`Cluster\` resource — a few lines of spec that the operator expands into pods, PVCs, Services and Secrets on its own.

Work in the **k3d-server** tab: \`/root/cluster.yaml\` was staged there when this environment was built. Read it, apply it, then watch the cluster object's STATUS column.

You do not have to wait for the whole cluster here — check as soon as the primary is past "Setting up primary".`,
      instructions: `The CloudNativePG operator was installed into this cluster while the environment was built, so it is already running and watching for \`Cluster\` resources. Now ask it for a 3-instance PostgreSQL cluster. A manifest is already staged on the \`k3d-server\` node — open that terminal tab and read it:

\`\`\`
cat cluster.yaml
\`\`\`

\`\`\`yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-cluster
  namespace: default
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie
  storage:
    size: 1Gi
\`\`\`

That's the entire spec CNPG needs — no StatefulSet, no PVC, no Service to write by hand; the operator generates all of it. (\`imageName\` is pinned here only so this environment can side-load that exact image into the nodes ahead of time; leave it out and CNPG picks its own default.) Apply it:

\`\`\`
kubectl apply -f cluster.yaml
\`\`\`

Then watch the first instance come up:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

This takes a few minutes: CNPG bootstraps one instance at a time — \`initdb\` on the primary, then a join job per replica — so the work is serial by design. (Each node's k3s runtime keeps its own image cache, so the ~1.2 GB Postgres image would otherwise be pulled once per node; this environment side-loads it into all three up front instead.) Move to the next objective once the primary is past **"Setting up primary"**.`,
      hint: `\`kubectl get cluster.postgresql.cnpg.io pg-cluster\` shows NAME / INSTANCES / READY / STATUS / PRIMARY — watch the STATUS column change.`,
      solution: `kubectl apply -f cluster.yaml
kubectl get cluster.postgresql.cnpg.io pg-cluster`,
    },

    {
      id: 'watch-healthy',
      title: 'Wait for all 3 instances and identify the primary',
      limitSec: 600,
      criteria: [
        'Cluster reports "Cluster in healthy state"',
        'READY is 3/3',
        'All 3 instances are scheduled on different nodes',
        '/root/primary.txt was written',
        'It names the actual primary',
      ],
      brief: `Wait for the operator to finish bootstrapping all three instances, then work out which one is the primary.

Poll the cluster until STATUS reads "Cluster in healthy state" and READY is 3/3 — expect several minutes, because CNPG bootstraps one instance at a time. Look at where the pods landed, then record the primary pod's name in \`/root/primary.txt\`.

Exactly one instance accepts writes; the other two stream from it. Knowing which is which is the whole point.`,
      instructions: `Keep polling until every instance is up:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
\`\`\`

And watch where the instances land:

\`\`\`
kubectl get pods -o wide
\`\`\`

STATUS moves \`Setting up primary\` → \`Creating a new replica\` → \`Waiting for the instances to become active\` → **\`Cluster in healthy state\`**, with READY climbing 0/3 → 1/3 → 2/3 → 3/3. CNPG's own anti-affinity spreads the 3 instances across all 3 nodes on its own — no \`nodeSelector\` or \`topologySpreadConstraint\` needed for a cluster this size.

Once it's healthy, find the primary (the one instance actually accepting writes):

\`\`\`
kubectl get pods -L cnpg.io/instanceRole
\`\`\`

Record its name:

\`\`\`
echo <pod-name> > /root/primary.txt
\`\`\``,
      hint: `The \`cnpg.io/instanceRole\` column reads \`primary\` for exactly one pod and \`replica\` for the other two — that's the same label CNPG's own Services select on.`,
      solution: `kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -o wide
kubectl get pods -L cnpg.io/instanceRole
echo pg-cluster-1 > /root/primary.txt`,
    },

    {
      id: 'connectivity',
      title: 'Prove the cluster actually accepts writes and replicates them',
      limitSec: 480,
      criteria: ['A row was written on the primary', 'It reads back identically from a different instance'],
      brief: `Prove the database actually works, instead of trusting the cluster's own health string.

Pull the \`app\` user's operator-generated password out of the \`pg-cluster-app\` Secret, create a table and insert a row on the primary, then read that same row back from a **different** instance.

Reading it somewhere else is the proof: it means streaming replication is genuinely running, not just that three pods happen to be up.`,
      instructions: `A healthy \`Cluster\` object is not proof anything actually works end to end — prove it with real SQL. The \`app\` user needs its operator-generated password, from the \`<cluster>-app\` Secret:

\`\`\`
export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
\`\`\`

Then create a table on the primary (use whichever pod name \`/root/primary.txt\` actually names):

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "CREATE TABLE pv_proof (id serial primary key, note text, created_at timestamptz default now());"
\`\`\`

And write a row into it:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "INSERT INTO pv_proof (note) VALUES ('connectivity-check') RETURNING *;"
\`\`\`

(Replicas reject writes with \`cannot execute INSERT in a read-only transaction\`, which is worth triggering once on purpose to see.)

Now read it back from a **different** instance, proving the write actually replicated rather than only existing on the primary's own disk:

\`\`\`
kubectl exec pg-cluster-2 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof;"
\`\`\``,
      hint: `If \`psql\` refuses the connection, double check \`$PGPASSWORD\` actually got set — \`echo $PGPASSWORD\` should print something, not an empty line.`,
      solution: `export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "CREATE TABLE pv_proof (id serial primary key, note text, created_at timestamptz default now());"
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "INSERT INTO pv_proof (note) VALUES ('connectivity-check') RETURNING *;"
kubectl exec pg-cluster-2 -c postgres -- env PGPASSWORD=$PGPASSWORD psql -h 127.0.0.1 -U app -d app -c "SELECT * FROM pv_proof;"`,
    },
  ],
}
