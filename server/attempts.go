package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// attempts.go — the attempt registry: one real k3d + CNPG + SeaweedFS environment per
// lab attempt, provisioned async and torn down on demand. Mirrors dbcanvas's own
// deployment/progress-log pattern, scaled down to this app's single-stack-per-attempt
// shape (no stack designer, no multi-node-type canvas — just "give me lab X").

const maxConcurrentAttempts = 2

var validLabs = map[string]bool{
	"cnpg-operator-install":         true,
	"cnpg-cluster-creation":         true,
	"cnpg-persistent-volume":        true,
	"cnpg-service-connectivity":     true,
	"cnpg-client-certificates":      true,
	"cnpg-server-certificates":      true,
	"cnpg-pgbouncer":                true,
	"cnpg-failover":                 true,
	"cnpg-switchover":               true,
	"cnpg-failover-endpoint-time":   true,
	"cnpg-switchover-endpoint-time": true,
	"cnpg-degraded-recovery":        true,
	"cnpg-pvc-deletion":             true,
	"cnpg-corrupted-pvc":            true,
	"cnpg-barman-backup":            true,
	"cnpg-volume-snapshots":         true,
	"cnpg-barman-restore":           true,
	"cnpg-pitr":                     true,
	"cnpg-operator-deployment":      true,
	"cnpg-operator-configmap":       true,
	"cnpg-operator-pod-deletion":    true,
	"cnpg-wal-restore":              true,
	"cnpg-operator-eviction":        true,
	"cnpg-operator-upgrade":         true,
	"cnpg-operator-ha":              true,
	"cnpg-metrics":                  true,
	"cnpg-pgbouncer-metrics":        true,
	"cnpg-json-logs":                true,
	"cnpg-replication-slots":        true,
	"cnpg-synchronous-replication":  true,
	"cnpg-cluster-scaling":          true,
	"cnpg-logical-replication":      true,
	"cnpg-replica-cluster":          true,
	"cnpg-fencing":                  true,
	"cnpg-hibernation":              true,
	"cnpg-config-changes":           true,
	"cnpg-rolling-update":           true,
	"cnpg-image-catalog":            true,
	"cnpg-hot-standby-params":       true,
	"cnpg-replica-from-backup":      true,
	"cnpg-replica-from-snapshot":    true,
	"cnpg-initdb":                   true,
	"cnpg-taints-tolerations":       true,
	"cnpg-node-selector":            true,
	"cnpg-podspec-drift":            true,
	"cnpg-in-place-upgrade":         true,
	"cnpg-multi-arch":               true,
	"cnpg-inherited-metadata":       true,
	"cnpg-object-metadata":          true,
	"cnpg-data-corruption":          true,
	"cnpg-basebackup-clone":         true,
	"cnpg-import-microservice":      true,
	"cnpg-import-monolith":          true,
	"cnpg-storage-expansion":        true,
	"cnpg-wal-volume":               true,
	"cnpg-node-drain":               true,
	"cnpg-single-instance-drain":    true,
	"cnpg-declarative-hibernation":  true,
	"cnpg-snapshot-modes":           true,
	"cnpg-snapshot-pitr":            true,
	"cnpg-plugin-snapshot-backup":   true,
	"cnpg-scheduled-snapshots":      true,
	"cnpg-managed-roles":            true,
	"cnpg-role-passwords":           true,
	"cnpg-tablespaces":              true,
	"cnpg-temporary-tablespaces":    true,
	"cnpg-tablespace-backup":        true,
	"cnpg-tablespace-snapshot":      true,
	"cnpg-declarative-databases":    true,
	"cnpg-database-reclaim":         true,
	"cnpg-major-upgrade":            true,
}

type Baseline struct {
	Primary string `json:"primary"`
	Volume  string `json:"volume"`
	Node    string `json:"node"`
}

// Attempt is the mutable, lock-guarded record of one provisioning run. Never copy it by
// value (it embeds a mutex) — use snapshot() to get a safe read for API responses.
type Attempt struct {
	mu sync.Mutex

	id          string
	labID       string
	status      string // provisioning | ready | error | destroyed
	phaseLog    []string
	err         string
	clusterName string
	network     string
	nodes       []NodeInfo
	seaweedID   string
	toolboxID   string
	baseline    *Baseline
	createdAt   time.Time

	// Cancellation for an abort mid-provision. Tearing an attempt down while its
	// provisioner is still running is not enough on its own: the goroutine would carry on
	// creating the very resources the teardown just removed, re-leaking a cluster and its
	// /16. Destroy cancels first and waits for `finished` before removing anything.
	cancel   context.CancelFunc
	finished chan struct{}
}

func (a *Attempt) log(msg string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	log.Printf("[%s] %s", a.id, msg)
	a.phaseLog = append(a.phaseLog, msg)
}

func (a *Attempt) setCancel(fn context.CancelFunc) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancel = fn
}

// abort cancels the provisioning goroutine, if one is still running, and reports whether
// there was anything to cancel.
func (a *Attempt) abort() bool {
	a.mu.Lock()
	fn := a.cancel
	a.cancel = nil
	a.mu.Unlock()
	if fn == nil {
		return false
	}
	fn()
	return true
}

func (a *Attempt) setStatus(status string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status = status
}

func (a *Attempt) setError(err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	log.Printf("[%s] error: %v", a.id, err)
	a.status = "error"
	a.err = err.Error()
}

func (a *Attempt) setNodes(nodes []NodeInfo) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nodes = nodes
}

func (a *Attempt) setSeaweedID(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seaweedID = id
}

func (a *Attempt) setToolboxID(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.toolboxID = id
}

func (a *Attempt) toolboxIDSnap() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.toolboxID
}

func (a *Attempt) setBaseline(b *Baseline) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.baseline = b
}

