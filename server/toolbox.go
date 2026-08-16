package main

import (
	"context"
	"fmt"
	"log"
	"strings"
)

// toolbox.go — one Ubuntu tooling container per attempt, a sibling of the k3d nodes on the
// attempt's Docker network, exposed to the learner as an extra terminal tab.
//
// Why it exists: the rancher/k3s image is deliberately minimal. It has no `jq`, no `curl`,
// no `psql`, no `openssl` and no `yq`, so every lab that wants to read `-o json`, scrape a
// metrics endpoint, connect to the database as a client or look at a certificate has been
// working around their absence — `grep -o '"field":"[^"]*"'` where `jq -r .field` is the
// thing a learner would actually type at work. The toolbox is where the real tools are.
//
// Why it is an image and not an install step: provisioning already spends minutes building
// a real cluster, and `apt-get install` per attempt would add minutes more and make every
// lab depend on the learner's network. toolbox/Dockerfile is built once by `make toolbox`
// (and by `make up`, if the tag is missing); provisioning only starts a container from it.
//
// The interesting part is the networking. See toolbox/entrypoint.sh: a sibling container
// can reach the nodes by their Docker addresses but has no route to a Pod address
// (10.42.x.x) or a Service address (10.43.x.x), because those networks live inside the
// nodes. Four static routes — each node's own pod CIDR via that node, and the service CIDR
// via any one node — are enough for both: the owning node forwards pod traffic, and
// kube-proxy DNATs ClusterIP traffic in PREROUTING on the way through. Confirmed live
// against a real cluster: instance Pods, their 9187 metrics ports, every ClusterIP
// including kube-dns and the API server's 10.43.0.1.
//
// Everything here is best-effort. A lab environment without a toolbox is still a complete
// lab environment — every lab's own content works from the node tabs — so a missing image
// or a failed route logs and moves on rather than failing the provision.

// toolboxImage is duplicated in the Makefile (TOOLBOX_IMAGE / TOOLBOX_TAG). Bump both
// together: this app never builds or pulls it, it only expects to find it.
const toolboxImage = "dbcanvas-labs-toolbox:1"

// toolboxLabID is the frontend-facing terminal id, alongside k3d-server / k3d-agent-N.
const toolboxLabID = "toolbox"

type Toolbox struct {
	docker *Docker
	k3d    *K3D
}

func NewToolbox(docker *Docker, k3d *K3D) *Toolbox {
	return &Toolbox{docker: docker, k3d: k3d}
}

// Deploy starts the toolbox for an attempt and returns its container ID, or "" if there is
// no usable toolbox. It must run after the cluster is up: the routes and the kubeconfig are
// read from the live cluster, not assumed.
//
// Two things it guarantees, both load-bearing:
//
//   - Exactly one logf() call on every path, because PROVISION_STEPS in LabPlayer.jsx counts
//     these lines to draw the progress bar.
//   - It either returns a *running* container or "". Anything half-built is removed here
//     rather than recorded, so a failed toolbox is indistinguishable from an unbuilt image:
//     one tab fewer, and nothing for the teardown paths to find.
func (t *Toolbox) Deploy(ctx context.Context, name, network, serverID string, nodes []NodeInfo, logf func(string)) (string, error) {
	if !t.docker.ImageExists(ctx, toolboxImage) {
		logf("toolbox image " + toolboxImage + " not found — skipping the toolbox tab (run `make toolbox`)")
		return "", nil
	}
	logf("starting the toolbox (jq, curl, psql, openssl, yq) on the lab network")

	id, err := t.deploy(ctx, name, network, serverID, nodes)
	if err != nil {
		if id != "" {
			if rmErr := t.docker.ContainerRemove(ctx, id); rmErr != nil {
				log.Printf("removing half-built toolbox %s: %v", name, rmErr)
			}
		}
		return "", err
	}
	return id, nil
}

func (t *Toolbox) deploy(ctx context.Context, name, network, serverID string, nodes []NodeInfo) (string, error) {
	routes, err := t.routes(ctx, serverID, nodes)
	if err != nil {
		return "", fmt.Errorf("toolbox routes: %w", err)
	}
	dnsIP, err := t.clusterDNS(ctx, serverID)
	if err != nil {
		return "", fmt.Errorf("toolbox dns: %w", err)
	}

	id, err := t.docker.ContainerCreate(ctx, ContainerSpec{
		Name:     name,
		Image:    toolboxImage,
		Hostname: toolboxLabID,
		Network:  network,
		Aliases:  []string{toolboxLabID},
		// Needed by the entrypoint to install the pod/service routes. Nothing else in this
		// app asks for a capability; the toolbox does because routing itself onto the
		// cluster's networks is the whole point of it.
		CapAdd: []string{"NET_ADMIN"},
		Env: []string{
			"TOOLBOX_ROUTES=" + strings.Join(routes, " "),
			"TOOLBOX_DNS=" + dnsIP,
			"TOOLBOX_SEARCH=default.svc.cluster.local svc.cluster.local cluster.local",
		},
	})
	if err != nil {
		return "", err
	}

	// Staged before the container starts, exactly like SeaweedFS's identity file: the shell
	// a learner lands in should already be able to talk to the cluster.
	kubeconfig, err := t.kubeconfig(ctx, serverID, network)
	if err != nil {
		return id, fmt.Errorf("toolbox kubeconfig: %w", err)
	}
	if err := t.docker.PutArchive(ctx, id, "/root/.kube", "config", []byte(kubeconfig), 0600); err != nil {
		return id, fmt.Errorf("staging toolbox kubeconfig: %w", err)
	}

	if err := t.docker.ContainerStart(ctx, id); err != nil {
		return id, err
	}
	return id, nil
}

