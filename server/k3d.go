package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// k3d.go — the k3d cluster frame: a throwaway 3-node k3s cluster (1 server + 2 agents)
// created by the real `k3d` CLI, used to run CloudNativePG the way it actually runs in
// production. Mirrors the pattern in ~/Projects/dbcanvas's own k3d.go (read-only
// reference): k3d itself is a Docker API *client* invoked as a subprocess (not
// reimplemented), while this backend drives Docker directly for everything else
// (network, SeaweedFS, node discovery, kubectl exec, the interactive terminal).

const (
	metalLBVersion  = "v0.14.9"
	metalLBManifest = "https://raw.githubusercontent.com/metallb/metallb/" + metalLBVersion + "/config/manifests/metallb-native.yaml"
	k3dKubeconfig   = "/etc/rancher/k3s/k3s.yaml"

	// Pinned rather than left to k3d's built-in default, which trails the k3s releases and
	// silently changes when the k3d binary is upgraded — a lab that grades real `kubectl`
	// output should not have its Kubernetes version drift underneath it. Same reasoning as
	// dbcanvas's own `--image` pin (see its k3d.go: "The Kubernetes version is always ours,
	// never k3d's default").
	k3sImage = "rancher/k3s:v1.35.5-k3s1"

	// k3d's own wait for every node to report `successfully registered node`. dbcanvas uses
	// 10m for the same 1-server/2-agent shape; 5m was not enough here whenever the host was
	// busy, and a timeout costs a full teardown + retry, so the generous value is the cheap one.
	k3dCreateTimeout = "10m"
)

// clusterPrefix marks every cluster this app owns, so a startup sweep can tell its own
// leftovers apart from any other k3d cluster on the machine (dbcanvas runs its own).
const clusterPrefix = "dbol-"

func clusterName(attemptID string) string { return clusterPrefix + attemptID }
func networkName(attemptID string) string { return "dbonlinetest-" + attemptID }

func serverContainerName(cluster string) string { return "k3d-" + cluster + "-server-0" }
func agentContainerName(cluster string, i int) string {
	return fmt.Sprintf("k3d-%s-agent-%d", cluster, i)
}

type K3D struct {
	docker *Docker
	sock   string
}

func NewK3D(docker *Docker, sock string) *K3D {
	return &K3D{docker: docker, sock: sock}
}

// k3dBinary resolves the k3d executable: $K3D_BIN, else "k3d" on $PATH. The container
// image bakes a static k3d in and sets K3D_BIN; a native dev run uses the host's own
// k3d next to Docker. Same contract as dbcanvas's k3dBinary().
func k3dBinary() (string, error) {
	if p := strings.TrimSpace(os.Getenv("K3D_BIN")); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("K3D_BIN=%s does not exist", p)
	}
	return exec.LookPath("k3d")
}

