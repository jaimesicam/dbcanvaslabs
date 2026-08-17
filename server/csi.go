package main

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// csi.go — a snapshot-capable CSI driver for the volume-snapshot lab.
//
// k3s ships only `local-path`, which cannot snapshot, so that lab needs a real CSI driver
// with snapshot support. On this platform the choice is narrower than it looks: the Docker
// VM exposes no loadable kernel modules, so anything needing `rbd` (Ceph), `iscsi_tcp`
// (Longhorn) or `device-mapper`/`zfs` (OpenEBS) cannot mount its volumes at all. What is
// left is the driver that needs no kernel support because it is bind mounts underneath —
// csi-driver-host-path, which is also what the Kubernetes project itself tests snapshots
// against.
//
// Two things about deploying it are load-bearing:
//
//   - Its RBAC is not in its own repo. The upstream deploy script pulls a ClusterRole from
//     each of five sidecar repositories, at versions it derives by parsing image tags out of
//     the YAML. Fetching five repos at provision time would make this lab break whenever any
//     of them moved, so those ClusterRoles are vendored below, pinned to the versions of the
//     sidecar images csi-driver-host-path v1.17.0 actually runs. They are small and they are
//     the only part of the install that is version-coupled across repositories.
//
//   - The plugin is a single-replica StatefulSet, so it registers as a CSI node on exactly
//     one node. Volumes can only be provisioned there, so both the driver and the lab's
//     Cluster are pinned to the server node; otherwise the PVC sits Pending forever with
//     `ExternalProvisioning`, which reads like a broken driver rather than a scheduling
//     mismatch.
const (
	hostpathVersion    = "1.17.0"
	hostpathTarballFmt = "https://github.com/kubernetes-csi/csi-driver-host-path/archive/refs/tags/v%s.tar.gz"
	// The manifest directory inside that release. Named for the Kubernetes version it was
	// written against, not the one it runs on — 1.30 is the newest this release ships and it
	// applies cleanly to the k3s version pinned here.
	hostpathManifestDir = "deploy/kubernetes-1.30/hostpath"

	snapshotterVersion = "v8.2.0"
	snapshotCRDFmt     = "https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/" + snapshotterVersion + "/client/config/crd/snapshot.storage.k8s.io_%s.yaml"
	snapshotRBACURL    = "https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/" + snapshotterVersion + "/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml"
	snapshotSetupURL   = "https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/" + snapshotterVersion + "/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml"

	snapshotStorageClass = "csi-hostpath-sc"
	snapshotClassName    = "csi-hostpath-snapclass"
	restoredClusterName  = "pg-cluster-restored"

	// The hot/cold snapshot lab's own objects.
	hotBackupName           = "hot-backup"
	coldBackupName          = "cold-backup"
	coldRestoredClusterName = "pg-restored"

	// The tablespace-snapshot lab's own objects. Neither name contains "-tbs-", and that is
	// load-bearing rather than cosmetic: a tablespace's claim is named <instance>-tbs-<tablespace>,
	// and a *cluster* called pg-tbs-restored made the operator read its own data claim as a
	// tablespace's. The restored cluster then rolled its instance forever — "original and target
	// PodSpec differ in volumes: element tbs-pgdata has been removed" — with the data correctly
	// restored and the cluster never becoming ready. Measured twice, and fixed by the name alone.
	tbsBackupName          = "daily-snapshot"
	tbsRestoredClusterName = "pg-restored"
	tbsHalfClusterName     = "pg-half"
)

// csiSnapshotImages is everything the snapshot stack pulls, pre-seeded into the nodes for
// the same reason the Postgres image is.
var csiSnapshotImages = []string{
	"registry.k8s.io/sig-storage/hostpathplugin:v1.16.1",
	"registry.k8s.io/sig-storage/csi-external-health-monitor-controller:v0.14.0",
	"registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.13.0",
	"registry.k8s.io/sig-storage/livenessprobe:v2.15.0",
	"registry.k8s.io/sig-storage/csi-attacher:v4.8.0",
	"registry.k8s.io/sig-storage/csi-provisioner:v5.2.0",
	"registry.k8s.io/sig-storage/csi-resizer:v1.13.1",
	"registry.k8s.io/sig-storage/csi-snapshotter:v8.2.0",
	"registry.k8s.io/sig-storage/snapshot-controller:" + snapshotterVersion,
}

