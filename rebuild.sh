#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$SCRIPT_DIR"
STABLE_REPO_DIR="$HOME/.dotfiles"
SKILLS_DIR="$(dirname "$REPO_DIR")/skills"
SKILLS_REPO="https://github.com/TobiasBak/skills.git"

log() { printf '\033[0;36m[rebuild]\033[0m %s\n' "$*"; }

resolve_path() {
  readlink -f "$1" 2>/dev/null || true
}

run_git_noninteractive() {
  GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never SSH_ASKPASS=/bin/false git "$@"
}

normalize_path() {
  local entry filtered_path=""

  while IFS= read -r entry; do
    case "$entry" in
      "" | /mnt/[A-Za-z]/* | /run/wrappers/bin | /run/current-system/sw/bin) continue ;;
    esac
    filtered_path="${filtered_path:+$filtered_path:}$entry"
  done < <(printf '%s' "$PATH" | tr ':' '\n')

  PATH="/run/wrappers/bin:/run/current-system/sw/bin${filtered_path:+:$filtered_path}"
  export PATH
}

ensure_github_auth() {
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    gh auth setup-git --hostname github.com >/dev/null 2>&1 || true
    return
  fi

  log "GitHub authentication is required for the private skills repository."
  gh auth login --hostname github.com --git-protocol https --web
  gh auth setup-git --hostname github.com >/dev/null 2>&1
}

ensure_dotfiles_link() {
  local repo_resolved stable_resolved
  repo_resolved="$(resolve_path "$REPO_DIR")"
  stable_resolved="$(resolve_path "$STABLE_REPO_DIR")"

  if [ -L "$STABLE_REPO_DIR" ] && [ "$stable_resolved" = "$repo_resolved" ]; then
    return
  fi

  if [ -e "$STABLE_REPO_DIR" ] && [ ! -L "$STABLE_REPO_DIR" ]; then
    echo "$STABLE_REPO_DIR exists and is not a symlink. Move it aside before rebuilding." >&2
    exit 1
  fi

  rm -f "$STABLE_REPO_DIR"
  ln -s "$repo_resolved" "$STABLE_REPO_DIR"
  log "Linked $STABLE_REPO_DIR -> $repo_resolved"
}

ensure_skills_checkout() {
  mkdir -p "$(dirname "$SKILLS_DIR")"

  if [ -d "$SKILLS_DIR/.git" ]; then
    log "Updating skills repository..."
    run_git_noninteractive -C "$SKILLS_DIR" pull --ff-only || {
      ensure_github_auth
      git -C "$SKILLS_DIR" pull --ff-only
    }
    return
  fi

  if [ -e "$SKILLS_DIR" ]; then
    echo "$SKILLS_DIR exists but is not a Git repository. Move it aside before rebuilding." >&2
    exit 1
  fi

  log "Cloning skills repository..."
  run_git_noninteractive clone "$SKILLS_REPO" "$SKILLS_DIR" || {
    ensure_github_auth
    git clone "$SKILLS_REPO" "$SKILLS_DIR"
  }
}

if [ ! -f /etc/NIXOS ] || ! grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "rebuild.sh must be run inside NixOS WSL." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "Run rebuild.sh as the normal WSL user, not root." >&2
  exit 1
fi

normalize_path

for command_name in git gh nix nixos-rebuild sudo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 1
  fi
done

ensure_dotfiles_link
ensure_skills_checkout

export NIX_CONFIG="${NIX_CONFIG:-}
experimental-features = nix-command flakes"

log "Building the NixOS WSL system..."
nix build --no-link "$REPO_DIR/nixos#nixosConfigurations.wsl.config.system.build.toplevel"

log "Switching to the new NixOS WSL system..."
sudo nixos-rebuild switch --flake "$REPO_DIR/nixos#wsl"

log "NixOS WSL rebuild complete."
