#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
session_name="${2:-}"

tmux_cmd=(tmux)
if [[ -n "${AI_AGENT_SESSION_TMUX_SOCKET_NAME:-}" ]]; then
  tmux_cmd+=(-L "${AI_AGENT_SESSION_TMUX_SOCKET_NAME}")
fi

if [[ -z "${command_name}" ]]; then
  echo "Missing command." >&2
  exit 1
fi

if [[ -z "${session_name}" ]]; then
  echo "Missing session name." >&2
  exit 1
fi

require_session() {
  if ! "${tmux_cmd[@]}" has-session -t "${session_name}" >/dev/null 2>&1; then
    echo "Session '${session_name}' not found." >&2
    exit 1
  fi
}

case "${command_name}" in
  output)
    require_session
    lines="${3:-400}"
    echo "__WORKSPACE_AGENT_HUB_PWD__"
    "${tmux_cmd[@]}" display-message -p -t "${session_name}" "#{pane_current_path}"
    echo "__WORKSPACE_AGENT_HUB_TEXT_BEGIN__"
    "${tmux_cmd[@]}" capture-pane -pt "${session_name}" -S "-${lines}"
    ;;
  send)
    require_session
    payload_path="${3:-}"
    submit_mode="${4:-submit}"
    if [[ -z "${payload_path}" || ! -f "${payload_path}" ]]; then
      echo "Payload file is required." >&2
      exit 1
    fi
    "${tmux_cmd[@]}" load-buffer "${payload_path}"
    "${tmux_cmd[@]}" paste-buffer -d -t "${session_name}"
    if [[ "${submit_mode}" == "submit" ]]; then
      "${tmux_cmd[@]}" send-keys -t "${session_name}" Enter
    fi
    ;;
  interrupt)
    require_session
    "${tmux_cmd[@]}" send-keys -t "${session_name}" C-c
    ;;
  *)
    echo "Unsupported command '${command_name}'." >&2
    exit 1
    ;;
esac
