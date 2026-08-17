// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md):
// declaring a role under spec.managed.roles created it within seconds, applied its comment, took
// its password from the named Secret (the role connected through pg-cluster-rw with it), and
// reported `byStatus.reconciled: [analyst]`. Two findings shape the lab, both measured over
// several minutes: an `ALTER ROLE analyst NOLOGIN` made outside the spec was **not** reverted and
// the status went on saying `reconciled`, until any later change to the spec re-applied the whole
// role and restored LOGIN. And `ensure: absent` on a role that owns objects is refused with
// `cannotReconcile: could not perform DELETE on role analyst: 2 objects in database app` and a
// status of `pending-reconciliation` — dropping the objects alone changes nothing until the spec
// is touched again, after which the role goes.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster and a client
// Pod are this lab's starting state, built by its own provisioning. No reference to any other lab
// (see CLAUDE.md, "Lab content contract").

export const cnpgManagedRoles = {
  id: 'cnpg-managed-roles',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

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
      'A healthy 3-instance Cluster named pg-cluster whose only roles are the ones the operator makes: app, postgres, streaming_replica and the metrics exporter',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'Every database grows a collection of roles, and the usual way they arrive — somebody runs CREATE ROLE once and writes the password in a ticket — is exactly why nobody can say what the current set is. CloudNativePG can own them instead: declare a role in the Cluster, keep its password in a Secret, and the operator makes the database match. You will do that, and then find the two edges of the mechanism, both of which matter more than the happy path: what it does when somebody changes a role behind its back, and what it does when you ask it to drop a role that still owns something.',
  },

  tasks: [
    {
      id: 'declare-a-role',
      title: 'Declare a role instead of creating one',
      limitSec: 480,
      criteria: [
        'The Cluster declares a managed role called analyst',
        'The role exists in the database and may log in',
        'And the operator reports it reconciled',
        'You can connect as it with the password from the Secret',
      ],
      brief: `A managed role is an entry under \`spec.managed.roles\`: a name, whether it should be present, the attributes it should have, and — the part that makes this worth doing — a reference to a Kubernetes Secret holding its password.

That last part is the difference between this and running \`CREATE ROLE\`. The password lives in a Secret, so it can be rotated, sealed, sourced from a vault or audited like any other Kubernetes object, and it never appears in a manifest or in your shell history.

Create the Secret, declare the role, and then do the only test that actually proves it worked: connect as that role, through the Service, with the password from the Secret.`,
      instructions: `Work in the **k3d-server** tab. See what roles exist before you start:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\du"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'
\`\`\`

Four roles, all the operator's own, and a status that sorts them: \`app\` is \`not-managed\` — it exists but you have not asked for it — and \`postgres\`, \`streaming_replica\` and \`cnpg_metrics_exporter\` are \`reserved\`, because the operator uses them and will not let you manage them.

Make the Secret holding the password:

\`\`\`
kubectl create secret generic analyst-password \\
  --from-literal=username=analyst --from-literal=password=analyst_pw
kubectl get secret analyst-password
\`\`\`

Both keys matter: the operator checks that \`username\` matches the role it is managing, which is a small guard against pointing a role at the wrong Secret.

Now declare the role:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true,
     "comment": "read-only reporting account",
     "passwordSecret": {"name": "analyst-password"}}
  ]}}}'
sleep 15
\`\`\`

Look at what the operator did:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin, rolcreatedb, rolconnlimit FROM pg_roles WHERE rolname = 'analyst';"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT shobj_description(oid, 'pg_authid') FROM pg_roles WHERE rolname = 'analyst';"
\`\`\`

\`analyst\` has moved into \`byStatus.reconciled\`, the role exists with \`rolcanlogin\` true, and even the comment was applied — \`COMMENT ON ROLE\` is part of what the operator maintains.

Note the \`passwordStatus\` in that status block too: it records the Secret's \`resourceVersion\` and the transaction id in which the password was set. That is how the operator knows whether the Secret has changed since it last applied it.

Now the real test — connect as the role, from outside, with the password from the Secret:

\`\`\`
kubectl exec psql-client -- env PGPASSWORD=analyst_pw \\
  psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user, session_user;"
\`\`\`

A role you never created by hand, with a password you never typed into the database.`,
      hint: `The Secret needs both \`username\` and \`password\` keys, and \`username\` has to equal the role's name — otherwise the operator declines to use it.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "\\du"
kubectl create secret generic analyst-password --from-literal=username=analyst --from-literal=password=analyst_pw
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"comment":"read-only reporting account","passwordSecret":{"name":"analyst-password"}}]}}}'
sleep 15
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT rolname, rolcanlogin, rolcreatedb, rolconnlimit FROM pg_roles WHERE rolname = 'analyst';"
kubectl exec psql-client -- env PGPASSWORD=analyst_pw psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user, session_user;"`,
    },

    {
      id: 'the-operator-owns-it',
      title: 'Find out how much of it the operator is really watching',
      limitSec: 600,
      criteria: [
        'The Cluster now declares the role with createdb',
        'And the database agrees',
        '/root/drift.txt records the operator calling the role reconciled',
        'And a later change to the spec put the LOGIN back',
      ],
      brief: `Changing the role is now an edit to the Cluster: add an attribute, and the operator issues the \`ALTER ROLE\` for you. That much is what "declarative" promises.

Then find the boundary. Change the role in SQL instead — take its LOGIN away, the way somebody would during an incident at two in the morning — and watch what the operator does about it.

The answer is nothing, for as long as you care to wait, and the status goes on calling the role \`reconciled\` the whole time. That is worth knowing precisely, because it is not what "desired state" usually implies: the operator compares against what it last applied, not against what the database currently says. Any later change to the spec makes it apply the whole role again, and the drift disappears — but nothing before that will.`,
      instructions: `Add an attribute declaratively:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true, "createdb": true,
     "comment": "read-only reporting account",
     "passwordSecret": {"name": "analyst-password"}}
  ]}}}'
sleep 12
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin, rolcreatedb FROM pg_roles WHERE rolname = 'analyst';"
\`\`\`

\`rolcreatedb\` is now true. Note that the whole entry has to be sent again — \`spec.managed.roles\` is a list, and a merge patch replaces it wholesale, so leaving out \`login\` or the Secret would have removed them.

Now go behind its back:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "ALTER ROLE analyst NOLOGIN;"
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'analyst';"
\`\`\`

The role can no longer log in. Watch for a minute to see whether anything puts it back:

\`\`\`
for i in $(seq 1 6); do
  printf "%s " "$(date +%T)"
  kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
    "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'analyst';"
  sleep 10
done
\`\`\`

\`f\` every time. And here is the part to record — ask the operator how it thinks that role is doing:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}' | tee /root/drift.txt
\`\`\`

Still \`reconciled\`. The database and the spec disagree, the operator is content, and anything trusting that status is now wrong. Confirm what it means for a client:

\`\`\`
kubectl exec psql-client -- env PGPASSWORD=analyst_pw \\
  psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>&1 | head -2
\`\`\`

Now make the operator look again. Any change to the entry will do — here, a connection limit:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true, "createdb": true,
     "connectionLimit": 10, "comment": "read-only reporting account",
     "passwordSecret": {"name": "analyst-password"}}
  ]}}}'
sleep 15
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolcanlogin, rolcreatedb, rolconnlimit FROM pg_roles WHERE rolname = 'analyst';"
\`\`\`

LOGIN is back, alongside the connection limit you actually asked for: the operator re-applied the entire entry, not just the field you changed.

So the mental model to carry away is "applied on change", not "enforced continuously". Managed roles are excellent for describing the roles a cluster should have and keeping their passwords in Kubernetes; they are not an audit control, and they will not tell you that somebody has been editing roles by hand.`,
      hint: `\`tee\` writes the status to the file and still shows it to you. The check wants that file to contain the word \`reconciled\` — capture it while the database and the spec disagree.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"createdb":true,"comment":"read-only reporting account","passwordSecret":{"name":"analyst-password"}}]}}}'
sleep 12
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "ALTER ROLE analyst NOLOGIN;"
sleep 30
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'analyst';"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}' | tee /root/drift.txt
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"createdb":true,"connectionLimit":10,"comment":"read-only reporting account","passwordSecret":{"name":"analyst-password"}}]}}}'
sleep 15
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT rolname, rolcanlogin, rolcreatedb, rolconnlimit FROM pg_roles WHERE rolname = 'analyst';"`,
    },

    {
      id: 'remove-it',
      title: 'Ask for it to be gone',
      limitSec: 600,
      criteria: [
        'The Cluster asks for the role to be absent',
        '/root/cannot-drop.txt records why the first attempt could not be carried out',
        'The role is gone from the database now that nothing depends on it',
        'And the operator reports nothing it cannot reconcile',
      ],
      brief: `\`ensure: absent\` asks for the role to not exist. Whether that can be carried out is PostgreSQL's decision, not the operator's: a role that owns objects cannot be dropped, and no amount of declaring will change that.

So give the role something to own first, ask for it to be gone, and read what comes back. The operator does not fail the cluster, does not retry forever in the background and does not hide the problem — it moves the role to \`pending-reconciliation\` and writes the database's own refusal into \`cannotReconcile\`, where monitoring can find it.

Then clear the obstacle and watch the same thing you learned in the last objective apply again: fixing the database is not enough on its own, because nothing is looking until the spec changes.`,
      instructions: `Give the role something to own:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -c \\
  "CREATE TABLE reports (id serial primary key, title text); ALTER TABLE reports OWNER TO analyst;"
\`\`\`

Now ask for the role to go:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [{"name": "analyst", "ensure": "absent"}]}}}'
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT count(*) FROM pg_roles WHERE rolname = 'analyst';"
\`\`\`

Still there. Ask the operator why:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}' | tee /root/cannot-drop.txt
\`\`\`

\`cannotReconcile\` carries PostgreSQL's own answer — *could not perform DELETE on role analyst: 2 objects in database app* — and \`byStatus\` has moved the role from \`reconciled\` to \`pending-reconciliation\`. Two objects, not one: the table and the sequence behind its \`serial\` column.

Note what has **not** happened. The cluster is healthy, nothing is degraded, no event storm, and the request is simply outstanding:

\`\`\`
kubectl get cluster pg-cluster
\`\`\`

Clear the obstacle:

\`\`\`
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -c "DROP TABLE reports;"
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT count(*) FROM pg_roles WHERE rolname = 'analyst';"
\`\`\`

Still 1 — the objects are gone but the role is not, because nothing has asked the operator to look again. Give it a reason to:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [{"name": "analyst", "ensure": "absent", "comment": "retired"}]}}}'
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc \\
  "SELECT count(*) FROM pg_roles WHERE rolname = 'analyst';"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'
\`\`\`

Zero, and \`cannotReconcile\` is gone.

Two habits follow from all of this. Reassign or drop what a role owns *before* asking for the role to be absent — \`REASSIGN OWNED BY\` and \`DROP OWNED BY\` are the SQL for it, and they are what a real retirement looks like. And alert on \`status.managedRolesStatus.cannotReconcile\` rather than on the cluster's phase, because this is a class of failure that leaves the cluster perfectly healthy and the request quietly unfulfilled.`,
      hint: `An \`ensure: absent\` entry needs only the name and the ensure field; the password Secret and the attributes are irrelevant to a role that should not exist.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -c "CREATE TABLE reports (id serial primary key, title text); ALTER TABLE reports OWNER TO analyst;"
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"absent"}]}}}'
sleep 20
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}' | tee /root/cannot-drop.txt
kubectl exec $PRIMARY -c postgres -- psql -U postgres -d app -c "DROP TABLE reports;"
sleep 20
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"absent","comment":"retired"}]}}}'
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname = 'analyst';"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'`,
    },
  ],
}