// csiSidecarClusterRoles are the five ClusterRoles the hostpath plugin's RoleBindings refer
// to, copied verbatim from each sidecar's own deploy/kubernetes/rbac.yaml at the version of
// the sidecar image csi-driver-host-path v1.17.0 runs:
//
//	external-provisioner-runner                from external-provisioner       v5.2.0
//	external-attacher-runner                   from external-attacher          v4.8.0
//	external-snapshotter-runner                from external-snapshotter       v8.2.0
//	external-resizer-runner                    from external-resizer           v1.13.1
//	external-health-monitor-controller-runner  from external-health-monitor    v0.14.0
//
// The plugin also binds to external-snapshot-metadata-runner, which is not vendored: that
// sidecar is added by a separate patch this install does not apply, and a RoleBinding to a
// ClusterRole that does not exist simply grants nothing.
//
// Upgrading csi-driver-host-path means re-copying these at the sidecar versions the new
// release's plugin manifest names.
//
// The block below is third-party code, redistributed under its own licence rather than this
// project's. This app is GPL-3.0-or-later; Apache-2.0 is one-way compatible with that, so
// the combined work is GPL while these lines remain Apache-2.0 and must keep this notice.
//
//	Copyright The Kubernetes Authors.
//	SPDX-License-Identifier: Apache-2.0
//
// Copied verbatim and unmodified from the kubernetes-csi repositories listed above. The
// full licence is at https://www.apache.org/licenses/LICENSE-2.0.
const csiSidecarClusterRoles = `kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: external-provisioner-runner
rules:
  - apiGroups: [""]
    resources: ["persistentvolumes"]
    verbs: ["get", "list", "watch", "create", "patch", "delete"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "update"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["list", "watch", "create", "update", "patch"]
  - apiGroups: ["snapshot.storage.k8s.io"]
    resources: ["volumesnapshots"]
    verbs: ["get", "list"]
  - apiGroups: ["snapshot.storage.k8s.io"]
    resources: ["volumesnapshotcontents"]
    verbs: ["get", "list"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["csinodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["volumeattachments"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["volumeattachments/status"]
    verbs: ["patch"]
---
kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: external-attacher-runner
rules:
  - apiGroups: [""]
    resources: ["persistentvolumes"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["csinodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["volumeattachments"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["volumeattachments/status"]
    verbs: ["patch"]
---
kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: external-snapshotter-runner
rules:
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["list", "watch", "create", "update", "patch"]
  - apiGroups: ["snapshot.storage.k8s.io"]
    resources: ["volumesnapshotclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["snapshot.storage.k8s.io"]
    resources: ["volumesnapshotcontents"]
    verbs: ["create", "get", "list", "watch", "update", "delete", "patch"]
  - apiGroups: ["snapshot.storage.k8s.io"]
    resources: ["volumesnapshotcontents/status"]
    verbs: ["update", "patch"]
  - apiGroups: ["groupsnapshot.storage.k8s.io"]
    resources: ["volumegroupsnapshotclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["groupsnapshot.storage.k8s.io"]
    resources: ["volumegroupsnapshotcontents"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: ["groupsnapshot.storage.k8s.io"]
    resources: ["volumegroupsnapshotcontents/status"]
    verbs: ["update", "patch"]
---
kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: external-resizer-runner
rules:
  - apiGroups: [""]
    resources: ["persistentvolumes"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims/status"]
    verbs: ["patch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["list", "watch", "create", "update", "patch"]
---
kind: ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: external-health-monitor-controller-runner
rules:
  - apiGroups: [""]
    resources: ["persistentvolumes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
`

// snapshotStorageClass is deliberately not the cluster's default: every other lab keeps
// local-path, and this one names the class explicitly on the Cluster it creates.
const snapshotStorageClassYAML = `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ` + snapshotStorageClass + `
provisioner: hostpath.csi.k8s.io
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
`

