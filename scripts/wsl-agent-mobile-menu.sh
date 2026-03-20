#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/path-helpers.sh"

declare -A STARTUP_COMMANDS=(
  [codex]="${HOME}/.local/bin/codex"
  [claude]="${HOME}/.local/bin/claude"
  [gemini]="${HOME}/.local/bin/gemini"
  [shell]=''
)

declare -A HEALTHCHECK_COMMANDS=(
  [codex]="${HOME}/.local/bin/codex --version"
  [claude]="${HOME}/.local/bin/claude --version"
  [gemini]="${HOME}/.local/bin/gemini --version"
  [shell]=''
)

DEFAULT_WORKSPACE_ROOT="$AGENT_SESSION_HUB_WORKSPACE_ROOT"
SESSION_FIELD_DELIM=$'\x1f'

trim_cr() {
  tr -d '\r'
}

get_windows_env() {
  local variable_name="$1"
  local value

  value="$(cmd.exe /c "echo %${variable_name}%" < /dev/null 2>/dev/null | trim_cr || true)"
  if [[ "$value" == "%${variable_name}%" ]]; then
    value=''
  fi
  printf '%s\n' "$value"
}

resolve_session_catalog_path() {
  local override="${AI_AGENT_SESSION_CATALOG_PATH:-}"
  local windows_userprofile=''
  local wsl_userprofile=''

  if [[ -n "${override// }" ]]; then
    printf '%s\n' "$override"
    return 0
  fi

  windows_userprofile="$(get_windows_env 'USERPROFILE')"
  if [[ -n "${windows_userprofile// }" ]]; then
    wsl_userprofile="$(wslpath "$windows_userprofile" 2>/dev/null || true)"
    if [[ -n "${wsl_userprofile// }" ]]; then
      printf '%s\n' "${wsl_userprofile}/agent-handoff/session-catalog.json"
      return 0
    fi
  fi

  printf '%s\n' "${HOME}/.agent-handoff/session-catalog.json"
}

SESSION_CATALOG_PATH="$(resolve_session_catalog_path)"

no_attach_requested() {
  [[ -n "${AI_AGENT_SESSION_NO_ATTACH:-}" ]] && return 0
  [[ -n "$(get_windows_env 'AI_AGENT_SESSION_NO_ATTACH')" ]] && return 0
  return 1
}

usage() {
  cat <<'EOF'
Usage:
  wsl-agent-mobile-menu.sh
  wsl-agent-mobile-menu.sh menu
  wsl-agent-mobile-menu.sh list
  wsl-agent-mobile-menu.sh list-all
  wsl-agent-mobile-menu.sh start <codex|claude|gemini|shell> [title...]
  wsl-agent-mobile-menu.sh resume <session-name>
  wsl-agent-mobile-menu.sh rename <session-name> <title...>
  wsl-agent-mobile-menu.sh archive <session-name>
  wsl-agent-mobile-menu.sh unarchive <session-name>
  wsl-agent-mobile-menu.sh close <session-name>
  wsl-agent-mobile-menu.sh delete <session-name>
  wsl-agent-mobile-menu.sh manage [session-name]
  wsl-agent-mobile-menu.sh shell
  wsl-agent-mobile-menu.sh --help
EOF
}

normalize_label() {
  local value="$1"
  local safe
  safe="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "$safe" ]]; then
    printf 'Session name is empty after normalization.\n' >&2
    return 1
  fi
  printf '%s\n' "$safe"
}

ensure_session_catalog_file() {
  local catalog_dir
  catalog_dir="$(dirname "$SESSION_CATALOG_PATH")"
  mkdir -p "$catalog_dir"
  [[ -f "$SESSION_CATALOG_PATH" ]] || printf '[]\n' > "$SESSION_CATALOG_PATH"
}

upsert_session_catalog_entry() {
  local session_name="$1"
  local session_type="$2"
  local session_title="${3:-}"
  local working_directory_windows="${4:-}"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  SESSION_TYPE="$session_type" \
  SESSION_TITLE="$session_title" \
  WORKING_DIRECTORY_WINDOWS="$working_directory_windows" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;
const sessionType = process.env.SESSION_TYPE;
const sessionTitle = (process.env.SESSION_TITLE || '').trim();
const workingDirectoryWindows = (process.env.WORKING_DIRECTORY_WINDOWS || '').trim();
const nowUtc = new Date().toISOString();

let entries = [];
try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  }
} catch (error) {
  entries = [];
}

