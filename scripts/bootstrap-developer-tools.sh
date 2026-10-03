#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REAL_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STABLE_REPO_DIR="$HOME/.dotfiles"

log() { printf '\033[0;36m[developer-tools]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[developer-tools]\033[0m %s\n' "$*"; }

# Keep freshly installed pnpm binaries visible even when this is called from a
# non-interactive shell (for example by the WSL installer).
PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
PNPM_BIN="$PNPM_HOME/bin"
PATH="$PNPM_BIN:$HOME/.local/bin:$HOME/bin:$PATH"
export PATH PNPM_BIN PNPM_HOME

resolve_path() {
  readlink -f "$1" 2>/dev/null || true
}

ensure_dotfiles_link() {
  local stable_resolved
  stable_resolved="$(resolve_path "$STABLE_REPO_DIR")"

  if [ -L "$STABLE_REPO_DIR" ] && [ "$stable_resolved" = "$REAL_REPO_DIR" ]; then
    return 0
  fi

  if [ -e "$STABLE_REPO_DIR" ] && [ ! -L "$STABLE_REPO_DIR" ]; then
    echo "$STABLE_REPO_DIR exists and is not a symlink. Move it aside before bootstrapping." >&2
    return 1
  fi

  rm -f "$STABLE_REPO_DIR"
  ln -s "$REAL_REPO_DIR" "$STABLE_REPO_DIR"
  log "Linked $STABLE_REPO_DIR -> $REAL_REPO_DIR"
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    warn "$command_name is missing; skipping the dependent developer-tool step."
    return 1
  fi
}

run_git_noninteractive() {
  if command -v timeout >/dev/null 2>&1; then
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never SSH_ASKPASS=/bin/false timeout 120 git "$@"
  else
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never SSH_ASKPASS=/bin/false git "$@"
  fi
}

install_opencode_cli() {
  require_command pnpm || return 0

  mkdir -p "$PNPM_BIN"
  log "Installing/updating OpenCode v2..."
  # V2's postinstall selects the native binary; allow only its build script.
  # https://opencode.ai/v2/docs
  command pnpm add --global --allow-build=@opencode/cli "@opencode/cli@latest"
}

install_pi_cli() {
  require_command pnpm || return 0

  mkdir -p "$PNPM_BIN"
  log "Installing/updating Pi coding agent..."
  command pnpm add --global --ignore-scripts "@earendil-works/pi-coding-agent@latest"
}

install_agent_skill_links() {
  require_command git || return 0

  local vault_repo="https://github.com/TobiasBak/vault-public.git"
  local vault_dir
  vault_dir="$(cd "$REAL_REPO_DIR/.." && pwd)/vault-public"

  if [ -d "$vault_dir/.git" ]; then
    log "Updating vault at $vault_dir..."
    run_git_noninteractive -C "$vault_dir" pull --ff-only ||
      warn "Could not update vault at $vault_dir. Continuing with the existing checkout."
  elif [ ! -e "$vault_dir" ]; then
    log "Cloning vault into $vault_dir..."
    run_git_noninteractive clone "$vault_repo" "$vault_dir" || {
      warn "Could not clone vault into $vault_dir."
      if [ -d "$vault_dir" ] && [ ! -d "$vault_dir/.git" ]; then
        rm -rf "$vault_dir"
      fi
      return 0
    }
  else
    warn "$vault_dir exists but is not a git repository. Skipping agent skill links."
    return 0
  fi

  if [ ! -f "$vault_dir/scripts/install-skills.sh" ]; then
    warn "Skills installer not found: $vault_dir/scripts/install-skills.sh"
    return 0
  fi

  log "Linking agent skills..."
  bash "$vault_dir/scripts/install-skills.sh" --fix
}

set_shell() {
  if command -v zsh >/dev/null 2>&1 && [ "${SHELL:-}" != "$(command -v zsh)" ]; then
    log "Default shell is not zsh yet. NixOS should set this declaratively on next login."
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the user account, not root. Current HOME is $HOME." >&2
  exit 1
fi

ensure_dotfiles_link
bash "$SCRIPT_DIR/bootstrap-ai-clis.sh"
install_opencode_cli
install_pi_cli
install_agent_skill_links
set_shell

log "Developer-tool bootstrap complete."
