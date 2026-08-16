# dbonlinetest-server

The real backend: drives Docker directly (stdlib only, no SDK — same pattern as
`~/Projects/dbcanvas`'s own `app/docker.go`) to provision a real 3-node k3d cluster, real
MetalLB, real SeaweedFS, and the real CloudNativePG operator per lab attempt, plus a real
WebSocket terminal into it and on-demand grading that runs actual `kubectl`/`psql`
commands against the actual cluster.

It is also the *whole* deployed application: `//go:embed all:web/dist` bakes the built React
SPA into this binary, so the shipped artifact is one container serving the UI and `/api` on
one port with the host's Docker socket mounted (`Dockerfile` and `docker-compose.yml` at the
repo root — `make up`). Nothing here persists anything to disk.

## Prerequisites

Only when building/running it natively — the container image carries all of this:

- Docker running (Docker Desktop, Rancher Desktop, or a stock Engine — the socket is
  auto-detected: `$DOCKER_SOCK`, then `/var/run/docker.sock`, `~/.rd/docker.sock`,
  `~/.docker/run/docker.sock`, in that order).
- The `k3d` binary on `$PATH`, or `$K3D_BIN` pointing at one.
- Go 1.26+.

## Running

```bash
make dev              # from the repo root: this backend on :8090 + Vite on :5174
```

`make dev` compiles and runs the binary rather than `go run .`, which execs the real server
as a *child* — killing "the process" would leave it listening and orphan every lab
environment it owns.

It listens on `$APP_HOST:$APP_PORT`, defaulting to `127.0.0.1:8090` (`$PORT` still works as
a fallback for the port). Open Vite's :5174, not this port: the dev server proxies `/api`
(REST and the terminal WebSocket) here, and a natively built binary has no UI embedded —
`web/dist/index.html` is a tracked placeholder saying exactly that, replaced by the real
build inside the image.

## What one attempt actually provisions

1. A dedicated Docker network.
2. A real k3d cluster on it: 1 server + 2 agents, `servicelb`/`traefik` disabled.
3. MetalLB, installed from the upstream manifest, with an address pool carved from the
   top of the attempt's own Docker subnet.
4. A SeaweedFS container (S3-compatible object storage), which the backup and restore labs
   use for real as the Barman Cloud plugin's `ObjectStore` target.
5. A toolbox container — Ubuntu, carrying the `jq`/`curl`/`psql`/`openssl`/`yq` the minimal
   k3s node image lacks — offered as a fourth terminal tab. Best-effort: skipped, with no
   tab and no other consequence, when its image has not been built (`make toolbox`). See
   `../toolbox/README.md`.
6. The CNPG operator release tarball, staged onto the server node — applied for real
   immediately only for labs where the operator is a precondition; left staged-but-unapplied
   for the lab that's actually about installing it.
7. For the persistent-volume lab, a healthy 3-instance `Cluster` too, plus a captured
   baseline (original primary pod, its PVC's real volume name and pinned node) so grading
   can later prove something actually changed.

Every attempt is fully torn down (`k3d cluster delete`, container removal, network
removal) on `POST /api/attempts/{id}/destroy` — there is no persistence across a backend
restart; a stale `attemptId` the frontend still has just 404s and it starts a fresh one.

## Files

- `docker.go` — stdlib Docker Engine API client, including the hand-rolled raw HTTP
  hijack `HijackExec` needs (net/http can't reclaim a connection after a 101/200 upgrade).
- `k3d.go` — cluster lifecycle, node discovery, kubeconfig propagation to all 3 nodes,
  MetalLB install.
- `cnpg.go` — fetches CNPG's tagged release source and applies the manifest it ships
  (the same method CNPG's own Quickstart/e2e tests use — not Helm), Cluster manifest
  staging/apply, baseline capture.
- `seaweedfs.go` — the SeaweedFS container.
- `toolbox.go` — the toolbox container: the four static routes that give a *sibling*
  container reachability into the cluster's pod and service networks, cluster DNS, and a
  staged kubeconfig. Best-effort throughout — no lab depends on it.
- `terminal.go` — the WebSocket ↔ real-shell bridge.
- `check.go` — on-demand grading: real `kubectl`/`psql` queries per task, mechanically
  ported from the frontend's former simulated `check(world)` bodies.
- `state.go` — a lightweight cluster snapshot for the frontend's visualization panels,
  refreshed alongside each check click (not polled on an interval).
- `attempts.go` — the attempt registry, per-lab provisioning recipes, and teardown.
- `main.go` — HTTP routes, the embedded-SPA handler, and `-healthcheck` mode (the runtime
  image is distroless, so the binary is its own health probe).
- `web/dist/` — where the image build writes the SPA this binary embeds. The tracked
  `index.html` is a placeholder for native builds; the real assets are never committed.
