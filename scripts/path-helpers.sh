#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${AGENT_SESSION_HUB_PATH_HELPERS_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi

export AGENT_SESSION_HUB_PATH_HELPERS_LOADED='1'
export AGENT_SESSION_HUB_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AGENT_SESSION_HUB_REPO_ROOT="$(cd "${AGENT_SESSION_HUB_SCRIPTS_DIR}/.." && pwd)"
export AGENT_SESSION_HUB_WORKSPACE_ROOT="$(cd "${AGENT_SESSION_HUB_REPO_ROOT}/.." && pwd)"