// InstallSnapshotStack installs the VolumeSnapshot API, its controller, and a CSI driver
// that implements it, pinned to the server node.
//
// Must run BEFORE the CloudNativePG operator: the operator decides whether it supports
// volume-snapshot backups by looking for the VolumeSnapshot CRD *at startup*, and refuses
// the backup method outright if the CRD arrived later ("please restart it to enable
// VolumeSnapshot support").
func (c *CNPG) InstallSnapshotStack(ctx context.Context, serverID, serverNodeName string, logf func(string)) error {
	logf("fetching the VolumeSnapshot API (external-snapshotter " + snapshotterVersion + ")")
	var crds []byte
	for _, kind := range []string{"volumesnapshots", "volumesnapshotclasses", "volumesnapshotcontents"} {
		body, err := httpGet(ctx, fmt.Sprintf(snapshotCRDFmt, kind))
		if err != nil {
			return fmt.Errorf("fetch %s CRD: %w", kind, err)
		}
		crds = append(crds, body...)
		crds = append(crds, []byte("\n---\n")...)
	}
	controllerRBAC, err := httpGet(ctx, snapshotRBACURL)
	if err != nil {
		return fmt.Errorf("fetch snapshot-controller rbac: %w", err)
	}
	controllerSetup, err := httpGet(ctx, snapshotSetupURL)
	if err != nil {
		return fmt.Errorf("fetch snapshot-controller: %w", err)
	}
	controller := append(append(controllerRBAC, []byte("\n---\n")...), controllerSetup...)

	logf("fetching csi-driver-host-path v" + hostpathVersion)
	tarball, err := httpGet(ctx, fmt.Sprintf(hostpathTarballFmt, hostpathVersion))
	if err != nil {
		return fmt.Errorf("fetch csi-driver-host-path: %w", err)
	}
	files, err := untarGz(tarball)
	if err != nil {
		return fmt.Errorf("unpack csi-driver-host-path: %w", err)
	}
	var driver []byte
	for _, name := range []string{"csi-hostpath-driverinfo.yaml", "csi-hostpath-plugin.yaml", "csi-hostpath-snapshotclass.yaml"} {
		var body []byte
		for path, content := range files {
			if stripFirstDir(path) == hostpathManifestDir+"/"+name {
				body = content
				break
			}
		}
		if body == nil {
			return fmt.Errorf("%s not found in the csi-driver-host-path v%s tarball", name, hostpathVersion)
		}
		driver = append(driver, body...)
		driver = append(driver, []byte("\n---\n")...)
	}

	for name, body := range map[string][]byte{
		"snapshot-crds.yaml":       crds,
		"snapshot-controller.yaml": controller,
		"csi-clusterroles.yaml":    []byte(csiSidecarClusterRoles),
		"csi-hostpath.yaml":        driver,
		"csi-storageclass.yaml":    []byte(snapshotStorageClassYAML),
	} {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", name, body, 0644); err != nil {
			return err
		}
	}

	logf("applying the VolumeSnapshot CRDs and snapshot-controller")
	for _, f := range []string{"/root/snapshot-crds.yaml", "/root/snapshot-controller.yaml"} {
		res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", f)
		if err != nil {
			return err
		}
		if res.ExitCode != 0 {
			return fmt.Errorf("kubectl apply %s: exit %d: %s", f, res.ExitCode, res.Stderr)
		}
	}

	logf("applying the CSI hostpath driver and its vendored sidecar RBAC")
	for _, f := range []string{"/root/csi-clusterroles.yaml", "/root/csi-hostpath.yaml", "/root/csi-storageclass.yaml"} {
		res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", f)
		if err != nil {
			return err
		}
		if res.ExitCode != 0 {
			return fmt.Errorf("kubectl apply %s: exit %d: %s", f, res.ExitCode, res.Stderr)
		}
	}

	// Pin it, rather than letting the scheduler choose: the driver registers as a CSI node
	// only where it runs, and the lab's Cluster has to be pinned to the same node.
	logf("pinning the CSI driver to the server node")
	patch := fmt.Sprintf(`{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":%q}}}}}`, serverNodeName)
	res, err := c.k3d.Kubectl(ctx, serverID, "patch", "statefulset", "csi-hostpathplugin", "--type=merge", "-p", patch)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("pin csi driver: exit %d: %s", res.ExitCode, res.Stderr)
	}

	logf("waiting for the CSI driver to register")
	return c.k3d.waitPodReady(ctx, serverID, "csi-hostpathplugin-0", 5*time.Minute)
}