// AttemptView is the JSON-safe, mutex-free copy handed to the API layer.
type AttemptView struct {
	ID        string    `json:"id"`
	LabID     string    `json:"labId"`
	Status    string    `json:"status"`
	PhaseLog  []string  `json:"phaseLog"`
	Error     string    `json:"error,omitempty"`
	Nodes     []string  `json:"nodes,omitempty"` // frontend-facing node ids (k3d-server, ...)
	Baseline  *Baseline `json:"baseline,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

func (a *Attempt) view() AttemptView {
	a.mu.Lock()
	defer a.mu.Unlock()
	nodeIDs := make([]string, len(a.nodes))
	for i, n := range a.nodes {
		nodeIDs[i] = n.LabID
	}
	// The toolbox is a terminal, not a cluster node — it rides along in this list because
	// that is what the frontend builds tabs from, and it is deliberately last so the node
	// tabs keep the positions the labs' `terminals` arrays describe. It is absent when the
	// image has not been built, and the player simply shows one tab fewer.
	if a.toolboxID != "" {
		nodeIDs = append(nodeIDs, toolboxLabID)
	}
	return AttemptView{
		ID:        a.id,
		LabID:     a.labID,
		Status:    a.status,
		PhaseLog:  append([]string(nil), a.phaseLog...),
		Error:     a.err,
		Nodes:     nodeIDs,
		Baseline:  a.baseline,
		CreatedAt: a.createdAt,
	}
}

func (a *Attempt) serverNodeID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, n := range a.nodes {
		if n.Role == "control-plane" {
			return n.ID
		}
	}
	return ""
}

func (a *Attempt) nodeIDByLabID(labID string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if labID == toolboxLabID {
		return a.toolboxID
	}
	for _, n := range a.nodes {
		if n.LabID == labID {
			return n.ID
		}
	}
	return ""
}

// labIDForContainerName maps a real k3d container name (e.g. k3d-dbol-a1b2c3-agent-1, as
// seen in a PVC's volume.kubernetes.io/selected-node annotation) back to the clean,
// frontend-facing node id (k3d-agent-1) a learner would actually write down.
func (a *Attempt) labIDForContainerName(containerName string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, n := range a.nodes {
		if n.ContainerName == containerName {
			return n.LabID
		}
	}
	return ""
}

// serverNodeName is the Kubernetes node name of the control-plane node — which is the k3d
// container name, and the value of its kubernetes.io/hostname label.
func (a *Attempt) serverNodeName() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, n := range a.nodes {
		if n.Role == "control-plane" {
			return n.ContainerName
		}
	}
	return ""
}

// agentNodeName is the Kubernetes node name of the first worker node. The single-instance
// drain lab pins its cluster there rather than to the control plane: draining the control
// plane would also evict CoreDNS and the local-path provisioner, which has nothing to do with
// what that lab is teaching and quite a lot to do with confusing it.
func (a *Attempt) agentNodeName() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, n := range a.nodes {
		if n.Role != "control-plane" {
			return n.ContainerName
		}
	}
	return ""
}

func (a *Attempt) clusterNameSnap() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.clusterName
}

func (a *Attempt) networkSnap() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.network
}

func (a *Attempt) seaweedIDSnap() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.seaweedID
}

/* ------------------------------------------------------------------ store */

type AttemptStore struct {
	mu       sync.Mutex
	attempts map[string]*Attempt
	docker   *Docker
	k3d      *K3D
	cnpg     *CNPG
	seaweed  *SeaweedFS
	toolbox  *Toolbox

	// Only one environment is ever built at a time. Provisioning is by far the most
	// CPU-hungry thing this backend does — three k3s nodes racing to register, then three
	// Postgres instances pulling and starting — and two of them at once on a laptop simply
	// starve each other: k3d gives up waiting for an agent to report `successfully
	// registered node`, both clusters fail, and the failures look like bugs rather than
	// contention. Idle *ready* clusters cost little, so the cap on live environments stays
	// separate (maxConcurrentAttempts) from this serialization of the expensive phase.
	provisionSem chan struct{}
}

func NewAttemptStore(docker *Docker, k3d *K3D, cnpg *CNPG, seaweed *SeaweedFS, toolbox *Toolbox) *AttemptStore {
	return &AttemptStore{
		attempts:     map[string]*Attempt{},
		docker:       docker,
		k3d:          k3d,
		cnpg:         cnpg,
		seaweed:      seaweed,
		toolbox:      toolbox,
		provisionSem: make(chan struct{}, 1),
	}
}

func newAttemptID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *AttemptStore) activeCount() int {
	n := 0
	for _, a := range s.attempts {
		st := a.view().Status
		if st == "provisioning" || st == "ready" {
			n++
		}
	}
	return n
}

// liveForLab returns the still-live attempt for labID, if any. Caller must hold s.mu.
func (s *AttemptStore) liveForLab(labID string) *Attempt {
	for _, a := range s.attempts {
		v := a.view()
		if v.LabID == labID && (v.Status == "provisioning" || v.Status == "ready") {
			return a
		}
	}
	return nil
}

// Create provisions a real environment for labID — or hands back the one that is already
// live for that lab.
//
// Idempotent per lab, deliberately. Provisioning here is a real, minutes-long, CPU-heavy
// operation (a 3-node k3d cluster, MetalLB, SeaweedFS, the CNPG operator), and a browser
// can legitimately ask for the same lab twice in quick succession: React StrictMode's
// dev-only double-invoke, an HMR remount, a second tab, or a retry after a transient
// error. Creating a *second* real cluster in those cases was actively harmful — the two
// clusters starved each other of CPU until k3d gave up waiting for agents to register
// ("failed to get ready: error waiting for log line `successfully registered node`"),
// which surfaced as an error, which triggered another retry, which created another
// cluster. The backend owns this decision because it is the only party that knows what is
// actually running; no amount of frontend guarding can make a non-idempotent create safe.
func (s *AttemptStore) Create(labID string) (*Attempt, error) {
	if !validLabs[labID] {
		return nil, fmt.Errorf("unknown lab %q", labID)
	}
	s.mu.Lock()
	if a := s.liveForLab(labID); a != nil {
		s.mu.Unlock()
		return a, nil
	}
	if s.activeCount() >= maxConcurrentAttempts {
		s.mu.Unlock()
		return nil, fmt.Errorf("at capacity: %d live lab environments already running on this machine — destroy one first", maxConcurrentAttempts)
	}
	id := newAttemptID()
	attempt := &Attempt{
		id:          id,
		labID:       labID,
		status:      "provisioning",
		clusterName: clusterName(id),
		network:     networkName(id),
		createdAt:   time.Now(),
		finished:    make(chan struct{}),
	}
	s.attempts[id] = attempt
	s.mu.Unlock()

	go s.provision(attempt)
	return attempt, nil
}

