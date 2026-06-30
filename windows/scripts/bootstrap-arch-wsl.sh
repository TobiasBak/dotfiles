#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIGS_DIR="$REPO_DIR/configs"
BACKUP_DIR="$HOME/dotfiles_backup_$(date +%Y%m%d_%H%M%S)"

log() { printf '\033[0;36m[arch-wsl]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[arch-wsl]\033[0m %s\n' "$*"; }

if ! command -v pacman >/dev/null 2>&1; then
  echo "pacman not found; this bootstrap expects Arch Linux." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  warn "Running as root. Shell config will install under $HOME. Create/set WSL user first if you want non-root home."
else
  SUDO="sudo"
fi

install_missing_packages() {
  local missing=()
  local package

  for package in "$@"; do
    if ! pacman -Q "$package" >/dev/null 2>&1; then
      missing+=("$package")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    log "Shell packages already installed."
    return
  fi

  log "Installing missing shell packages: ${missing[*]}"
  $SUDO pacman -Syu --needed --noconfirm "${missing[@]}"
}

install_missing_packages \
  zsh git github-cli curl tmux nvm zsh-syntax-highlighting python \
  ripgrep fd bat jq unzip openssh

if [ ! -d "$HOME/.oh-my-zsh" ]; then
  log "Installing Oh My Zsh..."
  RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
else
  log "Oh My Zsh already installed."
fi

backup_file() {
  local target="$1"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    mkdir -p "$BACKUP_DIR"
    mv "$target" "$BACKUP_DIR/"
    warn "Backed up existing $target to $BACKUP_DIR"
  fi
}

link_config() {
  local source="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"

  if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$source" ]; then
    log "Already linked: $target"
    return
  fi

  backup_file "$target"
  [ -L "$target" ] && rm "$target"
  ln -s "$source" "$target"
  log "Linked $source -> $target"
}

log "Linking zsh config from dotfiles repo..."
link_config "$CONFIGS_DIR/zsh/.zshrc" "$HOME/.zshrc"
mkdir -p "$HOME/.oh-my-zsh/custom/themes"
link_config "$CONFIGS_DIR/zsh/custom.zsh-theme" "$HOME/.oh-my-zsh/custom/themes/custom.zsh-theme"
link_config "$CONFIGS_DIR/tmux" "$HOME/.config/tmux"
link_config "$CONFIGS_DIR/pi/settings.json" "$HOME/.pi/agent/settings.json"
link_config "$CONFIGS_DIR/pi/APPEND_SYSTEM.md" "$HOME/.pi/agent/APPEND_SYSTEM.md"
link_config "$CONFIGS_DIR/pi/extensions" "$HOME/.pi/agent/extensions"
link_config "$CONFIGS_DIR/pi/prompts" "$HOME/.pi/agent/prompts"
link_config "$CONFIGS_DIR/pi/keybindings.json" "$HOME/.pi/agent/keybindings.json"
link_config "$CONFIGS_DIR/codex/prompts" "$HOME/.codex/prompts"

install_codex_cli() {
  if command -v codex >/dev/null 2>&1; then
    log "Codex CLI already installed: $(command -v codex)"
    return
  fi

  log "Installing Codex CLI..."
  curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
}

ensure_node_lts() {
  if [ ! -f /usr/share/nvm/init-nvm.sh ]; then
    warn "nvm init script missing; Pi coding agent install skipped."
    return 1
  fi

  # shellcheck disable=SC1091
  source /usr/share/nvm/init-nvm.sh
  if ! command -v node >/dev/null 2>&1; then
    log "Installing Node.js LTS via nvm..."
    nvm install --lts
  fi

  command -v npm >/dev/null 2>&1
}

install_pi_cli() {
  if ! ensure_node_lts; then
    return
  fi

  log "Installing/updating Pi coding agent..."
  command npm install -g "@earendil-works/pi-coding-agent@latest"
}

install_agent_skill_links() {
  local skills_repo="https://github.com/TobiasBak/skills.git"
  local skills_dir
  skills_dir="$(cd "$REPO_DIR/.." && pwd)/skills"

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

install_codex_cli
install_pi_cli
install_agent_skill_links

if command -v zsh >/dev/null 2>&1 && [ "${SHELL:-}" != "$(command -v zsh)" ] && [ -n "$SUDO" ]; then
  log "Changing default shell to zsh..."
  chsh -s "$(command -v zsh)" || warn "chsh failed; set default shell manually."
fi

log "Arch WSL shell bootstrap complete."
