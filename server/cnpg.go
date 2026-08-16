package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// cnpg.go — CloudNativePG, installed the same way ~/Projects/dbcanvas installs the
// Percona operators (pxc/ps/psmdb/pg), not via Helm: fetch the tagged release source,
// unpack it onto the server node, apply the manifest that ships inside it. This is also
// the exact method CNPG's own Quickstart and e2e test suite use — not a chart install —
// which fits a lab literally titled "Installation of the operator" much better.

const (
	cnpgVersion        = "1.30.0"
	cnpgTarballURLFmt  = "https://github.com/cloudnative-pg/cloudnative-pg/archive/refs/tags/v%s.tar.gz"
	cnpgNamespace      = "cnpg-system"
	cnpgOperatorDeploy = "cnpg-controller-manager"
	cnpgClusterCRD     = "clusters.postgresql.cnpg.io"
	cnpgStageDir       = "/root/cloudnative-pg"

	// The Postgres data image, pinned rather than left to whatever default the operator
	// version happens to carry: it is the single largest thing an attempt downloads, so it
	// has to be nameable up front to be pre-seeded into the nodes (see PreseedImages), and a
	// lab that grades real `kubectl` output should not have its Postgres version move on its
	// own. This is CNPG 1.30.0's own default, so pinning it changes nothing but the drift.
	cnpgPostgresImage = "ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie"
	// One minor release behind cnpgPostgresImage. The rolling-update lab starts a cluster on
	// this and has the learner move it to the pinned image, so the upgrade is real rather
	// than a no-op re-apply.
	cnpgPreviousPostgresImage = "ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie"
	cnpgOperatorImage = "ghcr.io/cloudnative-pg/cloudnative-pg:" + cnpgVersion

	// The `cnpg` kubectl plugin, shipped as its own asset on the same tagged release as the
	// operator. Installed only for the labs whose subject *is* a plugin command (issuing a
	// client certificate, promoting an instance) — it is a ~98MB binary, so nothing pays for
	// it unless the lab actually teaches it.
	cnpgPluginURLFmt = "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v%s/kubectl-cnpg_%s_linux_%s.tar.gz"
	// Absent from the rancher/k3s image but already on its PATH, so a plugin dropped here is
	// found by kubectl as `kubectl cnpg` without touching where k3s keeps its own binaries.
	cnpgPluginDir = "/usr/local/bin"
)

// cnpgImages are every image an attempt's cluster pulls. k3d nodes do not share an image
// cache with each other or with the host, so left alone each of the 3 nodes downloads the
// ~500MB Postgres image from ghcr.io independently — which is what made the
// persistent-volume lab (a 3-instance cluster, one instance per node) take upwards of ten
// minutes to come up, and what the "several minutes on a cold image cache" note in the
// progress log was describing. Pulled once to the host and imported locally instead.
var cnpgImages = []string{cnpgPostgresImage, cnpgOperatorImage}

type CNPG struct {
	k3d *K3D
}

func NewCNPG(k3d *K3D) *CNPG {
	return &CNPG{k3d: k3d}
}

// StageOperator fetches the CNPG release tarball and unpacks its release manifest onto
// the server node. It does NOT apply it — inert prep, nothing to learn from watching a
// download. Returns the absolute path to the staged manifest.
func (c *CNPG) StageOperator(ctx context.Context, serverID string, logf func(string)) (string, error) {
	url := fmt.Sprintf(cnpgTarballURLFmt, cnpgVersion)
	logf("fetching CNPG v" + cnpgVersion + " source")
	tarball, err := httpGet(ctx, url)
	if err != nil {
		return "", fmt.Errorf("fetch CNPG tarball: %w", err)
	}

	files, err := untarGz(tarball)
	if err != nil {
		return "", fmt.Errorf("unpack CNPG tarball: %w", err)
	}
	// The repo's releases/ directory accumulates every historical version's manifest —
	// match the exact pinned version, not just the releases/cnpg-*.yaml pattern (which
	// matched arbitrarily, since map iteration order is randomized).
	releaseName := fmt.Sprintf("cnpg-%s.yaml", cnpgVersion)
	var releaseManifest []byte
	for name, content := range files {
		if stripFirstDir(name) == "releases/"+releaseName {
			releaseManifest = content
			break
		}
	}
	if releaseManifest == nil {
		return "", fmt.Errorf("release manifest releases/%s not found in CNPG v%s tarball", releaseName, cnpgVersion)
	}

	logf("staging it on the server node at " + cnpgStageDir)
	if _, err := c.k3d.docker.ExecRoot(ctx, serverID, []string{"mkdir", "-p", cnpgStageDir + "/releases"}, nil); err != nil {
		return "", err
	}
	if err := c.k3d.docker.PutArchive(ctx, serverID, cnpgStageDir+"/releases", releaseName, releaseManifest, 0644); err != nil {
		return "", err
	}
	return cnpgStageDir + "/releases/" + releaseName, nil
}

// InstallOperator applies the staged release manifest and waits for it to actually be
// serving — the same command a learner runs by hand in the operator-install lab,
// triggered automatically here only for labs where the operator is a precondition.
func (c *CNPG) InstallOperator(ctx context.Context, serverID, manifestPath string, logf func(string)) error {
	logf("kubectl apply --server-side -f " + manifestPath)
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "--server-side", "-f", manifestPath)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply cnpg manifest: exit %d: %s", res.ExitCode, res.Stderr)
	}

	logf("waiting for the " + cnpgClusterCRD + " CRD")
	if err := c.k3d.waitCRD(ctx, serverID, cnpgClusterCRD, 2*time.Minute); err != nil {
		return err
	}
	// CRD-established alone isn't sufficient — the admission webhook is served by this
	// same Deployment, so a Cluster applied before it's ready fails with "no endpoints
	// available for service ...-webhook-service" (the same race dbcanvas's own cnpg.go
	// calls out for its Helm-based install path).
	logf("waiting for the operator Deployment to be ready")
	return c.k3d.waitDeployment(ctx, serverID, cnpgNamespace, cnpgOperatorDeploy, 3*time.Minute)
}