func (t *Toolbox) Destroy(ctx context.Context, containerID string) error {
	if containerID == "" {
		return nil
	}
	return t.docker.ContainerRemove(ctx, containerID)
}

// routes builds the CIDR=GATEWAY list the entrypoint installs: one entry per node for the
// pod CIDR that node owns, and one for the whole service CIDR.
func (t *Toolbox) routes(ctx context.Context, serverID string, nodes []NodeInfo) ([]string, error) {
	res, err := t.k3d.Kubectl(ctx, serverID, "get", "nodes",
		"-o", `jsonpath={range .items[*]}{.metadata.name}{" "}{.spec.podCIDR}{"\n"}{end}`)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("reading node pod CIDRs (exit %d): %s", res.ExitCode, res.Stderr)
	}

	// Kubernetes node name == k3d container name, which is how a podCIDR is tied back to the
	// Docker address that owns it.
	ipByContainer := map[string]string{}
	for _, n := range nodes {
		ip, err := t.docker.ContainerIP(ctx, n.ID, "")
		if err != nil {
			return nil, err
		}
		ipByContainer[n.ContainerName] = ip
	}

	var routes []string
	for _, line := range strings.Split(strings.TrimSpace(res.Stdout), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		if ip := ipByContainer[fields[0]]; ip != "" {
			routes = append(routes, fields[1]+"="+ip)
		}
	}
	if len(routes) == 0 {
		return nil, fmt.Errorf("no pod CIDRs resolved to a node address")
	}

	// The service CIDR, via the control-plane node. Derived from the `kubernetes` Service's
	// own address rather than hard-coded: it is the first address in the range by
	// definition, so masking it to a /16 covers k3s's default and any /16 override, and
	// there is no flag to read on a node that does not run the apiserver.
	svcRes, err := t.k3d.Kubectl(ctx, serverID, "get", "svc", "kubernetes", "-n", "default",
		"-o", "jsonpath={.spec.clusterIP}")
	if err == nil && svcRes.ExitCode == 0 {
		if cidr := maskToSlash16(strings.TrimSpace(svcRes.Stdout)); cidr != "" {
			serverIP := ipByContainer[controlPlaneContainerName(nodes)]
			if serverIP != "" {
				routes = append(routes, cidr+"="+serverIP)
			}
		}
	}
	return routes, nil
}

// clusterDNS is kube-dns's ClusterIP — reachable from the toolbox once the service route
// above is installed, which is what lets `pg-cluster-rw` resolve there as it does in a Pod.
func (t *Toolbox) clusterDNS(ctx context.Context, serverID string) (string, error) {
	res, err := t.k3d.Kubectl(ctx, serverID, "get", "svc", "kube-dns", "-n", "kube-system",
		"-o", "jsonpath={.spec.clusterIP}")
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("reading kube-dns address (exit %d): %s", res.ExitCode, res.Stderr)
	}
	return strings.TrimSpace(res.Stdout), nil
}

// kubeconfig is k3s's own admin kubeconfig with the server address rewritten from the
// node's loopback to the address the toolbox can actually reach it on.
func (t *Toolbox) kubeconfig(ctx context.Context, serverID, network string) (string, error) {
	res, err := t.docker.ExecRoot(ctx, serverID, []string{"cat", "/etc/rancher/k3s/k3s.yaml"}, nil)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("reading k3s.yaml (exit %d): %s", res.ExitCode, res.Stderr)
	}
	ip, err := t.docker.ContainerIP(ctx, serverID, network)
	if err != nil {
		return "", err
	}
	return strings.ReplaceAll(res.Stdout, "https://127.0.0.1:6443", "https://"+ip+":6443"), nil
}

func controlPlaneContainerName(nodes []NodeInfo) string {
	for _, n := range nodes {
		if n.Role == "control-plane" {
			return n.ContainerName
		}
	}
	return ""
}

// maskToSlash16 turns 10.43.0.1 into 10.43.0.0/16.
func maskToSlash16(ip string) string {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return ""
	}
	return parts[0] + "." + parts[1] + ".0.0/16"
}
