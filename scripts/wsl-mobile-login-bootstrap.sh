#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MENU_SCRIPT="${SCRIPT_DIR}/wsl-agent-mobile-menu.sh"

usage() {
  cat <<'EOF'
Usage:
  wsl-mobile-login-bootstrap.sh
  wsl-mobile-login-bootstrap.sh --probe
  wsl-mobile-login-bootstrap.sh --help

Options:
  --probe  Print whether the mobile menu would open in the current environment.
  --help   Show this help text.
EOF
}

trim_cr() {
  tr -d '\r'
}

get_windows_env() {
  local variable_name="$1"
  local bridge_name="AI_AGENT_MOBILE_WINDOWS_${variable_name}"
  local value

  value="${!bridge_name:-}"
  if [[ -n "${value// }" ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  value="$(cmd.exe /c "echo %${variable_name}%" < /dev/null 2>/dev/null | trim_cr || true)"
  if [[ "$value" == "%${variable_name}%" ]]; then
    value=''
  fi
  printf '%s\n' "$value"
}

has_ssh_context() {
  [[ -n "${SSH_CONNECTION:-}" ]] && return 0
  [[ -n "${SSH_CLIENT:-}" ]] && return 0
  [[ -n "${SSH_TTY:-}" ]] && return 0
  [[ -n "$(get_windows_env 'SSH_CONNECTION')" ]] && return 0
  [[ -n "$(get_windows_env 'SSH_CLIENT')" ]] && return 0
  [[ -n "$(get_windows_env 'SSH_TTY')" ]] && return 0
  return 1
}

has_interactive_tty() {
  [[ -n "${AI_AGENT_MOBILE_ASSUME_TTY:-}" ]] && return 0
  [[ -t 0 ]]
}

should_open_menu() {
  command -v tmux >/dev/null 2>&1 || return 1
  has_interactive_tty || return 1
  [[ -z "${TMUX:-}" ]] || return 1
  [[ -z "${AI_AGENT_MOBILE_BYPASS:-}" ]] || return 1
  [[ -x "$MENU_SCRIPT" ]] || return 1
  has_ssh_context || return 1
}

main() {
  case "${1:-}" in
    --help|-h)
      usage
      exit 0
      ;;
    --probe)
      if should_open_menu; then
        printf 'open-menu\n'
      else
        printf 'skip-menu\n'
      fi
      exit 0
      ;;
    '')
      if should_open_menu; then
        exec "$MENU_SCRIPT"
      fi
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "${1:-}"
