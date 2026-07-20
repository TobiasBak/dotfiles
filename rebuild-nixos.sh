#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$SCRIPT_DIR"
STABLE_REPO_DIR="$HOME/.dotfiles"
BOOTSTRAP=false
TARGET_HOST=""

log() { printf '\033[0;36m[rebuild-nixos]\033[0m %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: ./rebuild-nixos.sh [host] [--bootstrap]

Builds and switches a native developer host. When host is omitted, the
current hostname is used. Pass a host during first setup from generic NixOS.

Hosts:
  pc
  laptop

Options:
  --bootstrap  Refresh mutable Pi/Codex tools and skill links after switching.
  -h, --help   Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bootstrap) BOOTSTRAP=true ;;
    pc | laptop)
      if [ -n "$TARGET_HOST" ]; then
        echo "Specify only one host." >&2
        exit 2
      fi
      TARGET_HOST="$1"
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

current_host="$(hostname)"
host="${TARGET_HOST:-$current_host}"
case "$host" in
  pc) host_dir="tobias-stationary" ;;
  laptop) host_dir="tobias-laptop" ;;
  *)
    echo "Unsupported native NixOS hostname: $host" >&2
    echo "For first setup, pass pc or laptop explicitly." >&2
    exit 1
    ;;
esac

hardware_config="$REPO_DIR/nixos/hosts/$host_dir/hardware-configuration.nix"
if grep -q "Bootstrap placeholder" "$hardware_config"; then
  generated_hardware_config="/etc/nixos/hardware-configuration.nix"
  if [ -z "$TARGET_HOST" ] || [ ! -f "$generated_hardware_config" ]; then
    echo "Refusing to rebuild with the placeholder hardware configuration: $hardware_config" >&2
    echo "Pass the target host explicitly on a generic NixOS installation." >&2
    exit 1
  fi
  if grep -q "Bootstrap placeholder" "$generated_hardware_config"; then
    echo "Generated hardware configuration is also a placeholder: $generated_hardware_config" >&2
    exit 1
  fi
  cp "$generated_hardware_config" "$hardware_config"
  log "Copied generated hardware configuration for $host"
fi

normalize_efi_mount() {
  local efi_device efi_fs_type

  [ -n "$TARGET_HOST" ] || return
  if findmnt -n --mountpoint /boot/efi >/dev/null 2>&1; then
    return
  fi

  efi_fs_type="$(findmnt -n -o FSTYPE --mountpoint /boot 2>/dev/null || true)"
  [ "$efi_fs_type" = "vfat" ] || return

  if ! grep -q 'fileSystems\."/boot\(/efi\)\?"' "$hardware_config"; then
    echo "The EFI partition is mounted at /boot, but $hardware_config has no matching filesystem entry." >&2
    exit 1
  fi

  efi_device="$(findmnt -n -o SOURCE --mountpoint /boot)"
  log "Moving the EFI mount from /boot to /boot/efi for the native GRUB configuration..."
  sudo umount /boot
  sudo mkdir -p /boot/efi
  if ! sudo mount "$efi_device" /boot/efi; then
    sudo mount "$efi_device" /boot || true
    echo "Could not mount $efi_device at /boot/efi; restored the /boot mount." >&2
    exit 1
  fi

  sed -i 's|fileSystems\."/boot"|fileSystems."/boot/efi"|' "$hardware_config"
  log "Mounted $efi_device at /boot/efi and updated the hardware configuration"
}

normalize_efi_mount

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

nix_config="${NIX_CONFIG:-}"
if [ -n "$nix_config" ]; then
  nix_config+=$'\n'
fi
nix_config+='experimental-features = nix-command flakes'

log "Building $host..."
NIX_CONFIG="$nix_config" nix build --no-link "$REPO_DIR/nixos#nixosConfigurations.$host.config.system.build.toplevel"

log "Switching $host..."
sudo env "NIX_CONFIG=$nix_config" nixos-rebuild switch --flake "$REPO_DIR/nixos#$host"

if [ "$current_host" != "$host" ]; then
  sudo hostname "$host"
  log "Updated runtime hostname to $host"
fi

if [ "$BOOTSTRAP" = true ]; then
  log "Refreshing developer tools and skill links..."
  bash "$REPO_DIR/scripts/bootstrap-developer-tools.sh"
fi

log "$host rebuild complete."
