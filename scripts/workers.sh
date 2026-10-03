#!/bin/bash
# Three network namespaces. Each one has tap0 and guest address 172.16.0.2.
# The proxy reaches a guest through that namespace's veth address.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -n bash "$0" "$@"
fi

up_worker() {
  local name="$1"
  local host_ip="$2"
  local ns_ip="$3"
  local host_if="veth-${name#worker-}"

  if ip netns list | awk '{print $1}' | grep -qx "$name"; then
    ip netns pids "$name" | xargs -r kill -9 || true
    ip netns del "$name"
  fi
  ip link del "$host_if" 2>/dev/null || true

  ip netns add "$name"
  ip netns exec "$name" ip link set lo up
  ip link add "$host_if" type veth peer name veth0 netns "$name"
  ip addr add "${host_ip}/24" dev "$host_if"
  ip link set "$host_if" up
  ip netns exec "$name" ip addr add "${ns_ip}/24" dev veth0
  ip netns exec "$name" ip link set veth0 up

  ip netns exec "$name" ip tuntap add tap0 mode tap
  # The same address on every worker, so the guest's ARP entry still matches after restore.
  ip netns exec "$name" ip link set tap0 address 02:fc:00:00:00:01
  ip netns exec "$name" ip addr add 172.16.0.1/30 dev tap0
  ip netns exec "$name" ip link set tap0 up
  ip netns exec "$name" ip route add default via "$host_ip"

  ip netns exec "$name" sysctl -w net.ipv4.ip_forward=1 >/dev/null
  ip netns exec "$name" sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null
  ip netns exec "$name" sysctl -w net.ipv4.conf.veth0.rp_filter=0 >/dev/null
  ip netns exec "$name" sysctl -w net.ipv4.conf.tap0.rp_filter=0 >/dev/null
  ip netns exec "$name" iptables -t nat -A PREROUTING -i veth0 -p tcp --dport 8080 -j DNAT --to-destination 172.16.0.2:8080
  ip netns exec "$name" iptables -t nat -A PREROUTING -i veth0 -p tcp --dport 9000 -j DNAT --to-destination 172.16.0.2:9000
  ip netns exec "$name" iptables -t nat -A POSTROUTING -o tap0 -j MASQUERADE
  ip netns exec "$name" iptables -P FORWARD ACCEPT
}

down_workers() {
  local name host_if
  for name in worker-a worker-b worker-c; do
    host_if="veth-${name#worker-}"
    if ip netns list | awk '{print $1}' | grep -qx "$name"; then
      ip netns pids "$name" | xargs -r kill -9 || true
      ip netns del "$name"
    fi
    ip link del "$host_if" 2>/dev/null || true
  done
}

case "${1:-up}" in
  up)
    up_worker worker-a 10.0.1.1 10.0.1.2
    up_worker worker-b 10.0.2.1 10.0.2.2
    up_worker worker-c 10.0.3.1 10.0.3.2
    ;;
  down)
    down_workers
    ;;
  *)
    echo "use: workers.sh up|down" >&2
    exit 1
    ;;
esac
