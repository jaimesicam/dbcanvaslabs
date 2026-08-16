#!/bin/bash
# Wire the toolbox into the lab cluster's networks, then block.
#
# The toolbox is a *sibling* of the k3d node containers on the attempt's Docker bridge, not
# a member of the Kubernetes cluster. So out of the box it can reach the nodes by their
# Docker addresses and nothing else: a Pod address (10.42.x.x) or a Service address
# (10.43.x.x) has no route, because those networks live inside the nodes — flannel between
# them, kube-proxy's iptables in front of them.
#
# Four static routes fix that, and they are enough: each node's own pod CIDR via that node,
# and the whole service CIDR via any one node. Traffic to a Pod is forwarded by the node
# that owns it; traffic to a ClusterIP is DNAT'd by kube-proxy in that node's PREROUTING
# chain on the way through, exactly as it would be for a Pod. Verified against a real
# cluster: with these routes a sibling container reaches instance Pods, their metrics ports,
# every ClusterIP including kube-dns and the API server's 10.43.0.1.
#
# Requires NET_ADMIN, which the backend grants at container-create time. Everything here is
# best-effort and non-fatal — a toolbox with no routes is still a usable shell, and failing
# to start it would take the whole lab environment down with it.

set -u

log() { echo "toolbox: $*" >&2; }

# TOOLBOX_ROUTES is a space-separated list of CIDR=GATEWAY pairs, built by the backend from
# the live cluster (each node's .spec.podCIDR, plus the service CIDR).
for pair in ${TOOLBOX_ROUTES:-}; do
    cidr="${pair%%=*}"
    gw="${pair##*=}"
    if [ -n "$cidr" ] && [ -n "$gw" ] && [ "$cidr" != "$gw" ]; then
        ip route replace "$cidr" via "$gw" 2>/dev/null \
            || log "could not add route $cidr via $gw (is NET_ADMIN granted?)"
    fi
done

# Resolve Service names the way a Pod does. CoreDNS is listed first and Docker's own
# embedded resolver second: CoreDNS forwards anything it does not own upstream, so this
# order gives both `pg-cluster-rw` and the public internet, and still degrades to
# working-but-cluster-blind if CoreDNS is unreachable.
if [ -n "${TOOLBOX_DNS:-}" ]; then
    {
        echo "nameserver ${TOOLBOX_DNS}"
        echo "nameserver 127.0.0.11"
        echo "search ${TOOLBOX_SEARCH:-default.svc.cluster.local svc.cluster.local cluster.local}"
        echo "options ndots:5"
    } > /etc/resolv.conf 2>/dev/null || log "could not rewrite /etc/resolv.conf"
fi

log "ready"

# Same shape as a k3d node container: alive, doing nothing, waiting to be exec'd into.
exec sleep infinity
