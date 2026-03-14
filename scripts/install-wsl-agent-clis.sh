#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage:
  install-wsl-agent-clis.sh

Configures npm to install globals into ~/.local and installs:
  @openai/codex
  @google/gemini-cli
  @anthropic-ai/claude-code
EOF
  exit 0
fi

home_local_bin="${HOME}/.local/bin"
mkdir -p "$home_local_bin"

if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "${HOME}/.profile" 2>/dev/null; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "${HOME}/.profile"
fi

if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "${HOME}/.bashrc" 2>/dev/null; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "${HOME}/.bashrc"
fi

npm config set prefix "${HOME}/.local"
npm install -g @openai/codex @google/gemini-cli @anthropic-ai/claude-code

"${home_local_bin}/codex" --version
"${home_local_bin}/gemini" --version
"${home_local_bin}/claude" --version

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${script_dir}/install-wsl-mobile-menu-hook.sh"
