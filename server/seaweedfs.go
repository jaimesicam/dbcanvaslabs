package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// seaweedfs.go — a real SeaweedFS (S3-compatible object storage) container per attempt,
// mirroring ~/Projects/dbcanvas's own seaweedfs.go (read-only reference). Not yet wired
// to any CNPG backup functionality (Barman Cloud plugin, ObjectStore CR) — that's future
// LABORATORY.md roadmap scope; for now it's stood up so it's there when those labs land.

const seaweedImage = "chrislusf/seaweedfs:latest"

type SeaweedFS struct {
	docker *Docker
}

func NewSeaweedFS(docker *Docker) *SeaweedFS {
	return &SeaweedFS{docker: docker}
}

// Deploy pulls the image, creates the container, stages its S3 identity file (must exist
// before the process starts), starts it, then creates the bucket via `weed shell` —
// retried, since the S3 API takes a moment to come up after the process starts.
func (s *SeaweedFS) Deploy(ctx context.Context, name, network, accessKey, secretKey, bucket string, logf func(string)) (string, error) {
	logf("pulling seaweedfs image")
	if err := s.docker.ImagePull(ctx, seaweedImage); err != nil {
		return "", err
	}

	id, err := s.docker.ContainerCreate(ctx, ContainerSpec{
		Name:     name,
		Image:    seaweedImage,
		Hostname: name,
		Network:  network,
		Aliases:  []string{name},
		Cmd:      []string{"server", "-dir=/data", "-s3", "-s3.config=/etc/seaweedfs/s3.json"},
	})
	if err != nil {
		return "", err
	}

	identity := map[string]any{
		"identities": []map[string]any{
			{
				"name":        accessKey,
				"credentials": []map[string]string{{"accessKey": accessKey, "secretKey": secretKey}},
				"actions":     []string{"Admin", "Read", "Write", "List", "Tagging"},
			},
		},
	}
	raw, _ := json.Marshal(identity)
	if err := s.docker.PutArchive(ctx, id, "/etc/seaweedfs", "s3.json", raw, 0644); err != nil {
		return "", err
	}

	logf("starting seaweedfs")
	if err := s.docker.ContainerStart(ctx, id); err != nil {
		return "", err
	}

	logf("creating bucket " + bucket)
	shellCmd := fmt.Sprintf("printf 's3.bucket.create -name %s\\n' | weed shell", bucket)
	var lastErr error
	for i := 0; i < 10; i++ {
		res, err := s.docker.Exec(ctx, id, []string{"sh", "-c", shellCmd}, nil, "/")
		if err == nil && res.ExitCode == 0 {
			return id, nil
		}
		lastErr = fmt.Errorf("%v (exit %d): %s", err, res.ExitCode, res.Stderr)
		time.Sleep(3 * time.Second)
	}
	return id, fmt.Errorf("creating seaweedfs bucket: %w", lastErr)
}

func (s *SeaweedFS) Destroy(ctx context.Context, containerID string) error {
	return s.docker.ContainerRemove(ctx, containerID)
}
