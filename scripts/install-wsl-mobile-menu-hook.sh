#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  cat <<'EOF'
Usage:
  install-wsl-mobile-menu-hook.sh

Installs or updates the managed AI mobile menu hook in ~/.bashrc.
EOF
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook_script="${script_dir}/wsl-mobile-login-bootstrap.sh"
bashrc_path="${HOME}/.bashrc"

if [[ ! -x "$hook_script" ]]; then
  chmod +x "$hook_script"
fi

python3 - "$bashrc_path" "$hook_script" <<'PY'
from pathlib import Path
import re
import sys

bashrc_path = Path(sys.argv[1])
hook_script = sys.argv[2]
start_marker = "# >>> AI agent mobile menu hook >>>"
end_marker = "# <<< AI agent mobile menu hook <<<"
legacy_block_pattern = re.compile(
    r"\n?# Auto-open the typed AI session menu for SSH logins\.\n"
    r'export PATH="\$HOME/\.local/bin:\$PATH"\n'
    r"AGENT_SESSION_MENU_SCRIPT='[^']+'\n"
    r'if command -v tmux &>/dev/null && \[ -t 0 \] && \[ -z "\$TMUX" \] && \[ -n "\$SSH_CONNECTION" \] && \[ -z "\$AI_AGENT_MOBILE_BYPASS" \] && \[ -x "\$AGENT_SESSION_MENU_SCRIPT" \]; then\n'
    r'    exec "\$AGENT_SESSION_MENU_SCRIPT"\n'
    r"fi\n?",
    re.MULTILINE,
)
block = "\n".join(
    [
        start_marker,
        'export PATH="$HOME/.local/bin:$PATH"',
        f'if [ -x "{hook_script}" ]; then',
        f'    "{hook_script}"',
        'fi',
        end_marker,
    ]
) + "\n"

content = bashrc_path.read_text(encoding="utf-8") if bashrc_path.exists() else ""
content = legacy_block_pattern.sub("\n", content)
start = content.find(start_marker)
end = content.find(end_marker)

if start != -1 and end != -1 and end > start:
    end += len(end_marker)
    while end < len(content) and content[end] in "\r\n":
        end += 1
    updated = content[:start].rstrip() + "\n\n" + block
else:
    updated = content.rstrip() + "\n\n" + block if content.strip() else block

bashrc_path.write_text(updated, encoding="utf-8")
PY

printf 'Installed mobile menu hook in %s\n' "$bashrc_path"