func (k *K3D) runK3D(ctx context.Context, args ...string) (string, error) {
	bin, err := k3dBinary()
	if err != nil {
		return "", fmt.Errorf("k3d is not available: %w", err)
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	// HOME is pointed at a scratch dir on purpose. k3d wants a home for its own config
	// and, by default, merges every cluster it creates into ~/.kube/config — neither of
	// which this app has any use for, since kubectl is only ever exec'd *inside* node
	// containers, never on the host. The distroless runtime image has no home directory
	// at all, and a native dev run should not be quietly rewriting the developer's real
	// kubeconfig with throwaway dbol-* clusters either.
	cmd.Env = append(os.Environ(),
		"DOCKER_HOST=unix://"+k.sock,
		"HOME=/tmp",
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err = cmd.Run()
	if err != nil {
		return out.String(), fmt.Errorf("k3d %s: %w: %s", strings.Join(args, " "), err, out.String())
	}
	return out.String(), nil
}

// CreateCluster creates a 3-node (1 server + 2 agents) k3d cluster on the given Docker
// network, with servicelb/traefik disabled — MetalLB replaces servicelb, traefik isn't
// needed for these labs — mirroring dbcanvas's own k3d.go flags.
func (k *K3D) CreateCluster(ctx context.Context, cluster, network string, logf func(string)) error {
	logf("removing any stale cluster with this name (idempotent)")
	_, _ = k.runK3D(ctx, "cluster", "delete", cluster)

	// Pull the node image before handing over to k3d, not during. k3d's --timeout covers the
	// whole create *including* any pull it has to do itself, so on a cold cache the download
	// competes for the budget meant for nodes actually registering — and the failure it
	// produces ("agent failed to get ready") names the wrong culprit. Pulling here keeps the
	// create's clock spent only on the cluster, and lets a slow download be reported as one.
	logf("ensuring the k3s node image " + k3sImage + " is present")
	if err := k.docker.ImagePull(ctx, k3sImage); err != nil {
		return fmt.Errorf("pull %s: %w", k3sImage, err)
	}

	logf("creating k3d cluster (1 server + 2 agents)")
	_, err := k.runK3D(ctx, "cluster", "create", cluster,
		"--image", k3sImage,
		"--network", network,
		"--servers", "1",
		"--agents", "2",
		"--k3s-arg", "--disable=servicelb@server:*",
		"--k3s-arg", "--disable=traefik@server:*",
		"--api-port", "0.0.0.0:0",
		"--wait", "--timeout", k3dCreateTimeout,
	)
	return err
}

// PreseedImages makes images available inside every node of the cluster without any node
// reaching the network for them: pulled once into the host's Docker (cached across every
// future attempt) and then side-loaded into the nodes with `k3d image import`.
//
// This is the single biggest win in provisioning time. A k3d node has its own containerd
// image store, shared with neither the host nor the other nodes, so a 3-instance Postgres
// cluster otherwise triggers three independent ~500MB pulls from ghcr.io — serialized
// behind CNPG's own one-instance-at-a-time bootstrap, since it only creates the next
// instance once the previous one is up. Importing is local I/O and runs once for all nodes.
//
// Non-fatal by design: a failure here costs time, not correctness, because the nodes fall
// back to pulling the image themselves exactly as before. Saying so in the log beats
// failing an otherwise healthy cluster over a slow registry.
func (k *K3D) PreseedImages(ctx context.Context, cluster string, images []string, logf func(string)) {
	for _, img := range images {
		logf("caching " + img + " on the host")
		if err := k.docker.ImagePull(ctx, img); err != nil {
			logf("could NOT pre-seed " + img + " (" + err.Error() + ") — nodes will pull it themselves, which is slower")
			continue
		}
	}
	logf("importing images into the cluster's nodes (local — no node downloads them again)")
	args := append([]string{"image", "import", "--cluster", cluster}, images...)
	if out, err := k.runK3D(ctx, args...); err != nil {
		logf("could NOT import images into the nodes (" + err.Error() + ") — nodes will pull them themselves, which is slower")
		_ = out
	}
}

func (k *K3D) DestroyCluster(ctx context.Context, cluster string) error {
	_, err := k.runK3D(ctx, "cluster", "delete", cluster)
	return err
}

/* ------------------------------------------------------------------ node discovery */

type NodeInfo struct {
	ID            string // Docker container ID
	ContainerName string // real k3d container name, e.g. k3d-dbol-xyz-server-0
	LabID         string // clean id the frontend/labs use: k3d-server / k3d-agent-1 / k3d-agent-2
	Role          string // "control-plane" | "<none>"
}

func (k *K3D) DiscoverNodes(ctx context.Context, cluster string) ([]NodeInfo, error) {
	specs := []struct {
		container string
		labID     string
		role      string
	}{
		{serverContainerName(cluster), "k3d-server", "control-plane"},
		{agentContainerName(cluster, 0), "k3d-agent-1", "<none>"},
		{agentContainerName(cluster, 1), "k3d-agent-2", "<none>"},
	}
	var nodes []NodeInfo
	for _, s := range specs {
		id, err := k.docker.ContainerByName(ctx, s.container)
		if err != nil {
			return nil, err
		}
		if id == "" {
			return nil, fmt.Errorf("node container %s not found", s.container)
		}
		nodes = append(nodes, NodeInfo{ID: id, ContainerName: s.container, LabID: s.labID, Role: s.role})
	}
	return nodes, nil
}

// PropagateKubeconfig copies the admin kubeconfig from the server node onto both agents
// too (rewriting `server: https://127.0.0.1:6443` to the server's real container name,
// resolvable over the shared Docker network's embedded DNS), so any of the 3 node
// terminals can run kubectl — matching what the labs' own instructions already say.
func (k *K3D) PropagateKubeconfig(ctx context.Context, nodes []NodeInfo) error {
	var server NodeInfo
	var agents []NodeInfo
	for _, n := range nodes {
		if n.Role == "control-plane" {
			server = n
		} else {
			agents = append(agents, n)
		}
	}
	res, err := k.docker.ExecRoot(ctx, server.ID, []string{"cat", k3dKubeconfig}, nil)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("reading server kubeconfig: exit %d: %s", res.ExitCode, res.Stderr)
	}
	rewritten := strings.ReplaceAll(res.Stdout, "127.0.0.1", server.ContainerName)

	for _, a := range agents {
		if _, err := k.docker.ExecRoot(ctx, a.ID, []string{"mkdir", "-p", "/etc/rancher/k3s"}, nil); err != nil {
			return err
		}
		if err := k.docker.PutArchive(ctx, a.ID, "/etc/rancher/k3s", "k3s.yaml", []byte(rewritten), 0644); err != nil {
			return err
		}
	}
	return nil
}

/* ------------------------------------------------------------------ kubectl */

func (k *K3D) Kubectl(ctx context.Context, nodeID string, args ...string) (ExecResult, error) {
	cmd := append([]string{"kubectl"}, args...)
	return k.docker.ExecRoot(ctx, nodeID, cmd, []string{"KUBECONFIG=" + k3dKubeconfig})
}

func (k *K3D) waitDeployment(ctx context.Context, nodeID, namespace, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		res, err := k.Kubectl(ctx, nodeID, "-n", namespace, "get", "deploy", name, "-o", "jsonpath={.status.readyReplicas}")
		if err == nil && res.ExitCode == 0 {
			v := strings.TrimSpace(res.Stdout)
			if v != "" && v != "0" {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for deployment %s/%s", namespace, name)
}

func (k *K3D) waitPodReady(ctx context.Context, nodeID, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		res, err := k.Kubectl(ctx, nodeID, "get", "pod", name, "-o", "jsonpath={.status.containerStatuses[0].ready}")
		if err == nil && res.ExitCode == 0 && strings.TrimSpace(res.Stdout) == "true" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for pod %s to be ready", name)
}

func (k *K3D) waitCRD(ctx context.Context, nodeID, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		res, err := k.Kubectl(ctx, nodeID, "get", "crd", name, "-o", "jsonpath={.status.conditions[?(@.type=='Established')].status}")
		if err == nil && res.ExitCode == 0 && strings.TrimSpace(res.Stdout) == "True" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("timed out waiting for CRD %s", name)
}

/* ------------------------------------------------------------------ MetalLB */

// InstallMetalLB applies the upstream manifest, waits for its controller, then carves an
// address pool from the top of the attempt's own Docker subnet — the same "top 50
// addresses" logic dbcanvas's own metalLBPool uses, since Docker's IPAM hands out
// addresses from the bottom.
func (k *K3D) InstallMetalLB(ctx context.Context, serverID, network string, logf func(string)) error {
	logf("fetching MetalLB " + metalLBVersion + " manifest")
	manifest, err := httpGet(ctx, metalLBManifest)
	if err != nil {
		return fmt.Errorf("fetch metallb manifest: %w", err)
	}
	if err := k.docker.PutArchive(ctx, serverID, "/root", "metallb.yaml", manifest, 0644); err != nil {
		return err
	}
	logf("applying MetalLB")
	res, err := k.Kubectl(ctx, serverID, "apply", "-f", "/root/metallb.yaml")
	if err != nil || res.ExitCode != 0 {
		return fmt.Errorf("kubectl apply metallb: %v (exit %d): %s", err, res.ExitCode, res.Stderr)
	}

	logf("waiting for the MetalLB controller")
	if err := k.waitDeployment(ctx, serverID, "metallb-system", "controller", 3*time.Minute); err != nil {
		return err
	}

	subnet, err := k.docker.NetworkSubnet(ctx, network)
	if err != nil {
		return err
	}
	pool, err := metalLBPool(subnet)
	if err != nil {
		return err
	}
	poolYAML := fmt.Sprintf(`apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: dbonlinetest
  namespace: metallb-system
spec:
  addresses:
  - %s
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: dbonlinetest
  namespace: metallb-system
spec:
  ipAddressPools:
  - dbonlinetest
`, pool)
	if err := k.docker.PutArchive(ctx, serverID, "/root", "metallb-pool.yaml", []byte(poolYAML), 0644); err != nil {
		return err
	}

	logf("applying MetalLB address pool " + pool)
	// The admission webhook needs a moment after "Available" before it accepts these
	// CRs — same race dbcanvas's own k3d.go retries around.
	var lastErr error
	for i := 0; i < 10; i++ {
		res, err := k.Kubectl(ctx, serverID, "apply", "-f", "/root/metallb-pool.yaml")
		if err == nil && res.ExitCode == 0 {
			return nil
		}
		lastErr = fmt.Errorf("%v: %s", err, res.Stderr)
		time.Sleep(5 * time.Second)
	}
	return fmt.Errorf("applying metallb pool: %w", lastErr)
}

// metalLBPool carves a 50-address pool from the top of subnetCIDR.
func metalLBPool(subnetCIDR string) (string, error) {
	_, ipnet, err := net.ParseCIDR(subnetCIDR)
	if err != nil {
		return "", err
	}
	ip4 := ipnet.IP.To4()
	if ip4 == nil {
		return "", fmt.Errorf("not an IPv4 subnet: %s", subnetCIDR)
	}
	mask := ipnet.Mask
	bcast := make(net.IP, 4)
	for i := 0; i < 4; i++ {
		bcast[i] = ip4[i] | ^mask[i]
	}
	toU32 := func(ip net.IP) uint32 { return binary.BigEndian.Uint32(ip.To4()) }
	u32ToIP := func(u uint32) net.IP {
		b := make([]byte, 4)
		binary.BigEndian.PutUint32(b, u)
		return net.IP(b)
	}
	last := toU32(bcast) - 2
	first := last - 49
	base := toU32(ip4)
	if first <= base+1 {
		first = base + 2
	}
	return fmt.Sprintf("%s-%s", u32ToIP(first), u32ToIP(last)), nil
}

/* ------------------------------------------------------------------ helpers */

func httpGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}