// snapshotClusterManifest is the lab's source cluster: a single instance, on the snapshot
// -capable StorageClass, pinned to the node the driver runs on, and told which
// VolumeSnapshotClass its backups should use.
//
// One instance rather than three because both the driver and every volume it provisions
// live on one node; a lab about backup and restore loses nothing by it.
func snapshotClusterManifest(name, nodeName string, restoreFrom string) string {
	bootstrap := ""
	if restoreFrom != "" {
		bootstrap = fmt.Sprintf(`  bootstrap:
    recovery:
      volumeSnapshots:
        storage:
          name: %s
          kind: VolumeSnapshot
          apiGroup: snapshot.storage.k8s.io
`, restoreFrom)
	} else {
		bootstrap = fmt.Sprintf(`  backup:
    volumeSnapshot:
      className: %s
      online: true
`, snapshotClassName)
	}
	return fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
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
%s`, name, cnpgPostgresImage, nodeName, snapshotStorageClass, bootstrap)
}

// snapshotClusterTablespacesManifest is the tablespace-snapshot lab's source cluster: one
// instance on the snapshot-capable class, with its tablespaces on that same class. The class
// matters — a tablespace on a driver that cannot snapshot would leave a backup with a hole in it,
// which is the failure this lab is arranged to avoid rather than to demonstrate.
func snapshotClusterTablespacesManifest(name, nodeName string, specs []tablespaceSpec) string {
	var tbs strings.Builder
	tbs.WriteString("  tablespaces:\n")
	for _, t := range specs {
		fmt.Fprintf(&tbs, "  - name: %s\n    storage:\n      size: %s\n      storageClass: %s\n",
			t.Name, t.Size, snapshotStorageClass)
	}
	return fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
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
%s  backup:
    volumeSnapshot:
      className: %s
      online: true
`, name, cnpgPostgresImage, nodeName, snapshotStorageClass, tbs.String(), snapshotClassName)
}

// ApplySnapshotClusterTablespaces creates that cluster and waits for it to be healthy with every
// tablespace reconciled.
func (c *CNPG) ApplySnapshotClusterTablespaces(ctx context.Context, serverID, name, nodeName string, specs []tablespaceSpec, logf func(string)) error {
	body := snapshotClusterTablespacesManifest(name, nodeName, specs)
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "cluster.yaml", []byte(body), 0644); err != nil {
		return err
	}
	logf("kubectl apply -f cluster.yaml (one instance and its tablespaces, all on " + snapshotStorageClass + ")")
	if res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/cluster.yaml"); err != nil {
		return err
	} else if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply cluster: exit %d: %s", res.ExitCode, res.Stderr)
	}

	logf("waiting for the cluster and its tablespaces")
	want := strings.Repeat("reconciled ", len(specs))
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		res, err := c.k3d.Kubectl(ctx, serverID, "get", "cluster.postgresql.cnpg.io", name,
			"-o", `jsonpath={.status.phase}|{range .status.tablespacesStatus[*]}{.state} {end}`)
		if err == nil && res.ExitCode == 0 &&
			strings.TrimSpace(res.Stdout) == strings.TrimSpace("Cluster in healthy state|"+want) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for %s and its tablespaces", name)
}

