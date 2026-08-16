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
