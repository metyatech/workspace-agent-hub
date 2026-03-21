#!/usr/bin/env bash
set -euo pipefail

session_name="${TMUX_SESSION:-}"
startup_command="${TMUX_STARTUP:-}"

if [[ -z "$session_name" || -z "$startup_command" ]]; then
  printf 'TMUX_SESSION and TMUX_STARTUP are required.\n' >&2
  exit 1
fi

for _ in $(seq 1 100); do
  attached="$(tmux display-message -p -t "$session_name" "#{session_attached}" 2>/dev/null || echo 0)"
  if [[ "$attached" -ge 1 ]]; then
    sleep 1
    tmux send-keys -t "$session_name" -l "$startup_command"
    tmux send-keys -t "$session_name" Enter
    exit 0
  fi
  sleep 0.1
done

exit 0
