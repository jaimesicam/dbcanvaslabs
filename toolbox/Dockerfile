# DBCanvas Labs — the lab toolbox image.
#
# One extra sibling container per attempt, on the attempt's Docker network alongside the
# k3d nodes: an Ubuntu box with the tools the k3s node containers do not have. The k3s
# image is deliberately minimal — no `jq`, no `curl`, no `psql`, no `openssl` — so labs
# that want to parse `-o json`, fetch a metrics endpoint properly, or connect to the
# database as a client have been working around its absence with `grep -o` and `wget -qO-`.
# This is the box where those tools exist.
#
# Built ahead of time, never at attempt time. Provisioning a lab environment already takes
# minutes of real cluster building; `apt-get install` on top of that would be minutes more,
# per attempt, and would make every lab depend on the learner's network. `make toolbox`
# builds this once and provisioning just starts a container from it — see the Makefile.
#
# Versions are pinned for the same reason everything else in this app is: labs grade real
# command output, which must not drift under them. kubectl tracks the k3s minor version
# (`k3sImage` in server/k3d.go) and the cnpg plugin tracks `cnpgVersion` in server/cnpg.go —
# changing either there means changing it here.
#
# Layering note: the CLI tooling is a separate stage from the final image on purpose. A
# graphical layer (VNC + a desktop + a browser, for labs that want to point a real browser
# at something in the cluster) slots in as a stage on top of `cli` without disturbing any
# of this — see toolbox/README.md.

FROM ubuntu:24.04 AS cli

# TARGETARCH is injected by BuildKit and by BuildKit only — the legacy builder leaves it
# unset, and `set -u` in the download steps below turned that into a hard build failure.
# So every arch-specific download falls back to the build machine's own architecture, which
# `dpkg` happens to name exactly as Go does (amd64, arm64). Nothing in this app pins a
# platform — the lab environments are whatever the host is — so the downloads follow suit,
# and an explicit buildx cross-build still wins, because TARGETARCH takes precedence.
ARG TARGETARCH

ARG KUBECTL_VERSION=v1.35.7
ARG CNPG_PLUGIN_VERSION=1.30.0
ARG YQ_VERSION=v4.53.3
ARG PG_MAJOR=18

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# Base tooling. `iproute2` is not a convenience: the entrypoint needs `ip route` to reach
# the cluster's pod and service networks at all (see entrypoint.sh).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        jq \
        gnupg \
        iproute2 \
        iputils-ping \
        dnsutils \
        netcat-openbsd \
        openssl \
        git \
        less \
        vim \
        nano \
        tree \
        unzip \
        procps \
        bash-completion \
        locales \
    && rm -rf /var/lib/apt/lists/*

# psql from PGDG rather than Ubuntu's, so the client major version matches the server the
# labs actually run (`cnpgPostgresImage` in server/cnpg.go). A mismatched psql works, but
# prints version warnings that would show up in lab transcripts.
RUN set -eux; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"; \
    rm -rf /var/lib/apt/lists/*

# kubectl, matching the k3s minor version the labs run.
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSLo /usr/local/bin/kubectl \
        "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    chmod 0755 /usr/local/bin/kubectl; \
    kubectl version --client=true

# The cnpg kubectl plugin, so `kubectl cnpg status/promote/certificate/logs` work here too
# and not only on the nodes. This is the one download whose asset names are *not* Go's: the
# CNPG release is built by goreleaser with its default naming, so 64-bit Intel is published
# as `x86_64` and `amd64` 404s. arm64 is spelled the same either way.
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in amd64) arch=x86_64 ;; esac; \
    curl -fsSL "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CNPG_PLUGIN_VERSION}/kubectl-cnpg_${CNPG_PLUGIN_VERSION}_linux_${arch}.tar.gz" \
        | tar -xz -C /usr/local/bin kubectl-cnpg; \
    chmod 0755 /usr/local/bin/kubectl-cnpg

# yq, the same argument as jq: CNPG's interesting objects are YAML.
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSLo /usr/local/bin/yq \
        "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${arch}"; \
    chmod 0755 /usr/local/bin/yq; \
    yq --version

COPY entrypoint.sh /usr/local/bin/toolbox-entrypoint
COPY bashrc /root/.bashrc
RUN chmod 0755 /usr/local/bin/toolbox-entrypoint

# The backend stages the cluster's kubeconfig here before the container starts. Docker's
# put-archive endpoint extracts *into* an existing directory and will not create one, so
# this has to exist in the image.
RUN mkdir -p /root/.kube

WORKDIR /root

# The container's job is to sit on the network and wait for `docker exec`, exactly like a
# k3d node does. The entrypoint wires up routing and DNS, then blocks forever.
ENTRYPOINT ["/usr/local/bin/toolbox-entrypoint"]

# ---------------------------------------------------------------------------------------
# The image the labs use. Kept as a trivial alias of `cli` so that adding a `desktop` stage
# later is a one-line change here rather than a restructuring.
FROM cli