// StageTablespaceSnapshotManifests writes what the tablespace-snapshot lab applies: a
// volumeSnapshot Backup, and a recovery Cluster whose snapshot names are left as placeholders.
//
// The placeholders are the point. A snapshot backup of a cluster with tablespaces produces one
// VolumeSnapshot per volume, and recovery has to map every one of them back by hand under
// `volumeSnapshots.tablespaceStorage`, keyed by tablespace name. Handing the learner a finished
// file would hide exactly the step that goes wrong in real life.
func (c *CNPG) StageTablespaceSnapshotManifests(ctx context.Context, serverID, clusterName, nodeName string, specs []tablespaceSpec, logf func(string)) error {
	backup := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: %s
  namespace: default
spec:
  cluster:
    name: %s
  method: volumeSnapshot
  online: true
`, tbsBackupName, clusterName)

	var tbsDecl, tbsStorage strings.Builder
	tbsDecl.WriteString("  tablespaces:\n")
	tbsStorage.WriteString("        tablespaceStorage:\n")
	for _, t := range specs {
		fmt.Fprintf(&tbsDecl, "  - name: %s\n    storage:\n      size: %s\n      storageClass: %s\n",
			t.Name, t.Size, snapshotStorageClass)
		fmt.Fprintf(&tbsStorage, "          %s:\n            name: %s_SNAPSHOT\n            kind: VolumeSnapshot\n            apiGroup: snapshot.storage.k8s.io\n",
			t.Name, strings.ToUpper(t.Name))
	}

	restore := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
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
%s  bootstrap:
    recovery:
      volumeSnapshots:
        storage:
          name: DATA_SNAPSHOT
          kind: VolumeSnapshot
          apiGroup: snapshot.storage.k8s.io
%s`, tbsRestoredClusterName, cnpgPostgresImage, nodeName, snapshotStorageClass, tbsDecl.String(), tbsStorage.String())

	// The same recovery with the tablespace mapping left out entirely — the lab applies it on
	// purpose to see what the operator does when a tablespace has no snapshot behind it.
	half := strings.Replace(
		strings.Replace(restore, tbsRestoredClusterName, tbsHalfClusterName, 1),
		tbsStorage.String(), "", 1)

	files := map[string]string{
		"snapshot-backup.yaml":       backup,
		"restore.yaml.template":      restore,
		"restore-half.yaml.template": half,
	}
	logf("staging a volumeSnapshot Backup and two recovery templates, one of them missing the tablespace mapping")
	for name, body := range files {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", name, []byte(body), 0644); err != nil {
			return err
		}
	}
	return nil
}

// ApplySnapshotCluster creates the lab's source cluster and waits for it to be healthy.
func (c *CNPG) ApplySnapshotCluster(ctx context.Context, serverID, name, nodeName string, logf func(string)) error {
	body := snapshotClusterManifest(name, nodeName, "")
	if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", "cluster.yaml", []byte(body), 0644); err != nil {
		return err
	}
	logf("kubectl apply -f cluster.yaml (on " + snapshotStorageClass + ")")
	res, err := c.k3d.Kubectl(ctx, serverID, "apply", "-f", "/root/cluster.yaml")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply cluster: exit %d: %s", res.ExitCode, res.Stderr)
	}

	logf("waiting for the cluster to report healthy")
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

// StageSnapshotManifests writes the Backup request and the restore Cluster the lab applies.
func (c *CNPG) StageSnapshotManifests(ctx context.Context, serverID, clusterName, nodeName string) error {
	backup := fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: snapshot-backup
  namespace: default
spec:
  cluster:
    name: %s
  method: volumeSnapshot
`, clusterName)

	for name, body := range map[string]string{
		"snapshot-backup.yaml":  backup,
		"restored-cluster.yaml": snapshotClusterManifest(restoredClusterName, nodeName, "snapshot-backup"),
	} {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", name, []byte(body), 0644); err != nil {
			return err
		}
	}
	return nil
}

// StageSnapshotModeManifests writes the three manifests the hot/cold snapshot lab applies: two
// Backup requests that differ in one field, and a Cluster that recovers from the cold one.
//
// `online` is the field. True — the default — takes the snapshot while PostgreSQL is running,
// bracketed by pg_backup_start and pg_backup_stop, so the volume is copied mid-flight and the
// snapshot carries a backup label telling recovery where to begin. False fences the target
// instance first, so what is copied is a cleanly shut down data directory: no backup label, and
// a control file that says so.
func (c *CNPG) StageSnapshotModeManifests(ctx context.Context, serverID, clusterName, nodeName string, logf func(string)) error {
	backup := func(name string, online bool) string {
		return fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: %s
  namespace: default
spec:
  cluster:
    name: %s
  method: volumeSnapshot
  online: %t
`, name, clusterName, online)
	}

	files := map[string]string{
		"hot-backup.yaml":  backup(hotBackupName, true),
		"cold-backup.yaml": backup(coldBackupName, false),
		// Recovering from a snapshot is the same manifest whichever mode produced it — which
		// is the point the last objective checks.
		"restore-cold.yaml": snapshotClusterManifest(coldRestoredClusterName, nodeName, coldBackupName),
	}
	logf("staging the hot and cold Backup manifests, and a cluster that recovers from the cold one")
	for name, body := range files {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", name, []byte(body), 0644); err != nil {
			return err
		}
	}
	return nil
}

