package main

import (
	"context"
	"embed"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// main.go — HTTP routes and composition. Go 1.22+ pattern-based ServeMux, no router
// library, mirroring ~/Projects/dbcanvas's own main.go composition style.
//
// This binary is the whole application: it serves the built React SPA (embedded below)
// and the /api routes from one origin, which is what lets the shipped artifact be a
// single container with the Docker socket mounted. There is no separate web server in
// production — the Vite dev server and its /api proxy exist only for local development.

// The built SPA, baked into the binary at compile time. The image build writes Vite's
// output here (see the Dockerfile); a native `go build` finds only the tracked
// placeholder index.html, which is correct — in that mode the UI is served by Vite on
// its own port and this binary only answers /api.
//
//go:embed all:web/dist
var embeddedFS embed.FS

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func main() {
	// Health-check mode for the container HEALTHCHECK — the runtime image is distroless
	// and has no shell, curl or wget, so the binary checks itself.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck())
	}

	sock := resolveDockerSocket()
	docker := NewDocker(sock)
	if err := docker.Ping(context.Background()); err != nil {
		log.Fatalf("cannot reach Docker at %s: %v", sock, err)
	}
	log.Printf("connected to Docker at %s", sock)

	k3d := NewK3D(docker, sock)
	cnpg := NewCNPG(k3d)
	seaweed := NewSeaweedFS(docker)
	toolbox := NewToolbox(docker, k3d)
	store := NewAttemptStore(docker, k3d, cnpg, seaweed, toolbox)

	// Reclaim anything a previous run left behind before serving: the registry is in-memory,
	// so those environments are unreachable and would otherwise hold CPU and subnets forever.
	store.ReapOrphans(context.Background())

	mux := http.NewServeMux()

	// Liveness for the container HEALTHCHECK (and a quick "is the backend up?" for a
	// human). Deliberately does not touch Docker: the daemon being briefly unreachable
	// is not a reason to restart this process and lose the attempt registry.
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("POST /api/attempts", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			LabID string `json:"labId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, err)
			return
		}
		attempt, err := store.Create(body.LabID)
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		writeJSON(w, 200, attempt.view())
	})

	mux.HandleFunc("GET /api/attempts/{id}", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.Get(r.PathValue("id"))
		if !ok {
			writeErr(w, 404, errNotFound("attempt"))
			return
		}
		writeJSON(w, 200, attempt.view())
	})

	mux.HandleFunc("POST /api/attempts/{id}/destroy", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Destroy(r.PathValue("id")); err != nil {
			writeErr(w, 400, err)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "destroyed"})
	})

	mux.HandleFunc("POST /api/attempts/{id}/check", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.Get(r.PathValue("id"))
		if !ok {
			writeErr(w, 404, errNotFound("attempt"))
			return
		}
		var body struct {
			TaskID string `json:"taskId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, err)
			return
		}
		result, err := RunCheck(r.Context(), k3d, docker, attempt, body.TaskID)
		if err != nil {
			writeErr(w, 500, err)
			return
		}
		writeJSON(w, 200, result)
	})

	mux.HandleFunc("GET /api/attempts/{id}/state", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.Get(r.PathValue("id"))
		if !ok {
			writeErr(w, 404, errNotFound("attempt"))
			return
		}
		state, err := readState(r.Context(), k3d, attempt)
		if err != nil {
			writeErr(w, 500, err)
			return
		}
		writeJSON(w, 200, state)
	})

	mux.HandleFunc("GET /api/attempts/{id}/nodes/{node}/term", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.Get(r.PathValue("id"))
		if !ok {
			writeErr(w, 404, errNotFound("attempt"))
			return
		}
		nodeID := attempt.nodeIDByLabID(r.PathValue("node"))
		if nodeID == "" {
			writeErr(w, 404, errNotFound("node"))
			return
		}
		handleTerminal(docker, nodeID)(w, r)
	})

	// Anything that is not /api is the SPA. Registered last, and only as the catch-all
	// pattern, so it cannot shadow the API routes above.
	mux.Handle("/", spaHandler())

	// 127.0.0.1 by default so a native run never exposes Docker-socket-backed
	// orchestration to the network by accident; the container image overrides it to
	// 0.0.0.0 because there the publish binding in docker-compose.yml is what decides
	// who can reach it.
	host := envOr("APP_HOST", "127.0.0.1")
	port := envOr("APP_PORT", envOr("PORT", "8090"))
	addr := net.JoinHostPort(host, port)

	srv := &http.Server{
		Addr: addr,
		Handler: mux,
		// Header timeout only — the terminal route is a long-lived WebSocket, so a
		// whole-request read/write deadline would cut every shell off.
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("dbonlinetest-server listening on %s", addr)
	log.Fatal(srv.ListenAndServe())
}

// spaHandler serves the embedded build, falling back to index.html for client-side
// routes. This app routes on the hash, so the fallback mostly matters for a stray deep
// link or a stale asset URL after a rebuild.
func spaHandler() http.Handler {
	dist, err := fs.Sub(embeddedFS, "web/dist")
	if err != nil {
		log.Fatalf("locate embedded SPA: %v", err)
	}
	fileServer := http.FileServer(http.FS(dist))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := dist.Open(p); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		index, err := dist.Open("index.html")
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer index.Close()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.Copy(w, index)
	})
}

// healthcheck asks the running server for something cheap that proves the process is
// actually serving, and turns it into an exit code for Docker's HEALTHCHECK.
func healthcheck() int {
	port := envOr("APP_PORT", envOr("PORT", "8090"))
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func errNotFound(what string) error { return &notFoundError{what} }

type notFoundError struct{ what string }

func (e *notFoundError) Error() string { return e.what + " not found" }