const existingIndex = entries.findIndex((entry) => String(entry.session_name) === sessionName);
if (existingIndex >= 0) {
  const entry = { ...entries[existingIndex], session_type: sessionType, updated_utc: nowUtc };
  if (sessionTitle) {
    entry.title = sessionTitle;
  }
  if (workingDirectoryWindows) {
    entry.working_directory_windows = workingDirectoryWindows;
  }
  delete entry.closed_utc;
  if (typeof entry.archived !== 'boolean') {
    entry.archived = false;
  }
  entries[existingIndex] = entry;
} else {
  entries.push({
    session_name: sessionName,
    session_type: sessionType,
    title: sessionTitle,
    working_directory_windows: workingDirectoryWindows,
    archived: false,
    created_utc: nowUtc,
    updated_utc: nowUtc,
  });
}

fs.writeFileSync(catalogPath, `${JSON.stringify(entries, null, 2)}\n`);
NODE
}

set_session_catalog_title() {
  local session_name="$1"
  local session_type="$2"
  local session_title="${3:-}"
  local working_directory_windows="${4:-}"

  upsert_session_catalog_entry "$session_name" "$session_type" "$session_title" "$working_directory_windows"
}

set_session_catalog_archived_state() {
  local session_name="$1"
  local session_type="$2"
  local archived="$3"
  local session_title="${4:-}"
  local working_directory_windows="${5:-}"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  SESSION_TYPE="$session_type" \
  SESSION_ARCHIVED="$archived" \
  SESSION_TITLE="$session_title" \
  WORKING_DIRECTORY_WINDOWS="$working_directory_windows" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;
const sessionType = process.env.SESSION_TYPE;
const archived = String(process.env.SESSION_ARCHIVED || '').toLowerCase() === 'true';
const sessionTitle = (process.env.SESSION_TITLE || '').trim();
const workingDirectoryWindows = (process.env.WORKING_DIRECTORY_WINDOWS || '').trim();
const nowUtc = new Date().toISOString();

let entries = [];
try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  }
} catch (error) {
  entries = [];
}

const existingIndex = entries.findIndex((entry) => String(entry.session_name) === sessionName);
if (existingIndex >= 0) {
  const entry = { ...entries[existingIndex], session_type: sessionType, archived, updated_utc: nowUtc };
  if (sessionTitle) {
    entry.title = sessionTitle;
  }
  if (workingDirectoryWindows) {
    entry.working_directory_windows = workingDirectoryWindows;
  }
  entries[existingIndex] = entry;
} else {
  entries.push({
    session_name: sessionName,
    session_type: sessionType,
    title: sessionTitle,
    working_directory_windows: workingDirectoryWindows,
    archived,
    created_utc: nowUtc,
    updated_utc: nowUtc,
  });
}

fs.writeFileSync(catalogPath, `${JSON.stringify(entries, null, 2)}\n`);
NODE
}

set_session_catalog_closed_state() {
  local session_name="$1"
  local session_type="$2"
  local closed="$3"
  local session_title="${4:-}"
  local working_directory_windows="${5:-}"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  SESSION_TYPE="$session_type" \
  SESSION_CLOSED="$closed" \
  SESSION_TITLE="$session_title" \
  WORKING_DIRECTORY_WINDOWS="$working_directory_windows" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;
const sessionType = process.env.SESSION_TYPE;
const closed = String(process.env.SESSION_CLOSED || '').toLowerCase() === 'true';
const sessionTitle = (process.env.SESSION_TITLE || '').trim();
const workingDirectoryWindows = (process.env.WORKING_DIRECTORY_WINDOWS || '').trim();
const nowUtc = new Date().toISOString();

let entries = [];
try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  }
} catch (error) {
  entries = [];
}

const existingIndex = entries.findIndex((entry) => String(entry.session_name) === sessionName);
let entry;
if (existingIndex >= 0) {
  entry = { ...entries[existingIndex] };
} else {
  entry = {
    session_name: sessionName,
    session_type: sessionType,
    title: '',
    working_directory_windows: '',
    archived: false,
    created_utc: nowUtc,
    updated_utc: nowUtc,
  };
  entries.push(entry);
}

entry.session_type = sessionType;
if (sessionTitle) {
  entry.title = sessionTitle;
}
if (workingDirectoryWindows) {
  entry.working_directory_windows = workingDirectoryWindows;
}
if (closed) {
  entry.closed_utc = nowUtc;
  entry.archived = true;
} else {
  delete entry.closed_utc;
}
entry.updated_utc = nowUtc;

if (existingIndex >= 0) {
  entries[existingIndex] = entry;
} else {
  entries[entries.length - 1] = entry;
}

