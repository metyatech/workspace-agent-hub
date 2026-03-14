#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
session_name="${2:-}"

if [[ -z "${command_name}" ]]; then
  echo "Missing command." >&2
  exit 1
fi

if [[ -z "${session_name}" ]]; then
  echo "Missing session name." >&2
  exit 1
fi

require_session() {
  if ! tmux has-session -t "${session_name}" >/dev/null 2>&1; then
    echo "Session '${session_name}' not found." >&2
    exit 1
  fi
}

case "${command_name}" in
  output)
    require_session
    lines="${3:-400}"
    echo "__WORKSPACE_AGENT_HUB_PWD__"
    tmux display-message -p -t "${session_name}" "#{pane_current_path}"
    echo "__WORKSPACE_AGENT_HUB_TEXT_BEGIN__"
    tmux capture-pane -pt "${session_name}" -S "-${lines}"
    ;;
  send)
    require_session
    payload_path="${3:-}"
    submit_mode="${4:-submit}"
    if [[ -z "${payload_path}" || ! -f "${payload_path}" ]]; then
      echo "Payload file is required." >&2
      exit 1
    fi
    tmux load-buffer "${payload_path}"
    tmux paste-buffer -d -t "${session_name}"
    if [[ "${submit_mode}" == "submit" ]]; then
      tmux send-keys -t "${session_name}" Enter
    fi
    ;;
  interrupt)
    require_session
    tmux send-keys -t "${session_name}" C-c
    ;;
  *)
    echo "Unsupported command '${command_name}'." >&2
    exit 1
    ;;
esac