// cnpgPreviousVersion is the release the upgrade lab starts from — the previous minor line,
// so the upgrade the learner performs is the same one an operator team would actually run.
// The staged 1.30.0 manifest every attempt already gets is what they upgrade *to*.
const cnpgPreviousVersion = "1.29.2"

var cnpgPreviousImage = "ghcr.io/cloudnative-pg/cloudnative-pg:" + cnpgPreviousVersion

// InstallOperatorVersion installs a specific release rather than the pinned one. Used only
// by the upgrade lab, which has to begin on an older operator for the upgrade to be real.
func (c *CNPG) InstallOperatorVersion(ctx context.Context, serverID, version string, logf func(string)) error {
	logf("fetching CNPG v" + version + " (the release this environment starts on)")
	tarball, err := httpGet(ctx, fmt.Sprintf(cnpgTarballURLFmt, version))
	if err != nil {
		return fmt.Errorf("fetch CNPG %s tarball: %w", version, err)
	}
	files, err := untarGz(tarball)
	if err != nil {
		return fmt.Errorf("unpack CNPG %s tarball: %w", version, err)
	}
	releaseName := fmt.Sprintf("cnpg-%s.yaml", version)
	var manifest []byte
	for name, content := range files {
		if stripFirstDir(name) == "releases/"+releaseName {
			manifest = content
			break
		}
	}
	if manifest == nil {
		return fmt.Errorf("release manifest releases/%s not found in the v%s tarball", releaseName, version)
	}
	if err := c.k3d.docker.PutArchive(ctx, serverID, cnpgStageDir+"/releases", releaseName, manifest, 0644); err != nil {
		return err
	}
	return c.InstallOperator(ctx, serverID, cnpgStageDir+"/releases/"+releaseName, logf)
}

// StageClusterManifest writes (but does not apply) a Cluster manifest to /root/cluster.yaml
// — inert prep, the same "give the learner something real to read and apply themselves"
// pattern as StageOperator, for the lab where creating the Cluster is the graded action.
func (c *CNPG) StageClusterManifest(ctx context.Context, serverID, name string, instances int, storageSize string) error {
	return c.StageClusterManifestImage(ctx, serverID, name, instances, storageSize, cnpgPostgresImage)
}

// StageClusterManifestImage is the same, with the PostgreSQL image spelled out — the
// rolling-update lab needs a cluster that starts a minor release behind.
func (c *CNPG) StageClusterManifestImage(ctx context.Context, serverID, name string, instances int, storageSize, image string) error {
	manifest := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: %s
  namespace: default
spec:
  instances: %d
  imageName: %s
  storage:
    size: %s
`, name, instances, image, storageSize)
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "cluster.yaml", []byte(manifest), 0644)
}

// ApplyCluster stages and applies a Cluster manifest (no plugins/backups — out of scope
// for the 3 current labs) and waits for it to report healthy — used for labs where the
// Cluster is a precondition rather than the learner's own graded action.
func (c *CNPG) ApplyCluster(ctx context.Context, serverID, name string, instances int, storageSize string, logf func(string)) error {
	return c.ApplyClusterImage(ctx, serverID, name, instances, storageSize, cnpgPostgresImage, logf)
}

// ApplyClusterImage is ApplyCluster with the image spelled out.
func (c *CNPG) ApplyClusterImage(ctx context.Context, serverID, name string, instances int, storageSize, image string, logf func(string)) error {
	if err := c.StageClusterManifestImage(ctx, serverID, name, instances, storageSize, image); err != nil {
		return err
	}

	logf("kubectl apply -f cluster.yaml")
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/cluster.yaml")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply cluster: exit %d: %s", res.ExitCode, res.Stderr)
	}

	// CNPG bootstraps instances one at a time — initdb on the primary, then a join job per
	// replica — so this is inherently serial even with the images already on every node.
	logf("waiting for the 3-instance cluster to report healthy (CNPG bootstraps one instance at a time)")
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		res, err := c.k3d.Kubectl(ctx, serverID, "get", "cluster.postgresql.cnpg.io", name, "-o", "jsonpath={.status.phase}")
		if err == nil && res.ExitCode == 0 && strings.TrimSpace(res.Stdout) == "Cluster in healthy state" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for cluster %s to become healthy", name)
}

/* ------------------------------------------------------- second clusters */

// externalClusterYAML is the block that lets one Cluster reach another. Two flavours are
// needed, and which one applies is not a style choice — it follows from the source's own
// pg_hba, which CloudNativePG generates:
//
//	hostssl postgres    streaming_replica all cert
//	hostssl replication streaming_replica all cert
//	host    all         all               all scram-sha-256
//
// So `streaming_replica` authenticates with a certificate but may only reach the `postgres`
// database, which is enough for physical streaming and nothing else. Anything that has to
// read *user* tables — a logical replication subscription — needs a password role instead,
// and that role needs REPLICATION granted to it before the publisher will accept it.
const streamingExternalCluster = `  externalClusters:
    - name: origin
      connectionParameters:
        host: %s-rw
        user: streaming_replica
        sslmode: verify-full
        dbname: postgres
      sslKey:
        name: %s-replication
        key: tls.key
      sslCert:
        name: %s-replication
        key: tls.crt
      sslRootCert:
        name: %s-ca
        key: ca.crt
`

const logicalExternalCluster = `  externalClusters:
    - name: origin-app
      connectionParameters:
        host: %s-rw
        user: app
        dbname: app
        sslmode: require
      password:
        name: %s-app
        key: password
`

// StageStreamingReplicaManifest writes — but does not apply — a replica Cluster that
// bootstraps from the source over streaming replication. `bootstrap.pg_basebackup` clones
// the source once; `replica.enabled` is what keeps it a standby afterwards rather than
// letting it promote itself the moment the clone finishes.
func (c *CNPG) StageStreamingReplicaManifest(ctx context.Context, serverID, source, replica string, logf func(string)) error {
	manifest := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: %s
  namespace: default
spec:
  instances: 1
  imageName: %s
  storage:
    size: 1Gi
  bootstrap:
    pg_basebackup:
      source: origin
  replica:
    enabled: true
    source: origin
`+streamingExternalCluster, replica, cnpgPostgresImage, source, source, source, source)

	logf("staging the replica cluster manifest on the server node")
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "replica-cluster.yaml", []byte(manifest), 0644)
}