fs.writeFileSync(catalogPath, `${JSON.stringify(entries, null, 2)}\n`);
NODE
}

remove_session_catalog_entry() {
  local session_name="$1"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;

let entries = [];
try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  }
} catch (error) {
  entries = [];
}

const filtered = entries.filter((entry) => String(entry.session_name) !== sessionName);
fs.writeFileSync(catalogPath, `${JSON.stringify(filtered, null, 2)}\n`);
NODE
}

list_session_catalog_entries() {
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;

try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (!raw) {
    process.exit(0);
  }

  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    const fields = [
      String(entry.session_name || ''),
      String(entry.session_type || ''),
      String(entry.title || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' '),
      String(entry.working_directory_windows || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' '),
      entry.archived ? 'true' : 'false',
      String(entry.closed_utc || ''),
      String(entry.created_utc || ''),
      String(entry.updated_utc || ''),
    ];
    process.stdout.write(`${fields.join('\u001f')}\n`);
  }
} catch (error) {
  process.exit(0);
}
NODE
}

get_session_title_from_catalog() {
  local session_name="$1"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;

try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (!raw) {
    process.exit(0);
  }

  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const entry = entries.find((item) => String(item.session_name) === sessionName);
  if (entry && typeof entry.title === 'string' && entry.title.trim()) {
    process.stdout.write(entry.title.trim());
  }
} catch (error) {
  process.exit(0);
}
NODE
}

get_working_directory_from_catalog() {
  local session_name="$1"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;

try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (!raw) {
    process.exit(0);
  }

  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const entry = entries.find((item) => String(item.session_name) === sessionName);
  if (entry && typeof entry.working_directory_windows === 'string' && entry.working_directory_windows.trim()) {
    process.stdout.write(entry.working_directory_windows.trim());
  }
} catch (error) {
  process.exit(0);
}
NODE
}

get_archived_state_from_catalog() {
  local session_name="$1"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;

try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (!raw) {
    process.stdout.write('false');
    process.exit(0);
  }

  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const entry = entries.find((item) => String(item.session_name) === sessionName);
  process.stdout.write(entry && entry.archived ? 'true' : 'false');
} catch (error) {
  process.stdout.write('false');
}
NODE
}

get_closed_utc_from_catalog() {
  local session_name="$1"
  ensure_session_catalog_file

  SESSION_CATALOG_PATH="$SESSION_CATALOG_PATH" \
  SESSION_NAME="$session_name" \
  node <<'NODE'
const fs = require('fs');

const catalogPath = process.env.SESSION_CATALOG_PATH;
const sessionName = process.env.SESSION_NAME;

try {
  const raw = fs.readFileSync(catalogPath, 'utf8').trim();
  if (!raw) {
    process.exit(0);
  }

  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const entry = entries.find((item) => String(item.session_name) === sessionName);
  if (entry && typeof entry.closed_utc === 'string' && entry.closed_utc.trim()) {
    process.stdout.write(entry.closed_utc.trim());
  }
} catch (error) {
  process.exit(0);
}
NODE
}

flatten_text() {
  local value="${1:-}"
  printf '%s' "$value" | tr '\t\r\n' '   '
}

new_auto_session_label() {
  printf 'auto-%s-%s\n' "$(date '+%Y%m%d-%H%M%S')" "$(cut -c1-4 /proc/sys/kernel/random/uuid)"
}

pretty_agent_label() {
  local session_type="$1"
  case "$session_type" in
    codex) printf 'Codex' ;;
    claude) printf 'Claude' ;;
    gemini) printf 'Gemini' ;;
    shell) printf 'Shell' ;;
    *) printf 'Session' ;;
  esac
}

resolve_working_directory() {
  local input_path="${1:-}"
  local resolved_path

  if [[ -n "${input_path// }" ]]; then
    resolved_path="$(realpath -m "$input_path")"
  else
    resolved_path="$DEFAULT_WORKSPACE_ROOT"
  fi

  [[ -d "$resolved_path" ]] || {
    printf 'Working directory not found: %s\n' "$resolved_path" >&2
    return 1
  }

  printf '%s\n' "$resolved_path"
}

convert_wsl_to_windows_path() {
  local wsl_path="$1"
  wslpath -a -w "$wsl_path" | tr -d '\r'
}

