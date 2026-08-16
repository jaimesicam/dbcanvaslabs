package main

import "context"

// state.go — a lightweight cluster snapshot for the frontend's cluster-visualization
// panels (ClusterSpine/Inspector/Topology). Distinct from check.go's per-task grading:
// this is refreshed on demand (alongside each "Check Solution" click, or an explicit
// manual refresh) rather than polled on an interval — no background polling anywhere.

type NodeState struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	Up   bool   `json:"up"`
}

type PodState struct {
	Name  string `json:"name"`
	Phase string `json:"phase"`
	Node  string `json:"node"`
}

type OperatorState struct {
	Installed bool      `json:"installed"`
	Pod       *PodState `json:"pod,omitempty"`
}

type ClusterMemberState struct {
	Role   string `json:"role"`
	Node   string `json:"node"`
	Phase  string `json:"phase"`
	Volume string `json:"volume"`
}

type ClusterStateView struct {
	Name      string                        `json:"name"`
	Namespace string                        `json:"namespace"`
	Instances int                           `json:"instances"`
	Phase     string                        `json:"phase"`
	Primary   string                        `json:"primary"`
	Members   map[string]ClusterMemberState `json:"members"`
}

type StateView struct {
	ClusterName  string            `json:"clusterName"`
	StorageClass string            `json:"storageClass"`
	Nodes        []NodeState       `json:"nodes"`
	Operator     OperatorState     `json:"operator"`
	Cluster      *ClusterStateView `json:"cluster,omitempty"`
}

func readState(ctx context.Context, k3d *K3D, a *Attempt) (StateView, error) {
	server := a.serverNodeID()
	view := StateView{ClusterName: a.clusterNameSnap(), StorageClass: "local-path"}
	if server == "" {
		return view, nil // still provisioning — nothing to report yet
	}

	a.mu.Lock()
	nodes := append([]NodeInfo(nil), a.nodes...)
	a.mu.Unlock()

	var nl nodeList
	_ = kubectlJSON(ctx, k3d, server, &nl, "get", "nodes")
	for _, n := range nodes {
		view.Nodes = append(view.Nodes, NodeState{ID: n.LabID, Role: n.Role, Up: nl.ready(n.ContainerName)})
	}

	var opPods podList
	if err := kubectlJSON(ctx, k3d, server, &opPods, "-n", cnpgNamespace, "get", "pods"); err == nil && len(opPods.Items) > 0 {
		p := opPods.Items[0]
		view.Operator = OperatorState{
			Installed: p.Status.Phase == "Running",
			Pod:       &PodState{Name: p.Metadata.Name, Phase: p.Status.Phase, Node: a.labIDForContainerName(p.Spec.NodeName)},
		}
	}

	var c cnpgCluster
	if err := kubectlJSON(ctx, k3d, server, &c, "get", "cluster.postgresql.cnpg.io", "pg-cluster"); err == nil {
		members := map[string]ClusterMemberState{}
		var pods podList
		var pvcs pvcList
		_ = kubectlJSON(ctx, k3d, server, &pods, "get", "pods", "-l", "cnpg.io/cluster=pg-cluster")
		_ = kubectlJSON(ctx, k3d, server, &pvcs, "get", "pvc")
		volumeByName := map[string]string{}
		for _, p := range pvcs.Items {
			volumeByName[p.Metadata.Name] = p.Spec.VolumeName
		}
		for _, p := range pods.Items {
			role := "replica"
			if p.Metadata.Name == c.Status.CurrentPrimary {
				role = "primary"
			}
			members[p.Metadata.Name] = ClusterMemberState{
				Role:   role,
				Node:   a.labIDForContainerName(p.Spec.NodeName),
				Phase:  p.Status.Phase,
				Volume: volumeByName[p.Metadata.Name],
			}
		}
		view.Cluster = &ClusterStateView{
			Name:      "pg-cluster",
			Namespace: "default",
			Instances: c.Status.Instances,
			Phase:     c.Status.Phase,
			Primary:   c.Status.CurrentPrimary,
			Members:   members,
		}
	}

	return view, nil
}