// ApplyTargetCluster builds the second, independent cluster the logical-replication lab
// subscribes *from*. It is a normal cluster — not a replica — carrying an externalClusters
// entry that points back at the source with a password role, which is what a declarative
// Subscription resolves its `externalClusterName` against.
func (c *CNPG) ApplyTargetCluster(ctx context.Context, serverID, source, target string, logf func(string)) error {
	manifest := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: %s
  namespace: default
spec:
  instances: 1
  imageName: %s
  storage:
    size: 1Gi
`+logicalExternalCluster, target, cnpgPostgresImage, source, source)

	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "target-cluster.yaml", []byte(manifest), 0644); err != nil {
		return err
	}
	logf("applying the second cluster " + target + " (the subscriber)")
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/target-cluster.yaml")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply target cluster: exit %d: %s", res.ExitCode, res.Stderr)
	}

	logf("waiting for " + target + " to report healthy")
	deadline := time.Now().Add(8 * time.Minute)
	for time.Now().Before(deadline) {
		res, err := c.k3d.Kubectl(ctx, serverID, "get", "cluster.postgresql.cnpg.io", target, "-o", "jsonpath={.status.phase}")
		if err == nil && res.ExitCode == 0 && strings.TrimSpace(res.Stdout) == "Cluster in healthy state" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for cluster %s to become healthy", target)
}

// StageLogicalManifests writes the Publication and Subscription the learner applies. Both
// are staged rather than applied, because declaring them is the lab.
//
// `publicationDBName` is the field this lab exists to teach. The external cluster it points
// at connects to a named database; the publication lives in whichever database it was
// created in. When those differ the subscription connects successfully and then reports
// that the publication does not exist — a warning in the subscriber's log rather than an
// error on the resource, which is exactly the kind of failure that wastes an afternoon.
func (c *CNPG) StageLogicalManifests(ctx context.Context, serverID, source, target string, logf func(string)) error {
	publication := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Publication
metadata:
  name: orders-pub
  namespace: default
spec:
  name: orders_pub
  dbname: app
  cluster:
    name: %s
  target:
    objects:
      - table:
          name: orders
`, source)

	subscription := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Subscription
metadata:
  name: orders-sub
  namespace: default
spec:
  name: orders_sub
  dbname: app
  cluster:
    name: %s
  externalClusterName: origin-app
  publicationName: orders_pub
  publicationDBName: app
`, target)

	logf("staging the Publication and Subscription manifests on the server node")
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "publication.yaml", []byte(publication), 0644); err != nil {
		return err
	}
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "subscription.yaml", []byte(subscription), 0644)
}

/* --------------------------------------------- image catalogs and replica bootstraps */

// StageImageCatalogManifest writes an ImageCatalog naming the *older* PostgreSQL image for
// major 18, plus the patch that points the Cluster at it. Neither is applied: adopting the
// catalog and then moving it forward is the lab.
//
// The schema is easy to get wrong. `spec.images` is the required list and its entries are
// {major, image}; `spec.componentImages` is a separate optional list keyed by {key, image}
// for non-PostgreSQL components such as PgBouncer. Putting `major` under componentImages is
// rejected by the API server with a strict-decoding error.
func (c *CNPG) StageImageCatalogManifest(ctx context.Context, serverID string, logf func(string)) error {
	catalog := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: ImageCatalog
metadata:
  name: postgres-catalog
  namespace: default
spec:
  images:
    - major: 18
      image: %s
`, cnpgPreviousPostgresImage)

	logf("staging the ImageCatalog manifest on the server node")
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "catalog.yaml", []byte(catalog), 0644)
}

