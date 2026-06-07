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

log "Installing shell packages..."
$SUDO pacman -Sy --needed --noconfirm \
  zsh git github-cli curl eza nvm zsh-syntax-highlighting ttf-jetbrains-mono-nerd

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

if command -v zsh >/dev/null 2>&1 && [ "${SHELL:-}" != "$(command -v zsh)" ] && [ -n "$SUDO" ]; then
  log "Changing default shell to zsh..."
  chsh -s "$(command -v zsh)" || warn "chsh failed; set default shell manually."
fi

log "Arch WSL shell bootstrap complete."
