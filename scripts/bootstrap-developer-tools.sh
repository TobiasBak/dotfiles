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

  require_command pnpm || return 0
  mkdir -p "$PNPM_BIN"
  log "Installing/updating Codex CLI..."
  if command pnpm add --global --ignore-scripts "@openai/codex@latest"; then
    log "Codex CLI ready: $(command -v codex 2>/dev/null || printf '%s' "$PNPM_BIN/codex")"
    return 0
  fi

  if [ -n "$codex_path" ] && ! is_wsl_windows_path "$codex_path"; then
    warn "Codex update failed. Keeping existing native Codex: $codex_path"
    return 0
  fi

  return 1
}

install_pi_cli() {
  require_command pnpm || return 0

  mkdir -p "$PNPM_BIN"
  log "Installing/updating Pi coding agent..."
  command pnpm add --global --ignore-scripts "@earendil-works/pi-coding-agent@latest"
}

install_pi_tools() {
  require_command git || return 0

  local pi_tools_repo="https://github.com/TobiasBak/pi-tools.git"
  local pi_tools_dir
  pi_tools_dir="$(cd "$REAL_REPO_DIR/.." && pwd)/pi-tools"

  mkdir -p "$(dirname "$pi_tools_dir")"
  if [ -d "$pi_tools_dir/.git" ]; then
    log "Updating Pi tools repo at $pi_tools_dir..."
    run_git_noninteractive -C "$pi_tools_dir" pull --ff-only ||
      warn "Could not update Pi tools at $pi_tools_dir. Continuing with the existing checkout."
  elif [ ! -e "$pi_tools_dir" ]; then
    log "Cloning Pi tools into $pi_tools_dir..."
    run_git_noninteractive clone "$pi_tools_repo" "$pi_tools_dir" || {
      warn "Could not clone Pi tools into $pi_tools_dir."
      if [ -d "$pi_tools_dir" ] && [ ! -d "$pi_tools_dir/.git" ]; then
        rm -rf "$pi_tools_dir"
      fi
      return 0
    }
  else
    echo "$pi_tools_dir exists but is not a git repository. Move it aside before bootstrapping." >&2
    return 1
  fi

  require_command pnpm || return 0
  if [ ! -f "$pi_tools_dir/pnpm-lock.yaml" ]; then
    warn "Pi tools dependency lockfile not found: $pi_tools_dir/pnpm-lock.yaml"
    return 0
  fi

  log "Installing Pi tools runtime dependencies..."
  command pnpm --dir "$pi_tools_dir" install --prod --frozen-lockfile
}

remove_legacy_subagents() {
  local package_root="$HOME/.pi/agent/npm"

  if [ -d "$package_root/node_modules/pi-subagents" ] ||
     { [ -f "$package_root/package.json" ] && grep -q '"pi-subagents"' "$package_root/package.json"; }; then
    if command -v pnpm >/dev/null 2>&1; then
      log "Removing legacy pi-subagents package..."
      command pnpm --dir "$package_root" remove pi-subagents ||
        warn "Could not remove legacy pi-subagents package from $package_root"
    else
      warn "pnpm not found, skipping legacy pi-subagents package cleanup."
    fi
  fi
}

install_agent_skill_links() {
  require_command git || return 0

  local skills_repo="https://github.com/TobiasBak/skills.git"
  local skills_dir
  skills_dir="$(cd "$REAL_REPO_DIR/.." && pwd)/skills"

  mkdir -p "$(dirname "$skills_dir")"
  if [ -d "$skills_dir/.git" ]; then
    log "Updating skills repo at $skills_dir..."
    run_git_noninteractive -C "$skills_dir" pull --ff-only ||
      warn "Could not update skills repo at $skills_dir. Continuing with the existing checkout."
  elif [ ! -e "$skills_dir" ]; then
    log "Cloning skills repo into $skills_dir..."
    run_git_noninteractive clone "$skills_repo" "$skills_dir" || {
      warn "Could not clone skills repo into $skills_dir."
      if [ -d "$skills_dir" ] && [ ! -d "$skills_dir/.git" ]; then
        rm -rf "$skills_dir"
      fi
      return 0
    }
  else
    warn "$skills_dir exists but is not a git repository. Skipping agent skill links."
    return 0
  fi

  if [ ! -f "$skills_dir/scripts/install-links.sh" ]; then
    warn "Skills installer not found: $skills_dir/scripts/install-links.sh"
    return 0
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
  echo "Run this as the user account, not root. Current HOME is $HOME." >&2
  exit 1
fi

ensure_dotfiles_link
install_codex_cli
install_pi_cli
install_pi_tools
remove_legacy_subagents
install_agent_skill_links
set_shell

log "Developer-tool bootstrap complete."
