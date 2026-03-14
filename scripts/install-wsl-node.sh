#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  install-wsl-node.sh [node-version]

Installs Node.js from the official nodejs.org Linux x64 tarball into:
  /usr/local/lib/nodejs/current

Requires root.
Default version: v22.22.1
EOF
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'install-wsl-node.sh must run as root.\n' >&2
  exit 1
fi

version="${1:-v22.22.1}"
arch='linux-x64'
install_root='/usr/local/lib/nodejs'
archive="node-${version}-${arch}.tar.xz"
url="https://nodejs.org/dist/${version}/${archive}"

mkdir -p "$install_root" /usr/local/bin
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cd "$tmpdir"
curl -fsSLO "$url"
tar -xJf "$archive" -C "$install_root"

ln -sfn "$install_root/node-${version}-${arch}" "$install_root/current"
ln -sfn "$install_root/current/bin/node" /usr/local/bin/node
ln -sfn "$install_root/current/bin/npm" /usr/local/bin/npm
ln -sfn "$install_root/current/bin/npx" /usr/local/bin/npx

node --version
npm --version
