package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// docker.go — a stdlib-only Docker Engine API client, mirroring the pattern used by
// ~/Projects/dbcanvas (read-only reference): dial the daemon's unix socket directly,
// talk plain HTTP/JSON to a fake "docker" host, and hand-roll the one thing net/http
// can't do cleanly — hijacking an /exec/start response into a raw bidirectional stream
// for the interactive terminal and for streaming kubectl output.

// resolveDockerSocket finds the daemon socket without shelling out to the docker CLI.
// Order: $DOCKER_SOCK, then the common locations across a stock Docker Engine, Docker
// Desktop, and Rancher Desktop (confirmed at ~/.rd/docker.sock on this machine).
func resolveDockerSocket() string {
	if s := os.Getenv("DOCKER_SOCK"); s != "" {
		return s
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		"/var/run/docker.sock",
		filepath.Join(home, ".rd", "docker.sock"),
		filepath.Join(home, ".docker", "run", "docker.sock"),
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.Mode()&os.ModeSocket != 0 {
			return c
		}
	}
	return "/var/run/docker.sock"
}

type Docker struct {
	sock string
	http *http.Client
}

func NewDocker(sock string) *Docker {
	return &Docker{
		sock: sock,
		http: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					var d net.Dialer
					return d.DialContext(ctx, "unix", sock)
				},
			},
			Timeout: 5 * time.Minute,
		},
	}
}

func (d *Docker) url(path string) string {
	return "http://docker" + path
}

func (d *Docker) do(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.url(path), rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker %s %s: %w", method, path, err)
	}
	return resp, nil
}

func errFromResp(resp *http.Response) error {
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var e struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(b, &e)
	if e.Message != "" {
		return fmt.Errorf("docker: %s (status %d)", e.Message, resp.StatusCode)
	}
	return fmt.Errorf("docker: status %d: %s", resp.StatusCode, string(b))
}

func (d *Docker) doJSON(ctx context.Context, method, path string, body any, out any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	resp, err := d.do(ctx, method, path, raw)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errFromResp(resp)
	}
	if out == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

/* ------------------------------------------------------------------ networks */

