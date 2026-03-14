#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/path-helpers.sh"

session_label="manage-mobile-check-$$"
session_name="shell-${session_label}"
initial_title="manage-mobile-initial-$$"
renamed_title="manage-mobile-renamed-$$"
script_path="${AGENT_SESSION_HUB_SCRIPTS_DIR}/wsl-agent-mobile-menu.sh"

cleanup() {
  "$script_path" delete "$session_name" >/dev/null 2>&1 || true
  tmux kill-session -t "$session_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

tmux kill-session -t "$session_name" >/dev/null 2>&1 || true
tmux new-session -d -s "$session_name" -c "$AGENT_SESSION_HUB_WORKSPACE_ROOT"

"$script_path" rename "$session_name" "$initial_title"
"$script_path" archive "$session_name"

list_output="$("$script_path" list)"
list_all_output="$("$script_path" list-all)"
[[ "$list_output" != *"$initial_title"* ]]
[[ "$list_all_output" == *"$initial_title"* ]]
[[ "$list_all_output" == *'Running (archived)'* ]]

"$script_path" unarchive "$session_name"
list_output="$("$script_path" list)"
[[ "$list_output" == *"$initial_title"* ]]

"$script_path" rename "$session_name" "$renamed_title"
list_output="$("$script_path" list)"
[[ "$list_output" == *"$renamed_title"* ]]

"$script_path" close "$session_name"
list_all_output="$("$script_path" list-all)"
[[ "$list_all_output" == *"$renamed_title"* ]]
[[ "$list_all_output" == *'Closed'* ]]

"$script_path" delete "$session_name"
list_all_output="$("$script_path" list-all)"
[[ "$list_all_output" != *"$renamed_title"* ]]

printf 'PASS\n'