// ReapOrphans removes every dbol-* cluster (and its network and SeaweedFS container) left
// behind by a previous run of this process.
//
// The attempt registry lives only in memory, so a restart — a crash, a rebuild during
// development, an Ctrl-C at the wrong moment — permanently forgets whatever it had
// provisioned. The clusters themselves keep running: real containers, real CPU, and a /16
// out of Docker's default pool each, with nothing left that can ever reach or release them.
// Since a restarted process starts with an empty registry, *any* dbol-* cluster found at
// startup is by definition unreachable, and the safe thing is to reclaim it. Called before
// the server begins listening so no attempt can race it.
func (s *AttemptStore) ReapOrphans(ctx context.Context) {
	out, err := s.k3d.runK3D(ctx, "cluster", "list", "--no-headers")
	if err != nil {
		log.Printf("orphan sweep: could not list clusters: %v", err)
		return
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !strings.HasPrefix(fields[0], clusterPrefix) {
			continue
		}
		name := fields[0]
		id := strings.TrimPrefix(name, clusterPrefix)
		log.Printf("orphan sweep: reclaiming %s (left by a previous run)", name)
		if err := s.k3d.DestroyCluster(ctx, name); err != nil {
			log.Printf("orphan sweep: delete %s: %v", name, err)
		}
		if cid, err := s.docker.ContainerByName(ctx, "seaweedfs-"+id); err == nil && cid != "" {
			if err := s.seaweed.Destroy(ctx, cid); err != nil {
				log.Printf("orphan sweep: seaweedfs-%s: %v", id, err)
			}
		}
		// Found by name, since the registry that held its container ID is gone. Like
		// SeaweedFS, it is attached to the attempt's network and would block the removal
		// below if it were left behind.
		if cid, err := s.docker.ContainerByName(ctx, "toolbox-"+id); err == nil && cid != "" {
			if err := s.toolbox.Destroy(ctx, cid); err != nil {
				log.Printf("orphan sweep: toolbox-%s: %v", id, err)
			}
		}
		if err := s.docker.NetworkRemove(ctx, networkName(id)); err != nil {
			log.Printf("orphan sweep: network for %s: %v", id, err)
		}
	}
}

func (s *AttemptStore) Get(id string) (*Attempt, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.attempts[id]
	return a, ok
}

// teardownFailed releases the real Docker resources a half-finished provision left behind.
//
// Without this, every failed attempt leaked its Docker network forever, and each network
// permanently reserves a /16 out of the daemon's default address pool (172.16–172.31 — only
// 16 of them exist). A run of failures therefore exhausted the pool and made *all* further
// cluster creation impossible, on top of the disk and memory the half-built cluster held.
// k3d already rolls its own cluster back on a failed create; this cleans up everything else
// and is safe to call when those resources were never created.
func (s *AttemptStore) teardownFailed(a *Attempt) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	if sw := a.seaweedIDSnap(); sw != "" {
		if err := s.seaweed.Destroy(ctx, sw); err != nil {
			log.Printf("[%s] cleanup seaweedfs: %v", a.id, err)
		}
	}
	if tb := a.toolboxIDSnap(); tb != "" {
		if err := s.toolbox.Destroy(ctx, tb); err != nil {
			log.Printf("[%s] cleanup toolbox: %v", a.id, err)
		}
	}
	if err := s.k3d.DestroyCluster(ctx, a.clusterNameSnap()); err != nil {
		log.Printf("[%s] cleanup k3d cluster: %v", a.id, err)
	}
	if err := s.docker.NetworkRemove(ctx, a.networkSnap()); err != nil {
		log.Printf("[%s] cleanup network: %v", a.id, err)
	}
}

