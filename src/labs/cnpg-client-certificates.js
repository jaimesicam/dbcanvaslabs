// Certificate subjects, issuers, the pg_hba rule and every error message below are
// confirmed live against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md).
// Grading runs server-side, against the real cluster: it parses the actual certificates out
// of the Secrets and attempts real connections.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, the cnpg
// plugin and a staged client Pod manifest are this lab's starting state, built by its own
// provisioning. No reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgClientCertificates = {
  id: 'cnpg-client-certificates',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster with its own real certificate authority, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time, and the cnpg plugin is fetched and installed on every node.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", with TLS on and the certificates the operator generates for itself: a private CA in the pg-cluster-ca Secret, a server certificate in pg-cluster-server, and a replication client certificate in pg-cluster-replication',
      'The cnpg kubectl plugin v1.30.0, installed on all three nodes, so kubectl cnpg works from any terminal tab',
      'A client Pod manifest staged at /root/cert-client.yaml on the k3d-server node — written but deliberately not applied, because it mounts a Secret that does not exist yet',
    ],
    yourJob:
      'The cluster already speaks TLS, but every client still authenticates with a password, and the certificate that would let one authenticate without a password has never been issued. You will read what the operator generated, issue a client certificate for the app user, turn on certificate authentication in the cluster spec, and then connect with no password at all.',
  },

  tasks: [
    {
      id: 'inspect-tls',
      title: 'Read the certificates the operator generated',
      limitSec: 420,
      criteria: [
        'The operator-generated Secrets pg-cluster-ca and pg-cluster-server exist',
        "The server certificate is issued for pg-cluster-rw and signed by the cluster's own CA",
        '/root/server-cert-cn.txt was written',
        'It names pg-cluster-rw',
      ],
      brief: `Before issuing anything, find out what already exists. A CloudNativePG cluster is its own certificate authority from the moment it is created, and it has already issued itself everything it needs.

Look at the Secrets in the namespace, then look at the certificate the database actually presents on the wire: who it was issued to, and who signed it. Record the name it is issued for in \`/root/server-cert-cn.txt\`.

The answer is the read-write Service name, not a Pod name or a host name, and that is the detail the rest of the lab rests on: a client that verifies the server is verifying the Service it dialled, which is why verification survives a failover moving the database to a different Pod.`,
      instructions: `Start with what the operator created alongside the database:

\`\`\`
kubectl get secrets
\`\`\`

Four of them matter here. \`pg-cluster-ca\` holds the cluster's own certificate authority — both \`ca.crt\` and, importantly, \`ca.key\`. \`pg-cluster-server\` holds the certificate PostgreSQL presents to clients. \`pg-cluster-replication\` holds a client certificate the replicas use to authenticate as the \`streaming_replica\` user. \`pg-cluster-app\` is the password Secret you would otherwise be using.

Rather than trust the Secret, ask the database what it actually presents on the wire. Run it inside an instance Pod, whose PostgreSQL image carries openssl:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- sh -c "openssl s_client -starttls postgres -connect pg-cluster-rw:5432 </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName"
\`\`\`

The subject is \`CN=pg-cluster-rw\` — the read-write Service name. The issuer is the cluster's own CA. And the subject alternative names cover all three Service names, in short and fully-qualified form, which is what lets a client verify the host name it dialled no matter which instance answers.

Record the name the certificate is issued for:

\`\`\`
echo pg-cluster-rw > /root/server-cert-cn.txt
\`\`\``,
      hint: `The whole pipeline has to run inside the Pod, so it needs \`sh -c "..."\` — a pipe typed outside runs on whichever machine your terminal is on instead, which is not where the connection is being made.`,
      solution: `kubectl get secrets
kubectl exec pg-cluster-1 -c postgres -- sh -c "openssl s_client -starttls postgres -connect pg-cluster-rw:5432 </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName"
echo pg-cluster-rw > /root/server-cert-cn.txt`,
    },

    {
      id: 'issue-client-cert',
      title: 'Issue a client certificate for the app user',
      limitSec: 300,
      criteria: [
        'Secret app-client-cert exists, of type kubernetes.io/tls',
        'Its certificate is issued for the app user (CN=app)',
        "It is signed by the same CA the cluster's server certificate is",
      ],
      brief: `Issue a certificate that identifies a client as the \`app\` database user, signed by the cluster's own CA.

The cnpg kubectl plugin does this in one command: it reads the CA key straight out of the Secret, signs a new certificate whose common name is the PostgreSQL user you name, and stores the result as a TLS Secret called \`app-client-cert\`.

The common name is not a label — it is the identity. When certificate authentication is switched on in the next objective, PostgreSQL will read the user name out of that field and refuse the connection if it does not match the user being requested.`,
      instructions: `The cnpg plugin is installed on all three nodes, so this works from any terminal tab:

\`\`\`
kubectl cnpg certificate app-client-cert --cnpg-cluster pg-cluster --cnpg-user app
\`\`\`

That reads \`ca.key\` out of the \`pg-cluster-ca\` Secret, signs a fresh client certificate with a common name of \`app\`, and writes it to a new Secret:

\`\`\`
kubectl get secret app-client-cert
\`\`\`

The type is \`kubernetes.io/tls\`, holding \`tls.crt\` and \`tls.key\` — the same shape as the server Secret, because it is the same kind of object playing the other role. Confirm what it says, again using the openssl inside a database Pod:

\`\`\`
kubectl get secret app-client-cert -o jsonpath='{.data.tls\\.crt}' | base64 -d > /tmp/app.crt
kubectl exec -i pg-cluster-1 -c postgres -- openssl x509 -noout -subject -issuer -dates < /tmp/app.crt
\`\`\`

Subject \`CN=app\`, issued by the same CA that signed the server certificate, valid for 90 days. Nothing about the database has changed yet — this certificate is currently useless, because nothing has told PostgreSQL to accept one.`,
      hint: `The flags are \`--cnpg-cluster\` and \`--cnpg-user\`, not \`--cluster\` and \`--user\` — those two belong to kubectl itself, for picking a kubeconfig context. Add \`--dry-run -o yaml\` if you want to see the Secret before creating it.`,
      solution: `kubectl cnpg certificate app-client-cert --cnpg-cluster pg-cluster --cnpg-user app
kubectl get secret app-client-cert
kubectl get secret app-client-cert -o jsonpath='{.data.tls\\.crt}' | base64 -d > /tmp/app.crt
kubectl exec -i pg-cluster-1 -c postgres -- openssl x509 -noout -subject -issuer -dates < /tmp/app.crt`,
    },

    {
      id: 'enable-cert-auth',
      title: 'Turn on certificate authentication',
      limitSec: 420,
      criteria: [
        "The Cluster's spec.postgresql.pg_hba declares a hostssl ... cert rule for app",
        'PostgreSQL reloaded it — pg_hba_file_rules lists it ahead of the scram-sha-256 fallback',
        'A TLS connection with a password but no client certificate is now refused',
        'The cluster is still healthy',
      ],
      brief: `A certificate on its own authenticates nobody. PostgreSQL decides how each connection may authenticate from its \`pg_hba.conf\`, and right now that file has no rule that would accept a certificate from an ordinary user.

You do not edit that file — the operator owns it, and hand edits would be reconciled away. You add your rule to the Cluster resource instead, under the PostgreSQL section, and the operator writes it into the file and reloads every instance for you.

Order is the thing to watch. \`pg_hba\` is first match wins, and the operator always appends a password-based catch-all at the end, so a rule that lands after it would never be reached. Once yours is in place, a TLS connection with a password and no certificate stops working — which is the proof that the rule took effect.`,
      instructions: `Add the rule declaratively, to the Cluster resource:

\`\`\`
kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge \\
  -p '{"spec":{"postgresql":{"pg_hba":["hostssl app app all cert"]}}}'
\`\`\`

Read that rule left to right: for TLS connections only, to database \`app\`, as user \`app\`, from anywhere, authenticate by client certificate. Confirm it landed in the spec:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.spec.postgresql.pg_hba}'
\`\`\`

The operator now writes it into every instance's \`pg_hba.conf\` and reloads PostgreSQL — no restart, no downtime. Watch the running rules, which needs superuser, so ask over the Pod's local socket:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rule_number, type, database, user_name, auth_method FROM pg_hba_file_rules ORDER BY rule_number;"
\`\`\`

Your rule appears among the operator's own — after the \`streaming_replica\` rules, and crucially before the \`host all all all scram-sha-256\` line that ends the file. Since \`pg_hba\` is first match wins, that ordering is what makes it effective at all.

Now see what it did. Get the app password and connect over TLS without a certificate:

\`\`\`
export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql "host=pg-cluster-rw user=app dbname=app sslmode=require" -c "SELECT 1;"
\`\`\`

It is refused: \`FATAL: connection requires a valid client certificate\`. The password is correct and the connection is encrypted — it is simply no longer sufficient.`,
      hint: `If the connection still succeeds, check that you asked for TLS: without \`sslmode=require\` libpq will happily connect in the clear here, which matches the \`host all all all scram-sha-256\` rule instead of your \`hostssl\` one, and a password is still enough for that.`,
      solution: `kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"postgresql":{"pg_hba":["hostssl app app all cert"]}}}'
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.spec.postgresql.pg_hba}'
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT rule_number, type, database, user_name, auth_method FROM pg_hba_file_rules ORDER BY rule_number;"
export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
kubectl exec pg-cluster-1 -c postgres -- env PGPASSWORD=$PGPASSWORD psql "host=pg-cluster-rw user=app dbname=app sslmode=require" -c "SELECT 1;"`,
    },

    {
      id: 'connect-with-cert',
      title: 'Connect with the certificate and no password',
      limitSec: 420,
      criteria: [
        'The cert-client Pod is running',
        "A row noted 'via-client-cert' exists in cert_proof",
        'It recorded a client certificate DN of CN=app',
        'The session that wrote it was TLS-encrypted',
      ],
      brief: `Now connect as a client that holds the certificate instead of the password, and make the database itself record who it thinks you are.

The staged Pod manifest mounts two things: the CA certificate, so the client can verify the server, and the client certificate and key you issued, so the server can verify the client. Apply it, then connect with full verification and no password anywhere in the command.

The row you write is the evidence. PostgreSQL exposes the distinguished name it read off your certificate for the current session, so writing that value into the table proves the connection was authenticated by certificate rather than by anything you typed.`,
      instructions: `Look at what has been waiting for you, then apply it:

\`\`\`
cat /root/cert-client.yaml
kubectl apply -f /root/cert-client.yaml
kubectl get pod cert-client
\`\`\`

Two details in that manifest are worth pausing on. Only \`ca.crt\` is projected out of the CA Secret — \`ca.key\` is in there too, and a client has no business ever seeing it. And the volumes use a group-readable mode with an \`fsGroup\`, because libpq refuses to use a private key file that is more permissive than that.

Now connect with verification at full strength and no password at all:

\`\`\`
CONN="host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/etc/tls/ca/ca.crt sslcert=/etc/tls/client/tls.crt sslkey=/etc/tls/client/tls.key"
kubectl exec cert-client -- psql "$CONN" -c "SELECT current_user, ssl, version, client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
\`\`\`

\`verify-full\` means the client checks the server's certificate against the CA and checks that its name matches the host dialled — the \`CN=pg-cluster-rw\` you recorded earlier. In the other direction, the server reads your certificate and takes the user name from it.

Have the database record its own view of who connected:

\`\`\`
kubectl exec cert-client -- psql "$CONN" -c "CREATE TABLE cert_proof (id serial primary key, note text, client_dn text, tls text);"
kubectl exec cert-client -- psql "$CONN" -c "INSERT INTO cert_proof (note, client_dn, tls) SELECT 'via-client-cert', client_dn, version FROM pg_stat_ssl WHERE pid = pg_backend_pid() RETURNING *;"
\`\`\`

The stored distinguished name is \`/CN=app\` over \`TLSv1.3\`. No password was involved at any point.`,
      hint: `If psql complains that the private key has group or world access, the Pod was applied from an edited manifest — the staged one sets \`fsGroup\` and a 0640 mode for exactly that reason. If it complains the certificate is not valid for the host name, you are dialling something other than \`pg-cluster-rw\` under \`verify-full\`.`,
      solution: `kubectl apply -f /root/cert-client.yaml
kubectl get pod cert-client
CONN="host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/etc/tls/ca/ca.crt sslcert=/etc/tls/client/tls.crt sslkey=/etc/tls/client/tls.key"
kubectl exec cert-client -- psql "$CONN" -c "SELECT current_user, ssl, version, client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
kubectl exec cert-client -- psql "$CONN" -c "CREATE TABLE cert_proof (id serial primary key, note text, client_dn text, tls text);"
kubectl exec cert-client -- psql "$CONN" -c "INSERT INTO cert_proof (note, client_dn, tls) SELECT 'via-client-cert', client_dn, version FROM pg_stat_ssl WHERE pid = pg_backend_pid() RETURNING *;"`,
    },
  ],
}
