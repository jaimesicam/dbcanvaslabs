# The lab toolbox

A second image, built on the host by `make toolbox`, and started as one extra sibling
container per lab attempt — alongside the three k3d nodes and SeaweedFS, on the attempt's
own Docker network. Learners get it as a terminal tab called `toolbox`.

## Why

The `rancher/k3s` node image is deliberately minimal, and the gap shows in lab content. It
has no `jq`, no `curl`, no `psql`, no `openssl` and no `yq`, so labs that want to read
`kubectl -o json`, scrape a metrics endpoint, connect to the database as a client or
inspect a certificate have been working around their absence — `grep -o
'"logger":"[^"]*"'` where `jq -r .logger` is what a learner would type at work, and `wget
-qO-` where everyone else uses `curl`.

The toolbox is where the real tools are. Three labs now teach from it — `cnpg-json-logs`
uses jq to read structured logs, `cnpg-metrics` and `cnpg-pgbouncer-metrics` use curl to
scrape endpoints — and their instructions name the tab. The other 25 still work entirely
from the node tabs.

Provisioning is still best-effort (a missing image skips the tab rather than failing the
environment), but those three labs are unplayable without it. `make up` builds the image
when the tag is missing, so the gap only opens on a native `make dev` run that never ran
`make toolbox`.

## Why an image, and not an install step

Provisioning already spends minutes building a real cluster. An `apt-get install` per
attempt would add minutes more to every lab and make provisioning depend on the learner's
network being up and fast. So the image is built once, ahead of time:

```
make toolbox        # (re)build it
make up             # builds it too, but only if the tag is missing
```

`server/toolbox.go` never builds or pulls it — it checks whether the tag exists and starts a
container from it, or logs that it is missing and carries on without a toolbox tab. The tag
is written in two places, `TOOLBOX_IMAGE`/`TOOLBOX_TAG` in the Makefile and `toolboxImage`
in `server/toolbox.go`; bump both together.

Because lab environments are siblings of the app container rather than children, the image
has to exist on the *host* daemon — which is why this is a `make` target and not a stage in
the app's own Dockerfile.

## The networking, which is the interesting part

A sibling container on the attempt's Docker bridge can reach the node containers by their
Docker addresses and nothing else. Pod addresses (`10.42.x.x`) and Service addresses
(`10.43.x.x`) have no route: those networks live *inside* the nodes, flannel between them
and kube-proxy's iptables in front of them.

Four static routes are enough to fix both, and `entrypoint.sh` installs them from
`TOOLBOX_ROUTES`:

| route | why it works |
|---|---|
| each node's own pod CIDR via that node | the owning node forwards the packet into its pod network |
| the whole service CIDR via any one node | kube-proxy DNATs the ClusterIP in that node's `PREROUTING` chain on the way through, exactly as it would for a Pod |

Verified against a real cluster: instance Pods, their `9187` metrics ports, PgBouncer's
`9127`, and every ClusterIP including kube-dns and the API server's `10.43.0.1`.

This needs `NET_ADMIN`, which the backend grants at container-create time. It is the only
capability anything in this app asks for.

`/etc/resolv.conf` is then pointed at kube-dns with the usual cluster search domains, so
`pg-cluster-rw` resolves in the toolbox the way it does in a Pod. Docker's own resolver is
kept as a second entry, so name resolution degrades to working-but-cluster-blind rather
than failing outright if CoreDNS is unreachable.

The kubeconfig is k3s's own admin config, staged at `/root/.kube/config` before the
container starts, with the server address rewritten from the node's loopback to the address
the toolbox can actually reach it on.

## Grading

`readFileAnyNode` in `server/check.go` searches the toolbox as well as the three nodes. A
learner who does the work in the toolbox tab and writes `/root/answer.txt` there is graded
on it exactly as if they had written it on a node — the same reason it searches all three
nodes in the first place.

## Adding a desktop later

The Dockerfile's CLI tooling is a stage named `cli`, and the final image is a one-line
alias of it, so a graphical layer slots in as a stage on top without disturbing anything
above. What that would take, beyond the packages:

- VNC + a desktop + a browser is roughly 1.5–2.5 GB of image and ~1–2 GB of RAM per live
  attempt, against `maxConcurrentAttempts` of 2.
- **The host cannot reach container addresses.** Measured on macOS: a `curl` from the host
  to a container IP on the lab network gets nothing, which is why k3d publishes the API
  server on a host port. So a desktop is not reachable just by existing — it needs either a
  published port per attempt, or a websocket proxy through the Go backend (the shape the
  terminal already uses) plus a noVNC panel in the player.
- If the goal is only to *look at a web UI* running in the cluster, publishing a port from
  k3d to the host is far cheaper than a desktop: the learner opens `localhost:PORT` in the
  browser they already have open, with real devtools.

## What is in it

Pinned deliberately, like everything else in this app, because labs grade real command
output that must not drift: `kubectl` tracks the k3s minor version in `server/k3d.go`, and
`kubectl-cnpg` tracks `cnpgVersion` in `server/cnpg.go`. Changing either there means
changing it here.

- `kubectl` v1.35.7 and the `cnpg` plugin v1.30.0
- `psql` 18 from PGDG, matching `cnpgPostgresImage`
- `jq`, `yq`, `curl`, `wget`, `openssl`
- `dnsutils`, `iproute2`, `iputils-ping`, `netcat-openbsd`
- `git`, `vim`, `nano`, `less`, `tree`, `unzip`, `procps`, bash completion