func (s *AttemptStore) provision(a *Attempt) {
	defer close(a.finished)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	a.setCancel(cancel)

	// Wait for the one provisioning slot before starting any real work. The learner is told
	// they are queued rather than left watching a progress bar that has not moved — and an
	// abort while queued takes effect immediately, without building anything first.
	select {
	case s.provisionSem <- struct{}{}:
	case <-ctx.Done():
		a.setStatus("destroyed")
		return
	default:
		a.log("waiting for another lab environment to finish building — only one is built at a time")
		select {
		case s.provisionSem <- struct{}{}:
		case <-ctx.Done():
			a.setStatus("destroyed")
			return
		}
	}
	defer func() { <-s.provisionSem }()

	// Any path out of this function that left status "provisioning" would strand the
	// attempt forever (it counts as live, so it also blocks the concurrency slot).
	// An aborted attempt is Destroy's to clean up, not this goroutine's.
	defer func() {
		if a.view().Status == "error" && ctx.Err() == nil {
			s.teardownFailed(a)
		}
	}()

	network := a.networkSnap()
	cluster := a.clusterNameSnap()

	if err := s.docker.NetworkEnsure(ctx, network); err != nil {
		a.setError(fmt.Errorf("network: %w", err))
		return
	}
	if err := s.k3d.CreateCluster(ctx, cluster, network, a.log); err != nil {
		a.setError(fmt.Errorf("k3d cluster: %w", err))
		return
	}
	// Before anything schedules a pod: get the images into the nodes locally, so CNPG's
	// instance-by-instance bootstrap is not gated on three separate registry downloads.
	s.k3d.PreseedImages(ctx, cluster, cnpgImages, a.log)

	nodes, err := s.k3d.DiscoverNodes(ctx, cluster)
	if err != nil {
		a.setError(fmt.Errorf("discover nodes: %w", err))
		return
	}
	a.setNodes(nodes)

	// The rancher/k3s node image ships no /root at all (root's real home is "/") — make
	// it a real, writable directory everywhere before anything stages a file into it.
	for _, n := range nodes {
		// Must use workdir "/", not ExecRoot's "/root" — /root doesn't exist yet, and a
		// nonexistent WorkingDir makes the container runtime refuse to even start the
		// exec (a chicken-and-egg failure, not something a non-zero exit code reports).
		res, err := s.docker.Exec(ctx, n.ID, []string{"mkdir", "-p", "/root"}, nil, "/")
		if err != nil {
			a.setError(fmt.Errorf("mkdir /root on %s: %w", n.LabID, err))
			return
		}
		if res.ExitCode != 0 {
			a.setError(fmt.Errorf("mkdir /root on %s: exit %d: %s", n.LabID, res.ExitCode, res.Stderr))
			return
		}
	}

	a.log("propagating kubeconfig to all 3 nodes")
	if err := s.k3d.PropagateKubeconfig(ctx, nodes); err != nil {
		a.setError(fmt.Errorf("propagate kubeconfig: %w", err))
		return
	}

	serverID := a.serverNodeID()

	if err := s.k3d.InstallMetalLB(ctx, serverID, network, a.log); err != nil {
		a.setError(fmt.Errorf("metallb: %w", err))
		return
	}

	seaweedID, err := s.seaweed.Deploy(ctx, "seaweedfs-"+a.id, network, "seaweedfs", "seaweedfs_password", "cnpg-backups", a.log)
	if err != nil {
		a.setError(fmt.Errorf("seaweedfs: %w", err))
		return
	}
	a.setSeaweedID(seaweedID)

	// The tooling tab. Best-effort on purpose: every lab's content works from the node tabs
	// alone, so a missing image or an unroutable network costs a convenience, not the
	// environment. See toolbox.go.
	toolboxID, err := s.toolbox.Deploy(ctx, "toolbox-"+a.id, network, serverID, nodes, a.log)
	if err != nil {
		log.Printf("[%s] toolbox: %v", a.id, err)
	}
	a.setToolboxID(toolboxID)

	manifestPath, err := s.cnpg.StageOperator(ctx, serverID, a.log)
	if err != nil {
		a.setError(fmt.Errorf("stage cnpg operator: %w", err))
		return
	}

	for _, step := range s.recipe(ctx, a, serverID, manifestPath) {
		if err := step.run(); err != nil {
			a.setError(fmt.Errorf("%s: %w", step.name, err))
			return
		}
	}

	a.log("ready")
	a.setStatus("ready")
}

// provisionStep is one named piece of a lab's precondition, run for real server-side.
type provisionStep struct {
	name string
	run  func() error
}

