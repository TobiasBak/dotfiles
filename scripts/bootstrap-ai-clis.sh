#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STABLE_REPO_DIR="$HOME/.dotfiles"

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the user account, not root." >&2
  exit 1
fi

if [ "$(readlink -f "$STABLE_REPO_DIR" 2>/dev/null || true)" != "$REPO_DIR" ]; then
  echo "$STABLE_REPO_DIR must link to $REPO_DIR. Run the developer-tool bootstrap to repair it." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to install the agent CLIs." >&2
  exit 1
fi

PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
PNPM_BIN="$PNPM_HOME/bin"
PATH="$PNPM_BIN:$HOME/.local/bin:$HOME/bin:$PATH"
export PATH PNPM_BIN PNPM_HOME

for config in codex/config.toml claude/settings.json; do
  target="$HOME/.$config"
  source="$STABLE_REPO_DIR/configs/$config"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ ! -L "$target" ] || [ "$(readlink -f "$target")" != "$(readlink -f "$source")" ]; then
      echo "$target is not a managed link to $source. Apply the Home Manager configuration instead of overwriting it." >&2
      exit 1
    fi
  else
    mkdir -p "$(dirname "$target")"
    ln -s "$source" "$target"
  fi
done

mkdir -p "$PNPM_BIN"
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 command pnpm add --global \
  --allow-build=@anthropic-ai/claude-code \
  "@openai/codex@latest" "@anthropic-ai/claude-code@latest"

"$PNPM_BIN/codex" --version
"$PNPM_BIN/claude" --version
