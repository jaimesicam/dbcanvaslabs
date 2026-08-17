package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// registry.go — the smallest possible OCI registry client, used by exactly one thing: the
// multi-arch lab's grader.
//
// That lab has the learner walk a public image tag down to the image their own node runs —
// index, then the per-architecture manifest, then the config blob that finally states an
// architecture. Grading it means walking the same chain server-side and comparing, because
// the only alternative is trusting a digest the learner typed. Anonymous pull tokens are all
// this needs; nothing here authenticates, pushes, or caches.
//
// Same stdlib-only rule as the rest of server/: net/http and encoding/json, no registry SDK.

const (
	ghcrHost = "ghcr.io"
	// Both media types have to be offered on every request. An index answers with the OCI
	// index type, a single-platform manifest with the OCI manifest type, and a registry that
	// is not offered the type it holds answers with a v2 schema conversion instead.
	ociAcceptHeader = "application/vnd.oci.image.index.v1+json," +
		"application/vnd.docker.distribution.manifest.list.v2+json," +
		"application/vnd.oci.image.manifest.v1+json," +
		"application/vnd.docker.distribution.manifest.v2+json"
)

var registryClient = &http.Client{Timeout: 20 * time.Second}

// splitImage turns ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie into its repository
// and reference. Only ghcr.io images are ever passed in — every image these labs pin lives
// there — so anything else is refused rather than half-handled.
func splitImage(image string) (repo, ref string, err error) {
	rest, ok := strings.CutPrefix(image, ghcrHost+"/")
	if !ok {
		return "", "", fmt.Errorf("not a %s image: %s", ghcrHost, image)
	}
	i := strings.LastIndex(rest, ":")
	if i < 0 {
		return "", "", fmt.Errorf("image %s names no tag", image)
	}
	return rest[:i], rest[i+1:], nil
}

// registryToken fetches an anonymous pull token. Public repositories still need one — ghcr
// answers an unauthenticated manifest request with 401.
func registryToken(ctx context.Context, repo string) (string, error) {
	body, err := httpGet(ctx, fmt.Sprintf("https://%s/token?scope=repository:%s:pull", ghcrHost, repo))
	if err != nil {
		return "", err
	}
	var t struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &t); err != nil {
		return "", err
	}
	if t.Token == "" {
		return "", fmt.Errorf("registry returned no pull token for %s", repo)
	}
	return t.Token, nil
}

func registryGet(ctx context.Context, token, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", ociAcceptHeader)
	resp, err := registryClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// imageIndex is one tag's list of per-platform manifests. The entries whose platform is
// "unknown/unknown" are attestations (provenance and SBOM), not runnable images — the lab
// says so, and this ignores them by matching on os and architecture.
type imageIndex struct {
	MediaType string `json:"mediaType"`
	Manifests []struct {
		Digest   string `json:"digest"`
		Platform struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
		} `json:"platform"`
	} `json:"manifests"`
}

// indexPlatforms returns the linux platforms a tag publishes, and the digest of each.
func indexPlatforms(ctx context.Context, image string) (map[string]string, error) {
	repo, ref, err := splitImage(image)
	if err != nil {
		return nil, err
	}
	token, err := registryToken(ctx, repo)
	if err != nil {
		return nil, err
	}
	body, err := registryGet(ctx, token, fmt.Sprintf("https://%s/v2/%s/manifests/%s", ghcrHost, repo, ref))
	if err != nil {
		return nil, err
	}
	var idx imageIndex
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, m := range idx.Manifests {
		if m.Platform.OS == "linux" && m.Platform.Architecture != "unknown" {
			out[m.Platform.Architecture] = m.Digest
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s publishes no linux platforms", image)
	}
	return out, nil
}

// manifestConfigDigest is the second step of the chain: the per-architecture manifest names
// the config blob that actually records what the image was built for.
func manifestConfigDigest(ctx context.Context, image, manifestDigest string) (string, error) {
	repo, _, err := splitImage(image)
	if err != nil {
		return "", err
	}
	token, err := registryToken(ctx, repo)
	if err != nil {
		return "", err
	}
	body, err := registryGet(ctx, token, fmt.Sprintf("https://%s/v2/%s/manifests/%s", ghcrHost, repo, manifestDigest))
	if err != nil {
		return "", err
	}
	var m struct {
		Config struct {
			Digest string `json:"digest"`
		} `json:"config"`
	}
	if err := json.Unmarshal(body, &m); err != nil {
		return "", err
	}
	if m.Config.Digest == "" {
		return "", fmt.Errorf("manifest %s names no config blob", manifestDigest)
	}
	return m.Config.Digest, nil
}

// blobPlatform is the last step: the config blob's own architecture and os fields, which are
// the image's answer to "what was I built for".
func blobPlatform(ctx context.Context, image, configDigest string) (arch, os string, err error) {
	repo, _, err := splitImage(image)
	if err != nil {
		return "", "", err
	}
	token, err := registryToken(ctx, repo)
	if err != nil {
		return "", "", err
	}
	body, err := registryGet(ctx, token, fmt.Sprintf("https://%s/v2/%s/blobs/%s", ghcrHost, repo, configDigest))
	if err != nil {
		return "", "", err
	}
	var c struct {
		Architecture string `json:"architecture"`
		OS           string `json:"os"`
	}
	if err := json.Unmarshal(body, &c); err != nil {
		return "", "", err
	}
	return c.Architecture, c.OS, nil
}
