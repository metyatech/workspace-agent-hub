#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/path-helpers.sh"

temp_home="$(mktemp -d)"
temp_catalog_dir="$(mktemp -d)"
temp_catalog_path="${temp_catalog_dir}/catalog.json"
linux_only_path='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

cleanup() {
  rm -rf "$temp_home" "$temp_catalog_dir"
}

trap cleanup EXIT

fallback_output="$(
  env -i \
    HOME="$temp_home" \
    PATH="$linux_only_path" \
    "${AGENT_SESSION_HUB_SCRIPTS_DIR}/wsl-agent-mobile-menu.sh" list
)"

[[ -f "${temp_home}/.agent-handoff/session-catalog.json" ]]
[[ "$fallback_output" == *'Title'* ]]

override_output="$(
  env -i \
    HOME="$temp_home" \
    PATH="$linux_only_path" \
    AI_AGENT_SESSION_CATALOG_PATH="$temp_catalog_path" \
    "${AGENT_SESSION_HUB_SCRIPTS_DIR}/wsl-agent-mobile-menu.sh" list
)"

[[ -f "$temp_catalog_path" ]]
[[ "$override_output" == *'Title'* ]]

printf 'PASS\n'
