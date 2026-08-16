// Every openssl invocation, certificate subject and failure message below is confirmed live
// against a real K3D + CloudNativePG deploy (server/, see LABORATORY.md): the cluster really
// does swap its server certificate without a restart, and really does keep streaming. Grading
// runs server-side and parses the certificate the database presents on a real TLS handshake.
//
// Worked from the `toolbox` tab. That is what lets the certificates be generated as ordinary
// local files and handed straight to `kubectl create secret` — no `kubectl exec`, no `sh -c`
// quoting, and no copying PEM files out of a container. The toolbox's OpenSSL is 3.0.13
// (Ubuntu 24.04), older than the PostgreSQL image's 3.5.6, which is why `req -quiet` is not
// used here: that flag arrived in OpenSSL 3.2.
//
// Self-contained, like every lab here: the operator, a healthy 3-instance cluster, a client
// Pod and the toolbox are this lab's starting state, built by its own provisioning. No
// reference to any other lab (see CLAUDE.md, "Lab content contract").

export const cnpgServerCertificates = {
  id: 'cnpg-server-certificates',
  terminals: ['k3d-server', 'k3d-agent-1', 'k3d-agent-2'],
  // Directs the learner to the toolbox tab, so the player opens it as soon as the
  // attempt reports one (see CLAUDE.md, "Lab content contract").
  usesToolbox: true,

  environment: {
    summary:
      'Everything below is really built, from scratch, for you alone — a disposable Kubernetes cluster on its own Docker network, running a real, healthy PostgreSQL cluster already serving TLS with certificates it issued itself, and thrown away when you finish. Nothing is simulated, which is why it takes a few minutes: three PostgreSQL instances are bootstrapped one at a time before you get here.',
    provides: [
      'A 3-node k3s cluster (rancher/k3s:v1.35.5-k3s1): one control-plane node, k3d-server, and two workers, k3d-agent-1 and k3d-agent-2 — each a real container you get a root shell on',
      'kubectl and a kubeconfig on all three nodes, so any terminal tab can talk to the cluster',
      'A toolbox terminal — an Ubuntu container on the lab network carrying the tools the minimal k3s nodes do not have: jq, curl, psql 18, openssl and yq. It is already pointed at the cluster, resolves Service names, and can reach Pod and Service addresses directly',
      'MetalLB v0.14.9, so Services of type LoadBalancer get a real address',
      'A SeaweedFS container (S3-compatible object storage) on the same network',
      'The CloudNativePG v1.30.0 operator, installed and Running in the cnpg-system namespace while this environment was built',
      'A healthy 3-instance Cluster named pg-cluster, reporting "Cluster in healthy state", already serving TLS with a certificate the operator generated from its own self-signed CA in the pg-cluster-ca Secret',
      'A Pod named psql-client, running the PostgreSQL image with the app credentials in its environment — an in-cluster client, if you want to compare what a Pod sees with what the toolbox sees',
    ],
    yourJob:
      "The database's certificate is its own: signed by a CA that exists only inside this cluster, which no client of yours has any reason to trust. You will become the certificate authority instead — create a CA, issue a server certificate from it for the cluster's Service names, load both into Secrets, and hand them to the operator, then prove on the wire that PostgreSQL is presenting your certificate and that the operator's old CA no longer validates anything. Work in the toolbox tab, which has openssl and psql.",
  },

  tasks: [
    {
      id: 'create-ca',
      title: 'Create a CA and issue a server certificate',
      limitSec: 480,
      criteria: [
        'A self-signed CA certificate exists at /root/tls/ca.crt',
        'A server certificate at /root/tls/server.crt is issued for pg-cluster-rw',
        'Its subject alternative names cover pg-cluster-rw, pg-cluster-ro and pg-cluster-r',
        'Your CA signed it',
      ],
      brief: `Become the certificate authority. Create a self-signed CA, then issue a server certificate from it for the database to present.

Work in the **toolbox** tab. It has openssl, so these are ordinary local files in an ordinary directory — which matters more than it sounds, because the next objective hands those same files straight to kubectl.

Two things about the server certificate decide whether this will work at all: its common name has to be the read-write Service name, and its subject alternative names have to cover every Service name a client might dial.

That second point is where a hand-rolled certificate usually goes wrong. A client using full verification checks the name it dialled against the certificate, so a certificate naming only one Service silently breaks every client that connects through another.`,
      instructions: `In the **toolbox** tab, make a directory to work in and start with the certificate authority — self-signed, because you are the root of trust now:

\`\`\`
mkdir -p /root/tls && cd /root/tls
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \\
  -keyout ca.key -out ca.crt \\
  -subj "/CN=dbcanvas-labs-ca/O=DBCanvas Labs" 2>/dev/null
\`\`\`

Now issue the server certificate from that CA. The common name is the read-write Service, and the alternative names cover all three Services in both short and namespaced form:

\`\`\`
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \\
  -CA ca.crt -CAkey ca.key \\
  -keyout server.key -out server.crt \\
  -subj "/CN=pg-cluster-rw" \\
  -addext "subjectAltName=DNS:pg-cluster-rw,DNS:pg-cluster-rw.default,DNS:pg-cluster-rw.default.svc,DNS:pg-cluster-ro,DNS:pg-cluster-ro.default,DNS:pg-cluster-ro.default.svc,DNS:pg-cluster-r,DNS:pg-cluster-r.default,DNS:pg-cluster-r.default.svc" 2>/dev/null
\`\`\`

Passing the CA to the same command that makes the key is an OpenSSL 3 convenience — it generates the key, builds the request and signs it in one step, instead of the older make-a-request-then-sign-it dance.

Four files, and note the permissions openssl chose for the two private keys:

\`\`\`
ls -l /root/tls
\`\`\`

Read back what you made, and check the signature chain rather than assuming it:

\`\`\`
openssl x509 -in server.crt -noout -subject -issuer -ext subjectAltName
openssl verify -CAfile ca.crt server.crt
\`\`\`

Subject \`CN=pg-cluster-rw\`, issuer your CA, nine alternative names, and \`server.crt: OK\`.`,
      hint: `The \`2>/dev/null\` is only there to swallow the page of key-generation dots this OpenSSL prints — drop it if you would rather watch. Newer builds have a \`-quiet\` flag instead, but the toolbox ships OpenSSL 3.0 and that flag arrived in 3.2.`,
      solution: `mkdir -p /root/tls && cd /root/tls
openssl req -x509 -nodes -newkey rsa:2048 -days 365 -keyout ca.key -out ca.crt -subj "/CN=dbcanvas-labs-ca/O=DBCanvas Labs" 2>/dev/null
openssl req -x509 -nodes -newkey rsa:2048 -days 365 -CA ca.crt -CAkey ca.key -keyout server.key -out server.crt -subj "/CN=pg-cluster-rw" -addext "subjectAltName=DNS:pg-cluster-rw,DNS:pg-cluster-rw.default,DNS:pg-cluster-rw.default.svc,DNS:pg-cluster-ro,DNS:pg-cluster-ro.default,DNS:pg-cluster-ro.default.svc,DNS:pg-cluster-r,DNS:pg-cluster-r.default,DNS:pg-cluster-r.default.svc" 2>/dev/null
ls -l /root/tls
openssl x509 -in server.crt -noout -subject -issuer -ext subjectAltName
openssl verify -CAfile ca.crt server.crt`,
    },

    {
      id: 'load-secrets',
      title: 'Load the material into Secrets',
      limitSec: 360,
      criteria: [
        'Secret pg-server-ca holds a CA certificate',
        'Secret pg-server-cert is a kubernetes.io/tls Secret issued for pg-cluster-rw',
        "It holds the certificate your CA signed, not the operator's",
      ],
      brief: `The certificates are files on disk, which is no use to the operator. Get them into Kubernetes as two Secrets.

The CA goes into an ordinary Secret under the key \`ca.crt\`, because that is the key the operator looks for. The certificate and its key go into a TLS Secret, the same shape the operator generates for itself.

Two things are worth noticing as you do it. The key *name* in the CA Secret is load-bearing, not decoration — the operator reads \`ca.crt\` specifically. And one file never leaves your directory: the CA's private key. The operator has no use for it, and nothing that does not need a private key should be given one.`,
      instructions: `Both Secrets are created straight from the files you just made — kubectl reads them from disk, so there is nothing to copy anywhere:

\`\`\`
cd /root/tls
kubectl create secret generic pg-server-ca --from-file=ca.crt=ca.crt
\`\`\`

The \`--from-file=ca.crt=ca.crt\` is doing two jobs: the part after the \`=\` is the file to read, and the part before it is the key to store it under. They happen to match here, and the key is the half that matters.

The certificate goes in as a TLS Secret, which is a purpose-built type with exactly two keys:

\`\`\`
kubectl create secret tls pg-server-cert --cert=server.crt --key=server.key
kubectl get secret pg-server-ca pg-server-cert
\`\`\`

One \`Opaque\` Secret with one key, one \`kubernetes.io/tls\` Secret with two. Nothing has changed about the database yet — these are just two objects sitting in the namespace, and the cluster is still serving the operator's own certificate.

Notice what you did not upload: \`ca.key\`. Your CA's private key is the one thing in that directory that could issue new certificates for this database, and it stays on your disk.`,
      hint: `If \`create secret tls\` complains that the key does not match the certificate, you have paired \`server.key\` with the wrong \`.crt\` — it verifies the pair before creating anything, which is worth knowing as a free sanity check.`,
      solution: `cd /root/tls
kubectl create secret generic pg-server-ca --from-file=ca.crt=ca.crt
kubectl create secret tls pg-server-cert --cert=server.crt --key=server.key
kubectl get secret pg-server-ca pg-server-cert`,
    },

    {
      id: 'wire-into-cluster',
      title: 'Hand the certificates to the operator',
      limitSec: 420,
      criteria: [
        'spec.certificates.serverCASecret names pg-server-ca',
        'spec.certificates.serverTLSSecret names pg-server-cert',
        'The cluster is healthy with all 3 instances ready',
        'Replication survived the change — both replicas are still streaming',
      ],
      brief: `Tell the Cluster to use your certificates instead of the ones it generated, by naming both Secrets in its spec.

Watch what this does not do. The instances are not restarted and nothing is re-created: the operator swaps the mounted material and has PostgreSQL reload, so the change lands without downtime.

Replication is the thing worth checking afterwards, and the reason both Secrets have to be named together. The replicas verify the primary's certificate against the server CA the operator gives them — hand over a certificate without the CA that signed it and you would break streaming replication rather than a client.`,
      instructions: `Name both Secrets in the Cluster's certificates section:

\`\`\`
kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge \\
  -p '{"spec":{"certificates":{"serverCASecret":"pg-server-ca","serverTLSSecret":"pg-server-cert"}}}'
\`\`\`

Confirm the spec took it:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.spec.certificates}'
\`\`\`

Now watch what happens to the running database:

\`\`\`
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
\`\`\`

Nothing. The cluster stays healthy, the restart counts stay at zero, and the ages keep climbing — the operator replaces the mounted certificate and signals PostgreSQL to reload, which is a configuration reload, not a restart.

Check the part that could have broken:

\`\`\`
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"
\`\`\`

Both replicas still streaming. They verify the primary's certificate against the server CA the operator hands them, which is why the CA Secret and the certificate Secret have to change together — a certificate whose CA the replicas do not have would stop replication, not just clients.`,
      hint: `If the patch is rejected, the admission webhook is telling you a named Secret does not exist or is the wrong shape — check the spelling against \`kubectl get secret\`, and that the CA Secret's key is \`ca.crt\`.`,
      solution: `kubectl patch cluster.postgresql.cnpg.io pg-cluster --type=merge -p '{"spec":{"certificates":{"serverCASecret":"pg-server-ca","serverTLSSecret":"pg-server-cert"}}}'
kubectl get cluster.postgresql.cnpg.io pg-cluster -o jsonpath='{.spec.certificates}'
kubectl get cluster.postgresql.cnpg.io pg-cluster
kubectl get pods -l cnpg.io/cluster=pg-cluster
kubectl exec pg-cluster-1 -c postgres -- psql -U postgres -c "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;"`,
    },

    {
      id: 'verify-on-the-wire',
      title: 'Prove it on the wire',
      limitSec: 420,
      criteria: [
        'The certificate PostgreSQL presents is signed by your CA',
        '/root/server-issuer.txt was written',
        'It names your CA',
        "A client that trusts only the operator's original CA would now reject it",
      ],
      brief: `Finish by asking the database itself what it is presenting, rather than trusting that the Secret you created is the one being served.

Open a TLS handshake against the read-write Service and read the certificate off it. The issuer should be your CA. Record that issuer's common name in \`/root/server-issuer.txt\`.

Then connect twice with full verification: once trusting your CA, which should work, and once trusting the operator's original CA, which should now fail. That second failure is the real result of this lab — the trust anchor for this database is now yours, and anything that does not know your CA is turned away.

The toolbox is a real client here, not a stand-in. It resolves the Service name and dials it exactly as an application would.`,
      instructions: `Ask the server what it presents, over a real handshake:

\`\`\`
openssl s_client -starttls postgres -connect pg-cluster-rw:5432 </dev/null 2>/dev/null \\
  | openssl x509 -noout -subject -issuer
\`\`\`

Subject \`CN=pg-cluster-rw\`, issuer your CA. Record the issuer's common name:

\`\`\`
echo dbcanvas-labs-ca > /root/server-issuer.txt
\`\`\`

Now connect as a client that verifies properly. The app password lives in a Secret the operator generated, so read it into the environment first:

\`\`\`
export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
psql "host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/root/tls/ca.crt" \\
  -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
\`\`\`

Connected, over TLS 1.3, with the server's identity verified against a CA you control. Now try the same thing trusting the operator's original CA instead — pull it out of its Secret and use it as the root:

\`\`\`
kubectl get secret pg-cluster-ca -o jsonpath='{.data.ca\\.crt}' | base64 -d > /root/tls/operator-ca.crt
psql "host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/root/tls/operator-ca.crt" \\
  -c "SELECT 1;"
\`\`\`

Rejected: \`SSL error: certificate verify failed\`. The old CA is still in the namespace, and the operator still uses it to sign the client certificates its replicas authenticate with — but it no longer has anything to do with proving the *server's* identity. That is now yours.`,
      hint: `\`sslmode=verify-full\` checks both the signature chain and the host name you dialled; \`verify-ca\` would check only the chain. If it fails against your own CA, check the name you dialled is one of the alternative names on the certificate.`,
      solution: `openssl s_client -starttls postgres -connect pg-cluster-rw:5432 </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
echo dbcanvas-labs-ca > /root/server-issuer.txt
export PGPASSWORD=$(kubectl get secret pg-cluster-app -o jsonpath='{.data.password}' | base64 -d)
psql "host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/root/tls/ca.crt" -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
kubectl get secret pg-cluster-ca -o jsonpath='{.data.ca\\.crt}' | base64 -d > /root/tls/operator-ca.crt
psql "host=pg-cluster-rw user=app dbname=app sslmode=verify-full sslrootcert=/root/tls/operator-ca.crt" -c "SELECT 1;"`,
    },
  ],
}