// StageReplicaFromBackupManifest writes — but does not apply — a replica Cluster that
// bootstraps from the object store rather than from a live connection.
//
// The difference from a streaming replica cluster is where the data and the ongoing changes
// come from. `bootstrap.recovery` restores the base backup out of the bucket, and because
// `replica.enabled` is set the cluster then stays in recovery and keeps replaying WAL the
// source archives — so the two clusters are coupled only through object storage and never
// talk to each other directly. That is what makes this the cross-region shape.
func (c *CNPG) StageReplicaFromBackupManifest(ctx context.Context, serverID, sourceCluster, replica string, logf func(string)) error {
	manifest := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: %s
  namespace: default
spec:
  instances: 1
  imageName: %s
  storage:
    size: 1Gi
  bootstrap:
    recovery:
      source: origin
  replica:
    enabled: true
    source: origin
  externalClusters:
  - name: origin
    plugin:
      name: %s
      parameters:
        barmanObjectName: %s
        serverName: %s
`, replica, cnpgPostgresImage, barmanPluginName, objectStoreName, sourceCluster)

	logf("staging the replica-from-backup manifest on the server node")
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "replica-cluster.yaml", []byte(manifest), 0644)
}

// StageSnapshotReplicaManifests writes the two manifests the volume-snapshot replica lab
// applies: a VolumeSnapshot of the source cluster's PVC, and a replica Cluster that
// bootstraps from that snapshot and then follows the source by streaming.
//
// Two constraints from the CSI setup are baked in (see csi.go): the hostpath driver is a
// single-replica StatefulSet, so every cluster here is single-instance and pinned to the
// server node; and the snapshot class is the driver's own. The streaming half needs the
// source's certificates exactly as the streaming replica-cluster lab does, because
// `streaming_replica` authenticates by certificate and may only reach the postgres database.
func (c *CNPG) StageSnapshotReplicaManifests(ctx context.Context, serverID, sourceCluster, replica, nodeName string, logf func(string)) error {
	snapshot := fmt.Sprintf(`apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: %s-snapshot
  namespace: default
spec:
  volumeSnapshotClassName: %s
  source:
    persistentVolumeClaimName: %s-1
`, sourceCluster, snapshotClassName, sourceCluster)

	cluster := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: %s
  namespace: default
spec:
  instances: 1
  imageName: %s
  affinity:
    nodeSelector:
      kubernetes.io/hostname: %s
  storage:
    size: 1Gi
    storageClass: %s
  bootstrap:
    recovery:
      volumeSnapshots:
        storage:
          name: %s-snapshot
          kind: VolumeSnapshot
          apiGroup: snapshot.storage.k8s.io
  replica:
    enabled: true
    source: origin
`+streamingExternalCluster, replica, cnpgPostgresImage, nodeName, snapshotStorageClass,
		sourceCluster, sourceCluster, sourceCluster, sourceCluster, sourceCluster)

	logf("staging the VolumeSnapshot and replica cluster manifests on the server node")
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "snapshot.yaml", []byte(snapshot), 0644); err != nil {
		return err
	}
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "replica-cluster.yaml", []byte(cluster), 0644)
}

// StageInitdbManifest writes — but does not apply — a Cluster whose `bootstrap.initdb`
// block sets every option worth seeing: a non-default database and owner, explicit encoding
// and locale, checksums, a non-default WAL segment size, and both post-init SQL hooks.
//
// The point of the lab it serves is that none of this can be changed afterwards. `bootstrap`
// is a one-shot instruction rather than desired state: patching these fields on a running
// cluster is *accepted* by the API server and then has no effect at all, leaving the spec
// permanently describing something the database is not.
func (c *CNPG) StageInitdbManifest(ctx context.Context, serverID, name string, logf func(string)) error {
	manifest := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: %s
  namespace: default
spec:
  instances: 2
  imageName: %s
  storage:
    size: 1Gi
  bootstrap:
    initdb:
      database: orders
      owner: shop
      encoding: UTF8
      localeCollate: C
      localeCType: C
      dataChecksums: true
      walSegmentSize: 32
      postInitSQL:
        - CREATE ROLE auditor NOLOGIN
      postInitApplicationSQL:
        - CREATE TABLE seeded (id serial primary key, note text)
        - INSERT INTO seeded (note) VALUES ('from postInitApplicationSQL')
`, name, cnpgPostgresImage)

	logf("staging the initdb cluster manifest on the server node")
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "initdb-cluster.yaml", []byte(manifest), 0644)
}

// InstallPlugin puts the `cnpg` kubectl plugin on every node, so the labs whose subject is
// a plugin command can run `kubectl cnpg ...` from any terminal tab. The release publishes
// one tarball per architecture, and the nodes are whatever the host is (no `platform:` pin
// anywhere in this app), so the arch is read off a node rather than assumed.
func (c *CNPG) InstallPlugin(ctx context.Context, nodes []NodeInfo, logf func(string)) error {
	if len(nodes) == 0 {
		return fmt.Errorf("no nodes to install the cnpg plugin on")
	}
	arch, err := c.nodeArch(ctx, nodes[0].ID)
	if err != nil {
		return err
	}
	logf("fetching the cnpg kubectl plugin v" + cnpgVersion + " (linux/" + arch + ")")
	tarball, err := httpGet(ctx, fmt.Sprintf(cnpgPluginURLFmt, cnpgVersion, cnpgVersion, arch))
	if err != nil {
		return fmt.Errorf("fetch kubectl-cnpg: %w", err)
	}
	files, err := untarGz(tarball)
	if err != nil {
		return fmt.Errorf("unpack kubectl-cnpg: %w", err)
	}
	bin := files["kubectl-cnpg"]
	if bin == nil {
		return fmt.Errorf("kubectl-cnpg binary not found in the v%s plugin tarball", cnpgVersion)
	}

	logf("installing it on all 3 nodes as `kubectl cnpg`")
	for _, n := range nodes {
		if _, err := c.k3d.docker.ExecRoot(ctx, n.ID, []string{"mkdir", "-p", cnpgPluginDir}, nil); err != nil {
			return err
		}
		if err := c.k3d.docker.PutArchive(ctx, n.ID, cnpgPluginDir, "kubectl-cnpg", bin, 0755); err != nil {
			return err
		}
	}
	return nil
}

// nodeArch translates a node container's `uname -m` into the architecture slug CNPG's
// release assets are named with (kubectl-cnpg_<v>_linux_arm64 / _linux_x86_64).
func (c *CNPG) nodeArch(ctx context.Context, nodeID string) (string, error) {
	res, err := c.k3d.docker.ExecRoot(ctx, nodeID, []string{"uname", "-m"}, nil)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("uname -m on node: exit %d: %s", res.ExitCode, res.Stderr)
	}
	switch m := strings.TrimSpace(res.Stdout); m {
	case "aarch64", "arm64":
		return "arm64", nil
	case "x86_64", "amd64":
		return "x86_64", nil
	default:
		return "", fmt.Errorf("no CNPG plugin release for node architecture %q", m)
	}
}

// psqlClientManifest is a plain, long-lived Postgres client Pod — the honest shape of "an
// application connecting to the database", as opposed to running psql inside an instance
// Pod, which is what makes it the right vantage point for the Service-connectivity and
// PgBouncer labs. Its credentials come from the operator-generated <cluster>-app Secret by
// reference, so nothing anywhere prints or stores the password.
func psqlClientManifest(clusterName string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Pod
metadata:
  name: psql-client
  namespace: default
spec:
  restartPolicy: Never
  containers:
  - name: psql
    image: %s
    command: ["sleep", "infinity"]
    env:
    - name: PGUSER
      value: app
    - name: PGDATABASE
      value: app
    - name: PGPASSWORD
      valueFrom:
        secretKeyRef:
          name: %s-app
          key: password
`, cnpgPostgresImage, clusterName)
}

