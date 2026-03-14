#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/path-helpers.sh"

menu_session="shell-menu-runner-$$"
target_session="shell-resume-check-$$"

cleanup() {
  tmux kill-session -t "$menu_session" >/dev/null 2>&1 || true
  tmux kill-session -t "$target_session" >/dev/null 2>&1 || true
}

trap cleanup EXIT

tmux new-session -d -s "$menu_session" -c "$AGENT_SESSION_HUB_WORKSPACE_ROOT" "env AI_AGENT_SESSION_NO_ATTACH=1 '${AGENT_SESSION_HUB_SCRIPTS_DIR}/wsl-agent-mobile-menu.sh'"
tmux set-option -t "$menu_session" remain-on-exit on >/dev/null 2>&1 || true
sleep 1

tmux new-session -d -s "$target_session" -c "$AGENT_SESSION_HUB_WORKSPACE_ROOT"
sleep 1

tmux send-keys -t "$menu_session" '2' C-m
pane_output=''
for _ in $(seq 1 100); do
  pane_output="$(tmux capture-pane -pt "$menu_session" -S -200)"
  if [[ "$pane_output" == *'resume-check'* ]]; then
    break
  fi
  sleep 0.2
done
[[ "$pane_output" == *'[1] '* ]]
[[ "$pane_output" == *'resume-check'* ]]

selected_index="$(printf '%s\n' "$pane_output" | sed -n 's/^\[\([0-9]\+\)\].*resume-check.*/\1/p')"
[[ -n "${selected_index// }" ]]

tmux send-keys -t "$menu_session" "$selected_index" C-m
for _ in $(seq 1 100); do
  pane_output="$(tmux capture-pane -pt "$menu_session" -S -200)"
  if [[ "$pane_output" == *"Session ready: $target_session"* ]]; then
    break
  fi
  sleep 0.2
done

[[ "$pane_output" == *"Session ready: $target_session"* ]]

printf 'PASS\n'
