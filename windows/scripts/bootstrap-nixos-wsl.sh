#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STABLE_REPO_DIR="$HOME/.dotfiles"
BACKUP_DIR="$HOME/dotfiles_backup_$(date +%Y%m%d_%H%M%S)"

log() { printf '\033[0;36m[nixos-wsl]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[nixos-wsl]\033[0m %s\n' "$*"; }

ensure_dotfiles_link() {
  if [ -L "$STABLE_REPO_DIR" ] && [ "$(readlink -f "$STABLE_REPO_DIR")" = "$REAL_REPO_DIR" ]; then
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

repo_dir() {
  if [ -L "$STABLE_REPO_DIR" ] && [ "$(readlink -f "$STABLE_REPO_DIR")" = "$REAL_REPO_DIR" ]; then
    printf '%s\n' "$STABLE_REPO_DIR"
  else
    printf '%s\n' "$REAL_REPO_DIR"
  fi
}

ensure_dotfiles_link
REPO_DIR="$(repo_dir)"
CONFIGS_DIR="$REPO_DIR/configs"

if [ "$(id -u)" -eq 0 ]; then
  warn "Run this as the WSL user, not root. Current HOME is $HOME."
fi

backup_file() {
  local target="$1"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    mkdir -p "$BACKUP_DIR"
    mv "$target" "$BACKUP_DIR/"
    warn "Backed up existing $target to $BACKUP_DIR"
  fi
}

ensure_parent_dir() {
  local target="$1"
  local parent
  parent="$(dirname "$target")"

  if [ -d "$parent" ]; then
    return
  fi

  if [ -L "$parent" ]; then
    rm "$parent"
    warn "Removed stale parent symlink: $parent"
  elif [ -e "$parent" ]; then
    backup_file "$parent"
  fi

  mkdir -p "$parent"
}

link_config() {
  local source="$1"
  local target="$2"
  ensure_parent_dir "$target"

  if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$(readlink -f "$source")" ]; then
    log "Already linked: $target"
    return
  fi

  backup_file "$target"
  [ -L "$target" ] && rm "$target"
  ln -s "$source" "$target"
  log "Linked $source -> $target"
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    warn "$command_name is missing. Add it to nixos/hosts/wsl/configuration.nix and rebuild."
    return 1
  fi
}

install_oh_my_zsh() {
  if [ ! -d "$HOME/.oh-my-zsh" ]; then
    require_command curl || return
    log "Installing Oh My Zsh..."
    RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
  else
    log "Oh My Zsh already installed."
  fi
}

setup_symlinks() {
  log "Linking shell and agent configs through $REPO_DIR..."
  link_config "$CONFIGS_DIR/zsh/.zshrc" "$HOME/.zshrc"
  mkdir -p "$HOME/.oh-my-zsh/custom/themes"
  link_config "$CONFIGS_DIR/zsh/custom.zsh-theme" "$HOME/.oh-my-zsh/custom/themes/custom.zsh-theme"
  link_config "$CONFIGS_DIR/tmux" "$HOME/.config/tmux"
  link_config "$CONFIGS_DIR/pi/settings.json" "$HOME/.pi/agent/settings.json"
  link_config "$CONFIGS_DIR/pi/APPEND_SYSTEM.md" "$HOME/.pi/agent/APPEND_SYSTEM.md"
  link_config "$CONFIGS_DIR/pi/extensions" "$HOME/.pi/agent/extensions"
  link_config "$CONFIGS_DIR/pi/prompts" "$HOME/.pi/agent/prompts"
  link_config "$CONFIGS_DIR/pi/keybindings.json" "$HOME/.pi/agent/keybindings.json"
  link_config "$CONFIGS_DIR/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
  link_config "$CONFIGS_DIR/codex/prompts" "$HOME/.codex/prompts"
}

install_codex_cli() {
  if command -v codex >/dev/null 2>&1; then
    log "Codex CLI already installed: $(command -v codex)"
    return
  fi

  require_command curl || return
  log "Installing Codex CLI..."
  curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
}

install_pi_cli() {
  require_command npm || return

  mkdir -p "$HOME/.local"
  log "Installing/updating Pi coding agent..."
  NPM_CONFIG_PREFIX="$HOME/.local" command npm install -g "@earendil-works/pi-coding-agent@latest"
}

install_agent_skill_links() {
  require_command git || return

  local skills_repo="https://github.com/TobiasBak/skills.git"
  local skills_dir
  skills_dir="$(cd "$REAL_REPO_DIR/.." && pwd)/skills"

  mkdir -p "$(dirname "$skills_dir")"
  if [ -d "$skills_dir/.git" ]; then
    log "Updating skills repo at $skills_dir..."
    git -C "$skills_dir" pull --ff-only || warn "Could not update skills repo at $skills_dir. Continuing with the existing checkout."
  elif [ ! -e "$skills_dir" ]; then
    log "Cloning skills repo into $skills_dir..."
    git clone "$skills_repo" "$skills_dir" || {
      warn "Could not clone skills repo into $skills_dir."
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

install_oh_my_zsh
setup_symlinks
install_codex_cli
install_pi_cli
install_agent_skill_links
set_shell

log "NixOS WSL shell bootstrap complete."