// StagePITRSnapshotManifests writes what the snapshot-PITR lab applies: a hot and a cold Backup
// request, and two recovery Clusters that start from those snapshots and then replay WAL out of
// the object store up to a moment the learner chooses.
//
// The shape worth reading is the recovery block. `volumeSnapshots` says where the data directory
// comes from; `source` names an external cluster the WAL archive is behind; `recoveryTarget`
// says where to stop. A snapshot alone can only ever restore you to the instant it was taken —
// everything after that instant comes from the archive, which is why both halves are here.
func (c *CNPG) StagePITRSnapshotManifests(ctx context.Context, serverID, clusterName, nodeName string, logf func(string)) error {
	backup := func(name string, online bool) string {
		return fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: %s
  namespace: default
spec:
  cluster:
    name: %s
  method: volumeSnapshot
  online: %t
`, name, clusterName, online)
	}

	// TARGET_TIME is left for the learner to substitute, exactly as the object-store PITR
	// template does: choosing the moment is the lab.
	recover := func(name, snapshot string) string {
		return fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
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
      source: origin
      volumeSnapshots:
        storage:
          name: %s
          kind: VolumeSnapshot
          apiGroup: snapshot.storage.k8s.io
      recoveryTarget:
        targetTime: "TARGET_TIME"
  externalClusters:
  - name: origin
    plugin:
      name: %s
      parameters:
        barmanObjectName: %s
        serverName: %s
`, name, cnpgPostgresImage, nodeName, snapshotStorageClass, snapshot, barmanPluginName, objectStoreName, clusterName)
	}

	files := map[string]string{
		"hot-backup.yaml":         backup(hotBackupName, true),
		"cold-backup.yaml":        backup(coldBackupName, false),
		"pitr-hot.yaml.template":  recover("pg-hot-pitr", hotBackupName),
		"pitr-cold.yaml.template": recover("pg-cold-pitr", coldBackupName),
	}
	logf("staging the hot and cold Backup manifests and two point-in-time recovery templates")
	for name, body := range files {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", name, []byte(body), 0644); err != nil {
			return err
		}
	}
	return nil
}

// StageScheduledSnapshotManifests writes the two ScheduledBackups the declarative-backup lab
// applies: one that runs online on a schedule, and one that runs cold. Both are staged, because
// declaring them is the lab.
func (c *CNPG) StageScheduledSnapshotManifests(ctx context.Context, serverID, clusterName string, logf func(string)) error {
	scheduled := func(name, schedule string, online, immediate bool) string {
		return fmt.Sprintf(`apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: %s
  namespace: default
spec:
  schedule: "%s"
  immediate: %t
  backupOwnerReference: self
  cluster:
    name: %s
  method: volumeSnapshot
  online: %t
`, name, schedule, immediate, clusterName, online)
	}

	files := map[string]string{
		// Six fields, not five: CloudNativePG's schedule includes seconds.
		"scheduled-online.yaml": scheduled("every-minute-online", "0 * * * * *", true, true),
		"scheduled-cold.yaml":   scheduled("every-two-minutes-cold", "0 */2 * * * *", false, false),
	}
	logf("staging the online and cold ScheduledBackup manifests")
	for name, body := range files {
		if err := c.k3d.docker.PutArchive(ctx, serverID, "/root", name, []byte(body), 0644); err != nil {
			return err
		}
	}
	return nil
}