// ApplyPSQLClient stages and applies the client Pod above, and waits for it to be running
// so the lab's very first command is not "wait for a container to start".
func (c *CNPG) ApplyPSQLClient(ctx context.Context, serverID, clusterName string, logf func(string)) error {
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "psql-client.yaml", []byte(psqlClientManifest(clusterName)), 0644); err != nil {
		return err
	}
	logf("starting a psql client Pod to connect from")
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/psql-client.yaml")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply psql-client: exit %d: %s", res.ExitCode, res.Stderr)
	}
	return c.k3d.waitPodReady(ctx, serverID, "psql-client", 3*time.Minute)
}

// StagePoolerManifest writes (but does not apply) a Pooler manifest — the PgBouncer lab's
// own graded action is applying it. Session pooling and a deliberately small pool are what
// make the "many client connections, few server connections" observation legible.
func (c *CNPG) StagePoolerManifest(ctx context.Context, serverID, clusterName string, instances int) error {
	manifest := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: %s-pooler-rw
  namespace: default
spec:
  cluster:
    name: %s
  instances: %d
  type: rw
  pgbouncer:
    poolMode: session
    parameters:
      max_client_conn: "100"
      default_pool_size: "5"
`, clusterName, clusterName, instances)
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "pooler.yaml", []byte(manifest), 0644)
}

// StageCertClientManifest writes (but does not apply) a client Pod that mounts the cluster
// CA and a client certificate the learner has not issued yet — applying it, once that
// Secret exists, is the certificates lab's own graded action.
//
// Two details are load-bearing and worth reading before editing: only `ca.crt` is projected
// out of the CA Secret (it also holds `ca.key`, which no client has any business seeing),
// and fsGroup + mode 0640 exist because libpq refuses a private key that is group- or
// world-writable and the image runs as uid 26.
func (c *CNPG) StageCertClientManifest(ctx context.Context, serverID, clusterName, certSecret string) error {
	manifest := fmt.Sprintf(`apiVersion: v1
kind: Pod
metadata:
  name: cert-client
  namespace: default
spec:
  restartPolicy: Never
  securityContext:
    fsGroup: 26
  containers:
  - name: psql
    image: %s
    command: ["sleep", "infinity"]
    volumeMounts:
    - name: ca
      mountPath: /etc/tls/ca
    - name: client
      mountPath: /etc/tls/client
  volumes:
  - name: ca
    secret:
      secretName: %s-ca
      defaultMode: 0640
      items:
      - key: ca.crt
        path: ca.crt
  - name: client
    secret:
      secretName: %s
      defaultMode: 0640
`, cnpgPostgresImage, clusterName, certSecret)
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "cert-client.yaml", []byte(manifest), 0644)
}

/* ------------------------------------------------------------------ backup stack */

const (
	// The Barman Cloud plugin is how CloudNativePG 1.30 does object-store backups: the
	// in-tree spec.backup.barmanObjectStore still exists but the API server answers every
	// use of it with a deprecation warning and it is removed in 1.31, so teaching it would
	// be teaching a dead end.
	barmanPluginVersion  = "v0.14.0"
	barmanPluginManifest = "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/" + barmanPluginVersion + "/manifest.yaml"
	barmanPluginImage    = "ghcr.io/cloudnative-pg/plugin-barman-cloud:" + barmanPluginVersion
	barmanPluginDeploy   = "barman-cloud"
	barmanPluginName     = "barman-cloud.cloudnative-pg.io"

	// cert-manager is not optional decoration here: the plugin manifest contains Certificate
	// and Issuer resources for the mTLS between the operator and the plugin, so applying it
	// without cert-manager's CRDs fails outright.
	certManagerVersion  = "v1.19.1"
	certManagerManifest = "https://github.com/cert-manager/cert-manager/releases/download/" + certManagerVersion + "/cert-manager.yaml"
	certManagerNS       = "cert-manager"

	// The bucket SeaweedFS is provisioned with, and the in-cluster name the labs address it
	// by (see ExposeSeaweedFS).
	backupBucket    = "cnpg-backups"
	seaweedSvcName  = "seaweedfs"
	seaweedS3Port   = 8333
	objectStoreName = "seaweedfs-store"
)

var certManagerImages = []string{
	"quay.io/jetstack/cert-manager-controller:" + certManagerVersion,
	"quay.io/jetstack/cert-manager-webhook:" + certManagerVersion,
	"quay.io/jetstack/cert-manager-cainjector:" + certManagerVersion,
}

// backupStackImages are pre-seeded into the nodes for the backup labs, for the same reason
// the Postgres image is: a node that has to fetch these itself does it while the learner
// watches a progress bar.
var backupStackImages = append([]string{barmanPluginImage}, certManagerImages...)

// InstallCertManager applies the upstream manifest and waits for all three of its
// Deployments, because the plugin's Certificates cannot be issued until the webhook is
// actually serving.
func (c *CNPG) InstallCertManager(ctx context.Context, serverID string, logf func(string)) error {
	logf("fetching cert-manager " + certManagerVersion)
	manifest, err := httpGet(ctx, certManagerManifest)
	if err != nil {
		return fmt.Errorf("fetch cert-manager: %w", err)
	}
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "cert-manager.yaml", manifest, 0644); err != nil {
		return err
	}
	logf("applying cert-manager (the backup plugin's certificates need it)")
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/cert-manager.yaml")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply cert-manager: exit %d: %s", res.ExitCode, res.Stderr)
	}
	logf("waiting for cert-manager to be ready")
	for _, d := range []string{"cert-manager", "cert-manager-cainjector", "cert-manager-webhook"} {
		if err := c.k3d.waitDeployment(ctx, serverID, certManagerNS, d, 5*time.Minute); err != nil {
			return err
		}
	}
	return nil
}

// InstallBarmanPlugin applies the Barman Cloud plugin and waits for it to be serving. It
// registers the ObjectStore CRD the labs then use.
func (c *CNPG) InstallBarmanPlugin(ctx context.Context, serverID string, logf func(string)) error {
	logf("fetching the Barman Cloud plugin " + barmanPluginVersion)
	manifest, err := httpGet(ctx, barmanPluginManifest)
	if err != nil {
		return fmt.Errorf("fetch barman plugin: %w", err)
	}
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "barman-plugin.yaml", manifest, 0644); err != nil {
		return err
	}
	logf("applying the Barman Cloud plugin")
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/barman-plugin.yaml")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply barman plugin: exit %d: %s", res.ExitCode, res.Stderr)
	}
	logf("waiting for the plugin and its ObjectStore CRD")
	if err := c.k3d.waitCRD(ctx, serverID, "objectstores.barmancloud.cnpg.io", 3*time.Minute); err != nil {
		return err
	}
	return c.k3d.waitDeployment(ctx, serverID, cnpgNamespace, barmanPluginDeploy, 5*time.Minute)
}

// ExposeSeaweedFS gives the attempt's SeaweedFS container a stable in-cluster name.
//
// The object store is a sibling container on the attempt's Docker network, not a Pod: its
// address changes per attempt and Pods cannot resolve Docker's embedded DNS. A Service with
// no selector plus a hand-written EndpointSlice pointing at the container's address fixes
// both problems at once — every lab can then say `http://seaweedfs:8333` and mean it.
func (c *CNPG) ExposeSeaweedFS(ctx context.Context, serverID, address string, logf func(string)) error {
	manifest := fmt.Sprintf(`apiVersion: v1
kind: Service
metadata:
  name: %[1]s
  namespace: default
spec:
  ports:
  - name: s3
    port: %[2]d
    targetPort: %[2]d
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: %[1]s-manual
  namespace: default
  labels:
    kubernetes.io/service-name: %[1]s
addressType: IPv4
ports:
- name: s3
  port: %[2]d
endpoints:
- addresses: ["%[3]s"]
  conditions:
    ready: true
`, seaweedSvcName, seaweedS3Port, address)
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "seaweedfs-service.yaml", []byte(manifest), 0644); err != nil {
		return err
	}
	logf("publishing SeaweedFS in-cluster as " + seaweedSvcName + ":" + strconv.Itoa(seaweedS3Port))
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/seaweedfs-service.yaml")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply seaweedfs service: exit %d: %s", res.ExitCode, res.Stderr)
	}
	return nil
}

