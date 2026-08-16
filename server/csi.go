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
