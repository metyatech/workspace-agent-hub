#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/path-helpers.sh"

menu_session="shell-menu-start-$$"
session_title="start-menu-check-$$"
created_session=''

cleanup() {
  tmux kill-session -t "$menu_session" >/dev/null 2>&1 || true
  if [[ -n "${created_session// }" ]]; then
    tmux kill-session -t "$created_session" >/dev/null 2>&1 || true
  fi

  SESSION_CATALOG_PATH="$(wslpath "$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')")/agent-handoff/session-catalog.json" \
  SESSION_TITLE="$session_title" \
  SESSION_NAME="$created_session" \
  node <<'NODE' >/dev/null 2>&1 || true
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionTitle = process.env.SESSION_TITLE;
const sessionName = process.env.SESSION_NAME;

if (!fs.existsSync(catalogPath)) {
  process.exit(0);
}

const raw = fs.readFileSync(catalogPath, 'utf8').trim();
const entries = raw ? JSON.parse(raw) : [];
const filtered = (Array.isArray(entries) ? entries : [entries]).filter((entry) => {
  return String(entry.title || '') !== sessionTitle && String(entry.session_name || '') !== sessionName;
});
fs.writeFileSync(catalogPath, `${JSON.stringify(filtered, null, 2)}\n`);
NODE
}

trap cleanup EXIT

tmux new-session -d -s "$menu_session" -c "$AGENT_SESSION_HUB_WORKSPACE_ROOT" "env AI_AGENT_SESSION_NO_ATTACH=1 '${AGENT_SESSION_HUB_SCRIPTS_DIR}/wsl-agent-mobile-menu.sh'"
tmux set-option -t "$menu_session" remain-on-exit on >/dev/null 2>&1 || true

wait_for_menu_text() {
  local expected_text="$1"
  local pane_output=''

  for _ in $(seq 1 100); do
    if ! tmux has-session -t "$menu_session" >/dev/null 2>&1; then
      printf 'Menu session exited before showing expected text: %s\n' "$expected_text" >&2
      return 1
    fi

    pane_output="$(tmux capture-pane -pt "$menu_session" -S -200 2>/dev/null || true)"
    if [[ "$pane_output" == *"$expected_text"* ]]; then
      printf '%s\n' "$pane_output"
      return 0
    fi

    sleep 0.2
  done

  printf 'Timed out waiting for menu text: %s\n' "$expected_text" >&2
  printf '%s\n' "$pane_output" >&2
  return 1
}

wait_for_menu_text 'Choose 1/2/3/4/5/6:' >/dev/null
tmux send-keys -t "$menu_session" '1' C-m

wait_for_menu_text 'Type (codex/claude/gemini/shell):' >/dev/null
tmux send-keys -t "$menu_session" 'shell' C-m

wait_for_menu_text 'What is this session about? (optional):' >/dev/null
tmux send-keys -t "$menu_session" "$session_title" C-m

wait_for_menu_text 'Working directory (optional, default:' >/dev/null
tmux send-keys -t "$menu_session" "$AGENT_SESSION_HUB_REPO_ROOT" C-m

pane_output="$(wait_for_menu_text 'Session ready:')"
created_session="$(printf '%s\n' "$pane_output" | sed -n 's/.*Session ready: \([^[:space:]]\+\).*/\1/p' | tail -n 1)"

[[ -n "${created_session// }" ]]
printf '%s\n' "$pane_output" | grep -q 'Session ready:'
printf '%s\n' "$pane_output" | grep -q "$session_title"

tmux display-message -p -t "$created_session" '#{pane_current_path}' | grep -qx "$AGENT_SESSION_HUB_REPO_ROOT"

SESSION_CATALOG_PATH="$(wslpath "$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')")/agent-handoff/session-catalog.json" \
SESSION_TITLE="$session_title" \
SESSION_NAME="$created_session" \
EXPECTED_WORKING_DIRECTORY_WINDOWS="$(wslpath -a -w "$AGENT_SESSION_HUB_REPO_ROOT" | tr -d '\r')" \
node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionTitle = process.env.SESSION_TITLE;
const sessionName = process.env.SESSION_NAME;
const expectedWorkingDirectoryWindows = process.env.EXPECTED_WORKING_DIRECTORY_WINDOWS;

const raw = fs.readFileSync(catalogPath, 'utf8').trim();
const entries = raw ? JSON.parse(raw) : [];
const items = Array.isArray(entries) ? entries : [entries];
const entry = items.find((item) => String(item.title || '') === sessionTitle && String(item.session_name || '') === sessionName);

if (!entry) {
  console.error(`Missing catalog entry for ${sessionTitle}`);
  process.exit(1);
}

if (String(entry.working_directory_windows || '') !== expectedWorkingDirectoryWindows) {
  console.error(`Unexpected working_directory_windows: ${entry.working_directory_windows}`);
  process.exit(1);
}
NODE

printf 'PASS\n'
