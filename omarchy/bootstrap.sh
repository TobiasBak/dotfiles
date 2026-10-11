#!/usr/bin/env bash
# Set up the pc under Omarchy: host packages, Nix, Home Manager, Tailscale,
# T3 Code's per-user service and TPM2 unlock support. Run as tobias from a
# checkout of this repository; it uses sudo where needed and is safe to rerun.
#
#   omarchy/bootstrap.sh          # everything except the initramfs
#   omarchy/bootstrap.sh --tpm2   # also switch to the TPM2-capable initramfs
#
# Steps that need a human (logins, the LUKS passphrase) are printed at the end
# and make the script exit 2 until they are done.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
DATA_DIR=/mnt/data-2tb
LUKS_NAME=omarchy_root
# T3 pins the version it installs; later updates go through `t3 update`.
T3_VERSION="${T3_VERSION:-nightly}"

tpm2=false
case "${1:-}" in
  "") ;;
  --tpm2) tpm2=true ;;
  *) echo "Usage: $0 [--tpm2]" >&2; exit 2 ;;
esac

log() { printf '\033[0;36m[omarchy]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[omarchy]\033[0m %s\n' "$*" >&2; exit 1; }
manual=()
needs_human() { manual+=("$*"); }

[ "$(id -u)" -ne 0 ] || die "run as your user, not root"
. /etc/os-release
[ "${ID:-}" = omarchy ] || die "this is ${PRETTY_NAME:-not Omarchy}; use the NixOS or WSL entrypoint instead"
# Omarchy's commands need its environment, which non-login shells lack.
. /usr/share/omarchy/default/bash/env-bootstrap

# Home Manager links every repository file through ~/.dotfiles.
if [ "$(readlink -f "$HOME/.dotfiles" 2>/dev/null)" != "$REPO_DIR" ]; then
  if [ -e "$HOME/.dotfiles" ] && [ ! -L "$HOME/.dotfiles" ]; then
    die "$HOME/.dotfiles exists and is not a symlink; move it aside"
  fi
  ln -sfn "$REPO_DIR" "$HOME/.dotfiles"
  log "Linked ~/.dotfiles -> $REPO_DIR"
fi

mapfile -t packages < <(grep -Ev '^[[:space:]]*(#|$)' "$SCRIPT_DIR/packages.txt")
if omarchy-pkg-missing "${packages[@]}"; then
  # Omarchy blocks direct `pacman -Syu`; its update syncs and upgrades first,
  # so the install below is never a partial upgrade.
  log "Updating Omarchy before installing $(echo $(pacman -T "${packages[@]}" || true))"
  omarchy-update -y
  omarchy-pkg-add "${packages[@]}"
fi

# Nix comes from pacman as a multi-user daemon whose socket every user may use.
# Its store gets its own Btrfs subvolume so Snapper's root snapshots skip it.
if [ "$(stat -f -c %T /nix)" = btrfs ] && [ "$(stat -c %i /nix)" != 256 ]; then
  [ ! -e /nix/store ] || die "/nix/store exists outside a subvolume; move it aside first"
  sudo systemctl stop nix-daemon.socket nix-daemon.service
  sudo mv /nix /nix.pacman
  sudo btrfs subvolume create /nix >/dev/null
  sudo cp -a /nix.pacman/. /nix/
  sudo rm -rf /nix.pacman
  log "Moved /nix onto its own Btrfs subvolume"
fi
if [ ! -d /nix/store ]; then
  sudo install -d -m 1775 -o root -g nixbld /nix/store
fi
if ! grep -qE '^experimental-features *=.*flakes' /etc/nix/nix.conf; then
  echo 'experimental-features = nix-command flakes' | sudo tee -a /etc/nix/nix.conf >/dev/null
  sudo systemctl try-restart nix-daemon.service
fi
sudo systemctl enable --now nix-daemon.socket

# Untested on Omarchy past this point: the VM proof stopped while this build ran.
log "Activating Home Manager (tobias@omarchy)"
generation="$(nix build --no-link --print-out-paths \
  "$REPO_DIR/nixos#homeConfigurations.\"tobias@omarchy\".activationPackage")"
