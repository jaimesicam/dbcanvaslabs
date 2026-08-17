// Confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md). The
// spine of this lab is a measurement, not a reading of the documentation: editing the password
// inside a managed role's Secret changed **nothing** for six minutes — the old password still
// connected and `passwordStatus.resourceVersion` still named the version the operator had
// applied — until the Secret was labelled `cnpg.io/reload: "true"`, after which it was applied
// in about eight seconds (resourceVersion 1351 → 2154, transaction 757 → 770). A second
// rotation on the now-labelled Secret took effect in the same eight seconds. An
// `ALTER ROLE analyst PASSWORD` made in SQL was not reverted for two minutes and the status went
// on saying `reconciled`; annotating the Secret (same password, new resourceVersion) had the
// operator overwrite it within one poll. `validUntil` in the past gave `FATAL: password
// authentication failed for user "analyst"` — PostgreSQL does not say "expired" — while the
// operator still called the role reconciled. `disablePassword: true` alongside `passwordSecret`
// is refused by the webhook with "This role both sets and disables a password"; on its own it
// left `rolpassword` NULL, `rolvaliduntil` back to `infinity`, and `passwordStatus` carrying
// only a transaction id.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client Pod,
// the analyst role and the Secret holding its password are this lab's starting state, built by
// its own provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgRolePasswords = {
  id: 'cnpg-role-passwords',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster running a real 3-instance PostgreSQL cluster, thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time, and then a role is declared and waited for before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster',
      'A Secret named analyst-password, holding username and password keys, with the password analyst_pw — created by hand while this environment was built, carrying no labels of any kind',
      'A role called analyst, declared under the Cluster\'s spec.managed.roles with its password taken from that Secret, already created in the database and able to log in',
      'A Pod named psql-client, running the same PostgreSQL image, with the app credentials already in its environment',
    ],
    yourJob:
      'A password in a Secret is only useful if changing the Secret changes the password. You will try exactly that — rotate the Secret and watch the database go on accepting the old password — and then find the one line that was missing, which is the whole mechanism by which the operator decides a Secret is worth watching. After that: what happens when somebody changes the password in SQL instead, and the two declarative ways to take a password away.',
  },

  tasks: [
    {
      id: 'rotate-the-secret',
      title: 'Rotate the password, and find out why nothing happened',
      limitSec: 720,
      criteria: [
        'The Secret holds the new password',
        '/root/not-rotated.txt caught the two versions disagreeing',
        "The Secret carries cnpg.io/reload, which is what puts it in the operator's watch set",
        'And the operator has applied it — the new password works, the old one is refused',
      ],
      brief: `Rotating a password ought to be the easy part of managing one: the password lives in a Kubernetes Secret, so change the Secret.

Do that, and then watch the database rather than the manifest. The old password goes on working, and the operator's own status quietly tells you why — it records the resourceVersion of the Secret it last applied, and that number is not moving.

The reason is a label. CloudNativePG only watches Secrets that carry \`cnpg.io/reload: "true"\`; anything else is read once, when the spec that names it changes, and then never looked at again. The operator's own generated Secrets carry the label, which is why the mechanism is invisible until you make a Secret yourself.

Add it, and the rotation you asked for a minute ago happens on its own.`,
      instructions: `Work in the **k3d-server** tab. Look at what you have been given:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.spec.managed.roles}{"\\n"}'
kubectl get secret analyst-password -o jsonpath='{.data.password}' | base64 -d; echo
kubectl exec psql-client -- env PGPASSWORD=analyst_pw \\
  psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user;"
\`\`\`

A role declared in the Cluster, a Secret holding its password, and a connection that proves the two are joined up.

Now rotate it. A merge patch with \`stringData\` writes a new value without you having to base64 anything:

\`\`\`
kubectl patch secret analyst-password -p '{"stringData":{"password":"analyst_2026"}}'
kubectl get secret analyst-password -o jsonpath='{.data.password}' | base64 -d; echo
\`\`\`

The Secret says \`analyst_2026\`. Watch what the database says:

\`\`\`
for i in $(seq 1 6); do
  printf "%s new=" "$(date +%T)"
  kubectl exec psql-client -- env PGPASSWORD=analyst_2026 \\
    psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  printf " old="
  kubectl exec psql-client -- env PGPASSWORD=analyst_pw \\
    psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  echo
  sleep 8
done
\`\`\`

The new password never gets in and the old one always does. Nothing is broken and nothing is pending — the operator simply has not looked.

Its status says so, if you compare it with the Secret. Capture both numbers, in this order:

\`\`\`
kubectl get secret analyst-password -o jsonpath='{.metadata.resourceVersion}{"\\n"}' | tee /root/not-rotated.txt
kubectl get cluster pg-cluster \\
  -o jsonpath='{.status.managedRolesStatus.passwordStatus.analyst.resourceVersion}{"\\n"}' \\
  | tee -a /root/not-rotated.txt
\`\`\`

Two different numbers: where the Secret is now, and which version of it the operator acted on. That gap is the whole diagnosis, and it is worth knowing because nothing else reports it — the cluster is healthy and the role is \`reconciled\` throughout.

Now look at a Secret the operator made for itself, and at yours:

\`\`\`
kubectl get secret pg-cluster-app --show-labels
kubectl get secret analyst-password --show-labels
\`\`\`

The generated one carries \`cnpg.io/reload=true\`; yours carries nothing. That label is how CloudNativePG decides which Secrets to watch. Add it:

\`\`\`
kubectl label secret analyst-password cnpg.io/reload=true
\`\`\`

And watch the rotation you asked for finally happen:

\`\`\`
for i in $(seq 1 6); do
  printf "%s new=" "$(date +%T)"
  kubectl exec psql-client -- env PGPASSWORD=analyst_2026 \\
    psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  printf " status="
  kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus}'
  echo
  sleep 8
done
\`\`\`

About eight seconds after the label, the new password connects, the old one is refused, and \`passwordStatus\` has moved to the Secret's current version with a new transaction id beside it.`,
      hint: `The label is \`cnpg.io/reload=true\`, and \`kubectl get secret pg-cluster-app --show-labels\` shows you the operator using it on a Secret of its own.`,
      solution: `kubectl exec psql-client -- env PGPASSWORD=analyst_pw psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user;"
kubectl patch secret analyst-password -p '{"stringData":{"password":"analyst_2026"}}'
sleep 30
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;"
kubectl get secret analyst-password -o jsonpath='{.metadata.resourceVersion}{"\\n"}' | tee /root/not-rotated.txt
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus.analyst.resourceVersion}{"\\n"}' | tee -a /root/not-rotated.txt
kubectl label secret analyst-password cnpg.io/reload=true
sleep 20
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user;"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus}{"\\n"}'`,
    },

    {
      id: 'changed-in-sql',
      title: 'Change it in SQL, and get the Secret back in charge',
      limitSec: 720,
      criteria: [
        '/root/sql-password.txt records the operator calling the role reconciled while the passwords disagreed',
        "The Secret's password is back in force",
        'And the one set in SQL no longer gets in',
        'Because the operator re-read the Secret it watches',
      ],
      brief: `The Secret is now watched, so the obvious question is what happens from the other side: somebody with a psql prompt runs \`ALTER ROLE ... PASSWORD\` during an incident and forgets to say so.

Watch, and give it long enough to be sure. The password in the database is not the password in the Secret, and the operator goes on reporting the role as \`reconciled\` — because what it compares is the Secret's resourceVersion against the one it last applied, not the database against the Secret.

Which also tells you how to fix it. You do not need to change the password to make the operator re-apply it; you need to change the *Secret*, and any change will do — an annotation is enough to move its resourceVersion and put it back in charge.`,
      instructions: `Change the password behind the operator's back, on the primary:

\`\`\`
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "ALTER ROLE analyst PASSWORD 'out_of_band';"
\`\`\`

Now watch both passwords for a while — long enough that "it will fix itself in a moment" stops being a possible explanation:

\`\`\`
for i in $(seq 1 8); do
  printf "%s sql=" "$(date +%T)"
  kubectl exec psql-client -- env PGPASSWORD=out_of_band \\
    psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  printf " secret="
  kubectl exec psql-client -- env PGPASSWORD=analyst_2026 \\
    psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  echo
  sleep 10
done
\`\`\`

The password somebody typed works; the one in the Secret does not. Record what the operator thinks of the role while that is true:

\`\`\`
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}' | tee /root/sql-password.txt
\`\`\`

\`reconciled\`. The operator is not wrong about its own job — it applied what the Secret said, and the Secret has not changed since. It is simply not an auditor of the database.

So make the Secret change. Not its password — an annotation of your own is enough:

\`\`\`
kubectl annotate secret analyst-password lab/rotated-at="$(date +%s)" --overwrite
kubectl get secret analyst-password -o jsonpath='{.metadata.resourceVersion}{"\\n"}'
\`\`\`

And watch the operator overwrite the out-of-band password with the one it is responsible for:

\`\`\`
for i in $(seq 1 6); do
  printf "%s sql=" "$(date +%T)"
  kubectl exec psql-client -- env PGPASSWORD=out_of_band \\
    psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  printf " secret="
  kubectl exec psql-client -- env PGPASSWORD=analyst_2026 \\
    psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>/dev/null | tr -d '\\n'
  printf " status="
  kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus}'
  echo
  sleep 8
done
\`\`\`

Within one poll the roles reverse: the Secret's password connects, the improvised one does not, and \`passwordStatus.resourceVersion\` matches the Secret's current version with the transaction id one higher.

Two things to take away. A watched Secret is the source of truth *when it moves*, so "touch the Secret" is the operational fix for any drift you find. And the number to compare in a hurry is the pair you have just been reading — the Secret's \`resourceVersion\` against \`passwordStatus.resourceVersion\` — because the role's status says \`reconciled\` in both the healthy and the drifted case.`,
      hint: `You do not have to change the password to force a re-apply. \`kubectl annotate secret analyst-password lab/rotated-at="$(date +%s)" --overwrite\` moves the resourceVersion, which is all the operator is watching.`,
      solution: `PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "ALTER ROLE analyst PASSWORD 'out_of_band';"
sleep 40
kubectl exec psql-client -- env PGPASSWORD=out_of_band psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}' | tee /root/sql-password.txt
kubectl annotate secret analyst-password lab/rotated-at="$(date +%s)" --overwrite
sleep 20
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user;"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus.passwordStatus}{"\\n"}'`,
    },

    {
      id: 'expire-and-disable',
      title: 'Expire it, then take it away entirely',
      limitSec: 720,
      criteria: [
        '/root/expired.txt records what PostgreSQL says about an expired password',
        'The Cluster asks for the password to be disabled, with no Secret alongside it',
        "And the role's password really is NULL in pg_authid",
        'No password gets in, and the operator still reports the role reconciled',
      ],
      brief: `Two more fields, both about ending a password's life rather than changing it.

\`validUntil\` is an expiry date, written straight through to PostgreSQL's own \`VALID UNTIL\`. Put one in the past and the password stops working — and the message the client gets is worth reading carefully, because PostgreSQL will not tell you the password expired. It says authentication failed, exactly as it would for a wrong password.

\`disablePassword\` removes the password altogether, setting it to NULL. It cannot be combined with a \`passwordSecret\`: asking for both at once is refused by the operator's admission webhook, which is the right answer to a contradictory request.

Through all of it the role stays \`reconciled\` and the cluster stays healthy, because none of this is a failure — it is what you asked for.`,
      instructions: `Give the password an expiry date that has already passed:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true,
     "comment": "reporting account", "validUntil": "2026-01-01T00:00:00Z",
     "passwordSecret": {"name": "analyst-password"}}
  ]}}}'
sleep 20
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT rolname, rolvaliduntil FROM pg_roles WHERE rolname = 'analyst';"
\`\`\`

The date is in the role. Try the password that worked a minute ago, and keep what you get:

\`\`\`
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 \\
  psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>&1 | tee /root/expired.txt
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'
\`\`\`

*password authentication failed for user "analyst"* — the same sentence a wrong password produces. Nothing anywhere tells the client the password expired, and the operator still calls the role reconciled, so an expiry you forgot about looks exactly like a password somebody mistyped. The server's own log is the only place the distinction survives.

Move the date forward and it works again, which is all a renewal is:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true,
     "comment": "reporting account", "validUntil": "2027-01-01T00:00:00Z",
     "passwordSecret": {"name": "analyst-password"}}
  ]}}}'
sleep 20
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 \\
  psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT current_user;"
\`\`\`

Now take the password away entirely. First ask for something contradictory, on purpose:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true,
     "comment": "reporting account", "disablePassword": true,
     "passwordSecret": {"name": "analyst-password"}}
  ]}}}'
\`\`\`

Refused at admission: *This role both sets and disables a password*. Nothing was written, so there is nothing to undo.

Ask for it properly — the Secret reference goes away with the password:

\`\`\`
kubectl patch cluster pg-cluster --type=merge -p '{
  "spec": {"managed": {"roles": [
    {"name": "analyst", "ensure": "present", "login": true,
     "comment": "reporting account", "disablePassword": true}
  ]}}}'
sleep 20
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c \\
  "SELECT rolname, (rolpassword IS NULL) AS no_password, rolvaliduntil FROM pg_authid WHERE rolname = 'analyst';"
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 \\
  psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>&1 | head -1
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'
\`\`\`

Three things to notice in that output. The password is NULL, so no password gets in at all — the role is still allowed to log in, it simply has nothing to log in with, which is what you want for a role that authenticates some other way. \`rolvaliduntil\` has gone back to \`infinity\`, because the operator re-applies the *whole* entry and you stopped asking for an expiry. And \`passwordStatus\` for the role now carries only a transaction id, with no resourceVersion — there is no Secret being tracked any more.

So the shape of password maintenance here: keep the password in a Secret, label it \`cnpg.io/reload\` or nothing you do to it will matter, rotate by patching the Secret, force a re-apply by touching it, and end a password with \`validUntil\` or \`disablePassword\` rather than by dropping the role.`,
      hint: `The final patch must contain \`disablePassword: true\` and **no** \`passwordSecret\` — the two together are rejected by the webhook rather than merged.`,
      solution: `kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"comment":"reporting account","validUntil":"2026-01-01T00:00:00Z","passwordSecret":{"name":"analyst-password"}}]}}}'
sleep 20
kubectl exec psql-client -- env PGPASSWORD=analyst_2026 psql -h pg-cluster-rw -U analyst -d app -tAc "SELECT 1;" 2>&1 | tee /root/expired.txt
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"comment":"reporting account","validUntil":"2027-01-01T00:00:00Z","passwordSecret":{"name":"analyst-password"}}]}}}'
sleep 20
kubectl patch cluster pg-cluster --type=merge -p '{"spec":{"managed":{"roles":[{"name":"analyst","ensure":"present","login":true,"comment":"reporting account","disablePassword":true}]}}}'
sleep 20
PRIMARY=$(kubectl get cluster pg-cluster -o jsonpath='{.status.currentPrimary}')
kubectl exec $PRIMARY -c postgres -- psql -U postgres -c "SELECT rolname, (rolpassword IS NULL) AS no_password, rolvaliduntil FROM pg_authid WHERE rolname = 'analyst';"
kubectl get cluster pg-cluster -o jsonpath='{.status.managedRolesStatus}{"\\n"}'`,
    },
  ],
}
