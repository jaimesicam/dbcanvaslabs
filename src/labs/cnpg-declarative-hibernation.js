// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md):
// annotating the Cluster cnpg.io/hibernation=on removed all three instance Pods within about ten
// seconds and left all three claims Bound, the Services present with no endpoints and the Secrets
// untouched. The trap is the status: phase still reads "Cluster in healthy state" with the READY
// column blank, and the only honest signal is a new condition, cnpg.io/hibernation True with
// reason Hibernated. The spec stays editable while it sleeps — max_connections was patched to 200
// with no Pods running — and `cnpg.io/hibernation=off` brought three Pods back in about 30
// seconds on the original volumes, with the edited setting in force and the condition gone.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster with a seeded
// table and a client Pod are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgDeclarativeHibernation = {
  id: 'cnpg-declarative-hibernation',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here, and the ones you shut down are really shut down.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster with three bound volumes, three Services and its generated Secrets',
      'A table called notes in its application database, owned by the app user, holding 50 rows',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A database nobody is using still costs what it costs, and deleting it is not the same as switching it off. Hibernation is CloudNativePG\'s answer: every instance Pod is removed and every volume is kept, so the compute stops and the data does not move. It is declared with a single annotation, which means a Git commit can do it — and it comes with a trap worth meeting once, because a hibernated cluster goes on describing itself as healthy.',
  },

  tasks: [
    {
      id: 'put-it-to-sleep',
      title: 'Switch it off with an annotation',
      limitSec: 480,
      criteria: [
        'The Cluster is annotated cnpg.io/hibernation: on',
        'Every instance Pod is gone',
        'All 3 volumes are still bound — the data is kept',
        'And the cluster reports a hibernation condition',
      ],
      brief: `Hibernation has no field of its own in the Cluster spec. It is an annotation, \`cnpg.io/hibernation\`, and setting it to \`on\` is the entire interface — which is what makes it declarative: the annotation lives in the manifest, so whatever manages your manifests manages the sleeping too.

Set it and watch the Pods go. What matters as much is what stays: the claims are left bound, which is the difference between hibernating a cluster and deleting one.

Then look at how the cluster describes itself, and be careful about what you believe. \`kubectl get cluster\` will tell you the cluster is healthy, because the operator has nothing to complain about. The signal that it is asleep is somewhere else.`,
      instructions: `Work in the **k3d-server** tab. Note what you have before switching it off:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
\`\`\`

Now put it to sleep:

\`\`\`
kubectl annotate cluster pg-cluster cnpg.io/hibernation=on
\`\`\`

Watch the instances disappear — this takes seconds, not minutes:

\`\`\`
for i in 1 2 3 4 5 6; do
  printf "%s " "$(date +%T)"
  kubectl get pods -l cnpg.io/cluster=pg-cluster --no-headers | wc -l
  sleep 5
done
\`\`\`

Three, then none. Every instance Pod has been deleted; PostgreSQL was shut down first, cleanly, on each of them.

Now the volumes:

\`\`\`
kubectl get pvc
\`\`\`

All three still \`Bound\`, with the same ages they had before. Nothing about your data has moved or been copied — the disks are simply not attached to anything at the moment.

Here is the part worth being careful about:

\`\`\`
kubectl get cluster pg-cluster
\`\`\`

STATUS reads *Cluster in healthy state* and the READY column is blank. The operator is not lying — there is nothing unhealthy about a cluster that was asked to stop — but anything watching that column for trouble will not notice this at all. The honest signal is a condition:

\`\`\`
kubectl get cluster pg-cluster \\
  -o jsonpath='{range .status.conditions[*]}{.type}{"\\t"}{.status}{"\\t"}{.reason}{"\\n"}{end}'
\`\`\`

Among them is \`type: cnpg.io/hibernation\`, \`status: "True"\`, \`reason: Hibernated\`. That is what monitoring should be looking at. Note \`ConsistentSystemID\` has gone \`False\` too, with reason \`NotFound\` — there are no instances left to report one.

Read the annotation back, since it is the thing you set and the thing a manifest would carry:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/hibernation}{"\\n"}'
\`\`\``,
      hint: `\`kubectl annotate\` adds the annotation; adding \`--overwrite\` lets it replace an existing value, which you will need when switching it back.`,
      solution: `kubectl get cluster pg-cluster
kubectl get pvc
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl annotate cluster pg-cluster cnpg.io/hibernation=on
sleep 20
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl get pvc
kubectl get cluster pg-cluster
kubectl get cluster pg-cluster \\
  -o jsonpath='{range .status.conditions[*]}{.type}{"\\t"}{.status}{"\\t"}{.reason}{"\\n"}{end}'
kubectl get cluster pg-cluster -o jsonpath='{.metadata.annotations.cnpg\\.io/hibernation}{"\\n"}'`,
    },

    {
      id: 'what-remains',
      title: 'Take stock of what is still standing',
      limitSec: 480,
      criteria: [
        'All three Services are still there',
        'And not one of them has an endpoint to send anything to',
        'The generated application Secret is untouched',
        'And the spec took an edit while it slept — max_connections now asks for 200',
      ],
      brief: `A hibernated cluster is not a deleted cluster, and the difference is a list of objects that are still there: the Services, the Secrets, the certificates, the claims. Only the Pods are gone.

That has a consequence worth seeing rather than being told. The Services exist and resolve, and they point at nothing — so a client does not get a DNS failure, it gets a connection refused, which is a different problem to debug at three in the morning.

Then use the fact that the Cluster object is still an ordinary, fully editable Kubernetes resource. Change something about the database while it is asleep, and it will be true when it wakes.`,
      instructions: `Look at what survived:

\`\`\`
kubectl get svc -l cnpg.io/cluster=pg-cluster
kubectl get secret
kubectl get pvc
\`\`\`

Three Services, the generated Secrets — application credentials, the CA, the server and replication certificates — and the three volumes. Everything except the instances.

Now ask each Service what it actually points at:

\`\`\`
for s in pg-cluster-rw pg-cluster-ro pg-cluster-r; do
  printf "%-14s " "$s"
  kubectl get endpointslices -l kubernetes.io/service-name=$s \\
    -o jsonpath='{.items[*].endpoints[*].addresses[*]}'
  echo
done
\`\`\`

Three empty lines. The Services are real, the names resolve, and there is nothing behind any of them. That is what a client sees:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;" 2>&1 | head -3
\`\`\`

\`Connection refused\` — not "no such host". Anything that treats a name resolving as a database being up will report this cluster as reachable right until it tries to use it.

Now edit the spec while it sleeps. There are no instances to reconcile, so nothing happens — yet:

\`\`\`
kubectl patch cluster pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"parameters":{"max_connections":"200"}}}}'
kubectl get cluster pg-cluster -o jsonpath='{.spec.postgresql.parameters}{"\\n"}'
kubectl get pods -l cnpg.io/cluster=pg-cluster --no-headers | wc -l
\`\`\`

The spec now asks for 200 connections and there is still not a single Pod. A hibernated cluster is a perfectly ordinary object that happens to have no instances — which makes hibernation a reasonable moment to make the changes you would rather not make to a running database.

Confirm the volumes are still exactly where they were:

\`\`\`
kubectl get pvc -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,VOLUME:.spec.volumeName,CREATED:.metadata.creationTimestamp
\`\`\``,
      hint: `An empty jsonpath result prints nothing at all, which is why the loop above adds its own \`echo\` — three blank lines is the answer you are looking for.`,
      solution: `kubectl get svc -l cnpg.io/cluster=pg-cluster
kubectl get secret
for s in pg-cluster-rw pg-cluster-ro pg-cluster-r; do printf "%-14s " "$s"; kubectl get endpointslices -l kubernetes.io/service-name=$s -o jsonpath='{.items[*].endpoints[*].addresses[*]}'; echo; done
kubectl exec psql-client -- psql -h pg-cluster-rw -c "SELECT 1;" 2>&1 | head -3
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"postgresql":{"parameters":{"max_connections":"200"}}}}'
kubectl get cluster pg-cluster -o jsonpath='{.spec.postgresql.parameters}{"\\n"}'
kubectl get pods -l cnpg.io/cluster=pg-cluster --no-headers | wc -l`,
    },

    {
      id: 'wake-it-up',
      title: 'Wake it up and check what came back',
      limitSec: 600,
      criteria: [
        'The hibernation annotation reads off',
        'All 3 instances are back, on volumes older than themselves',
        'The setting you changed while it slept is in force',
        'And the rows written before it slept are still there',
      ],
      brief: `Set the annotation to \`off\` and the operator does the obvious thing: it creates the instance Pods again, each one attached to the volume that was waiting for it. No copying, no rebuild, no \`pg_basebackup\` — the data never went anywhere.

The clearest evidence of that is an age mismatch. Look at the Pods and the claims side by side and you will find Pods that are seconds old sitting on volumes that are many minutes old. A cluster rebuilt from scratch could not produce that.

Then check the two things that prove the round trip was lossless in both directions: the rows you wrote before it slept, and the setting you changed while it did.`,
      instructions: `Wake it:

\`\`\`
kubectl annotate cluster pg-cluster cnpg.io/hibernation=off --overwrite
\`\`\`

Watch it come back — about half a minute for three instances:

\`\`\`
for i in 1 2 3 4 5 6; do
  printf "%s " "$(date +%T)"
  kubectl get cluster pg-cluster --no-headers
  sleep 10
done
\`\`\`

The primary starts first and the replicas follow, and the cluster reports *Cluster in healthy state* with three of three ready.

Now the age mismatch, which is the whole point:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp
kubectl get pvc -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp
\`\`\`

Every Pod is younger than the claim it is using. New processes, old disks.

Check the setting you changed while it was asleep:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SHOW max_connections;"
\`\`\`

200 — the instances started with the spec as it was when they started, not as it was when they stopped.

And the data:

\`\`\`
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl exec psql-client -- psql -h pg-cluster-rw -c "INSERT INTO notes (entry) VALUES ('written after waking up') RETURNING id;"
\`\`\`

Fifty rows, and writes work again.

Finally, the condition that told you it was asleep:

\`\`\`
kubectl get cluster pg-cluster \\
  -o jsonpath='{range .status.conditions[*]}{.type}{"\\t"}{.status}{"\\n"}{end}' | grep hibernation || echo "(no hibernation condition)"
\`\`\`

An empty list — the condition is removed rather than set to False, so anything alerting on it has to treat "absent" as awake.

Worth being clear about what hibernation is for, and what it is not. It suits a cluster that is genuinely idle — a demonstration environment, a seasonal workload, a per-branch database nobody is using tonight — and it costs nothing but the storage, which you are paying for anyway. It is not a backup: the volumes are still the only copy of the data, and nothing about being asleep protects them from being deleted. And it is not a way to save a cluster you are worried about, because a cluster with no instances running is a cluster whose replication has stopped, whose backups have stopped, and which nobody is watching.`,
      hint: `\`--overwrite\` is required when changing an annotation that already exists — without it \`kubectl annotate\` refuses rather than replacing the value.`,
      solution: `kubectl annotate cluster pg-cluster cnpg.io/hibernation=off --overwrite
sleep 45
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp
kubectl get pvc -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SHOW max_connections;"
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT count(*) FROM notes;"
kubectl get cluster pg-cluster \\
  -o jsonpath='{range .status.conditions[*]}{.type}{"\\t"}{.status}{"\\n"}{end}' | grep hibernation || echo "(no hibernation condition)"`,
    },
  ],
}
