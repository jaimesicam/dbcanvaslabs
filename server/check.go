package main

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// check.go — real, on-demand grading. Each task's Check runs the same kubectl/exec
// queries a human would, against the attempt's real cluster, and returns the same
// {ok, checks:[{label, ok, detail}]} shape the frontend already renders — ported
// mechanically from the simulator's check(world) bodies (src/labs/cnpg-*.js).

type CheckItem struct {
	Label  string `json:"label"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type CheckResult struct {
	OK     bool        `json:"ok"`
	Checks []CheckItem `json:"checks"`
}

func okItem(label, detail string) CheckItem { return CheckItem{Label: label, OK: true, Detail: detail} }
func noItem(label, detail string) CheckItem {
	return CheckItem{Label: label, OK: false, Detail: detail}
}

func finish(checks []CheckItem) CheckResult {
	all := true
	for _, c := range checks {
		if !c.OK {
			all = false
			break
		}
	}
	return CheckResult{OK: all, Checks: checks}
}

/* ------------------------------------------------------------------ kubectl helpers */

func kubectlJSON(ctx context.Context, k3d *K3D, nodeID string, out any, args ...string) error {
	full := append(append([]string{}, args...), "-o", "json")
	res, err := k3d.Kubectl(ctx, nodeID, full...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl %v: exit %d: %s", args, res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return json.Unmarshal([]byte(res.Stdout), out)
}

func catFile(ctx context.Context, docker *Docker, nodeID, path string) (string, bool) {
	res, err := docker.ExecRoot(ctx, nodeID, []string{"cat", path}, nil)
	if err != nil || res.ExitCode != 0 {
		return "", false
	}
	return strings.TrimSpace(res.Stdout), true
}

// namedIn returns the longest string from ids that appears in body, or "".
func namedIn(ids []string, body string) string {
	best := ""
	for _, id := range ids {
		if strings.Contains(body, id) && len(id) > len(best) {
			best = id
		}
	}
	return best
}

type nodeList struct {
	Items []struct {
		Metadata struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
		Status struct {
			Conditions []struct {
				Type   string `json:"type"`
				Status string `json:"status"`
			} `json:"conditions"`
		} `json:"status"`
	} `json:"items"`
}

func (nl nodeList) ready(name string) bool {
	for _, n := range nl.Items {
		if n.Metadata.Name != name {
			continue
		}
		for _, c := range n.Status.Conditions {
			if c.Type == "Ready" {
				return c.Status == "True"
			}
		}
	}
	return false
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
		Spec struct {
			NodeName string `json:"nodeName"`
		} `json:"spec"`
		Status struct {
			Phase             string `json:"phase"`
			PodIP             string `json:"podIP"`
			ContainerStatuses []struct {
				Ready bool   `json:"ready"`
				Image string `json:"image"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

// nameForIP maps a Pod IP — which is all a Service's endpoints ever record — back to the
// Pod name a learner reads off `kubectl get pods`.
func (p podList) nameForIP(ip string) string {
	for _, it := range p.Items {
		if it.Status.PodIP != "" && it.Status.PodIP == ip {
			return it.Metadata.Name
		}
	}
	return ""
}

func (p podList) readyCount() int {
	n := 0
	for _, it := range p.Items {
		for _, cs := range it.Status.ContainerStatuses {
			if cs.Ready {
				n++
				break
			}
		}
	}
	return n
}

type serviceList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Spec struct {
			Type     string            `json:"type"`
			Selector map[string]string `json:"selector"`
		} `json:"spec"`
	} `json:"items"`
}

// missing reports which of the named Services are not present.
func (s serviceList) missing(names ...string) []string {
	have := map[string]bool{}
	for _, it := range s.Items {
		have[it.Metadata.Name] = true
	}
	var out []string
	for _, n := range names {
		if !have[n] {
			out = append(out, n)
		}
	}
	return out
}

type pvcList struct {
	Items []struct {
		Metadata struct {
			Name        string            `json:"name"`
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
		Spec struct {
			StorageClassName string `json:"storageClassName"`
			VolumeName       string `json:"volumeName"`
		} `json:"spec"`
	} `json:"items"`
}

type cnpgCluster struct {
	Spec struct {
		PostgreSQL struct {
			PgHBA []string `json:"pg_hba"`
		} `json:"postgresql"`
	} `json:"spec"`
	Status struct {
		Phase          string `json:"phase"`
		ReadyInstances int    `json:"readyInstances"`
		Instances      int    `json:"instances"`
		CurrentPrimary string `json:"currentPrimary"`
		TargetPrimary  string `json:"targetPrimary"`
		TimelineID     int    `json:"timelineID"`
		// The two halves of a promotion, stamped by the operator itself: when it decided an
		// instance should become primary, and when that instance actually was one. Their
		// difference is a real, server-side measurement of how long a failover took —
		// nothing the learner can type, and the only honest way to grade a timing claim
		// after the fact.
		TargetPrimaryTimestamp  string `json:"targetPrimaryTimestamp"`
		CurrentPrimaryTimestamp string `json:"currentPrimaryTimestamp"`
		Conditions              []struct {
			Type   string `json:"type"`
			Status string `json:"status"`
		} `json:"conditions"`
	} `json:"status"`
}

// promotionSeconds is how long the last promotion took: decided-at → became-primary. It is
// also non-zero for the initial bootstrap (instance 1 "promoted" minutes after the operator
// targeted it), so a check that wants to prove a *failover* was fast must also prove a
// failover happened at all.
func (c cnpgCluster) promotionSeconds() (float64, bool) {
	target, err1 := time.Parse(time.RFC3339Nano, c.Status.TargetPrimaryTimestamp)
	current, err2 := time.Parse(time.RFC3339Nano, c.Status.CurrentPrimaryTimestamp)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	d := current.Sub(target).Seconds()
	if d < 0 {
		return 0, false
	}
	return d, true
}

type poolerResource struct {
	Spec struct {
		Instances *int   `json:"instances"`
		Type      string `json:"type"`
		PgBouncer struct {
			PoolMode string `json:"poolMode"`
		} `json:"pgbouncer"`
	} `json:"spec"`
	Status struct {
		Instances int `json:"instances"`
	} `json:"status"`
}

// endpointSliceList is how a Service's membership is read here: `kubectl get endpoints` is
// deprecated from Kubernetes 1.33 on and prints a warning across the output, and this
// cluster runs 1.35.
type endpointSliceList struct {
	Items []struct {
		Endpoints []struct {
			Addresses  []string `json:"addresses"`
			Conditions struct {
				Ready *bool `json:"ready"`
			} `json:"conditions"`
		} `json:"endpoints"`
	} `json:"items"`
}

// serviceEndpointIPs returns the ready Pod IPs behind a Service, sorted so two reads are
// comparable.
func serviceEndpointIPs(ctx context.Context, k3d *K3D, nodeID, service string) ([]string, error) {
	var esl endpointSliceList
	if err := kubectlJSON(ctx, k3d, nodeID, &esl, "get", "endpointslices", "-l", "kubernetes.io/service-name="+service); err != nil {
		return nil, err
	}
	var ips []string
	for _, item := range esl.Items {
		for _, e := range item.Endpoints {
			if e.Conditions.Ready != nil && !*e.Conditions.Ready {
				continue
			}
			ips = append(ips, e.Addresses...)
		}
	}
	sort.Strings(ips)
	return ips, nil
}

// secretCert pulls one PEM certificate out of a Secret and parses it, so checks can assert
// on what a certificate actually says (who it is for, who signed it) rather than on the
// fact that some Secret exists.
func secretCert(ctx context.Context, k3d *K3D, nodeID, secret, key string) (*x509.Certificate, error) {
	jsonKey := strings.ReplaceAll(key, ".", `\.`)
	res, err := k3d.Kubectl(ctx, nodeID, "get", "secret", secret, "-o", "jsonpath={.data."+jsonKey+"}")
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("reading secret %s: exit %d: %s", secret, res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(res.Stdout))
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("secret %s key %s is not PEM", secret, key)
	}
	return x509.ParseCertificate(block.Bytes)
}

// appPassword fetches the operator-generated <cluster>-app Secret's password — real
// CNPG clusters require it even for a loopback psql connection as the app user.
func appPassword(ctx context.Context, k3d *K3D, nodeID, clusterName string) (string, error) {
	res, err := k3d.Kubectl(ctx, nodeID, "get", "secret", clusterName+"-app", "-o", "jsonpath={.data.password}")
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("reading app secret: exit %d: %s", res.ExitCode, res.Stderr)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(res.Stdout))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// psqlOn runs one SQL statement against a specific pod's local Postgres and returns its
// terse (-tA) output lines.
func psqlOn(ctx context.Context, docker *Docker, nodeID, pod, password, sql string) (string, int, error) {
	// PGPASSWORD must be part of the *remote* command `kubectl exec` runs inside the pod
	// — env vars on the outer `docker exec`/kubectl client process never reach it. This
	// is the exact shape the real mined transcript used (`-- env PGPASSWORD=*** psql`).
	cmd := []string{
		"kubectl", "exec", pod, "-c", "postgres", "--",
		"env", "PGPASSWORD=" + password,
		"psql", "-h", "127.0.0.1", "-U", "app", "-d", "app", "-tAc", sql,
	}
	res, err := docker.ExecRoot(ctx, nodeID, cmd, []string{"KUBECONFIG=" + k3dKubeconfig})
	if err != nil {
		return "", -1, err
	}
	return strings.TrimSpace(res.Stdout), res.ExitCode, nil
}

// sqlResult is one psql invocation's outcome. stderr matters as much as stdout here:
// several checks are about a connection being *refused*, and the refusal is the evidence.
type sqlResult struct {
	stdout string
	stderr string
	code   int
}

func (r sqlResult) ok() bool { return r.code == 0 }

// count reads a single-value `-tA` result as a number; a failed or non-numeric result is 0.
func (r sqlResult) count() int {
	if r.code != 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(r.stdout))
	if err != nil {
		return 0
	}
	return n
}

func runSQL(ctx context.Context, docker *Docker, nodeID string, cmd []string) (sqlResult, error) {
	res, err := docker.ExecRoot(ctx, nodeID, cmd, []string{"KUBECONFIG=" + k3dKubeconfig})
	if err != nil {
		return sqlResult{}, err
	}
	return sqlResult{strings.TrimSpace(res.Stdout), strings.TrimSpace(res.Stderr), res.ExitCode}, nil
}

// psqlSuper runs one statement inside an instance Pod as the local postgres superuser —
// peer authentication over the unix socket, so no password is involved at all. Needed for
// anything the `app` user is not privileged to see: pg_stat_replication's state columns and
// pg_hba_file_rules both come back empty or refused for a plain application role.
func psqlSuper(ctx context.Context, docker *Docker, nodeID, pod, db, sql string) (sqlResult, error) {
	return runSQL(ctx, docker, nodeID, []string{
		"kubectl", "exec", pod, "-c", "postgres", "--",
		"psql", "-U", "postgres", "-d", db, "-tAc", sql,
	})
}

// psqlFromClient runs one statement from the lab's psql-client Pod against a host — the
// only way to grade a *Service* rather than an instance, since the thing being tested is
// where the Service's name resolves to. Its PGUSER/PGDATABASE/PGPASSWORD come from the Pod's
// own environment, as the manifest that provisioned it set them.
func psqlFromClient(ctx context.Context, docker *Docker, nodeID, host, sql string) (sqlResult, error) {
	return runSQL(ctx, docker, nodeID, []string{
		"kubectl", "exec", "psql-client", "--",
		"psql", "-h", host, "-tAc", sql,
	})
}

/* ------------------------------------------------------------------ dispatch */

func RunCheck(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, taskID string) (CheckResult, error) {
	server := a.serverNodeID()
	if server == "" {
		return CheckResult{}, fmt.Errorf("attempt has no server node yet")
	}
	switch a.labID {
	case "cnpg-operator-install":
		return checkOperatorInstall(ctx, k3d, docker, a, server, taskID)
	case "cnpg-cluster-creation":
		return checkClusterCreation(ctx, k3d, docker, a, server, taskID)
	case "cnpg-persistent-volume":
		return checkPersistentVolume(ctx, k3d, docker, a, server, taskID)
	case "cnpg-service-connectivity":
		return checkServiceConnectivity(ctx, k3d, docker, a, server, taskID)
	case "cnpg-client-certificates":
		return checkClientCertificates(ctx, k3d, docker, a, server, taskID)
	case "cnpg-server-certificates":
		return checkServerCertificates(ctx, k3d, docker, a, server, taskID)
	case "cnpg-pgbouncer":
		return checkPgBouncer(ctx, k3d, docker, a, server, taskID)
	case "cnpg-failover":
		return checkFailover(ctx, k3d, docker, a, server, taskID)
	case "cnpg-switchover":
		return checkSwitchover(ctx, k3d, docker, a, server, taskID)
	case "cnpg-failover-endpoint-time":
		return checkFailoverEndpointTime(ctx, k3d, docker, a, server, taskID)
	case "cnpg-switchover-endpoint-time":
		return checkSwitchoverEndpointTime(ctx, k3d, docker, a, server, taskID)
	case "cnpg-degraded-recovery":
		return checkDegradedRecovery(ctx, k3d, docker, a, server, taskID)
	case "cnpg-pvc-deletion":
		return checkPVCDeletion(ctx, k3d, docker, a, server, taskID)
	case "cnpg-corrupted-pvc":
		return checkCorruptedPVC(ctx, k3d, docker, a, server, taskID)
	case "cnpg-barman-backup":
		return checkBarmanBackup(ctx, k3d, docker, a, server, taskID)
	case "cnpg-volume-snapshots":
		return checkVolumeSnapshots(ctx, k3d, docker, a, server, taskID)
	case "cnpg-barman-restore":
		return checkBarmanRestore(ctx, k3d, docker, a, server, taskID)
	case "cnpg-pitr":
		return checkPITR(ctx, k3d, docker, a, server, taskID)
	case "cnpg-wal-restore":
		return checkWALRestore(ctx, k3d, docker, a, server, taskID)
	case "cnpg-operator-eviction":
		return checkOperatorEviction(ctx, k3d, docker, a, server, taskID)
	case "cnpg-operator-upgrade":
		return checkOperatorUpgrade(ctx, k3d, docker, a, server, taskID)
	case "cnpg-operator-ha":
		return checkOperatorHA(ctx, k3d, docker, a, server, taskID)
	case "cnpg-metrics":
		return checkMetrics(ctx, k3d, docker, a, server, taskID)
	case "cnpg-pgbouncer-metrics":
		return checkPgBouncerMetrics(ctx, k3d, docker, a, server, taskID)
	case "cnpg-json-logs":
		return checkJSONLogs(ctx, k3d, docker, a, server, taskID)
	case "cnpg-operator-deployment":
		return checkOperatorDeployment(ctx, k3d, docker, a, server, taskID)
	case "cnpg-operator-configmap":
		return checkOperatorConfigMap(ctx, k3d, docker, a, server, taskID)
	case "cnpg-operator-pod-deletion":
		return checkOperatorPodDeletion(ctx, k3d, docker, a, server, taskID)
	case "cnpg-replication-slots":
		return checkReplicationSlots(ctx, k3d, docker, a, server, taskID)
	case "cnpg-synchronous-replication":
		return checkSynchronousReplication(ctx, k3d, docker, a, server, taskID)
	case "cnpg-cluster-scaling":
		return checkClusterScaling(ctx, k3d, docker, a, server, taskID)
	case "cnpg-replica-cluster":
		return checkReplicaCluster(ctx, k3d, docker, a, server, taskID)
	case "cnpg-logical-replication":
		return checkLogicalReplication(ctx, k3d, docker, a, server, taskID)
	case "cnpg-fencing":
		return checkFencing(ctx, k3d, docker, a, server, taskID)
	case "cnpg-hibernation":
		return checkHibernation(ctx, k3d, docker, a, server, taskID)
	case "cnpg-config-changes":
		return checkConfigChanges(ctx, k3d, docker, a, server, taskID)
	case "cnpg-rolling-update":
		return checkRollingUpdate(ctx, k3d, docker, a, server, taskID)
	case "cnpg-image-catalog":
		return checkImageCatalog(ctx, k3d, docker, a, server, taskID)
	case "cnpg-hot-standby-params":
		return checkHotStandbyParams(ctx, k3d, docker, a, server, taskID)
	case "cnpg-replica-from-backup":
		return checkReplicaFromBackup(ctx, k3d, docker, a, server, taskID)
	case "cnpg-replica-from-snapshot":
		return checkReplicaFromSnapshot(ctx, k3d, docker, a, server, taskID)
	case "cnpg-initdb":
		return checkInitdb(ctx, k3d, docker, a, server, taskID)
	case "cnpg-taints-tolerations":
		return checkTaintsTolerations(ctx, k3d, docker, a, server, taskID)
	case "cnpg-node-selector":
		return checkNodeSelector(ctx, k3d, docker, a, server, taskID)
	case "cnpg-podspec-drift":
		return checkPodSpecDrift(ctx, k3d, docker, a, server, taskID)
	case "cnpg-in-place-upgrade":
		return checkInPlaceUpgrade(ctx, k3d, docker, a, server, taskID)
	case "cnpg-multi-arch":
		return checkMultiArch(ctx, k3d, docker, a, server, taskID)
	case "cnpg-inherited-metadata":
		return checkInheritedMetadata(ctx, k3d, docker, a, server, taskID)
	case "cnpg-object-metadata":
		return checkObjectMetadata(ctx, k3d, docker, a, server, taskID)
	case "cnpg-data-corruption":
		return checkDataCorruption(ctx, k3d, docker, a, server, taskID)
	case "cnpg-basebackup-clone":
		return checkBasebackupClone(ctx, k3d, docker, a, server, taskID)
	case "cnpg-import-microservice":
		return checkImportMicroservice(ctx, k3d, docker, a, server, taskID)
	case "cnpg-import-monolith":
		return checkImportMonolith(ctx, k3d, docker, a, server, taskID)
	case "cnpg-storage-expansion":
		return checkStorageExpansion(ctx, k3d, docker, a, server, taskID)
	case "cnpg-wal-volume":
		return checkWALVolume(ctx, k3d, docker, a, server, taskID)
	case "cnpg-node-drain":
		return checkNodeDrain(ctx, k3d, docker, a, server, taskID)
	case "cnpg-single-instance-drain":
		return checkSingleInstanceDrain(ctx, k3d, docker, a, server, taskID)
	case "cnpg-declarative-hibernation":
		return checkDeclarativeHibernation(ctx, k3d, docker, a, server, taskID)
	case "cnpg-snapshot-modes":
		return checkSnapshotModes(ctx, k3d, docker, a, server, taskID)
	case "cnpg-snapshot-pitr":
		return checkSnapshotPITR(ctx, k3d, docker, a, server, taskID)
	case "cnpg-plugin-snapshot-backup":
		return checkPluginSnapshotBackup(ctx, k3d, docker, a, server, taskID)
	case "cnpg-scheduled-snapshots":
		return checkScheduledSnapshots(ctx, k3d, docker, a, server, taskID)
	case "cnpg-managed-roles":
		return checkManagedRoles(ctx, k3d, docker, a, server, taskID)
	case "cnpg-role-passwords":
		return checkRolePasswords(ctx, k3d, docker, a, server, taskID)
	case "cnpg-tablespaces":
		return checkTablespaces(ctx, k3d, docker, a, server, taskID)
	case "cnpg-temporary-tablespaces":
		return checkTemporaryTablespaces(ctx, k3d, docker, a, server, taskID)
	case "cnpg-declarative-databases":
		return checkDeclarativeDatabases(ctx, k3d, docker, a, server, taskID)
	case "cnpg-database-reclaim":
		return checkDatabaseReclaim(ctx, k3d, docker, a, server, taskID)
	case "cnpg-tablespace-backup":
		return checkTablespaceBackup(ctx, k3d, docker, a, server, taskID)
	case "cnpg-tablespace-snapshot":
		return checkTablespaceSnapshot(ctx, k3d, docker, a, server, taskID)
	case "cnpg-major-upgrade":
		return checkMajorUpgrade(ctx, k3d, docker, a, server, taskID)
	}
	return CheckResult{}, fmt.Errorf("unknown lab %q", a.labID)
}

/* ---- Labs 29–31: replication slots, synchronous replication, scaling ---- */

// slotRow is one row of pg_replication_slots as the checks below read it.
type slotRow struct {
	name       string
	slotType   string
	active     bool
	restartLSN string
}

// readSlots lists the primary's replication slots. Read as the superuser over the Pod's
// unix socket, because pg_replication_slots' restart_lsn is not visible to a plain
// application role.
func readSlots(ctx context.Context, docker *Docker, server, primary string) ([]slotRow, error) {
	res, err := psqlSuper(ctx, docker, server, primary, "postgres",
		"SELECT slot_name, slot_type, active, coalesce(restart_lsn::text,'') FROM pg_replication_slots ORDER BY slot_name;")
	if err != nil {
		return nil, err
	}
	var out []slotRow
	for _, line := range strings.Split(strings.TrimSpace(res.stdout), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, "|")
		if len(f) < 4 {
			continue
		}
		out = append(out, slotRow{name: f[0], slotType: f[1], active: f[2] == "t", restartLSN: f[3]})
	}
	return out, nil
}

func haSlots(slots []slotRow) []slotRow {
	var out []slotRow
	for _, s := range slots {
		if strings.HasPrefix(s.name, "_cnpg_") {
			out = append(out, s)
		}
	}
	return out
}

func slotNames(slots []slotRow) string {
	names := make([]string, 0, len(slots))
	for _, s := range slots {
		names = append(names, s.name)
	}
	if len(names) == 0 {
		return "none"
	}
	return strings.Join(names, ", ")
}

func checkReplicationSlots(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	primary := c.Status.CurrentPrimary

	switch taskID {
	case "find-the-slots":
		var spec struct {
			Spec struct {
				ReplicationSlots struct {
					HighAvailability struct {
						Enabled    *bool  `json:"enabled"`
						SlotPrefix string `json:"slotPrefix"`
					} `json:"highAvailability"`
				} `json:"replicationSlots"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		enabled := spec.Spec.ReplicationSlots.HighAvailability.Enabled == nil ||
			*spec.Spec.ReplicationSlots.HighAvailability.Enabled

		slots, err := readSlots(ctx, docker, server, primary)
		if err != nil {
			return CheckResult{}, err
		}
		ha := haSlots(slots)
		allPhysical := len(ha) > 0
		for _, s := range ha {
			if s.slotType != "physical" {
				allPhysical = false
			}
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(enabled,
			"High-availability replication slots are enabled on the Cluster",
			detailOr("highAvailability.enabled is false", "enabled, slotPrefix _cnpg_", !enabled)))
		checks = append(checks, boolCheck(len(ha) == 2 && allPhysical,
			"The primary holds one physical slot per replica, named with the _cnpg_ prefix",
			fmt.Sprintf("%d slot(s): %s", len(ha), slotNames(ha))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/slots.txt")
		if !found {
			checks = append(checks, noItem("/root/slots.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/slots.txt was written", "found"))
		listed := 0
		for _, s := range ha {
			if strings.Contains(body, s.name) {
				listed++
			}
		}
		checks = append(checks, boolCheck(listed == len(ha) && listed > 0,
			"It names the slots the primary is holding",
			fmt.Sprintf("%d of %d slot name(s) present, file begins %q", listed, len(ha), firstLine(body))))
		return finish(checks), nil

	case "slot-holds-wal":
		// The point of the objective: a standby that was away rejoins and catches up from
		// WAL the slot made the primary keep — it is not rebuilt. So the evidence is the row
		// written during the outage being present on the instance that was away.
		written, err := psqlSuper(ctx, docker, server, primary, "app",
			"SELECT count(*) FROM slot_demo WHERE note = 'during-fence';")
		if err != nil {
			return CheckResult{}, err
		}
		onReplica, _ := psqlSuper(ctx, docker, server, "pg-cluster-3", "app",
			"SELECT count(*) FROM slot_demo WHERE note = 'during-fence';")
		streaming, err := psqlSuper(ctx, docker, server, primary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(written.count() >= 1,
			"A row noted 'during-fence' was written on the primary while pg-cluster-3 was away",
			fmt.Sprintf("%d row(s) on the primary", written.count())))
		checks = append(checks, boolCheck(streaming.count() == 2,
			"pg-cluster-3 is streaming again",
			fmt.Sprintf("%d standby(s) streaming", streaming.count())))
		checks = append(checks, boolCheck(onReplica.count() >= 1,
			"It caught up from the WAL its slot retained — the row is on pg-cluster-3",
			fmt.Sprintf("%d row(s) on pg-cluster-3", onReplica.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/slot-lsn.txt")
		if !found {
			checks = append(checks, noItem("/root/slot-lsn.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/slot-lsn.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "/"),
			"It records the restart_lsn the slot was holding",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "disable-ha-slots":
		var spec struct {
			Spec struct {
				ReplicationSlots struct {
					HighAvailability struct {
						Enabled *bool `json:"enabled"`
					} `json:"highAvailability"`
				} `json:"replicationSlots"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		disabled := spec.Spec.ReplicationSlots.HighAvailability.Enabled != nil &&
			!*spec.Spec.ReplicationSlots.HighAvailability.Enabled

		slots, err := readSlots(ctx, docker, server, primary)
		if err != nil {
			return CheckResult{}, err
		}
		ha := haSlots(slots)
		streaming, err := psqlSuper(ctx, docker, server, primary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(disabled,
			"highAvailability.enabled is set to false on the Cluster",
			detailOr("still enabled", "disabled", !disabled)))
		checks = append(checks, boolCheck(len(ha) == 0,
			"The _cnpg_ slots are gone from the primary",
			fmt.Sprintf("%d _cnpg_ slot(s) remain: %s", len(ha), slotNames(ha))))
		checks = append(checks, boolCheck(streaming.count() == 2,
			"Both replicas are still streaming without them",
			fmt.Sprintf("%d standby(s) streaming", streaming.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-replication-slots", taskID)
}

func checkSynchronousReplication(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	primary := c.Status.CurrentPrimary

	type syncSpec struct {
		Spec struct {
			PostgreSQL struct {
				Synchronous struct {
					Method         string `json:"method"`
					Number         int    `json:"number"`
					DataDurability string `json:"dataDurability"`
				} `json:"synchronous"`
			} `json:"postgresql"`
		} `json:"spec"`
	}
	readSync := func() (syncSpec, error) {
		var s syncSpec
		err := kubectlJSON(ctx, k3d, server, &s, "get", "cluster.postgresql.cnpg.io", "pg-cluster")
		return s, err
	}
	standbyNames := func() string {
		res, err := psqlSuper(ctx, docker, server, primary, "postgres", "SHOW synchronous_standby_names;")
		if err != nil || !res.ok() {
			return ""
		}
		return strings.TrimSpace(res.stdout)
	}

	switch taskID {
	case "enable-sync":
		spec, err := readSync()
		if err != nil {
			return CheckResult{}, err
		}
		names := standbyNames()
		quorum, err := psqlSuper(ctx, docker, server, primary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE sync_state = 'quorum';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		configured := spec.Spec.PostgreSQL.Synchronous.Method == "any" && spec.Spec.PostgreSQL.Synchronous.Number >= 1
		checks = append(checks, boolCheck(configured,
			"spec.postgresql.synchronous is set to method any",
			detailOr("not configured", fmt.Sprintf("method %s, number %d",
				spec.Spec.PostgreSQL.Synchronous.Method, spec.Spec.PostgreSQL.Synchronous.Number), !configured)))
		checks = append(checks, boolCheck(strings.HasPrefix(names, "ANY "),
			"PostgreSQL's synchronous_standby_names is no longer empty",
			detailOr("still empty — the cluster is asynchronous", names, !strings.HasPrefix(names, "ANY "))))
		checks = append(checks, boolCheck(quorum.count() == 2,
			"Both replicas report sync_state quorum",
			fmt.Sprintf("%d standby(s) in quorum", quorum.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/standby-names.txt")
		if !found {
			checks = append(checks, noItem("/root/standby-names.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/standby-names.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "ANY"),
			"It records the setting PostgreSQL is now running with",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "durability-required":
		spec, err := readSync()
		if err != nil {
			return CheckResult{}, err
		}
		// One standby away: the fenced instance stops streaming, so the primary sees one.
		streaming, err := psqlSuper(ctx, docker, server, primary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(spec.Spec.PostgreSQL.Synchronous.Number == 2,
			"The cluster now requires 2 acknowledgements",
			fmt.Sprintf("number is %d", spec.Spec.PostgreSQL.Synchronous.Number)))
		durability := spec.Spec.PostgreSQL.Synchronous.DataDurability
		checks = append(checks, boolCheck(durability == "" || durability == "required",
			"dataDurability is still required — the default",
			detailOr("dataDurability is "+durability, "required", !(durability == "" || durability == "required"))))
		checks = append(checks, boolCheck(streaming.count() == 1,
			"Only one standby is streaming, so the quorum cannot be met",
			fmt.Sprintf("%d standby(s) streaming", streaming.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/syncrep-wait.txt")
		if !found {
			checks = append(checks, noItem("/root/syncrep-wait.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/syncrep-wait.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "SyncRep"),
			"It records the wait event the blocked write was parked in",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "durability-preferred":
		spec, err := readSync()
		if err != nil {
			return CheckResult{}, err
		}
		names := standbyNames()
		written, err := psqlSuper(ctx, docker, server, primary, "app",
			"SELECT count(*) FROM sync_demo WHERE note = 'after-preferred';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		preferred := spec.Spec.PostgreSQL.Synchronous.DataDurability == "preferred"
		checks = append(checks, boolCheck(preferred,
			"dataDurability is set to preferred",
			detailOr("still "+spec.Spec.PostgreSQL.Synchronous.DataDurability, "preferred", !preferred)))
		// With one standby gone, `preferred` rewrites the list to what is actually reachable.
		shrunk := strings.HasPrefix(names, "ANY 1") && !strings.Contains(names, "pg-cluster-3")
		checks = append(checks, boolCheck(shrunk,
			"synchronous_standby_names now names only the standby that is actually there",
			detailOr(names, names, !shrunk)))
		checks = append(checks, boolCheck(written.count() >= 1,
			"A row noted 'after-preferred' committed instead of blocking",
			fmt.Sprintf("%d row(s)", written.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-synchronous-replication", taskID)
}

func checkClusterScaling(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	primary := c.Status.CurrentPrimary

	var spec struct {
		Spec struct {
			Instances int `json:"instances"`
		} `json:"spec"`
	}
	if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
		return CheckResult{}, err
	}
	pvcExists := func(name string) bool {
		var pvc struct {
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		}
		return kubectlJSON(ctx, k3d, server, &pvc, "get", "pvc", name) == nil && pvc.Status.Phase == "Bound"
	}

	switch taskID {
	case "scale-up":
		slots, err := readSlots(ctx, docker, server, primary)
		if err != nil {
			return CheckResult{}, err
		}
		hasSlot4 := false
		for _, s := range slots {
			if strings.HasSuffix(s.name, "_4") {
				hasSlot4 = true
			}
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(spec.Spec.Instances == 4,
			"spec.instances is 4", fmt.Sprintf("instances is %d", spec.Spec.Instances)))
		healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 4
		checks = append(checks, boolCheck(healthy,
			"The cluster is healthy with 4 of 4 ready",
			fmt.Sprintf("%s, %d/4 ready", c.Status.Phase, c.Status.ReadyInstances)))
		checks = append(checks, boolCheck(pvcExists("pg-cluster-4"),
			"pg-cluster-4 has a PersistentVolumeClaim of its own",
			detailOr("no bound PVC named pg-cluster-4", "bound", !pvcExists("pg-cluster-4"))))
		checks = append(checks, boolCheck(hasSlot4,
			"The primary holds a replication slot for the new instance",
			fmt.Sprintf("slots: %s", slotNames(haSlots(slots)))))
		return finish(checks), nil

	case "verify-new-replica":
		inRecovery, err := psqlSuper(ctx, docker, server, "pg-cluster-4", "postgres", "SELECT pg_is_in_recovery();")
		if err != nil {
			return CheckResult{}, err
		}
		rows, _ := psqlSuper(ctx, docker, server, "pg-cluster-4", "app",
			"SELECT count(*) FROM scale_demo WHERE note = 'before-scale-up';")
		streaming, err := psqlSuper(ctx, docker, server, primary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(strings.TrimSpace(inRecovery.stdout) == "t",
			"pg-cluster-4 is a standby, in recovery",
			detailOr("not in recovery", "pg_is_in_recovery() is true", strings.TrimSpace(inRecovery.stdout) != "t")))
		checks = append(checks, boolCheck(streaming.count() == 3,
			"The primary is streaming to all 3 standbys",
			fmt.Sprintf("%d standby(s) streaming", streaming.count())))
		checks = append(checks, boolCheck(rows.count() >= 1,
			"It carries data written before it existed — it was cloned, not replayed from empty",
			fmt.Sprintf("%d row(s) noted 'before-scale-up' on pg-cluster-4", rows.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/instances.txt")
		if !found {
			checks = append(checks, noItem("/root/instances.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/instances.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "4"),
			"It records how many instances the cluster grew to",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "scale-down":
		slots, err := readSlots(ctx, docker, server, primary)
		if err != nil {
			return CheckResult{}, err
		}
		slot4 := false
		for _, s := range slots {
			if strings.HasSuffix(s.name, "_4") {
				slot4 = true
			}
		}
		var pod struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		podGone := kubectlJSON(ctx, k3d, server, &pod, "get", "pod", "pg-cluster-4") != nil

		var checks []CheckItem
		checks = append(checks, boolCheck(spec.Spec.Instances == 3,
			"spec.instances is back to 3", fmt.Sprintf("instances is %d", spec.Spec.Instances)))
		checks = append(checks, boolCheck(podGone,
			"The pg-cluster-4 Pod is gone",
			detailOr("still present", "removed", !podGone)))
		checks = append(checks, boolCheck(!pvcExists("pg-cluster-4"),
			"Its PersistentVolumeClaim went with it",
			detailOr("pg-cluster-4 PVC is still bound", "removed", pvcExists("pg-cluster-4"))))
		checks = append(checks, boolCheck(!slot4,
			"And so did its replication slot",
			fmt.Sprintf("slots: %s", slotNames(haSlots(slots)))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-cluster-scaling", taskID)
}

/* ---- Labs 32–33: replica clusters and logical replication ---- */

// clusterPhase is the phase of any Cluster by name, or "" if it does not exist. The
// second-cluster labs grade an object the learner created, so its absence is a normal
// answer rather than an error.
func clusterPhase(ctx context.Context, k3d *K3D, server, name string) (string, int, bool) {
	var c struct {
		Status struct {
			Phase          string `json:"phase"`
			ReadyInstances int    `json:"readyInstances"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", name); err != nil {
		return "", 0, false
	}
	return c.Status.Phase, c.Status.ReadyInstances, true
}

func checkReplicaCluster(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	sourceC, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	sourcePrimary := sourceC.Status.CurrentPrimary

	switch taskID {
	case "create-replica-cluster":
		phase, ready, exists := clusterPhase(ctx, k3d, server, "pg-replica")
		// The source sees a replica cluster as one more streaming standby, named after the
		// cluster rather than an instance.
		streams, err := psqlSuper(ctx, docker, server, sourcePrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE application_name = 'pg-replica' AND state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(exists,
			"A second Cluster named pg-replica exists",
			detailOr("not found", "found", !exists)))
		checks = append(checks, boolCheck(phase == "Cluster in healthy state" && ready == 1,
			"It is healthy with its one instance ready",
			fmt.Sprintf("%s, %d/1 ready", detailOr("no phase", phase, phase == ""), ready)))
		checks = append(checks, boolCheck(streams.count() == 1,
			"The source cluster is streaming to it",
			fmt.Sprintf("%d connection(s) named pg-replica on the source", streams.count())))
		return finish(checks), nil

	case "verify-read-only":
		inRecovery, err := psqlSuper(ctx, docker, server, "pg-replica-1", "postgres", "SELECT pg_is_in_recovery();")
		if err != nil {
			return CheckResult{}, err
		}
		replicated, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "app",
			"SELECT count(*) FROM replica_demo WHERE note = 'before-replica';")
		// A write must be refused. Running it here is the only honest way to grade "it is
		// read-only" — the error is the evidence, so a *failing* statement is the pass.
		write, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "app",
			"INSERT INTO replica_demo (note) VALUES ('should-fail');")
		refused := !write.ok() && strings.Contains(write.stderr, "read-only")

		var checks []CheckItem
		isStandby := strings.TrimSpace(inRecovery.stdout) == "t"
		checks = append(checks, boolCheck(isStandby,
			"pg-replica-1 is in recovery — it is a standby, not a primary",
			detailOr("pg_is_in_recovery() is false", "pg_is_in_recovery() is true", !isStandby)))
		checks = append(checks, boolCheck(replicated.count() >= 1,
			"It carries the row written on the source before it was created",
			fmt.Sprintf("%d row(s) noted 'before-replica'", replicated.count())))
		checks = append(checks, boolCheck(refused,
			"It refuses writes: a read-only transaction error, not a permissions error",
			detailOr(firstLine(write.stderr), firstLine(write.stderr), !refused)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/replica-state.txt")
		if !found {
			checks = append(checks, noItem("/root/replica-state.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/replica-state.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "t"),
			"It records that the replica was in recovery",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "detach":
		var spec struct {
			Spec struct {
				Replica struct {
					Enabled *bool `json:"enabled"`
				} `json:"replica"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-replica"); err != nil {
			return CheckResult{}, err
		}
		detached := spec.Spec.Replica.Enabled != nil && !*spec.Spec.Replica.Enabled

		inRecovery, err := psqlSuper(ctx, docker, server, "pg-replica-1", "postgres", "SELECT pg_is_in_recovery();")
		if err != nil {
			return CheckResult{}, err
		}
		// Promotion starts a new timeline: the clearest evidence that this is now its own
		// lineage rather than a copy of the source's.
		timeline, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "postgres",
			"SELECT timeline_id FROM pg_control_checkpoint();")
		written, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "app",
			"SELECT count(*) FROM replica_demo WHERE note = 'after-detach';")

		var checks []CheckItem
		checks = append(checks, boolCheck(detached,
			"replica.enabled is set to false on pg-replica",
			detailOr("still an active replica cluster", "detached", !detached)))
		promoted := strings.TrimSpace(inRecovery.stdout) == "f"
		checks = append(checks, boolCheck(promoted,
			"pg-replica-1 has been promoted out of recovery",
			detailOr("still in recovery", "pg_is_in_recovery() is false", !promoted)))
		checks = append(checks, boolCheck(timeline.count() >= 2,
			"It is on a new timeline — its own lineage, not the source's",
			fmt.Sprintf("timeline %d", timeline.count())))
		checks = append(checks, boolCheck(written.count() >= 1,
			"A row noted 'after-detach' was accepted, so it takes writes now",
			fmt.Sprintf("%d row(s)", written.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-replica-cluster", taskID)
}

func checkLogicalReplication(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	sourceC, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	sourcePrimary := sourceC.Status.CurrentPrimary

	// crStatus reads the `applied` flag CloudNativePG stamps on a Publication or
	// Subscription, plus whatever message it left when it could not apply.
	crStatus := func(kind, name string) (bool, string) {
		var o struct {
			Status struct {
				Applied *bool  `json:"applied"`
				Message string `json:"message"`
			} `json:"status"`
		}
		if err := kubectlJSON(ctx, k3d, server, &o, "get", kind, name); err != nil {
			return false, "not found"
		}
		if o.Status.Applied == nil {
			return false, detailOr("no status yet", o.Status.Message, o.Status.Message == "")
		}
		return *o.Status.Applied, o.Status.Message
	}

	switch taskID {
	case "prepare-the-publisher":
		rows, err := psqlSuper(ctx, docker, server, sourcePrimary, "app",
			"SELECT count(*) FROM orders;")
		if err != nil {
			return CheckResult{}, err
		}
		// The role the subscription will connect as has to be allowed to start replication
		// at all — without this the publisher refuses the connection outright.
		repl, err := psqlSuper(ctx, docker, server, sourcePrimary, "postgres",
			"SELECT count(*) FROM pg_roles WHERE rolname = 'app' AND rolreplication;")
		if err != nil {
			return CheckResult{}, err
		}
		// …and to read the tables being published, or the initial copy fails with a
		// permission error long after the subscription reports itself applied.
		readable, _ := psqlSuper(ctx, docker, server, sourcePrimary, "app",
			"SELECT has_table_privilege('app', 'orders', 'SELECT')::text;")

		var checks []CheckItem
		checks = append(checks, boolCheck(rows.count() >= 2,
			"An orders table on the source holds at least 2 rows",
			fmt.Sprintf("%d row(s)", rows.count())))
		checks = append(checks, boolCheck(repl.count() == 1,
			"The app role has been granted REPLICATION on the source",
			detailOr("app cannot start replication", "rolreplication is true", repl.count() != 1)))
		checks = append(checks, boolCheck(strings.TrimSpace(readable.stdout) == "true",
			"The app role can read the orders table",
			detailOr("no SELECT privilege", "SELECT granted", strings.TrimSpace(readable.stdout) != "true")))
		return finish(checks), nil

	case "publish":
		applied, msg := crStatus("publication.postgresql.cnpg.io", "orders-pub")
		inPG, err := psqlSuper(ctx, docker, server, sourcePrimary, "app",
			"SELECT count(*) FROM pg_publication WHERE pubname = 'orders_pub';")
		if err != nil {
			return CheckResult{}, err
		}
		tables, _ := psqlSuper(ctx, docker, server, sourcePrimary, "app",
			"SELECT count(*) FROM pg_publication_tables WHERE pubname = 'orders_pub' AND tablename = 'orders';")

		var checks []CheckItem
		checks = append(checks, boolCheck(applied,
			"The Publication resource reports applied",
			detailOr(msg, "applied", !applied)))
		checks = append(checks, boolCheck(inPG.count() == 1,
			"PostgreSQL really has a publication named orders_pub",
			fmt.Sprintf("%d matching publication(s)", inPG.count())))
		checks = append(checks, boolCheck(tables.count() == 1,
			"It publishes the orders table",
			fmt.Sprintf("%d published table(s) named orders", tables.count())))
		return finish(checks), nil

	case "subscribe":
		applied, msg := crStatus("subscription.postgresql.cnpg.io", "orders-sub")
		// A logical slot on the *publisher* is what a working subscription looks like from
		// the other side.
		slot, err := psqlSuper(ctx, docker, server, sourcePrimary, "postgres",
			"SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'orders_sub' AND slot_type = 'logical';")
		if err != nil {
			return CheckResult{}, err
		}
		copied, _ := psqlSuper(ctx, docker, server, "pg-target-1", "app",
			"SELECT count(*) FROM orders;")
		live, _ := psqlSuper(ctx, docker, server, "pg-target-1", "app",
			"SELECT count(*) FROM orders WHERE item = 'after-subscribe';")

		var checks []CheckItem
		checks = append(checks, boolCheck(applied,
			"The Subscription resource reports applied",
			detailOr(msg, "applied", !applied)))
		checks = append(checks, boolCheck(slot.count() == 1,
			"A logical replication slot named orders_sub exists on the publisher",
			fmt.Sprintf("%d logical slot(s)", slot.count())))
		checks = append(checks, boolCheck(copied.count() >= 2,
			"The subscriber received the rows that already existed — the initial copy ran",
			fmt.Sprintf("%d row(s) on pg-target", copied.count())))
		checks = append(checks, boolCheck(live.count() >= 1,
			"And a row inserted after subscribing arrived too — it is still streaming",
			fmt.Sprintf("%d row(s) noted 'after-subscribe'", live.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-logical-replication", taskID)
}

/* ---- Labs 34–37: fencing, hibernation, configuration, rolling updates ---- */

// podPhase reports a Pod's readiness and restart count, and whether it exists at all. The
// fencing and hibernation labs both turn on the difference between "the Pod is gone" and
// "the Pod is there but not serving".
func podReady(ctx context.Context, k3d *K3D, server, name string) (exists, ready bool, restarts int) {
	var p struct {
		Status struct {
			Conditions []struct {
				Type   string `json:"type"`
				Status string `json:"status"`
			} `json:"conditions"`
			ContainerStatuses []struct {
				RestartCount int `json:"restartCount"`
			} `json:"containerStatuses"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &p, "get", "pod", name); err != nil {
		return false, false, 0
	}
	for _, c := range p.Status.Conditions {
		if c.Type == "Ready" {
			ready = c.Status == "True"
		}
	}
	if len(p.Status.ContainerStatuses) > 0 {
		restarts = p.Status.ContainerStatuses[0].RestartCount
	}
	return true, ready, restarts
}

func clusterAnnotation(ctx context.Context, k3d *K3D, server, cluster, key string) string {
	var c struct {
		Metadata struct {
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
	}
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster); err != nil {
		return ""
	}
	return c.Metadata.Annotations[key]
}

func checkFencing(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "fence-an-instance":
		fenced := clusterAnnotation(ctx, k3d, server, "pg-cluster", "cnpg.io/fencedInstances")
		exists, ready, restarts := podReady(ctx, k3d, server, "pg-cluster-3")
		// Fencing stops PostgreSQL and leaves the container running, so the socket is gone
		// while the Pod is not: a psql over the Pod's own socket must fail.
		psqlRes, _ := psqlSuper(ctx, docker, server, "pg-cluster-3", "postgres", "SELECT 1;")
		stopped := !psqlRes.ok()

		var checks []CheckItem
		named := strings.Contains(fenced, "pg-cluster-3")
		checks = append(checks, boolCheck(named,
			"The cluster carries a cnpg.io/fencedInstances annotation naming pg-cluster-3",
			detailOr("annotation absent or does not name it", fenced, !named)))
		checks = append(checks, boolCheck(exists && !ready,
			"Its Pod is still there, but not Ready — so it is out of the Services",
			fmt.Sprintf("exists=%t ready=%t restarts=%d", exists, ready, restarts)))
		checks = append(checks, boolCheck(stopped,
			"PostgreSQL inside it is stopped — the socket is gone",
			detailOr("psql still answers, so PostgreSQL is not stopped", firstLine(psqlRes.stderr), !stopped)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/fenced.txt")
		if !found {
			checks = append(checks, noItem("/root/fenced.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/fenced.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "pg-cluster-3"),
			"It records which instance was fenced",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "data-survives":
		exists, _, restarts := podReady(ctx, k3d, server, "pg-cluster-3")
		var pvc struct {
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		}
		pvcBound := kubectlJSON(ctx, k3d, server, &pvc, "get", "pvc", "pg-cluster-3") == nil && pvc.Status.Phase == "Bound"

		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		written, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT count(*) FROM fence_demo WHERE note = 'while-fenced';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(exists && restarts == 0,
			"The fenced Pod was never restarted — fencing is not a delete",
			fmt.Sprintf("exists=%t, restarts=%d", exists, restarts)))
		checks = append(checks, boolCheck(pvcBound,
			"Its PersistentVolumeClaim is still bound",
			detailOr("PVC missing or unbound", "bound", !pvcBound)))
		checks = append(checks, boolCheck(written.count() >= 1,
			"The rest of the cluster kept serving writes while it was fenced",
			fmt.Sprintf("%d row(s) noted 'while-fenced'", written.count())))
		return finish(checks), nil

	case "unfence":
		fenced := clusterAnnotation(ctx, k3d, server, "pg-cluster", "cnpg.io/fencedInstances")
		_, ready, _ := podReady(ctx, k3d, server, "pg-cluster-3")
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		caughtUp, _ := psqlSuper(ctx, docker, server, "pg-cluster-3", "app",
			"SELECT count(*) FROM fence_demo WHERE note = 'while-fenced';")

		var checks []CheckItem
		clear := !strings.Contains(fenced, "pg-cluster-3")
		checks = append(checks, boolCheck(clear,
			"pg-cluster-3 is no longer in the fencedInstances annotation",
			detailOr("still fenced: "+fenced, "annotation cleared", !clear)))
		checks = append(checks, boolCheck(ready,
			"Its Pod is Ready again, so it is back in the Services",
			detailOr("still not Ready", "Ready", !ready)))
		checks = append(checks, boolCheck(streaming.count() == 2,
			"It is streaming from the primary again",
			fmt.Sprintf("%d standby(s) streaming", streaming.count())))
		checks = append(checks, boolCheck(caughtUp.count() >= 1,
			"And it caught up on everything written while it was away",
			fmt.Sprintf("%d row(s) noted 'while-fenced' on pg-cluster-3", caughtUp.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-fencing", taskID)
}

func checkHibernation(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	pvcCount := func() int {
		var l struct {
			Items []struct {
				Status struct {
					Phase string `json:"phase"`
				} `json:"status"`
			} `json:"items"`
		}
		if err := kubectlJSON(ctx, k3d, server, &l, "get", "pvc", "-l", "cnpg.io/cluster=pg-cluster"); err != nil {
			return 0
		}
		n := 0
		for _, i := range l.Items {
			if i.Status.Phase == "Bound" {
				n++
			}
		}
		return n
	}
	instancePods := func() int {
		_, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return -1
		}
		return len(pods.Items)
	}

	switch taskID {
	case "hibernate":
		ann := clusterAnnotation(ctx, k3d, server, "pg-cluster", "cnpg.io/hibernation")
		pods := instancePods()
		pvcs := pvcCount()

		var checks []CheckItem
		checks = append(checks, boolCheck(ann == "on",
			"The cluster is annotated cnpg.io/hibernation: on",
			detailOr("annotation is "+detailOr("absent", ann, ann == ""), "on", ann != "on")))
		checks = append(checks, boolCheck(pods == 0,
			"Every instance Pod is gone",
			fmt.Sprintf("%d instance Pod(s) remain", pods)))
		checks = append(checks, boolCheck(pvcs == 3,
			"All 3 PersistentVolumeClaims are still bound — the data is kept",
			fmt.Sprintf("%d bound PVC(s)", pvcs)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/hibernated.txt")
		if !found {
			checks = append(checks, noItem("/root/hibernated.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/hibernated.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "3"),
			"It records how many volumes were kept",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "wake-up":
		ann := clusterAnnotation(ctx, k3d, server, "pg-cluster", "cnpg.io/hibernation")
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT count(*) FROM hibernate_demo WHERE note = 'before-hibernation';")

		var checks []CheckItem
		checks = append(checks, boolCheck(ann == "off",
			"The hibernation annotation reads off",
			detailOr("annotation is "+detailOr("absent", ann, ann == ""), "off", ann != "off")))
		healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
		checks = append(checks, boolCheck(healthy,
			"The cluster is healthy again with 3 of 3 ready",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		checks = append(checks, boolCheck(rows.count() >= 1,
			"The row written before hibernation is still there",
			fmt.Sprintf("%d row(s) noted 'before-hibernation'", rows.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-hibernation", taskID)
}

// pgSetting reads one row of pg_settings from an instance: the running value and whether a
// restart is outstanding before the configured value takes effect.
func pgSetting(ctx context.Context, docker *Docker, server, pod, name string) (value string, pendingRestart bool) {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres",
		fmt.Sprintf("SELECT setting || '|' || pending_restart FROM pg_settings WHERE name = '%s';", name))
	if err != nil || !res.ok() {
		return "", false
	}
	v, p := splitPipe(strings.TrimSpace(res.stdout))
	return v, p == "t"
}

func checkConfigChanges(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	primary := c.Status.CurrentPrimary

	var spec struct {
		Spec struct {
			PostgreSQL struct {
				Parameters map[string]string `json:"parameters"`
			} `json:"postgresql"`
		} `json:"spec"`
	}
	if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
		return CheckResult{}, err
	}

	switch taskID {
	case "reload-only":
		value, pending := pgSetting(ctx, docker, server, primary, "log_min_duration_statement")
		_, _, restarts := podReady(ctx, k3d, server, primary)

		var checks []CheckItem
		declared := spec.Spec.PostgreSQL.Parameters["log_min_duration_statement"]
		checks = append(checks, boolCheck(declared != "",
			"log_min_duration_statement is declared in spec.postgresql.parameters",
			detailOr("not set", declared, declared == "")))
		checks = append(checks, boolCheck(value == "250",
			"PostgreSQL is running with it — 250ms",
			fmt.Sprintf("running value is %q", value)))
		checks = append(checks, boolCheck(!pending,
			"No restart is pending — it took effect on a reload",
			detailOr("pending_restart is true", "pending_restart is false", pending)))
		checks = append(checks, boolCheck(restarts == 0,
			"The primary's container was never restarted",
			fmt.Sprintf("restartCount is %d", restarts)))
		return finish(checks), nil

	case "restart-required":
		value, pending := pgSetting(ctx, docker, server, primary, "max_connections")

		var checks []CheckItem
		declared := spec.Spec.PostgreSQL.Parameters["max_connections"]
		checks = append(checks, boolCheck(declared == "200",
			"max_connections is declared as 200",
			detailOr("declared as "+detailOr("nothing", declared, declared == ""), declared, declared != "200")))
		checks = append(checks, boolCheck(value == "200",
			"PostgreSQL is running with 200 — the restart has happened",
			fmt.Sprintf("running value is %q", value)))
		checks = append(checks, boolCheck(!pending,
			"pending_restart has cleared",
			detailOr("still pending", "false", pending)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster came back healthy with 3 of 3 ready",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/pending-restart.txt")
		if !found {
			checks = append(checks, noItem("/root/pending-restart.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/pending-restart.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "t") || strings.Contains(body, "max_connections"),
			"It captured the pending_restart state you saw",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "rejected":
		// The admission webhook refuses "fixed" parameters outright, so the evidence is
		// twofold: the spec never took the value, and the learner captured the refusal.
		_, hasFixed := spec.Spec.PostgreSQL.Parameters["listen_addresses"]

		var checks []CheckItem
		checks = append(checks, boolCheck(!hasFixed,
			"listen_addresses never reached the spec — the webhook refused it",
			detailOr("it is present in spec.postgresql.parameters", "absent, as expected", hasFixed)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/rejected.txt")
		if !found {
			checks = append(checks, noItem("/root/rejected.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/rejected.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "fixed configuration parameter"),
			"It captured the webhook's refusal",
			fmt.Sprintf("file says %q", firstLine(body))))
		// The parameters that *were* accepted are still in force: a rejected change is
		// rejected whole, and leaves everything else alone.
		running, _ := pgSetting(ctx, docker, server, primary, "max_connections")
		checks = append(checks, boolCheck(running == "200",
			"The parameters that were accepted are still in force",
			fmt.Sprintf("max_connections is %q", running)))
		return finish(checks), nil

	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-config-changes", taskID)
}

func checkRollingUpdate(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, pods, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}

	var spec struct {
		Spec struct {
			ImageName           string `json:"imageName"`
			PrimaryUpdateMethod string `json:"primaryUpdateMethod"`
		} `json:"spec"`
	}
	if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
		return CheckResult{}, err
	}

	switch taskID {
	case "survey-the-version":
		version, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT current_setting('server_version');")

		var checks []CheckItem
		old := strings.Contains(spec.Spec.ImageName, "18.3")
		checks = append(checks, boolCheck(old,
			"The cluster is running the 18.3 image it was built with",
			fmt.Sprintf("imageName is %q", spec.Spec.ImageName)))
		checks = append(checks, boolCheck(strings.HasPrefix(strings.TrimSpace(version.stdout), "18.3"),
			"PostgreSQL reports a matching server version",
			fmt.Sprintf("server_version is %q", strings.TrimSpace(version.stdout))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/before-image.txt")
		if !found {
			checks = append(checks, noItem("/root/before-image.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/before-image.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "18.3"),
			"It records the image the cluster started on",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "roll-the-image":
		version, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT current_setting('server_version');")
		// The image a Pod is *running* comes from its container status, not its spec — the
		// spec can name a new image while the container is still the old one mid-roll.
		onNew := 0
		for _, p := range pods.Items {
			for _, cs := range p.Status.ContainerStatuses {
				if strings.Contains(cs.Image, "18.4") {
					onNew++
					break
				}
			}
		}

		var checks []CheckItem
		updated := strings.Contains(spec.Spec.ImageName, "18.4")
		checks = append(checks, boolCheck(updated,
			"spec.imageName now names the 18.4 image",
			fmt.Sprintf("imageName is %q", spec.Spec.ImageName)))
		checks = append(checks, boolCheck(onNew == 3,
			"All 3 instance Pods are running that image",
			fmt.Sprintf("%d of %d Pod(s) on 18.4", onNew, len(pods.Items))))
		checks = append(checks, boolCheck(strings.HasPrefix(strings.TrimSpace(version.stdout), "18.4"),
			"PostgreSQL reports the new server version",
			fmt.Sprintf("server_version is %q", strings.TrimSpace(version.stdout))))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster is healthy with 3 of 3 ready",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "data-intact":
		rows, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT count(*) FROM upgrade_demo WHERE note = 'before-upgrade';")
		if err != nil {
			return CheckResult{}, err
		}
		after, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT count(*) FROM upgrade_demo WHERE note = 'after-upgrade';")
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(rows.count() >= 1,
			"The row written before the upgrade survived it",
			fmt.Sprintf("%d row(s) noted 'before-upgrade'", rows.count())))
		checks = append(checks, boolCheck(after.count() >= 1,
			"A row written after the upgrade was accepted",
			fmt.Sprintf("%d row(s) noted 'after-upgrade'", after.count())))
		checks = append(checks, boolCheck(streaming.count() == 2,
			"Both replicas are streaming on the new image",
			fmt.Sprintf("%d standby(s) streaming", streaming.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-rolling-update", taskID)
}

/* ---- Labs 38–41: image catalogs, hot-standby parameters, replica bootstraps ---- */

// hotStandbyParams are the settings PostgreSQL requires a standby to hold at a value no
// lower than the primary's. The primary's values reach the standby through the WAL and are
// recorded in its control file; a standby whose own setting is below what the control file
// says refuses to start hot standby.
var hotStandbyParams = []string{
	"max_connections", "max_worker_processes", "max_wal_senders",
	"max_prepared_transactions", "max_locks_per_transaction",
}

func checkImageCatalog(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, pods, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}

	var spec struct {
		Spec struct {
			ImageName       string `json:"imageName"`
			ImageCatalogRef struct {
				Kind  string `json:"kind"`
				Name  string `json:"name"`
				Major int    `json:"major"`
			} `json:"imageCatalogRef"`
		} `json:"spec"`
	}
	if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
		return CheckResult{}, err
	}
	// catalogImage is what the catalog maps major 18 to right now.
	catalogImage := func() string {
		var cat struct {
			Spec struct {
				Images []struct {
					Major int    `json:"major"`
					Image string `json:"image"`
				} `json:"images"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &cat, "get", "imagecatalog.postgresql.cnpg.io", "postgres-catalog"); err != nil {
			return ""
		}
		for _, i := range cat.Spec.Images {
			if i.Major == 18 {
				return i.Image
			}
		}
		return ""
	}
	podsOn := func(tag string) int {
		n := 0
		for _, p := range pods.Items {
			for _, cs := range p.Status.ContainerStatuses {
				if strings.Contains(cs.Image, tag) {
					n++
					break
				}
			}
		}
		return n
	}
	refOK := spec.Spec.ImageCatalogRef.Kind == "ImageCatalog" &&
		spec.Spec.ImageCatalogRef.Name == "postgres-catalog" &&
		spec.Spec.ImageCatalogRef.Major == 18

	switch taskID {
	case "adopt-the-catalog":
		img := catalogImage()

		var checks []CheckItem
		checks = append(checks, boolCheck(img != "",
			"An ImageCatalog named postgres-catalog exists",
			detailOr("not found, or it has no entry for major 18", img, img == "")))
		checks = append(checks, boolCheck(strings.Contains(img, "18.3"),
			"It maps major 18 to the 18.3 image",
			fmt.Sprintf("major 18 is %q", img)))
		checks = append(checks, boolCheck(refOK && spec.Spec.ImageName == "",
			"The Cluster references the catalog and no longer names an image of its own",
			detailOr("spec.imageName is "+spec.Spec.ImageName, fmt.Sprintf("imageCatalogRef %s major %d",
				spec.Spec.ImageCatalogRef.Name, spec.Spec.ImageCatalogRef.Major), spec.Spec.ImageName != "")))
		healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
		checks = append(checks, boolCheck(healthy && podsOn("18.3") == 3,
			"The cluster is still healthy, still on 18.3",
			fmt.Sprintf("%s, %d/3 ready, %d Pod(s) on 18.3", c.Status.Phase, c.Status.ReadyInstances, podsOn("18.3"))))
		return finish(checks), nil

	case "roll-via-the-catalog":
		img := catalogImage()
		version, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT current_setting('server_version');")

		var checks []CheckItem
		checks = append(checks, boolCheck(strings.Contains(img, "18.4"),
			"The catalog now maps major 18 to the 18.4 image",
			fmt.Sprintf("major 18 is %q", img)))
		checks = append(checks, boolCheck(podsOn("18.4") == 3,
			"All 3 instance Pods are running that image",
			fmt.Sprintf("%d of %d Pod(s) on 18.4", podsOn("18.4"), len(pods.Items))))
		// The point of the lab: the upgrade happened without the Cluster being edited.
		checks = append(checks, boolCheck(refOK && spec.Spec.ImageName == "",
			"The Cluster still names no image of its own — only the catalog moved",
			detailOr("spec.imageName is set to "+spec.Spec.ImageName, "imageCatalogRef only", spec.Spec.ImageName != "")))
		checks = append(checks, boolCheck(strings.HasPrefix(strings.TrimSpace(version.stdout), "18.4"),
			"PostgreSQL reports the new server version",
			fmt.Sprintf("server_version is %q", strings.TrimSpace(version.stdout))))
		return finish(checks), nil

	case "record-the-result":
		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT count(*) FROM catalog_demo WHERE note = 'before-catalog-bump';")
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(rows.count() >= 1,
			"The row written before the catalog moved survived the roll",
			fmt.Sprintf("%d row(s) noted 'before-catalog-bump'", rows.count())))
		checks = append(checks, boolCheck(streaming.count() == 2,
			"Both replicas are streaming on the new image",
			fmt.Sprintf("%d standby(s) streaming", streaming.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/catalog-image.txt")
		if !found {
			checks = append(checks, noItem("/root/catalog-image.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/catalog-image.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "18.4"),
			"It records the image the catalog now points at",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-image-catalog", taskID)
}

// controlFileParam reads one "<name> setting:" line out of pg_controldata on an instance —
// which is where a standby records the *primary's* value for a hot-standby-sensitive
// parameter, learned from the WAL rather than from its own configuration.
func controlFileParam(ctx context.Context, docker *Docker, server, pod, name string) string {
	res, err := runSQL(ctx, docker, server, []string{
		"kubectl", "exec", pod, "-c", "postgres", "--",
		"pg_controldata", "-D", "/var/lib/postgresql/data/pgdata",
	})
	if err != nil || !res.ok() {
		return ""
	}
	// pg_controldata abbreviates two of them: max_prepared_xacts, max_locks_per_xact.
	want := strings.TrimSuffix(strings.TrimSuffix(name, "actions"), "_transaction")
	for _, line := range strings.Split(res.stdout, "\n") {
		if strings.HasPrefix(line, name+" setting:") || strings.HasPrefix(line, want+" setting:") ||
			(name == "max_prepared_transactions" && strings.HasPrefix(line, "max_prepared_xacts setting:")) ||
			(name == "max_locks_per_transaction" && strings.HasPrefix(line, "max_locks_per_xact setting:")) {
			_, v := splitPipe(strings.ReplaceAll(line, "setting:", "|"))
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func checkHotStandbyParams(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	primary := c.Status.CurrentPrimary
	standby := "pg-cluster-2"
	if primary == standby {
		standby = "pg-cluster-1"
	}

	// allAgree reports whether every instance runs the same value for each sensitive
	// parameter — which is the invariant the operator's roll order exists to preserve.
	allAgree := func() (bool, string) {
		var mismatched []string
		for _, name := range hotStandbyParams {
			p, _ := pgSetting(ctx, docker, server, primary, name)
			s, _ := pgSetting(ctx, docker, server, standby, name)
			if p == "" || p != s {
				mismatched = append(mismatched, fmt.Sprintf("%s primary=%s standby=%s", name, p, s))
			}
		}
		if len(mismatched) == 0 {
			return true, fmt.Sprintf("all %d parameters agree", len(hotStandbyParams))
		}
		return false, strings.Join(mismatched, "; ")
	}

	switch taskID {
	case "find-the-parameters":
		agree, detail := allAgree()
		ctrl := controlFileParam(ctx, docker, server, standby, "max_connections")
		running, _ := pgSetting(ctx, docker, server, primary, "max_connections")

		var checks []CheckItem
		checks = append(checks, boolCheck(agree,
			"The five hot-standby-sensitive parameters agree on the primary and a standby", detail))
		checks = append(checks, boolCheck(ctrl != "" && ctrl == running,
			"The standby's control file records the primary's max_connections",
			fmt.Sprintf("control file says %q, the primary runs %q", ctrl, running)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/control-file.txt")
		if !found {
			checks = append(checks, noItem("/root/control-file.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/control-file.txt was written", "found"))
		checks = append(checks, boolCheck(ctrl != "" && strings.Contains(body, ctrl),
			"It captured the value the control file is holding",
			fmt.Sprintf("file says %q, control file says %q", firstLine(body), ctrl)))
		return finish(checks), nil

	case "raise-the-limit":
		var spec struct {
			Spec struct {
				PostgreSQL struct {
					Parameters map[string]string `json:"parameters"`
				} `json:"postgresql"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		running, _ := pgSetting(ctx, docker, server, primary, "max_connections")
		onStandby, _ := pgSetting(ctx, docker, server, standby, "max_connections")
		ctrl := controlFileParam(ctx, docker, server, standby, "max_connections")

		var checks []CheckItem
		checks = append(checks, boolCheck(spec.Spec.PostgreSQL.Parameters["max_connections"] == "200",
			"max_connections is declared as 200",
			detailOr("declared as "+spec.Spec.PostgreSQL.Parameters["max_connections"], "200",
				spec.Spec.PostgreSQL.Parameters["max_connections"] != "200")))
		checks = append(checks, boolCheck(running == "200" && onStandby == "200",
			"The primary and the standby are both running 200",
			fmt.Sprintf("primary=%s standby=%s", running, onStandby)))
		// The invariant: a standby must never sit below the primary, which is why the
		// operator rolls the replicas before the primary.
		checks = append(checks, boolCheck(ctrl == "200",
			"The standby's control file followed the primary up to 200",
			fmt.Sprintf("control file says %q", ctrl)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster came back healthy with 3 of 3 ready",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "lower-it-again":
		running, _ := pgSetting(ctx, docker, server, primary, "max_connections")
		ctrl := controlFileParam(ctx, docker, server, standby, "max_connections")
		agree, detail := allAgree()

		var checks []CheckItem
		checks = append(checks, boolCheck(running == "100",
			"max_connections is back to 100 on the primary",
			fmt.Sprintf("primary runs %q", running)))
		checks = append(checks, boolCheck(ctrl == "100",
			"The standby's control file followed it back down",
			fmt.Sprintf("control file says %q", ctrl)))
		checks = append(checks, boolCheck(agree,
			"Every sensitive parameter agrees across instances again", detail))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-hot-standby-params", taskID)
}

// replicaBootstrapChecks is shared by the two replica-bootstrap labs: both end with a
// single-instance Cluster named pg-replica that must be in recovery, carry the source's
// data, and refuse writes.
func replicaBootstrapChecks(ctx context.Context, k3d *K3D, docker *Docker, server, table, note string) []CheckItem {
	phase, ready, exists := clusterPhase(ctx, k3d, server, "pg-replica")
	inRecovery, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "postgres", "SELECT pg_is_in_recovery();")
	rows, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "app",
		fmt.Sprintf("SELECT count(*) FROM %s WHERE note = '%s';", table, note))
	write, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "app",
		fmt.Sprintf("INSERT INTO %s (note) VALUES ('should-fail');", table))
	refused := !write.ok() && strings.Contains(write.stderr, "read-only")

	var checks []CheckItem
	checks = append(checks, boolCheck(exists && phase == "Cluster in healthy state" && ready == 1,
		"A Cluster named pg-replica is healthy with its one instance ready",
		fmt.Sprintf("%s, %d/1 ready", detailOr("not found", phase, !exists), ready)))
	standby := strings.TrimSpace(inRecovery.stdout) == "t"
	checks = append(checks, boolCheck(standby,
		"It is in recovery — a standby, not a primary",
		detailOr("pg_is_in_recovery() is false", "pg_is_in_recovery() is true", !standby)))
	checks = append(checks, boolCheck(rows.count() >= 1,
		"It carries the row the source wrote before it existed",
		fmt.Sprintf("%d row(s) noted '%s'", rows.count(), note)))
	checks = append(checks, boolCheck(refused,
		"It refuses writes with a read-only transaction error",
		detailOr("the write was accepted", firstLine(write.stderr), !refused)))
	return checks
}

func checkReplicaFromBackup(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "recover-into-a-replica":
		return finish(replicaBootstrapChecks(ctx, k3d, docker, server, "backup_demo", "before-backup")), nil

	case "follow-the-archive":
		// The coupling is the object store, not a connection: the source archives WAL and
		// the replica replays what it finds there.
		after, _ := psqlSuper(ctx, docker, server, "pg-replica-1", "app",
			"SELECT count(*) FROM backup_demo WHERE note = 'after-backup';")
		var conn struct {
			Items []struct {
				Metadata struct{ Name string } `json:"metadata"`
			} `json:"items"`
		}
		_ = kubectlJSON(ctx, k3d, server, &conn, "get", "pods", "-l", "cnpg.io/cluster=pg-replica")
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		// The source must not be streaming to it — that is what makes this the archive shape.
		streams, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE application_name = 'pg-replica';")

		var checks []CheckItem
		checks = append(checks, boolCheck(after.count() >= 1,
			"A row written on the source after the backup reached the replica",
			fmt.Sprintf("%d row(s) noted 'after-backup' on pg-replica", after.count())))
		checks = append(checks, boolCheck(streams.count() == 0,
			"The source is not streaming to it — the two are coupled only through the object store",
			fmt.Sprintf("%d streaming connection(s) named pg-replica", streams.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/replica-lsn.txt")
		if !found {
			checks = append(checks, noItem("/root/replica-lsn.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/replica-lsn.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "/"),
			"It records how far the replica has replayed",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-replica-from-backup", taskID)
}

func checkReplicaFromSnapshot(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "take-the-snapshot":
		var snap struct {
			Status struct {
				ReadyToUse  *bool  `json:"readyToUse"`
				RestoreSize string `json:"restoreSize"`
			} `json:"status"`
		}
		err := kubectlJSON(ctx, k3d, server, &snap, "get", "volumesnapshot", "pg-cluster-snapshot")
		ready := err == nil && snap.Status.ReadyToUse != nil && *snap.Status.ReadyToUse

		var checks []CheckItem
		checks = append(checks, boolCheck(err == nil,
			"A VolumeSnapshot named pg-cluster-snapshot exists",
			detailOr("not found", "found", err != nil)))
		checks = append(checks, boolCheck(ready,
			"It reports readyToUse — the CSI driver has taken it",
			detailOr("not ready yet", "readyToUse is true, restoreSize "+snap.Status.RestoreSize, !ready)))
		return finish(checks), nil

	case "bootstrap-from-it":
		checks := replicaBootstrapChecks(ctx, k3d, docker, server, "snapshot_demo", "before-snapshot")
		// Unlike the object-store shape, this replica follows by streaming, so the source
		// really should see it.
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		streams, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE application_name = 'pg-replica' AND state = 'streaming';")
		checks = append(checks, boolCheck(streams.count() == 1,
			"The source is streaming to it — the snapshot was the seed, streaming keeps it current",
			fmt.Sprintf("%d streaming connection(s) named pg-replica", streams.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-replica-from-snapshot", taskID)
}

/* ---- Labs 42–43: initdb bootstrap, taints and tolerations ---- */

// namedClusterSetting reads one pg_settings value from an instance of a cluster other than
// pg-cluster — the initdb lab's cluster is called pg-init and has its own instances.
func namedClusterSetting(ctx context.Context, docker *Docker, server, pod, name string) string {
	v, _ := pgSetting(ctx, docker, server, pod, name)
	return v
}

func checkInitdb(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	phase, ready, exists := clusterPhase(ctx, k3d, server, "pg-init")

	switch taskID {
	case "bootstrap-it":
		// The database, its owner and the two post-init hooks are all things only initdb
		// could have produced — they are read back from the cluster it built.
		db, _ := psqlSuper(ctx, docker, server, "pg-init-1", "postgres",
			"SELECT count(*) FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname='orders' AND r.rolname='shop';")
		seeded, _ := psqlSuper(ctx, docker, server, "pg-init-1", "orders",
			"SELECT count(*) FROM seeded WHERE note = 'from postInitApplicationSQL';")
		auditor, _ := psqlSuper(ctx, docker, server, "pg-init-1", "postgres",
			"SELECT count(*) FROM pg_roles WHERE rolname = 'auditor';")

		var checks []CheckItem
		checks = append(checks, boolCheck(exists && phase == "Cluster in healthy state" && ready == 2,
			"A Cluster named pg-init is healthy with both instances ready",
			fmt.Sprintf("%s, %d/2 ready", detailOr("not found", phase, !exists), ready)))
		checks = append(checks, boolCheck(db.count() == 1,
			"Its application database is orders, owned by shop",
			detailOr("no database named orders owned by shop", "orders is owned by shop", db.count() != 1)))
		checks = append(checks, boolCheck(seeded.count() >= 1,
			"postInitApplicationSQL ran — the seeded table exists in orders with its row",
			fmt.Sprintf("%d matching row(s) in orders.seeded", seeded.count())))
		checks = append(checks, boolCheck(auditor.count() == 1,
			"postInitSQL ran — the auditor role exists",
			detailOr("no auditor role", "auditor exists", auditor.count() != 1)))
		return finish(checks), nil

	case "read-the-physical-choices":
		// These two are decided by initdb and written into the data directory; nothing can
		// change them later without rebuilding the cluster.
		wal := namedClusterSetting(ctx, docker, server, "pg-init-1", "wal_segment_size")
		checksums := namedClusterSetting(ctx, docker, server, "pg-init-1", "data_checksums")

		var checks []CheckItem
		checks = append(checks, boolCheck(wal == "33554432",
			"The WAL segment size is 32MB, not the 16MB default",
			fmt.Sprintf("wal_segment_size is %q", wal)))
		checks = append(checks, boolCheck(checksums == "on",
			"Data checksums are on", fmt.Sprintf("data_checksums is %q", checksums)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/initdb-settings.txt")
		if !found {
			checks = append(checks, noItem("/root/initdb-settings.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/initdb-settings.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "33554432"),
			"It records the segment size initdb chose",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "try-to-change-it":
		var spec struct {
			Spec struct {
				Bootstrap struct {
					Initdb struct {
						Database       string `json:"database"`
						WalSegmentSize int    `json:"walSegmentSize"`
					} `json:"initdb"`
				} `json:"bootstrap"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-init"); err != nil {
			return CheckResult{}, err
		}
		// The spec was accepted and now describes something that is not true.
		stillOrders, _ := psqlSuper(ctx, docker, server, "pg-init-1", "postgres",
			"SELECT count(*) FROM pg_database WHERE datname = 'orders';")
		renamed, _ := psqlSuper(ctx, docker, server, "pg-init-1", "postgres",
			"SELECT count(*) FROM pg_database WHERE datname = 'renamed';")
		wal := namedClusterSetting(ctx, docker, server, "pg-init-1", "wal_segment_size")

		var checks []CheckItem
		asked := spec.Spec.Bootstrap.Initdb.Database == "renamed"
		checks = append(checks, boolCheck(asked,
			"The spec now asks for a database called renamed",
			detailOr("spec still says "+spec.Spec.Bootstrap.Initdb.Database, "renamed", !asked)))
		checks = append(checks, boolCheck(stillOrders.count() == 1 && renamed.count() == 0,
			"The database is still orders — nothing was renamed",
			fmt.Sprintf("orders=%d renamed=%d", stillOrders.count(), renamed.count())))
		checks = append(checks, boolCheck(wal == "33554432",
			"And the WAL segment size is still 32MB, whatever the spec now says",
			fmt.Sprintf("wal_segment_size is %q, spec asks for %dMB", wal, spec.Spec.Bootstrap.Initdb.WalSegmentSize)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-initdb", taskID)
}

// taintedNodeName is the node this lab taints: the agent hosting pg-cluster-2 at the time
// the check runs, resolved from the Pod rather than assumed, since scheduling is not fixed.
func nodeTaints(ctx context.Context, k3d *K3D, server, node string) []struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Effect string `json:"effect"`
} {
	var n struct {
		Spec struct {
			Taints []struct {
				Key    string `json:"key"`
				Value  string `json:"value"`
				Effect string `json:"effect"`
			} `json:"taints"`
		} `json:"spec"`
	}
	if err := kubectlJSON(ctx, k3d, server, &n, "get", "node", node); err != nil {
		return nil
	}
	return n.Spec.Taints
}

func checkTaintsTolerations(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, pods, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	// Find whichever node carries the maintenance taint, whatever it is called.
	var nodeList struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}
	_ = kubectlJSON(ctx, k3d, server, &nodeList, "get", "nodes")
	tainted, taintDetail := "", "no node carries a maintenance taint"
	for _, n := range nodeList.Items {
		for _, t := range nodeTaints(ctx, k3d, server, n.Metadata.Name) {
			if t.Key == "maintenance" {
				tainted = n.Metadata.Name
				taintDetail = fmt.Sprintf("%s has maintenance=%s:%s", n.Metadata.Name, t.Value, t.Effect)
			}
		}
	}

	var spec struct {
		Spec struct {
			Affinity struct {
				Tolerations []struct {
					Key    string `json:"key"`
					Value  string `json:"value"`
					Effect string `json:"effect"`
				} `json:"tolerations"`
			} `json:"affinity"`
		} `json:"spec"`
	}
	if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
		return CheckResult{}, err
	}
	tolerated := false
	for _, t := range spec.Spec.Affinity.Tolerations {
		if t.Key == "maintenance" {
			tolerated = true
		}
	}
	pending, running := 0, 0
	for _, p := range pods.Items {
		if p.Status.Phase == "Pending" {
			pending++
		}
		if p.Status.Phase == "Running" {
			running++
		}
	}

	switch taskID {
	case "taint-a-node":
		var checks []CheckItem
		checks = append(checks, boolCheck(tainted != "",
			"A node carries a maintenance taint with the NoSchedule effect", taintDetail))
		// NoSchedule governs placement only — it never evicts what is already there.
		checks = append(checks, boolCheck(running == 3 && pending == 0,
			"All 3 instances are still Running — NoSchedule does not evict anything",
			fmt.Sprintf("%d running, %d pending", running, pending)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/tainted-node.txt")
		if !found {
			checks = append(checks, noItem("/root/tainted-node.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/tainted-node.txt was written", "found"))
		checks = append(checks, boolCheck(tainted != "" && strings.Contains(body, tainted),
			"It names the node you tainted",
			fmt.Sprintf("file says %q, the tainted node is %q", firstLine(body), tainted)))
		return finish(checks), nil

	case "strand-an-instance":
		// The instance cannot be rescheduled: its local-path volume pins it to the node it
		// was on, and that node is now tainted.
		var ev struct {
			Items []struct {
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"items"`
		}
		_ = kubectlJSON(ctx, k3d, server, &ev, "get", "events", "--field-selector", "reason=FailedScheduling")
		untolerated := false
		for _, e := range ev.Items {
			if strings.Contains(e.Message, "untolerated taint") {
				untolerated = true
			}
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(pending == 1,
			"Exactly one instance is Pending, unable to be scheduled",
			fmt.Sprintf("%d pending, %d running", pending, running)))
		checks = append(checks, boolCheck(untolerated,
			"The scheduler blames an untolerated taint",
			detailOr("no FailedScheduling event mentions an untolerated taint", "FailedScheduling names the taint", !untolerated)))
		checks = append(checks, boolCheck(c.Status.ReadyInstances == 2,
			"The cluster is degraded but still serving on 2 of 3",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "tolerate-it":
		var checks []CheckItem
		checks = append(checks, boolCheck(tolerated,
			"The Cluster declares a toleration for the maintenance taint",
			detailOr("spec.affinity.tolerations names no maintenance key",
				fmt.Sprintf("%d toleration(s) declared", len(spec.Spec.Affinity.Tolerations)), !tolerated)))
		checks = append(checks, boolCheck(tainted != "",
			"The node is still tainted — the toleration is what changed, not the node", taintDetail))
		healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
		checks = append(checks, boolCheck(healthy,
			"All 3 instances are scheduled and the cluster is healthy again",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-taints-tolerations", taskID)
}

/* ---- Labs 44–49: pod scheduling, and the metadata on the objects ---- */

// instancePod is one instance Pod as the scheduling and metadata labs read it. The leaner
// podList above carries none of what they grade on: the metadata the operator writes, the
// placement it asked for, the resources it requested, and when this particular Pod came
// into existence — which is the only honest way to tell a rebuilt Pod from a surviving one.
type instancePod struct {
	Metadata struct {
		Name              string            `json:"name"`
		Labels            map[string]string `json:"labels"`
		Annotations       map[string]string `json:"annotations"`
		CreationTimestamp time.Time         `json:"creationTimestamp"`
	} `json:"metadata"`
	Spec struct {
		NodeName     string            `json:"nodeName"`
		NodeSelector map[string]string `json:"nodeSelector"`
		Affinity     podAffinity       `json:"affinity"`
		Containers   []struct {
			Name      string `json:"name"`
			Resources struct {
				Requests map[string]string `json:"requests"`
				Limits   map[string]string `json:"limits"`
			} `json:"resources"`
		} `json:"containers"`
	} `json:"spec"`
	Status struct {
		Phase             string `json:"phase"`
		PodIP             string `json:"podIP"`
		ContainerStatuses []struct {
			Ready        bool `json:"ready"`
			RestartCount int  `json:"restartCount"`
		} `json:"containerStatuses"`
	} `json:"status"`
}

// podAffinity is only ever read for its topology key — the one field of the generated rule
// these labs ask about, and the one the Cluster spec does not show until it is overridden.
type podAffinity struct {
	PodAntiAffinity struct {
		Preferred []struct {
			Weight          int `json:"weight"`
			PodAffinityTerm struct {
				TopologyKey string `json:"topologyKey"`
			} `json:"podAffinityTerm"`
		} `json:"preferredDuringSchedulingIgnoredDuringExecution"`
		Required []struct {
			TopologyKey string `json:"topologyKey"`
		} `json:"requiredDuringSchedulingIgnoredDuringExecution"`
	} `json:"podAntiAffinity"`
}

// topologyKey returns the key the generated anti-affinity rule spreads on, whichever of the
// two forms the operator wrote, and "" if there is no rule at all.
func (a podAffinity) topologyKey() string {
	for _, p := range a.PodAntiAffinity.Preferred {
		if p.PodAffinityTerm.TopologyKey != "" {
			return p.PodAffinityTerm.TopologyKey
		}
	}
	for _, r := range a.PodAntiAffinity.Required {
		if r.TopologyKey != "" {
			return r.TopologyKey
		}
	}
	return ""
}

func (p instancePod) ready() bool {
	for _, cs := range p.Status.ContainerStatuses {
		if cs.Ready {
			return true
		}
	}
	return false
}

func (p instancePod) restarts() int {
	n := 0
	for _, cs := range p.Status.ContainerStatuses {
		n += cs.RestartCount
	}
	return n
}

// requestedMemory is what the postgres container asks for, or "" when nothing was requested.
func (p instancePod) requestedMemory() string {
	for _, c := range p.Spec.Containers {
		if c.Name == "postgres" {
			return c.Resources.Requests["memory"]
		}
	}
	return ""
}

// readInstancePods lists a cluster's instance Pods — the real instances only, since the
// short-lived initdb and join Jobs carry the same cluster label but not the instance role.
func readInstancePods(ctx context.Context, k3d *K3D, server, cluster string) ([]instancePod, error) {
	var list struct {
		Items []instancePod `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "pods", "-l", "cnpg.io/podRole=instance,cnpg.io/cluster="+cluster); err != nil {
		return nil, err
	}
	sort.Slice(list.Items, func(i, j int) bool {
		return list.Items[i].Metadata.Name < list.Items[j].Metadata.Name
	})
	return list.Items, nil
}

func instanceByName(pods []instancePod, name string) (instancePod, bool) {
	for _, p := range pods {
		if p.Metadata.Name == name {
			return p, true
		}
	}
	return instancePod{}, false
}

// nodesUsed counts how many distinct nodes the instances are spread over, which is what
// "one instance per node" means when it is graded rather than eyeballed.
func nodesUsed(pods []instancePod) int {
	seen := map[string]bool{}
	for _, p := range pods {
		if p.Spec.NodeName != "" {
			seen[p.Spec.NodeName] = true
		}
	}
	return len(seen)
}

func runningCount(pods []instancePod) int {
	n := 0
	for _, p := range pods {
		if p.Status.Phase == "Running" {
			n++
		}
	}
	return n
}

// clusterAffinity is the Cluster's own scheduling block. podAntiAffinityType is defaulted
// into it by the operator's webhook — it reads "preferred" on a Cluster nobody has touched —
// while topologyKey stays empty until somebody sets it.
type clusterAffinity struct {
	NodeSelector        map[string]string `json:"nodeSelector"`
	PodAntiAffinityType string            `json:"podAntiAffinityType"`
	TopologyKey         string            `json:"topologyKey"`
}

func readClusterAffinity(ctx context.Context, k3d *K3D, server, cluster string) (clusterAffinity, error) {
	var c struct {
		Spec struct {
			Affinity clusterAffinity `json:"affinity"`
		} `json:"spec"`
	}
	err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster)
	return c.Spec.Affinity, err
}

// failedSchedulingSaying looks for a FailedScheduling event whose message contains needle,
// and returns that message. The scheduler's own words are the evidence for every "and here
// is why it would not schedule" objective in these labs — nothing else records the reason
// once the Pod has been placed after all.
func failedSchedulingSaying(ctx context.Context, k3d *K3D, server, needle string) (string, bool) {
	var ev struct {
		Items []struct {
			Message string `json:"message"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &ev, "get", "events", "--field-selector", "reason=FailedScheduling"); err != nil {
		return "", false
	}
	for _, e := range ev.Items {
		if strings.Contains(e.Message, needle) {
			return firstLine(e.Message), true
		}
	}
	return "", false
}

// metaList reads just the metadata of a set of objects — enough for every "did this label
// reach everything the operator generated" check.
type metaList struct {
	Items []struct {
		Metadata struct {
			Name        string            `json:"name"`
			Labels      map[string]string `json:"labels"`
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
	} `json:"items"`
}

func readMeta(ctx context.Context, k3d *K3D, server, kind string, args ...string) metaList {
	var list metaList
	_ = kubectlJSON(ctx, k3d, server, &list, append([]string{"get", kind}, args...)...)
	return list
}

// everyItemHasLabel reports whether every object in the list carries key=value, and how many
// did — a count is what makes a failed check readable ("2 of 3").
func (m metaList) everyItemHasLabel(key, value string) (bool, int) {
	n := 0
	for _, it := range m.Items {
		if it.Metadata.Labels[key] == value {
			n++
		}
	}
	return len(m.Items) > 0 && n == len(m.Items), n
}

func (m metaList) everyItemHasAnnotation(key, value string) (bool, int) {
	n := 0
	for _, it := range m.Items {
		if it.Metadata.Annotations[key] == value {
			n++
		}
	}
	return len(m.Items) > 0 && n == len(m.Items), n
}

// execInPod runs one command inside an instance Pod's postgres container. The multi-arch lab
// grades what the *image* reports about itself, which only the image can answer.
func execInPod(ctx context.Context, docker *Docker, server, pod string, cmd ...string) (string, bool) {
	full := append([]string{"kubectl", "exec", pod, "-c", "postgres", "--"}, cmd...)
	res, err := docker.ExecRoot(ctx, server, full, []string{"KUBECONFIG=" + k3dKubeconfig})
	if err != nil || res.ExitCode != 0 {
		return "", false
	}
	return strings.TrimSpace(res.Stdout), true
}

/* ---- Lab 44: Node Selectors and Pod Anti-Affinity ---- */

func checkNodeSelector(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods, err := readInstancePods(ctx, k3d, server, cluster)
	if err != nil {
		return CheckResult{}, err
	}
	affinity, err := readClusterAffinity(ctx, k3d, server, cluster)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	placement := fmt.Sprintf("%d Running across %d node(s), %s", runningCount(pods), nodesUsed(pods), c.Status.Phase)

	switch taskID {
	case "read-defaults":
		var checks []CheckItem
		checks = append(checks, boolCheck(runningCount(pods) == 3 && nodesUsed(pods) == 3,
			"All 3 instances are Running, one on each node", placement))
		checks = append(checks, boolCheck(affinity.PodAntiAffinityType == "preferred",
			"The Cluster asks for preferred anti-affinity — a value nobody wrote",
			detailOr("spec.affinity.podAntiAffinityType is "+affinity.PodAntiAffinityType,
				"podAntiAffinityType: preferred", affinity.PodAntiAffinityType != "preferred")))

		// Read off a Pod, not off the Cluster: the topology key the rule actually uses is not
		// in the spec until somebody overrides it.
		key := ""
		if len(pods) > 0 {
			key = pods[0].Spec.Affinity.topologyKey()
		}
		body, found := readFileAnyNode(ctx, docker, a, "/root/topology-key.txt")
		if !found {
			checks = append(checks, noItem("/root/topology-key.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/topology-key.txt was written", "found"))
		checks = append(checks, boolCheck(key != "" && strings.Contains(body, key),
			"It names the topology key the generated rule spreads on",
			fmt.Sprintf("file says %q, the rule uses %q", firstLine(body), key)))
		return finish(checks), nil

	case "node-selector":
		var checks []CheckItem
		checks = append(checks, boolCheck(len(affinity.NodeSelector) > 0,
			"The Cluster declares a nodeSelector",
			detailOr("spec.affinity.nodeSelector is empty",
				fmt.Sprintf("%v", affinity.NodeSelector), len(affinity.NodeSelector) == 0)))

		stamped := len(pods) > 0
		for _, p := range pods {
			for k, v := range affinity.NodeSelector {
				if p.Spec.NodeSelector[k] != v {
					stamped = false
				}
			}
		}
		checks = append(checks, boolCheck(stamped && len(affinity.NodeSelector) > 0,
			"Every instance Pod carries it, written there by the operator",
			detailOr("at least one Pod does not carry the selector", "all instance Pods carry it", !stamped)))

		msg, sawIt := failedSchedulingSaying(ctx, k3d, server, "didn't match Pod's node affinity/selector")
		checks = append(checks, boolCheck(sawIt,
			"The scheduler refused a Pod for not matching it",
			detailOr("no FailedScheduling event blames the node selector", msg, !sawIt)))
		checks = append(checks, boolCheck(healthy && runningCount(pods) == 3,
			"All 3 instances are Running again and the cluster is healthy", placement))
		return finish(checks), nil

	case "required-anti-affinity":
		var checks []CheckItem
		checks = append(checks, boolCheck(affinity.PodAntiAffinityType == "required",
			"Anti-affinity is a requirement now, not a preference",
			detailOr("podAntiAffinityType is "+affinity.PodAntiAffinityType,
				"podAntiAffinityType: required", affinity.PodAntiAffinityType != "required")))

		msg, sawIt := failedSchedulingSaying(ctx, k3d, server, "didn't match pod anti-affinity rules")
		checks = append(checks, boolCheck(sawIt,
			"The scheduler refused a Pod for not matching pod anti-affinity rules",
			detailOr("no FailedScheduling event blames the anti-affinity rule", msg, !sawIt)))
		checks = append(checks, boolCheck(affinity.TopologyKey == "kubernetes.io/hostname",
			"The topology key is back to kubernetes.io/hostname",
			detailOr("topologyKey is "+affinity.TopologyKey, affinity.TopologyKey,
				affinity.TopologyKey != "kubernetes.io/hostname")))
		checks = append(checks, boolCheck(healthy && nodesUsed(pods) == 3,
			"All 3 instances are Running again, one per node", placement))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-node-selector", taskID)
}

/* ---- Lab 45: PodSpec Drift Detection ---- */

// recordedPodSpec parses the cnpg.io/podSpec annotation — the operator's own record of the
// Pod it generated, and the thing it compares against to decide a Pod has drifted.
type recordedPodSpec struct {
	TerminationGracePeriodSeconds *int `json:"terminationGracePeriodSeconds"`
	Containers                    []struct {
		Name      string `json:"name"`
		Resources struct {
			Requests map[string]string `json:"requests"`
			Limits   map[string]string `json:"limits"`
		} `json:"resources"`
	} `json:"containers"`
}

func recordedSpecOf(p instancePod) (recordedPodSpec, bool) {
	raw := p.Metadata.Annotations["cnpg.io/podSpec"]
	if raw == "" {
		return recordedPodSpec{}, false
	}
	var spec recordedPodSpec
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		return recordedPodSpec{}, false
	}
	return spec, len(spec.Containers) > 0
}

func (r recordedPodSpec) requestedMemory() string {
	for _, c := range r.Containers {
		if c.Name == "postgres" {
			return c.Resources.Requests["memory"]
		}
	}
	return ""
}

func checkPodSpecDrift(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const wantMemory = "512Mi"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods, err := readInstancePods(ctx, k3d, server, cluster)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3

	switch taskID {
	case "read-the-record":
		var checks []CheckItem
		recorded, grace := 0, 0
		for _, p := range pods {
			if spec, ok := recordedSpecOf(p); ok {
				recorded++
				if spec.TerminationGracePeriodSeconds != nil {
					grace = *spec.TerminationGracePeriodSeconds
				}
			}
		}
		checks = append(checks, boolCheck(recorded == 3,
			"All 3 instance Pods carry the cnpg.io/podSpec annotation",
			fmt.Sprintf("%d of %d Pods have a readable recorded spec", recorded, len(pods))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/grace-period.txt")
		if !found {
			checks = append(checks, noItem("/root/grace-period.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/grace-period.txt was written", "found"))
		want := strconv.Itoa(grace)
		checks = append(checks, boolCheck(grace > 0 && strings.Contains(body, want),
			"It names the shutdown grace period the operator recorded",
			fmt.Sprintf("file says %q, the recorded spec says %s", firstLine(body), want)))
		return finish(checks), nil

	case "cause-drift":
		var spec struct {
			Spec struct {
				Resources struct {
					Requests map[string]string `json:"requests"`
					Limits   map[string]string `json:"limits"`
				} `json:"resources"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", cluster); err != nil {
			return CheckResult{}, err
		}
		asked := spec.Spec.Resources.Requests["memory"]

		live, recorded := 0, 0
		for _, p := range pods {
			if p.requestedMemory() == wantMemory {
				live++
			}
			if rec, ok := recordedSpecOf(p); ok && rec.requestedMemory() == wantMemory {
				recorded++
			}
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(asked == wantMemory,
			"The Cluster asks for "+wantMemory+" of memory",
			detailOr("spec.resources.requests.memory is "+detailOr("unset", asked, asked == ""), asked, asked != wantMemory)))
		checks = append(checks, boolCheck(live == 3,
			"All 3 instance Pods are running with it",
			fmt.Sprintf("%d of %d Pods request %s", live, len(pods), wantMemory)))
		checks = append(checks, boolCheck(recorded == 3,
			"The recorded podSpec was rewritten to match",
			fmt.Sprintf("%d of %d recorded specs request %s", recorded, len(pods), wantMemory)))
		// The rollout replaces every Pod, primary included — but it does not hand the role to
		// somebody else, which is what "restarted without a switchover" in the phase means.
		same := a.baselinePrimary() != "" && c.Status.CurrentPrimary == a.baselinePrimary()
		checks = append(checks, boolCheck(same && healthy,
			"The same instance is still primary — the roll never switched over",
			fmt.Sprintf("primary is %s, was %s; %s", c.Status.CurrentPrimary, a.baselinePrimary(), c.Status.Phase)))
		return finish(checks), nil

	case "tamper":
		primary, ok := instanceByName(pods, c.Status.CurrentPrimary)
		rebuilt, rebuiltName := false, ""
		for _, p := range pods {
			if !ok || p.Metadata.Name == primary.Metadata.Name {
				continue
			}
			if p.Metadata.CreationTimestamp.After(primary.Metadata.CreationTimestamp) {
				rebuilt, rebuiltName = true, p.Metadata.Name
			}
		}
		restored := 0
		for _, p := range pods {
			if _, ok := recordedSpecOf(p); ok {
				restored++
			}
		}

		var checks []CheckItem
		// The roll in the previous objective left the primary's Pod the youngest of the three,
		// so a replica younger than it can only have been rebuilt afterwards.
		checks = append(checks, boolCheck(rebuilt,
			"The replica you tampered with was rebuilt",
			detailOr("no replica Pod is younger than the primary's", rebuiltName+" is younger than "+c.Status.CurrentPrimary, !rebuilt)))
		checks = append(checks, boolCheck(restored == 3,
			"Its cnpg.io/podSpec annotation is a generated Pod spec again",
			fmt.Sprintf("%d of %d Pods carry a readable recorded spec", restored, len(pods))))
		checks = append(checks, boolCheck(healthy,
			"The cluster is healthy, with all 3 instances back",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-podspec-drift", taskID)
}

/* ---- Lab 46: In-Place Instance Manager Upgrades ---- */

// operatorState is the three facts the in-place upgrade lab keeps comparing: which version
// the operator Deployment runs, whether it is serving, and when its Pod started — the last
// of which is the reference point for "the instances were never recreated".
type operatorState struct {
	image     string
	version   string
	available bool
	podStart  time.Time
}

func readOperatorState(ctx context.Context, k3d *K3D, server string) operatorState {
	var st operatorState
	var deploy struct {
		Spec struct {
			Template struct {
				Spec struct {
					Containers []struct {
						Image string `json:"image"`
					} `json:"containers"`
				} `json:"spec"`
			} `json:"template"`
		} `json:"spec"`
		Status struct {
			ReadyReplicas int `json:"readyReplicas"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &deploy, "-n", cnpgNamespace, "get", "deploy", cnpgOperatorDeploy); err == nil {
		if len(deploy.Spec.Template.Spec.Containers) > 0 {
			st.image = deploy.Spec.Template.Spec.Containers[0].Image
			if i := strings.LastIndex(st.image, ":"); i >= 0 {
				st.version = st.image[i+1:]
			}
		}
		st.available = deploy.Status.ReadyReplicas >= 1
	}
	var pods struct {
		Items []struct {
			Metadata struct {
				CreationTimestamp time.Time `json:"creationTimestamp"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &pods, "-n", cnpgNamespace, "get", "pods",
		"-l", "app.kubernetes.io/name=cloudnative-pg"); err == nil {
		for _, p := range pods.Items {
			if p.Metadata.CreationTimestamp.After(st.podStart) {
				st.podStart = p.Metadata.CreationTimestamp
			}
		}
	}
	return st
}

// instanceVersions counts how many instance Pods report version v in the annotation the
// operator stamps on them, cnpg.io/operatorVersion.
func instanceVersions(pods []instancePod, v string) (int, string) {
	n := 0
	var seen []string
	for _, p := range pods {
		got := p.Metadata.Annotations["cnpg.io/operatorVersion"]
		if got == v {
			n++
		}
		seen = append(seen, p.Metadata.Name+"="+detailOr("(none)", got, got == ""))
	}
	return n, strings.Join(seen, " ")
}

func checkInPlaceUpgrade(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods, err := readInstancePods(ctx, k3d, server, cluster)
	if err != nil {
		return CheckResult{}, err
	}
	op := readOperatorState(ctx, k3d, server)

	// Every instance Pod older than the operator's own Pod is the proof that an operator
	// change did not take the database with it.
	untouched, oldest := true, 0
	for _, p := range pods {
		if !op.podStart.IsZero() && p.Metadata.CreationTimestamp.Before(op.podStart) {
			oldest++
		} else {
			untouched = false
		}
	}
	untouched = untouched && len(pods) == 3
	survivedDetail := fmt.Sprintf("%d of %d instance Pods predate the current operator Pod", oldest, len(pods))

	switch taskID {
	case "record-the-version":
		var checks []CheckItem
		checks = append(checks, boolCheck(op.version == cnpgPreviousVersion,
			"The operator is running v"+cnpgPreviousVersion,
			detailOr("operator image is "+op.image, op.image, op.version != cnpgPreviousVersion)))
		n, detail := instanceVersions(pods, cnpgPreviousVersion)
		checks = append(checks, boolCheck(n == 3,
			"All 3 instances report the same version in cnpg.io/operatorVersion", detail))

		body, found := readFileAnyNode(ctx, docker, a, "/root/before.txt")
		if !found {
			checks = append(checks, noItem("/root/before.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/before.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, cnpgPreviousVersion),
			"It names the version the instances report",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "enable-in-place":
		// The key is INPLACE, not IN_PLACE. Spelling it the other way is accepted silently —
		// the ConfigMap is read, the unknown key ignored, and the operator logs the setting
		// still false — which is why the lab has the learner read it back out of the log.
		var cm struct {
			Metadata struct {
				CreationTimestamp time.Time `json:"creationTimestamp"`
			} `json:"metadata"`
			Data map[string]string `json:"data"`
		}
		cmErr := kubectlJSON(ctx, k3d, server, &cm, "-n", cnpgNamespace, "get", "configmap", "cnpg-controller-manager-config")
		flag := strings.ToLower(strings.TrimSpace(cm.Data["ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES"]))
		// Not-before rather than after: Kubernetes creation timestamps have one-second
		// resolution, and creating the ConfigMap and restarting the operator in the same
		// command lands both in the same second — which is exactly what the lab's own
		// instructions do.
		readIt := cmErr == nil && !cm.Metadata.CreationTimestamp.IsZero() &&
			!op.podStart.IsZero() && !op.podStart.Before(cm.Metadata.CreationTimestamp)

		var checks []CheckItem
		checks = append(checks, boolCheck(flag == "true",
			"The operator ConfigMap switches in-place instance manager updates on",
			detailOr("ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES is "+detailOr("absent", flag, flag == ""),
				"ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true", flag != "true")))
		checks = append(checks, boolCheck(readIt,
			"And the operator has restarted since, so it has read it",
			detailOr("the operator Pod is older than the ConfigMap — it is still running on the old configuration",
				"operator Pod started after the ConfigMap was created", !readIt)))
		n, detail := instanceVersions(pods, cnpgPreviousVersion)
		checks = append(checks, boolCheck(n == 3,
			"The database is untouched and still reports v"+cnpgPreviousVersion, detail))
		return finish(checks), nil

	case "upgrade-in-place":
		restarted := 0
		for _, p := range pods {
			restarted += p.restarts()
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(op.version == cnpgVersion && op.available,
			"The operator is now v"+cnpgVersion+" and serving",
			fmt.Sprintf("%s, ready=%v", op.image, op.available)))
		n, detail := instanceVersions(pods, cnpgVersion)
		checks = append(checks, boolCheck(n == 3,
			"Every instance reports v"+cnpgVersion+" too", detail))
		checks = append(checks, boolCheck(untouched && restarted == 0,
			"Without a single Pod being recreated or a container restarted",
			survivedDetail+fmt.Sprintf(", %d container restarts", restarted)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"And the cluster never left its healthy state",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-in-place-upgrade", taskID)
}

/* ---- Lab 47: Multi-Arch Images ---- */

// nodeArchitecture is what every check in the multi-arch lab compares against: the
// architecture the nodes report, which is whatever the machine running this lab is.
func nodeArchitecture(ctx context.Context, k3d *K3D, server string) (string, int, int) {
	var nl struct {
		Items []struct {
			Status struct {
				NodeInfo struct {
					Architecture string `json:"architecture"`
				} `json:"nodeInfo"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &nl, "get", "nodes"); err != nil {
		return "", 0, 0
	}
	counts := map[string]int{}
	for _, n := range nl.Items {
		counts[n.Status.NodeInfo.Architecture]++
	}
	best, n := "", 0
	for arch, c := range counts {
		if c > n {
			best, n = arch, c
		}
	}
	return best, n, len(nl.Items)
}

func checkMultiArch(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	arch, same, total := nodeArchitecture(ctx, k3d, server)

	switch taskID {
	case "what-you-run":
		var checks []CheckItem
		checks = append(checks, boolCheck(arch != "" && same == total && total == 3,
			"All 3 nodes report the same architecture",
			fmt.Sprintf("%d of %d nodes are %s", same, total, detailOr("unknown", arch, arch == ""))))

		reported, ok := execInPod(ctx, docker, server, "pg-cluster-1", "dpkg", "--print-architecture")
		checks = append(checks, boolCheck(ok && reported == arch,
			"The PostgreSQL image running on them reports it too",
			fmt.Sprintf("the container says %q, the nodes say %q", reported, arch)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/arch.txt")
		if !found {
			checks = append(checks, noItem("/root/arch.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/arch.txt was written", "found"))
		checks = append(checks, boolCheck(arch != "" && strings.Contains(body, arch),
			"It names your nodes' architecture",
			fmt.Sprintf("file says %q, the nodes are %q", firstLine(body), arch)))
		return finish(checks), nil

	case "ask-the-registry":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/image-digest.txt")
		if !found {
			checks = append(checks, noItem("/root/image-digest.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/image-digest.txt was written", "found"))
		digest := firstLine(body)

		// The same walk the learner did, done server-side: a digest is only worth anything if
		// the registry really publishes it for this tag.
		platforms, err := indexPlatforms(ctx, cnpgPostgresImage)
		if err != nil {
			checks = append(checks, noItem("It is a digest the registry publishes for this tag", "could not read the registry: "+err.Error()))
			checks = append(checks, noItem("And it is the one built for your architecture", "not checked"))
			return finish(checks), nil
		}
		known := false
		for _, d := range platforms {
			if d == digest {
				known = true
			}
		}
		checks = append(checks, boolCheck(known,
			"It is a digest the registry publishes for this tag",
			fmt.Sprintf("file says %q; the index lists %d linux platforms", digest, len(platforms))))
		checks = append(checks, boolCheck(digest != "" && digest == platforms[arch],
			"And it is the one built for your architecture",
			fmt.Sprintf("linux/%s is %s", arch, platforms[arch])))
		return finish(checks), nil

	case "follow-the-digest":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/config-digest.txt")
		if !found {
			checks = append(checks, noItem("/root/config-digest.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/config-digest.txt was written", "found"))
		recorded := firstLine(body)

		platforms, err := indexPlatforms(ctx, cnpgPostgresImage)
		if err != nil {
			checks = append(checks, noItem("The manifest for your architecture names it as its config blob", "could not read the registry: "+err.Error()))
			checks = append(checks, noItem("And that blob says the image was built for your architecture", "not checked"))
			return finish(checks), nil
		}
		config, err := manifestConfigDigest(ctx, cnpgPostgresImage, platforms[arch])
		if err != nil {
			checks = append(checks, noItem("The manifest for your architecture names it as its config blob", "could not read the manifest: "+err.Error()))
			checks = append(checks, noItem("And that blob says the image was built for your architecture", "not checked"))
			return finish(checks), nil
		}
		checks = append(checks, boolCheck(recorded == config,
			"The manifest for your architecture names it as its config blob",
			fmt.Sprintf("file says %q, the manifest names %q", recorded, config)))

		blobArch, blobOS, err := blobPlatform(ctx, cnpgPostgresImage, config)
		checks = append(checks, boolCheck(err == nil && blobArch == arch && blobOS == "linux",
			"And that blob says the image was built for your architecture",
			fmt.Sprintf("the config blob says %s/%s, the nodes are linux/%s", blobOS, blobArch, arch)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-multi-arch", taskID)
}

/* ---- Lab 48: Cluster Labels and Annotations ---- */

// inheritedMetadata is spec.inheritedMetadata: labels and annotations the operator copies
// onto every object it generates for this Cluster.
type inheritedMetadata struct {
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
}

func readInheritedMetadata(ctx context.Context, k3d *K3D, server, cluster string) inheritedMetadata {
	var c struct {
		Spec struct {
			InheritedMetadata inheritedMetadata `json:"inheritedMetadata"`
		} `json:"spec"`
	}
	_ = kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster)
	return c.Spec.InheritedMetadata
}

func checkInheritedMetadata(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const selector = "cnpg.io/cluster=pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	inherited := readInheritedMetadata(ctx, k3d, server, cluster)
	pods := readMeta(ctx, k3d, server, "pods", "-l", "cnpg.io/podRole=instance,"+selector)
	claims := readMeta(ctx, k3d, server, "pvc", "-l", selector)
	services := readMeta(ctx, k3d, server, "svc", "-l", selector)
	// By selector, not by name: `kubectl get secret <name> -o json` returns the object rather
	// than a List, so metaList.Items would come back empty and every check over it would fail
	// with a confusing "0 of 0".
	secrets := readMeta(ctx, k3d, server, "secret", "-l", selector)

	switch taskID {
	case "inherit-them":
		team := inherited.Labels["team"]
		centre := inherited.Labels["cost-centre"]
		owner := inherited.Annotations["owner"]

		podsLabelled, podCount := pods.everyItemHasLabel("team", team)
		podsAnnotated, podAnnCount := pods.everyItemHasAnnotation("owner", owner)
		claimsLabelled, claimCount := claims.everyItemHasLabel("team", team)
		svcLabelled, svcCount := services.everyItemHasLabel("team", team)
		secretLabelled, secretCount := secrets.everyItemHasLabel("team", team)

		var checks []CheckItem
		checks = append(checks, boolCheck(team != "" && centre != "" && owner != "",
			"The Cluster asks for two labels and an annotation to be inherited",
			fmt.Sprintf("labels %v, annotations %v", inherited.Labels, inherited.Annotations)))
		checks = append(checks, boolCheck(team != "" && podsLabelled && podsAnnotated,
			"All 3 instance Pods carry both",
			fmt.Sprintf("%d of %d Pods have the label, %d have the annotation", podCount, len(pods.Items), podAnnCount)))
		checks = append(checks, boolCheck(team != "" && claimsLabelled,
			"So do their PersistentVolumeClaims",
			fmt.Sprintf("%d of %d claims", claimCount, len(claims.Items))))
		checks = append(checks, boolCheck(team != "" && svcLabelled && secretLabelled,
			"And the Services and the application Secret the operator generated",
			fmt.Sprintf("%d of %d Services, %d of %d Secrets", svcCount, len(services.Items), secretCount, len(secrets.Items))))
		return finish(checks), nil

	case "change-and-remove":
		_, stillInSpec := inherited.Labels["cost-centre"]
		team := inherited.Labels["team"]
		kept, keptCount := pods.everyItemHasLabel("cost-centre", "cc-4471")
		followed, followedCount := pods.everyItemHasLabel("team", team)
		claimsFollowed, claimsCount := claims.everyItemHasLabel("team", team)

		var checks []CheckItem
		checks = append(checks, boolCheck(!stillInSpec,
			"The Cluster no longer asks for cost-centre to be inherited",
			detailOr("spec.inheritedMetadata.labels still names it", "removed from the spec", stillInSpec)))
		checks = append(checks, boolCheck(kept,
			"The Pods still carry it — nothing takes an inherited label back",
			fmt.Sprintf("%d of %d Pods still labelled cost-centre=cc-4471", keptCount, len(pods.Items))))
		checks = append(checks, boolCheck(team != "" && followed && claimsFollowed,
			"While the team label's new value reached every Pod and claim",
			fmt.Sprintf("team=%s on %d of %d Pods and %d of %d claims", team, followedCount, len(pods.Items), claimsCount, len(claims.Items))))
		return finish(checks), nil

	case "override-what-the-operator-owns":
		_, stillOverridden := inherited.Labels["cnpg.io/instanceRole"]
		primaries := 0
		primaryName := ""
		for _, p := range pods.Items {
			if p.Metadata.Labels["cnpg.io/instanceRole"] == "primary" {
				primaries++
				primaryName = p.Metadata.Name
			}
		}
		ips, _ := serviceEndpointIPs(ctx, k3d, server, cluster+"-rw")

		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/readonly-error.txt")
		if !found {
			checks = append(checks, noItem("/root/readonly-error.txt was written", "file not found on any node"))
		} else {
			checks = append(checks, boolCheck(strings.Contains(body, "read-only transaction"),
				"/root/readonly-error.txt was written",
				fmt.Sprintf("file says %q", firstLine(body))))
		}
		checks = append(checks, boolCheck(!stillOverridden,
			"The Cluster no longer inherits cnpg.io/instanceRole",
			detailOr("spec.inheritedMetadata.labels still overrides it", "the override is gone", stillOverridden)))
		checks = append(checks, boolCheck(primaries == 1 && primaryName == c.Status.CurrentPrimary,
			"Exactly one Pod is labelled primary, and it is the real one",
			fmt.Sprintf("%d Pod(s) labelled primary, the cluster says %s", primaries, c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(len(ips) == 1,
			"The read-write Service is back to a single endpoint",
			fmt.Sprintf("%d ready endpoint(s): %v", len(ips), ips)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-inherited-metadata", taskID)
}

/* ---- Lab 49: Object Metadata ---- */

func checkObjectMetadata(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const selector = "cnpg.io/cluster=pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods := readMeta(ctx, k3d, server, "pods", "-l", "cnpg.io/podRole=instance,"+selector)
	claims := readMeta(ctx, k3d, server, "pvc", "-l", selector)
	services := readMeta(ctx, k3d, server, "svc", "-l", selector)
	// By selector, not by name: `kubectl get secret <name> -o json` returns the object rather
	// than a List, so metaList.Items would come back empty and every check over it would fail
	// with a confusing "0 of 0".
	secrets := readMeta(ctx, k3d, server, "secret", "-l", selector)

	switch taskID {
	case "one-selector":
		podsOK, podCount := pods.everyItemHasLabel("cnpg.io/cluster", cluster)
		claimsOK, claimCount := claims.everyItemHasLabel("cnpg.io/cluster", cluster)
		svcOK, svcCount := services.everyItemHasLabel("cnpg.io/cluster", cluster)
		secretOK, secretCount := secrets.everyItemHasLabel("cnpg.io/cluster", cluster)

		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/cluster-label.txt")
		if !found {
			checks = append(checks, noItem("/root/cluster-label.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/cluster-label.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "cnpg.io/cluster"),
			"It names the label every generated object carries",
			fmt.Sprintf("file says %q", firstLine(body))))
		checks = append(checks, boolCheck(podsOK && claimsOK,
			"The instance Pods and their claims all carry it",
			fmt.Sprintf("%d of %d Pods, %d of %d claims", podCount, len(pods.Items), claimCount, len(claims.Items))))
		checks = append(checks, boolCheck(svcOK && secretOK,
			"So do the Services and the application Secret",
			fmt.Sprintf("%d of %d Services, %d of %d Secrets", svcCount, len(services.Items), secretCount, len(secrets.Items))))
		return finish(checks), nil

	case "the-routing-table":
		var svc struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
				Spec struct {
					Selector map[string]string `json:"selector"`
				} `json:"spec"`
			} `json:"items"`
		}
		_ = kubectlJSON(ctx, k3d, server, &svc, "get", "svc", "-l", selector)
		rwSelector, roSelector := map[string]string{}, map[string]string{}
		for _, s := range svc.Items {
			switch s.Metadata.Name {
			case cluster + "-rw":
				rwSelector = s.Spec.Selector
			case cluster + "-ro":
				roSelector = s.Spec.Selector
			}
		}
		rwIPs, _ := serviceEndpointIPs(ctx, k3d, server, cluster+"-rw")
		roIPs, _ := serviceEndpointIPs(ctx, k3d, server, cluster+"-ro")

		primaryIP := ""
		instances, _ := readInstancePods(ctx, k3d, server, cluster)
		if p, ok := instanceByName(instances, c.Status.CurrentPrimary); ok {
			primaryIP = p.Status.PodIP
		}

		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/rw-selector.txt")
		if !found {
			checks = append(checks, noItem("/root/rw-selector.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/rw-selector.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "cnpg.io/instanceRole") && strings.Contains(body, "primary"),
			"It names the label the read-write Service selects on",
			fmt.Sprintf("file says %q", firstLine(body))))
		checks = append(checks, boolCheck(rwSelector["cnpg.io/instanceRole"] == "primary" &&
			len(rwIPs) == 1 && primaryIP != "" && rwIPs[0] == primaryIP,
			"The read-write Service resolves to exactly one Pod, the current primary",
			fmt.Sprintf("selector %v, endpoints %v, primary %s is %s", rwSelector, rwIPs, c.Status.CurrentPrimary, primaryIP)))
		checks = append(checks, boolCheck(roSelector["cnpg.io/instanceRole"] == "replica" && len(roIPs) == 2,
			"And the read-only Service to the two replicas",
			fmt.Sprintf("selector %v, %d endpoint(s)", roSelector, len(roIPs))))
		return finish(checks), nil

	case "who-owns-the-labels":
		mine, minePod := false, ""
		primaries, primaryName := 0, ""
		for _, p := range pods.Items {
			if p.Metadata.Labels["scratch"] == "mine" {
				mine, minePod = true, p.Metadata.Name
			}
			if p.Metadata.Labels["cnpg.io/instanceRole"] == "primary" {
				primaries++
				primaryName = p.Metadata.Name
			}
		}
		rwIPs, _ := serviceEndpointIPs(ctx, k3d, server, cluster+"-rw")

		var checks []CheckItem
		checks = append(checks, boolCheck(mine,
			"A label of your own is still on an instance Pod — the operator left it alone",
			detailOr("no instance Pod carries scratch=mine", minePod+" carries scratch=mine", !mine)))
		checks = append(checks, boolCheck(primaries == 1 && primaryName == c.Status.CurrentPrimary,
			"But cnpg.io/instanceRole agrees with the operator again",
			fmt.Sprintf("%d Pod(s) labelled primary, the cluster says %s", primaries, c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(len(rwIPs) == 1,
			"And the read-write Service still resolves to the primary alone",
			fmt.Sprintf("%d ready endpoint(s): %v", len(rwIPs), rwIPs)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-object-metadata", taskID)
}

/* ---- Labs 50–53: corruption, cloning and importing ---- */

// tableCount counts a table inside one instance, as the local superuser. It returns the whole
// result rather than just the number, because several of the checks below are about the read
// *failing* — a corrupt page is proved by the error, not by the count.
func tableCount(ctx context.Context, docker *Docker, server, pod, db, table string) sqlResult {
	res, err := psqlSuper(ctx, docker, server, pod, db, "SELECT count(*) FROM "+table+";")
	if err != nil {
		return sqlResult{stderr: err.Error(), code: -1}
	}
	return res
}

// countsOn reports the row count each of the named instances returns, and whether every one of
// them answered with want.
func countsOn(ctx context.Context, docker *Docker, server, db, table string, pods []string, want int) (bool, string) {
	all := true
	var parts []string
	for _, p := range pods {
		res := tableCount(ctx, docker, server, p, db, table)
		if !res.ok() {
			all = false
			parts = append(parts, p+"=error")
			continue
		}
		if res.count() != want {
			all = false
		}
		parts = append(parts, fmt.Sprintf("%s=%d", p, res.count()))
	}
	return all && len(pods) > 0, strings.Join(parts, " ")
}

// instanceNames lists a cluster's instance Pods by name.
func instanceNames(ctx context.Context, k3d *K3D, server, cluster string) []string {
	pods, err := readInstancePods(ctx, k3d, server, cluster)
	if err != nil {
		return nil
	}
	var out []string
	for _, p := range pods {
		out = append(out, p.Metadata.Name)
	}
	return out
}

// pvcVolume is the PersistentVolume a claim is bound to — the only way to tell a rebuilt
// instance from a restarted one, since the claim keeps its name either way.
func pvcVolume(ctx context.Context, k3d *K3D, server, claim string) string {
	res, err := k3d.Kubectl(ctx, server, "get", "pvc", claim, "-o", "jsonpath={.spec.volumeName}")
	if err != nil || res.ExitCode != 0 {
		return ""
	}
	return strings.TrimSpace(res.Stdout)
}

func secretExists(ctx context.Context, k3d *K3D, server, name string) bool {
	res, err := k3d.Kubectl(ctx, server, "get", "secret", name, "-o", "jsonpath={.metadata.name}")
	return err == nil && res.ExitCode == 0 && strings.TrimSpace(res.Stdout) != ""
}

// psqlAsUser connects from the lab's client Pod as a named role with an explicit password —
// which is how the import labs prove that a role's password did or did not come across.
func psqlAsUser(ctx context.Context, docker *Docker, server, host, user, password, db, sql string) sqlResult {
	res, err := runSQL(ctx, docker, server, []string{
		"kubectl", "exec", "psql-client", "--",
		"env", "PGPASSWORD=" + password,
		"psql", "-h", host, "-U", user, "-d", db, "-tAc", sql,
	})
	if err != nil {
		return sqlResult{stderr: err.Error(), code: -1}
	}
	return res
}

// databaseOwners maps database name to owner on one instance.
func databaseOwners(ctx context.Context, docker *Docker, server, pod string) map[string]string {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres",
		"SELECT datname || '|' || pg_get_userbyid(datdba) FROM pg_database WHERE datname NOT IN ('template0','template1');")
	out := map[string]string{}
	if err != nil || !res.ok() {
		return out
	}
	for _, line := range strings.Split(res.stdout, "\n") {
		name, owner := splitPipe(line)
		if name != "" {
			out[name] = owner
		}
	}
	return out
}

// roleLogin maps role name to whether it may log in, for the roles a lab cares about.
func roleLogin(ctx context.Context, docker *Docker, server, pod string) map[string]bool {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres",
		"SELECT rolname || '|' || rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%';")
	out := map[string]bool{}
	if err != nil || !res.ok() {
		return out
	}
	for _, line := range strings.Split(res.stdout, "\n") {
		name, canLogin := splitPipe(line)
		if name != "" {
			// Concatenating a boolean renders it as true/false, not as the t/f psql prints
			// in a table — which is a difference worth being explicit about.
			out[name] = strings.HasPrefix(canLogin, "t")
		}
	}
	return out
}

/* ---- Lab 50: Data Corruption ---- */

func checkDataCorruption(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods := instanceNames(ctx, k3d, server, cluster)
	damaged := a.baselinePrimary() // the instance that was primary when the environment was built
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3

	var others []string
	for _, p := range pods {
		if p != damaged {
			others = append(others, p)
		}
	}

	switch taskID {
	case "find-the-page":
		var checks []CheckItem
		checksums, _ := pgSetting(ctx, docker, server, c.Status.CurrentPrimary, "data_checksums")
		checks = append(checks, boolCheck(checksums == "on",
			"Data checksums are on", "data_checksums is "+detailOr("unreadable", checksums, checksums == "")))

		ok, detail := countsOn(ctx, docker, server, "app", "ledger", pods, 2000)
		checks = append(checks, boolCheck(ok, "All 3 instances return every row of the ledger table", detail))

		path, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT pg_relation_filepath('ledger');")
		want := ""
		if err == nil && path.ok() {
			want = strings.TrimSpace(path.stdout)
		}
		body, found := readFileAnyNode(ctx, docker, a, "/root/ledger-path.txt")
		if !found {
			checks = append(checks, noItem("/root/ledger-path.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/ledger-path.txt was written", "found"))
		checks = append(checks, boolCheck(want != "" && strings.Contains(body, want),
			"It names the file the table lives in",
			fmt.Sprintf("file says %q, the table is in %q", firstLine(body), want)))
		return finish(checks), nil

	case "corrupt-and-count":
		var checks []CheckItem
		if damaged == "" {
			return CheckResult{}, fmt.Errorf("this attempt has no baseline primary recorded")
		}
		// The read is the evidence. A page whose checksum does not match is refused outright,
		// and the refusal names the block and the file.
		read := tableCount(ctx, docker, server, damaged, "app", "ledger")
		broke := !read.ok() && strings.Contains(read.stderr, "invalid page in block")
		checks = append(checks, boolCheck(broke,
			"The instance you damaged cannot read the block",
			detailOr(fmt.Sprintf("%s answered %q", damaged, firstLine(detailOr(read.stdout, read.stderr, read.stderr != ""))),
				firstLine(read.stderr), !broke)))

		failures := 0
		if res, err := psqlSuper(ctx, docker, server, damaged, "postgres",
			"SELECT checksum_failures FROM pg_stat_database WHERE datname = 'app';"); err == nil {
			failures = res.count()
		}
		checks = append(checks, boolCheck(failures > 0,
			"Its checksum failure counter has recorded it",
			fmt.Sprintf("pg_stat_database.checksum_failures is %d", failures)))

		checks = append(checks, boolCheck(healthy,
			"The cluster still reports healthy — nothing else noticed",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))

		ok, detail := countsOn(ctx, docker, server, "app", "ledger", others, 2000)
		checks = append(checks, boolCheck(ok, "The other two instances still return every row", detail))
		return finish(checks), nil

	case "discard-the-copy":
		var checks []CheckItem
		moved := damaged != "" && c.Status.CurrentPrimary != damaged
		checks = append(checks, boolCheck(moved,
			"A different instance is primary now",
			fmt.Sprintf("primary is %s, the damaged instance was %s", c.Status.CurrentPrimary, damaged)))

		volume := pvcVolume(ctx, k3d, server, damaged)
		replaced := volume != "" && a.baselineVolume() != "" && volume != a.baselineVolume()
		checks = append(checks, boolCheck(replaced,
			"The damaged instance is on a different volume",
			fmt.Sprintf("%s is on %s, was on %s", damaged, detailOr("(gone)", volume, volume == ""), a.baselineVolume())))

		checks = append(checks, boolCheck(healthy,
			"All 3 instances are ready and the cluster is healthy",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))

		ok, detail := countsOn(ctx, docker, server, "app", "ledger", pods, 2000)
		checks = append(checks, boolCheck(ok, "Every row is back, on all three instances", detail))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-data-corruption", taskID)
}

/* ---- Lab 51: Cloning with pg_basebackup ---- */

func checkBasebackupClone(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const source = "pg-cluster"
	const clone = "pg-clone"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	sourceHealthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	clonePhase, cloneReady, cloneExists := clusterPhase(ctx, k3d, server, clone)
	cloneHealthy := cloneExists && clonePhase == "Cluster in healthy state" && cloneReady == 1

	switch taskID {
	case "read-the-source":
		var checks []CheckItem
		res := tableCount(ctx, docker, server, c.Status.CurrentPrimary, "app", "notes")
		checks = append(checks, boolCheck(sourceHealthy && res.ok() && res.count() == 50,
			"The source is healthy and the notes table has 50 rows",
			fmt.Sprintf("%s, %d/3 ready, %d rows", c.Status.Phase, c.Status.ReadyInstances, res.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/source-rows.txt")
		if !found {
			checks = append(checks, noItem("/root/source-rows.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/source-rows.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "50"),
			"It records the row count you read", fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "clone-it":
		var checks []CheckItem
		checks = append(checks, boolCheck(cloneHealthy,
			"A second Cluster named pg-clone reports healthy",
			detailOr("pg-clone does not exist yet", clonePhase+fmt.Sprintf(", %d/1 ready", cloneReady), !cloneExists)))

		recovery, _ := psqlSuper(ctx, docker, server, clone+"-1", "postgres", "SELECT pg_is_in_recovery();")
		standing := strings.TrimSpace(recovery.stdout) == "f"
		checks = append(checks, boolCheck(standing,
			"It is a read-write primary, not a standby",
			fmt.Sprintf("pg_is_in_recovery() is %q", strings.TrimSpace(recovery.stdout))))

		rows := tableCount(ctx, docker, server, clone+"-1", "app", "notes")
		checks = append(checks, boolCheck(rows.ok() && rows.count() == 50,
			"It carries the 50 rows the source had when the copy was taken",
			fmt.Sprintf("%d rows on the clone", rows.count())))

		// A physical copy brings the source's roles, passwords included — and then the
		// operator resets the application user to the credentials it manages for this new
		// cluster, so the password that worked a minute ago on the source does not work here.
		sourcePassword, err := appPassword(ctx, k3d, server, source)
		refused := false
		detail := "could not read the source's app secret"
		if err == nil {
			try := psqlAsUser(ctx, docker, server, clone+"-rw", "app", sourcePassword, "app", "SELECT 1;")
			refused = !try.ok() && strings.Contains(try.stderr, "password authentication failed")
			detail = detailOr("the source's password still works on the clone", firstLine(try.stderr), !refused)
		}
		checks = append(checks, boolCheck(refused,
			"And its own application credentials — the source password is refused", detail))
		return finish(checks), nil

	case "prove-independence":
		var checks []CheckItem
		onClone, _ := psqlSuper(ctx, docker, server, clone+"-1", "app",
			"SELECT count(*) FROM notes WHERE entry LIKE '%clone%';")
		onSource, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT count(*) FROM notes WHERE entry LIKE '%clone%';")
		checks = append(checks, boolCheck(onClone.count() > 0 && onSource.count() == 0,
			"The row you wrote on the clone is not on the source",
			fmt.Sprintf("%d on the clone, %d on the source", onClone.count(), onSource.count())))

		srcRow, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT count(*) FROM notes WHERE entry LIKE '%source%';")
		cloneRow, _ := psqlSuper(ctx, docker, server, clone+"-1", "app",
			"SELECT count(*) FROM notes WHERE entry LIKE '%source%';")
		checks = append(checks, boolCheck(srcRow.count() > 0 && cloneRow.count() == 0,
			"The row you wrote on the source is not on the clone",
			fmt.Sprintf("%d on the source, %d on the clone", srcRow.count(), cloneRow.count())))

		receiver, _ := psqlSuper(ctx, docker, server, clone+"-1", "postgres", "SELECT count(*) FROM pg_stat_wal_receiver;")
		senders, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE application_name = 'pg-clone';")
		checks = append(checks, boolCheck(receiver.count() == 0 && senders.count() == 0,
			"Neither one is replicating to the other",
			fmt.Sprintf("%d WAL receiver(s) on the clone, %d sender(s) for it on the source", receiver.count(), senders.count())))

		checks = append(checks, boolCheck(sourceHealthy && cloneHealthy,
			"Both clusters are healthy",
			fmt.Sprintf("source: %s; clone: %s", c.Status.Phase, clonePhase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-basebackup-clone", taskID)
}

/* ---- Lab 52: Importing one database (microservice) ---- */

func checkImportMicroservice(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const target = "pg-orders"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	sourcePrimary := c.Status.CurrentPrimary
	sourceHealthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	targetPhase, targetReady, targetExists := clusterPhase(ctx, k3d, server, target)
	targetHealthy := targetExists && targetPhase == "Cluster in healthy state" && targetReady == 1

	switch taskID {
	case "survey-the-source":
		var checks []CheckItem
		dbs := databaseOwners(ctx, docker, server, sourcePrimary)
		_, hasOrders := dbs["orders"]
		_, hasBilling := dbs["billing"]
		checks = append(checks, boolCheck(hasOrders && hasBilling,
			"The source server carries the orders and billing databases",
			fmt.Sprintf("databases: %s", strings.Join(sortedKeysOf(dbs), ", "))))

		rows := tableCount(ctx, docker, server, sourcePrimary, "orders", "lines")
		checks = append(checks, boolCheck(rows.ok() && rows.count() == 500,
			"The orders database has 500 rows in lines", fmt.Sprintf("%d rows", rows.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/orders-rows.txt")
		if !found {
			checks = append(checks, noItem("/root/orders-rows.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/orders-rows.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "500"),
			"It records that row count", fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "import-it":
		var checks []CheckItem
		checks = append(checks, boolCheck(targetHealthy,
			"A new Cluster named pg-orders reports healthy",
			detailOr("pg-orders does not exist yet", targetPhase+fmt.Sprintf(", %d/1 ready", targetReady), !targetExists)))

		rows := tableCount(ctx, docker, server, target+"-1", "app", "lines")
		checks = append(checks, boolCheck(rows.ok() && rows.count() == 500,
			"Its application database holds the imported table, with all 500 rows",
			fmt.Sprintf("%d rows in the app database", rows.count())))

		owner, _ := psqlSuper(ctx, docker, server, target+"-1", "app",
			"SELECT tableowner FROM pg_tables WHERE tablename = 'lines';")
		got := strings.TrimSpace(owner.stdout)
		checks = append(checks, boolCheck(got == "app",
			"And it belongs to the new cluster's application user",
			fmt.Sprintf("lines is owned by %q", got)))

		src := tableCount(ctx, docker, server, sourcePrimary, "orders", "lines")
		checks = append(checks, boolCheck(sourceHealthy && src.ok() && src.count() >= 500,
			"The source is untouched and still serving",
			fmt.Sprintf("%s, orders.lines has %d rows", c.Status.Phase, src.count())))
		return finish(checks), nil

	case "what-it-left-behind":
		var checks []CheckItem
		roles := roleLogin(ctx, docker, server, target+"-1")
		_, hasShop := roles["shop"]
		checks = append(checks, boolCheck(!hasShop,
			"The imported cluster has no shop role — a microservice import brings no roles",
			fmt.Sprintf("roles: %s", strings.Join(sortedKeysOf(roles), ", "))))

		dbs := databaseOwners(ctx, docker, server, target+"-1")
		_, hasOrders := dbs["orders"]
		_, hasApp := dbs["app"]
		checks = append(checks, boolCheck(!hasOrders && hasApp,
			"And no database called orders — it arrived as app",
			fmt.Sprintf("databases: %s", strings.Join(sortedKeysOf(dbs), ", "))))

		src := tableCount(ctx, docker, server, sourcePrimary, "orders", "lines")
		dst := tableCount(ctx, docker, server, target+"-1", "app", "lines")
		diverged := src.ok() && dst.ok() && src.count() > dst.count()
		checks = append(checks, boolCheck(diverged,
			"A row written on the source after the import never reached it",
			fmt.Sprintf("source has %d rows, the imported cluster has %d", src.count(), dst.count())))

		checks = append(checks, boolCheck(sourceHealthy && targetHealthy,
			"Both clusters are healthy",
			fmt.Sprintf("source: %s; imported: %s", c.Status.Phase, targetPhase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-import-microservice", taskID)
}

/* ---- Lab 53: Importing a whole server (monolith) ---- */

func checkImportMonolith(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const target = "pg-estate"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	sourcePrimary := c.Status.CurrentPrimary
	sourceHealthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	targetPhase, targetReady, targetExists := clusterPhase(ctx, k3d, server, target)
	targetHealthy := targetExists && targetPhase == "Cluster in healthy state" && targetReady == 1

	switch taskID {
	case "survey-the-server":
		var checks []CheckItem
		dbs := databaseOwners(ctx, docker, server, sourcePrimary)
		haveAll := dbs["orders"] == "shop" && dbs["billing"] == "shop" && dbs["app"] == "app"
		checks = append(checks, boolCheck(haveAll,
			"The server carries three application databases, with two owners between them",
			fmt.Sprintf("%v", dbs)))

		roles := roleLogin(ctx, docker, server, sourcePrimary)
		shop, hasShop := roles["shop"]
		reporting, hasReporting := roles["reporting"]
		checks = append(checks, boolCheck(hasShop && shop && hasReporting && !reporting,
			"And the roles that own them, including one that cannot log in",
			fmt.Sprintf("shop can log in: %v; reporting can log in: %v", shop, reporting)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/databases.txt")
		if !found {
			checks = append(checks, noItem("/root/databases.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/databases.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "orders") && strings.Contains(body, "billing"),
			"It lists the databases you are about to move",
			fmt.Sprintf("file names orders: %v, billing: %v",
				strings.Contains(body, "orders"), strings.Contains(body, "billing"))))
		return finish(checks), nil

	case "import-everything":
		var checks []CheckItem
		checks = append(checks, boolCheck(targetHealthy,
			"A new Cluster named pg-estate reports healthy",
			detailOr("pg-estate does not exist yet", targetPhase+fmt.Sprintf(", %d/1 ready", targetReady), !targetExists)))

		dbs := databaseOwners(ctx, docker, server, target+"-1")
		kept := dbs["orders"] == "shop" && dbs["billing"] == "shop"
		checks = append(checks, boolCheck(kept,
			"It has the same databases, with the same names and owners",
			fmt.Sprintf("%v", dbs)))

		roles := roleLogin(ctx, docker, server, target+"-1")
		shop, hasShop := roles["shop"]
		reporting, hasReporting := roles["reporting"]
		checks = append(checks, boolCheck(hasShop && shop && hasReporting && !reporting,
			"And the roles, including the one that cannot log in",
			fmt.Sprintf("shop: %v (login %v), reporting: %v (login %v)", hasShop, shop, hasReporting, reporting)))

		lines := tableCount(ctx, docker, server, target+"-1", "orders", "lines")
		invoices := tableCount(ctx, docker, server, target+"-1", "billing", "invoices")
		checks = append(checks, boolCheck(lines.count() == 500 && invoices.count() == 200,
			"The data came with them — 500 order lines and 200 invoices",
			fmt.Sprintf("orders.lines=%d billing.invoices=%d", lines.count(), invoices.count())))
		return finish(checks), nil

	case "what-you-own-now":
		var checks []CheckItem
		// pg_dumpall --roles-only carries the password hashes, so a login role that worked on
		// the source works here — which is convenient and worth knowing before you assume
		// otherwise during a cutover.
		try := psqlAsUser(ctx, docker, server, target+"-rw", "shop", "shop_pw", "orders", "SELECT count(*) FROM lines;")
		checks = append(checks, boolCheck(try.ok() && try.count() == 500,
			"The imported roles kept their passwords — shop still logs in with the old one",
			detailOr(firstLine(try.stderr), fmt.Sprintf("read %d rows as shop", try.count()), !try.ok())))

		checks = append(checks, boolCheck(!secretExists(ctx, k3d, server, target+"-app"),
			"The operator created no application user for this cluster",
			detailOr("a "+target+"-app Secret exists", "there is no "+target+"-app Secret",
				secretExists(ctx, k3d, server, target+"-app"))))

		receiver, _ := psqlSuper(ctx, docker, server, target+"-1", "postgres", "SELECT count(*) FROM pg_stat_wal_receiver;")
		senders, _ := psqlSuper(ctx, docker, server, sourcePrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE application_name = 'pg-estate';")
		checks = append(checks, boolCheck(receiver.count() == 0 && senders.count() == 0,
			"And nothing is replicating — the copy stopped when the import finished",
			fmt.Sprintf("%d WAL receiver(s), %d sender(s) for it on the source", receiver.count(), senders.count())))

		checks = append(checks, boolCheck(sourceHealthy && targetHealthy,
			"Both clusters are healthy",
			fmt.Sprintf("source: %s; imported: %s", c.Status.Phase, targetPhase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-import-monolith", taskID)
}

// sortedKeysOf is sortedKeys for a string-valued map, used only to make a check's detail
// readable when it lists what was actually found.
func sortedKeysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

/* ---- Labs 54–59: storage, maintenance, hibernation and snapshot modes ---- */

// storageClassExpands reports whether a StorageClass allows volume expansion, and whether it
// exists at all. An absent allowVolumeExpansion means false — the field is optional and its
// zero value is the restrictive one.
func storageClassExpands(ctx context.Context, k3d *K3D, server, name string) (allows, exists bool) {
	var sc struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		AllowVolumeExpansion *bool `json:"allowVolumeExpansion"`
	}
	if err := kubectlJSON(ctx, k3d, server, &sc, "get", "storageclass", name); err != nil {
		return false, false
	}
	return sc.AllowVolumeExpansion != nil && *sc.AllowVolumeExpansion, sc.Metadata.Name == name
}

// claim is one PersistentVolumeClaim, read for the three things these labs compare: what was
// asked for, what is actually there, and which volume is behind it.
type claim struct {
	Metadata struct {
		Name              string            `json:"name"`
		CreationTimestamp time.Time         `json:"creationTimestamp"`
		Labels            map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		StorageClassName string `json:"storageClassName"`
		VolumeName       string `json:"volumeName"`
		DataSource       *struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		} `json:"dataSource"`
		Resources struct {
			Requests map[string]string `json:"requests"`
		} `json:"resources"`
	} `json:"spec"`
	Status struct {
		Phase    string            `json:"phase"`
		Capacity map[string]string `json:"capacity"`
	} `json:"status"`
}

func readClaims(ctx context.Context, k3d *K3D, server string, args ...string) []claim {
	var list struct {
		Items []claim `json:"items"`
	}
	_ = kubectlJSON(ctx, k3d, server, &list, append([]string{"get", "pvc"}, args...)...)
	sort.Slice(list.Items, func(i, j int) bool { return list.Items[i].Metadata.Name < list.Items[j].Metadata.Name })
	return list.Items
}

func claimByName(claims []claim, name string) (claim, bool) {
	for _, c := range claims {
		if c.Metadata.Name == name {
			return c, true
		}
	}
	return claim{}, false
}

// clusterConditionOf returns the status and reason of one condition on the Cluster.
func clusterConditionOf(ctx context.Context, k3d *K3D, server, cluster, condType string) (status, reason string) {
	var c struct {
		Status struct {
			Conditions []struct {
				Type   string `json:"type"`
				Status string `json:"status"`
				Reason string `json:"reason"`
			} `json:"conditions"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster); err != nil {
		return "", ""
	}
	for _, cond := range c.Status.Conditions {
		if cond.Type == condType {
			return cond.Status, cond.Reason
		}
	}
	return "", ""
}

// budget is a PodDisruptionBudget as the drain labs read it: how many disruptions it is
// currently prepared to allow, which is the number a drain runs into.
type budget struct {
	name    string
	allowed int
	healthy int
}

func readBudgets(ctx context.Context, k3d *K3D, server string) []budget {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				DisruptionsAllowed int `json:"disruptionsAllowed"`
				CurrentHealthy     int `json:"currentHealthy"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "poddisruptionbudgets"); err != nil {
		return nil
	}
	var out []budget
	for _, b := range list.Items {
		out = append(out, budget{b.Metadata.Name, b.Status.DisruptionsAllowed, b.Status.CurrentHealthy})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func budgetByName(budgets []budget, name string) (budget, bool) {
	for _, b := range budgets {
		if b.name == name {
			return b, true
		}
	}
	return budget{}, false
}

// unschedulableNodes lists the nodes a drain has cordoned.
func unschedulableNodes(ctx context.Context, k3d *K3D, server string) []string {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Unschedulable bool `json:"unschedulable"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "nodes"); err != nil {
		return nil
	}
	var out []string
	for _, n := range list.Items {
		if n.Spec.Unschedulable {
			out = append(out, n.Metadata.Name)
		}
	}
	sort.Strings(out)
	return out
}

// snapshotOf reads one VolumeSnapshot: whether it is usable, and the annotations CloudNativePG
// stamps on it — which are where the difference between a hot and a cold backup is recorded.
type snapshotInfo struct {
	exists      bool
	readyToUse  bool
	annotations map[string]string
}

func readSnapshot(ctx context.Context, k3d *K3D, server, name string) snapshotInfo {
	var snap struct {
		Metadata struct {
			Name        string            `json:"name"`
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
		Status struct {
			ReadyToUse *bool `json:"readyToUse"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &snap, "get", "volumesnapshot", name); err != nil {
		return snapshotInfo{}
	}
	return snapshotInfo{
		exists:      snap.Metadata.Name == name,
		readyToUse:  snap.Status.ReadyToUse != nil && *snap.Status.ReadyToUse,
		annotations: snap.Metadata.Annotations,
	}
}

// backupModeOf returns a Backup's phase and what was *asked for* in spec.online. The spec is
// the honest field: in this operator release .status.online reported true for a backup taken
// with spec.online false, so nothing here reads it.
func backupModeOf(ctx context.Context, k3d *K3D, server, name string) (phase string, online *bool, exists bool) {
	var b struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Spec struct {
			Online *bool `json:"online"`
		} `json:"spec"`
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &b, "get", "backup", name); err != nil {
		return "", nil, false
	}
	return b.Status.Phase, b.Spec.Online, b.Metadata.Name == name
}

/* ---- Lab 54: Storage Expansion ---- */

func checkStorageExpansion(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const dataClaim = "pg-cluster-1"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 1
	claims := readClaims(ctx, k3d, server)
	pvc, hasPVC := claimByName(claims, dataClaim)

	var spec struct {
		Spec struct {
			Storage struct {
				Size         string `json:"size"`
				StorageClass string `json:"storageClass"`
			} `json:"storage"`
		} `json:"spec"`
	}
	_ = kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", cluster)

	switch taskID {
	case "read-the-classes":
		csiAllows, csiExists := storageClassExpands(ctx, k3d, server, "csi-hostpath-sc")
		localAllows, localExists := storageClassExpands(ctx, k3d, server, "local-path")

		var checks []CheckItem
		checks = append(checks, boolCheck(csiExists && localExists && csiAllows && !localAllows,
			"Only one of the two StorageClasses allows volume expansion",
			fmt.Sprintf("csi-hostpath-sc allows: %v, local-path allows: %v", csiAllows, localAllows)))
		onRightClass := hasPVC && pvc.Spec.StorageClassName == "csi-hostpath-sc" &&
			pvc.Spec.Resources.Requests["storage"] == "1Gi"
		checks = append(checks, boolCheck(onRightClass,
			"The cluster's volume is 1Gi on the class that allows it",
			fmt.Sprintf("%s asks for %s on %s", dataClaim, pvc.Spec.Resources.Requests["storage"], pvc.Spec.StorageClassName)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/expandable-class.txt")
		if !found {
			checks = append(checks, noItem("/root/expandable-class.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/expandable-class.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "csi-hostpath-sc"),
			"It names the class that allows expansion", fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "expand-it":
		var checks []CheckItem
		checks = append(checks, boolCheck(spec.Spec.Storage.Size == "2Gi",
			"The Cluster asks for 2Gi",
			"spec.storage.size is "+detailOr("unset", spec.Spec.Storage.Size, spec.Spec.Storage.Size == "")))
		grown := hasPVC && pvc.Status.Capacity["storage"] == "2Gi"
		checks = append(checks, boolCheck(grown,
			"And the claim has actually grown to 2Gi",
			fmt.Sprintf("requested %s, capacity %s", pvc.Spec.Resources.Requests["storage"], pvc.Status.Capacity["storage"])))
		// The claim keeps its name across a rebuild, so the volume behind it is the only thing
		// that can tell an expansion from a replacement.
		same := hasPVC && a.baselineVolume() != "" && pvc.Spec.VolumeName == a.baselineVolume()
		checks = append(checks, boolCheck(same,
			"On the same volume it started on — nothing was recreated",
			fmt.Sprintf("now on %s, started on %s", pvc.Spec.VolumeName, a.baselineVolume())))
		rows := tableCount(ctx, docker, server, cluster+"-1", "app", "notes")
		checks = append(checks, boolCheck(healthy && rows.count() == 50,
			"The cluster is healthy and the 50 rows are still there",
			fmt.Sprintf("%s, %d rows", c.Status.Phase, rows.count())))
		return finish(checks), nil

	case "the-limits":
		var checks []CheckItem
		shrink, foundShrink := readFileAnyNode(ctx, docker, a, "/root/shrink-error.txt")
		checks = append(checks, boolCheck(foundShrink && strings.Contains(shrink, "shrink"),
			"/root/shrink-error.txt records the refusal",
			detailOr("file not found on any node", firstLine(shrink), !foundShrink)))
		checks = append(checks, boolCheck(spec.Spec.Storage.Size == "2Gi",
			"The Cluster still asks for 2Gi — the refusal changed nothing",
			"spec.storage.size is "+spec.Spec.Storage.Size))
		noExp, foundNoExp := readFileAnyNode(ctx, docker, a, "/root/no-expansion-error.txt")
		checks = append(checks, boolCheck(foundNoExp && strings.Contains(noExp, "support resize"),
			"/root/no-expansion-error.txt records what a class without expansion says",
			detailOr("file not found on any node", firstLine(noExp), !foundNoExp)))
		same := hasPVC && a.baselineVolume() != "" && pvc.Spec.VolumeName == a.baselineVolume()
		checks = append(checks, boolCheck(healthy && same,
			"The cluster is healthy and still on its original volume",
			fmt.Sprintf("%s, volume %s", c.Status.Phase, pvc.Spec.VolumeName)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-storage-expansion", taskID)
}

/* ---- Lab 55: A Dedicated WAL Volume ---- */

// walSymlink returns what pg_wal inside the data directory points at, or "" when it is an
// ordinary directory — which is the whole before-and-after of this lab.
func walSymlink(ctx context.Context, docker *Docker, server, pod string) string {
	out, ok := execInPod(ctx, docker, server, pod, "sh", "-c",
		"readlink /var/lib/postgresql/data/pgdata/pg_wal || true")
	if !ok {
		return ""
	}
	return strings.TrimSpace(out)
}

func checkWALVolume(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	claims := readClaims(ctx, k3d, server, "-l", "cnpg.io/cluster="+cluster)
	data, wal := 0, 0
	for _, cl := range claims {
		if strings.HasSuffix(cl.Metadata.Name, "-wal") {
			if cl.Status.Phase == "Bound" {
				wal++
			}
			continue
		}
		if cl.Status.Phase == "Bound" {
			data++
		}
	}

	var spec struct {
		Spec struct {
			WalStorage *struct {
				Size string `json:"size"`
			} `json:"walStorage"`
		} `json:"spec"`
	}
	_ = kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", cluster)

	switch taskID {
	case "where-the-wal-is":
		var checks []CheckItem
		link := walSymlink(ctx, docker, server, c.Status.CurrentPrimary)
		checks = append(checks, boolCheck(link == "",
			"pg_wal is a directory inside the data volume, not a link to anywhere",
			detailOr("pg_wal points at "+link, "pg_wal is an ordinary directory", link != "")))
		checks = append(checks, boolCheck(data == 3 && wal == 0,
			"The cluster has one volume per instance and no more",
			fmt.Sprintf("%d data claim(s), %d WAL claim(s)", data, wal)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/wal-path.txt")
		if !found {
			checks = append(checks, noItem("/root/wal-path.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/wal-path.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "pgdata/pg_wal"),
			"It names the pg_wal directory inside the data directory",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "give-it-a-volume":
		var checks []CheckItem
		asked := spec.Spec.WalStorage != nil && spec.Spec.WalStorage.Size != ""
		checks = append(checks, boolCheck(asked,
			"The Cluster asks for a WAL volume",
			detailOr("spec.walStorage is not set", "spec.walStorage.size is "+detailOr("", spec.Spec.WalStorage.Size, spec.Spec.WalStorage == nil), !asked)))
		checks = append(checks, boolCheck(wal == 3,
			"Each instance has a second claim bound for it",
			fmt.Sprintf("%d data claim(s), %d WAL claim(s)", data, wal)))

		linked := 0
		var detail []string
		for _, pod := range instanceNames(ctx, k3d, server, cluster) {
			link := walSymlink(ctx, docker, server, pod)
			if strings.Contains(link, "/var/lib/postgresql/wal") {
				linked++
			}
			detail = append(detail, pod+"→"+detailOr("(none)", link, link == ""))
		}
		checks = append(checks, boolCheck(linked == 3,
			"And pg_wal inside every data directory is now a link to it", strings.Join(detail, " ")))

		rows := tableCount(ctx, docker, server, c.Status.CurrentPrimary, "app", "notes")
		checks = append(checks, boolCheck(healthy && rows.count() == 50,
			"The cluster is healthy with all 3 instances, and the data is intact",
			fmt.Sprintf("%s, %d/3 ready, %d rows", c.Status.Phase, c.Status.ReadyInstances, rows.count())))
		return finish(checks), nil

	case "one-way-door":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/walstorage-error.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "cannot be disabled"),
			"/root/walstorage-error.txt records what happened when you tried to remove it",
			detailOr("file not found on any node", firstLine(body), !found)))
		checks = append(checks, boolCheck(spec.Spec.WalStorage != nil,
			"The Cluster still has its WAL volume declared",
			detailOr("spec.walStorage is gone", "spec.walStorage is still there", spec.Spec.WalStorage == nil)))
		checks = append(checks, boolCheck(wal == 3 && data == 3,
			"And all six claims are still bound",
			fmt.Sprintf("%d data claim(s), %d WAL claim(s)", data, wal)))
		checks = append(checks, boolCheck(healthy,
			"The cluster is healthy",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-wal-volume", taskID)
}

/* ---- Lab 56: Draining a Node ---- */

func checkNodeDrain(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods, err := readInstancePods(ctx, k3d, server, cluster)
	if err != nil {
		return CheckResult{}, err
	}
	budgets := readBudgets(ctx, k3d, server)
	cordoned := unschedulableNodes(ctx, k3d, server)

	switch taskID {
	case "read-the-budgets":
		var checks []CheckItem
		_, hasReplicaPDB := budgetByName(budgets, cluster)
		primaryPDB, hasPrimaryPDB := budgetByName(budgets, cluster+"-primary")
		checks = append(checks, boolCheck(len(budgets) == 2 && hasReplicaPDB && hasPrimaryPDB,
			"The operator maintains two PodDisruptionBudgets for this cluster",
			fmt.Sprintf("%d budget(s): %v", len(budgets), budgets)))
		checks = append(checks, boolCheck(hasPrimaryPDB && primaryPDB.allowed == 0,
			"The primary's budget allows no disruptions at all",
			fmt.Sprintf("%s allows %d", cluster+"-primary", primaryPDB.allowed)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/drain-target.txt")
		if !found {
			checks = append(checks, noItem("/root/drain-target.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/drain-target.txt was written", "found"))
		target := firstLine(body)
		primaryNode := ""
		replicaNodes := map[string]bool{}
		for _, p := range pods {
			if p.Metadata.Name == c.Status.CurrentPrimary {
				primaryNode = p.Spec.NodeName
			} else if p.Spec.NodeName != "" {
				replicaNodes[p.Spec.NodeName] = true
			}
		}
		checks = append(checks, boolCheck(target != "" && target != primaryNode && replicaNodes[target],
			"It names a node holding a replica, not the primary",
			fmt.Sprintf("file says %q; the primary is on %q", target, primaryNode)))
		return finish(checks), nil

	case "drain-a-node":
		body, _ := readFileAnyNode(ctx, docker, a, "/root/drain-target.txt")
		target := firstLine(body)

		var checks []CheckItem
		isCordoned := false
		for _, n := range cordoned {
			if n == target {
				isCordoned = true
			}
		}
		checks = append(checks, boolCheck(isCordoned,
			"The node you drained will take no new Pods",
			fmt.Sprintf("cordoned nodes: %v", cordoned)))

		pending := 0
		for _, p := range pods {
			if p.Status.Phase == "Pending" {
				pending++
			}
		}
		checks = append(checks, boolCheck(pending == 1,
			"The instance that was on it is Pending, with nowhere to go",
			fmt.Sprintf("%d instance(s) Pending", pending)))

		msg, sawIt := failedSchedulingSaying(ctx, k3d, server, "node(s) were unschedulable")
		checks = append(checks, boolCheck(sawIt,
			"The scheduler says so itself",
			detailOr("no FailedScheduling event mentions an unschedulable node", msg, !sawIt)))
		checks = append(checks, boolCheck(c.Status.ReadyInstances == 2,
			"The cluster is degraded but still serving on 2 of 3",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "maintenance-window":
		body, _ := readFileAnyNode(ctx, docker, a, "/root/drain-target.txt")
		target := firstLine(body)

		var checks []CheckItem
		warn, found := readFileAnyNode(ctx, docker, a, "/root/maintenance-warning.txt")
		checks = append(checks, boolCheck(found && strings.Contains(warn, "enablePDB"),
			"/root/maintenance-warning.txt records what the API server said about this field",
			detailOr("file not found on any node", firstLine(warn), !found)))

		onDrained := 0
		for _, p := range pods {
			if p.Spec.NodeName == target {
				onDrained++
			}
		}
		checks = append(checks, boolCheck(target != "" && onDrained == 0,
			"No instance is left on the node you drained",
			fmt.Sprintf("%d instance(s) still on %s", onDrained, target)))
		checks = append(checks, boolCheck(len(cordoned) == 0,
			"Every node is schedulable again",
			detailOr(fmt.Sprintf("still cordoned: %v", cordoned), "no node is cordoned", len(cordoned) > 0)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"And the cluster is healthy with all 3 instances",
			fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-node-drain", taskID)
}

/* ---- Lab 57: Draining a Node with One Instance ---- */

func checkSingleInstanceDrain(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods, err := readInstancePods(ctx, k3d, server, cluster)
	if err != nil {
		return CheckResult{}, err
	}
	budgets := readBudgets(ctx, k3d, server)
	cordoned := unschedulableNodes(ctx, k3d, server)

	var spec struct {
		Spec struct {
			EnablePDB *bool `json:"enablePDB"`
		} `json:"spec"`
	}
	_ = kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", cluster)

	switch taskID {
	case "one-budget":
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.Instances == 1 && len(pods) == 1,
			"The cluster has exactly one instance",
			fmt.Sprintf("%d instance(s)", len(pods))))
		primaryPDB, has := budgetByName(budgets, cluster+"-primary")
		checks = append(checks, boolCheck(len(budgets) == 1 && has && primaryPDB.allowed == 0,
			"And one PodDisruptionBudget, which allows no disruptions",
			fmt.Sprintf("%d budget(s): %v", len(budgets), budgets)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/instance-node.txt")
		if !found {
			checks = append(checks, noItem("/root/instance-node.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/instance-node.txt was written", "found"))
		node := ""
		if len(pods) > 0 {
			node = pods[0].Spec.NodeName
		}
		checks = append(checks, boolCheck(node != "" && strings.Contains(body, node),
			"It names the node the instance is on",
			fmt.Sprintf("file says %q, the instance is on %q", firstLine(body), node)))
		return finish(checks), nil

	case "drain-blocked":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/drain-error.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "disruption budget"),
			"/root/drain-error.txt records the eviction being refused",
			detailOr("file not found on any node", "the drain output names the disruption budget", !found)))
		checks = append(checks, boolCheck(len(cordoned) == 1,
			"The node is cordoned — a drain cordons first and evicts afterwards",
			fmt.Sprintf("cordoned nodes: %v", cordoned)))
		running := runningCount(pods)
		checks = append(checks, boolCheck(running == 1 && c.Status.ReadyInstances == 1,
			"But the instance is still running, and the database is still up",
			fmt.Sprintf("%d Running, %d/1 ready", running, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "disable-the-budget":
		var checks []CheckItem
		off := spec.Spec.EnablePDB != nil && !*spec.Spec.EnablePDB
		checks = append(checks, boolCheck(off,
			"PodDisruptionBudgets are switched off for this cluster",
			detailOr("spec.enablePDB is not false", "spec.enablePDB: false", !off)))
		checks = append(checks, boolCheck(len(budgets) == 0,
			"And there are none left to refuse an eviction",
			fmt.Sprintf("%d budget(s) remain", len(budgets))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/outage.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "Pending"),
			"/root/outage.txt records the instance with nowhere to run",
			detailOr("file not found on any node", firstLine(body), !found)))
		checks = append(checks, boolCheck(len(cordoned) == 0 && c.Status.ReadyInstances == 1,
			"And after uncordoning, the instance is back",
			fmt.Sprintf("cordoned: %v, %d/1 ready", cordoned, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-single-instance-drain", taskID)
}

/* ---- Lab 58: Declarative Hibernation ---- */

func checkDeclarativeHibernation(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	pods, err := readInstancePods(ctx, k3d, server, cluster)
	if err != nil {
		return CheckResult{}, err
	}
	claims := readClaims(ctx, k3d, server, "-l", "cnpg.io/cluster="+cluster)
	bound := 0
	for _, cl := range claims {
		if cl.Status.Phase == "Bound" {
			bound++
		}
	}
	annotation := clusterAnnotation(ctx, k3d, server, cluster, "cnpg.io/hibernation")

	var spec struct {
		Spec struct {
			PostgreSQL struct {
				Parameters map[string]string `json:"parameters"`
			} `json:"postgresql"`
		} `json:"spec"`
	}
	_ = kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", cluster)

	switch taskID {
	case "put-it-to-sleep":
		status, reason := clusterConditionOf(ctx, k3d, server, cluster, "cnpg.io/hibernation")

		var checks []CheckItem
		checks = append(checks, boolCheck(annotation == "on",
			"The Cluster is annotated cnpg.io/hibernation: on",
			"the annotation reads "+detailOr("(absent)", annotation, annotation == "")))
		checks = append(checks, boolCheck(len(pods) == 0,
			"Every instance Pod is gone", fmt.Sprintf("%d instance Pod(s)", len(pods))))
		checks = append(checks, boolCheck(bound == 3,
			"All 3 volumes are still bound — the data is kept",
			fmt.Sprintf("%d of %d claim(s) bound", bound, len(claims))))
		checks = append(checks, boolCheck(status == "True" && reason == "Hibernated",
			"And the cluster reports a hibernation condition",
			fmt.Sprintf("condition cnpg.io/hibernation is %q/%q", status, reason)))
		return finish(checks), nil

	case "what-remains":
		services := readMeta(ctx, k3d, server, "svc", "-l", "cnpg.io/cluster="+cluster)
		endpoints := 0
		for _, svc := range []string{cluster + "-rw", cluster + "-ro", cluster + "-r"} {
			ips, _ := serviceEndpointIPs(ctx, k3d, server, svc)
			endpoints += len(ips)
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(len(services.Items) == 3,
			"All three Services are still there",
			fmt.Sprintf("%d Service(s)", len(services.Items))))
		checks = append(checks, boolCheck(endpoints == 0,
			"And not one of them has an endpoint to send anything to",
			fmt.Sprintf("%d endpoint(s) across the three", endpoints)))
		checks = append(checks, boolCheck(secretExists(ctx, k3d, server, cluster+"-app"),
			"The generated application Secret is untouched",
			detailOr("the "+cluster+"-app Secret is gone", "the "+cluster+"-app Secret is still there",
				!secretExists(ctx, k3d, server, cluster+"-app"))))
		asked := spec.Spec.PostgreSQL.Parameters["max_connections"]
		checks = append(checks, boolCheck(asked == "200" && len(pods) == 0,
			"And the spec took an edit while it slept — max_connections now asks for 200",
			fmt.Sprintf("spec asks for %q, %d Pod(s) running", detailOr("(unset)", asked, asked == ""), len(pods))))
		return finish(checks), nil

	case "wake-it-up":
		var checks []CheckItem
		checks = append(checks, boolCheck(annotation == "off",
			"The hibernation annotation reads off",
			"the annotation reads "+detailOr("(absent)", annotation, annotation == "")))

		// The Pods are new; the volumes are not. That gap is the proof that hibernation kept
		// the data and threw away only the compute.
		reused := len(pods) == 3
		for _, p := range pods {
			cl, ok := claimByName(claims, p.Metadata.Name)
			if !ok || !cl.Metadata.CreationTimestamp.Before(p.Metadata.CreationTimestamp) {
				reused = false
			}
		}
		checks = append(checks, boolCheck(reused,
			"All 3 instances are back, on volumes older than themselves",
			fmt.Sprintf("%d Pod(s), %d bound claim(s)", len(pods), bound)))

		running, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SHOW max_connections;")
		checks = append(checks, boolCheck(strings.TrimSpace(running.stdout) == "200",
			"The setting you changed while it slept is in force",
			fmt.Sprintf("max_connections is %q", strings.TrimSpace(running.stdout))))

		rows := tableCount(ctx, docker, server, c.Status.CurrentPrimary, "app", "notes")
		checks = append(checks, boolCheck(rows.count() == 50 &&
			c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"And the rows written before it slept are still there",
			fmt.Sprintf("%d rows, %s, %d/3 ready", rows.count(), c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-declarative-hibernation", taskID)
}

/* ---- Lab 59: Hot and Cold Snapshot Backups ---- */

func checkSnapshotModes(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const restored = "pg-restored"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 1

	switch taskID {
	case "hot-backup":
		phase, online, exists := backupModeOf(ctx, k3d, server, "hot-backup")
		snap := readSnapshot(ctx, k3d, server, "hot-backup")

		var checks []CheckItem
		checks = append(checks, boolCheck(exists && phase == "completed",
			"The hot backup completed",
			detailOr("no Backup named hot-backup yet", "phase is "+phase, !exists)))
		checks = append(checks, boolCheck(online != nil && *online,
			"It was taken online — spec.online is true",
			detailOr("spec.online is not true", "spec.online: true", online == nil || !*online)))
		checks = append(checks, boolCheck(snap.exists && snap.readyToUse,
			"Its VolumeSnapshot is ready to use",
			fmt.Sprintf("exists: %v, readyToUse: %v", snap.exists, snap.readyToUse)))
		_, hasLabel := snap.annotations["cnpg.io/backupLabelFile"]
		checks = append(checks, boolCheck(hasLabel,
			"And it carries a backup label, because the database was running throughout",
			detailOr("the snapshot carries no cnpg.io/backupLabelFile annotation",
				"cnpg.io/backupLabelFile is present", !hasLabel)))
		return finish(checks), nil

	case "cold-backup":
		phase, online, exists := backupModeOf(ctx, k3d, server, "cold-backup")
		snap := readSnapshot(ctx, k3d, server, "cold-backup")
		_, hasLabel := snap.annotations["cnpg.io/backupLabelFile"]
		controlData := snap.annotations["cnpg.io/pgControldata"]

		var checks []CheckItem
		checks = append(checks, boolCheck(exists && phase == "completed" && online != nil && !*online,
			"The cold backup completed, with spec.online false",
			fmt.Sprintf("phase %q, spec.online %v", phase, online != nil && *online)))
		checks = append(checks, boolCheck(snap.exists && snap.readyToUse && !hasLabel,
			"Its snapshot is ready and carries no backup label — nothing was running to label",
			fmt.Sprintf("readyToUse: %v, backup label present: %v", snap.readyToUse, hasLabel)))
		shutDown := strings.Contains(controlData, "shut down")
		checks = append(checks, boolCheck(shutDown,
			"The control file inside it says the database was shut down",
			detailOr("the snapshot's recorded control file does not say shut down",
				"Database cluster state: shut down", !shutDown)))
		fenced := clusterAnnotation(ctx, k3d, server, cluster, "cnpg.io/fencedInstances")
		clear := fenced == "" || fenced == "[]"
		checks = append(checks, boolCheck(clear && healthy,
			"And nothing is fenced any more — the instance is Ready again",
			fmt.Sprintf("fencedInstances %q, %s", fenced, c.Status.Phase)))
		return finish(checks), nil

	case "restore-the-cold-one":
		phase, ready, exists := clusterPhase(ctx, k3d, server, restored)
		claims := readClaims(ctx, k3d, server)
		pvc, hasPVC := claimByName(claims, restored+"-1")

		var checks []CheckItem
		checks = append(checks, boolCheck(exists && phase == "Cluster in healthy state" && ready == 1,
			"A cluster named pg-restored reports healthy",
			detailOr("pg-restored does not exist yet", phase+fmt.Sprintf(", %d/1 ready", ready), !exists)))
		fromCold := hasPVC && pvc.Spec.DataSource != nil &&
			pvc.Spec.DataSource.Kind == "VolumeSnapshot" && pvc.Spec.DataSource.Name == "cold-backup"
		checks = append(checks, boolCheck(fromCold,
			"Its volume was created from the cold snapshot",
			detailOr("the claim names no VolumeSnapshot as its dataSource",
				"dataSource is the cold-backup VolumeSnapshot", !fromCold)))
		rows := tableCount(ctx, docker, server, restored+"-1", "app", "notes")
		checks = append(checks, boolCheck(rows.count() == 50,
			"It carries all 50 rows", fmt.Sprintf("%d rows", rows.count())))
		checks = append(checks, boolCheck(healthy,
			"And the cluster it was taken from is untouched",
			fmt.Sprintf("%s, %d/1 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-snapshot-modes", taskID)
}

/* ---- Labs 60–63: snapshot PITR, plugin and scheduled backups, managed roles ---- */

// backupNames lists the Backup objects in the namespace, with their phase and requested mode.
type backupRow struct {
	name   string
	phase  string
	method string
	online *bool
}

func readBackups(ctx context.Context, k3d *K3D, server string) []backupRow {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Method string `json:"method"`
				Online *bool  `json:"online"`
			} `json:"spec"`
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "backup"); err != nil {
		return nil
	}
	var out []backupRow
	for _, b := range list.Items {
		out = append(out, backupRow{b.Metadata.Name, b.Status.Phase, b.Spec.Method, b.Spec.Online})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func (b backupRow) isOnline() bool  { return b.online == nil || *b.online }
func (b backupRow) isOffline() bool { return b.online != nil && !*b.online }

// String keeps a check's detail readable: a %v of the struct would print the address of the
// online pointer, which tells a learner nothing at all.
func (b backupRow) String() string {
	mode := "online unset"
	if b.online != nil {
		mode = fmt.Sprintf("online=%v", *b.online)
	}
	return fmt.Sprintf("%s(%s, %s)", b.name, b.phase, mode)
}

// snapshotNames lists the VolumeSnapshots, which is how the labs count what has accumulated.
func snapshotNames(ctx context.Context, k3d *K3D, server string) []string {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "volumesnapshot"); err != nil {
		return nil
	}
	var out []string
	for _, s := range list.Items {
		out = append(out, s.Metadata.Name)
	}
	sort.Strings(out)
	return out
}

/* ---- Lab 60: Point-in-Time Recovery from a Volume Snapshot ---- */

func checkSnapshotPITR(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	sourceHealthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 1

	// The proof of a point-in-time recovery is which of two rows arrived, so both checks below
	// read the same table on whichever cluster they are asking about.
	rowsOn := func(pod string) (first, second int) {
		f, _ := psqlSuper(ctx, docker, server, pod, "app", "SELECT count(*) FROM pitr_proof WHERE note = 'first';")
		s, _ := psqlSuper(ctx, docker, server, pod, "app", "SELECT count(*) FROM pitr_proof WHERE note = 'second';")
		return f.count(), s.count()
	}

	recovered := func(name, snapshot string) []CheckItem {
		phase, ready, exists := clusterPhase(ctx, k3d, server, name)
		claims := readClaims(ctx, k3d, server)
		pvc, hasPVC := claimByName(claims, name+"-1")
		first, second := rowsOn(name + "-1")

		var checks []CheckItem
		checks = append(checks, boolCheck(exists && phase == "Cluster in healthy state" && ready == 1,
			"A cluster named "+name+" reports healthy",
			detailOr(name+" does not exist yet", phase+fmt.Sprintf(", %d/1 ready", ready), !exists)))
		fromSnapshot := hasPVC && pvc.Spec.DataSource != nil &&
			pvc.Spec.DataSource.Kind == "VolumeSnapshot" && pvc.Spec.DataSource.Name == snapshot
		checks = append(checks, boolCheck(fromSnapshot,
			"Its volume was created from the "+snapshot+" snapshot",
			detailOr("the claim names no VolumeSnapshot as its dataSource",
				"dataSource is the "+snapshot+" VolumeSnapshot", !fromSnapshot)))
		checks = append(checks, boolCheck(first == 1,
			"It carries the row written before your target time",
			fmt.Sprintf("%d row(s) noted 'first'", first)))
		checks = append(checks, boolCheck(second == 0,
			"And not the one written after it",
			fmt.Sprintf("%d row(s) noted 'second'", second)))
		return checks
	}

	switch taskID {
	case "take-both-snapshots":
		status, _ := clusterConditionOf(ctx, k3d, server, cluster, "ContinuousArchiving")
		backups := readBackups(ctx, k3d, server)
		hot, cold := false, false
		for _, b := range backups {
			if b.name == "hot-backup" && b.phase == "completed" && b.isOnline() {
				hot = true
			}
			if b.name == "cold-backup" && b.phase == "completed" && b.isOffline() {
				cold = true
			}
		}
		hotSnap := readSnapshot(ctx, k3d, server, "hot-backup")
		coldSnap := readSnapshot(ctx, k3d, server, "cold-backup")

		var checks []CheckItem
		checks = append(checks, boolCheck(status == "True",
			"WAL archiving is working — the archive is what makes a target time reachable",
			"ContinuousArchiving is "+detailOr("(absent)", status, status == "")))
		checks = append(checks, boolCheck(hot && cold,
			"Both backups completed, one online and one not",
			fmt.Sprintf("%d backup(s): %v", len(backups), backups)))
		checks = append(checks, boolCheck(hotSnap.readyToUse && coldSnap.readyToUse,
			"And both snapshots are ready to use",
			fmt.Sprintf("hot ready: %v, cold ready: %v", hotSnap.readyToUse, coldSnap.readyToUse)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/target-time.txt")
		if !found {
			checks = append(checks, noItem("/root/target-time.txt holds a moment between two rows", "file not found on any node"))
			return finish(checks), nil
		}
		// The target has to sit strictly between the two commits, or the recovery afterwards
		// proves nothing. The database's own clock is the only one that can settle it.
		between, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", fmt.Sprintf(
			"SELECT count(*) FROM pitr_proof WHERE (note = 'first' AND at < '%s') OR (note = 'second' AND at > '%s');",
			strings.TrimSpace(firstLine(body)), strings.TrimSpace(firstLine(body))))
		checks = append(checks, boolCheck(between.count() == 2,
			"/root/target-time.txt holds a moment between two rows",
			fmt.Sprintf("file says %q; %d of 2 rows fall on the right side of it", firstLine(body), between.count())))
		return finish(checks), nil

	case "recover-from-the-hot-one":
		return finish(recovered("pg-hot-pitr", "hot-backup")), nil

	case "recover-from-the-cold-one":
		checks := recovered("pg-cold-pitr", "cold-backup")
		checks = append(checks, boolCheck(sourceHealthy,
			"And the cluster all three came from is untouched",
			fmt.Sprintf("%s, %d/1 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-snapshot-pitr", taskID)
}

/* ---- Lab 61: Backups with the cnpg plugin ---- */

func checkPluginSnapshotBackup(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 1
	backups := readBackups(ctx, k3d, server)

	// The plugin names an unnamed backup after the cluster and the moment, so the online one is
	// found by shape rather than by a name the lab dictates.
	var generated *backupRow
	for i, b := range backups {
		if b.name != "cold-by-plugin" && b.method == "volumeSnapshot" && b.phase == "completed" {
			generated = &backups[i]
			break
		}
	}
	cold, hasCold := backupRow{}, false
	for _, b := range backups {
		if b.name == "cold-by-plugin" {
			cold, hasCold = b, true
		}
	}

	switch taskID {
	case "plugin-backup":
		var checks []CheckItem
		checks = append(checks, boolCheck(generated != nil,
			"The plugin created a volumeSnapshot Backup, and it completed",
			fmt.Sprintf("%d backup(s): %v", len(backups), backups)))
		online := generated != nil && generated.isOnline()
		checks = append(checks, boolCheck(online,
			"It was taken online, which is what the plugin asks for by default",
			detailOr("no completed online backup found", "spec.online is true or unset", !online)))
		ready := false
		if generated != nil {
			ready = readSnapshot(ctx, k3d, server, generated.name).readyToUse
		}
		checks = append(checks, boolCheck(ready,
			"Its VolumeSnapshot is ready to use",
			fmt.Sprintf("readyToUse: %v", ready)))
		checks = append(checks, boolCheck(healthy,
			"And the cluster is healthy — nothing was interrupted",
			fmt.Sprintf("%s, %d/1 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "cold-by-plugin":
		snap := readSnapshot(ctx, k3d, server, "cold-by-plugin")
		_, hasLabel := snap.annotations["cnpg.io/backupLabelFile"]
		shutDown := strings.Contains(snap.annotations["cnpg.io/pgControldata"], "shut down")
		fenced := clusterAnnotation(ctx, k3d, server, cluster, "cnpg.io/fencedInstances")

		var checks []CheckItem
		checks = append(checks, boolCheck(hasCold && cold.phase == "completed",
			"A Backup named cold-by-plugin completed",
			detailOr("no Backup called cold-by-plugin yet", "phase is "+cold.phase, !hasCold)))
		checks = append(checks, boolCheck(hasCold && cold.isOffline(),
			"The plugin asked for it offline — spec.online is false",
			fmt.Sprintf("spec.online is %v", hasCold && cold.isOnline())))
		checks = append(checks, boolCheck(shutDown && !hasLabel,
			"Its snapshot records a shut down database and carries no backup label",
			fmt.Sprintf("control file says shut down: %v, backup label present: %v", shutDown, hasLabel)))
		clear := fenced == "" || fenced == "[]"
		checks = append(checks, boolCheck(clear && healthy,
			"And the instance is Ready again, with nothing fenced",
			fmt.Sprintf("fencedInstances %q, %s", fenced, c.Status.Phase)))
		return finish(checks), nil

	case "what-the-plugin-made":
		completed := 0
		for _, b := range backups {
			if b.method == "volumeSnapshot" && b.phase == "completed" {
				completed++
			}
		}
		var last struct {
			Status struct {
				LastSuccessfulBackup string `json:"lastSuccessfulBackup"`
			} `json:"status"`
		}
		_ = kubectlJSON(ctx, k3d, server, &last, "get", "cluster.postgresql.cnpg.io", cluster)

		var checks []CheckItem
		checks = append(checks, boolCheck(completed >= 2,
			"Both of the plugin's Backups are ordinary Backup objects, and both completed",
			fmt.Sprintf("%d completed volumeSnapshot backup(s)", completed)))
		checks = append(checks, boolCheck(generated != nil && hasCold && generated.isOnline() && cold.isOffline(),
			"One asked for online and the other did not",
			fmt.Sprintf("%v", backups)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/backups.txt")
		if !found {
			checks = append(checks, noItem("/root/backups.txt lists what the plugin created", "file not found on any node"))
			return finish(checks), nil
		}
		listed := strings.Contains(body, "cold-by-plugin") && generated != nil && strings.Contains(body, generated.name)
		checks = append(checks, boolCheck(listed,
			"/root/backups.txt lists what the plugin created",
			fmt.Sprintf("file names cold-by-plugin: %v", strings.Contains(body, "cold-by-plugin"))))
		checks = append(checks, boolCheck(last.Status.LastSuccessfulBackup != "",
			"And the cluster records when it was last backed up",
			"status.lastSuccessfulBackup is "+detailOr("(empty)", last.Status.LastSuccessfulBackup, last.Status.LastSuccessfulBackup == "")))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-plugin-snapshot-backup", taskID)
}

/* ---- Lab 62: Scheduled snapshot backups ---- */

// schedule is a ScheduledBackup as this lab reads it.
type schedule struct {
	name      string
	suspended bool
	online    *bool
	method    string
	lastTime  string
	nextTime  string
}

func readSchedules(ctx context.Context, k3d *K3D, server string) []schedule {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Suspend *bool  `json:"suspend"`
				Online  *bool  `json:"online"`
				Method  string `json:"method"`
			} `json:"spec"`
			Status struct {
				LastScheduleTime string `json:"lastScheduleTime"`
				NextScheduleTime string `json:"nextScheduleTime"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "scheduledbackup"); err != nil {
		return nil
	}
	var out []schedule
	for _, sb := range list.Items {
		out = append(out, schedule{
			name:      sb.Metadata.Name,
			suspended: sb.Spec.Suspend != nil && *sb.Spec.Suspend,
			online:    sb.Spec.Online,
			method:    sb.Spec.Method,
			lastTime:  sb.Status.LastScheduleTime,
			nextTime:  sb.Status.NextScheduleTime,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func scheduleByName(schedules []schedule, name string) (schedule, bool) {
	for _, s := range schedules {
		if s.name == name {
			return s, true
		}
	}
	return schedule{}, false
}

// backupsFrom returns the Backups a schedule has produced, which are named after it.
func backupsFrom(backups []backupRow, scheduleName string) []backupRow {
	var out []backupRow
	for _, b := range backups {
		if strings.HasPrefix(b.name, scheduleName+"-") {
			out = append(out, b)
		}
	}
	return out
}

func checkScheduledSnapshots(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const onlineSchedule = "every-minute-online"
	const coldSchedule = "every-two-minutes-cold"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 1
	schedules := readSchedules(ctx, k3d, server)
	backups := readBackups(ctx, k3d, server)

	switch taskID {
	case "schedule-it":
		sb, has := scheduleByName(schedules, onlineSchedule)
		produced := backupsFrom(backups, onlineSchedule)
		completed := 0
		ready := 0
		for _, b := range produced {
			if b.phase == "completed" {
				completed++
				if readSnapshot(ctx, k3d, server, b.name).readyToUse {
					ready++
				}
			}
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(has && sb.method == "volumeSnapshot",
			"A ScheduledBackup exists, taking volume snapshots",
			detailOr("no ScheduledBackup called "+onlineSchedule, "method is "+sb.method, !has)))
		checks = append(checks, boolCheck(has && sb.isOnline(),
			"It runs online, so the database keeps serving on every run",
			fmt.Sprintf("spec.online is %v", has && sb.isOnline())))
		checks = append(checks, boolCheck(completed >= 1,
			"It has already produced at least one completed Backup",
			fmt.Sprintf("%d backup(s) from the schedule, %d completed", len(produced), completed)))
		checks = append(checks, boolCheck(ready >= 1 && has && sb.lastTime != "",
			"With a VolumeSnapshot ready to use, and a recorded last schedule time",
			fmt.Sprintf("%d snapshot(s) ready, lastScheduleTime %q", ready, sb.lastTime)))
		return finish(checks), nil

	case "schedule-a-cold-one":
		sb, has := scheduleByName(schedules, coldSchedule)
		produced := backupsFrom(backups, coldSchedule)
		coldName := ""
		for _, b := range produced {
			if b.phase == "completed" && b.isOffline() {
				coldName = b.name
			}
		}
		snap := readSnapshot(ctx, k3d, server, coldName)
		_, hasLabel := snap.annotations["cnpg.io/backupLabelFile"]
		shutDown := strings.Contains(snap.annotations["cnpg.io/pgControldata"], "shut down")

		var checks []CheckItem
		checks = append(checks, boolCheck(has && sb.isOffline(),
			"A second schedule exists, and it runs offline",
			detailOr("no ScheduledBackup called "+coldSchedule, "spec.online is false", !has)))
		checks = append(checks, boolCheck(coldName != "",
			"It has produced a completed Backup of its own",
			fmt.Sprintf("%d backup(s) from the schedule", len(produced))))
		checks = append(checks, boolCheck(shutDown && !hasLabel,
			"Whose snapshot records a shut down database, with no backup label",
			fmt.Sprintf("control file says shut down: %v, backup label present: %v", shutDown, hasLabel)))
		checks = append(checks, boolCheck(healthy,
			"And the cluster is healthy again between runs",
			fmt.Sprintf("%s, %d/1 ready", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "nobody-prunes-these":
		var spec struct {
			Spec struct {
				Backup struct {
					VolumeSnapshot struct {
						SnapshotOwnerReference string `json:"snapshotOwnerReference"`
					} `json:"volumeSnapshot"`
				} `json:"backup"`
			} `json:"spec"`
		}
		_ = kubectlJSON(ctx, k3d, server, &spec, "get", "cluster.postgresql.cnpg.io", cluster)

		suspended := 0
		for _, sb := range schedules {
			if sb.suspended {
				suspended++
			}
		}
		snapshots := snapshotNames(ctx, k3d, server)

		var checks []CheckItem
		checks = append(checks, boolCheck(len(schedules) == 2 && suspended == 2,
			"Both schedules are suspended",
			fmt.Sprintf("%d of %d schedule(s) suspended", suspended, len(schedules))))
		owner := spec.Spec.Backup.VolumeSnapshot.SnapshotOwnerReference
		checks = append(checks, boolCheck(owner == "backup",
			"The cluster now asks for new snapshots to be owned by their Backup",
			"snapshotOwnerReference is "+detailOr("(unset)", owner, owner == "")))

		body, found := readFileAnyNode(ctx, docker, a, "/root/orphan-snapshot.txt")
		if !found {
			checks = append(checks, noItem("/root/orphan-snapshot.txt names a snapshot that outlived its Backup", "file not found on any node"))
			return finish(checks), nil
		}
		orphan := firstLine(body)
		snapshotThere, backupGone := false, true
		for _, n := range snapshots {
			if n == orphan {
				snapshotThere = true
			}
		}
		for _, b := range backups {
			if b.name == orphan {
				backupGone = false
			}
		}
		checks = append(checks, boolCheck(orphan != "" && snapshotThere && backupGone,
			"/root/orphan-snapshot.txt names a snapshot that outlived its Backup",
			fmt.Sprintf("%q: snapshot present %v, Backup gone %v", orphan, snapshotThere, backupGone)))
		// Deliberately not gated on the cluster being ready: the cold schedule fences the
		// instance while it runs, so a check taken seconds after suspending one would fail on
		// something that has nothing to do with what this objective is about.
		checks = append(checks, boolCheck(len(snapshots) >= 2,
			"And the snapshots that accumulated are all still there",
			fmt.Sprintf("%d snapshot(s), %s", len(snapshots), c.Status.Phase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-scheduled-snapshots", taskID)
}

func (s schedule) isOnline() bool  { return s.online == nil || *s.online }
func (s schedule) isOffline() bool { return s.online != nil && !*s.online }

/* ---- Lab 63: Managed roles ---- */

// managedRole is one entry of spec.managed.roles, read back off the Cluster.
type managedRole struct {
	Name      string `json:"name"`
	Ensure    string `json:"ensure"`
	Login     *bool  `json:"login"`
	Superuser *bool  `json:"superuser"`
	CreateDB  *bool  `json:"createdb"`
	Comment   string `json:"comment"`
	// Read by the password-maintenance lab only.
	DisablePassword *bool  `json:"disablePassword"`
	ValidUntil      string `json:"validUntil"`
	PasswordSecret  struct {
		Name string `json:"name"`
	} `json:"passwordSecret"`
}

func readManagedRoles(ctx context.Context, k3d *K3D, server, cluster string) ([]managedRole, []string, []string) {
	var c struct {
		Spec struct {
			Managed struct {
				Roles []managedRole `json:"roles"`
			} `json:"managed"`
		} `json:"spec"`
		Status struct {
			ManagedRolesStatus struct {
				ByStatus        map[string][]string `json:"byStatus"`
				CannotReconcile map[string][]string `json:"cannotReconcile"`
			} `json:"managedRolesStatus"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster); err != nil {
		return nil, nil, nil
	}
	var reconciled []string
	for status, names := range c.Status.ManagedRolesStatus.ByStatus {
		if status == "reconciled" {
			reconciled = append(reconciled, names...)
		}
	}
	var problems []string
	for name, msgs := range c.Status.ManagedRolesStatus.CannotReconcile {
		problems = append(problems, name+": "+strings.Join(msgs, "; "))
	}
	sort.Strings(reconciled)
	sort.Strings(problems)
	return c.Spec.Managed.Roles, reconciled, problems
}

// roleAttributes reads one role straight out of the database, which is the only place that
// settles what the operator actually did.
func roleAttributes(ctx context.Context, docker *Docker, server, pod, role string) (exists, canLogin, createDB bool, comment string) {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres", fmt.Sprintf(
		"SELECT rolcanlogin || '|' || rolcreatedb || '|' || coalesce(shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = '%s';", role))
	if err != nil || !res.ok() || strings.TrimSpace(res.stdout) == "" {
		return false, false, false, ""
	}
	parts := strings.SplitN(strings.TrimSpace(res.stdout), "|", 3)
	if len(parts) < 3 {
		return true, false, false, ""
	}
	return true, strings.HasPrefix(parts[0], "t"), strings.HasPrefix(parts[1], "t"), parts[2]
}

func checkManagedRoles(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const role = "analyst"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	declared, reconciled, problems := readManagedRoles(ctx, k3d, server, cluster)
	exists, canLogin, createDB, comment := roleAttributes(ctx, docker, server, c.Status.CurrentPrimary, role)

	var wanted *managedRole
	for i, r := range declared {
		if r.Name == role {
			wanted = &declared[i]
		}
	}
	isReconciled := false
	for _, n := range reconciled {
		if n == role {
			isReconciled = true
		}
	}

	switch taskID {
	case "declare-a-role":
		var checks []CheckItem
		checks = append(checks, boolCheck(wanted != nil,
			"The Cluster declares a managed role called analyst",
			detailOr("spec.managed.roles names no analyst", fmt.Sprintf("%d role(s) declared", len(declared)), wanted == nil)))
		checks = append(checks, boolCheck(exists && canLogin,
			"The role exists in the database and may log in",
			fmt.Sprintf("exists: %v, can log in: %v", exists, canLogin)))
		checks = append(checks, boolCheck(isReconciled,
			"And the operator reports it reconciled",
			fmt.Sprintf("reconciled roles: %v; problems: %v", reconciled, problems)))

		// Connecting as the role is the only thing that proves the password from the Secret
		// really reached PostgreSQL.
		try := psqlAsUser(ctx, docker, server, cluster+"-rw", role, "analyst_pw", "app", "SELECT 1;")
		checks = append(checks, boolCheck(try.ok(),
			"You can connect as it with the password from the Secret",
			detailOr(firstLine(try.stderr), "connected and ran a query", !try.ok())))
		return finish(checks), nil

	case "the-operator-owns-it":
		var checks []CheckItem
		checks = append(checks, boolCheck(wanted != nil && wanted.CreateDB != nil && *wanted.CreateDB,
			"The Cluster now declares the role with createdb",
			detailOr("spec.managed.roles does not ask for createdb", "createdb: true is declared",
				wanted == nil || wanted.CreateDB == nil || !*wanted.CreateDB)))
		checks = append(checks, boolCheck(createDB,
			"And the database agrees",
			fmt.Sprintf("rolcreatedb is %v", createDB)))
		// The finding this objective is built on: an ALTER ROLE made outside the spec is *not*
		// reverted, and the operator goes on reporting the role as reconciled, because it
		// compares against what it last applied rather than against the database.
		body, found := readFileAnyNode(ctx, docker, a, "/root/drift.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "reconciled"),
			"/root/drift.txt records the operator calling the role reconciled",
			detailOr("file not found on any node", firstLine(body), !found)))
		checks = append(checks, boolCheck(canLogin && isReconciled && healthy,
			"And a later change to the spec put the LOGIN back",
			fmt.Sprintf("rolcanlogin is %v; reconciled: %v", canLogin, reconciled)))
		return finish(checks), nil

	case "remove-it":
		var checks []CheckItem
		absent := wanted != nil && wanted.Ensure == "absent"
		checks = append(checks, boolCheck(absent,
			"The Cluster asks for the role to be absent",
			detailOr("ensure is not absent", "ensure: absent", !absent)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/cannot-drop.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "objects in database"),
			"/root/cannot-drop.txt records why the first attempt could not be carried out",
			detailOr("file not found on any node", firstLine(body), !found)))

		checks = append(checks, boolCheck(!exists,
			"The role is gone from the database now that nothing depends on it",
			detailOr("analyst still exists", "no analyst role in pg_roles", exists)))
		checks = append(checks, boolCheck(len(problems) == 0 && healthy,
			"And the operator reports nothing it cannot reconcile",
			fmt.Sprintf("problems: %v, %s", problems, c.Status.Phase)))
		return finish(checks), nil
	}
	_ = comment
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-managed-roles", taskID)
}

/* ---- Lab 64: Password maintenance with Kubernetes Secrets ---- */

// secretView is what the password lab needs off a Secret: the password it holds, the
// resourceVersion the operator compares against, and whether it carries the label that puts it
// in the operator's watch set at all.
type secretView struct {
	password string
	rv       string
	reload   bool
	found    bool
}

func readSecret(ctx context.Context, k3d *K3D, server, name string) secretView {
	var sec struct {
		Metadata struct {
			ResourceVersion string            `json:"resourceVersion"`
			Labels          map[string]string `json:"labels"`
		} `json:"metadata"`
		Data map[string]string `json:"data"`
	}
	if err := kubectlJSON(ctx, k3d, server, &sec, "get", "secret", name); err != nil {
		return secretView{}
	}
	pw, _ := base64.StdEncoding.DecodeString(sec.Data["password"])
	return secretView{
		password: string(pw),
		rv:       sec.Metadata.ResourceVersion,
		reload:   sec.Metadata.Labels["cnpg.io/reload"] == "true",
		found:    true,
	}
}

// passwordStatusOf reads what the operator says it last applied for one role. The
// resourceVersion here is the Secret version it acted on — the whole lab turns on comparing it
// with the Secret's current one.
func passwordStatusOf(ctx context.Context, k3d *K3D, server, cluster, role string) (rv string, txID int64, present bool) {
	var c struct {
		Status struct {
			ManagedRolesStatus struct {
				PasswordStatus map[string]struct {
					ResourceVersion string `json:"resourceVersion"`
					TransactionID   int64  `json:"transactionID"`
				} `json:"passwordStatus"`
			} `json:"managedRolesStatus"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster); err != nil {
		return "", 0, false
	}
	st, ok := c.Status.ManagedRolesStatus.PasswordStatus[role]
	return st.ResourceVersion, st.TransactionID, ok
}

// rolePassword reads the two things pg_authid knows about a role's password: whether there is
// one at all, and when it stops being valid.
func rolePassword(ctx context.Context, docker *Docker, server, pod, role string) (noPassword bool, validUntil string, found bool) {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres", fmt.Sprintf(
		"SELECT (rolpassword IS NULL) || '|' || coalesce(rolvaliduntil::text, '') FROM pg_authid WHERE rolname = '%s';", role))
	if err != nil || !res.ok() || strings.TrimSpace(res.stdout) == "" {
		return false, "", false
	}
	parts := strings.SplitN(strings.TrimSpace(res.stdout), "|", 2)
	if len(parts) < 2 {
		return false, "", true
	}
	return strings.HasPrefix(parts[0], "t"), parts[1], true
}

// twoDifferentLines is how /root/not-rotated.txt is graded: the learner captures the Secret's
// resourceVersion and the one the operator had applied, and the point of the objective is that
// at that moment they disagreed.
func twoDifferentLines(body string) (a, b string, ok bool) {
	var lines []string
	for _, l := range strings.Split(body, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, strings.TrimSpace(l))
		}
	}
	if len(lines) < 2 {
		return "", "", false
	}
	return lines[0], lines[1], lines[0] != lines[1]
}

func checkRolePasswords(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	const role = "analyst"
	const secretName = "analyst-password"
	const oldPassword = "analyst_pw"   // what the environment created the role with
	const newPassword = "analyst_2026" // what the lab rotates to
	const sqlPassword = "out_of_band"  // what the learner sets behind the operator's back

	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	sec := readSecret(ctx, k3d, server, secretName)
	appliedRV, txID, hasStatus := passwordStatusOf(ctx, k3d, server, cluster, role)
	declared, reconciled, problems := readManagedRoles(ctx, k3d, server, cluster)

	var wanted *managedRole
	for i, r := range declared {
		if r.Name == role {
			wanted = &declared[i]
		}
	}
	isReconciled := false
	for _, n := range reconciled {
		if n == role {
			isReconciled = true
		}
	}
	connects := func(password string) sqlResult {
		return psqlAsUser(ctx, docker, server, cluster+"-rw", role, password, "app", "SELECT 1;")
	}

	switch taskID {
	case "rotate-the-secret":
		var checks []CheckItem
		checks = append(checks, boolCheck(sec.found && sec.password == newPassword,
			"The Secret holds the new password",
			detailOr("the Secret does not hold "+newPassword, "password is "+newPassword, !sec.found || sec.password != newPassword)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/not-rotated.txt")
		secretRV, applied, differ := twoDifferentLines(body)
		checks = append(checks, boolCheck(found && differ,
			"/root/not-rotated.txt caught the two versions disagreeing",
			detailOr("file not found on any node",
				fmt.Sprintf("Secret at %q, operator had applied %q", secretRV, applied), !found)))

		checks = append(checks, boolCheck(sec.reload,
			"The Secret carries cnpg.io/reload, which is what puts it in the operator's watch set",
			detailOr("no cnpg.io/reload label on the Secret", "cnpg.io/reload is true", !sec.reload)))

		newOK := connects(newPassword).ok()
		oldOK := connects(oldPassword).ok()
		checks = append(checks, boolCheck(newOK && !oldOK,
			"And the operator has applied it — the new password works, the old one is refused",
			fmt.Sprintf("new password connects: %v, old password connects: %v", newOK, oldOK)))
		return finish(checks), nil

	case "changed-in-sql":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/sql-password.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "reconciled"),
			"/root/sql-password.txt records the operator calling the role reconciled while the passwords disagreed",
			detailOr("file not found on any node", firstLine(body), !found)))

		secretOK := connects(newPassword).ok()
		sqlOK := connects(sqlPassword).ok()
		checks = append(checks, boolCheck(secretOK,
			"The Secret's password is back in force",
			fmt.Sprintf("connecting with the Secret's password: %v", secretOK)))
		checks = append(checks, boolCheck(!sqlOK,
			"And the one set in SQL no longer gets in",
			fmt.Sprintf("connecting with the out-of-band password: %v", sqlOK)))
		checks = append(checks, boolCheck(hasStatus && appliedRV == sec.rv && appliedRV != "",
			"Because the operator re-read the Secret it watches",
			fmt.Sprintf("Secret at %q, operator applied %q (transaction %d)", sec.rv, appliedRV, txID)))
		return finish(checks), nil

	case "expire-and-disable":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/expired.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "password authentication failed"),
			"/root/expired.txt records what PostgreSQL says about an expired password",
			detailOr("file not found on any node", firstLine(body), !found)))

		disabled := wanted != nil && wanted.DisablePassword != nil && *wanted.DisablePassword && wanted.PasswordSecret.Name == ""
		checks = append(checks, boolCheck(disabled,
			"The Cluster asks for the password to be disabled, with no Secret alongside it",
			detailOr("disablePassword is not set on its own",
				"disablePassword: true, no passwordSecret", !disabled)))

		noPassword, validUntil, exists := rolePassword(ctx, docker, server, c.Status.CurrentPrimary, role)
		checks = append(checks, boolCheck(exists && noPassword,
			"And the role's password really is NULL in pg_authid",
			detailOr("the role still has a password",
				fmt.Sprintf("rolpassword is NULL, rolvaliduntil %q", validUntil), !exists || !noPassword)))

		secretOK := connects(newPassword).ok()
		checks = append(checks, boolCheck(!secretOK && isReconciled && healthy && len(problems) == 0,
			"No password gets in, and the operator still reports the role reconciled",
			fmt.Sprintf("Secret password connects: %v, reconciled: %v, %s", secretOK, reconciled, c.Status.Phase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-role-passwords", taskID)
}

/* ---- Labs 65-68: tablespaces and declarative databases ---- */

// tablespaceEntry is one entry of spec.tablespaces, read back off the Cluster after the webhook
// has filled in the fields nobody wrote.
type tablespaceEntry struct {
	Name  string `json:"name"`
	Owner struct {
		Name string `json:"name"`
	} `json:"owner"`
	Temporary bool `json:"temporary"`
	Storage   struct {
		Size string `json:"size"`
	} `json:"storage"`
}

// readTablespaces returns what the Cluster declares and what the operator says it did about it.
func readTablespaces(ctx context.Context, k3d *K3D, server, cluster string) ([]tablespaceEntry, map[string]string) {
	var c struct {
		Spec struct {
			Tablespaces []tablespaceEntry `json:"tablespaces"`
		} `json:"spec"`
		Status struct {
			TablespacesStatus []struct {
				Name  string `json:"name"`
				State string `json:"state"`
			} `json:"tablespacesStatus"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster); err != nil {
		return nil, nil
	}
	states := map[string]string{}
	for _, t := range c.Status.TablespacesStatus {
		states[t.Name] = t.State
	}
	return c.Spec.Tablespaces, states
}

func tablespaceByName(list []tablespaceEntry, name string) (tablespaceEntry, bool) {
	for _, t := range list {
		if t.Name == name {
			return t, true
		}
	}
	return tablespaceEntry{}, false
}

// tablespaceClaims maps a tablespace name to the claims carrying its data — one per instance,
// labelled by the operator with the tablespace they belong to.
func tablespaceClaims(ctx context.Context, k3d *K3D, server string) map[string][]string {
	out := map[string][]string{}
	for _, c := range readClaims(ctx, k3d, server) {
		if name := c.Metadata.Labels["cnpg.io/tablespaceName"]; name != "" {
			out[name] = append(out[name], c.Metadata.Name)
		}
	}
	for _, v := range out {
		sort.Strings(v)
	}
	return out
}

// pgTablespaces reads what PostgreSQL itself knows: name and location, which is the only thing
// that settles whether a declaration became a tablespace.
func pgTablespaces(ctx context.Context, docker *Docker, server, pod string) map[string]string {
	out := map[string]string{}
	res, err := psqlSuper(ctx, docker, server, pod, "postgres",
		"SELECT spcname || '|' || coalesce(pg_tablespace_location(oid), '') FROM pg_tablespace ORDER BY spcname;")
	if err != nil || !res.ok() {
		return out
	}
	for _, line := range strings.Split(res.stdout, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "|", 2)
		if len(parts) == 2 {
			out[parts[0]] = parts[1]
		}
	}
	return out
}

// tableTablespace returns which tablespace a table lives in, per PostgreSQL.
func tableTablespace(ctx context.Context, docker *Docker, server, pod, table string) string {
	res, err := psqlSuper(ctx, docker, server, pod, "app",
		fmt.Sprintf("SELECT coalesce(tablespace, 'pg_default') FROM pg_tables WHERE tablename = '%s';", table))
	if err != nil || !res.ok() {
		return ""
	}
	return strings.TrimSpace(res.stdout)
}

// tempStats reads one instance's own temporary-file counters. They are per-instance — a standby
// counts the spills it served, and nothing is replicated.
func tempStats(ctx context.Context, docker *Docker, server, pod string) (files int, bytes int64) {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres",
		"SELECT temp_files || '|' || temp_bytes FROM pg_stat_database WHERE datname = 'app';")
	if err != nil || !res.ok() {
		return 0, 0
	}
	parts := strings.SplitN(strings.TrimSpace(res.stdout), "|", 2)
	if len(parts) < 2 {
		return 0, 0
	}
	f, _ := strconv.Atoi(parts[0])
	b, _ := strconv.ParseInt(parts[1], 10, 64)
	return f, b
}

func checkTablespaces(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, pods, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	declared, states := readTablespaces(ctx, k3d, server, cluster)
	claims := tablespaceClaims(ctx, k3d, server)
	spaces := pgTablespaces(ctx, docker, server, c.Status.CurrentPrimary)

	_, hasReporting := tablespaceByName(declared, "reporting")
	_, hasArchive := tablespaceByName(declared, "archive")
	bothReconciled := states["reporting"] == "reconciled" && states["archive"] == "reconciled"

	switch taskID {
	case "declare-them":
		var checks []CheckItem
		checks = append(checks, boolCheck(hasReporting && hasArchive,
			"The Cluster declares the reporting and archive tablespaces",
			fmt.Sprintf("%d declared: %v", len(declared), tablespaceNames(declared))))
		checks = append(checks, boolCheck(bothReconciled && healthy,
			"Both report reconciled, on a healthy cluster",
			fmt.Sprintf("reporting=%s archive=%s, %s", detailOr("(absent)", states["reporting"], states["reporting"] == ""),
				detailOr("(absent)", states["archive"], states["archive"] == ""), c.Status.Phase)))
		checks = append(checks, boolCheck(len(claims["reporting"]) == 3 && len(claims["archive"]) == 3,
			"Every instance has its own volume for each of them",
			fmt.Sprintf("reporting: %d claim(s), archive: %d claim(s)", len(claims["reporting"]), len(claims["archive"]))))
		bothInPG := spaces["reporting"] != "" && spaces["archive"] != ""
		checks = append(checks, boolCheck(bothInPG,
			"And PostgreSQL knows about both, with their own locations",
			detailOr("pg_tablespace does not have both",
				fmt.Sprintf("reporting at %s", spaces["reporting"]), !bothInPG)))
		return finish(checks), nil

	case "put-a-table-in-one":
		var checks []CheckItem
		where := tableTablespace(ctx, docker, server, c.Status.CurrentPrimary, "quarterly")
		checks = append(checks, boolCheck(where == "reporting",
			"A table called quarterly lives in the reporting tablespace",
			detailOr("no quarterly table on the primary", "pg_tables says "+where, where == "")))

		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM quarterly;")
		checks = append(checks, boolCheck(rows.count() == 1000,
			"It holds 1000 rows",
			fmt.Sprintf("%d row(s)", rows.count())))

		links, _ := execInPod(ctx, docker, server, c.Status.CurrentPrimary,
			"sh", "-c", "ls -l /var/lib/postgresql/data/pgdata/pg_tblspc/")
		linked := strings.Contains(links, "/var/lib/postgresql/tablespaces/reporting/data")
		checks = append(checks, boolCheck(linked,
			"Its files really are under /var/lib/postgresql/tablespaces/reporting on the primary",
			detailOr("pg_tblspc has no link to the reporting mount", firstLine(links), !linked)))

		replicasOK, detail := 0, []string{}
		for _, p := range replicaPods(c, pods) {
			r, _ := psqlSuper(ctx, docker, server, p, "app", "SELECT count(*) FROM quarterly;")
			if r.count() == 1000 && tableTablespace(ctx, docker, server, p, "quarterly") == "reporting" {
				replicasOK++
			}
			detail = append(detail, fmt.Sprintf("%s: %d", p, r.count()))
		}
		checks = append(checks, boolCheck(replicasOK == 2,
			"And every replica has the same rows in its own copy of the tablespace",
			strings.Join(detail, ", ")))
		return finish(checks), nil

	case "no-taking-it-back":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/no-delete.txt")
		refused := found && strings.Contains(body, "no tablespace can be deleted once created")
		checks = append(checks, boolCheck(refused,
			"/root/no-delete.txt records the operator refusing to remove one",
			detailOr("file not found on any node", firstLine(body), !found)))

		checks = append(checks, boolCheck(hasReporting && hasArchive && bothReconciled,
			"Both tablespaces are still declared, and still reconciled",
			fmt.Sprintf("declared: %v, states: reporting=%s archive=%s", tablespaceNames(declared),
				states["reporting"], states["archive"])))

		arch, _ := tablespaceByName(declared, "archive")
		defaulted := arch.Owner.Name != "" && !arch.Temporary
		checks = append(checks, boolCheck(defaulted,
			"The owner the webhook filled in is on the tablespace nobody gave one to",
			fmt.Sprintf("archive owner is %q, temporary %v", arch.Owner.Name, arch.Temporary)))

		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM quarterly;")
		checks = append(checks, boolCheck(rows.count() == 1000 && healthy,
			"And the table inside one of them is still readable",
			fmt.Sprintf("%d row(s), %s", rows.count(), c.Status.Phase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-tablespaces", taskID)
}

func tablespaceNames(list []tablespaceEntry) []string {
	out := make([]string, 0, len(list))
	for _, t := range list {
		out = append(out, t.Name)
	}
	return out
}

func checkTemporaryTablespaces(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, pods, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	declared, states := readTablespaces(ctx, k3d, server, cluster)
	scratch, hasScratch := tablespaceByName(declared, "scratch")
	claims := tablespaceClaims(ctx, k3d, server)

	tempGUC := func(pod string) string {
		res, err := psqlSuper(ctx, docker, server, pod, "postgres", "SHOW temp_tablespaces;")
		if err != nil || !res.ok() {
			return ""
		}
		return strings.TrimSpace(res.stdout)
	}

	switch taskID {
	case "declare-a-temporary-one":
		var checks []CheckItem
		checks = append(checks, boolCheck(hasScratch && scratch.Temporary,
			"The Cluster declares scratch as a temporary tablespace",
			fmt.Sprintf("declared: %v, temporary: %v", tablespaceNames(declared), scratch.Temporary)))
		checks = append(checks, boolCheck(states["scratch"] == "reconciled" && healthy,
			"It reports reconciled, on a healthy cluster",
			fmt.Sprintf("state %q, %s", states["scratch"], c.Status.Phase)))
		checks = append(checks, boolCheck(len(claims["scratch"]) == 3,
			"Every instance has its own volume for it",
			fmt.Sprintf("%d claim(s): %v", len(claims["scratch"]), claims["scratch"])))

		onAll, detail := 0, []string{}
		for _, p := range pods.Items {
			g := tempGUC(p.Metadata.Name)
			if g == "scratch" {
				onAll++
			}
			detail = append(detail, fmt.Sprintf("%s: %q", p.Metadata.Name, g))
		}
		checks = append(checks, boolCheck(onAll == len(pods.Items) && onAll > 0,
			"And temp_tablespaces names it on every instance, not just the primary",
			strings.Join(detail, ", ")))
		return finish(checks), nil

	case "where-temp-objects-go":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/temp-table.txt")
		landed := found && strings.Contains(body, "scratch")
		checks = append(checks, boolCheck(landed,
			"/root/temp-table.txt shows a temporary table landing in scratch",
			detailOr("file not found on any node", firstLine(body), !found)))

		files, bytes := tempStats(ctx, docker, server, c.Status.CurrentPrimary)
		checks = append(checks, boolCheck(files > 0,
			"The primary has written temporary files for the app database",
			fmt.Sprintf("temp_files %d", files)))
		checks = append(checks, boolCheck(bytes > 10<<20,
			"And enough of them that the sort really spilled to disk",
			fmt.Sprintf("temp_bytes %d", bytes)))

		// The data directory keeps a pgsql_tmp of its own — PostgreSQL makes it at startup —
		// and the whole point of the objective is that it stays *empty* while the tablespace
		// fills up. Counting entries is the honest test; checking the directory is absent is not.
		out, _ := execInPod(ctx, docker, server, c.Status.CurrentPrimary,
			"sh", "-c", "ls -1 /var/lib/postgresql/data/pgdata/base/pgsql_tmp 2>/dev/null | wc -l")
		emptyInData := strings.TrimSpace(out) == "0"
		checks = append(checks, boolCheck(emptyInData && healthy,
			"While the data directory's own pgsql_tmp stayed empty",
			fmt.Sprintf("%q entries in base/pgsql_tmp, %s", firstLine(out), c.Status.Phase)))
		return finish(checks), nil

	case "the-standbys-spill-too":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/replica-spill.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "temp_files"),
			"/root/replica-spill.txt records a standby's own temporary-file counters",
			detailOr("file not found on any node", firstLine(body), !found)))

		spilled, detail := 0, []string{}
		for _, p := range replicaPods(c, pods) {
			f, b := tempStats(ctx, docker, server, p)
			if f > 0 && b > 1<<20 {
				spilled++
			}
			detail = append(detail, fmt.Sprintf("%s: %d file(s), %d bytes", p, f, b))
		}
		checks = append(checks, boolCheck(spilled >= 1,
			"A standby has written temporary files of its own",
			strings.Join(detail, ", ")))
		checks = append(checks, boolCheck(len(claims["scratch"]) == 3,
			"Each standby has its own scratch volume to write them to",
			fmt.Sprintf("%d claim(s): %v", len(claims["scratch"]), claims["scratch"])))
		checks = append(checks, boolCheck(healthy && states["scratch"] == "reconciled",
			"And the cluster is healthy throughout",
			fmt.Sprintf("%s, scratch %s", c.Status.Phase, states["scratch"])))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-temporary-tablespaces", taskID)
}

// databaseObj is a Database resource as the two declarative-database labs read it.
type databaseObj struct {
	Metadata struct {
		Name              string   `json:"name"`
		Finalizers        []string `json:"finalizers"`
		DeletionTimestamp string   `json:"deletionTimestamp"`
	} `json:"metadata"`
	Spec struct {
		Name                  string `json:"name"`
		Owner                 string `json:"owner"`
		Ensure                string `json:"ensure"`
		DatabaseReclaimPolicy string `json:"databaseReclaimPolicy"`
		Cluster               struct {
			Name string `json:"name"`
		} `json:"cluster"`
	} `json:"spec"`
	Status struct {
		Applied            *bool  `json:"applied"`
		Message            string `json:"message"`
		ObservedGeneration int64  `json:"observedGeneration"`
	} `json:"status"`
}

func (d databaseObj) isApplied() bool { return d.Status.Applied != nil && *d.Status.Applied }

func readDatabases(ctx context.Context, k3d *K3D, server string) []databaseObj {
	var list struct {
		Items []databaseObj `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "database.postgresql.cnpg.io"); err != nil {
		return nil
	}
	sort.Slice(list.Items, func(i, j int) bool { return list.Items[i].Metadata.Name < list.Items[j].Metadata.Name })
	return list.Items
}

func databaseByObject(list []databaseObj, name string) (databaseObj, bool) {
	for _, d := range list {
		if d.Metadata.Name == name {
			return d, true
		}
	}
	return databaseObj{}, false
}

// pgDatabase answers what PostgreSQL has, which is the only thing a reclaim policy is about.
func pgDatabase(ctx context.Context, docker *Docker, server, pod, name string) (exists bool, owner string) {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres", fmt.Sprintf(
		"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '%s';", name))
	if err != nil || !res.ok() || strings.TrimSpace(res.stdout) == "" {
		return false, ""
	}
	return true, strings.TrimSpace(res.stdout)
}

func checkDeclarativeDatabases(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	dbs := readDatabases(ctx, k3d, server)
	obj, hasObj := databaseByObject(dbs, "reporting-db")
	exists, owner := pgDatabase(ctx, docker, server, c.Status.CurrentPrimary, "reporting")

	switch taskID {
	case "declare-a-database":
		var checks []CheckItem
		checks = append(checks, boolCheck(hasObj && obj.isApplied(),
			"A Database object called reporting-db reports applied",
			detailOr("no reporting-db object", fmt.Sprintf("applied %v, message %q", obj.isApplied(), obj.Status.Message), !hasObj)))
		checks = append(checks, boolCheck(exists && owner == "app",
			"The reporting database exists in PostgreSQL, owned by app",
			detailOr("no reporting database", "owner is "+owner, !exists)))
		checks = append(checks, boolCheck(obj.Spec.DatabaseReclaimPolicy == "retain" && obj.Spec.Ensure == "present",
			"Its reclaim policy is retain — the default nobody wrote",
			fmt.Sprintf("databaseReclaimPolicy %q, ensure %q", obj.Spec.DatabaseReclaimPolicy, obj.Spec.Ensure)))
		hasFinalizer := false
		for _, f := range obj.Metadata.Finalizers {
			if f == "cnpg.io/deleteDatabase" {
				hasFinalizer = true
			}
		}
		checks = append(checks, boolCheck(hasFinalizer && healthy,
			"And the object carries the cnpg.io/deleteDatabase finalizer",
			fmt.Sprintf("finalizers %v, %s", obj.Metadata.Finalizers, c.Status.Phase)))
		return finish(checks), nil

	case "one-object-owns-it":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/already-managed.txt")
		refused := found && strings.Contains(body, "already managed by object")
		checks = append(checks, boolCheck(refused,
			"/root/already-managed.txt records the second object being turned away",
			detailOr("file not found on any node", firstLine(body), !found)))

		_, dupStillThere := databaseByObject(dbs, "reporting-dup")
		checks = append(checks, boolCheck(!dupStillThere,
			"The duplicate object has been removed again",
			detailOr("reporting-dup is still there", "no reporting-dup object", dupStillThere)))

		checks = append(checks, boolCheck(hasObj && obj.isApplied() && obj.Status.Message == "",
			"The original is still applied, with nothing to report",
			fmt.Sprintf("applied %v, message %q", obj.isApplied(), obj.Status.Message)))

		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "reporting", "SELECT count(*) FROM ledger;")
		checks = append(checks, boolCheck(rows.count() == 3,
			"And the table you created inside the database holds 3 rows",
			fmt.Sprintf("%d row(s)", rows.count())))
		return finish(checks), nil

	case "delete-the-object-keep-the-database":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/retained.txt")
		kept := found && strings.Contains(body, "reporting")
		checks = append(checks, boolCheck(kept,
			"/root/retained.txt records the database still there after the object went",
			detailOr("file not found on any node", firstLine(body), !found)))

		checks = append(checks, boolCheck(exists && owner == "app",
			"The reporting database survived the deletion",
			detailOr("no reporting database", "owner is "+owner, !exists)))

		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "reporting", "SELECT count(*) FROM ledger;")
		checks = append(checks, boolCheck(rows.count() == 3,
			"With its table and rows untouched",
			fmt.Sprintf("%d row(s)", rows.count())))

		checks = append(checks, boolCheck(hasObj && obj.isApplied() && healthy,
			"And a Database object declaring it again has adopted it",
			fmt.Sprintf("applied %v, message %q, %s", obj.isApplied(), obj.Status.Message, c.Status.Phase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-declarative-databases", taskID)
}

func checkDatabaseReclaim(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	dbs := readDatabases(ctx, k3d, server)
	tempObj, hasTemp := databaseByObject(dbs, "temp-db")
	keepObj, hasKeep := databaseByObject(dbs, "keep-db")
	tempExists, _ := pgDatabase(ctx, docker, server, c.Status.CurrentPrimary, "tempdb")
	keepExists, keepOwner := pgDatabase(ctx, docker, server, c.Status.CurrentPrimary, "keepdb")

	switch taskID {
	case "two-policies":
		var checks []CheckItem
		checks = append(checks, boolCheck(hasTemp && tempObj.isApplied() && hasKeep && keepObj.isApplied(),
			"Both Database objects report applied",
			fmt.Sprintf("temp-db applied %v, keep-db applied %v", tempObj.isApplied(), keepObj.isApplied())))
		checks = append(checks, boolCheck(tempExists && keepExists && keepOwner == "app",
			"Both databases exist in PostgreSQL",
			fmt.Sprintf("tempdb %v, keepdb %v", tempExists, keepExists)))
		checks = append(checks, boolCheck(tempObj.Spec.DatabaseReclaimPolicy == "delete",
			"tempdb is declared with the delete reclaim policy",
			fmt.Sprintf("policy %q", tempObj.Spec.DatabaseReclaimPolicy)))
		checks = append(checks, boolCheck(keepObj.Spec.DatabaseReclaimPolicy == "retain" && healthy,
			"And keepdb with retain, so the two can be compared",
			fmt.Sprintf("policy %q, %s", keepObj.Spec.DatabaseReclaimPolicy, c.Status.Phase)))
		return finish(checks), nil

	case "delete-takes-it-with-it":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/blocked.txt")
		blocked := found && strings.Contains(body, "deletionTimestamp")
		checks = append(checks, boolCheck(blocked,
			"/root/blocked.txt records the object waiting on its finalizer, with a deletionTimestamp",
			detailOr("file not found on any node", firstLine(body), !found)))

		checks = append(checks, boolCheck(!hasTemp,
			"The temp-db object is gone now that nothing is connected",
			detailOr("temp-db is still there", "no temp-db object", hasTemp)))
		checks = append(checks, boolCheck(!tempExists,
			"And tempdb went with it — that is what delete means",
			detailOr("tempdb still exists", "no tempdb in pg_database", tempExists)))
		checks = append(checks, boolCheck(keepExists && hasKeep && healthy,
			"While keepdb, on the other policy, is untouched",
			fmt.Sprintf("keepdb %v, keep-db object %v, %s", keepExists, hasKeep, c.Status.Phase)))
		return finish(checks), nil

	case "absent-is-not-the-same":
		var checks []CheckItem
		checks = append(checks, boolCheck(hasKeep && keepObj.Spec.Ensure == "absent",
			"The keep-db object now asks for the database to be absent",
			detailOr("keep-db does not ask for absent", "ensure: absent", !hasKeep || keepObj.Spec.Ensure != "absent")))
		checks = append(checks, boolCheck(!keepExists,
			"keepdb has been dropped",
			detailOr("keepdb still exists", "no keepdb in pg_database", keepExists)))
		checks = append(checks, boolCheck(hasKeep && keepObj.isApplied(),
			"But the object is still there, and still reports applied",
			fmt.Sprintf("object present %v, applied %v", hasKeep, keepObj.isApplied())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/absent.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "keep-db") && healthy,
			"And /root/absent.txt records the object outliving its database",
			detailOr("file not found on any node", firstLine(body), !found)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-database-reclaim", taskID)
}

/* ---- Lab 69: backing up and restoring a cluster with tablespaces ---- */

// backupWAL reads what a completed Backup says about where it begins, which is the segment the
// archive has to contain before that backup can be restored at all.
func backupWAL(ctx context.Context, k3d *K3D, server string) (name, phase, beginWal string) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Phase    string `json:"phase"`
				BeginWal string `json:"beginWal"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "backup"); err != nil || len(list.Items) == 0 {
		return "", "", ""
	}
	b := list.Items[0]
	return b.Metadata.Name, b.Status.Phase, b.Status.BeginWal
}

func checkTablespaceBackup(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	_, states := readTablespaces(ctx, k3d, server, cluster)

	switch taskID {
	case "take-a-backup":
		var checks []CheckItem
		name, phase, beginWal := backupWAL(ctx, k3d, server)
		checks = append(checks, boolCheck(name != "" && phase == "completed",
			"A backup of the cluster completed",
			detailOr("no Backup object yet", fmt.Sprintf("%s is %s", name, phase), name == "")))
		checks = append(checks, boolCheck(beginWal != "",
			"It records the WAL segment it begins from",
			detailOr("no beginWal on the backup", "beginWal "+beginWal, beginWal == "")))

		body, found := readFileAnyNode(ctx, docker, a, "/root/first-wal.txt")
		named := found && beginWal != "" && strings.Contains(body, beginWal)
		checks = append(checks, boolCheck(named,
			"/root/first-wal.txt names that segment",
			detailOr("file not found on any node", firstLine(body), !found)))

		// The segment a backup starts in has to be closed before it can be shipped, and an idle
		// database will sit in it indefinitely — which is what makes an apparently completed
		// backup unrestorable. Comparing the current segment with the backup's is the check.
		cur, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT pg_walfile_name(pg_current_wal_lsn());")
		current := strings.TrimSpace(cur.stdout)
		moved := current != "" && beginWal != "" && current > beginWal
		archiving, _ := clusterConditionOf(ctx, k3d, server, cluster, "ContinuousArchiving")
		checks = append(checks, boolCheck(moved && archiving == "True" && healthy,
			"And the database has moved past it, so the archive has the whole segment",
			fmt.Sprintf("backup begins in %s, the primary is now writing %s, ContinuousArchiving %s",
				beginWal, current, archiving)))
		return finish(checks), nil

	case "forget-the-tablespaces":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/forgot.txt")
		refused := found && strings.Contains(body, "Read-only file system") &&
			strings.Contains(body, "/var/lib/postgresql/tablespaces")
		checks = append(checks, boolCheck(refused,
			"/root/forgot.txt records the restore failing on a read-only /var/lib/postgresql/tablespaces",
			detailOr("file not found on any node", firstLine(body), !found)))

		phaseBody, phaseFound := readFileAnyNode(ctx, docker, a, "/root/forgot-phase.txt")
		stuck := phaseFound && strings.Contains(phaseBody, "Setting up primary")
		checks = append(checks, boolCheck(stuck,
			"/root/forgot-phase.txt shows it stuck at Setting up primary, never becoming an instance",
			detailOr("file not found on any node", firstLine(phaseBody), !phaseFound)))

		_, _, gone := clusterPhase(ctx, k3d, server, "pg-forgot")
		checks = append(checks, boolCheck(!gone,
			"The failed cluster has been removed again",
			detailOr("pg-forgot is still there", "no pg-forgot cluster", gone)))

		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM quarterly;")
		checks = append(checks, boolCheck(rows.count() == 500 && healthy && states["reporting"] == "reconciled",
			"And the cluster it was recovering from never noticed",
			fmt.Sprintf("%d row(s), %s, reporting %s", rows.count(), c.Status.Phase, states["reporting"])))
		return finish(checks), nil

	case "recover-with-them":
		var checks []CheckItem
		phase, ready, exists := clusterPhase(ctx, k3d, server, "pg-restored")
		checks = append(checks, boolCheck(exists && phase == "Cluster in healthy state" && ready == 1,
			"A cluster named pg-restored reports healthy",
			detailOr("pg-restored does not exist yet", fmt.Sprintf("%s, %d/1 ready", phase, ready), !exists)))

		claims := tablespaceClaims(ctx, k3d, server)
		own := false
		for _, n := range claims["reporting"] {
			if n == "pg-restored-1-tbs-reporting" {
				own = true
			}
		}
		checks = append(checks, boolCheck(own,
			"It has a volume of its own for the reporting tablespace",
			fmt.Sprintf("claims for reporting: %v", claims["reporting"])))

		rows, _ := psqlSuper(ctx, docker, server, "pg-restored-1", "app", "SELECT count(*) FROM quarterly;")
		where := tableTablespace(ctx, docker, server, "pg-restored-1", "quarterly")
		checks = append(checks, boolCheck(rows.count() == 500 && where == "reporting",
			"The quarterly table is there, still in that tablespace, with its 500 rows",
			fmt.Sprintf("%d row(s), tablespace %q", rows.count(), where)))

		src, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM quarterly;")
		checks = append(checks, boolCheck(src.count() == 500 && healthy,
			"And the cluster it was recovered from is untouched",
			fmt.Sprintf("%d row(s), %s", src.count(), c.Status.Phase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-tablespace-backup", taskID)
}

/* ---- Lab 70: snapshot backup and recovery of a cluster with tablespaces ---- */

// snapshotRow is a VolumeSnapshot as the tablespace-snapshot lab reads it: whether it is usable,
// which claim it came from, and which tablespace it holds if it holds one.
type snapshotRow struct {
	name       string
	ready      bool
	sourcePVC  string
	tablespace string
}

func readSnapshots(ctx context.Context, k3d *K3D, server string) []snapshotRow {
	var list struct {
		Items []struct {
			Metadata struct {
				Name   string            `json:"name"`
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
			Spec struct {
				Source struct {
					PersistentVolumeClaimName string `json:"persistentVolumeClaimName"`
				} `json:"source"`
			} `json:"spec"`
			Status struct {
				ReadyToUse *bool `json:"readyToUse"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &list, "get", "volumesnapshot"); err != nil {
		return nil
	}
	var out []snapshotRow
	for _, s := range list.Items {
		out = append(out, snapshotRow{
			name:       s.Metadata.Name,
			ready:      s.Status.ReadyToUse != nil && *s.Status.ReadyToUse,
			sourcePVC:  s.Spec.Source.PersistentVolumeClaimName,
			tablespace: s.Metadata.Labels["cnpg.io/tablespaceName"],
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func snapshotByName(list []snapshotRow, name string) (snapshotRow, bool) {
	for _, s := range list {
		if s.name == name {
			return s, true
		}
	}
	return snapshotRow{}, false
}

func snapshotNamesOf(list []snapshotRow) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		out = append(out, s.name)
	}
	return out
}

func checkTablespaceSnapshot(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const backupName = "daily-snapshot"
	const tbsSnapshot = backupName + "-tbs-reporting"
	c, _, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 1
	snaps := readSnapshots(ctx, k3d, server)

	switch taskID {
	case "snapshot-every-volume":
		var checks []CheckItem
		backups := readBackups(ctx, k3d, server)
		done := false
		for _, b := range backups {
			if b.name == backupName && b.phase == "completed" {
				done = true
			}
		}
		checks = append(checks, boolCheck(done,
			"The volumeSnapshot backup completed",
			fmt.Sprintf("%d backup(s): %v", len(backups), backups)))

		data, hasData := snapshotByName(snaps, backupName)
		tbs, hasTbs := snapshotByName(snaps, tbsSnapshot)
		checks = append(checks, boolCheck(hasData && hasTbs,
			"It produced one VolumeSnapshot per volume, not one for the cluster",
			fmt.Sprintf("%d snapshot(s): %v", len(snaps), snapshotNamesOf(snaps))))
		checks = append(checks, boolCheck(hasTbs && tbs.tablespace == "reporting" &&
			tbs.sourcePVC == "pg-cluster-1-tbs-reporting",
			"The tablespace's snapshot says which tablespace it holds",
			fmt.Sprintf("%s: tablespace %q, from claim %q", tbsSnapshot, tbs.tablespace, tbs.sourcePVC)))
		checks = append(checks, boolCheck(hasData && data.ready && hasTbs && tbs.ready && healthy,
			"Both are ready to use, and the cluster never stopped serving",
			fmt.Sprintf("data ready %v, tablespace ready %v, %s", data.ready, tbs.ready, c.Status.Phase)))
		return finish(checks), nil

	case "forget-the-mapping":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/missing-source.txt")
		named := found && strings.Contains(body, "missing StorageSource for tablespace")
		checks = append(checks, boolCheck(named,
			"/root/missing-source.txt records the operator refusing to create the claims",
			detailOr("file not found on any node", firstLine(body), !found)))

		stalledBody, stalledFound := readFileAnyNode(ctx, docker, a, "/root/stalled.txt")
		checks = append(checks, boolCheck(stalledFound && strings.Contains(stalledBody, "pg-half"),
			"/root/stalled.txt records the half-mapped cluster with nothing running",
			detailOr("file not found on any node", firstLine(stalledBody), !stalledFound)))

		_, _, stillThere := clusterPhase(ctx, k3d, server, "pg-half")
		checks = append(checks, boolCheck(!stillThere,
			"The half-mapped cluster has been removed again",
			detailOr("pg-half is still there", "no pg-half cluster", stillThere)))

		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM quarterly;")
		checks = append(checks, boolCheck(rows.count() == 500 && healthy,
			"And nothing was taken from the cluster you snapshotted",
			fmt.Sprintf("%d row(s), %s", rows.count(), c.Status.Phase)))
		return finish(checks), nil

	case "map-them-back":
		var checks []CheckItem
		phase, ready, exists := clusterPhase(ctx, k3d, server, "pg-restored")
		checks = append(checks, boolCheck(exists && phase == "Cluster in healthy state" && ready == 1,
			"A cluster named pg-restored reports healthy",
			detailOr("pg-restored does not exist yet", fmt.Sprintf("%s, %d/1 ready", phase, ready), !exists)))

		claims := readClaims(ctx, k3d, server)
		from := func(claimName, snapshot string) bool {
			cl, ok := claimByName(claims, claimName)
			return ok && cl.Spec.DataSource != nil && cl.Spec.DataSource.Kind == "VolumeSnapshot" &&
				cl.Spec.DataSource.Name == snapshot
		}
		dataOK := from("pg-restored-1", backupName)
		tbsOK := from("pg-restored-1-tbs-reporting", tbsSnapshot)
		checks = append(checks, boolCheck(dataOK,
			"Its data volume was created from the data snapshot",
			fmt.Sprintf("pg-restored-1 from %s: %v", backupName, dataOK)))
		checks = append(checks, boolCheck(tbsOK,
			"And its tablespace volume from the tablespace's own snapshot",
			fmt.Sprintf("pg-restored-1-tbs-reporting from %s: %v", tbsSnapshot, tbsOK)))

		rows, _ := psqlSuper(ctx, docker, server, "pg-restored-1", "app", "SELECT count(*) FROM quarterly;")
		where := tableTablespace(ctx, docker, server, "pg-restored-1", "quarterly")
		checks = append(checks, boolCheck(rows.count() == 500 && where == "reporting",
			"With the quarterly table still in the reporting tablespace, all 500 rows",
			fmt.Sprintf("%d row(s), tablespace %q", rows.count(), where)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-tablespace-snapshot", taskID)
}

/* ---- Lab 71: declarative major version upgrade ---- */

// pgDataImageInfo is what the operator records about the image that last ran on the data
// directory — the field it compares against to notice a major version change at all.
func pgDataMajor(ctx context.Context, k3d *K3D, server, cluster string) (image string, major int) {
	var c struct {
		Status struct {
			Image           string `json:"image"`
			PGDataImageInfo struct {
				Image        string `json:"image"`
				MajorVersion int    `json:"majorVersion"`
			} `json:"pgDataImageInfo"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", cluster); err != nil {
		return "", 0
	}
	return c.Status.Image, c.Status.PGDataImageInfo.MajorVersion
}

// serverVersion is what PostgreSQL itself says, which is the only thing that settles whether an
// upgrade happened rather than an image tag being edited.
func serverVersion(ctx context.Context, docker *Docker, server, pod string) string {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres", "SHOW server_version;")
	if err != nil || !res.ok() {
		return ""
	}
	return strings.TrimSpace(res.stdout)
}

func showSetting(ctx context.Context, docker *Docker, server, pod, name string) string {
	res, err := psqlSuper(ctx, docker, server, pod, "postgres", "SHOW "+name+";")
	if err != nil || !res.ok() {
		return ""
	}
	return strings.TrimSpace(res.stdout)
}

// tableStats reads the two numbers a major upgrade does not carry across: the planner's row
// estimate and how many columns have statistics at all.
func tableStats(ctx context.Context, docker *Docker, server, pod, table string) (reltuples float64, statColumns int) {
	res, err := psqlSuper(ctx, docker, server, pod, "app", fmt.Sprintf(
		"SELECT reltuples || '|' || (SELECT count(*) FROM pg_stats WHERE tablename = '%s') FROM pg_class WHERE relname = '%s';",
		table, table))
	if err != nil || !res.ok() {
		return 0, 0
	}
	parts := strings.SplitN(strings.TrimSpace(res.stdout), "|", 2)
	if len(parts) < 2 {
		return 0, 0
	}
	rt, _ := strconv.ParseFloat(parts[0], 64)
	sc, _ := strconv.Atoi(parts[1])
	return rt, sc
}

func checkMajorUpgrade(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const cluster = "pg-cluster"
	c, pods, err := readCluster(ctx, k3d, server)
	if err != nil {
		return CheckResult{}, err
	}
	healthy := c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3
	image, major := pgDataMajor(ctx, k3d, server, cluster)
	version := serverVersion(ctx, docker, server, c.Status.CurrentPrimary)

	switch taskID {
	case "change-the-image":
		var checks []CheckItem
		checks = append(checks, boolCheck(strings.HasPrefix(version, "18."),
			"The primary really is running PostgreSQL 18 now",
			detailOr("could not read server_version", "server_version is "+version, version == "")))
		checks = append(checks, boolCheck(major == 18 && strings.Contains(image, "18"),
			"And the operator records the data directory as major 18",
			fmt.Sprintf("pgDataImageInfo major %d, image %s", major, image)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/upgrade-job.txt")
		bothImages := found && strings.Contains(body, "17-system-trixie") &&
			strings.Contains(body, "18.4-system-trixie")
		checks = append(checks, boolCheck(bothImages,
			"/root/upgrade-job.txt shows the upgrade job carrying both PostgreSQL versions",
			detailOr("file not found on any node", firstLine(body), !found)))

		rows, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM notes;")
		checks = append(checks, boolCheck(rows.count() == 50 && healthy,
			"The 50 rows came across, on a healthy 3-instance cluster",
			fmt.Sprintf("%d row(s), %s, %d/3 ready", rows.count(), c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "kept-and-rebuilt":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/volumes.txt")
		checks = append(checks, boolCheck(found && strings.Contains(body, "pg-cluster-1"),
			"/root/volumes.txt records what happened to each instance's volume",
			detailOr("file not found on any node", firstLine(body), !found)))

		claims := readClaims(ctx, k3d, server)
		primaryClaim, okP := claimByName(claims, c.Status.CurrentPrimary)
		younger, total := 0, 0
		for _, p := range replicaPods(c, pods) {
			if cl, ok := claimByName(claims, p); ok {
				total++
				if okP && cl.Metadata.CreationTimestamp.After(primaryClaim.Metadata.CreationTimestamp) {
					younger++
				}
			}
		}
		checks = append(checks, boolCheck(okP && total == 2 && younger == 2,
			"The replica volumes are younger than the primary's — they were rebuilt, it was not",
			fmt.Sprintf("%d of %d replica claim(s) newer than %s", younger, total, primaryClaim.Metadata.Name)))

		refusal, refusalFound := readFileAnyNode(ctx, docker, a, "/root/no-downgrade.txt")
		refused := refusalFound && strings.Contains(refusal, "can't downgrade from major")
		checks = append(checks, boolCheck(refused,
			"/root/no-downgrade.txt records the refusal to go back",
			detailOr("file not found on any node", firstLine(refusal), !refusalFound)))

		streaming, _ := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';")
		checks = append(checks, boolCheck(streaming.count() == 2 && healthy,
			"And both replicas are streaming from the upgraded primary",
			fmt.Sprintf("%d streaming, %s", streaming.count(), c.Status.Phase)))
		return finish(checks), nil

	case "what-it-left-behind":
		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/no-stats.txt")
		// reltuples of -1 is PostgreSQL's "never analysed", and it is what the upgraded table
		// reported before the learner ran ANALYZE.
		noStats := found && strings.Contains(body, "-1")
		checks = append(checks, boolCheck(noStats,
			"/root/no-stats.txt records the table with no statistics after the upgrade",
			detailOr("file not found on any node", firstLine(body), !found)))

		reltuples, statCols := tableStats(ctx, docker, server, c.Status.CurrentPrimary, "notes")
		checks = append(checks, boolCheck(reltuples > 0 && statCols > 0,
			"ANALYZE has given the planner its numbers back",
			fmt.Sprintf("reltuples %.0f, %d column(s) with statistics", reltuples, statCols)))

		freshPhase, freshReady, freshExists := clusterPhase(ctx, k3d, server, "pg-fresh")
		freshChecksums := ""
		if freshExists {
			freshChecksums = showSetting(ctx, docker, server, "pg-fresh-1", "data_checksums")
		}
		checks = append(checks, boolCheck(freshExists && freshReady == 1 && freshChecksums == "on",
			"A freshly bootstrapped PostgreSQL 18 cluster has data checksums on",
			detailOr("no healthy pg-fresh cluster",
				fmt.Sprintf("%s, data_checksums %q", freshPhase, freshChecksums), !freshExists || freshReady != 1)))

		upgradedChecksums := showSetting(ctx, docker, server, c.Status.CurrentPrimary, "data_checksums")
		checks = append(checks, boolCheck(upgradedChecksums == "off" && healthy,
			"While the upgraded cluster still has them off, as PostgreSQL 17 created it",
			fmt.Sprintf("data_checksums %q, %s", upgradedChecksums, c.Status.Phase)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-major-upgrade", taskID)
}

// readCluster is the starting point of nearly every check below: the live Cluster resource,
// its Pods, and which of them is primary right now.
func readCluster(ctx context.Context, k3d *K3D, server string) (cnpgCluster, podList, error) {
	var c cnpgCluster
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
		return c, podList{}, err
	}
	var pods podList
	err := kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
	return c, pods, err
}

// replicaPods lists the instance Pods that are not the current primary.
func replicaPods(c cnpgCluster, pods podList) []string {
	var out []string
	for _, p := range pods.Items {
		if p.Metadata.Name != c.Status.CurrentPrimary {
			out = append(out, p.Metadata.Name)
		}
	}
	sort.Strings(out)
	return out
}

var nodeLabIDs = []string{"k3d-server", "k3d-agent-1", "k3d-agent-2"}

/* ---- Lab 1: Installing the Operator ---- */

func checkOperatorInstall(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "survey":
		var nl nodeList
		if err := kubectlJSON(ctx, k3d, server, &nl, "get", "nodes"); err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		readyCount := 0
		var controlPlane string
		for _, n := range nl.Items {
			if nl.ready(n.Metadata.Name) {
				readyCount++
			}
			if _, ok := n.Metadata.Labels["node-role.kubernetes.io/control-plane"]; ok {
				controlPlane = n.Metadata.Name
			}
		}
		checks = append(checks, boolCheck(readyCount == 3, "All 3 nodes report Ready", fmt.Sprintf("%d of 3", readyCount)))
		checks = append(checks, boolCheck(controlPlane != "", "Exactly one node is control-plane", controlPlane))

		body, found := readFileAnyNode(ctx, docker, a, "/root/control-plane.txt")
		if !found {
			checks = append(checks, noItem("/root/control-plane.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/control-plane.txt was written", "found"))
		// Same real-vs-alias translation as the persistent-volume lab's pinned-node check:
		// kubectl only ever prints the raw k3d container name, never this app's clean alias.
		answer := strings.TrimSpace(body)
		namedLabID := a.labIDForContainerName(answer)
		if namedLabID == "" {
			namedLabID = namedIn(nodeLabIDs, answer)
		}
		controlPlaneLabID := a.labIDForContainerName(controlPlane)
		checks = append(checks, boolCheck(namedLabID != "" && namedLabID == controlPlaneLabID,
			"It names the control-plane node", fmt.Sprintf("file says %q, control-plane is %q", answer, controlPlane)))
		return finish(checks), nil

	case "install-operator":
		var checks []CheckItem

		// The Cluster CRD specifically, and its Established condition specifically: a CRD can
		// exist without the API server having accepted it yet, and until it is Established no
		// `kubectl get cluster` will work.
		var clusterCRD struct {
			Status struct {
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		}
		established := ""
		if err := kubectlJSON(ctx, k3d, server, &clusterCRD, "get", "crd", cnpgClusterCRD); err == nil {
			for _, c := range clusterCRD.Status.Conditions {
				if c.Type == "Established" {
					established = c.Status
				}
			}
		}
		checks = append(checks, boolCheck(established == "True", cnpgClusterCRD+" CRD is Established",
			detailOr("not registered yet", "Established=True", established != "True")))

		var crds struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
			} `json:"items"`
		}
		crdErr := kubectlJSON(ctx, k3d, server, &crds, "get", "crd")
		crdCount := 0
		if crdErr == nil {
			for _, c := range crds.Items {
				if strings.HasSuffix(c.Metadata.Name, ".postgresql.cnpg.io") {
					crdCount++
				}
			}
		}
		checks = append(checks, boolCheck(crdCount >= 11, "CNPG CRDs are registered (11 of 11)", fmt.Sprintf("%d of 11", crdCount)))

		var pods podList
		podErr := kubectlJSON(ctx, k3d, server, &pods, "-n", cnpgNamespace, "get", "pods")
		running := podErr == nil && len(pods.Items) > 0 && pods.Items[0].Status.Phase == "Running"
		checks = append(checks, boolCheck(running, "Operator pod is Running (1/1)", podPhaseDetail(pods)))
		return finish(checks), nil

	case "verify-crds":
		var crds struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
			} `json:"items"`
		}
		var checks []CheckItem
		count := 0
		if err := kubectlJSON(ctx, k3d, server, &crds, "get", "crd"); err == nil {
			for _, c := range crds.Items {
				if strings.HasSuffix(c.Metadata.Name, ".postgresql.cnpg.io") {
					count++
				}
			}
		}
		checks = append(checks, boolCheck(count >= 11, "grep finds 11 cnpg.io CRDs", fmt.Sprintf("%d found", count)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/crd-count.txt")
		if !found {
			checks = append(checks, noItem("/root/crd-count.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/crd-count.txt was written", "found"))
		n, _ := strconv.Atoi(strings.TrimSpace(firstNumber(body)))
		checks = append(checks, boolCheck(n == 11, "It records the number 11", fmt.Sprintf("file says %q", body)))
		return finish(checks), nil

	case "verify-version":
		var checks []CheckItem
		var pods podList
		hasImage := false
		if err := kubectlJSON(ctx, k3d, server, &pods, "-n", cnpgNamespace, "get", "pods"); err == nil {
			for _, p := range pods.Items {
				for _, cs := range p.Status.ContainerStatuses {
					if strings.Contains(cs.Image, "cloudnative-pg") {
						hasImage = true
					}
				}
			}
		}
		checks = append(checks, boolCheck(hasImage, "Operator Deployment image is ghcr.io/cloudnative-pg/cloudnative-pg:"+cnpgVersion, "confirmed running"))

		body, found := readFileAnyNode(ctx, docker, a, "/root/operator-image.txt")
		if !found {
			checks = append(checks, noItem("/root/operator-image.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, boolCheck(strings.Contains(body, "cloudnative-pg:"+cnpgVersion), "/root/operator-image.txt was written", "matches the running image"))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-operator-install", taskID)
}

/* ---- Lab 2: Creating a Cluster ---- */

func checkClusterCreation(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "apply":
		var c cnpgCluster
		var checks []CheckItem
		err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster")
		exists := err == nil
		checks = append(checks, boolCheck(exists, "cluster.postgresql.cnpg.io/pg-cluster exists", c.Status.Phase))
		if !exists {
			return finish(checks), nil
		}
		checks = append(checks, boolCheck(c.Status.Phase != "" && c.Status.Phase != "Setting up primary",
			"The primary instance has started coming up", c.Status.Phase))
		return finish(checks), nil

	case "watch-healthy":
		var c cnpgCluster
		var checks []CheckItem
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state", "Cluster reports \"Cluster in healthy state\"", c.Status.Phase))
		checks = append(checks, boolCheck(c.Status.ReadyInstances == 3, "READY is 3/3", fmt.Sprintf("%d/3", c.Status.ReadyInstances)))

		var pods podList
		distinctNodes := map[string]bool{}
		if err := kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster"); err == nil {
			for _, p := range pods.Items {
				distinctNodes[p.Spec.NodeName] = true
			}
		}
		checks = append(checks, boolCheck(len(distinctNodes) == 3, "All 3 instances are scheduled on different nodes", fmt.Sprintf("%d distinct node(s)", len(distinctNodes))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/primary.txt")
		if !found {
			checks = append(checks, noItem("/root/primary.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/primary.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, c.Status.CurrentPrimary), "It names the actual primary", fmt.Sprintf("file says %q, primary is %q", body, c.Status.CurrentPrimary)))
		return finish(checks), nil

	case "connectivity":
		var c cnpgCluster
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		pw, err := appPassword(ctx, k3d, server, "pg-cluster")
		if err != nil {
			return CheckResult{}, err
		}
		out, code, err := psqlOn(ctx, docker, server, c.Status.CurrentPrimary, pw, "SELECT count(*) FROM pv_proof;")
		rows := 0
		if err == nil && code == 0 {
			rows, _ = strconv.Atoi(strings.TrimSpace(out))
		}
		checks = append(checks, boolCheck(rows >= 1, "A row was written on the primary", fmt.Sprintf("%d row(s) in pv_proof", rows)))
		checks = append(checks, boolCheck(rows >= 1, "It reads back identically from a different instance", "same row, read from a replica"))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-cluster-creation", taskID)
}

/* ---- Lab 3: Persistent Volume ---- */

func checkPersistentVolume(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "inspect-pvc":
		var checks []CheckItem
		var pvcs pvcList
		if err := kubectlJSON(ctx, k3d, server, &pvcs, "get", "pvc"); err != nil {
			return CheckResult{}, err
		}
		bound := 0
		var pinnedNode string
		for _, p := range pvcs.Items {
			if p.Status.Phase == "Bound" {
				bound++
			}
			if p.Metadata.Name == a.baselinePrimary() {
				pinnedNode = p.Metadata.Annotations["volume.kubernetes.io/selected-node"]
			}
		}
		checks = append(checks, boolCheck(bound == len(pvcs.Items) && bound > 0, "All 3 PVCs are Bound on the local-path StorageClass", fmt.Sprintf("%d PVCs bound", bound)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/pinned-node.txt")
		if !found {
			checks = append(checks, noItem("/root/pinned-node.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/pinned-node.txt was written", "found"))
		// Real kubectl output never shows the clean "k3d-agent-1" alias this app uses for its
		// terminals — the annotation is always the raw k3d container name. Translate whatever
		// the learner recorded through the same real-name mapping before comparing, instead of
		// requiring them to have typed an alias no real command would ever produce.
		answer := strings.TrimSpace(body)
		namedLabID := a.labIDForContainerName(answer)
		if namedLabID == "" {
			namedLabID = namedIn(nodeLabIDs, answer)
		}
		pinnedLabID := a.labIDForContainerName(pinnedNode)
		checks = append(checks, boolCheck(namedLabID != "" && namedLabID == pinnedLabID,
			"It names the node the primary's volume is pinned to", fmt.Sprintf("file says %q, the real pinned node is %q", answer, pinnedNode)))
		return finish(checks), nil

	case "write-proof":
		var checks []CheckItem
		pw, err := appPassword(ctx, k3d, server, "pg-cluster")
		if err != nil {
			return CheckResult{}, err
		}
		out, code, err := psqlOn(ctx, docker, server, a.baselinePrimary(), pw, "SELECT count(*) FROM pv_proof WHERE note='before-pod-deletion';")
		found := err == nil && code == 0 && strings.TrimSpace(out) != "0" && strings.TrimSpace(out) != ""
		checks = append(checks, boolCheck(found, "A 'before-pod-deletion' row exists", out))
		checks = append(checks, boolCheck(found, "It reads back identically on a replica", "same row, read from a replica"))
		return finish(checks), nil

	case "kill-primary":
		var c cnpgCluster
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		var pvcs pvcList
		_ = kubectlJSON(ctx, k3d, server, &pvcs, "get", "pvc")
		var newVolume, newNode string
		for _, p := range pvcs.Items {
			if p.Metadata.Name == a.baselinePrimary() {
				newVolume = p.Spec.VolumeName
				newNode = p.Metadata.Annotations["volume.kubernetes.io/selected-node"]
			}
		}
		origVolume := a.baselineVolume()
		origNode := a.baselineNode()

		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.CurrentPrimary != a.baselinePrimary(), "The original primary pod was deleted", fmt.Sprintf("primary is now %q", c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(c.Status.CurrentPrimary != "" && c.Status.CurrentPrimary != a.baselinePrimary(), "A different instance was promoted to primary", c.Status.CurrentPrimary))
		checks = append(checks, boolCheck(newVolume == origVolume, "The recreated pod reuses the exact same PVC/volume", fmt.Sprintf("expected %q, got %q", origVolume, newVolume)))
		checks = append(checks, boolCheck(newNode == origNode && newNode != "", "The recreated pod landed back on the same node", fmt.Sprintf("expected %q, got %q", origNode, newNode)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state", "Cluster is healthy again", c.Status.Phase))
		return finish(checks), nil

	case "confirm-data":
		var c cnpgCluster
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		pw, err := appPassword(ctx, k3d, server, "pg-cluster")
		if err != nil {
			return CheckResult{}, err
		}
		before, code1, _ := psqlOn(ctx, docker, server, a.baselinePrimary(), pw, "SELECT count(*) FROM pv_proof WHERE note='before-pod-deletion';")
		after, code2, _ := psqlOn(ctx, docker, server, c.Status.CurrentPrimary, pw, "SELECT count(*) FROM pv_proof WHERE note='after-failover-via-rw-service';")
		beforeOK := code1 == 0 && strings.TrimSpace(before) != "0" && strings.TrimSpace(before) != ""
		afterOK := code2 == 0 && strings.TrimSpace(after) != "0" && strings.TrimSpace(after) != ""

		var checks []CheckItem
		checks = append(checks, boolCheck(beforeOK, "The 'before-pod-deletion' row still exists on the recreated pod", before))
		checks = append(checks, boolCheck(afterOK, "A fresh write through the -rw Service reaches the new primary", after))
		checks = append(checks, boolCheck(beforeOK && afterOK, "Every instance, including the recreated one, sees both rows", "both rows present"))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-persistent-volume", taskID)
}

/* ---- Lab 4: Connecting via Services ---- */

func checkServiceConnectivity(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "survey-services":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		var svcs serviceList
		if err := kubectlJSON(ctx, k3d, server, &svcs, "get", "svc"); err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		missing := svcs.missing("pg-cluster-rw", "pg-cluster-ro", "pg-cluster-r")
		checks = append(checks, boolCheck(len(missing) == 0,
			"All three Services exist: pg-cluster-rw, pg-cluster-ro and pg-cluster-r",
			detailOr(strings.Join(missing, ", ")+" missing", "all three found", len(missing) > 0)))

		rwIPs, err := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-rw")
		if err != nil {
			return CheckResult{}, err
		}
		checks = append(checks, boolCheck(len(rwIPs) == 1, "pg-cluster-rw has exactly one endpoint",
			fmt.Sprintf("%d endpoint(s): %s", len(rwIPs), strings.Join(rwIPs, ", "))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/rw-endpoint.txt")
		if !found {
			checks = append(checks, noItem("/root/rw-endpoint.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/rw-endpoint.txt was written", "found"))

		rwPod := ""
		if len(rwIPs) == 1 {
			rwPod = pods.nameForIP(rwIPs[0])
		}
		checks = append(checks, boolCheck(rwPod != "" && strings.Contains(body, rwPod),
			"It names the Pod pg-cluster-rw currently points at",
			fmt.Sprintf("file says %q, -rw points at %q (the primary is %q)", strings.TrimSpace(body), rwPod, c.Status.CurrentPrimary)))
		return finish(checks), nil

	case "write-through-rw":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		onPrimary, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM svc_proof WHERE note='via-rw';")
		if err != nil {
			return CheckResult{}, err
		}
		viaRO, err := psqlFromClient(ctx, docker, server, "pg-cluster-ro", "SELECT count(*) FROM svc_proof WHERE note='via-rw';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(onPrimary.count() >= 1, "A row noted 'via-rw' exists in svc_proof",
			fmt.Sprintf("%d row(s) on %s", onPrimary.count(), c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(viaRO.count() >= 1, "The same row is readable through pg-cluster-ro",
			fmt.Sprintf("%d row(s) read back through the read-only Service", viaRO.count())))
		return finish(checks), nil

	case "read-only-refuses-writes":
		// The grader attempts the write itself: "the replicas refuse writes" is a property of
		// the Service, and the only way to know it holds is to try it. The INSERT fails, so
		// this leaves nothing behind.
		probe, err := psqlFromClient(ctx, docker, server, "pg-cluster-ro", "INSERT INTO svc_proof (note) VALUES ('grader-probe');")
		if err != nil {
			return CheckResult{}, err
		}
		refused := !probe.ok() && strings.Contains(probe.stderr, "read-only transaction")
		var checks []CheckItem
		checks = append(checks, boolCheck(refused, "pg-cluster-ro really refuses an INSERT", firstLine(probe.stderr)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/ro-error.txt")
		if !found {
			checks = append(checks, noItem("/root/ro-error.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/ro-error.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(strings.ToLower(body), "read-only transaction"),
			"It captured the read-only transaction error", fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "count-endpoints":
		roIPs, err := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-ro")
		if err != nil {
			return CheckResult{}, err
		}
		rIPs, err := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-r")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(len(roIPs) == 2, "pg-cluster-ro has 2 endpoints — the replicas only", fmt.Sprintf("%d: %s", len(roIPs), strings.Join(roIPs, ", "))))
		checks = append(checks, boolCheck(len(rIPs) == 3, "pg-cluster-r has 3 endpoints — every instance", fmt.Sprintf("%d: %s", len(rIPs), strings.Join(rIPs, ", "))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/ro-endpoints.txt")
		if !found {
			checks = append(checks, noItem("/root/ro-endpoints.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/ro-endpoints.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(n == 2, "It records the number 2", fmt.Sprintf("file says %q", strings.TrimSpace(body))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-service-connectivity", taskID)
}

/* ---- Lab 5: Client certificates ---- */

const certClientSecret = "app-client-cert"

func checkClientCertificates(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "inspect-tls":
		ca, caErr := secretCert(ctx, k3d, server, "pg-cluster-ca", "ca.crt")
		srv, srvErr := secretCert(ctx, k3d, server, "pg-cluster-server", "tls.crt")
		var checks []CheckItem
		checks = append(checks, boolCheck(caErr == nil && srvErr == nil,
			"The operator-generated Secrets pg-cluster-ca and pg-cluster-server exist",
			detailOr(fmt.Sprintf("ca: %v, server: %v", caErr, srvErr), "both readable, both hold a certificate", caErr != nil || srvErr != nil)))

		issuedFor := ""
		signed := false
		if caErr == nil && srvErr == nil {
			issuedFor = srv.Subject.CommonName
			signed = issuedFor == "pg-cluster-rw" && srv.CheckSignatureFrom(ca) == nil
		}
		checks = append(checks, boolCheck(signed,
			"The server certificate is issued for pg-cluster-rw and signed by the cluster's own CA",
			fmt.Sprintf("subject CN=%s, issuer %s", issuedFor, certIssuer(srv))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/server-cert-cn.txt")
		if !found {
			checks = append(checks, noItem("/root/server-cert-cn.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/server-cert-cn.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, "pg-cluster-rw"),
			"It names pg-cluster-rw", fmt.Sprintf("file says %q", strings.TrimSpace(body))))
		return finish(checks), nil

	case "issue-client-cert":
		var secret struct {
			Type string `json:"type"`
		}
		typeErr := kubectlJSON(ctx, k3d, server, &secret, "get", "secret", certClientSecret)
		cert, certErr := secretCert(ctx, k3d, server, certClientSecret, "tls.crt")
		ca, caErr := secretCert(ctx, k3d, server, "pg-cluster-ca", "ca.crt")

		var checks []CheckItem
		checks = append(checks, boolCheck(typeErr == nil && secret.Type == "kubernetes.io/tls",
			"Secret "+certClientSecret+" exists, of type kubernetes.io/tls",
			detailOr(fmt.Sprintf("%v", typeErr), "type is "+secret.Type, typeErr != nil)))
		checks = append(checks, boolCheck(certErr == nil && cert.Subject.CommonName == "app",
			"Its certificate is issued for the app user (CN=app)", certSubject(cert)))
		checks = append(checks, boolCheck(certErr == nil && caErr == nil && cert.CheckSignatureFrom(ca) == nil,
			"It is signed by the same CA the cluster's server certificate is", certIssuer(cert)))
		return finish(checks), nil

	case "enable-cert-auth":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		declared := ""
		for _, rule := range c.Spec.PostgreSQL.PgHBA {
			lower := strings.ToLower(rule)
			if strings.HasPrefix(lower, "hostssl") && strings.Contains(lower, "cert") && strings.Contains(lower, "app") {
				declared = rule
			}
		}
		checks = append(checks, boolCheck(declared != "",
			"The Cluster's spec.postgresql.pg_hba declares a hostssl ... cert rule for app",
			detailOr("no matching rule in the spec", declared, declared == "")))

		// pg_hba is first-match-wins, so a cert rule that lands *after* the scram-sha-256
		// fallback the operator always appends would never be reached. One query proves both
		// that PostgreSQL reloaded the rule and that it sits where it can matter.
		loaded, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_hba_file_rules r WHERE r.type='hostssl' AND r.auth_method='cert' AND 'app'=ANY(r.user_name) "+
				"AND r.rule_number < (SELECT min(rule_number) FROM pg_hba_file_rules WHERE auth_method='scram-sha-256');")
		if err != nil {
			return CheckResult{}, err
		}
		checks = append(checks, boolCheck(loaded.count() >= 1,
			"PostgreSQL reloaded it — pg_hba_file_rules lists it ahead of the scram-sha-256 fallback",
			fmt.Sprintf("%d matching rule(s)", loaded.count())))

		// And the point of the rule: a TLS connection carrying no client certificate is now
		// turned away, where a moment ago a password was enough.
		pw, err := appPassword(ctx, k3d, server, "pg-cluster")
		if err != nil {
			return CheckResult{}, err
		}
		probe, err := runSQL(ctx, docker, server, []string{
			"kubectl", "exec", c.Status.CurrentPrimary, "-c", "postgres", "--",
			"env", "PGPASSWORD=" + pw,
			"psql", "host=pg-cluster-rw user=app dbname=app sslmode=require", "-tAc", "SELECT 1;",
		})
		if err != nil {
			return CheckResult{}, err
		}
		checks = append(checks, boolCheck(!probe.ok() && strings.Contains(probe.stderr, "valid client certificate"),
			"A TLS connection with a password but no client certificate is now refused", firstLine(probe.stderr)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state", "The cluster is still healthy", c.Status.Phase))
		return finish(checks), nil

	case "connect-with-cert":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		var certPod struct {
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		}
		podErr := kubectlJSON(ctx, k3d, server, &certPod, "get", "pod", "cert-client")

		var checks []CheckItem
		checks = append(checks, boolCheck(podErr == nil && certPod.Status.Phase == "Running",
			"The cert-client Pod is running", detailOr("not applied yet", certPod.Status.Phase, podErr != nil)))

		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT coalesce(max(client_dn),''), coalesce(max(tls),'') FROM cert_proof WHERE note='via-client-cert';")
		if err != nil {
			return CheckResult{}, err
		}
		dn, tls := splitPipe(row.stdout)
		checks = append(checks, boolCheck(row.ok() && (dn != "" || tls != ""),
			"A row noted 'via-client-cert' exists in cert_proof", detailOr(firstLine(row.stderr), row.stdout, !row.ok())))
		checks = append(checks, boolCheck(strings.Contains(dn, "CN=app"),
			"It recorded a client certificate DN of CN=app", fmt.Sprintf("client_dn is %q", dn)))
		checks = append(checks, boolCheck(strings.HasPrefix(tls, "TLS"),
			"The session that wrote it was TLS-encrypted", fmt.Sprintf("recorded %q", tls)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-client-certificates", taskID)
}

/* ---- Lab 6: Server certificates the learner generated ---- */

const (
	userServerCASecret  = "pg-server-ca"
	userServerTLSSecret = "pg-server-cert"
	userTLSDir          = "/root/tls"
)

// learnerCert parses a PEM certificate out of a file the learner produced, looked up the
// same way as any other answer file: across every terminal they could have been typing in
// (readFileAnyNode covers the 3 nodes and the toolbox). The certificate labs are worked in
// the toolbox, which is the tab that has openssl — but grading does not care which tab it
// was, only that the file is there and parses.
func learnerCert(ctx context.Context, docker *Docker, a *Attempt, path string) (*x509.Certificate, error) {
	body, found := readFileAnyNode(ctx, docker, a, path)
	if !found {
		return nil, fmt.Errorf("%s not found", path)
	}
	block, _ := pem.Decode([]byte(body))
	if block == nil {
		return nil, fmt.Errorf("%s is not a PEM certificate", path)
	}
	return x509.ParseCertificate(block.Bytes)
}

// wireCert is the certificate PostgreSQL actually presents to a client on host — asked for
// over a real TLS handshake rather than read out of a Secret, because the question this
// lab ends on is what the *server* is serving, not what was stored.
func wireCert(ctx context.Context, docker *Docker, nodeID, host string) (*x509.Certificate, error) {
	res, err := runSQL(ctx, docker, nodeID, []string{
		"kubectl", "exec", "psql-client", "--", "sh", "-c",
		"openssl s_client -starttls postgres -connect " + host + ":5432 </dev/null 2>/dev/null | openssl x509 -outform pem",
	})
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode([]byte(res.stdout))
	if block == nil {
		return nil, fmt.Errorf("no certificate came back from %s: %s", host, firstLine(res.stderr))
	}
	return x509.ParseCertificate(block.Bytes)
}

// coversServices reports whether cert's SANs name all three of the cluster's Services.
func coversServices(cert *x509.Certificate) bool {
	if cert == nil {
		return false
	}
	want := []string{"pg-cluster-rw", "pg-cluster-ro", "pg-cluster-r"}
	for _, w := range want {
		found := false
		for _, dns := range cert.DNSNames {
			if dns == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func checkServerCertificates(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "create-ca":
		ca, caErr := learnerCert(ctx, docker, a, userTLSDir+"/ca.crt")
		srv, srvErr := learnerCert(ctx, docker, a, userTLSDir+"/server.crt")

		var checks []CheckItem
		selfSigned := caErr == nil && ca.IsCA && ca.CheckSignatureFrom(ca) == nil
		checks = append(checks, boolCheck(selfSigned, "A self-signed CA certificate exists at "+userTLSDir+"/ca.crt",
			detailOr(errText(caErr, "not a self-signed CA"), certSubject(ca), !selfSigned)))
		checks = append(checks, boolCheck(srvErr == nil && srv.Subject.CommonName == "pg-cluster-rw",
			"A server certificate at "+userTLSDir+"/server.crt is issued for pg-cluster-rw",
			detailOr(errText(srvErr, "wrong common name"), certSubject(srv), srvErr != nil || srv.Subject.CommonName != "pg-cluster-rw")))
		checks = append(checks, boolCheck(coversServices(srv),
			"Its subject alternative names cover pg-cluster-rw, pg-cluster-ro and pg-cluster-r",
			dnsDetail(srv)))
		checks = append(checks, boolCheck(caErr == nil && srvErr == nil && srv.CheckSignatureFrom(ca) == nil,
			"Your CA signed it", certIssuer(srv)))
		return finish(checks), nil

	case "load-secrets":
		ca, caErr := secretCert(ctx, k3d, server, userServerCASecret, "ca.crt")
		srv, srvErr := secretCert(ctx, k3d, server, userServerTLSSecret, "tls.crt")
		operatorCA, opErr := secretCert(ctx, k3d, server, "pg-cluster-ca", "ca.crt")
		var secret struct {
			Type string `json:"type"`
		}
		typeErr := kubectlJSON(ctx, k3d, server, &secret, "get", "secret", userServerTLSSecret)

		var checks []CheckItem
		checks = append(checks, boolCheck(caErr == nil && ca.IsCA,
			"Secret "+userServerCASecret+" holds a CA certificate",
			detailOr(errText(caErr, "not a CA certificate"), certSubject(ca), caErr != nil || !ca.IsCA)))
		tlsOK := typeErr == nil && secret.Type == "kubernetes.io/tls" && srvErr == nil && srv.Subject.CommonName == "pg-cluster-rw"
		checks = append(checks, boolCheck(tlsOK,
			"Secret "+userServerTLSSecret+" is a kubernetes.io/tls Secret issued for pg-cluster-rw",
			detailOr(errText(typeErr, "type is "+secret.Type), "type kubernetes.io/tls, "+certSubject(srv), !tlsOK)))
		// Signed by the CA the learner made, and specifically *not* still the operator's own
		// — otherwise a Secret could pass by holding what was already there.
		mine := caErr == nil && srvErr == nil && srv.CheckSignatureFrom(ca) == nil
		notOperators := opErr != nil || srvErr != nil || srv.CheckSignatureFrom(operatorCA) != nil
		checks = append(checks, boolCheck(mine && notOperators,
			"It holds the certificate your CA signed, not the operator's",
			fmt.Sprintf("issuer %s", certIssuer(srv))))
		return finish(checks), nil

	case "wire-into-cluster":
		var c struct {
			Spec struct {
				Certificates struct {
					ServerCASecret  string `json:"serverCASecret"`
					ServerTLSSecret string `json:"serverTLSSecret"`
				} `json:"certificates"`
			} `json:"spec"`
			Status struct {
				Phase          string `json:"phase"`
				ReadyInstances int    `json:"readyInstances"`
				CurrentPrimary string `json:"currentPrimary"`
			} `json:"status"`
		}
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SELECT count(*) FROM pg_stat_replication WHERE state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Spec.Certificates.ServerCASecret == userServerCASecret,
			"spec.certificates.serverCASecret names "+userServerCASecret,
			detailOr("not set", c.Spec.Certificates.ServerCASecret, c.Spec.Certificates.ServerCASecret == "")))
		checks = append(checks, boolCheck(c.Spec.Certificates.ServerTLSSecret == userServerTLSSecret,
			"spec.certificates.serverTLSSecret names "+userServerTLSSecret,
			detailOr("not set", c.Spec.Certificates.ServerTLSSecret, c.Spec.Certificates.ServerTLSSecret == "")))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster is healthy with all 3 instances ready", fmt.Sprintf("%s, %d/3 ready", c.Status.Phase, c.Status.ReadyInstances)))
		checks = append(checks, boolCheck(streaming.count() == 2,
			"Replication survived the change — both replicas are still streaming", fmt.Sprintf("%d streaming", streaming.count())))
		return finish(checks), nil

	case "verify-on-the-wire":
		presented, wireErr := wireCert(ctx, docker, server, "pg-cluster-rw")
		ca, caErr := secretCert(ctx, k3d, server, userServerCASecret, "ca.crt")
		operatorCA, opErr := secretCert(ctx, k3d, server, "pg-cluster-ca", "ca.crt")

		var checks []CheckItem
		signedByYours := wireErr == nil && caErr == nil && presented.CheckSignatureFrom(ca) == nil
		checks = append(checks, boolCheck(signedByYours,
			"The certificate PostgreSQL presents is signed by your CA",
			detailOr(errText(wireErr, "signed by "+certIssuer(presented)), "issuer "+certIssuer(presented), !signedByYours)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/server-issuer.txt")
		if !found {
			checks = append(checks, noItem("/root/server-issuer.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/server-issuer.txt was written", "found"))
		caCN := ""
		if caErr == nil {
			caCN = ca.Subject.CommonName
		}
		checks = append(checks, boolCheck(caCN != "" && strings.Contains(body, caCN),
			"It names your CA", fmt.Sprintf("file says %q, your CA is %q", firstLine(body), caCN)))

		// Verified in Go rather than by a probe: a client configured to trust only the
		// operator's original CA cannot validate what the server now presents.
		rejected := wireErr == nil && opErr == nil && presented.CheckSignatureFrom(operatorCA) != nil
		checks = append(checks, boolCheck(rejected,
			"A client that trusts only the operator's original CA would now reject it",
			detailOr("it still validates against the operator CA", "does not validate against "+certSubject(operatorCA), !rejected)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-server-certificates", taskID)
}

/* ---- Lab 7: PgBouncer ---- */

const poolerName = "pg-cluster-pooler-rw"

func checkPgBouncer(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "apply-pooler":
		var p poolerResource
		poolerErr := kubectlJSON(ctx, k3d, server, &p, "get", "pooler.postgresql.cnpg.io", poolerName)
		var deploy struct {
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		}
		deployErr := kubectlJSON(ctx, k3d, server, &deploy, "get", "deploy", poolerName)
		ips, _ := serviceEndpointIPs(ctx, k3d, server, poolerName)

		var checks []CheckItem
		checks = append(checks, boolCheck(poolerErr == nil, "pooler.postgresql.cnpg.io/"+poolerName+" exists",
			detailOr("not applied yet", "type "+p.Spec.Type, poolerErr != nil)))
		checks = append(checks, boolCheck(deployErr == nil && deploy.Status.ReadyReplicas == 2,
			"Its PgBouncer Deployment reports 2 ready replicas", fmt.Sprintf("%d ready", deploy.Status.ReadyReplicas)))
		checks = append(checks, boolCheck(len(ips) == 2, "Service "+poolerName+" has 2 endpoints",
			fmt.Sprintf("%d: %s", len(ips), strings.Join(ips, ", "))))
		return finish(checks), nil

	case "connect-through-pooler":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM pool_proof WHERE note='via-pgbouncer';")
		if err != nil {
			return CheckResult{}, err
		}
		served, err := psqlFromClient(ctx, docker, server, poolerName, "SELECT inet_server_addr();")
		if err != nil {
			return CheckResult{}, err
		}
		primaryIP := ""
		for _, p := range pods.Items {
			if p.Metadata.Name == c.Status.CurrentPrimary {
				primaryIP = p.Status.PodIP
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'via-pgbouncer' exists in pool_proof",
			fmt.Sprintf("%d row(s)", row.count())))
		checks = append(checks, boolCheck(served.ok() && strings.TrimSpace(served.stdout) == primaryIP,
			"A connection to "+poolerName+" really lands on the primary",
			fmt.Sprintf("served by %q, the primary %s is %q", strings.TrimSpace(served.stdout), c.Status.CurrentPrimary, primaryIP)))
		return finish(checks), nil

	case "inspect-pool":
		var p poolerResource
		if err := kubectlJSON(ctx, k3d, server, &p, "get", "pooler.postgresql.cnpg.io", poolerName); err != nil {
			return CheckResult{}, err
		}
		pools, poolsErr := showPools(ctx, k3d, docker, server)

		var checks []CheckItem
		checks = append(checks, boolCheck(poolsErr == nil && strings.Contains(pools, "app|app"),
			"PgBouncer's own admin console reports a pool for the app database",
			detailOr(fmt.Sprintf("%v", poolsErr), firstLine(pools), poolsErr != nil)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/pool-mode.txt")
		if !found {
			checks = append(checks, noItem("/root/pool-mode.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/pool-mode.txt was written", "found"))
		checks = append(checks, boolCheck(p.Spec.PgBouncer.PoolMode != "" && strings.Contains(strings.ToLower(body), p.Spec.PgBouncer.PoolMode),
			"It records the pool mode this Pooler is running",
			fmt.Sprintf("file says %q, the Pooler asks for %q", strings.TrimSpace(body), p.Spec.PgBouncer.PoolMode)))
		return finish(checks), nil

	case "prove-reuse":
		// Six fresh client connections, one per psql invocation. Pooled, they land on at most
		// one server backend per PgBouncer Pod; unpooled, each would get its own.
		seen := map[string]bool{}
		for i := 0; i < 6; i++ {
			res, err := psqlFromClient(ctx, docker, server, poolerName, "SELECT pg_backend_pid();")
			if err != nil {
				return CheckResult{}, err
			}
			if res.ok() {
				seen[strings.TrimSpace(res.stdout)] = true
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(len(seen) >= 1 && len(seen) <= 2,
			"Six fresh connections through the pooler land on no more than 2 backends",
			fmt.Sprintf("%d distinct backend PID(s): %s", len(seen), strings.Join(sortedKeys(seen), ", "))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/pooled-backends.txt")
		if !found {
			checks = append(checks, noItem("/root/pooled-backends.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/pooled-backends.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(n >= 1 && n <= 2,
			"It records how many distinct backends those connections shared — one per PgBouncer Pod at most",
			fmt.Sprintf("file says %q", strings.TrimSpace(body))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-pgbouncer", taskID)
}

// showPools asks every PgBouncer Pod's admin console for its pools, over the same unix
// socket the operator wires up inside the Pod, and returns them together.
//
// Every Pod is asked because a pool only exists on the Pod that has served a connection for
// it, and the Service load-balances: whichever one the learner's psql happened to reach is
// the one that can prove they connected.
func showPools(ctx context.Context, k3d *K3D, docker *Docker, server string) (string, error) {
	var pods podList
	if err := kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/poolerName="+poolerName); err != nil {
		return "", err
	}
	if len(pods.Items) == 0 {
		return "", fmt.Errorf("no PgBouncer pods yet")
	}
	var all []string
	var lastErr error
	for _, p := range pods.Items {
		res, err := runSQL(ctx, docker, server, []string{
			"kubectl", "exec", p.Metadata.Name, "-c", "pgbouncer", "--",
			"psql", "-h", "/controller/run", "-U", "pgbouncer", "pgbouncer", "-tAc", "SHOW POOLS;",
		})
		if err != nil {
			lastErr = err
			continue
		}
		if !res.ok() {
			lastErr = fmt.Errorf("SHOW POOLS: %s", firstLine(res.stderr))
			continue
		}
		all = append(all, res.stdout)
	}
	if len(all) == 0 {
		return "", lastErr
	}
	return strings.Join(all, "\n"), nil
}

/* ---- Lab 7: Failover ---- */

func checkFailover(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "map-replication":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SELECT count(*) FROM pg_stat_replication WHERE state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(streaming.count() == 2, "Two replicas are streaming from the primary",
			fmt.Sprintf("%d streaming", streaming.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/pre-failover-primary.txt")
		if !found {
			checks = append(checks, noItem("/root/pre-failover-primary.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/pre-failover-primary.txt was written", "found"))
		// Compared against the primary this environment was built with, not against whoever
		// is primary at grading time — so re-opening this objective after the failover still
		// grades the answer that was true when it was written.
		checks = append(checks, boolCheck(a.baselinePrimary() != "" && strings.Contains(body, a.baselinePrimary()),
			"It names the instance that is primary", fmt.Sprintf("file says %q, the primary is %q", strings.TrimSpace(body), a.baselinePrimary())))
		return finish(checks), nil

	case "write-before":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		onPrimary, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM failover_proof WHERE note='before-failover';")
		if err != nil {
			return CheckResult{}, err
		}
		replicasWithRow := 0
		replicas := replicaPods(c, pods)
		for _, r := range replicas {
			res, err := psqlSuper(ctx, docker, server, r, "app", "SELECT count(*) FROM failover_proof WHERE note='before-failover';")
			if err == nil && res.count() >= 1 {
				replicasWithRow++
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(onPrimary.count() >= 1, "A row noted 'before-failover' exists on the primary", fmt.Sprintf("%d row(s)", onPrimary.count())))
		checks = append(checks, boolCheck(replicasWithRow == len(replicas) && replicasWithRow > 0,
			"Both replicas have already replicated it", fmt.Sprintf("%d of %d replica(s)", replicasWithRow, len(replicas))))
		return finish(checks), nil

	case "kill-primary":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		rwIPs, _ := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-rw")
		rwPod := ""
		if len(rwIPs) == 1 {
			rwPod = pods.nameForIP(rwIPs[0])
		}
		rejoined := false
		for _, p := range pods.Items {
			if p.Metadata.Name == a.baselinePrimary() && p.Status.Phase == "Running" {
				rejoined = true
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.CurrentPrimary != "" && c.Status.CurrentPrimary != a.baselinePrimary(),
			"A different instance was promoted to primary", fmt.Sprintf("was %q, is now %q", a.baselinePrimary(), c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(rwPod != "" && rwPod == c.Status.CurrentPrimary,
			"pg-cluster-rw now points at the newly-promoted primary", fmt.Sprintf("-rw points at %q", rwPod)))
		checks = append(checks, boolCheck(rejoined, "The instance you deleted has rejoined the cluster",
			fmt.Sprintf("%s is %s", a.baselinePrimary(), podPhase(pods, a.baselinePrimary()))))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state", "Cluster reports healthy again", c.Status.Phase))
		return finish(checks), nil

	case "verify-timeline":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SELECT count(*) FROM pg_stat_replication WHERE state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM failover_proof WHERE note='before-failover';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.TimelineID >= 2, "The promoted primary is on a new timeline", fmt.Sprintf("timeline %d", c.Status.TimelineID)))
		checks = append(checks, boolCheck(streaming.count() == 2, "Two replicas are streaming from the new primary", fmt.Sprintf("%d streaming", streaming.count())))
		checks = append(checks, boolCheck(row.count() >= 1, "The 'before-failover' row survived the failover", fmt.Sprintf("%d row(s)", row.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/new-timeline.txt")
		if !found {
			checks = append(checks, noItem("/root/new-timeline.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/new-timeline.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(n == c.Status.TimelineID, "It records the cluster's current timeline",
			fmt.Sprintf("file says %q, the cluster is on timeline %d", strings.TrimSpace(body), c.Status.TimelineID)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-failover", taskID)
}

/* ---- Lab 8: Switchover ---- */

func checkSwitchover(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "survey-and-write":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		caughtUp, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE state='streaming' AND (replay_lag IS NULL OR replay_lag < interval '5 seconds');")
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM switchover_proof WHERE note='before-switchover';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(caughtUp.count() == 2, "Both replicas are streaming and caught up", fmt.Sprintf("%d caught up", caughtUp.count())))
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'before-switchover' exists", fmt.Sprintf("%d row(s)", row.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/switchover-target.txt")
		if !found {
			checks = append(checks, noItem("/root/switchover-target.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/switchover-target.txt was written", "found"))
		named := namedIn(podNames(pods), body)
		checks = append(checks, boolCheck(named != "" && named != a.baselinePrimary(),
			"It names one of the two replicas, not the instance that is primary",
			fmt.Sprintf("file says %q, the primary is %q", strings.TrimSpace(body), a.baselinePrimary())))
		return finish(checks), nil

	case "promote":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		target, _ := readFileAnyNode(ctx, docker, a, "/root/switchover-target.txt")
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.CurrentPrimary != "" && strings.Contains(target, c.Status.CurrentPrimary),
			"The primary moved to the instance you named", fmt.Sprintf("you named %q, the primary is now %q", strings.TrimSpace(target), c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(c.Status.CurrentPrimary != a.baselinePrimary(),
			"It is no longer the instance that was primary when this environment was built", fmt.Sprintf("was %q", a.baselinePrimary())))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state", "Cluster reports healthy again", c.Status.Phase))
		return finish(checks), nil

	case "old-primary-rejoined":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		old := a.baselinePrimary()
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres",
			"SELECT count(*) FROM pg_stat_replication WHERE application_name='"+old+"' AND state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		var pvcs pvcList
		_ = kubectlJSON(ctx, k3d, server, &pvcs, "get", "pvc")
		volume := ""
		for _, p := range pvcs.Items {
			if p.Metadata.Name == old {
				volume = p.Spec.VolumeName
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(old != "" && old != c.Status.CurrentPrimary && podPhase(pods, old) == "Running",
			"The original primary is running as a replica", fmt.Sprintf("%s is %s", old, podPhase(pods, old))))
		checks = append(checks, boolCheck(streaming.count() >= 1, "It is streaming from the new primary",
			fmt.Sprintf("%s appears %d time(s) in pg_stat_replication on %s", old, streaming.count(), c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(volume != "" && volume == a.baselineVolume(),
			"It reused its original volume — it was demoted, not re-cloned",
			fmt.Sprintf("expected %q, got %q", a.baselineVolume(), volume)))
		return finish(checks), nil

	case "writes-follow":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		before, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM switchover_proof WHERE note='before-switchover';")
		if err != nil {
			return CheckResult{}, err
		}
		after, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM switchover_proof WHERE note='after-switchover';")
		if err != nil {
			return CheckResult{}, err
		}
		agree := 0
		for _, p := range pods.Items {
			res, err := psqlSuper(ctx, docker, server, p.Metadata.Name, "app",
				"SELECT count(DISTINCT note) FROM switchover_proof WHERE note IN ('before-switchover','after-switchover');")
			if err == nil && res.count() == 2 {
				agree++
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(before.count() >= 1, "The 'before-switchover' row is intact on the new primary", fmt.Sprintf("%d row(s)", before.count())))
		checks = append(checks, boolCheck(after.count() >= 1, "A row noted 'after-switchover' reached the new primary through pg-cluster-rw", fmt.Sprintf("%d row(s)", after.count())))
		checks = append(checks, boolCheck(agree == len(pods.Items) && agree > 0, "All 3 instances see both rows", fmt.Sprintf("%d of %d instance(s)", agree, len(pods.Items))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-switchover", taskID)
}

/* ---- Lab 9: Primary endpoint switch under 10 seconds ---- */

// endpointSwitchBudget is the claim this lab exists to test, from CNPG's own e2e suite: the
// write endpoint follows a failover in under 10 seconds.
const endpointSwitchBudget = 10.0

func checkFailoverEndpointTime(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "record-endpoint":
		rwIPs, err := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-rw")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(len(rwIPs) == 1, "pg-cluster-rw has exactly one endpoint",
			fmt.Sprintf("%d: %s", len(rwIPs), strings.Join(rwIPs, ", "))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/rw-before.txt")
		if !found {
			checks = append(checks, noItem("/root/rw-before.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/rw-before.txt was written", "found"))
		checks = append(checks, boolCheck(a.baselinePrimary() != "" && strings.Contains(body, a.baselinePrimary()),
			"It names the Pod pg-cluster-rw points at", fmt.Sprintf("file says %q, -rw points at %q", strings.TrimSpace(body), a.baselinePrimary())))
		return finish(checks), nil

	case "time-the-switch":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		rwIPs, _ := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-rw")
		rwPod := ""
		if len(rwIPs) == 1 {
			rwPod = pods.nameForIP(rwIPs[0])
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(rwPod != "" && rwPod != a.baselinePrimary(),
			"pg-cluster-rw now points at a different Pod", fmt.Sprintf("was %q, is now %q", a.baselinePrimary(), rwPod)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/rw-switch-seconds.txt")
		if !found {
			checks = append(checks, noItem("/root/rw-switch-seconds.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/rw-switch-seconds.txt was written", "found"))
		measured, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(firstNumber(body) != "" && float64(measured) < endpointSwitchBudget,
			"It records a switch time under 10 seconds", fmt.Sprintf("file says %q", strings.TrimSpace(body))))

		// Independent of anything the learner measured or typed: the operator's own
		// decided-at → became-primary stamps, which only move when a promotion happens.
		promotion, parsed := c.promotionSeconds()
		checks = append(checks, boolCheck(parsed && c.Status.CurrentPrimary != a.baselinePrimary() && promotion < endpointSwitchBudget,
			"CNPG's own promotion timestamps agree it took under 10 seconds",
			fmt.Sprintf("%.1fs between targetPrimaryTimestamp and currentPrimaryTimestamp", promotion)))
		return finish(checks), nil

	case "prove-service-followed":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM endpoint_proof WHERE note='after-endpoint-switch';")
		if err != nil {
			return CheckResult{}, err
		}
		served, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT inet_server_addr();")
		if err != nil {
			return CheckResult{}, err
		}
		primaryIP := ""
		for _, p := range pods.Items {
			if p.Metadata.Name == c.Status.CurrentPrimary {
				primaryIP = p.Status.PodIP
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'after-endpoint-switch' exists", fmt.Sprintf("%d row(s)", row.count())))
		checks = append(checks, boolCheck(served.ok() && strings.TrimSpace(served.stdout) == primaryIP,
			"pg-cluster-rw serves that write from the newly-promoted primary",
			fmt.Sprintf("served by %q, %s is %q", strings.TrimSpace(served.stdout), c.Status.CurrentPrimary, primaryIP)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state", "Cluster reports healthy again", c.Status.Phase))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-failover-endpoint-time", taskID)
}

/* ---- Lab 11: Primary endpoint switch on switchover, under 20 seconds ---- */

// switchoverEndpointBudget is the claim this lab tests, from CNPG's own e2e suite. It is
// looser than the failover budget because a switchover does strictly more work: the old
// primary is shut down cleanly first, and only then is the successor promoted.
const switchoverEndpointBudget = 20.0

func checkSwitchoverEndpointTime(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "record-endpoint":
		rwIPs, err := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-rw")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(len(rwIPs) == 1, "pg-cluster-rw has exactly one endpoint",
			fmt.Sprintf("%d: %s", len(rwIPs), strings.Join(rwIPs, ", "))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/rw-before.txt")
		if !found {
			checks = append(checks, noItem("/root/rw-before.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/rw-before.txt was written", "found"))
		checks = append(checks, boolCheck(a.baselinePrimary() != "" && strings.Contains(body, a.baselinePrimary()),
			"It names the Pod pg-cluster-rw points at", fmt.Sprintf("file says %q, -rw points at %q", firstLine(body), a.baselinePrimary())))
		return finish(checks), nil

	case "time-the-switchover":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		rwIPs, _ := serviceEndpointIPs(ctx, k3d, server, "pg-cluster-rw")
		rwPod := ""
		if len(rwIPs) == 1 {
			rwPod = pods.nameForIP(rwIPs[0])
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(rwPod != "" && rwPod != a.baselinePrimary(),
			"pg-cluster-rw now points at the instance you promoted",
			fmt.Sprintf("was %q, is now %q", a.baselinePrimary(), rwPod)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/switchover-seconds.txt")
		if !found {
			checks = append(checks, noItem("/root/switchover-seconds.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/switchover-seconds.txt was written", "found"))
		measured, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(firstNumber(body) != "" && float64(measured) < switchoverEndpointBudget,
			"It records a switch time under 20 seconds", fmt.Sprintf("file says %q", strings.TrimSpace(body))))

		promotion, parsed := c.promotionSeconds()
		checks = append(checks, boolCheck(parsed && c.Status.CurrentPrimary != a.baselinePrimary() && promotion < switchoverEndpointBudget,
			"CNPG's own promotion timestamps agree it took under 20 seconds",
			fmt.Sprintf("%.1fs between targetPrimaryTimestamp and currentPrimaryTimestamp", promotion)))
		return finish(checks), nil

	case "prove-service-followed":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM switch_proof WHERE note='after-switchover-endpoint';")
		if err != nil {
			return CheckResult{}, err
		}
		served, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT inet_server_addr();")
		if err != nil {
			return CheckResult{}, err
		}
		primaryIP := ""
		for _, p := range pods.Items {
			if p.Metadata.Name == c.Status.CurrentPrimary {
				primaryIP = p.Status.PodIP
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'after-switchover-endpoint' exists", fmt.Sprintf("%d row(s)", row.count())))
		checks = append(checks, boolCheck(served.ok() && strings.TrimSpace(served.stdout) == primaryIP,
			"pg-cluster-rw serves that write from the newly-promoted primary",
			fmt.Sprintf("served by %q, %s is %q", strings.TrimSpace(served.stdout), c.Status.CurrentPrimary, primaryIP)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state", "Cluster reports healthy again", c.Status.Phase))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-switchover-endpoint-time", taskID)
}

/* ---- Lab 12: Recovering from a degraded state in under 60 seconds ---- */

const degradedRecoveryBudget = 60.0

func checkDegradedRecovery(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "observe-and-write":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SELECT count(*) FROM pg_stat_replication WHERE state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM degraded_proof WHERE note='before-degradation';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.ReadyInstances == 3, "All 3 instances are ready", fmt.Sprintf("%d/3 ready", c.Status.ReadyInstances)))
		checks = append(checks, boolCheck(streaming.count() == 2, "Two replicas are streaming from the primary", fmt.Sprintf("%d streaming", streaming.count())))
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'before-degradation' exists", fmt.Sprintf("%d row(s)", row.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/degraded-target.txt")
		if !found {
			checks = append(checks, noItem("/root/degraded-target.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/degraded-target.txt was written", "found"))
		named := namedIn(podNames(pods), body)
		checks = append(checks, boolCheck(named != "" && named != a.baselinePrimary(),
			"It names one of the two replicas, not the primary",
			fmt.Sprintf("file says %q, the primary is %q", firstLine(body), a.baselinePrimary())))
		return finish(checks), nil

	case "degrade-and-time":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		target, _ := readFileAnyNode(ctx, docker, a, "/root/degraded-target.txt")
		named := namedIn(podNames(pods), target)

		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/recovery-seconds.txt")
		if !found {
			checks = append(checks, noItem("/root/recovery-seconds.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/recovery-seconds.txt was written", "found"))
		measured, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(firstNumber(body) != "" && float64(measured) < degradedRecoveryBudget,
			"It records a recovery time under 60 seconds", fmt.Sprintf("file says %q", strings.TrimSpace(body))))
		checks = append(checks, boolCheck(named != "" && podPhase(pods, named) == "Running",
			"The instance you deleted is running again", fmt.Sprintf("%s is %s", named, podPhase(pods, named))))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster reports healthy with 3 of 3 ready", fmt.Sprintf("%s, %d/3", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "no-failover":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SELECT count(*) FROM pg_stat_replication WHERE state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.CurrentPrimary == a.baselinePrimary() && c.Status.CurrentPrimary != "",
			"The primary never changed", fmt.Sprintf("still %q", c.Status.CurrentPrimary)))
		checks = append(checks, boolCheck(c.Status.TimelineID == 1, "The cluster is still on its original timeline", fmt.Sprintf("timeline %d", c.Status.TimelineID)))
		checks = append(checks, boolCheck(streaming.count() == 2, "Both replicas are streaming again", fmt.Sprintf("%d streaming", streaming.count())))
		return finish(checks), nil

	case "confirm-data":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		agree := 0
		for _, p := range pods.Items {
			res, err := psqlSuper(ctx, docker, server, p.Metadata.Name, "app", "SELECT count(*) FROM degraded_proof WHERE note='before-degradation';")
			if err == nil && res.count() >= 1 {
				agree++
			}
		}
		after, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM degraded_proof WHERE note='after-recovery';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(agree == len(pods.Items) && agree > 0,
			"The 'before-degradation' row is intact on all 3 instances", fmt.Sprintf("%d of %d instance(s)", agree, len(pods.Items))))
		checks = append(checks, boolCheck(after.count() >= 1,
			"A row noted 'after-recovery' reached the primary through pg-cluster-rw", fmt.Sprintf("%d row(s)", after.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-degraded-recovery", taskID)
}

/* ---- Lab 13: PVC deletion ---- */

func checkPVCDeletion(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "survey-and-write":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		var pvcs pvcList
		if err := kubectlJSON(ctx, k3d, server, &pvcs, "get", "pvc"); err != nil {
			return CheckResult{}, err
		}
		bound := 0
		for _, p := range pvcs.Items {
			if p.Status.Phase == "Bound" {
				bound++
			}
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM pvc_proof WHERE note='before-pvc-deletion';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(bound == 3, "All 3 PVCs are Bound", fmt.Sprintf("%d bound", bound)))
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'before-pvc-deletion' exists", fmt.Sprintf("%d row(s)", row.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/old-volume.txt")
		if !found {
			checks = append(checks, noItem("/root/old-volume.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/old-volume.txt was written", "found"))
		// The recorded volume has to belong to a replica: deleting the primary's claim is a
		// different (and much less instructive) exercise than rebuilding a replica.
		owner := ""
		for _, p := range pvcs.Items {
			if p.Spec.VolumeName != "" && strings.Contains(body, p.Spec.VolumeName) {
				owner = p.Metadata.Name
			}
		}
		checks = append(checks, boolCheck(owner != "" && owner != a.baselinePrimary(),
			"It names the volume behind one of the two replicas",
			fmt.Sprintf("file says %q, which backs %q (the primary is %q)", firstLine(body), detailOr("nothing", owner, owner == ""), a.baselinePrimary())))
		return finish(checks), nil

	case "delete-pvc":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		var pvcs pvcList
		if err := kubectlJSON(ctx, k3d, server, &pvcs, "get", "pvc"); err != nil {
			return CheckResult{}, err
		}
		oldVol, _ := readFileAnyNode(ctx, docker, a, "/root/old-volume.txt")
		oldVol = strings.TrimSpace(oldVol)

		stillThere := false
		bound := 0
		volumes := map[string]bool{}
		for _, p := range pvcs.Items {
			if p.Status.Phase == "Bound" {
				bound++
				volumes[p.Spec.VolumeName] = true
			}
			if oldVol != "" && p.Spec.VolumeName == oldVol {
				stillThere = true
			}
		}
		running := 0
		for _, p := range pods.Items {
			if p.Status.Phase == "Running" {
				running++
			}
		}
		oldVolDetail := "gone: " + oldVol
		if oldVol == "" {
			oldVolDetail = "nothing recorded in /root/old-volume.txt"
		} else if stillThere {
			// The usual reason to be here: the claim is Terminating but its finalizer is still
			// held by the running Pod, so nothing has actually been released yet.
			oldVolDetail = "still bound: " + oldVol
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(oldVol != "" && !stillThere,
			"No PVC is backed by the old volume any more", oldVolDetail))
		checks = append(checks, boolCheck(bound == 3 && len(volumes) == 3,
			"All 3 PVCs are Bound again, on 3 different volumes", fmt.Sprintf("%d bound, %d distinct volume(s)", bound, len(volumes))))
		checks = append(checks, boolCheck(running == 3, "All 3 instances are running", fmt.Sprintf("%d running", running)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster reports healthy with 3 of 3 ready", fmt.Sprintf("%s, %d/3", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil

	case "confirm-rebuild":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SELECT count(*) FROM pg_stat_replication WHERE state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		agree := 0
		for _, p := range pods.Items {
			res, err := psqlSuper(ctx, docker, server, p.Metadata.Name, "app", "SELECT count(*) FROM pvc_proof WHERE note='before-pvc-deletion';")
			if err == nil && res.count() >= 1 {
				agree++
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(streaming.count() == 2, "Two replicas are streaming from the primary", fmt.Sprintf("%d streaming", streaming.count())))
		checks = append(checks, boolCheck(agree == len(pods.Items) && agree > 0,
			"The 'before-pvc-deletion' row is present on every instance", fmt.Sprintf("%d of %d instance(s)", agree, len(pods.Items))))
		checks = append(checks, boolCheck(c.Status.CurrentPrimary == a.baselinePrimary() && c.Status.CurrentPrimary != "",
			"The primary never changed", fmt.Sprintf("still %q", c.Status.CurrentPrimary)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-pvc-deletion", taskID)
}

/* ---- Lab 14: Corrupted PVC ---- */

func checkCorruptedPVC(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "locate-the-data":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM corruption_proof WHERE note='before-corruption';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'before-corruption' exists", fmt.Sprintf("%d row(s)", row.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/pgdata-path.txt")
		if !found {
			checks = append(checks, noItem("/root/pgdata-path.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/pgdata-path.txt was written", "found"))
		path := firstLine(body)
		// Verified by looking for it: a data directory that really exists on a node, with
		// PG_VERSION inside it, rather than a plausible-looking string.
		node := nodeWithFile(ctx, docker, a, strings.TrimRight(path, "/")+"/PG_VERSION")
		checks = append(checks, boolCheck(node != "", "It names a real PostgreSQL data directory on one of the nodes",
			detailOr("no PG_VERSION under "+path, "found on "+node, node == "")))
		owner := namedIn(podNames(pods), path)
		checks = append(checks, boolCheck(owner != "" && owner != a.baselinePrimary(),
			"The directory belongs to one of the two replicas",
			fmt.Sprintf("path names %q (the primary is %q)", detailOr("no instance", owner, owner == ""), a.baselinePrimary())))
		return finish(checks), nil

	case "fence-and-corrupt":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		path, _ := readFileAnyNode(ctx, docker, a, "/root/pgdata-path.txt")
		target := namedIn(podNames(pods), firstLine(path))

		ready := map[string]bool{}
		for _, p := range pods.Items {
			for _, cs := range p.Status.ContainerStatuses {
				if cs.Ready {
					ready[p.Metadata.Name] = true
				}
			}
		}
		logs := ""
		if target != "" {
			res, err := runSQL(ctx, docker, server, []string{"kubectl", "logs", target, "--tail=300"})
			if err == nil {
				logs = res.stdout + res.stderr
			}
		}
		crc := strings.Contains(logs, "calculated CRC checksum does not match") ||
			strings.Contains(logs, "database files are incompatible with server")

		var checks []CheckItem
		checks = append(checks, boolCheck(target != "" && !ready[target], "The corrupted instance is not ready",
			fmt.Sprintf("%s ready=%v", detailOr("no instance recorded", target, target == ""), ready[target])))
		checks = append(checks, boolCheck(crc, "Its log shows PostgreSQL refusing to start on the corrupt control file",
			detailOr("no control-file error in the last 300 log lines", "pg_controldata reports a CRC mismatch", !crc)))
		checks = append(checks, boolCheck(c.Status.ReadyInstances == 2, "The cluster reports 2 of 3 instances ready", fmt.Sprintf("%d/3 ready", c.Status.ReadyInstances)))

		probe, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT 1;")
		if err != nil {
			return CheckResult{}, err
		}
		checks = append(checks, boolCheck(probe.ok() && strings.TrimSpace(probe.stdout) == "1",
			"The primary is unaffected — pg-cluster-rw still answers", detailOr(firstLine(probe.stderr), "SELECT 1 succeeded", !probe.ok())))
		return finish(checks), nil

	case "repair":
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		path, _ := readFileAnyNode(ctx, docker, a, "/root/pgdata-path.txt")
		target := namedIn(podNames(pods), firstLine(path))

		var pvcs pvcList
		_ = kubectlJSON(ctx, k3d, server, &pvcs, "get", "pvc")
		newVolume := ""
		for _, p := range pvcs.Items {
			if p.Metadata.Name == target {
				newVolume = p.Spec.VolumeName
			}
		}
		streaming, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "postgres", "SELECT count(*) FROM pg_stat_replication WHERE state='streaming';")
		if err != nil {
			return CheckResult{}, err
		}
		var rowOnTarget sqlResult
		if target != "" {
			rowOnTarget, _ = psqlSuper(ctx, docker, server, target, "app", "SELECT count(*) FROM corruption_proof WHERE note='before-corruption';")
		}

		var checks []CheckItem
		// The old volume's name is embedded in the path the learner recorded, so a rebuilt
		// instance is one whose claim points somewhere else entirely.
		checks = append(checks, boolCheck(newVolume != "" && !strings.Contains(firstLine(path), newVolume),
			"The instance is on a different volume than the one you corrupted",
			fmt.Sprintf("now %q, corrupted path was %q", newVolume, firstLine(path))))
		checks = append(checks, boolCheck(c.Status.ReadyInstances == 3 && c.Status.Phase == "Cluster in healthy state",
			"All 3 instances are ready again", fmt.Sprintf("%s, %d/3", c.Status.Phase, c.Status.ReadyInstances)))
		checks = append(checks, boolCheck(streaming.count() == 2, "The rebuilt instance is streaming from the primary", fmt.Sprintf("%d streaming", streaming.count())))
		checks = append(checks, boolCheck(rowOnTarget.count() >= 1, "The 'before-corruption' row is present on the rebuilt instance", fmt.Sprintf("%d row(s) on %s", rowOnTarget.count(), target)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-corrupted-pvc", taskID)
}

/* ---- Lab 15: Backups and ScheduledBackups on SeaweedFS ---- */

// bucketLS lists a path inside the attempt's own SeaweedFS container, using the object
// store's shell rather than anything in Kubernetes — so "the backup exists" is answered by
// the storage itself, not by the resource that claims to have written it.
func bucketLS(ctx context.Context, docker *Docker, a *Attempt, path string) (string, error) {
	id := a.seaweedIDSnap()
	if id == "" {
		return "", fmt.Errorf("this attempt has no object store")
	}
	res, err := docker.Exec(ctx, id, []string{"sh", "-c", "printf 'fs.ls " + path + "\\n' | weed shell"}, nil, "/")
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("weed shell: exit %d: %s", res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return strings.TrimSpace(res.Stdout), nil
}

type backupList struct {
	Items []struct {
		Metadata struct {
			Name            string `json:"name"`
			OwnerReferences []struct {
				Kind string `json:"kind"`
				Name string `json:"name"`
			} `json:"ownerReferences"`
		} `json:"metadata"`
		Spec struct {
			Method string `json:"method"`
		} `json:"spec"`
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
	} `json:"items"`
}

func checkBarmanBackup(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "wire-the-store":
		var secret struct {
			Data map[string]string `json:"data"`
		}
		secretErr := kubectlJSON(ctx, k3d, server, &secret, "get", "secret", "seaweedfs-creds")
		var store struct {
			Spec struct {
				Configuration struct {
					DestinationPath string `json:"destinationPath"`
					EndpointURL     string `json:"endpointURL"`
				} `json:"configuration"`
			} `json:"spec"`
		}
		storeErr := kubectlJSON(ctx, k3d, server, &store, "get", "objectstore.barmancloud.cnpg.io", objectStoreName)

		var checks []CheckItem
		hasKeys := secretErr == nil && secret.Data["ACCESS_KEY_ID"] != "" && secret.Data["ACCESS_SECRET_KEY"] != ""
		checks = append(checks, boolCheck(hasKeys, "Secret seaweedfs-creds holds the object store credentials",
			detailOr(errText(secretErr, "missing ACCESS_KEY_ID or ACCESS_SECRET_KEY"), "both keys present", !hasKeys)))
		checks = append(checks, boolCheck(storeErr == nil, "objectstore.barmancloud.cnpg.io/"+objectStoreName+" exists",
			detailOr("not applied yet", "found", storeErr != nil)))
		wantPath := "s3://" + backupBucket + "/"
		wantURL := fmt.Sprintf("http://%s:%d", seaweedSvcName, seaweedS3Port)
		checks = append(checks, boolCheck(storeErr == nil &&
			strings.HasPrefix(store.Spec.Configuration.DestinationPath, wantPath) &&
			store.Spec.Configuration.EndpointURL == wantURL,
			"It points at the "+wantPath+" bucket on "+wantURL,
			fmt.Sprintf("destinationPath=%q endpointURL=%q", store.Spec.Configuration.DestinationPath, store.Spec.Configuration.EndpointURL)))
		return finish(checks), nil

	case "enable-archiving":
		var c struct {
			Spec struct {
				Plugins []struct {
					Name          string            `json:"name"`
					IsWALArchiver bool              `json:"isWALArchiver"`
					Parameters    map[string]string `json:"parameters"`
				} `json:"plugins"`
			} `json:"spec"`
			Status struct {
				Phase          string `json:"phase"`
				ReadyInstances int    `json:"readyInstances"`
				Conditions     []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		}
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		archiver := false
		named := ""
		for _, p := range c.Spec.Plugins {
			if p.Name == barmanPluginName {
				archiver = p.IsWALArchiver
				named = p.Parameters["barmanObjectName"]
			}
		}
		archiving := ""
		for _, cond := range c.Status.Conditions {
			if cond.Type == "ContinuousArchiving" {
				archiving = cond.Status
			}
		}
		wals, walsErr := bucketLS(ctx, docker, a, "/buckets/"+backupBucket+"/pg-cluster/wals")

		var checks []CheckItem
		checks = append(checks, boolCheck(archiver, "The Cluster declares the barman-cloud plugin as its WAL archiver",
			detailOr("no plugin with isWALArchiver: true", "isWALArchiver: true", !archiver)))
		checks = append(checks, boolCheck(named == objectStoreName, "It names the "+objectStoreName+" object store",
			fmt.Sprintf("barmanObjectName=%q", named)))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster is healthy again after the rollout", fmt.Sprintf("%s, %d/3", c.Status.Phase, c.Status.ReadyInstances)))
		checks = append(checks, boolCheck(archiving == "True", "The cluster reports ContinuousArchiving=True",
			detailOr("condition is "+detailOr("absent", archiving, archiving == ""), "True", archiving != "True")))
		checks = append(checks, boolCheck(walsErr == nil && wals != "",
			"WAL files have appeared in the bucket", detailOr(errText(walsErr, "nothing under wals/"), firstLine(wals), walsErr != nil || wals == "")))
		return finish(checks), nil

	case "take-a-backup":
		var backups backupList
		if err := kubectlJSON(ctx, k3d, server, &backups, "get", "backup"); err != nil {
			return CheckResult{}, err
		}
		viaPlugin, completed := 0, 0
		for _, b := range backups.Items {
			if b.Spec.Method == "plugin" {
				viaPlugin++
				if b.Status.Phase == "completed" {
					completed++
				}
			}
		}
		base, baseErr := bucketLS(ctx, docker, a, "/buckets/"+backupBucket+"/pg-cluster/base")

		var checks []CheckItem
		checks = append(checks, boolCheck(viaPlugin >= 1, "A Backup resource exists, taken with the plugin method", fmt.Sprintf("%d plugin backup(s)", viaPlugin)))
		checks = append(checks, boolCheck(completed >= 1, "It reports phase completed", fmt.Sprintf("%d completed", completed)))
		checks = append(checks, boolCheck(baseErr == nil && base != "",
			"A base backup really exists in the bucket", detailOr(errText(baseErr, "nothing under base/"), base, baseErr != nil || base == "")))
		return finish(checks), nil

	case "schedule-backups":
		var scheduled struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
				Spec struct {
					Schedule string `json:"schedule"`
				} `json:"spec"`
				Status struct {
					LastCheckTime    string `json:"lastCheckTime"`
					LastScheduleTime string `json:"lastScheduleTime"`
				} `json:"status"`
			} `json:"items"`
		}
		if err := kubectlJSON(ctx, k3d, server, &scheduled, "get", "scheduledbackup"); err != nil {
			return CheckResult{}, err
		}
		var backups backupList
		_ = kubectlJSON(ctx, k3d, server, &backups, "get", "backup")

		fromSchedule := 0
		for _, b := range backups.Items {
			owned := false
			for _, o := range b.Metadata.OwnerReferences {
				if o.Kind == "ScheduledBackup" {
					owned = true
				}
			}
			if owned && b.Status.Phase == "completed" {
				fromSchedule++
			}
		}
		fired := ""
		for _, s := range scheduled.Items {
			if s.Status.LastScheduleTime != "" {
				fired = s.Status.LastScheduleTime
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(len(scheduled.Items) >= 1, "A ScheduledBackup exists for pg-cluster", fmt.Sprintf("%d scheduled backup(s)", len(scheduled.Items))))
		checks = append(checks, boolCheck(fired != "", "It has fired at least once", detailOr("no lastScheduleTime yet", "last fired "+fired, fired == "")))
		checks = append(checks, boolCheck(fromSchedule >= 1, "A Backup it created has completed", fmt.Sprintf("%d completed backup(s) owned by a schedule", fromSchedule)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-barman-backup", taskID)
}

/* ---- Lab 16: Backup and restore from Volume Snapshots ---- */

type volumeSnapshotList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Spec struct {
			Source struct {
				PersistentVolumeClaimName string `json:"persistentVolumeClaimName"`
			} `json:"source"`
			VolumeSnapshotClassName string `json:"volumeSnapshotClassName"`
		} `json:"spec"`
		Status struct {
			ReadyToUse *bool `json:"readyToUse"`
		} `json:"status"`
	} `json:"items"`
}

// pvcDataSource reports what a claim was created from — for a restored instance this is the
// VolumeSnapshot itself, which is the difference between "restored" and "freshly initdb'd".
type pvcDataSource struct {
	Spec struct {
		DataSource struct {
			APIGroup string `json:"apiGroup"`
			Kind     string `json:"kind"`
			Name     string `json:"name"`
		} `json:"dataSource"`
		StorageClassName string `json:"storageClassName"`
	} `json:"spec"`
	Status struct {
		Phase string `json:"phase"`
	} `json:"status"`
}

func checkVolumeSnapshots(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "survey-the-driver":
		var pvc pvcDataSource
		pvcErr := kubectlJSON(ctx, k3d, server, &pvc, "get", "pvc", "pg-cluster-1")
		var classes struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
				Driver string `json:"driver"`
			} `json:"items"`
		}
		classErr := kubectlJSON(ctx, k3d, server, &classes, "get", "volumesnapshotclass")
		haveClass := ""
		if classErr == nil {
			for _, c := range classes.Items {
				if c.Metadata.Name == snapshotClassName {
					haveClass = c.Driver
				}
			}
		}
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM snap_proof WHERE note='before-snapshot';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(pvcErr == nil && pvc.Spec.StorageClassName == snapshotStorageClass && pvc.Status.Phase == "Bound",
			"The cluster's volume is Bound on the "+snapshotStorageClass+" StorageClass",
			fmt.Sprintf("%s on %q", pvc.Status.Phase, pvc.Spec.StorageClassName)))
		checks = append(checks, boolCheck(haveClass == "hostpath.csi.k8s.io",
			"A VolumeSnapshotClass named "+snapshotClassName+" exists",
			detailOr("not found", "driver "+haveClass, haveClass == "")))
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'before-snapshot' exists", fmt.Sprintf("%d row(s)", row.count())))
		return finish(checks), nil

	case "take-snapshot":
		var backups backupList
		if err := kubectlJSON(ctx, k3d, server, &backups, "get", "backup"); err != nil {
			return CheckResult{}, err
		}
		completed := ""
		for _, b := range backups.Items {
			if b.Spec.Method == "volumeSnapshot" && b.Status.Phase == "completed" {
				completed = b.Metadata.Name
			}
		}
		var snaps volumeSnapshotList
		snapErr := kubectlJSON(ctx, k3d, server, &snaps, "get", "volumesnapshot")
		ofCluster, ready := "", false
		for _, s := range snaps.Items {
			if strings.HasPrefix(s.Spec.Source.PersistentVolumeClaimName, "pg-cluster-") {
				ofCluster = s.Metadata.Name
				if s.Status.ReadyToUse != nil && *s.Status.ReadyToUse {
					ready = true
				}
			}
		}
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		after, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM snap_proof WHERE note='after-snapshot';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(completed != "", "A Backup with method volumeSnapshot completed",
			detailOr("no completed volumeSnapshot backup", completed, completed == "")))
		checks = append(checks, boolCheck(snapErr == nil && ofCluster != "",
			"A VolumeSnapshot exists for the cluster's volume", detailOr("none found", ofCluster, ofCluster == "")))
		checks = append(checks, boolCheck(ready, "It reports readyToUse: true", detailOr("not ready yet", "ready", !ready)))
		checks = append(checks, boolCheck(after.count() >= 1,
			"A row noted 'after-snapshot' was written to the original cluster", fmt.Sprintf("%d row(s)", after.count())))
		return finish(checks), nil

	case "restore":
		var restored struct {
			Status struct {
				Phase          string `json:"phase"`
				ReadyInstances int    `json:"readyInstances"`
			} `json:"status"`
		}
		restoredErr := kubectlJSON(ctx, k3d, server, &restored, "get", "cluster.postgresql.cnpg.io", restoredClusterName)
		var pvc pvcDataSource
		pvcErr := kubectlJSON(ctx, k3d, server, &pvc, "get", "pvc", restoredClusterName+"-1")

		var checks []CheckItem
		checks = append(checks, boolCheck(restoredErr == nil, "cluster.postgresql.cnpg.io/"+restoredClusterName+" exists",
			detailOr("not applied yet", "found", restoredErr != nil)))
		fromSnapshot := pvcErr == nil && pvc.Spec.DataSource.Kind == "VolumeSnapshot" && pvc.Spec.DataSource.Name != ""
		checks = append(checks, boolCheck(fromSnapshot, "Its volume was created from the VolumeSnapshot",
			detailOr("no dataSource on the claim", fmt.Sprintf("dataSource %s/%s", pvc.Spec.DataSource.Kind, pvc.Spec.DataSource.Name), !fromSnapshot)))
		checks = append(checks, boolCheck(restored.Status.Phase == "Cluster in healthy state" && restored.Status.ReadyInstances == 1,
			"The restored cluster reports healthy", fmt.Sprintf("%s, %d/1", restored.Status.Phase, restored.Status.ReadyInstances)))
		return finish(checks), nil

	case "verify-restore":
		before, err := psqlSuper(ctx, docker, server, restoredClusterName+"-1", "app", "SELECT count(*) FROM snap_proof WHERE note='before-snapshot';")
		if err != nil {
			return CheckResult{}, err
		}
		after, err := psqlSuper(ctx, docker, server, restoredClusterName+"-1", "app", "SELECT count(*) FROM snap_proof WHERE note='after-snapshot';")
		if err != nil {
			return CheckResult{}, err
		}
		var svcs serviceList
		_ = kubectlJSON(ctx, k3d, server, &svcs, "get", "svc")
		missing := svcs.missing(restoredClusterName+"-rw", restoredClusterName+"-ro", restoredClusterName+"-r")

		var checks []CheckItem
		checks = append(checks, boolCheck(before.count() >= 1,
			"The 'before-snapshot' row is present in the restored cluster", fmt.Sprintf("%d row(s)", before.count())))
		// The point of the whole lab: a snapshot is a point in time, and everything written
		// to the original after it was taken is simply not in the copy.
		checks = append(checks, boolCheck(after.ok() && after.count() == 0,
			"The 'after-snapshot' row is absent — the copy stops at the snapshot",
			fmt.Sprintf("%d row(s) found", after.count())))
		checks = append(checks, boolCheck(len(missing) == 0,
			"The restored cluster has its own -rw, -ro and -r Services",
			detailOr(strings.Join(missing, ", ")+" missing", "all three exist", len(missing) > 0)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-volume-snapshots", taskID)
}

/* ---- Labs 17 & 18: Restore, and point-in-time recovery, from object storage ---- */

// recoveryCluster is a cluster that was bootstrapped by recovering rather than by initdb.
type recoveryCluster struct {
	Spec struct {
		Bootstrap struct {
			Recovery struct {
				Source         string `json:"source"`
				RecoveryTarget struct {
					TargetTime string `json:"targetTime"`
				} `json:"recoveryTarget"`
			} `json:"recovery"`
		} `json:"bootstrap"`
		ExternalClusters []struct {
			Name   string `json:"name"`
			Plugin struct {
				Name       string            `json:"name"`
				Parameters map[string]string `json:"parameters"`
			} `json:"plugin"`
		} `json:"externalClusters"`
	} `json:"spec"`
	Status struct {
		Phase          string `json:"phase"`
		ReadyInstances int    `json:"readyInstances"`
	} `json:"status"`
}

// recoversFromObjectStore reports whether this cluster bootstraps by recovery through the
// barman-cloud plugin — the difference between a restored database and a brand-new one.
func (r recoveryCluster) recoversFromObjectStore() bool {
	src := r.Spec.Bootstrap.Recovery.Source
	if src == "" {
		return false
	}
	for _, e := range r.Spec.ExternalClusters {
		if e.Name == src && e.Plugin.Name == barmanPluginName && e.Plugin.Parameters["barmanObjectName"] == objectStoreName {
			return true
		}
	}
	return false
}

func checkBarmanRestore(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const restored = "pg-restored"
	switch taskID {
	case "survey-the-archive":
		var c cnpgCluster
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		archiving := ""
		for _, cond := range c.Status.Conditions {
			if cond.Type == "ContinuousArchiving" {
				archiving = cond.Status
			}
		}
		var backups backupList
		_ = kubectlJSON(ctx, k3d, server, &backups, "get", "backup")
		completed := 0
		for _, b := range backups.Items {
			if b.Status.Phase == "completed" {
				completed++
			}
		}
		base, baseErr := bucketLS(ctx, docker, a, "/buckets/"+backupBucket+"/pg-cluster/base")
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM restore_proof WHERE note='after-backup';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(archiving == "True", "The cluster is archiving WAL to the object store",
			detailOr("ContinuousArchiving is "+detailOr("absent", archiving, archiving == ""), "ContinuousArchiving=True", archiving != "True")))
		checks = append(checks, boolCheck(completed >= 1, "A completed Backup already exists", fmt.Sprintf("%d completed", completed)))
		checks = append(checks, boolCheck(baseErr == nil && base != "", "The bucket holds a base backup",
			detailOr(errText(baseErr, "nothing under base/"), base, baseErr != nil || base == "")))
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'after-backup' exists", fmt.Sprintf("%d row(s)", row.count())))
		return finish(checks), nil

	case "restore":
		var r recoveryCluster
		err := kubectlJSON(ctx, k3d, server, &r, "get", "cluster.postgresql.cnpg.io", restored)
		var checks []CheckItem
		checks = append(checks, boolCheck(err == nil, "cluster.postgresql.cnpg.io/"+restored+" exists",
			detailOr("not applied yet", "found", err != nil)))
		checks = append(checks, boolCheck(err == nil && r.recoversFromObjectStore(),
			"It bootstraps by recovery from the barman-cloud external cluster",
			fmt.Sprintf("recovery source %q", r.Spec.Bootstrap.Recovery.Source)))
		checks = append(checks, boolCheck(r.Status.Phase == "Cluster in healthy state" && r.Status.ReadyInstances == 1,
			"The restored cluster reports healthy", fmt.Sprintf("%s, %d/1", r.Status.Phase, r.Status.ReadyInstances)))
		return finish(checks), nil

	case "verify-restore":
		onRestored, err := psqlSuper(ctx, docker, server, restored+"-1", "app", "SELECT count(*) FROM restore_proof WHERE note='after-backup';")
		if err != nil {
			return CheckResult{}, err
		}
		var svcs serviceList
		_ = kubectlJSON(ctx, k3d, server, &svcs, "get", "svc")
		missing := svcs.missing(restored+"-rw", restored+"-ro", restored+"-r")
		// The original has to be untouched — a restore that disturbed the source would be a
		// migration, not a restore.
		probe, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "INSERT INTO restore_proof (note) VALUES ('grader-probe') RETURNING id;")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(onRestored.count() >= 1,
			"The restored cluster contains the row written after the base backup",
			fmt.Sprintf("%d row(s) — replayed from the WAL archive", onRestored.count())))
		checks = append(checks, boolCheck(len(missing) == 0, "It is a separate cluster with its own Services",
			detailOr(strings.Join(missing, ", ")+" missing", "all three exist", len(missing) > 0)))
		checks = append(checks, boolCheck(probe.ok(), "The original cluster is untouched and still taking writes",
			detailOr(firstLine(probe.stderr), "accepted a write", !probe.ok())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-barman-restore", taskID)
}

func checkPITR(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const recovered = "pg-pitr"
	switch taskID {
	case "write-and-mark":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		// Both rows and their commit times, read straight out of the source database.
		times, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app",
			"SELECT coalesce(max(at) FILTER (WHERE note='first'),'-infinity')||'|'||coalesce(max(at) FILTER (WHERE note='second'),'-infinity') FROM pitr_proof;")
		if err != nil {
			return CheckResult{}, err
		}
		firstAt, secondAt := splitPipe(times.stdout)

		var checks []CheckItem
		checks = append(checks, boolCheck(firstAt != "" && firstAt != "-infinity", "A row noted 'first' exists", detailOr("not found", firstAt, firstAt == "-infinity")))
		checks = append(checks, boolCheck(secondAt != "" && secondAt != "-infinity", "A row noted 'second' exists, committed after it", detailOr("not found", secondAt, secondAt == "-infinity")))

		body, found := readFileAnyNode(ctx, docker, a, "/root/target-time.txt")
		if !found {
			checks = append(checks, noItem("/root/target-time.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/target-time.txt was written", "found"))
		// The recorded moment has to sit between the two commits, or the recovery it drives
		// proves nothing.
		between := false
		if t, ok := parsePGTime(firstLine(body)); ok {
			if f, ok1 := parsePGTime(firstAt); ok1 {
				if sec, ok2 := parsePGTime(secondAt); ok2 {
					between = t.After(f) && t.Before(sec)
				}
			}
		}
		checks = append(checks, boolCheck(between, "It holds a moment between the two rows",
			fmt.Sprintf("recorded %q, rows at %s and %s", firstLine(body), firstAt, secondAt)))
		return finish(checks), nil

	case "restore-to-target":
		var r recoveryCluster
		err := kubectlJSON(ctx, k3d, server, &r, "get", "cluster.postgresql.cnpg.io", recovered)
		recorded, _ := readFileAnyNode(ctx, docker, a, "/root/target-time.txt")

		var checks []CheckItem
		checks = append(checks, boolCheck(err == nil, "cluster.postgresql.cnpg.io/"+recovered+" exists",
			detailOr("not applied yet", "found", err != nil)))
		target := r.Spec.Bootstrap.Recovery.RecoveryTarget.TargetTime
		checks = append(checks, boolCheck(target != "", "Its bootstrap declares a recoveryTarget targetTime",
			detailOr("no recoveryTarget", target, target == "")))
		checks = append(checks, boolCheck(target != "" && strings.TrimSpace(target) == firstLine(recorded),
			"The targetTime is the moment you recorded",
			fmt.Sprintf("manifest says %q, you recorded %q", target, firstLine(recorded))))
		checks = append(checks, boolCheck(r.Status.Phase == "Cluster in healthy state" && r.Status.ReadyInstances == 1,
			"The recovered cluster reports healthy", fmt.Sprintf("%s, %d/1", r.Status.Phase, r.Status.ReadyInstances)))
		return finish(checks), nil

	case "verify-pitr":
		first, err := psqlSuper(ctx, docker, server, recovered+"-1", "app", "SELECT count(*) FROM pitr_proof WHERE note='first';")
		if err != nil {
			return CheckResult{}, err
		}
		second, err := psqlSuper(ctx, docker, server, recovered+"-1", "app", "SELECT count(*) FROM pitr_proof WHERE note='second';")
		if err != nil {
			return CheckResult{}, err
		}
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		both, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(DISTINCT note) FROM pitr_proof WHERE note IN ('first','second');")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(first.count() >= 1, "The recovered cluster contains the 'first' row", fmt.Sprintf("%d row(s)", first.count())))
		checks = append(checks, boolCheck(second.ok() && second.count() == 0,
			"The 'second' row is absent — recovery stopped at your target", fmt.Sprintf("%d row(s) found", second.count())))
		checks = append(checks, boolCheck(both.count() == 2, "The original cluster still has both rows", fmt.Sprintf("%d of 2", both.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-pitr", taskID)
}

// parsePGTime reads the timestamp format psql prints (and CloudNativePG accepts as a
// recovery target): "2026-08-15 11:13:31.110651+00".
func parsePGTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999-07",
		"2006-01-02 15:04:05.999999-07:00",
		"2006-01-02 15:04:05-07",
		time.RFC3339Nano,
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

/* ---- Lab 22: WAL restore, sequential and parallel ---- */

func checkWALRestore(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	// walSegments counts what is really in the archive, from the object store's side. The
	// archive is split into a directory per WAL "prefix", and a run of a hundred segments
	// crosses into the next one — so counting a single directory undercounts.
	walSegments := func() int {
		dirs, err := bucketLS(ctx, docker, a, "/buckets/"+backupBucket+"/pg-cluster/wals")
		if err != nil {
			return 0
		}
		n := 0
		for _, d := range strings.Fields(dirs) {
			out, err := bucketLS(ctx, docker, a, "/buckets/"+backupBucket+"/pg-cluster/wals/"+d)
			if err != nil {
				continue
			}
			for _, l := range strings.Split(out, "\n") {
				if strings.HasSuffix(strings.TrimSpace(l), ".gz") {
					n++
				}
			}
		}
		return n
	}
	maxParallel := func() int {
		var store struct {
			Spec struct {
				Configuration struct {
					Wal struct {
						MaxParallel int `json:"maxParallel"`
					} `json:"wal"`
				} `json:"configuration"`
			} `json:"spec"`
		}
		if err := kubectlJSON(ctx, k3d, server, &store, "get", "objectstore.barmancloud.cnpg.io", objectStoreName); err != nil {
			return 0
		}
		return store.Spec.Configuration.Wal.MaxParallel
	}
	healthy := func(name string) (bool, string) {
		var r recoveryCluster
		if err := kubectlJSON(ctx, k3d, server, &r, "get", "cluster.postgresql.cnpg.io", name); err != nil {
			return false, "not applied yet"
		}
		return r.Status.Phase == "Cluster in healthy state" && r.Status.ReadyInstances == 1,
			fmt.Sprintf("%s, %d/1", r.Status.Phase, r.Status.ReadyInstances)
	}

	switch taskID {
	case "survey-the-archive":
		segments := walSegments()
		var checks []CheckItem
		checks = append(checks, boolCheck(segments >= 50, "The archive holds a substantial run of WAL segments",
			fmt.Sprintf("%d segment(s) in the bucket", segments)))
		checks = append(checks, boolCheck(maxParallel() == 0,
			"The ObjectStore does not set maxParallel yet — restores fetch WAL one segment at a time",
			fmt.Sprintf("maxParallel=%d", maxParallel())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/wal-count.txt")
		if !found {
			checks = append(checks, noItem("/root/wal-count.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/wal-count.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(body))
		// Deliberately a range rather than an equality: the archive keeps growing while the
		// lab is played, and PostgreSQL's archived_count and the object store's file count
		// drift apart by a few either way as segments are shipped.
		checks = append(checks, boolCheck(n >= 50 && n <= segments+50,
			"It records a plausible count of the archive", fmt.Sprintf("file says %q, the bucket holds %d", firstLine(body), segments)))
		return finish(checks), nil

	case "time-sequential":
		ok, detail := healthy("pg-seq")
		var checks []CheckItem
		checks = append(checks, boolCheck(ok, "The sequential restore completed and reports healthy", detail))
		checks = append(checks, boolCheck(maxParallel() == 0,
			"It ran with maxParallel unset — one segment fetched at a time", fmt.Sprintf("maxParallel=%d", maxParallel())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/sequential-seconds.txt")
		if !found {
			checks = append(checks, noItem("/root/sequential-seconds.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/sequential-seconds.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(n > 0 && n < 900, "It records how long that restore took", fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "time-parallel":
		ok, detail := healthy("pg-par")
		var checks []CheckItem
		checks = append(checks, boolCheck(maxParallel() >= 2,
			"The ObjectStore now sets maxParallel, so WAL is prefetched in parallel", fmt.Sprintf("maxParallel=%d", maxParallel())))
		checks = append(checks, boolCheck(ok, "The parallel restore completed and reports healthy", detail))

		seqBody, seqFound := readFileAnyNode(ctx, docker, a, "/root/sequential-seconds.txt")
		body, found := readFileAnyNode(ctx, docker, a, "/root/parallel-seconds.txt")
		if !found {
			checks = append(checks, noItem("/root/parallel-seconds.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/parallel-seconds.txt was written", "found"))
		par, _ := strconv.Atoi(firstNumber(body))
		seq, _ := strconv.Atoi(firstNumber(seqBody))
		checks = append(checks, boolCheck(seqFound && par > 0 && seq > 0 && par < seq,
			"It is shorter than the sequential run you timed",
			fmt.Sprintf("parallel %ds vs sequential %ds", par, seq)))
		return finish(checks), nil

	case "verify-both":
		source, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT count(*) FROM bulk;")
		if err != nil {
			return CheckResult{}, err
		}
		seq, err := psqlSuper(ctx, docker, server, "pg-seq-1", "app", "SELECT count(*) FROM bulk;")
		if err != nil {
			return CheckResult{}, err
		}
		par, err := psqlSuper(ctx, docker, server, "pg-par-1", "app", "SELECT count(*) FROM bulk;")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(source.count() > 0 && seq.count() == source.count(),
			"The sequentially restored cluster holds every row the source does",
			fmt.Sprintf("%d rows vs %d in the source", seq.count(), source.count())))
		checks = append(checks, boolCheck(source.count() > 0 && par.count() == source.count(),
			"So does the one restored with parallel WAL fetching",
			fmt.Sprintf("%d rows vs %d in the source", par.count(), source.count())))
		checks = append(checks, boolCheck(seq.count() == par.count(),
			"The two restores produced identical databases — parallelism changed the speed, not the result",
			fmt.Sprintf("%d and %d rows", seq.count(), par.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-wal-restore", taskID)
}

/* ---- Labs 19–21: The operator itself ---- */

func checkOperatorDeployment(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "namespace-anatomy":
		var deploy struct {
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		}
		deployErr := kubectlJSON(ctx, k3d, server, &deploy, "-n", cnpgNamespace, "get", "deploy", cnpgOperatorDeploy)
		ips, _ := serviceEndpointIPsIn(ctx, k3d, server, cnpgNamespace, "cnpg-webhook-service")
		var pods podList
		_ = kubectlJSON(ctx, k3d, server, &pods, "-n", cnpgNamespace, "get", "pods", "-l", "app.kubernetes.io/name=cloudnative-pg")

		var checks []CheckItem
		checks = append(checks, boolCheck(deployErr == nil && deploy.Status.ReadyReplicas == 1,
			"The operator Deployment reports 1 ready replica", fmt.Sprintf("%d ready", deploy.Status.ReadyReplicas)))
		checks = append(checks, boolCheck(len(ips) == 1, "cnpg-webhook-service has exactly one endpoint",
			fmt.Sprintf("%d: %s", len(ips), strings.Join(ips, ", "))))

		body, found := readFileAnyNode(ctx, docker, a, "/root/operator-pod.txt")
		if !found {
			checks = append(checks, noItem("/root/operator-pod.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/operator-pod.txt was written", "found"))
		named := namedIn(podNames(pods), body)
		checks = append(checks, boolCheck(named != "", "It names the running operator Pod",
			fmt.Sprintf("file says %q, the operator Pod is %q", firstLine(body), strings.Join(podNames(pods), ", "))))
		return finish(checks), nil

	case "webhooks":
		var validating struct {
			Webhooks []struct {
				Name  string `json:"name"`
				Rules []struct {
					Resources []string `json:"resources"`
				} `json:"rules"`
			} `json:"webhooks"`
		}
		vErr := kubectlJSON(ctx, k3d, server, &validating, "get", "validatingwebhookconfiguration", "cnpg-validating-webhook-configuration")
		var mutating struct {
			Webhooks []struct {
				Name string `json:"name"`
			} `json:"webhooks"`
		}
		mErr := kubectlJSON(ctx, k3d, server, &mutating, "get", "mutatingwebhookconfiguration", "cnpg-mutating-webhook-configuration")

		intercepts := false
		for _, w := range validating.Webhooks {
			for _, r := range w.Rules {
				for _, res := range r.Resources {
					if strings.HasPrefix(res, "clusters") {
						intercepts = true
					}
				}
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(vErr == nil && mErr == nil, "Both CNPG webhook configurations exist",
			fmt.Sprintf("validating: %d webhook(s), mutating: %d", len(validating.Webhooks), len(mutating.Webhooks))))
		checks = append(checks, boolCheck(intercepts, "The validating configuration intercepts clusters.postgresql.cnpg.io",
			detailOr("no rule covers clusters", "found a rule for clusters", !intercepts)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/webhook-count.txt")
		if !found {
			checks = append(checks, noItem("/root/webhook-count.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/webhook-count.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(n == len(validating.Webhooks) && n > 0,
			"It records how many webhooks the validating configuration has",
			fmt.Sprintf("file says %q, there are %d", firstLine(body), len(validating.Webhooks))))
		return finish(checks), nil

	case "prove-the-webhook":
		var deploy struct {
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		}
		_ = kubectlJSON(ctx, k3d, server, &deploy, "-n", cnpgNamespace, "get", "deploy", cnpgOperatorDeploy)

		var checks []CheckItem
		body, found := readFileAnyNode(ctx, docker, a, "/root/webhook-error.txt")
		if !found {
			checks = append(checks, noItem("/root/webhook-error.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/webhook-error.txt was written", "found"))
		refused := strings.Contains(body, "no endpoints available") || strings.Contains(body, "failed to call webhook") ||
			strings.Contains(body, "connection refused")
		checks = append(checks, boolCheck(refused, "It captured the API server refusing the Cluster while no operator was running",
			fmt.Sprintf("file says %q", firstLine(body))))
		checks = append(checks, boolCheck(deploy.Status.ReadyReplicas == 1, "The operator is running again",
			fmt.Sprintf("%d ready", deploy.Status.ReadyReplicas)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-operator-deployment", taskID)
}

const operatorConfigMap = "cnpg-controller-manager-config"

func checkOperatorConfigMap(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	type cmView struct {
		Metadata struct {
			CreationTimestamp string `json:"creationTimestamp"`
		} `json:"metadata"`
		Data map[string]string `json:"data"`
	}
	switch taskID {
	case "create-config":
		var cm cmView
		err := kubectlJSON(ctx, k3d, server, &cm, "-n", cnpgNamespace, "get", "cm", operatorConfigMap)
		var checks []CheckItem
		checks = append(checks, boolCheck(err == nil, "ConfigMap "+operatorConfigMap+" exists in "+cnpgNamespace,
			detailOr("not created yet", "found", err != nil)))
		labels := cm.Data["INHERITED_LABELS"]
		checks = append(checks, boolCheck(strings.Contains(labels, "team"),
			"It sets INHERITED_LABELS to include team", detailOr("INHERITED_LABELS is "+detailOr("unset", labels, labels == ""), labels, !strings.Contains(labels, "team"))))
		return finish(checks), nil

	case "label-without-restart":
		var c struct {
			Metadata struct {
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
		}
		if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		var pods podList
		_ = kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
		inherited := 0
		for _, p := range pods.Items {
			if p.Metadata.Labels["team"] != "" {
				inherited++
			}
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Metadata.Labels["team"] != "", "The Cluster carries the team label",
			detailOr("no team label on the Cluster", "team="+c.Metadata.Labels["team"], c.Metadata.Labels["team"] == "")))
		checks = append(checks, boolCheck(inherited == 0,
			"The instance Pods have not inherited it — the operator has not re-read its configuration",
			fmt.Sprintf("%d of %d Pod(s) carry it", inherited, len(pods.Items))))
		return finish(checks), nil

	case "restart-and-inherit":
		var cm cmView
		cmErr := kubectlJSON(ctx, k3d, server, &cm, "-n", cnpgNamespace, "get", "cm", operatorConfigMap)
		var opPods podList
		_ = kubectlJSON(ctx, k3d, server, &opPods, "-n", cnpgNamespace, "get", "pods", "-l", "app.kubernetes.io/name=cloudnative-pg")
		started := ""
		if len(opPods.Items) > 0 {
			var pod struct {
				Status struct {
					StartTime string `json:"startTime"`
				} `json:"status"`
			}
			if err := kubectlJSON(ctx, k3d, server, &pod, "-n", cnpgNamespace, "get", "pod", opPods.Items[0].Metadata.Name); err == nil {
				started = pod.Status.StartTime
			}
		}
		restartedAfter := false
		if cmErr == nil {
			if created, err1 := time.Parse(time.RFC3339, cm.Metadata.CreationTimestamp); err1 == nil {
				if start, err2 := time.Parse(time.RFC3339, started); err2 == nil {
					restartedAfter = start.After(created)
				}
			}
		}

		var pods podList
		_ = kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
		podsWith := 0
		for _, p := range pods.Items {
			if p.Metadata.Labels["team"] != "" {
				podsWith++
			}
		}
		var pvcLabels struct {
			Items []struct {
				Metadata struct {
					Labels map[string]string `json:"labels"`
				} `json:"metadata"`
			} `json:"items"`
		}
		_ = kubectlJSON(ctx, k3d, server, &pvcLabels, "get", "pvc")
		pvcsWith := 0
		for _, p := range pvcLabels.Items {
			if p.Metadata.Labels["team"] != "" {
				pvcsWith++
			}
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(restartedAfter, "The operator was restarted after the ConfigMap was created",
			fmt.Sprintf("ConfigMap %s, operator started %s", cm.Metadata.CreationTimestamp, started)))
		checks = append(checks, boolCheck(podsWith == len(pods.Items) && podsWith > 0,
			"All 3 instance Pods now carry the inherited label", fmt.Sprintf("%d of %d", podsWith, len(pods.Items))))
		checks = append(checks, boolCheck(pvcsWith == len(pvcLabels.Items) && pvcsWith > 0,
			"So do their PersistentVolumeClaims", fmt.Sprintf("%d of %d", pvcsWith, len(pvcLabels.Items))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-operator-configmap", taskID)
}

func checkOperatorPodDeletion(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	operatorReplicas := func() (int, error) {
		var deploy struct {
			Spec struct {
				Replicas *int `json:"replicas"`
			} `json:"spec"`
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		}
		if err := kubectlJSON(ctx, k3d, server, &deploy, "-n", cnpgNamespace, "get", "deploy", cnpgOperatorDeploy); err != nil {
			return 0, err
		}
		return deploy.Status.ReadyReplicas, nil
	}

	switch taskID {
	case "delete-the-operator":
		ready, err := operatorReplicas()
		if err != nil {
			return CheckResult{}, err
		}
		var opPods podList
		_ = kubectlJSON(ctx, k3d, server, &opPods, "-n", cnpgNamespace, "get", "pods", "-l", "app.kubernetes.io/name=cloudnative-pg")
		var leases struct {
			Items []struct {
				Spec struct {
					HolderIdentity string `json:"holderIdentity"`
				} `json:"spec"`
			} `json:"items"`
		}
		_ = kubectlJSON(ctx, k3d, server, &leases, "-n", cnpgNamespace, "get", "lease")
		holderMatches := false
		for _, l := range leases.Items {
			for _, p := range opPods.Items {
				if strings.HasPrefix(l.Spec.HolderIdentity, p.Metadata.Name) {
					holderMatches = true
				}
			}
		}
		var pods podList
		_ = kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
		probe, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT 1;")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(ready == 1, "A replacement operator Pod is running", fmt.Sprintf("%d ready", ready)))
		checks = append(checks, boolCheck(holderMatches, "It holds the leader-election Lease",
			detailOr("no lease held by the current Pod", "lease holder matches the running Pod", !holderMatches)))
		checks = append(checks, boolCheck(probe.ok(), "The database is still serving", detailOr(firstLine(probe.stderr), "SELECT 1 succeeded", !probe.ok())))
		checks = append(checks, boolCheck(pods.readyCount() == 3, "All 3 instances are still ready", fmt.Sprintf("%d/3 ready", pods.readyCount())))
		return finish(checks), nil

	case "scale-to-zero":
		ready, err := operatorReplicas()
		if err != nil {
			return CheckResult{}, err
		}
		var pods podList
		_ = kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
		var c cnpgCluster
		_ = kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster")

		var checks []CheckItem
		checks = append(checks, boolCheck(ready == 0, "The operator is scaled to zero", fmt.Sprintf("%d ready", ready)))
		checks = append(checks, boolCheck(len(pods.Items) == 2, "One instance Pod is gone and nothing has replaced it",
			fmt.Sprintf("%d instance Pod(s)", len(pods.Items))))
		// The status is stale on purpose: nothing is running to update it, which is the point.
		checks = append(checks, boolCheck(c.Status.ReadyInstances == 3,
			"The Cluster still claims 3 ready — no controller is left to notice", fmt.Sprintf("status says %d/3", c.Status.ReadyInstances)))
		return finish(checks), nil

	case "restore-the-operator":
		ready, err := operatorReplicas()
		if err != nil {
			return CheckResult{}, err
		}
		var pods podList
		_ = kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
		var c cnpgCluster
		_ = kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster")

		var checks []CheckItem
		checks = append(checks, boolCheck(ready == 1, "The operator is running again", fmt.Sprintf("%d ready", ready)))
		checks = append(checks, boolCheck(len(pods.Items) == 3 && pods.readyCount() == 3,
			"The missing instance was recreated", fmt.Sprintf("%d Pod(s), %d ready", len(pods.Items), pods.readyCount())))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster is healthy with 3 of 3 ready", fmt.Sprintf("%s, %d/3", c.Status.Phase, c.Status.ReadyInstances)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-operator-pod-deletion", taskID)
}

/* ---- Labs 26–28: metrics and logs ---- */

// scrapeMetrics fetches a Prometheus endpoint from a Pod, using the node's own wget: the
// k3s nodes route to Pod addresses, and neither the node nor the PostgreSQL image has curl.
func scrapeMetrics(ctx context.Context, docker *Docker, nodeID, podIP string, port int) (string, error) {
	res, err := docker.ExecRoot(ctx, nodeID, []string{
		"wget", "-qO-", fmt.Sprintf("http://%s:%d/metrics", podIP, port),
	}, nil)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("scraping %s:%d: exit %d: %s", podIP, port, res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return res.Stdout, nil
}

// metricSeries counts the exported series whose name starts with prefix.
func metricSeries(body, prefix string) int {
	n := 0
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, prefix) {
			n++
		}
	}
	return n
}

// metricValue reads the value of the first series whose line contains match.
func metricValue(body, match string) (float64, bool) {
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "#") || !strings.Contains(line, match) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		var v float64
		if _, err := fmt.Sscanf(fields[len(fields)-1], "%g", &v); err == nil {
			return v, true
		}
	}
	return 0, false
}

func checkMetrics(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	instanceMetrics := func() (string, error) {
		c, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return "", err
		}
		for _, p := range pods.Items {
			if p.Metadata.Name == c.Status.CurrentPrimary && p.Status.PodIP != "" {
				return scrapeMetrics(ctx, docker, server, p.Status.PodIP, 9187)
			}
		}
		return "", fmt.Errorf("no primary Pod address yet")
	}

	switch taskID {
	case "scrape-the-instance":
		var pods podList
		if err := kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster"); err != nil {
			return CheckResult{}, err
		}
		body, scrapeErr := instanceMetrics()
		series := metricSeries(body, "cnpg_")

		var checks []CheckItem
		checks = append(checks, boolCheck(scrapeErr == nil && series > 100,
			"The instance serves CloudNativePG metrics on port 9187",
			detailOr(errText(scrapeErr, "too few series"), fmt.Sprintf("%d cnpg_ series", series), scrapeErr != nil || series <= 100)))
		up, hasUp := metricValue(body, "cnpg_collector_up{")
		checks = append(checks, boolCheck(hasUp && up == 1, "cnpg_collector_up reports the exporter is healthy",
			fmt.Sprintf("cnpg_collector_up=%v", up)))

		file, found := readFileAnyNode(ctx, docker, a, "/root/metric-count.txt")
		if !found {
			checks = append(checks, noItem("/root/metric-count.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/metric-count.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(file))
		// A range, not an equality: the series count moves as connections come and go.
		checks = append(checks, boolCheck(n > 100 && n <= series+100,
			"It records how many cnpg_ series you counted", fmt.Sprintf("file says %q, the endpoint now serves %d", firstLine(file), series)))
		return finish(checks), nil

	case "read-real-values":
		body, err := instanceMetrics()
		if err != nil {
			return CheckResult{}, err
		}
		replicaBackends := 0
		for _, line := range strings.Split(body, "\n") {
			if strings.HasPrefix(line, "cnpg_backends_total{") && strings.Contains(line, `usename="streaming_replica"`) {
				replicaBackends++
			}
		}
		slots := metricSeries(body, "cnpg_pg_replication_slots_active{")

		var checks []CheckItem
		checks = append(checks, boolCheck(replicaBackends == 2,
			"cnpg_backends_total shows both replicas connected as streaming_replica",
			fmt.Sprintf("%d such series", replicaBackends)))
		checks = append(checks, boolCheck(slots == 2,
			"cnpg_pg_replication_slots_active shows a slot per replica", fmt.Sprintf("%d slot series", slots)))

		file, found := readFileAnyNode(ctx, docker, a, "/root/replica-backends.txt")
		if !found {
			checks = append(checks, noItem("/root/replica-backends.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/replica-backends.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(file))
		checks = append(checks, boolCheck(n == 2, "It records the number 2", fmt.Sprintf("file says %q", strings.TrimSpace(file))))
		return finish(checks), nil

	case "custom-query":
		var cm struct {
			Data map[string]string `json:"data"`
		}
		cmErr := kubectlJSON(ctx, k3d, server, &cm, "get", "cm", "lab-queries")
		var c struct {
			Spec struct {
				Monitoring struct {
					CustomQueriesConfigMap []struct {
						Name string `json:"name"`
						Key  string `json:"key"`
					} `json:"customQueriesConfigMap"`
				} `json:"monitoring"`
			} `json:"spec"`
		}
		_ = kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster")
		referenced := false
		for _, q := range c.Spec.Monitoring.CustomQueriesConfigMap {
			if q.Name == "lab-queries" {
				referenced = true
			}
		}
		body, _ := instanceMetrics()
		value, exposed := metricValue(body, "cnpg_lab_rows_total")

		// What the metric claims, checked against the database it claims it about.
		cl, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		actual, err := psqlSuper(ctx, docker, server, cl.Status.CurrentPrimary, "app", "SELECT count(*) FROM pg_stat_user_tables;")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(cmErr == nil && strings.Contains(cm.Data["queries"], "lab_rows"),
			"ConfigMap lab-queries defines a lab_rows query",
			detailOr(errText(cmErr, "no lab_rows query in it"), "found", cmErr != nil || !strings.Contains(cm.Data["queries"], "lab_rows"))))
		checks = append(checks, boolCheck(referenced, "The Cluster references it under spec.monitoring",
			detailOr("not referenced", "customQueriesConfigMap names lab-queries", !referenced)))
		checks = append(checks, boolCheck(exposed, "The metric cnpg_lab_rows_total is exposed",
			detailOr("not present in the scrape", fmt.Sprintf("value %v", value), !exposed)))
		checks = append(checks, boolCheck(exposed && int(value) == actual.count() && actual.count() > 0,
			"Its value matches the number of user tables in the database",
			fmt.Sprintf("metric says %v, the database has %d", value, actual.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-metrics", taskID)
}

func checkPgBouncerMetrics(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	poolerMetrics := func() (string, error) {
		var pods podList
		if err := kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/poolerName="+poolerName); err != nil {
			return "", err
		}
		for _, p := range pods.Items {
			if p.Status.PodIP != "" {
				return scrapeMetrics(ctx, docker, server, p.Status.PodIP, 9127)
			}
		}
		return "", fmt.Errorf("no PgBouncer Pod address yet")
	}

	switch taskID {
	case "apply-the-pooler":
		var p poolerResource
		poolerErr := kubectlJSON(ctx, k3d, server, &p, "get", "pooler.postgresql.cnpg.io", poolerName)
		var deploy struct {
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		}
		_ = kubectlJSON(ctx, k3d, server, &deploy, "get", "deploy", poolerName)
		body, scrapeErr := poolerMetrics()
		series := metricSeries(body, "cnpg_pgbouncer_")

		var checks []CheckItem
		checks = append(checks, boolCheck(poolerErr == nil, "pooler.postgresql.cnpg.io/"+poolerName+" exists",
			detailOr("not applied yet", "type "+p.Spec.Type, poolerErr != nil)))
		checks = append(checks, boolCheck(deploy.Status.ReadyReplicas == 2, "Its PgBouncer Deployment reports 2 ready replicas",
			fmt.Sprintf("%d ready", deploy.Status.ReadyReplicas)))
		checks = append(checks, boolCheck(scrapeErr == nil && series > 20,
			"Each PgBouncer Pod serves metrics on port 9127",
			detailOr(errText(scrapeErr, "too few series"), fmt.Sprintf("%d cnpg_pgbouncer_ series", series), scrapeErr != nil || series <= 20)))
		return finish(checks), nil

	case "scrape-the-pooler":
		body, err := poolerMetrics()
		if err != nil {
			return CheckResult{}, err
		}
		series := metricSeries(body, "cnpg_pgbouncer_")
		lastErr, hasErr := metricValue(body, "cnpg_pgbouncer_last_collection_error")

		var checks []CheckItem
		checks = append(checks, boolCheck(hasErr && lastErr == 0,
			"cnpg_pgbouncer_last_collection_error is 0 — the exporter is talking to PgBouncer",
			fmt.Sprintf("value %v", lastErr)))

		file, found := readFileAnyNode(ctx, docker, a, "/root/pgbouncer-metric-count.txt")
		if !found {
			checks = append(checks, noItem("/root/pgbouncer-metric-count.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/pgbouncer-metric-count.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(file))
		checks = append(checks, boolCheck(n > 20 && n <= series+40,
			"It records how many cnpg_pgbouncer_ series you counted",
			fmt.Sprintf("file says %q, the endpoint now serves %d", firstLine(file), series)))
		return finish(checks), nil

	case "correlate-with-traffic":
		body, err := poolerMetrics()
		if err != nil {
			return CheckResult{}, err
		}
		appPool := false
		for _, line := range strings.Split(body, "\n") {
			if strings.HasPrefix(line, "cnpg_pgbouncer_pools_") && strings.Contains(line, `database="app"`) {
				appPool = true
			}
		}
		databases, hasDBs := metricValue(body, "cnpg_pgbouncer_lists_databases")
		row, err := psqlSuper(ctx, docker, server, "pg-cluster-1", "app", "SELECT count(*) FROM pool_metrics_proof WHERE note='via-pooler';")
		if err != nil {
			return CheckResult{}, err
		}

		var checks []CheckItem
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'via-pooler' reached the database through PgBouncer",
			fmt.Sprintf("%d row(s)", row.count())))
		checks = append(checks, boolCheck(appPool,
			"A cnpg_pgbouncer_pools_ series now exists for the app database",
			detailOr("only the pgbouncer admin pool is reported", "app pool present", !appPool)))
		checks = append(checks, boolCheck(hasDBs && databases >= 2,
			"cnpg_pgbouncer_lists_databases counts the pooled databases", fmt.Sprintf("value %v", databases)))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-pgbouncer-metrics", taskID)
}

func checkJSONLogs(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	podLog := func(namespace, pod string, tail int) string {
		args := []string{"kubectl"}
		if namespace != "" {
			args = append(args, "-n", namespace)
		}
		args = append(args, "logs", pod, fmt.Sprintf("--tail=%d", tail))
		res, err := runSQL(ctx, docker, server, args)
		if err != nil {
			return ""
		}
		return res.stdout + res.stderr
	}

	switch taskID {
	case "read-the-structure":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		instance := podLog("", c.Status.CurrentPrimary, 300)
		structured := strings.Contains(instance, `"level":`) && strings.Contains(instance, `"logging_pod":`) &&
			strings.Contains(instance, `"logger":`)

		operatorPod := ""
		for _, p := range operatorPods(ctx, k3d, server).Items {
			operatorPod = p.Metadata.Name
		}
		operatorJSON := operatorPod != "" && strings.Contains(podLog(cnpgNamespace, operatorPod, 100), `"level":`)

		var checks []CheckItem
		checks = append(checks, boolCheck(structured,
			"Every instance log line is a JSON object with level, logger and logging_pod",
			detailOr("the log does not look like CloudNativePG JSON", "level, logger and logging_pod all present", !structured)))
		checks = append(checks, boolCheck(operatorJSON, "The operator's own log is JSON in the same shape",
			detailOr("no JSON found in the operator log", "found", !operatorJSON)))

		file, found := readFileAnyNode(ctx, docker, a, "/root/loggers.txt")
		if !found {
			checks = append(checks, noItem("/root/loggers.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/loggers.txt was written", "found"))
		// The loggers that any healthy instance emits within a few hundred lines.
		want := []string{"postgres", "instance-manager"}
		missing := []string{}
		for _, w := range want {
			if !strings.Contains(file, w) {
				missing = append(missing, w)
			}
		}
		checks = append(checks, boolCheck(len(missing) == 0,
			"It lists the distinct logger values, including postgres and instance-manager",
			detailOr("missing: "+strings.Join(missing, ", "), firstLine(file), len(missing) > 0)))
		return finish(checks), nil

	case "find-an-error":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		log := podLog("", c.Status.CurrentPrimary, 500)
		// PostgreSQL's CSV log fields arrive as a nested object, so the SQLSTATE of a failed
		// statement is a field rather than something to parse out of a message.
		logged := strings.Contains(log, `"sql_state_code":"22012"`) && strings.Contains(log, `"error_severity":"ERROR"`)

		var checks []CheckItem
		checks = append(checks, boolCheck(logged,
			"The instance log carries the failed statement as structured JSON, with its SQLSTATE",
			detailOr("no ERROR with sql_state_code 22012 in the last 500 lines", "found sql_state_code 22012", !logged)))

		file, found := readFileAnyNode(ctx, docker, a, "/root/sqlstate.txt")
		if !found {
			checks = append(checks, noItem("/root/sqlstate.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/sqlstate.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(file, "22012"),
			"It records the SQLSTATE the log reported", fmt.Sprintf("file says %q", firstLine(file))))
		return finish(checks), nil

	case "aggregate-across-pods":
		body, found := readFileAnyNode(ctx, docker, a, "/root/all-pods.txt")
		var checks []CheckItem
		if !found {
			checks = append(checks, noItem("/root/all-pods.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/all-pods.txt was written", "found"))

		_, pods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		present := 0
		for _, p := range pods.Items {
			if strings.Contains(body, `"logging_pod":"`+p.Metadata.Name+`"`) {
				present++
			}
		}
		checks = append(checks, boolCheck(present == len(pods.Items) && present > 0,
			"It carries log lines from all 3 instances, in one stream",
			fmt.Sprintf("%d of %d instance(s) appear", present, len(pods.Items))))
		checks = append(checks, boolCheck(strings.Contains(body, `"logger":`),
			"The aggregated lines are still the same JSON records",
			detailOr("no logger field found", "logger fields present", !strings.Contains(body, `"logger":`))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-json-logs", taskID)
}

/* ---- Labs 23–25: evicting, upgrading and scaling the operator ---- */

// operatorReady is how many operator replicas are actually serving.
func operatorReady(ctx context.Context, k3d *K3D, server string) (int, int) {
	var deploy struct {
		Spec struct {
			Replicas *int `json:"replicas"`
		} `json:"spec"`
		Status struct {
			ReadyReplicas int `json:"readyReplicas"`
		} `json:"status"`
	}
	if err := kubectlJSON(ctx, k3d, server, &deploy, "-n", cnpgNamespace, "get", "deploy", cnpgOperatorDeploy); err != nil {
		return 0, 0
	}
	want := 0
	if deploy.Spec.Replicas != nil {
		want = *deploy.Spec.Replicas
	}
	return deploy.Status.ReadyReplicas, want
}

// operatorPods lists the operator's own Pods.
func operatorPods(ctx context.Context, k3d *K3D, server string) podList {
	var pods podList
	_ = kubectlJSON(ctx, k3d, server, &pods, "-n", cnpgNamespace, "get", "pods", "-l", "app.kubernetes.io/name=cloudnative-pg")
	return pods
}

// leaseHolder returns the Pod name currently holding the operator's leader-election Lease.
// The holder identity is "<pod>_<uuid>", so the Pod name is everything before the first _.
func leaseHolder(ctx context.Context, k3d *K3D, server string) string {
	var leases struct {
		Items []struct {
			Spec struct {
				HolderIdentity string `json:"holderIdentity"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := kubectlJSON(ctx, k3d, server, &leases, "-n", cnpgNamespace, "get", "lease"); err != nil {
		return ""
	}
	pods := operatorPods(ctx, k3d, server)
	for _, l := range leases.Items {
		holder := l.Spec.HolderIdentity
		if i := strings.Index(holder, "_"); i > 0 {
			holder = holder[:i]
		}
		for _, p := range pods.Items {
			if p.Metadata.Name == holder {
				return holder
			}
		}
	}
	return ""
}

func checkOperatorEviction(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	const pdbName = "cnpg-operator-pdb"
	pdbAllowed := func() (int, bool) {
		var pdb struct {
			Spec struct {
				MinAvailable any `json:"minAvailable"`
			} `json:"spec"`
			Status struct {
				DisruptionsAllowed int `json:"disruptionsAllowed"`
			} `json:"status"`
		}
		if err := kubectlJSON(ctx, k3d, server, &pdb, "-n", cnpgNamespace, "get", "pdb", pdbName); err != nil {
			return 0, false
		}
		return pdb.Status.DisruptionsAllowed, true
	}

	switch taskID {
	case "evict-the-operator":
		ready, _ := operatorReady(ctx, k3d, server)
		probe, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT 1;")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem

		body, found := readFileAnyNode(ctx, docker, a, "/root/eviction-result.txt")
		if !found {
			checks = append(checks, noItem("/root/eviction-result.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/eviction-result.txt was written", "found"))
		accepted := strings.Contains(body, `"status":"Success"`) || strings.Contains(body, "201")
		checks = append(checks, boolCheck(accepted, "It shows the API server accepting the eviction",
			fmt.Sprintf("file says %q", firstLine(body))))
		checks = append(checks, boolCheck(ready == 1, "A replacement operator Pod is running", fmt.Sprintf("%d ready", ready)))
		checks = append(checks, boolCheck(probe.ok(), "The database was untouched — it is still serving",
			detailOr(firstLine(probe.stderr), "SELECT 1 succeeded", !probe.ok())))
		return finish(checks), nil

	case "block-it-with-a-pdb":
		allowed, exists := pdbAllowed()
		var checks []CheckItem
		checks = append(checks, boolCheck(exists, "A PodDisruptionBudget named "+pdbName+" exists",
			detailOr("not created yet", "found", !exists)))
		checks = append(checks, boolCheck(exists && allowed == 0,
			"It reports 0 allowed disruptions — the single operator replica cannot be spared",
			fmt.Sprintf("disruptionsAllowed=%d", allowed)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/eviction-refused.txt")
		if !found {
			checks = append(checks, noItem("/root/eviction-refused.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/eviction-refused.txt was written", "found"))
		refused := strings.Contains(body, "disruption budget") || strings.Contains(body, "TooManyRequests")
		checks = append(checks, boolCheck(refused, "It captured the API server refusing the eviction",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "make-it-evictable":
		ready, want := operatorReady(ctx, k3d, server)
		allowed, exists := pdbAllowed()
		probe, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT 1;")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(want >= 2 && ready >= 2, "The operator now runs more than one replica",
			fmt.Sprintf("%d/%d ready", ready, want)))
		checks = append(checks, boolCheck(exists && allowed >= 1,
			"The PodDisruptionBudget now allows a disruption", fmt.Sprintf("disruptionsAllowed=%d", allowed)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/eviction-allowed.txt")
		if !found {
			checks = append(checks, noItem("/root/eviction-allowed.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/eviction-allowed.txt was written", "found"))
		accepted := strings.Contains(body, `"status":"Success"`) || strings.Contains(body, "201")
		checks = append(checks, boolCheck(accepted && probe.ok(),
			"An eviction succeeded with the budget still in place, and the database never noticed",
			fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-operator-eviction", taskID)
}

func checkOperatorUpgrade(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	operatorImage := func() string {
		res, err := k3d.Kubectl(ctx, server, "-n", cnpgNamespace, "get", "deploy", cnpgOperatorDeploy,
			"-o", "jsonpath={.spec.template.spec.containers[0].image}")
		if err != nil || res.ExitCode != 0 {
			return ""
		}
		return strings.TrimSpace(res.Stdout)
	}
	crdCount := func() int {
		var crds struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
			} `json:"items"`
		}
		if err := kubectlJSON(ctx, k3d, server, &crds, "get", "crd"); err != nil {
			return 0
		}
		n := 0
		for _, c := range crds.Items {
			if strings.HasSuffix(c.Metadata.Name, ".postgresql.cnpg.io") {
				n++
			}
		}
		return n
	}

	switch taskID {
	case "survey-the-old-operator":
		image := operatorImage()
		crds := crdCount()
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		row, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM upgrade_proof WHERE note='before-upgrade';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(strings.HasSuffix(image, ":"+cnpgPreviousVersion),
			"The operator Deployment is running "+cnpgPreviousVersion, image))
		checks = append(checks, boolCheck(crds == 10, "10 CNPG CRDs are registered", fmt.Sprintf("%d found", crds)))
		checks = append(checks, boolCheck(row.count() >= 1, "A row noted 'before-upgrade' exists", fmt.Sprintf("%d row(s)", row.count())))

		body, found := readFileAnyNode(ctx, docker, a, "/root/before-version.txt")
		if !found {
			checks = append(checks, noItem("/root/before-version.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/before-version.txt was written", "found"))
		checks = append(checks, boolCheck(strings.Contains(body, cnpgPreviousVersion),
			"It records the version you started on", fmt.Sprintf("file says %q", firstLine(body))))
		return finish(checks), nil

	case "upgrade":
		image := operatorImage()
		crds := crdCount()
		ready, _ := operatorReady(ctx, k3d, server)
		var checks []CheckItem
		checks = append(checks, boolCheck(strings.HasSuffix(image, ":"+cnpgVersion),
			"The operator Deployment is now running "+cnpgVersion, image))
		checks = append(checks, boolCheck(crds == 11,
			"11 CNPG CRDs are registered — the upgrade added one", fmt.Sprintf("%d found", crds)))
		checks = append(checks, boolCheck(ready == 1, "The upgraded operator Pod is Running", fmt.Sprintf("%d ready", ready)))
		return finish(checks), nil

	case "verify-no-disruption":
		c, _, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		restarts := 0
		var restartView struct {
			Items []struct {
				Status struct {
					ContainerStatuses []struct {
						RestartCount int `json:"restartCount"`
					} `json:"containerStatuses"`
				} `json:"status"`
			} `json:"items"`
		}
		_ = kubectlJSON(ctx, k3d, server, &restartView, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
		for _, p := range restartView.Items {
			for _, cs := range p.Status.ContainerStatuses {
				restarts += cs.RestartCount
			}
		}
		before, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM upgrade_proof WHERE note='before-upgrade';")
		if err != nil {
			return CheckResult{}, err
		}
		after, err := psqlSuper(ctx, docker, server, c.Status.CurrentPrimary, "app", "SELECT count(*) FROM upgrade_proof WHERE note='after-upgrade';")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state" && c.Status.ReadyInstances == 3,
			"The cluster is healthy with 3 of 3 ready", fmt.Sprintf("%s, %d/3", c.Status.Phase, c.Status.ReadyInstances)))
		checks = append(checks, boolCheck(restarts == 0,
			"No instance container was restarted by the upgrade", fmt.Sprintf("%d restart(s) across the instances", restarts)))
		checks = append(checks, boolCheck(before.count() >= 1, "The 'before-upgrade' row is intact", fmt.Sprintf("%d row(s)", before.count())))
		checks = append(checks, boolCheck(after.count() >= 1, "A row written after the upgrade succeeded", fmt.Sprintf("%d row(s)", after.count())))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-operator-upgrade", taskID)
}

func checkOperatorHA(ctx context.Context, k3d *K3D, docker *Docker, a *Attempt, server, taskID string) (CheckResult, error) {
	switch taskID {
	case "scale-up":
		ready, want := operatorReady(ctx, k3d, server)
		holder := leaseHolder(ctx, k3d, server)
		pods := operatorPods(ctx, k3d, server)
		nodes := map[string]bool{}
		for _, p := range pods.Items {
			nodes[p.Spec.NodeName] = true
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(want == 3 && ready == 3, "The operator Deployment reports 3 ready replicas",
			fmt.Sprintf("%d/%d ready", ready, want)))
		checks = append(checks, boolCheck(holder != "", "Exactly one Pod holds the leader-election Lease",
			detailOr("no Pod holds it", "held by "+holder, holder == "")))

		body, found := readFileAnyNode(ctx, docker, a, "/root/leader.txt")
		if !found {
			checks = append(checks, noItem("/root/leader.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/leader.txt was written", "found"))
		checks = append(checks, boolCheck(holder != "" && strings.Contains(body, holder),
			"It names the Pod holding the Lease", fmt.Sprintf("file says %q, the holder is %q", firstLine(body), holder)))
		return finish(checks), nil

	case "kill-the-leader":
		holder := leaseHolder(ctx, k3d, server)
		recorded, _ := readFileAnyNode(ctx, docker, a, "/root/leader.txt")
		probe, err := psqlFromClient(ctx, docker, server, "pg-cluster-rw", "SELECT 1;")
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(holder != "" && !strings.Contains(recorded, holder),
			"The Lease is held by a different Pod than the one you recorded",
			fmt.Sprintf("was %q, is now %q", firstLine(recorded), holder)))

		body, found := readFileAnyNode(ctx, docker, a, "/root/takeover-seconds.txt")
		if !found {
			checks = append(checks, noItem("/root/takeover-seconds.txt was written", "file not found on any node"))
			return finish(checks), nil
		}
		checks = append(checks, okItem("/root/takeover-seconds.txt was written", "found"))
		n, _ := strconv.Atoi(firstNumber(body))
		checks = append(checks, boolCheck(firstNumber(body) != "" && n < 30,
			"It records a takeover in under 30 seconds", fmt.Sprintf("file says %q", strings.TrimSpace(body))))
		checks = append(checks, boolCheck(probe.ok(), "The database was unaffected throughout",
			detailOr(firstLine(probe.stderr), "SELECT 1 succeeded", !probe.ok())))
		return finish(checks), nil

	case "followers-are-idle":
		holder := leaseHolder(ctx, k3d, server)
		pods := operatorPods(ctx, k3d, server)
		follower := ""
		for _, p := range pods.Items {
			if p.Metadata.Name != holder {
				follower = p.Metadata.Name
				break
			}
		}
		waiting := false
		if follower != "" {
			res, err := runSQL(ctx, docker, server, []string{"kubectl", "-n", cnpgNamespace, "logs", follower, "--tail=200"})
			if err == nil {
				logs := res.stdout + res.stderr
				waiting = strings.Contains(logs, "attempting to acquire leader lease") ||
					strings.Contains(logs, "Attempting to acquire leader lease")
			}
		}
		c, instancePods, err := readCluster(ctx, k3d, server)
		if err != nil {
			return CheckResult{}, err
		}
		var checks []CheckItem
		checks = append(checks, boolCheck(waiting, "A non-leader Pod's log shows it waiting to acquire the Lease",
			detailOr("no leader-lease wait in "+detailOr("any follower", follower, follower == "")+"'s last 200 lines", follower+" is waiting", !waiting)))
		checks = append(checks, boolCheck(len(instancePods.Items) == 3 && instancePods.readyCount() == 3,
			"Reconciliation still works — the cluster has all 3 instances", fmt.Sprintf("%d ready", instancePods.readyCount())))
		checks = append(checks, boolCheck(c.Status.Phase == "Cluster in healthy state",
			"The cluster is healthy", c.Status.Phase))
		return finish(checks), nil
	}
	return CheckResult{}, fmt.Errorf("unknown task %q for cnpg-operator-ha", taskID)
}

// serviceEndpointIPsIn is serviceEndpointIPs for a Service outside the default namespace.
func serviceEndpointIPsIn(ctx context.Context, k3d *K3D, nodeID, namespace, service string) ([]string, error) {
	var esl endpointSliceList
	if err := kubectlJSON(ctx, k3d, nodeID, &esl, "-n", namespace, "get", "endpointslices", "-l", "kubernetes.io/service-name="+service); err != nil {
		return nil, err
	}
	var ips []string
	for _, item := range esl.Items {
		for _, e := range item.Endpoints {
			if e.Conditions.Ready != nil && !*e.Conditions.Ready {
				continue
			}
			ips = append(ips, e.Addresses...)
		}
	}
	sort.Strings(ips)
	return ips, nil
}

// nodeWithFile returns the lab-facing id of the node that has path, or "".
func nodeWithFile(ctx context.Context, docker *Docker, a *Attempt, path string) string {
	if strings.TrimSpace(path) == "" || strings.Contains(path, " ") {
		return ""
	}
	for _, labID := range nodeLabIDs {
		id := a.nodeIDByLabID(labID)
		if id == "" {
			continue
		}
		res, err := docker.ExecRoot(ctx, id, []string{"test", "-f", path}, nil)
		if err == nil && res.ExitCode == 0 {
			return labID
		}
	}
	return ""
}

/* ------------------------------------------------------------------ small helpers */

func boolCheck(cond bool, label, detail string) CheckItem {
	if cond {
		return okItem(label, detail)
	}
	return noItem(label, detail)
}

// detailOr picks between a failure detail and a success detail, so a check's Detail says
// what went wrong when it fails and what was found when it passes.
func detailOr(bad, good string, failed bool) string {
	if failed {
		return bad
	}
	return good
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// splitPipe reads psql's terse two-column output ("a|b").
func splitPipe(s string) (string, string) {
	parts := strings.SplitN(strings.TrimSpace(s), "|", 2)
	if len(parts) != 2 {
		return strings.TrimSpace(s), ""
	}
	return parts[0], parts[1]
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func podNames(p podList) []string {
	out := make([]string, 0, len(p.Items))
	for _, it := range p.Items {
		out = append(out, it.Metadata.Name)
	}
	return out
}

func podPhase(p podList, name string) string {
	for _, it := range p.Items {
		if it.Metadata.Name == name {
			return it.Status.Phase
		}
	}
	return "absent"
}

// errText renders an error for a check Detail, falling back to a plain reason when the
// failure was a wrong value rather than a failed read.
func errText(err error, fallback string) string {
	if err != nil {
		return err.Error()
	}
	return fallback
}

func dnsDetail(c *x509.Certificate) string {
	if c == nil {
		return "no certificate"
	}
	if len(c.DNSNames) == 0 {
		return "no subject alternative names"
	}
	return strings.Join(c.DNSNames, ", ")
}

func certSubject(c *x509.Certificate) string {
	if c == nil {
		return "no certificate"
	}
	return c.Subject.String()
}

func certIssuer(c *x509.Certificate) string {
	if c == nil {
		return "no certificate"
	}
	return c.Issuer.String()
}

func podPhaseDetail(p podList) string {
	if len(p.Items) == 0 {
		return "no pod scheduled yet"
	}
	return p.Items[0].Status.Phase
}

func firstNumber(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else if b.Len() > 0 {
			break
		}
	}
	return b.String()
}

// readFileAnyNode checks a fixed path across every terminal the learner could have been
// typing in — all 3 nodes, and the toolbox when one is running. The frontend's terminal
// lets them pick any tab, so grading has to look in all of them; a learner who does the
// work in the toolbox and writes /root/answer.txt there must be graded on it exactly as if
// they had written it on a node.
func readFileAnyNode(ctx context.Context, docker *Docker, a *Attempt, path string) (string, bool) {
	for _, labID := range append(append([]string(nil), nodeLabIDs...), toolboxLabID) {
		id := a.nodeIDByLabID(labID)
		if id == "" {
			continue
		}
		if body, ok := catFile(ctx, docker, id, path); ok {
			return body, true
		}
	}
	return "", false
}

func (a *Attempt) baselinePrimary() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.baseline == nil {
		return ""
	}
	return a.baseline.Primary
}

func (a *Attempt) baselineVolume() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.baseline == nil {
		return ""
	}
	return a.baseline.Volume
}

func (a *Attempt) baselineNode() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.baseline == nil {
		return ""
	}
	return a.baseline.Node
}
