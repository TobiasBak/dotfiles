#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$SCRIPT_DIR"
STABLE_REPO_DIR="$HOME/.dotfiles"
BOOTSTRAP=false

log() { printf '\033[0;36m[rebuild-nixos]\033[0m %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: ./rebuild-nixos.sh [--bootstrap]

Builds and switches the native NixOS host matching the current hostname.

Options:
  --bootstrap  Refresh mutable Pi/Codex tools and skill links after switching.
  -h, --help   Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bootstrap) BOOTSTRAP=true ;;
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

if [ ! -f /etc/NIXOS ]; then
  echo "rebuild-nixos.sh must be run on NixOS." >&2
  exit 1
fi

if grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "Use rebuild-wsl.sh inside WSL." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "Run rebuild-nixos.sh as your normal user, not root." >&2
  exit 1
fi

host="$(hostname)"
case "$host" in
  tobias-stationary | tobias-laptop) ;;
  *)
    echo "Unsupported native NixOS hostname: $host" >&2
    exit 1
    ;;
esac

hardware_config="$REPO_DIR/nixos/hosts/$host/hardware-configuration.nix"
if grep -q "Bootstrap placeholder" "$hardware_config"; then
  echo "Refusing to rebuild with the placeholder hardware configuration: $hardware_config" >&2
  echo "Replace it with the generated configuration from this machine first." >&2
  exit 1
fi

repo_resolved="$(readlink -f "$REPO_DIR")"
stable_resolved="$(readlink -f "$STABLE_REPO_DIR" 2>/dev/null || true)"
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
  echo "$STABLE_REPO_DIR exists and does not point at $REPO_DIR." >&2
  exit 1
fi

log "Building $host..."
nix build --no-link "$REPO_DIR/nixos#nixosConfigurations.$host.config.system.build.toplevel"

log "Switching $host..."
sudo nixos-rebuild switch --flake "$REPO_DIR/nixos#$host"

if [ "$BOOTSTRAP" = true ]; then
  log "Refreshing developer tools and skill links..."
  bash "$REPO_DIR/scripts/bootstrap-developer-tools.sh"
fi

log "$host rebuild complete."