func (d *Docker) NetworkEnsure(ctx context.Context, name string) error {
	resp, err := d.do(ctx, "GET", "/networks/"+name, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode == 200 {
		return nil
	}
	return d.doJSON(ctx, "POST", "/networks/create", map[string]any{
		"Name":   name,
		"Driver": "bridge",
	}, nil)
}

func (d *Docker) NetworkRemove(ctx context.Context, name string) error {
	resp, err := d.do(ctx, "DELETE", "/networks/"+name, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// NetworkSubnet returns the network's IPAM subnet in CIDR form, e.g. "172.20.0.0/16" —
// used to carve MetalLB's address pool from the top of the range.
func (d *Docker) NetworkSubnet(ctx context.Context, name string) (string, error) {
	var out struct {
		IPAM struct {
			Config []struct {
				Subnet string `json:"Subnet"`
			} `json:"Config"`
		} `json:"IPAM"`
	}
	if err := d.doJSON(ctx, "GET", "/networks/"+name, nil, &out); err != nil {
		return "", err
	}
	if len(out.IPAM.Config) == 0 {
		return "", fmt.Errorf("network %s has no IPAM subnet", name)
	}
	return out.IPAM.Config[0].Subnet, nil
}

/* ------------------------------------------------------------------ containers */

type ContainerSpec struct {
	Name        string
	Image       string
	Hostname    string
	Env         []string
	Cmd         []string
	Network     string
	Aliases     []string
	PublishPort int      // container port to publish on 127.0.0.1, 0 to skip
	CapAdd      []string // extra Linux capabilities, e.g. NET_ADMIN for a container that routes itself onto the cluster networks
}

func (d *Docker) ContainerCreate(ctx context.Context, spec ContainerSpec) (string, error) {
	body := map[string]any{
		"Image":    spec.Image,
		"Hostname": spec.Hostname,
		"Env":      spec.Env,
	}
	if len(spec.Cmd) > 0 {
		body["Cmd"] = spec.Cmd
	}
	hostConfig := map[string]any{
		"NetworkMode": spec.Network,
	}
	if len(spec.CapAdd) > 0 {
		hostConfig["CapAdd"] = spec.CapAdd
	}
	if spec.PublishPort != 0 {
		portKey := fmt.Sprintf("%d/tcp", spec.PublishPort)
		body["ExposedPorts"] = map[string]any{portKey: map[string]any{}}
		hostConfig["PortBindings"] = map[string]any{
			portKey: []map[string]string{{"HostIp": "127.0.0.1", "HostPort": ""}},
		}
	}
	body["HostConfig"] = hostConfig
	if spec.Network != "" {
		body["NetworkingConfig"] = map[string]any{
			"EndpointsConfig": map[string]any{
				spec.Network: map[string]any{"Aliases": spec.Aliases},
			},
		}
	}

	var out struct {
		Id string `json:"Id"`
	}
	if err := d.doJSON(ctx, "POST", "/containers/create?name="+spec.Name, body, &out); err != nil {
		return "", err
	}
	return out.Id, nil
}

func (d *Docker) ContainerStart(ctx context.Context, id string) error {
	resp, err := d.do(ctx, "POST", "/containers/"+id+"/start", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode != 304 {
		return errFromResp(resp)
	}
	return nil
}

func (d *Docker) ContainerStop(ctx context.Context, id string) error {
	resp, err := d.do(ctx, "POST", "/containers/"+id+"/stop?t=5", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode != 304 {
		return errFromResp(resp)
	}
	return nil
}

func (d *Docker) ContainerRemove(ctx context.Context, id string) error {
	resp, err := d.do(ctx, "DELETE", "/containers/"+id+"?force=true&v=true", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode != 404 {
		return errFromResp(resp)
	}
	return nil
}

// ContainerByName returns the container ID for an exact name match, or "" if none exists.
func (d *Docker) ContainerByName(ctx context.Context, name string) (string, error) {
	filters, _ := json.Marshal(map[string][]string{"name": {"^/" + name + "$"}})
	var out []struct {
		Id string `json:"Id"`
	}
	if err := d.doJSON(ctx, "GET", "/containers/json?all=true&filters="+urlQueryEscape(string(filters)), nil, &out); err != nil {
		return "", err
	}
	if len(out) == 0 {
		return "", nil
	}
	return out[0].Id, nil
}

// ContainerIP returns a container's address on the given network. Pods inside the k3d
// cluster can route to it — they cannot use Docker's embedded DNS, which only the node
// containers themselves resolve against, so anything a Pod has to reach is reached by
// address.
func (d *Docker) ContainerIP(ctx context.Context, id, network string) (string, error) {
	var out struct {
		NetworkSettings struct {
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := d.doJSON(ctx, "GET", "/containers/"+id+"/json", nil, &out); err != nil {
		return "", err
	}
	if n, ok := out.NetworkSettings.Networks[network]; ok && n.IPAddress != "" {
		return n.IPAddress, nil
	}
	for _, n := range out.NetworkSettings.Networks {
		if n.IPAddress != "" {
			return n.IPAddress, nil
		}
	}
	return "", fmt.Errorf("container %s has no address on %s", id, network)
}

func urlQueryEscape(s string) string {
	// Minimal query escaping (stdlib net/url would also work; keeping this file
	// dependency-free beyond net/http is a style choice, not a hard requirement).
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			fmt.Fprintf(&b, "%%%02X", r)
		}
	}
	return b.String()
}

/* ------------------------------------------------------------------ one-shot exec */

// withHome ensures HOME=/root and a real PATH are set. Passing any Env at all to exec
// create *replaces* the container's default environment rather than extending it, so
// without this every exec that supplies its own Env (e.g. KUBECONFIG=...) would silently
// lose PATH too and every command would fail with "exit 127: command not found".
func withHome(env []string) []string {
	out := append([]string{}, env...)
	hasHome, hasPath := false, false
	for _, e := range out {
		hasHome = hasHome || strings.HasPrefix(e, "HOME=")
		hasPath = hasPath || strings.HasPrefix(e, "PATH=")
	}
	if !hasHome {
		out = append(out, "HOME=/root")
	}
	if !hasPath {
		out = append(out, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	return out
}

type ExecResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// ExecRoot runs a non-interactive command with /root as its working directory — the
// convention every k3d node uses in this app (see Exec's doc comment for why that's not
// simply the image's default). Requires /root to already exist; use Exec with workdir
// "/" for the one-time bootstrap that creates it.
func (d *Docker) ExecRoot(ctx context.Context, id string, cmd []string, env []string) (ExecResult, error) {
	return d.Exec(ctx, id, cmd, env, "/root")
}

// Exec runs a non-interactive command in workdir and returns its demuxed stdout/stderr +
// exit code. Every exec in this app runs inside a k3s node, which — unlike a normal Linux
// distro — ships no /root directory and no bash; most callers want ExecRoot instead,
// which pins workdir to "/root" (the caller is responsible for having created it so lab
// content can consistently assume it exists).
func (d *Docker) Exec(ctx context.Context, id string, cmd []string, env []string, workdir string) (ExecResult, error) {
	var created struct {
		Id string `json:"Id"`
	}
	err := d.doJSON(ctx, "POST", "/containers/"+id+"/exec", map[string]any{
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          false,
		"Cmd":          cmd,
		"Env":          withHome(env),
		"WorkingDir":   workdir,
	}, &created)
	if err != nil {
		return ExecResult{}, err
	}

	resp, err := d.do(ctx, "POST", "/exec/"+created.Id+"/start", mustJSON(map[string]any{
		"Detach": false, "Tty": false,
	}))
	if err != nil {
		return ExecResult{}, err
	}
	defer resp.Body.Close()
	stdout, stderr, err := demux(resp.Body)
	if err != nil {
		return ExecResult{}, err
	}

	var inspect struct {
		ExitCode int `json:"ExitCode"`
	}
	if err := d.doJSON(ctx, "GET", "/exec/"+created.Id+"/json", nil, &inspect); err != nil {
		return ExecResult{}, err
	}
	return ExecResult{Stdout: stdout, Stderr: stderr, ExitCode: inspect.ExitCode}, nil
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// demux splits Docker's multiplexed exec stream: an 8-byte header per frame
// ([type][000][big-endian uint32 size]), type 2 = stderr, else stdout.
func demux(r io.Reader) (stdout, stderr string, err error) {
	var outB, errB bytes.Buffer
	hdr := make([]byte, 8)
	for {
		_, err = io.ReadFull(r, hdr)
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return outB.String(), errB.String(), nil
		}
		if err != nil {
			return "", "", err
		}
		size := binary.BigEndian.Uint32(hdr[4:8])
		buf := make([]byte, size)
		if _, err = io.ReadFull(r, buf); err != nil {
			return "", "", err
		}
		if hdr[0] == 2 {
			errB.Write(buf)
		} else {
			outB.Write(buf)
		}
	}
}

/* ------------------------------------------------------------------ interactive exec (raw hijack) */

// ExecConn is a raw bidirectional stream into a running exec session (Tty:true, so the
// stream is NOT multiplexed — it's the pty's own bytes in both directions).
type ExecConn struct {
	ExecID string
	r      *bufio.Reader
	c      net.Conn
}

func (e *ExecConn) Read(p []byte) (int, error)  { return e.r.Read(p) }
func (e *ExecConn) Write(p []byte) (int, error) { return e.c.Write(p) }
func (e *ExecConn) Close() error                { return e.c.Close() }

// HijackExec starts an interactive (TTY) exec by dialing the socket raw and writing a
// hand-crafted HTTP request with `Connection: Upgrade`, then hands back the raw
// bidirectional connection. This can't go through net/http because the stdlib client
// gives no way to reclaim the underlying connection after a 101/200 upgrade — the same
// reason dbcanvas's own docker.go does this by hand rather than via http.Client.
func (d *Docker) HijackExec(ctx context.Context, id string, cmd []string, env []string) (*ExecConn, error) {
	var created struct {
		Id string `json:"Id"`
	}
	err := d.doJSON(ctx, "POST", "/containers/"+id+"/exec", map[string]any{
		"AttachStdin":  true,
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          true,
		"Cmd":          cmd,
		"Env":          withHome(env),
		"WorkingDir":   "/root",
	}, &created)
	if err != nil {
		return nil, err
	}

	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", d.sock)
	if err != nil {
		return nil, err
	}

	body := `{"Detach":false,"Tty":true}`
	req := "POST /exec/" + created.Id + "/start HTTP/1.1\r\n" +
		"Host: docker\r\n" +
		"Content-Type: application/json\r\n" +
		"Connection: Upgrade\r\n" +
		"Upgrade: tcp\r\n" +
		fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body)) + body
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, err
	}

	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil {
		conn.Close()
		return nil, err
	}
	if !strings.Contains(statusLine, " 101") && !strings.Contains(statusLine, " 200") {
		conn.Close()
		return nil, fmt.Errorf("exec start: unexpected status %q", strings.TrimSpace(statusLine))
	}
	// Drain headers up to the blank line.
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			conn.Close()
			return nil, err
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	return &ExecConn{ExecID: created.Id, r: br, c: conn}, nil
}

func (d *Docker) ResizeExec(ctx context.Context, execID string, cols, rows int) error {
	path := fmt.Sprintf("/exec/%s/resize?w=%d&h=%d", execID, cols, rows)
	resp, err := d.do(ctx, "POST", path, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

/* ------------------------------------------------------------------ file copy */

// PutArchive tars a single file's contents and copies it into the container at dir/name,
// via Docker's PUT /containers/{id}/archive — the same tar-based copy mechanism dbcanvas
// uses to stage a kubeconfig, a manifest, or an S3 identity file before a node ever runs it.
func (d *Docker) PutArchive(ctx context.Context, id, dir, name string, content []byte, mode int64) error {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	hdr := &tar.Header{Name: name, Mode: mode, Size: int64(len(content))}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if _, err := tw.Write(content); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", d.url("/containers/"+id+"/archive?path="+urlQueryEscape(dir)), &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-tar")
	resp, err := d.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errFromResp(resp)
	}
	return nil
}

/* ------------------------------------------------------------------ images */

// ImagePull pulls an image by reference (e.g. "chrislusf/seaweedfs:latest"), waiting for
// the pull stream to finish. Docker's create-image endpoint streams progress as
// newline-delimited JSON; we just drain it and surface the terminal error, if any.
func (d *Docker) ImagePull(ctx context.Context, ref string) error {
	resp, err := d.do(ctx, "POST", "/images/create?fromImage="+urlQueryEscape(ref), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errFromResp(resp)
	}
	dec := json.NewDecoder(resp.Body)
	for {
		var line struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&line); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if line.Error != "" {
			return fmt.Errorf("pulling %s: %s", ref, line.Error)
		}
	}
}

// ImageExists reports whether an image reference is already present on the daemon. Used
// for images this app expects to have been built ahead of time rather than pulled — see
// toolbox.go — so their absence can be reported as a clear instruction instead of a
// mid-provision failure.
func (d *Docker) ImageExists(ctx context.Context, ref string) bool {
	resp, err := d.do(ctx, "GET", "/images/"+ref+"/json", nil)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode < 300
}

func (d *Docker) Ping(ctx context.Context) error {
	resp, err := d.do(ctx, "GET", "/_ping", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errFromResp(resp)
	}
	return nil
}