// StageBackupManifests writes the three resources the object-store backup lab applies: the
// ObjectStore that describes the bucket, a one-off Backup, and a ScheduledBackup. Staged,
// not applied — creating them is what the lab teaches.
// objectStoreManifest describes the attempt's SeaweedFS bucket to the Barman Cloud plugin.
// Shared, because both the lab that has the learner apply it and the labs that need it
// already applied must produce exactly the same object.
func objectStoreManifest() string {
	return fmt.Sprintf(`apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: %s
  namespace: default
spec:
  retentionPolicy: 30d
  configuration:
    destinationPath: s3://%s/
    endpointURL: http://%s:%d
    s3Credentials:
      accessKeyId:
        name: seaweedfs-creds
        key: ACCESS_KEY_ID
      secretAccessKey:
        name: seaweedfs-creds
        key: ACCESS_SECRET_KEY
    wal:
      compression: gzip
`, objectStoreName, backupBucket, seaweedSvcName, seaweedS3Port)
}

func (c *CNPG) StageBackupManifests(ctx context.Context, serverID, clusterName string) error {
	objectStore := objectStoreManifest()

	backup := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: first-backup
  namespace: default
spec:
  cluster:
    name: %s
  method: plugin
  pluginConfiguration:
    name: %s
`, clusterName, barmanPluginName)

	scheduled := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: every-two-minutes
  namespace: default
spec:
  schedule: "0 */2 * * * *"
  backupOwnerReference: self
  cluster:
    name: %s
  method: plugin
  pluginConfiguration:
    name: %s
`, clusterName, barmanPluginName)

	for name, body := range map[string]string{
		"objectstore.yaml":     objectStore,
		"backup.yaml":          backup,
		"scheduledbackup.yaml": scheduled,
	} {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", name, []byte(body), 0644); err != nil {
			return err
		}
	}
	return nil
}

