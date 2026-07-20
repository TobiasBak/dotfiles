#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$SCRIPT_DIR"
STABLE_REPO_DIR="$HOME/.dotfiles"
BOOTSTRAP_SCRIPT="$REPO_DIR/scripts/bootstrap-developer-tools.sh"
NIXOS_ONLY=false

log() { printf '\033[0;36m[rebuild-wsl]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[rebuild-wsl]\033[0m %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: ./rebuild-wsl.sh [--nixos-only]

Applies the NixOS WSL flake, then refreshes user config links and agent tools.

Options:
  --nixos-only  Apply only the NixOS WSL flake. Skip user config links,
                Codex/Pi agent pnpm installs, and skill link refresh.
  -h, --help    Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --nixos-only)
      NIXOS_ONLY=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

resolve_path() {
  readlink -f "$1" 2>/dev/null || true
}

prepend_path_once() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) PATH="$1:$PATH" ;;
  esac
}

remove_wsl_windows_path() {
  local old_ifs entry filtered_path
  old_ifs="$IFS"
  filtered_path=""
  IFS=:

  for entry in $PATH; do
    case "$entry" in
      "" | /mnt/[A-Za-z]/*) continue ;;
    esac

    if [ -n "$filtered_path" ]; then
      filtered_path="$filtered_path:$entry"
    else
      filtered_path="$entry"
    fi
  done

  IFS="$old_ifs"
  PATH="$filtered_path"
}

remove_wsl_windows_path
prepend_path_once /run/current-system/sw/bin
prepend_path_once /run/wrappers/bin
export PATH

if [ ! -f /etc/NIXOS ]; then
  echo "rebuild-wsl.sh must be run inside NixOS WSL." >&2
  exit 1
fi

if ! grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "rebuild-wsl.sh must be run inside WSL." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "Run rebuild-wsl.sh as your normal WSL user, not root." >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/nixos/flake.nix" ]; then
  echo "Missing NixOS flake: $REPO_DIR/nixos/flake.nix" >&2
  exit 1
fi

if [ "$NIXOS_ONLY" = false ] && [ ! -f "$BOOTSTRAP_SCRIPT" ]; then
  echo "Missing WSL bootstrap script: $BOOTSTRAP_SCRIPT" >&2
  exit 1
fi

repo_resolved="$(resolve_path "$REPO_DIR")"
stable_resolved="$(resolve_path "$STABLE_REPO_DIR")"

if [ -z "$repo_resolved" ]; then
  echo "Could not resolve dotfiles checkout: $REPO_DIR" >&2
  exit 1
fi

if [ -L "$STABLE_REPO_DIR" ]; then
  if [ "$stable_resolved" != "$repo_resolved" ]; then
    rm -f "$STABLE_REPO_DIR"
    ln -s "$repo_resolved" "$STABLE_REPO_DIR"
    log "Linked $STABLE_REPO_DIR -> $repo_resolved"
  fi
elif [ ! -e "$STABLE_REPO_DIR" ]; then
  ln -s "$repo_resolved" "$STABLE_REPO_DIR"
  log "Linked $STABLE_REPO_DIR -> $repo_resolved"
elif [ "$stable_resolved" != "$repo_resolved" ]; then
  echo "$STABLE_REPO_DIR exists and does not point at $REPO_DIR. Move it aside or fix the link before rebuilding." >&2
  exit 1
else
  warn "$STABLE_REPO_DIR is not a symlink, but it resolves to this checkout."
fi

export NIX_CONFIG="${NIX_CONFIG:-}
experimental-features = nix-command flakes"

sudo_bin="/run/wrappers/bin/sudo"
if [ ! -x "$sudo_bin" ]; then
  sudo_bin="$(command -v sudo || true)"
fi

if [ -z "$sudo_bin" ]; then
  echo "Could not find sudo. Expected /run/wrappers/bin/sudo in NixOS WSL." >&2
  exit 1
fi

log "Applying NixOS WSL flake..."
"$sudo_bin" env "PATH=$PATH" nixos-rebuild switch --flake "$REPO_DIR/nixos#wsl"

if [ "$NIXOS_ONLY" = true ]; then
  log "Skipping WSL user config links and agent tools (--nixos-only)."
  log "NixOS WSL rebuild complete."
  exit 0
fi

log "Refreshing WSL user config links and agent tools..."
bash "$BOOTSTRAP_SCRIPT"

log "NixOS WSL rebuild complete."