HOME_MANAGER_BACKUP_EXT=pre-home-manager "$generation/activate"
PATH="$HOME/.nix-profile/bin:$PATH"

if [ "$(getent passwd "$USER" | cut -d: -f7)" != /usr/bin/zsh ]; then
  sudo chsh -s /usr/bin/zsh "$USER"
  log "Login shell is now zsh"
fi

sudo systemctl enable --now tailscaled.service
sudo tailscale set --operator="$USER"
if ! tailscale status >/dev/null 2>&1; then
  needs_human "Join the tailnet: sudo tailscale up (or migrate-home.sh --tailscale at cut-over)"
fi

# T3 Code runs from the user manager, which must start at boot without a login.
sudo loginctl enable-linger "$USER"
# T3 Code is reachable from localhost and the Tailnet, but not the LAN.
sudo ufw allow in on tailscale0 to any port 3773 proto tcp comment 'T3 Code' >/dev/null

# Orderready's worktrees keep the path they had on the NixOS data disk, which
# T3's database records. Omarchy has no data disk, so it is a plain directory.
if [ ! -O "$DATA_DIR" ]; then
  sudo install -d -o "$USER" -g "$(id -gn)" "$DATA_DIR"
fi

bash "$REPO_DIR/scripts/bootstrap-developer-tools.sh"

if ! systemctl --user cat t3code.service >/dev/null 2>&1; then
  log "Installing T3 Code's background service (t3@$T3_VERSION)"
  npx --yes "t3@$T3_VERSION" service install
fi

if $tpm2; then
  # Untested: the systemd initramfs and TPM2 unlock never booted in the VM.
  # Replace the busybox initramfs with systemd's so sd-encrypt can unlock the
  # root with the TPM. Without an enrolled TPM it still asks for the passphrase.
  regenerate=false
  hooks=/etc/mkinitcpio.conf.d/zz-tpm2-unlock.conf
  if ! cmp -s "$SCRIPT_DIR/mkinitcpio-tpm2.conf" "$hooks"; then
    sudo install -m 0644 "$SCRIPT_DIR/mkinitcpio-tpm2.conf" "$hooks"
    regenerate=true
  fi
  # The installer writes crypttab.initramfs; sd-encrypt reads it from the initramfs.
  if ! sudo awk -v name="$LUKS_NAME" '$1 == name && $4 ~ /tpm2-device=auto/ { found = 1 } END { exit !found }' /etc/crypttab.initramfs; then
    sudo sed -i -E "/^$LUKS_NAME[[:space:]]/ s/([[:space:]]+)([^[:space:]]+)\$/\1\2,tpm2-device=auto/" /etc/crypttab.initramfs
    sudo awk -v name="$LUKS_NAME" '$1 == name && $4 ~ /tpm2-device=auto/ { found = 1 } END { exit !found }' /etc/crypttab.initramfs ||
      die "/etc/crypttab.initramfs has no $LUKS_NAME line to extend"
    regenerate=true
  fi
  if $regenerate; then
    log "Rebuilding the initramfs and boot entries"
    sudo limine-mkinitcpio
  fi
  luks_device="$(sudo cryptsetup status "$LUKS_NAME" | awk '$1 == "device:" { print $2 }')"
  if ! sudo cryptsetup luksDump "$luks_device" | grep -q systemd-tpm2; then
    needs_human "Unlock the disk with the TPM at boot (asks for the LUKS passphrase): sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=7 $luks_device"
  fi
else
  log "Skipped the TPM2 initramfs; rerun with --tpm2 once the rest works."
fi

[ -f "$HOME/.config/restic/t3-password" ] ||
  needs_human "Restore ~/.config/restic/t3-password for the nightly T3 backup (migrate-home.sh copies it)"
gh auth status >/dev/null 2>&1 || needs_human "Sign in to GitHub: gh auth login"

log "T3 Code: $(systemctl --user is-active t3code.service)"
if [ "${#manual[@]}" -gt 0 ]; then
  log "Remaining manual steps, then rerun this script:"
  printf '  - %s\n' "${manual[@]}"
  log "Agent CLIs (claude, codex, pi) ask you to sign in on first use."
  exit 2
fi
log "Bootstrap complete."