// ConfigureBarmanBackup wires a cluster to the object store and waits until WAL is really
// arriving there — the precondition for the labs whose subject is *restoring*, which need a
// working archive before the learner starts rather than as their first exercise.
func (c *CNPG) ConfigureBarmanBackup(ctx context.Context, serverID, clusterName string, logf func(string)) error {
	logf("creating the object store credentials and ObjectStore")
	res, err := c.k3d.Kubectl(ctx, serverID, "create", "secret", "generic", "seaweedfs-creds",
		"--from-literal=ACCESS_KEY_ID=seaweedfs", "--from-literal=ACCESS_SECRET_KEY=seaweedfs_password")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 && !strings.Contains(res.Stderr, "already exists") {
		return fmt.Errorf("create seaweedfs-creds: exit %d: %s", res.ExitCode, res.Stderr)
	}
	// Written here rather than assumed: the labs whose subject is *restoring* never stage a
	// backup manifest of their own, so this step has to produce the ObjectStore it applies.
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "objectstore.yaml", []byte(objectStoreManifest()), 0644); err != nil {
		return err
	}
	if res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/objectstore.yaml"); err != nil {
		return err
	} else if res.ExitCode != 0 {
		return fmt.Errorf("apply objectstore: exit %d: %s", res.ExitCode, res.Stderr)
	}

	logf("switching WAL archiving on (the operator rolls the instances for this)")
	patchedAt := time.Now()
	patch := fmt.Sprintf(`{"spec":{"plugins":[{"name":%q,"isWALArchiver":true,"parameters":{"barmanObjectName":%q}}]}}`,
		barmanPluginName, objectStoreName)
	if res, err := c.k3d.Kubectl(ctx, serverID, "patch", "cluster.postgresql.cnpg.io", clusterName, "--type=merge", "-p", patch); err != nil {
		return err
	} else if res.ExitCode != 0 {
		return fmt.Errorf("enable wal archiving: exit %d: %s", res.ExitCode, res.Stderr)
	}

	// Two separate things have to be true before a backup can be taken, and waiting for only
	// one of them is a real trap: ContinuousArchiving turns True as soon as the *primary*
	// ships a WAL file, but a backup is taken from a standby by default, and a standby that
	// has not yet been rolled onto the new Pod spec answers "requested plugin is not
	// available". So this also waits for every instance to have been replaced by the rollout
	// the patch above triggered.
	logf("waiting for the rollout and for the first WAL file to reach the bucket")
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		res, err := c.k3d.Kubectl(ctx, serverID, "get", "cluster.postgresql.cnpg.io", clusterName,
			"-o", `jsonpath={.status.readyInstances} {range .status.conditions[?(@.type=="ContinuousArchiving")]}{.status}{end}`)
		if err == nil && res.ExitCode == 0 && strings.TrimSpace(res.Stdout) == "3 True" {
			rolled, err := c.instancesRolledSince(ctx, serverID, clusterName, patchedAt)
			if err == nil && rolled {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for WAL archiving on %s", clusterName)
}

// TakeBackup asks for a base backup and waits for it to complete, so a restore lab starts
// from a real backup in a real bucket.
func (c *CNPG) TakeBackup(ctx context.Context, serverID, clusterName, backupName string, logf func(string)) error {
	manifest := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: %s
  namespace: default
spec:
  cluster:
    name: %s
  method: plugin
  pluginConfiguration:
    name: %s
`, backupName, clusterName, barmanPluginName)
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", backupName+".yaml", []byte(manifest), 0644); err != nil {
		return err
	}
	logf("taking a base backup into the object store")
	if res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/"+backupName+".yaml"); err != nil {
		return err
	} else if res.ExitCode != 0 {
		return fmt.Errorf("apply backup: exit %d: %s", res.ExitCode, res.Stderr)
	}

	logf("waiting for the backup to complete")
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		res, err := c.k3d.Kubectl(ctx, serverID, "get", "backup", backupName, "-o", `jsonpath={.status.phase}|{.status.error}`)
		if err == nil && res.ExitCode == 0 {
			phase, backupErr := splitPipe(res.Stdout)
			switch phase {
			case "completed":
				return nil
			case "failed":
				return fmt.Errorf("base backup %s failed: %s", backupName, backupErr)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for backup %s", backupName)
}

// instancesRolledSince reports whether every instance Pod was created after t — i.e. the
// rollout a spec change triggered has actually reached all of them.
func (c *CNPG) instancesRolledSince(ctx context.Context, serverID, clusterName string, t time.Time) (bool, error) {
	res, err := c.k3d.Kubectl(ctx, serverID, "get", "pods", "-l", "cnpg.io/cluster="+clusterName,
		"-o", `jsonpath={range .items[*]}{.metadata.creationTimestamp}{"\n"}{end}`)
	if err != nil {
		return false, err
	}
	if res.ExitCode != 0 {
		return false, fmt.Errorf("listing instance pods: exit %d: %s", res.ExitCode, res.Stderr)
	}
	lines := strings.Fields(strings.TrimSpace(res.Stdout))
	if len(lines) == 0 {
		return false, nil
	}
	for _, l := range lines {
		created, err := time.Parse(time.RFC3339, l)
		if err != nil || !created.After(t) {
			return false, nil
		}
	}
	return true, nil
}

// recoveryClusterManifest is a Cluster that bootstraps by recovering from the object store
// rather than by initdb. `externalClusters` is where the plugin is named; `serverName` is
// which server's data to read out of the bucket, which is the source cluster's name.
func recoveryClusterManifest(name, sourceCluster, targetTime string) string {
	target := ""
	if targetTime != "" {
		target = fmt.Sprintf("      recoveryTarget:\n        targetTime: \"%s\"\n", targetTime)
	}
	return fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: %s
  namespace: default
spec:
  instances: 1
  imageName: %s
  storage:
    size: 1Gi
  bootstrap:
    recovery:
      source: origin
%s  externalClusters:
  - name: origin
    plugin:
      name: %s
      parameters:
        barmanObjectName: %s
        serverName: %s
`, name, cnpgPostgresImage, target, barmanPluginName, objectStoreName, sourceCluster)
}