get_session_working_directory_windows() {
  local session_name="$1"
  local catalog_directory pane_directory

  catalog_directory="$(get_working_directory_from_catalog "$session_name")"
  if [[ -n "${catalog_directory// }" ]]; then
    printf '%s\n' "$catalog_directory"
    return 0
  fi

  pane_directory="$(tmux display-message -p -t "$session_name" '#{pane_current_path}' 2>/dev/null || true)"
  if [[ -n "${pane_directory// }" ]]; then
    convert_wsl_to_windows_path "$pane_directory"
  fi
}

format_local_timestamp() {
  local epoch_seconds="$1"
  if [[ -z "$epoch_seconds" || ! "$epoch_seconds" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  date -d "@$epoch_seconds" '+%Y-%m-%d %H:%M'
}

catalog_timestamp_to_unix() {
  local utc_text="${1:-}"
  [[ -n "${utc_text// }" ]] || {
    printf '0\n'
    return 0
  }

  date -d "$utc_text" '+%s' 2>/dev/null || printf '0\n'
}

format_catalog_timestamp_local() {
  local utc_text="${1:-}"
  [[ -n "${utc_text// }" ]] || return 0

  date -d "$utc_text" '+%Y-%m-%d %H:%M' 2>/dev/null || true
}

get_session_state_label() {
  local is_live="$1"
  local archived="$2"
  local closed_utc="${3:-}"

  if [[ "$is_live" == 'true' ]]; then
    if [[ "$archived" == 'true' ]]; then
      printf 'Running (archived)\n'
    else
      printf 'Running\n'
    fi
    return 0
  fi

  local base_state='Saved'
  if [[ -n "${closed_utc// }" ]]; then
    base_state='Closed'
  fi

  if [[ "$archived" == 'true' ]]; then
    printf '%s (archived)\n' "$base_state"
  else
    printf '%s\n' "$base_state"
  fi
}

get_session_preview_text() {
  local session_name="$1"
  tmux capture-pane -pt "$session_name" -S -40 2>/dev/null | awk 'BEGIN { line = ""; found = 0 } NF { line = $0; found = 1 } END { if (found) print line }'
}

preview_is_meaningful() {
  local preview_text="$1"
  [[ -n "${preview_text// }" ]] || return 1
  [[ "$preview_text" =~ ^[^[:space:]@]+@[^:]+:.*[\$\#]$ ]] && return 1
  return 0
}

get_display_title() {
  local session_name="$1"
  local session_type="$2"
  local session_label="$3"
  local created_unix="$4"
  local preview_text="$5"
  local catalog_title agent_label

  catalog_title="$(get_session_title_from_catalog "$session_name")"
  if [[ -n "${catalog_title// }" ]]; then
    printf '%s\n' "$catalog_title"
    return 0
  fi

  if [[ -n "${session_label// }" && ! "$session_label" =~ ^auto- ]]; then
    printf '%s\n' "$session_label"
    return 0
  fi

  if preview_is_meaningful "$preview_text"; then
    printf '%s\n' "$preview_text"
    return 0
  fi

  agent_label="$(pretty_agent_label "$session_type")"
  printf '%s %s\n' "$agent_label" "$(format_local_timestamp "$created_unix")"
}

split_session_name() {
  local name="$1"
  if [[ "$name" =~ ^(codex|claude|gemini|shell)-(.+)$ ]]; then
    printf '%s|%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi

  printf 'unknown|%s\n' "$name"
}

build_session_inventory() {
  local include_catalog_only="${1:-0}"
  local include_archived="${2:-0}"
  local -A seen=()
  local line session_name created attached windows activity split type label preview_text display_title folder_text activity_local archived closed_utc state activity_unix created_info

  while IFS='|' read -r session_name created attached windows activity; do
    [[ -n "$session_name" ]] || continue
    split="$(split_session_name "$session_name")"
    type="${split%%|*}"
    label="${split#*|}"
    preview_text="$(flatten_text "$(get_session_preview_text "$session_name")")"
    display_title="$(flatten_text "$(get_display_title "$session_name" "$type" "$label" "$created" "$preview_text")")"
    folder_text="$(flatten_text "$(get_session_working_directory_windows "$session_name")")"
    activity_local="$(format_local_timestamp "$activity")"
    archived="$(get_archived_state_from_catalog "$session_name")"
    closed_utc="$(get_closed_utc_from_catalog "$session_name")"
    state="$(get_session_state_label 'true' "$archived" "$closed_utc")"
    if [[ "$include_archived" != '1' && "$archived" == 'true' ]]; then
      seen["$session_name"]=1
      continue
    fi
    printf '%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n' \
      "$session_name" "$SESSION_FIELD_DELIM" "$type" "$SESSION_FIELD_DELIM" "$label" "$SESSION_FIELD_DELIM" "$(flatten_text "$(get_session_title_from_catalog "$session_name")")" "$SESSION_FIELD_DELIM" \
      "$folder_text" "$SESSION_FIELD_DELIM" "$preview_text" "$SESSION_FIELD_DELIM" "$attached" "$SESSION_FIELD_DELIM" "$windows" "$SESSION_FIELD_DELIM" "$activity" "$SESSION_FIELD_DELIM" "$activity_local" "$SESSION_FIELD_DELIM" "$archived" "$SESSION_FIELD_DELIM" 'true' "$SESSION_FIELD_DELIM" "$closed_utc" "$SESSION_FIELD_DELIM" "$state"
    seen["$session_name"]=1
  done < <(tmux list-sessions -F '#{session_name}|#{session_created}|#{session_attached}|#{session_windows}|#{session_activity}' 2>/dev/null | sort -t '|' -k5,5nr)

  if [[ "$include_catalog_only" == '1' ]]; then
    while IFS="$SESSION_FIELD_DELIM" read -r session_name type title folder_text archived closed_utc created_utc updated_utc; do
      [[ -n "$session_name" ]] || continue
      [[ -n "${seen[$session_name]+x}" ]] && continue
      if [[ "$include_archived" != '1' && "$archived" == 'true' ]]; then
        continue
      fi
      split="$(split_session_name "$session_name")"
      label="${split#*|}"
      activity_unix="$(catalog_timestamp_to_unix "${closed_utc:-$updated_utc}")"
      activity_local="$(format_catalog_timestamp_local "${closed_utc:-$updated_utc}")"
      created_info="$(catalog_timestamp_to_unix "$created_utc")"
      display_title="$(flatten_text "$(get_display_title "$session_name" "$type" "$label" "$created_info" '')")"
      state="$(get_session_state_label 'false' "$archived" "$closed_utc")"
      printf '%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n' \
        "$session_name" "$SESSION_FIELD_DELIM" "$type" "$SESSION_FIELD_DELIM" "$label" "$SESSION_FIELD_DELIM" "$(flatten_text "$title")" "$SESSION_FIELD_DELIM" \
        "$(flatten_text "$folder_text")" "$SESSION_FIELD_DELIM" '' "$SESSION_FIELD_DELIM" '0' "$SESSION_FIELD_DELIM" '0' "$SESSION_FIELD_DELIM" "$activity_unix" "$SESSION_FIELD_DELIM" "$activity_local" "$SESSION_FIELD_DELIM" "$archived" "$SESSION_FIELD_DELIM" 'false' "$SESSION_FIELD_DELIM" "$closed_utc" "$SESSION_FIELD_DELIM" "$state"
    done < <(list_session_catalog_entries)
  fi
}

get_session_inventory_row() {
  local target_session_name="$1"
  local line
  local session_name

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS="$SESSION_FIELD_DELIM" read -r session_name _ <<<"$line"
    if [[ "$session_name" == "$target_session_name" ]]; then
      printf '%s\n' "$line"
      return 0
    fi
  done < <(build_session_inventory 1 1)

  return 1
}

get_inventory_row_session_name() {
  local row="$1"
  local session_name
  IFS="$SESSION_FIELD_DELIM" read -r session_name _ <<<"$row"
  printf '%s\n' "$session_name"
}

command_is_healthy() {
  local command_text="$1"
  if [[ -z "$command_text" ]]; then
    return 1
  fi

  bash -lc "$command_text" >/dev/null 2>&1
}

ensure_tmux_defaults() {
  tmux set-option -g mouse on >/dev/null 2>&1 || true
  tmux set-option -g history-limit 200000 >/dev/null 2>&1 || true
}

schedule_startup_on_attach() {
  local session_name="$1"
  local startup_command="$2"
  TMUX_SESSION="$session_name" TMUX_STARTUP="$startup_command" bash -lc '
    for _ in $(seq 1 100); do
      attached=$(tmux display-message -p -t "$TMUX_SESSION" "#{session_attached}" 2>/dev/null || echo 0)
      if [[ "$attached" -ge 1 ]]; then
        sleep 1
        tmux send-keys -t "$TMUX_SESSION" "$TMUX_STARTUP" C-m
        exit 0
      fi
      sleep 0.1
    done
  ' >/dev/null 2>&1 &
}

ensure_session_and_attach() {
  local session_type="$1"
  local session_label="$2"
  local session_title="${3:-}"
  local working_directory_input="${4:-}"
  local safe_label session_name startup healthcheck created_new working_directory working_directory_windows
  safe_label="$(normalize_label "$session_label")"
  session_name="${session_type}-${safe_label}"
  created_new=0
  working_directory="$(resolve_working_directory "$working_directory_input")"
  working_directory_windows="$(convert_wsl_to_windows_path "$working_directory")"

  if ! tmux has-session -t "$session_name" >/dev/null 2>&1; then
    tmux new-session -d -s "$session_name" -c "$working_directory"
    created_new=1
  fi

  if [[ "$created_new" -eq 1 ]]; then
    startup="${STARTUP_COMMANDS[$session_type]}"
    healthcheck="${HEALTHCHECK_COMMANDS[$session_type]}"
    upsert_session_catalog_entry "$session_name" "$session_type" "$session_title" "$working_directory_windows"
    if [[ -n "$startup" ]] && command_is_healthy "$healthcheck"; then
      if ! no_attach_requested; then
        schedule_startup_on_attach "$session_name" "$startup"
      fi
    elif [[ -n "$startup" ]]; then
      printf '%s startup is not runnable in WSL. Opening plain shell session instead.\n' "$session_type"
    fi
  elif [[ -n "${session_title// }" ]]; then
    upsert_session_catalog_entry "$session_name" "$session_type" "$session_title" "$working_directory_windows"
  fi

  if no_attach_requested; then
    printf 'Session ready: %s\n' "$session_name"
    return 0
  fi

  tmux attach-session -t "$session_name"
}

attach_existing_session() {
  local session_name="$1"
  tmux has-session -t "$session_name" >/dev/null 2>&1 || {
    printf 'Session not found: %s\n' "$session_name" >&2
    return 1
  }
  if no_attach_requested; then
    printf 'Session ready: %s\n' "$session_name"
    return 0
  fi
  tmux attach-session -t "$session_name"
}

list_sessions() {
  local include_archived="${1:-0}"
  local include_catalog_only="${2:-0}"
  local line session_name type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state display_title
  ensure_session_catalog_file
  printf '%-24s %-8s %-20s %-26s %-28s %-8s %s\n' 'Title' 'Type' 'State' 'Folder' 'Preview' 'Attached' 'Last Activity'
  while IFS="$SESSION_FIELD_DELIM" read -r session_name type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state; do
    [[ -n "$session_name" ]] || continue
    display_title="$(get_display_title "$session_name" "$type" "$label" "$(catalog_timestamp_to_unix "$closed_utc")" "$preview_text")"
    if [[ -n "${title// }" ]]; then
      display_title="$title"
    fi
    printf '%-24s %-8s %-20s %-26s %-28s %-8s %s\n' \
      "$(flatten_text "$display_title")" "$type" "$state" "$(flatten_text "$folder_text")" "$(flatten_text "$preview_text")" "$attached" "$activity_local"
  done < <(build_session_inventory "$include_catalog_only" "$include_archived" | sort -t "$SESSION_FIELD_DELIM" -k9,9nr)
}

choose_agent_type() {
  local choice
  while true; do
    read -r -p 'Type (codex/claude/gemini/shell): ' choice
    case "$choice" in
      codex|claude|gemini|shell)
        printf '%s\n' "$choice"
        return 0
        ;;
      *)
        printf 'Invalid type.\n'
        ;;
    esac
  done
}

choose_existing_session() {
  SELECTED_SESSION_NAME=''
  local -a rows=()
  local index=1
  local line session_name type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state display_title

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    rows+=("$line")
  done < <(build_session_inventory 0 0 | sort -t "$SESSION_FIELD_DELIM" -k9,9nr)

  if [[ "${#rows[@]}" -eq 0 ]]; then
    printf 'No tmux sessions found.\n' >&2
    return 1
  fi

  for line in "${rows[@]}"; do
    IFS="$SESSION_FIELD_DELIM" read -r session_name type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state <<<"$line"
    display_title="$title"
    if [[ -z "${display_title// }" ]]; then
      display_title="$(get_display_title "$session_name" "$type" "$label" "$activity_unix" "$preview_text")"
    fi
    printf '[%d] %s  type=%s  folder=%s  preview=%s  attached=%s  windows=%s  activity=%s\n' "$index" "$display_title" "$type" "$folder_text" "$preview_text" "$attached" "$windows" "$activity_local"
    index=$((index + 1))
  done

  while true; do
    local selected
    read -r -p 'Select session number: ' selected
    if [[ "$selected" =~ ^[0-9]+$ ]] && (( selected >= 1 && selected <= ${#rows[@]} )); then
      SELECTED_SESSION_NAME="$(get_inventory_row_session_name "${rows[$((selected - 1))]}")"
      return 0
    fi
    printf 'Invalid number.\n'
  done
}

choose_any_session() {
  SELECTED_SESSION_NAME=''
  local -a rows=()
  local index=1
  local line session_name type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state display_title

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    rows+=("$line")
  done < <(build_session_inventory 1 1 | sort -t "$SESSION_FIELD_DELIM" -k9,9nr)

  if [[ "${#rows[@]}" -eq 0 ]]; then
    printf 'No sessions found.\n' >&2
    return 1
  fi

  for line in "${rows[@]}"; do
    IFS="$SESSION_FIELD_DELIM" read -r session_name type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state <<<"$line"
    display_title="$title"
    if [[ -z "${display_title// }" ]]; then
      display_title="$(get_display_title "$session_name" "$type" "$label" "$activity_unix" "$preview_text")"
    fi
    printf '[%d] %s  type=%s  state=%s  folder=%s\n' "$index" "$display_title" "$type" "$state" "$folder_text"
    index=$((index + 1))
  done

  while true; do
    local selected
    read -r -p 'Select session number: ' selected
    if [[ "$selected" =~ ^[0-9]+$ ]] && (( selected >= 1 && selected <= ${#rows[@]} )); then
      SELECTED_SESSION_NAME="$(get_inventory_row_session_name "${rows[$((selected - 1))]}")"
      return 0
    fi
    printf 'Invalid number.\n'
  done
}

rename_session() {
  local session_name="$1"
  local new_title="${2:-}"
  [[ -n "${new_title// }" ]] || {
    printf 'Title is required.\n' >&2
    return 1
  }

  local row type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state
  row="$(get_session_inventory_row "$session_name")" || {
    printf 'Session not found: %s\n' "$session_name" >&2
    return 1
  }
  IFS="$SESSION_FIELD_DELIM" read -r _ type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state <<<"$row"
  set_session_catalog_title "$session_name" "$type" "$new_title" "$folder_text"
}

set_session_archived_state() {
  local session_name="$1"
  local archived_target="$2"
  local row type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state
  row="$(get_session_inventory_row "$session_name")" || {
    printf 'Session not found: %s\n' "$session_name" >&2
    return 1
  }
  IFS="$SESSION_FIELD_DELIM" read -r _ type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state <<<"$row"
  set_session_catalog_archived_state "$session_name" "$type" "$archived_target" "$title" "$folder_text"
}

close_session() {
  local session_name="$1"
  local row type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state
  row="$(get_session_inventory_row "$session_name")" || {
    printf 'Session not found: %s\n' "$session_name" >&2
    return 1
  }
  IFS="$SESSION_FIELD_DELIM" read -r _ type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state <<<"$row"
  if [[ "$is_live" == 'true' ]]; then
    tmux kill-session -t "$session_name" >/dev/null 2>&1 || true
  fi
  set_session_catalog_closed_state "$session_name" "$type" 'true' "$title" "$folder_text"
}

delete_session() {
  local session_name="$1"
  local row is_live
  row="$(get_session_inventory_row "$session_name" 2>/dev/null || true)"
  if [[ -n "${row// }" ]]; then
    IFS="$SESSION_FIELD_DELIM" read -r _ _ _ _ _ _ _ _ _ _ _ is_live _ _ <<<"$row"
    if [[ "$is_live" == 'true' ]]; then
      tmux kill-session -t "$session_name" >/dev/null 2>&1 || true
    fi
  fi
  remove_session_catalog_entry "$session_name"
}

manage_selected_session() {
  local session_name="$1"
  local row type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state display_title action new_title

  row="$(get_session_inventory_row "$session_name")" || {
    printf 'Session not found: %s\n' "$session_name" >&2
    return 1
  }

  IFS="$SESSION_FIELD_DELIM" read -r _ type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state <<<"$row"
  display_title="$title"
  if [[ -z "${display_title// }" ]]; then
    display_title="$(get_display_title "$session_name" "$type" "$label" "$activity_unix" "$preview_text")"
  fi

  while true; do
    printf '\nManage session: %s\n' "$display_title"
    printf '[1] Rename title\n'
    if [[ "$archived" == 'true' ]]; then
      printf '[2] Unarchive\n'
    else
      printf '[2] Archive\n'
    fi
    if [[ "$is_live" == 'true' ]]; then
      printf '[3] Close session\n'
    else
      printf '[3] Close session (already closed)\n'
    fi
    printf '[4] Delete entry\n'
    printf '[5] Back\n'
    read -r -p 'Choose 1/2/3/4/5: ' action
    case "$action" in
      1)
        read -r -p 'New title: ' new_title
        rename_session "$session_name" "$new_title"
        ;;
      2)
        if [[ "$archived" == 'true' ]]; then
          set_session_archived_state "$session_name" 'false'
        else
          set_session_archived_state "$session_name" 'true'
        fi
        ;;
      3)
        if [[ "$is_live" == 'true' ]]; then
          close_session "$session_name"
          return 0
        fi
        printf 'Session is already closed.\n'
        ;;
      4)
        delete_session "$session_name"
        return 0
        ;;
      5)
        return 0
        ;;
      *)
        printf 'Invalid choice.\n'
        ;;
    esac
    row="$(get_session_inventory_row "$session_name" 2>/dev/null || true)"
    [[ -n "${row// }" ]] || return 0
    IFS="$SESSION_FIELD_DELIM" read -r _ type label title folder_text preview_text attached windows activity_unix activity_local archived is_live closed_utc state <<<"$row"
    display_title="$title"
    if [[ -z "${display_title// }" ]]; then
      display_title="$(get_display_title "$session_name" "$type" "$label" "$activity_unix" "$preview_text")"
    fi
  done
}

manage_interactive_session() {
  choose_any_session
  manage_selected_session "$SELECTED_SESSION_NAME"
}

open_plain_shell() {
  export AI_AGENT_MOBILE_BYPASS=1
  exec bash --login
}

start_interactive_session() {
  local session_type session_label session_title session_working_directory
  session_type="$(choose_agent_type)"
  read -r -p 'What is this session about? (optional): ' session_title
  read -r -p "Working directory (optional, default: ${DEFAULT_WORKSPACE_ROOT}): " session_working_directory
  session_label="$(new_auto_session_label)"
  ensure_session_and_attach "$session_type" "$session_label" "$session_title" "$session_working_directory"
}

resume_interactive_session() {
  choose_existing_session
  attach_existing_session "$SELECTED_SESSION_NAME"
}

run_menu() {
  while true; do
    printf '\nAI session mobile menu\n'
    printf '[1] Start new typed session\n'
    printf '[2] Resume existing session\n'
    printf '[3] List active sessions\n'
    printf '[4] Manage sessions\n'
    printf '[5] Open plain shell\n'
    printf '[6] Exit\n'

    local choice
    read -r -p 'Choose 1/2/3/4/5/6: ' choice
    case "$choice" in
      1)
        start_interactive_session
        ;;
      2)
        resume_interactive_session
        ;;
      3)
        list_sessions 0 0
        ;;
      4)
        manage_interactive_session
        ;;
      5)
        open_plain_shell
        ;;
      6)
        exit 0
        ;;
      *)
        printf 'Invalid choice.\n'
        ;;
    esac
  done
}

