#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/path-helpers.sh"

usage() {
  cat <<'EOF'
Usage:
  wsl-mobile-e2e-sshd.sh start [--port PORT] [--user USER] [--password PASSWORD] [--catalog-path PATH] [--auto-resume-session SESSION]
  wsl-mobile-e2e-sshd.sh stop [--port PORT] [--purge-user]
  wsl-mobile-e2e-sshd.sh status [--port PORT]
EOF
}

require_root() {
  if [[ "$(id -u)" != '0' ]]; then
    printf 'This script must run as root.\n' >&2
    exit 1
  fi
}

PORT='2223'
TEST_USER='mobilee2e'
TEST_PASSWORD='MobileE2E123'
STATE_DIR='/tmp/workspace-agent-hub-mobile-e2e'
CONFIG_PATH="$STATE_DIR/sshd_config"
PID_PATH="$STATE_DIR/sshd.pid"
LOG_PATH="$STATE_DIR/sshd.log"
LOGIN_HOOK_LOG_PATH="$STATE_DIR/login-hook.log"
TMUX_ATTACHED_FLAG_PATH="$STATE_DIR/tmux-attached.flag"
CATALOG_PATH="$STATE_DIR/session-catalog.json"
USER_CREATED_MARKER_PATH="$STATE_DIR/user-created"
PURGE_USER='0'
AUTO_RESUME_SESSION=''

parse_args() {
  ACTION="${1:-}"
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        PORT="$2"
        shift 2
        ;;
      --user)
        TEST_USER="$2"
        shift 2
        ;;
      --password)
        TEST_PASSWORD="$2"
        shift 2
        ;;
      --catalog-path)
        CATALOG_PATH="$2"
        shift 2
        ;;
      --auto-resume-session)
        AUTO_RESUME_SESSION="$2"
        shift 2
        ;;
      --purge-user)
        PURGE_USER='1'
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        printf 'Unknown argument: %s\n' "$1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done
}

ensure_dependencies() {
  command -v sshd >/dev/null 2>&1 || {
    printf 'sshd is not installed. Install openssh-server first.\n' >&2
    exit 1
  }
  command -v useradd >/dev/null 2>&1 || {
    printf 'useradd is not available.\n' >&2
    exit 1
  }
}

ensure_test_user() {
  if ! id -u "$TEST_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$TEST_USER"
    printf 'true\n' > "$USER_CREATED_MARKER_PATH"
  fi

  printf '%s:%s\n' "$TEST_USER" "$TEST_PASSWORD" | chpasswd
}

resolve_catalog_path() {
  local windows_userprofile=''
  local wsl_userprofile=''

  if [[ -n "${CATALOG_PATH// }" ]]; then
    printf '%s\n' "$CATALOG_PATH"
    return 0
  fi

  windows_userprofile="${AI_AGENT_MOBILE_WINDOWS_USERPROFILE:-}"
  if [[ -z "${windows_userprofile// }" ]]; then
    windows_userprofile="$(cmd.exe /c "echo %USERPROFILE%" < /dev/null 2>/dev/null | tr -d '\r' || true)"
  fi
  if [[ -n "${windows_userprofile// }" ]] && [[ "$windows_userprofile" != '%USERPROFILE%' ]]; then
    wsl_userprofile="$(wslpath "$windows_userprofile" 2>/dev/null || true)"
    if [[ -n "${wsl_userprofile// }" ]]; then
      printf '%s\n' "${wsl_userprofile}/agent-handoff/session-catalog.json"
      return 0
    fi
  fi

  printf '%s\n' "$STATE_DIR/session-catalog.json"
}