// recipe is the per-lab provisioning recipe: what this lab needs to already exist, built by
// really running the commands rather than faking a starting state.
//
// The rule every entry here follows: whatever the lab actually *teaches* is left undone.
// The operator install lab gets the manifest staged but never applied; the cluster-creation
// lab gets the operator but only a staged Cluster manifest; the PgBouncer lab gets a
// healthy cluster but only a staged Pooler; the certificates lab gets the plugin and a
// client Pod manifest that mounts a Secret the learner has yet to issue.
//
// Anything added or removed here is visible to learners twice over — the `environment`
// block in src/labs/<id>.js has to describe it, and PROVISION_STEPS in LabPlayer.jsx counts
// the a.log() lines these steps emit. Both change in the same commit as this does.
func (s *AttemptStore) recipe(ctx context.Context, a *Attempt, serverID, manifestPath string) []provisionStep {
	const cluster = "pg-cluster"

	installOperator := provisionStep{"install operator", func() error {
		return s.cnpg.InstallOperator(ctx, serverID, manifestPath, a.log)
	}}
	stageCluster := provisionStep{"stage cluster manifest", func() error {
		return s.cnpg.StageClusterManifest(ctx, serverID, cluster, 3, "1Gi")
	}}
	applyCluster := provisionStep{"apply cluster", func() error {
		return s.cnpg.ApplyCluster(ctx, serverID, cluster, 3, "1Gi", a.log)
	}}
	psqlClient := provisionStep{"start psql client", func() error {
		return s.cnpg.ApplyPSQLClient(ctx, serverID, cluster, a.log)
	}}
	declareManagedRole := provisionStep{"declare a managed role", func() error {
		return s.cnpg.DeclareManagedRole(ctx, serverID, cluster, "analyst", "analyst-password", "analyst_pw", a.log)
	}}
	// The tablespaces the object-store and snapshot backup labs recover: declared server-side,
	// because those labs are about backing them up rather than about creating them.
	backupTablespaces := []tablespaceSpec{{Name: "reporting", Size: "1Gi", Owner: "app"}}
	declareBackupTablespaces := provisionStep{"declare a tablespace", func() error {
		return s.cnpg.DeclareTablespaces(ctx, serverID, cluster, backupTablespaces, a.log)
	}}
	seedTablespaceTable := provisionStep{"seed a table inside the tablespace", func() error {
		return s.cnpg.SeedTablespaceTable(ctx, serverID, cluster, "quarterly", "reporting", 500, a.log)
	}}
	stageTablespaceRestores := provisionStep{"stage the recovery manifests", func() error {
		return s.cnpg.StageTablespaceRestoreManifests(ctx, serverID, cluster, backupTablespaces, a.log)
	}}
	applySnapshotClusterTablespaces := provisionStep{"apply a cluster with a tablespace", func() error {
		return s.cnpg.ApplySnapshotClusterTablespaces(ctx, serverID, cluster, a.serverNodeName(), backupTablespaces, a.log)
	}}
	stageTablespaceSnapshots := provisionStep{"stage the snapshot backup and recovery manifests", func() error {
		return s.cnpg.StageTablespaceSnapshotManifests(ctx, serverID, cluster, a.serverNodeName(), backupTablespaces, a.log)
	}}
	stageRetainDatabases := provisionStep{"stage the Database manifests", func() error {
		return s.cnpg.StageDatabaseManifests(ctx, serverID, cluster, "retain", a.log)
	}}
	stageReclaimDatabases := provisionStep{"stage the Database manifests", func() error {
		return s.cnpg.StageDatabaseManifests(ctx, serverID, cluster, "reclaim", a.log)
	}}
	stagePooler := provisionStep{"stage pooler manifest", func() error {
		return s.cnpg.StagePoolerManifest(ctx, serverID, cluster, 2)
	}}
	stageCertClient := provisionStep{"stage cert client manifest", func() error {
		return s.cnpg.StageCertClientManifest(ctx, serverID, cluster, certClientSecret)
	}}
	installPlugin := provisionStep{"install cnpg plugin", func() error {
		a.mu.Lock()
		nodes := append([]NodeInfo(nil), a.nodes...)
		a.mu.Unlock()
		return s.cnpg.InstallPlugin(ctx, nodes, a.log)
	}}
	// Captured once, right after the cluster reports healthy: which instance is primary,
	// the volume behind it and the node that volume is pinned to. Every lab that breaks or
	// moves the primary grades against these, so "it changed" is a real comparison rather
	// than something the frontend was told.
	// The object-store backup stack: cert-manager (the plugin's certificates need it), the
	// Barman Cloud plugin itself, and a stable in-cluster name for the attempt's SeaweedFS
	// container. Pre-seeded first for the same reason the Postgres image is.
	preseedBackupStack := provisionStep{"pre-seed backup images", func() error {
		s.k3d.PreseedImages(ctx, a.clusterNameSnap(), backupStackImages, a.log)
		return nil
	}}
	installCertManager := provisionStep{"install cert-manager", func() error {
		return s.cnpg.InstallCertManager(ctx, serverID, a.log)
	}}
	installBarmanPlugin := provisionStep{"install barman plugin", func() error {
		return s.cnpg.InstallBarmanPlugin(ctx, serverID, a.log)
	}}
	exposeSeaweed := provisionStep{"publish seaweedfs", func() error {
		ip, err := s.docker.ContainerIP(ctx, a.seaweedIDSnap(), a.networkSnap())
		if err != nil {
			return err
		}
		return s.cnpg.ExposeSeaweedFS(ctx, serverID, ip, a.log)
	}}
	stageBackupManifests := provisionStep{"stage backup manifests", func() error {
		return s.cnpg.StageBackupManifests(ctx, serverID, cluster)
	}}

	// The snapshot stack must be installed BEFORE the operator: CloudNativePG decides at
	// startup whether it supports volume-snapshot backups by looking for the VolumeSnapshot
	// CRD, and refuses the method outright if the CRD showed up afterwards.
	preseedSnapshotStack := provisionStep{"pre-seed CSI images", func() error {
		s.k3d.PreseedImages(ctx, a.clusterNameSnap(), csiSnapshotImages, a.log)
		return nil
	}}
	installSnapshotStack := provisionStep{"install snapshot stack", func() error {
		return s.cnpg.InstallSnapshotStack(ctx, serverID, a.serverNodeName(), a.log)
	}}
	applySnapshotCluster := provisionStep{"apply cluster", func() error {
		return s.cnpg.ApplySnapshotCluster(ctx, serverID, cluster, a.serverNodeName(), a.log)
	}}
	stageSnapshotManifests := provisionStep{"stage snapshot manifests", func() error {
		return s.cnpg.StageSnapshotManifests(ctx, serverID, cluster, a.serverNodeName())
	}}

	// The restore labs need a working archive and a real backup already in the bucket: their
	// subject is recovering, not configuring.
	configureBackup := provisionStep{"configure wal archiving", func() error {
		return s.cnpg.ConfigureBarmanBackup(ctx, serverID, cluster, a.log)
	}}
	takeBaseBackup := provisionStep{"take base backup", func() error {
		return s.cnpg.TakeBackup(ctx, serverID, cluster, "base-backup", a.log)
	}}
	stageRestore := provisionStep{"stage restore manifest", func() error {
		return s.cnpg.StageRestoreManifest(ctx, serverID, cluster, "pg-restored")
	}}
	generateWAL := provisionStep{"generate wal", func() error {
		return s.cnpg.GenerateWAL(ctx, serverID, cluster, a.log)
	}}
	stageWALRestore := provisionStep{"stage wal restore manifests", func() error {
		return s.cnpg.StageWALRestoreManifests(ctx, serverID, cluster)
	}}
	stagePITR := provisionStep{"stage pitr template", func() error {
		return s.cnpg.StagePITRTemplate(ctx, serverID, cluster, "pg-pitr")
	}}

	// The upgrade lab is the one recipe that does not start on the pinned operator: it
	// installs the previous minor release so the upgrade the learner performs is real. The
	// 1.30.0 manifest they upgrade to is already staged, as it is for every attempt.
	preseedPreviousOperator := provisionStep{"pre-seed previous operator image", func() error {
		s.k3d.PreseedImages(ctx, a.clusterNameSnap(), []string{cnpgPreviousImage}, a.log)
		return nil
	}}
	installPreviousOperator := provisionStep{"install previous operator", func() error {
		return s.cnpg.InstallOperatorVersion(ctx, serverID, cnpgPreviousVersion, a.log)
	}}

	preseedPreviousPostgres := provisionStep{"pre-seed the previous PostgreSQL image", func() error {
		s.k3d.PreseedImages(ctx, a.clusterNameSnap(), []string{cnpgPreviousPostgresImage}, a.log)
		return nil
	}}
	applyClusterPreviousImage := provisionStep{"apply cluster", func() error {
		return s.cnpg.ApplyClusterImage(ctx, serverID, cluster, 3, "1Gi", cnpgPreviousPostgresImage, a.log)
	}}
	// The major-upgrade lab: both majors pre-seeded (pg_upgrade needs the old binaries as well
	// as the new ones), and a cluster started on the older one.
	preseedBothMajors := provisionStep{"pre-seed both PostgreSQL majors", func() error {
		s.k3d.PreseedImages(ctx, a.clusterNameSnap(), []string{cnpgMajorPreviousPostgresImage}, a.log)
		return nil
	}}
	applyClusterMajorPrevious := provisionStep{"apply cluster on the older major", func() error {
		return s.cnpg.ApplyClusterImage(ctx, serverID, cluster, 3, "1Gi", cnpgMajorPreviousPostgresImage, a.log)
	}}
	stageInitdb := provisionStep{"stage the initdb cluster manifest", func() error {
		return s.cnpg.StageInitdbManifest(ctx, serverID, "pg-init", a.log)
	}}
	stageImageCatalog := provisionStep{"stage the image catalog manifest", func() error {
		return s.cnpg.StageImageCatalogManifest(ctx, serverID, a.log)
	}}
	stageReplicaFromBackup := provisionStep{"stage replica-from-backup manifest", func() error {
		return s.cnpg.StageReplicaFromBackupManifest(ctx, serverID, cluster, "pg-replica", a.log)
	}}
	stageSnapshotReplica := provisionStep{"stage snapshot and replica manifests", func() error {
		return s.cnpg.StageSnapshotReplicaManifests(ctx, serverID, cluster, "pg-replica", a.serverNodeName(), a.log)
	}}
	stageStreamingReplica := provisionStep{"stage replica cluster manifest", func() error {
		return s.cnpg.StageStreamingReplicaManifest(ctx, serverID, cluster, "pg-replica", a.log)
	}}
	applyTargetCluster := provisionStep{"apply target cluster", func() error {
		return s.cnpg.ApplyTargetCluster(ctx, serverID, cluster, "pg-target", a.log)
	}}
	stageLogicalManifests := provisionStep{"stage logical replication manifests", func() error {
		return s.cnpg.StageLogicalManifests(ctx, serverID, cluster, "pg-target", a.log)
	}}
	// The corruption lab damages one page of a real table, so it needs a real table with
	// enough rows to make the loss legible — and it has to be read once and checkpointed while
	// the environment is built, for the hint-bit reason SeedAppTable explains.
	seedLedger := provisionStep{"seed the ledger table", func() error {
		return s.cnpg.SeedAppTable(ctx, serverID, cluster, "ledger", 2000, a.log)
	}}
	seedNotes := provisionStep{"seed the notes table", func() error {
		return s.cnpg.SeedAppTable(ctx, serverID, cluster, "notes", 50, a.log)
	}}
	seedSourceServer := provisionStep{"seed the source server", func() error {
		return s.cnpg.SeedSourceServer(ctx, serverID, cluster, a.log)
	}}
	stageClone := provisionStep{"stage the clone manifest", func() error {
		return s.cnpg.StageCloneManifest(ctx, serverID, cluster, "pg-clone", a.log)
	}}
	stageMicroserviceImport := provisionStep{"stage the import manifest", func() error {
		return s.cnpg.StageImportManifest(ctx, serverID, cluster, "pg-orders", "microservice", a.log)
	}}
	stageMonolithImport := provisionStep{"stage the import manifest", func() error {
		return s.cnpg.StageImportManifest(ctx, serverID, cluster, "pg-estate", "monolith", a.log)
	}}
	// The single-instance drain lab needs its one instance on a worker node, so the drain it
	// performs is a drain of an ordinary node.
	applyPinnedSingle := provisionStep{"apply a single-instance cluster", func() error {
		return s.cnpg.ApplyClusterOnNode(ctx, serverID, cluster, 1, "1Gi", a.agentNodeName(), a.log)
	}}
	stageSnapshotModes := provisionStep{"stage the hot and cold backup manifests", func() error {
		return s.cnpg.StageSnapshotModeManifests(ctx, serverID, cluster, a.serverNodeName(), a.log)
	}}
	// The snapshot-PITR lab needs a WAL archive as well as a snapshot-capable driver: a
	// snapshot restores you to the instant it was taken, and everything after that comes out of
	// the object store. Single-instance, because the CSI driver lives on one node.
	configureBackupSingle := provisionStep{"configure wal archiving", func() error {
		return s.cnpg.ConfigureBarmanBackupInstances(ctx, serverID, cluster, 1, a.log)
	}}
	stagePITRSnapshots := provisionStep{"stage the snapshot PITR manifests", func() error {
		return s.cnpg.StagePITRSnapshotManifests(ctx, serverID, cluster, a.serverNodeName(), a.log)
	}}
	stageScheduledSnapshots := provisionStep{"stage the scheduled backup manifests", func() error {
		return s.cnpg.StageScheduledSnapshotManifests(ctx, serverID, cluster, a.log)
	}}
	captureBaseline := provisionStep{"capture baseline", func() error {
		primary, volume, node, err := s.cnpg.Baseline(ctx, serverID, cluster)
		if err != nil {
			return err
		}
		a.setBaseline(&Baseline{Primary: primary, Volume: volume, Node: node})
		return nil
	}}

	switch a.labID {
	case "cnpg-operator-install":
		// Nothing: the release manifest is staged, and applying it is the whole lab.
		return nil
	case "cnpg-cluster-creation":
		return []provisionStep{installOperator, stageCluster}
	case "cnpg-persistent-volume":
		return []provisionStep{installOperator, applyCluster, captureBaseline}
	case "cnpg-service-connectivity":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-client-certificates":
		return []provisionStep{installOperator, applyCluster, installPlugin, stageCertClient}
	case "cnpg-server-certificates":
		// The learner works in the toolbox, which has openssl and psql. The client Pod is
		// still built so there is an in-cluster client to compare against.
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-pgbouncer":
		return []provisionStep{installOperator, applyCluster, psqlClient, stagePooler}
	case "cnpg-failover":
		return []provisionStep{installOperator, applyCluster, psqlClient, captureBaseline}
	case "cnpg-switchover":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient, captureBaseline}
	case "cnpg-failover-endpoint-time":
		return []provisionStep{installOperator, applyCluster, psqlClient, captureBaseline}
	case "cnpg-switchover-endpoint-time":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient, captureBaseline}
	case "cnpg-degraded-recovery":
		return []provisionStep{installOperator, applyCluster, psqlClient, captureBaseline}
	case "cnpg-pvc-deletion":
		return []provisionStep{installOperator, applyCluster, psqlClient, captureBaseline}
	case "cnpg-barman-backup":
		// Everything the plugin needs is installed, and the object store is reachable and
		// empty. Describing the bucket to CloudNativePG, and taking a backup, is the lab.
		return []provisionStep{
			installOperator, preseedBackupStack, installCertManager, installBarmanPlugin,
			applyCluster, exposeSeaweed, installPlugin, psqlClient, stageBackupManifests,
		}
	case "cnpg-volume-snapshots":
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			applySnapshotCluster, psqlClient, stageSnapshotManifests,
		}
	case "cnpg-barman-restore":
		return []provisionStep{
			installOperator, preseedBackupStack, installCertManager, installBarmanPlugin,
			applyCluster, exposeSeaweed, installPlugin, psqlClient,
			configureBackup, takeBaseBackup, stageRestore,
		}
	case "cnpg-pitr":
		return []provisionStep{
			installOperator, preseedBackupStack, installCertManager, installBarmanPlugin,
			applyCluster, exposeSeaweed, installPlugin, psqlClient,
			configureBackup, takeBaseBackup, stagePITR,
		}
	case "cnpg-wal-restore":
		return []provisionStep{
			installOperator, preseedBackupStack, installCertManager, installBarmanPlugin,
			applyCluster, exposeSeaweed, installPlugin, psqlClient,
			configureBackup, takeBaseBackup, generateWAL, stageWALRestore,
		}
	case "cnpg-operator-eviction":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-operator-upgrade":
		return []provisionStep{preseedPreviousOperator, installPreviousOperator, applyCluster, psqlClient}
	case "cnpg-operator-ha":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-metrics":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-pgbouncer-metrics":
		return []provisionStep{installOperator, applyCluster, psqlClient, stagePooler}
	case "cnpg-json-logs":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-replication-slots":
		// HA slots are on by default in 1.30, so the slots already exist — the lab is about
		// reading them and proving what they hold. The plugin comes along for `cnpg fencing`,
		// which is how a standby is held down long enough for a slot to visibly retain WAL.
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-synchronous-replication":
		// Ships async (synchronous_standby_names is empty); configuring it is the lab. The
		// plugin is for `cnpg fencing`, which is what takes a standby away to show the cost.
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-cluster-scaling":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-fencing":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-hibernation":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-config-changes":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-rolling-update":
		// Deliberately one minor release behind, so the learner performs a real image change.
		return []provisionStep{
			preseedPreviousPostgres, installOperator, applyClusterPreviousImage, installPlugin, psqlClient,
		}
	case "cnpg-initdb":
		// No cluster at all: bootstrapping one, with initdb options that can never be
		// changed afterwards, is the whole lab.
		return []provisionStep{installOperator, stageInitdb}
	case "cnpg-taints-tolerations":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-node-selector":
		// One instance per node, placed by the anti-affinity the operator defaults in — which
		// is exactly what the lab reads before changing it. Nothing is staged: every field it
		// touches is a patch on the running Cluster.
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-podspec-drift":
		// The baseline records which instance is primary, so the grader can prove the rollout
		// the learner triggers replaced every Pod *without* moving the primary.
		return []provisionStep{installOperator, applyCluster, psqlClient, captureBaseline}
	case "cnpg-multi-arch":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-inherited-metadata":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-object-metadata":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-data-corruption":
		// The plugin is the lab's toolkit: fencing to stop PostgreSQL without losing the Pod,
		// promote to move the writes off the damaged instance, destroy to throw its disk away.
		// The baseline records which instance is primary and which volume it is on, so the
		// grader can prove the damaged copy was replaced rather than repaired.
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient, seedLedger, captureBaseline}
	case "cnpg-basebackup-clone":
		return []provisionStep{installOperator, applyCluster, psqlClient, seedNotes, stageClone}
	case "cnpg-import-microservice":
		return []provisionStep{installOperator, applyCluster, psqlClient, seedSourceServer, stageMicroserviceImport}
	case "cnpg-import-monolith":
		return []provisionStep{installOperator, applyCluster, psqlClient, seedSourceServer, stageMonolithImport}
	case "cnpg-storage-expansion":
		// The snapshot-capable CSI driver is here for a different property of it: unlike k3s's
		// own local-path, its StorageClass allows volume expansion. Both classes exist, which
		// is what makes the comparison in the first objective real.
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			applySnapshotCluster, psqlClient, seedNotes, captureBaseline,
		}
	case "cnpg-wal-volume":
		return []provisionStep{installOperator, applyCluster, psqlClient, seedNotes}
	case "cnpg-node-drain":
		return []provisionStep{installOperator, applyCluster, psqlClient, captureBaseline}
	case "cnpg-single-instance-drain":
		return []provisionStep{installOperator, applyPinnedSingle, psqlClient}
	case "cnpg-declarative-hibernation":
		return []provisionStep{installOperator, applyCluster, psqlClient, seedNotes}
	case "cnpg-snapshot-modes":
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			applySnapshotCluster, psqlClient, seedNotes, stageSnapshotModes,
		}
	case "cnpg-snapshot-pitr":
		// Both stacks: the CSI driver for the snapshots and the Barman Cloud plugin for the WAL
		// archive the recovery replays out of.
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			preseedBackupStack, installCertManager, installBarmanPlugin,
			applySnapshotCluster, exposeSeaweed, psqlClient, seedNotes,
			configureBackupSingle, stagePITRSnapshots,
		}
	case "cnpg-plugin-snapshot-backup":
		// The cnpg plugin is the subject, so nothing is staged: every object this lab creates is
		// created by a plugin command.
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			applySnapshotCluster, installPlugin, psqlClient, seedNotes,
		}
	case "cnpg-scheduled-snapshots":
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			applySnapshotCluster, psqlClient, seedNotes, stageScheduledSnapshots,
		}
	case "cnpg-managed-roles":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-major-upgrade":
		// Starts a whole major version behind, so changing the image is a pg_upgrade rather than
		// a rolling restart. Seeded, because what a major upgrade has to carry across is data.
		return []provisionStep{
			preseedBothMajors, installOperator, applyClusterMajorPrevious, psqlClient, seedNotes,
		}
	case "cnpg-tablespaces":
		// A plain cluster: declaring the tablespaces is the lab.
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-temporary-tablespaces":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-tablespace-backup":
		// Tablespaces first, then WAL archiving: both roll the cluster, and the backup has to be
		// taken from a cluster whose tablespaces already exist.
		return []provisionStep{
			preseedBackupStack, installOperator, installCertManager, installBarmanPlugin,
			applyCluster, exposeSeaweed, psqlClient, declareBackupTablespaces, seedTablespaceTable,
			configureBackup, stageTablespaceRestores,
		}
	case "cnpg-tablespace-snapshot":
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			applySnapshotClusterTablespaces, psqlClient, seedTablespaceTable, stageTablespaceSnapshots,
		}
	case "cnpg-declarative-databases":
		return []provisionStep{installOperator, applyCluster, psqlClient, stageRetainDatabases}
	case "cnpg-database-reclaim":
		return []provisionStep{installOperator, applyCluster, psqlClient, stageReclaimDatabases}
	case "cnpg-role-passwords":
		// The role and its Secret are the *precondition* here — what this lab teaches is what
		// happens to that password afterwards, so the environment arrives with both in place.
		return []provisionStep{installOperator, applyCluster, psqlClient, declareManagedRole}
	case "cnpg-in-place-upgrade":
		// Starts on the previous minor release, like the operator-upgrade recipe: an in-place
		// instance-manager update can only be watched across a real operator version change.
		return []provisionStep{preseedPreviousOperator, installPreviousOperator, applyCluster, psqlClient}
	case "cnpg-image-catalog":
		// Starts a minor release behind, like the rolling-update lab, so moving the catalog
		// forward is a real image change.
		return []provisionStep{
			preseedPreviousPostgres, installOperator, applyClusterPreviousImage, installPlugin,
			psqlClient, stageImageCatalog,
		}
	case "cnpg-hot-standby-params":
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient}
	case "cnpg-replica-from-backup":
		// The whole backup stack, a real base backup in the object store, and a replica
		// cluster manifest that recovers from it — staged, never applied.
		return []provisionStep{
			installOperator, preseedBackupStack, installCertManager, installBarmanPlugin,
			applyCluster, exposeSeaweed, installPlugin, psqlClient,
			configureBackup, takeBaseBackup, stageReplicaFromBackup,
		}
	case "cnpg-replica-from-snapshot":
		return []provisionStep{
			preseedSnapshotStack, installSnapshotStack, installOperator,
			applySnapshotCluster, installPlugin, psqlClient, stageSnapshotReplica,
		}
	case "cnpg-replica-cluster":
		// The source cluster is real and healthy; the replica cluster's manifest is written
		// but never applied, because standing it up is the lab.
		return []provisionStep{installOperator, applyCluster, psqlClient, stageStreamingReplica}
	case "cnpg-logical-replication":
		// Both clusters are built for real — logical replication needs somewhere to
		// subscribe from and somewhere to subscribe to. The Publication and Subscription
		// are staged only.
		return []provisionStep{
			installOperator, applyCluster, psqlClient, applyTargetCluster, stageLogicalManifests,
		}
	case "cnpg-operator-deployment":
		return []provisionStep{installOperator, applyCluster}
	case "cnpg-operator-configmap":
		return []provisionStep{installOperator, applyCluster}
	case "cnpg-operator-pod-deletion":
		return []provisionStep{installOperator, applyCluster, psqlClient}
	case "cnpg-corrupted-pvc":
		// The plugin comes along for `kubectl cnpg fencing`: stopping PostgreSQL without
		// destroying the Pod is what makes corrupting its files on the node reproducible —
		// a clean shutdown would otherwise rewrite the control file over the damage.
		return []provisionStep{installOperator, applyCluster, installPlugin, psqlClient, captureBaseline}
	}
	return nil
}