// StageRestoreManifest writes the recovery Cluster the restore lab applies.
func (c *CNPG) StageRestoreManifest(ctx context.Context, serverID, sourceCluster, name string) error {
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "restore.yaml",
		[]byte(recoveryClusterManifest(name, sourceCluster, "")), 0644)
}

// GenerateWAL fills the archive with enough WAL segments that replaying them is the
// dominant cost of a recovery — which is what makes the sequential/parallel comparison in
// the WAL-restore lab measurable rather than lost in scheduling noise.
func (c *CNPG) GenerateWAL(ctx context.Context, serverID, clusterName string, logf func(string)) error {
	logf("filling the WAL archive (this is what makes the restore timings comparable)")
	stmts := []string{
		"CREATE TABLE IF NOT EXISTS bulk (id serial primary key, pad text);",
	}
	for i := 0; i < 6; i++ {
		stmts = append(stmts, "INSERT INTO bulk (pad) SELECT repeat(md5(g::text),60) FROM generate_series(1,120000) g;")
	}
	for _, sql := range stmts {
		res, err := runSQL(ctx, c.k3d.docker, serverID, []string{
			"kubectl", "exec", "psql-client", "--", "psql", "-h", clusterName + "-rw", "-c", sql,
		})
		if err != nil {
			return err
		}
		if !res.ok() {
			return fmt.Errorf("generating WAL: %s", firstLine(res.stderr))
		}
	}

	// Close the current segment so everything written above is archived rather than sitting
	// in a partial segment the recovery cannot use.
	res, err := c.k3d.Kubectl(ctx, serverID, "get", "cluster.postgresql.cnpg.io", clusterName, "-o", "jsonpath={.status.currentPrimary}")
	if err != nil {
		return err
	}
	primary := strings.TrimSpace(res.Stdout)
	if _, err := runSQL(ctx, c.k3d.docker, serverID, []string{
		"kubectl", "exec", primary, "-c", "postgres", "--", "psql", "-U", "postgres", "-c", "SELECT pg_switch_wal();",
	}); err != nil {
		return err
	}

	logf("waiting for the archive to catch up")
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		res, err := psqlSuper(ctx, c.k3d.docker, serverID, primary, "postgres",
			"SELECT count(*) FROM pg_stat_archiver WHERE last_failed_wal IS NULL OR last_archived_wal > last_failed_wal;")
		if err == nil && res.count() >= 1 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for the WAL archive to catch up")
}

// StageWALRestoreManifests writes the two recovery Clusters the WAL-restore lab times
// against each other. They are identical: the only difference between the runs is the
// maxParallel setting on the ObjectStore, which is the point.
func (c *CNPG) StageWALRestoreManifests(ctx context.Context, serverID, sourceCluster string) error {
	for name, file := range map[string]string{
		"pg-seq": "restore-sequential.yaml",
		"pg-par": "restore-parallel.yaml",
	} {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", file,
			[]byte(recoveryClusterManifest(name, sourceCluster, "")), 0644); err != nil {
			return err
		}
	}
	return nil
}

// StagePITRTemplate writes the point-in-time recovery Cluster as a *template*: the learner
// substitutes the timestamp they recorded, because the whole point is choosing the moment.
func (c *CNPG) StagePITRTemplate(ctx context.Context, serverID, sourceCluster, name string) error {
	return c.k3d.docker.PutArchive(ctx, serverID, "/root", "pitr.yaml.template",
		[]byte(recoveryClusterManifest(name, sourceCluster, "TARGET_TIME")), 0644)
}

// Baseline reads which instance is primary, its PVC's real volume name, and the node its
// volume is pinned to — the same "prove something actually changed" facts the
// persistent-volume lab's grader needs, captured once right after provisioning instead
// of faked by a simulated world.baseline.
func (c *CNPG) Baseline(ctx context.Context, serverID, clusterName string) (primary, volume, node string, err error) {
	res, err := c.k3d.Kubectl(ctx, serverID, "get", "cluster.postgresql.cnpg.io", clusterName, "-o", "jsonpath={.status.currentPrimary}")
	if err != nil {
		return "", "", "", err
	}
	if res.ExitCode != 0 {
		return "", "", "", fmt.Errorf("reading current primary: exit %d: %s", res.ExitCode, res.Stderr)
	}
	primary = strings.TrimSpace(res.Stdout)

	res, err = c.k3d.Kubectl(ctx, serverID, "get", "pvc", primary, "-o", "jsonpath={.spec.volumeName}")
	if err != nil {
		return "", "", "", err
	}
	if res.ExitCode != 0 {
		return "", "", "", fmt.Errorf("reading primary PVC volume: exit %d: %s", res.ExitCode, res.Stderr)
	}
	volume = strings.TrimSpace(res.Stdout)

	res, err = c.k3d.Kubectl(ctx, serverID, "get", "pvc", primary, "-o", "jsonpath={.metadata.annotations.volume\\.kubernetes\\.io/selected-node}")
	if err != nil {
		return "", "", "", err
	}
	if res.ExitCode != 0 {
		return "", "", "", fmt.Errorf("reading primary PVC selected-node: exit %d: %s", res.ExitCode, res.Stderr)
	}
	node = strings.TrimSpace(res.Stdout)
	return primary, volume, node, nil
}

func untarGz(data []byte) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		buf := make([]byte, hdr.Size)
		if _, err := io.ReadFull(tr, buf); err != nil {
			return nil, err
		}
		out[hdr.Name] = buf
	}
	return out, nil
}

func stripFirstDir(name string) string {
	i := strings.IndexByte(name, '/')
	if i < 0 {
		return name
	}
	return name[i+1:]
}
