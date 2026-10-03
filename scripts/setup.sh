#!/bin/bash
# Download Firecracker v1.16.1, a supported guest kernel, and the Ubuntu 24.04
# rootfs. Copy the guest programs into that rootfs.
# The v1.16 CI folder is not on the asset bucket. This is the CI drop from the
# week v1.16.1 was released. Guest kernel 6.1 is one Firecracker 1.16 supports.

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "setup runs on Linux with /dev/kvm" >&2
  exit 1
fi
if [[ ! -e /dev/kvm ]]; then
  echo "setup needs /dev/kvm" >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "setup is for x86_64" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -n bash "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/assets"
CI="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20260708-e8a198e23f48-0/x86_64"
mkdir -p "$ASSETS"

install_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    return
  fi
  echo "installing Node 22"
  apt-get update
  apt-get install -y xz-utils
  local version
  version="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | sed -n 's/.*node-v\(22\.[0-9.]*\)-linux-x64\.tar\.xz.*/\1/p' | head -1)"
  curl -fsSL "https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm /tmp/node.tar.xz
  echo "node $(node --version)"
}

download_firecracker() {
  if [[ -x "$ASSETS/firecracker" ]]; then
    return
  fi
  echo "downloading Firecracker v1.16.1"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/fc.tgz" "https://github.com/firecracker-microvm/firecracker/releases/download/v1.16.1/firecracker-v1.16.1-x86_64.tgz"
  tar -xzf "$tmp/fc.tgz" -C "$tmp"
  local binary
  binary="$(find "$tmp" -type f -name 'firecracker-v1.16.1-x86_64' | head -1)"
  install -m 755 "$binary" "$ASSETS/firecracker"
  rm -rf "$tmp"
}

download_kernel_and_rootfs() {
  if [[ ! -f "$ASSETS/vmlinux" ]]; then
    echo "downloading guest kernel"
    curl -fsSL -o "$ASSETS/vmlinux" "$CI/vmlinux-6.1.176"
  fi
  if [[ ! -f "$ASSETS/ubuntu-24.04.squashfs" ]]; then
    echo "downloading Ubuntu rootfs"
    curl -fsSL -o "$ASSETS/ubuntu-24.04.squashfs" "$CI/ubuntu-24.04.squashfs"
  fi
}

build_rootfs() {
  if [[ -f "$ASSETS/rootfs.ext4" ]]; then
    return
  fi
  echo "building rootfs.ext4"
  local tmp mib
  tmp="$(mktemp -d)"
  unsquashfs -d "$tmp/root" "$ASSETS/ubuntu-24.04.squashfs"
  mib="$(du -sm "$tmp/root" | awk '{print $1 + 512}')"
  dd if=/dev/zero of="$ASSETS/rootfs.ext4" bs=1M count="$mib" status=progress
  mkfs.ext4 -F "$ASSETS/rootfs.ext4"
  mkdir -p "$tmp/mnt"
  mount -o loop "$ASSETS/rootfs.ext4" "$tmp/mnt"
  cp -a "$tmp/root/." "$tmp/mnt/"
  umount "$tmp/mnt"
  rm -rf "$tmp"
}

install_guest_programs() {
  echo "copying guest programs into the rootfs"
  local mnt
  mnt="$(mktemp -d)"
  mount -o loop "$ASSETS/rootfs.ext4" "$mnt"
  mkdir -p "$mnt/opt/demo"
  cp "$ROOT/guest/server.py" "$ROOT/guest/agent.py" "$ROOT/guest/init" "$mnt/opt/demo/"
  chmod 755 "$mnt/opt/demo/init"
  umount "$mnt"
  rmdir "$mnt"
}

install_node
download_firecracker
download_kernel_and_rootfs
build_rootfs
install_guest_programs
echo "setup done"