func (s *AttemptStore) Destroy(id string) error {
	s.mu.Lock()
	a, ok := s.attempts[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("attempt %q not found", id)
	}

	// Abort a provision in flight and let it unwind before removing anything, so the
	// provisioner cannot recreate resources behind the teardown. The wait is bounded: k3d
	// can sit inside a single long call, and a learner who asked to abort should not be held
	// on the request — worst case the teardown below removes whatever it finds by name.
	if a.abort() {
		select {
		case <-a.finished:
		case <-time.After(30 * time.Second):
			log.Printf("[%s] provisioner did not stop within 30s — tearing down anyway", id)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if sw := a.seaweedIDSnap(); sw != "" {
		if err := s.seaweed.Destroy(ctx, sw); err != nil {
			log.Printf("[%s] destroy seaweedfs: %v", id, err)
		}
	}
	if tb := a.toolboxIDSnap(); tb != "" {
		if err := s.toolbox.Destroy(ctx, tb); err != nil {
			log.Printf("[%s] destroy toolbox: %v", id, err)
		}
	}
	if err := s.k3d.DestroyCluster(ctx, a.clusterNameSnap()); err != nil {
		log.Printf("[%s] destroy k3d cluster: %v", id, err)
	}
	if err := s.docker.NetworkRemove(ctx, a.networkSnap()); err != nil {
		log.Printf("[%s] remove network: %v", id, err)
	}
	a.setStatus("destroyed")
	return nil
}