main() {
  local action="${1:-menu}"
  ensure_tmux_defaults
  case "$action" in
    menu)
      run_menu
      ;;
    list)
      list_sessions 0 0
      ;;
    list-all)
      list_sessions 1 1
      ;;
    start)
      [[ $# -ge 2 ]] || {
        usage >&2
        return 1
      }
      case "$2" in
        codex|claude|gemini|shell) ;;
        *)
          usage >&2
          return 1
          ;;
      esac
      ensure_session_and_attach "$2" "$(new_auto_session_label)" "${*:3}" ''
      ;;
    resume)
      [[ $# -eq 2 ]] || {
        usage >&2
        return 1
      }
      attach_existing_session "$2"
      ;;
    rename)
      [[ $# -ge 3 ]] || {
        usage >&2
        return 1
      }
      rename_session "$2" "${*:3}"
      ;;
    archive)
      [[ $# -eq 2 ]] || {
        usage >&2
        return 1
      }
      set_session_archived_state "$2" 'true'
      ;;
    unarchive)
      [[ $# -eq 2 ]] || {
        usage >&2
        return 1
      }
      set_session_archived_state "$2" 'false'
      ;;
    close)
      [[ $# -eq 2 ]] || {
        usage >&2
        return 1
      }
      close_session "$2"
      ;;
    delete)
      [[ $# -eq 2 ]] || {
        usage >&2
        return 1
      }
      delete_session "$2"
      ;;
    manage)
      if [[ $# -eq 2 ]]; then
        manage_selected_session "$2"
      else
        manage_interactive_session
      fi
      ;;
    shell)
      open_plain_shell
      ;;
    --help|-h|help)
      usage
      ;;
    *)
      usage >&2
      return 1
      ;;
  esac
}

main "$@"