write_login_hook() {
  local resolved_catalog_path
  local resolved_catalog_dir
  local user_home_dir
  local bashrc_path
  local bash_profile_path

  resolved_catalog_path="$(resolve_catalog_path)"
  resolved_catalog_dir="$(dirname "$resolved_catalog_path")"
  if [[ ! -d "$resolved_catalog_dir" ]]; then
    if id -u "$TEST_USER" >/dev/null 2>&1; then
      install -d -m 700 -o "$TEST_USER" -g "$TEST_USER" "$resolved_catalog_dir"
    else
      mkdir -p "$resolved_catalog_dir"
    fi
  fi
  [[ -f "$resolved_catalog_path" ]] || printf '[]\n' > "$resolved_catalog_path"
  if id -u "$TEST_USER" >/dev/null 2>&1; then
    chown "$TEST_USER:$TEST_USER" "$resolved_catalog_path" >/dev/null 2>&1 || true
  fi

  user_home_dir="$(getent passwd "$TEST_USER" | cut -d: -f6)"
  bashrc_path="${user_home_dir}/.bashrc"
  bash_profile_path="${user_home_dir}/.bash_profile"

  cat >"$bashrc_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ -z "\${GHWS_MOBILE_E2E_MENU_ACTIVE:-}" ]]; then
  export GHWS_MOBILE_E2E_MENU_ACTIVE=1
  export AI_AGENT_SESSION_CATALOG_PATH='$resolved_catalog_path'
  if [[ -n '${AUTO_RESUME_SESSION}' ]]; then
    rm -f '$TMUX_ATTACHED_FLAG_PATH'
    tmux set-hook -t '${AUTO_RESUME_SESSION}' client-attached "run-shell 'printf attached > $TMUX_ATTACHED_FLAG_PATH'" >/dev/null 2>&1 || true
    exec '${AGENT_SESSION_HUB_SCRIPTS_DIR}/wsl-agent-mobile-menu.sh' resume '${AUTO_RESUME_SESSION}' 2>>'$LOGIN_HOOK_LOG_PATH'
  fi
  exec '${AGENT_SESSION_HUB_SCRIPTS_DIR}/wsl-agent-mobile-menu.sh' 2>>'$LOGIN_HOOK_LOG_PATH'
fi
EOF

  cat >"$bash_profile_path" <<'EOF'
#!/usr/bin/env bash
if [[ -f "$HOME/.bashrc" ]]; then
  . "$HOME/.bashrc"
fi
EOF

  chown "$TEST_USER:$TEST_USER" "$bashrc_path" "$bash_profile_path"
  chmod 644 "$bashrc_path" "$bash_profile_path"
}

write_config() {
  mkdir -p "$STATE_DIR"
  write_login_hook
  cat >"$CONFIG_PATH" <<EOF
Port $PORT
ListenAddress 0.0.0.0
Protocol 2
HostKey /etc/ssh/ssh_host_rsa_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile $PID_PATH
PasswordAuthentication yes
KbdInteractiveAuthentication yes
ChallengeResponseAuthentication no
PubkeyAuthentication yes
UsePAM yes
PermitRootLogin no
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp /usr/lib/openssh/sftp-server
LogLevel VERBOSE
EOF
}

start_sshd() {
  ensure_dependencies
  ensure_test_user
  mkdir -p /run/sshd
  write_config
  stop_sshd >/dev/null 2>&1 || true
  : > "$LOG_PATH"
  : > "$LOGIN_HOOK_LOG_PATH"
  rm -f "$TMUX_ATTACHED_FLAG_PATH"
  /usr/sbin/sshd -f "$CONFIG_PATH" -E "$LOG_PATH"
  for _ in $(seq 1 50); do
    if status_sshd >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
}

stop_sshd() {
  if [[ -f "$PID_PATH" ]]; then
    kill "$(cat "$PID_PATH")" >/dev/null 2>&1 || true
    rm -f "$PID_PATH"
  fi
  pkill -f "$CONFIG_PATH" >/dev/null 2>&1 || true

  if [[ "$PURGE_USER" == '1' ]] && [[ -f "$USER_CREATED_MARKER_PATH" ]]; then
    pkill -u "$TEST_USER" >/dev/null 2>&1 || true
    userdel -r "$TEST_USER" >/dev/null 2>&1 || true
    rm -f "$USER_CREATED_MARKER_PATH"
  fi
}

status_sshd() {
  if [[ -f "$PID_PATH" ]] && kill -0 "$(cat "$PID_PATH")" >/dev/null 2>&1; then
    printf 'running port=%s pid=%s user=%s\n' "$PORT" "$(cat "$PID_PATH")" "$TEST_USER"
    return 0
  fi

  printf 'stopped port=%s user=%s\n' "$PORT" "$TEST_USER"
  return 1
}

main() {
  parse_args "$@"
  case "$ACTION" in
    start)
      require_root
      start_sshd
      status_sshd
      ;;
    stop)
      require_root
      stop_sshd
      printf 'stopped\n'
      ;;
    status)
      require_root
      status_sshd
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
