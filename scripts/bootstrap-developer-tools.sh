#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REAL_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STABLE_REPO_DIR="$HOME/.dotfiles"

log() { printf '\033[0;36m[developer-tools]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[developer-tools]\033[0m %s\n' "$*"; }

# Keep freshly installed npm binaries visible even when this is called from a
# non-interactive shell (for example by the WSL installer).
PATH="$HOME/.local/bin:$HOME/bin:$PATH"
export PATH

resolve_path() {
  readlink -f "$1" 2>/dev/null || true
}

ensure_dotfiles_link() {
  local stable_resolved
  stable_resolved="$(resolve_path "$STABLE_REPO_DIR")"

  if [ -L "$STABLE_REPO_DIR" ] && [ "$stable_resolved" = "$REAL_REPO_DIR" ]; then
    return
  fi

  if [ -e "$STABLE_REPO_DIR" ] && [ ! -L "$STABLE_REPO_DIR" ]; then
    warn "$STABLE_REPO_DIR exists and is not a symlink. Config links will use $REAL_REPO_DIR."
    return
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

is_wsl_windows_path() {
  case "$1" in
    /mnt/[A-Za-z]/*) return 0 ;;
    *) return 1 ;;
  esac
}

run_git_noninteractive() {
  if command -v timeout >/dev/null 2>&1; then
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never SSH_ASKPASS=/bin/false timeout 120 git "$@"
  else
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never SSH_ASKPASS=/bin/false git "$@"
  fi
}

ensure_github_auth() {
  require_command gh || return 1

  if gh auth status --hostname github.com >/dev/null 2>&1; then
    return 0
  fi

  log "GitHub auth is needed for private repos. Follow the GitHub CLI login prompts."
  if ! gh auth login --hostname github.com --git-protocol https --web; then
    warn "GitHub login did not complete."
    return 1
  fi
}

install_codex_cli() {
  local codex_path
  codex_path="$(command -v codex 2>/dev/null || true)"

  if [ -n "$codex_path" ]; then
    if is_wsl_windows_path "$codex_path"; then
      warn "Ignoring Windows Codex on WSL PATH: $codex_path"
    else
      log "Existing Codex CLI: $codex_path"
    fi
  fi

  require_command npm || return
  mkdir -p "$HOME/.local"
  log "Installing/updating Codex CLI..."
  if NPM_CONFIG_PREFIX="$HOME/.local" command npm install -g "@openai/codex@latest"; then
    log "Codex CLI ready: $(command -v codex 2>/dev/null || printf '%s' "$HOME/.local/bin/codex")"
    return
  fi

  if [ -n "$codex_path" ] && ! is_wsl_windows_path "$codex_path"; then
    warn "Codex update failed. Keeping existing native Codex: $codex_path"
    return
  fi

  return 1
}

install_pi_cli() {
  require_command npm || return

  mkdir -p "$HOME/.local"
  log "Installing/updating Pi coding agent..."
  NPM_CONFIG_PREFIX="$HOME/.local" command npm install -g "@earendil-works/pi-coding-agent@latest"
}

remove_legacy_subagents() {
  local package_root="$HOME/.pi/agent/npm"
  local agents_link="$HOME/.codex/agents"

  if [ -d "$package_root/node_modules/pi-subagents" ] ||
     { [ -f "$package_root/package.json" ] && grep -q '"pi-subagents"' "$package_root/package.json"; }; then
    if command -v npm >/dev/null 2>&1; then
      log "Removing legacy pi-subagents package..."
      command npm uninstall --prefix "$package_root" pi-subagents ||
        warn "Could not remove legacy pi-subagents package from $package_root"
    else
      warn "npm not found, skipping legacy pi-subagents package cleanup."
    fi
  fi

  if [ -L "$agents_link" ]; then
    log "Removing legacy Codex agents link..."
    rm -f "$agents_link"
  fi
}

install_agent_skill_links() {
  require_command git || return

  local skills_repo="https://github.com/TobiasBak/skills.git"
  local skills_dir
  skills_dir="$(cd "$REAL_REPO_DIR/.." && pwd)/skills"

  mkdir -p "$(dirname "$skills_dir")"
  if [ -d "$skills_dir/.git" ]; then
    log "Updating skills repo at $skills_dir..."
    run_git_noninteractive -C "$skills_dir" pull --ff-only ||
      { ensure_github_auth && git -C "$skills_dir" pull --ff-only; } ||
      warn "Could not update skills repo at $skills_dir. Continuing with the existing checkout."
  elif [ ! -e "$skills_dir" ]; then
    log "Cloning skills repo into $skills_dir..."
    run_git_noninteractive clone "$skills_repo" "$skills_dir" ||
      { ensure_github_auth && git clone "$skills_repo" "$skills_dir"; } || {
      warn "Could not clone skills repo into $skills_dir."
      if [ -d "$skills_dir" ] && [ ! -d "$skills_dir/.git" ]; then
        rm -rf "$skills_dir"
      fi
      return
    }
  else
    warn "$skills_dir exists but is not a git repository. Skipping agent skill links."
    return
  fi

  if [ ! -f "$skills_dir/scripts/install-links.sh" ]; then
    warn "Skills installer not found: $skills_dir/scripts/install-links.sh"
    return
  fi

  log "Linking Pi skills..."
  PI_SKILLS_DIR="$HOME/.pi/agent/skills" bash "$skills_dir/scripts/install-links.sh" --fix

  log "Linking Codex CLI skills..."
  PI_SKILLS_DIR="$HOME/.agents/skills" bash "$skills_dir/scripts/install-links.sh" --fix
}

set_shell() {
  if command -v zsh >/dev/null 2>&1 && [ "${SHELL:-}" != "$(command -v zsh)" ]; then
    log "Default shell is not zsh yet. NixOS should set this declaratively on next login."
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  warn "Run this as the user account, not root. Current HOME is $HOME."
fi

ensure_github_auth || warn "GitHub login did not complete. Continuing without authenticated Git access."
ensure_dotfiles_link
install_codex_cli
install_pi_cli
remove_legacy_subagents
install_agent_skill_links
set_shell

log "Developer-tool bootstrap complete."
