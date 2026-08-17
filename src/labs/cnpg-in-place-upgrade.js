// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md).
// Upgrading the operator 1.29.2 → 1.30.0 with the default configuration replaced all three
// instance Pods — replicas first, primary last, every creationTimestamp moving — because the
// instance manager travels inside the Pod. With ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true in
// the operator ConfigMap the same version change left every Pod exactly where it was:
// creationTimestamps unchanged, restart counts 0, cnpg.io/operatorVersion moving to 1.30.0 on
// its own. The spelling trap is real and was hit while building this lab —
// ENABLE_INSTANCE_MANAGER_IN_PLACE_UPDATES (with the extra underscore) is accepted in silence
// and the operator logs `"enableInstanceManagerInplaceUpdates":false`.
//
// Self-contained, like every lab here: the previous operator release, a healthy 3-instance
// cluster, a client Pod and both release manifests are this lab's starting state, built by its
// own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgInPlaceUpgrade = {
  id: 'cnpg-in-place-upgrade',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real, deliberately out-of-date CloudNativePG operator and a real database for it to manage, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.29.2 operator — the previous minor release — installed and Running in the cnpg-system namespace, started with --config-map-name=cnpg-controller-manager-config, a ConfigMap that does not exist yet',
      'The v1.30.0 release manifest staged on the k3d-server node at /root/cloudnative-pg/releases/cnpg-1.30.0.yaml — downloaded, but deliberately not applied',
      'A healthy 3-instance Cluster named pg-cluster, each instance running an instance manager binary the v1.29.2 operator put there',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Every CloudNativePG instance runs a small agent from the operator called the instance manager, and when the operator is upgraded that agent has to be upgraded with it. By default the only way to change a binary inside a container is to replace the container — so upgrading the operator restarts every database it manages. There is a setting that changes this, and you will switch it on before performing the upgrade, then prove the databases were never touched. Work in the k3d-server tab, where the release manifest is staged.',
  },

  tasks: [
    {
      id: 'record-the-version',
      title: 'Find the operator inside the database Pods',
      limitSec: 420,
      criteria: [
        'The operator is running v1.29.2',
        'All 3 instances report the same version in cnpg.io/operatorVersion',
        '/root/before.txt was written',
        'It names the version the instances report',
      ],
      brief: `An operator is usually described as a thing that watches the API server and acts on it. CloudNativePG is that, and something else as well: a piece of it runs **inside every database Pod**.

That piece is the instance manager. It is PID 1 in the postgres container, it starts and stops PostgreSQL, runs the probes, streams the logs, and answers the operator. It is a binary from the operator's own image, copied into the instance at startup.

Which means the operator's version is not one number but two: the version of the controller in \`cnpg-system\`, and the version of the agent inside each instance. Right now they agree. Find both, and write down what the instances say — the whole lab is about what happens to that number when the controller moves on without them.`,
      instructions: `Work in the **k3d-server** tab. Start with the controller:

\`\`\`
kubectl -n cnpg-system get deploy cnpg-controller-manager \\
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl -n cnpg-system get pods
\`\`\`

Version 1.29.2, one replica, Running. Now find the same version inside the database Pods, where the operator stamps it on every instance it manages:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
\`\`\`

Three instances, all reporting 1.29.2, none of them ever restarted. That annotation is the operator's record of which version of itself is running inside that Pod.

You can see the agent directly, too — it is the process the container was started with:

\`\`\`
kubectl get pod pg-cluster-1 -o jsonpath='{.spec.containers[0].command}{"\\n"}'
kubectl exec pg-cluster-1 -c postgres -- ps -o pid,args -p 1
\`\`\`

\`/controller/manager instance run\` — the operator's own binary, running as PID 1 next to PostgreSQL. PostgreSQL is a child process of it, not the other way round.

Record what the instances report:

\`\`\`
kubectl get pod pg-cluster-1 \\
  -o jsonpath='{.metadata.annotations.cnpg\\.io/operatorVersion}' > /root/before.txt
cat /root/before.txt
\`\`\`

And note the ages, because the claim at the end of this lab is that they will still be climbing:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\``,
      hint: `Annotation keys contain dots, which have to be escaped inside a jsonpath or a custom-columns expression: \`.metadata.annotations.cnpg\\.io/operatorVersion\`.`,
      solution: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
kubectl exec pg-cluster-1 -c postgres -- ps -o pid,args -p 1
kubectl get pod pg-cluster-1 -o jsonpath='{.metadata.annotations.cnpg\\.io/operatorVersion}' > /root/before.txt
cat /root/before.txt`,
    },

    {
      id: 'enable-in-place',
      title: 'Switch on in-place instance manager updates',
      limitSec: 480,
      criteria: [
        'The operator ConfigMap switches in-place instance manager updates on',
        'And the operator has restarted since, so it has read it',
        'The database is untouched and still reports v1.29.2',
      ],
      brief: `The default answer to "the agent inside the container needs replacing" is to replace the container. That is correct, safe, and expensive: upgrading the operator means a rolling restart of every database it manages, which on an estate of clusters is an evening's work and an evening's risk.

CloudNativePG offers the alternative. With in-place updates enabled, the operator hands the new instance manager binary to the one already running, which writes it down and re-executes itself. The Pod is never deleted; PostgreSQL keeps running underneath.

Switch it on **before** the upgrade — this is configuration the operator reads at startup, so it has to be in place and loaded before the version change happens. Two traps are waiting here, and both are silent. The key is not spelled the way you would guess, and configuration the operator has not restarted to read does nothing at all. So do not trust the ConfigMap: read the setting back out of the operator's own log.`,
      instructions: `Look at what the operator was told to read:

\`\`\`
kubectl -n cnpg-system get deploy cnpg-controller-manager \\
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\\n"}'
kubectl -n cnpg-system get cm
\`\`\`

It is asking for \`--config-map-name=cnpg-controller-manager-config\`, and no such ConfigMap exists — which is how a default installation runs. Create it with the one setting this lab needs:

\`\`\`
kubectl -n cnpg-system create configmap cnpg-controller-manager-config \\
  --from-literal=ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true
kubectl -n cnpg-system get cm cnpg-controller-manager-config -o jsonpath='{.data}{"\\n"}'
\`\`\`

Read that key carefully: **INPLACE**, one word, not \`IN_PLACE\`. An unrecognised key in this ConfigMap is ignored without any complaint whatsoever — no error, no warning, no event — and the operator carries on with the default.

Now restart the operator so it reads the file, and wait for it:

\`\`\`
kubectl -n cnpg-system rollout restart deploy cnpg-controller-manager
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
\`\`\`

And confirm it took, by asking the operator rather than the ConfigMap. It logs its entire loaded configuration on startup:

\`\`\`
kubectl -n cnpg-system logs deploy/cnpg-controller-manager | grep "Operator configuration loaded" | tail -1
\`\`\`

That line is long. The field to find in it is \`enableInstanceManagerInplaceUpdates\`, and it must read \`true\`. If it reads \`false\`, the ConfigMap has a key the operator does not recognise — which is the whole reason for checking here instead of trusting what you typed.

While you are looking at that line, notice \`inheritedLabels\` and \`inheritedAnnotations\` beside it, and \`availableArchitectures\` on the line below: the operator reports which architectures it can supply an instance manager for.

Finally, confirm the database noticed none of this:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp
kubectl get cluster pg-cluster
\`\`\`

Same ages, still 1.29.2, still healthy. Restarting the controller does nothing to the databases — they are separate processes, and that separation is exactly what the next objective puts to the test.`,
      hint: `If the log line shows \`enableInstanceManagerInplaceUpdates":false\`, check the spelling of the key in the ConfigMap and recreate it — \`kubectl -n cnpg-system delete cm cnpg-controller-manager-config\` and create it again — then restart the operator once more.`,
      solution: `kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].args}{"\\n"}'
kubectl -n cnpg-system create configmap cnpg-controller-manager-config --from-literal=ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true
kubectl -n cnpg-system rollout restart deploy cnpg-controller-manager
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system logs deploy/cnpg-controller-manager | grep "Operator configuration loaded" | tail -1
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp`,
    },

    {
      id: 'upgrade-in-place',
      title: 'Upgrade the operator without restarting a database',
      limitSec: 600,
      criteria: [
        'The operator is now v1.30.0 and serving',
        'Every instance reports v1.30.0 too',
        'Without a single Pod being recreated or a container restarted',
        'And the cluster never left its healthy state',
      ],
      brief: `Now do the upgrade. Applying the newer release manifest replaces the controller Deployment, which is an ordinary Kubernetes rollout and takes a few seconds.

What happens next is the part worth watching. The new controller finds three instances running an agent one version behind. With in-place updates on, it uploads the new binary to each of them and asks it to re-execute — so the annotation flips to the new version while the Pod carries on being the same Pod, with the same name, the same UID, the same age and the same PostgreSQL process it had before.

Prove that, and prove it in the way that cannot be argued with: creation timestamps. A Pod that was replaced has a new one. These will not.`,
      instructions: `Note the ages one more time, so there is something to compare against:

\`\`\`
kubectl get pods -l cnpg.io/cluster=pg-cluster \\
  -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
\`\`\`

Apply the newer release:

\`\`\`
kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get deploy cnpg-controller-manager \\
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
\`\`\`

The controller is on 1.30.0. Now watch the instances follow it:

\`\`\`
for i in 1 2 3 4 5 6; do
  kubectl get pods -l cnpg.io/cluster=pg-cluster --no-headers \\
    -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
  echo "---"
  sleep 10
done
\`\`\`

The VERSION column moves to 1.30.0 within a few seconds. The CREATED column does not move at all, and RESTARTS stays at zero. The instance manager was replaced inside a container that was never restarted, in a Pod that was never deleted.

Confirm the database went through it without noticing:

\`\`\`
kubectl get cluster pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now() - pg_postmaster_start_time() AS uptime;"
\`\`\`

The PostgreSQL uptime is older than the upgrade you just performed — the strongest statement available that this was not a restart in disguise.

Two things to take away. Without this setting, upgrading the operator is a rolling restart of every database it manages, which is why operator upgrades get scheduled like database maintenance; with it, they are ordinary deployments. And the trade is real rather than free: an in-place update swaps a running agent's binary underneath itself, so the conservative default exists for a reason and CloudNativePG asks you to opt in.`,
      hint: `\`--server-side\` matters on this manifest — the CRDs in a CloudNativePG release are too large for the client-side apply annotation, and a plain \`kubectl apply\` refuses them.`,
      solution: `kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
kubectl apply --server-side -f /root/cloudnative-pg/releases/cnpg-1.30.0.yaml
kubectl -n cnpg-system rollout status deploy cnpg-controller-manager
kubectl -n cnpg-system get deploy cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\\n"}'
sleep 30
kubectl get pods -l cnpg.io/cluster=pg-cluster -o custom-columns=NAME:.metadata.name,VERSION:.metadata.annotations.cnpg\\.io/operatorVersion,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount
kubectl get cluster pg-cluster
kubectl exec psql-client -- psql -h pg-cluster-rw -tAc "SELECT now() - pg_postmaster_start_time() AS uptime;"`,
    },
  ],
}
