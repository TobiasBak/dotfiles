#!/usr/bin/env bash
# Set up the pc under Omarchy: host packages, Nix, Home Manager, mise tools,
# Tailscale, T3 Code (nightly desktop app and per-user service) and TPM2 unlock
# support. Run as the desktop user from a checkout of this repository; it uses
# sudo where needed and is safe to rerun.
#
#   omarchy/bootstrap.sh          # everything except the initramfs
#   omarchy/bootstrap.sh --tpm2   # also switch to the TPM2-capable initramfs
#
# Steps that need a human (logins, the LUKS passphrase) are printed at the end
# and make the script exit 2 until they are done.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

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
# The flake has one Home Manager configuration per user, homed at /home/<user>.
USER="$(id -un)"
[ "$HOME" = "/home/$USER" ] || die "HOME is $HOME; the Home Manager configuration expects /home/$USER"
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
  missing="$(pacman -T "${packages[@]}" || true)"
  log "Updating Omarchy before installing ${missing//$'\n'/ }"
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
log "Activating Home Manager ($USER@omarchy)"
generation="$(nix build --no-link --print-out-paths \
  "$REPO_DIR/nixos#homeConfigurations.\"$USER@omarchy\".activationPackage")"
# Home Manager backs up colliding files, but it cannot force a link over a real
# directory. Omarchy creates these two; move them aside once.
for dir in .config/tmux .claude/skills; do
  if [ -d "$HOME/$dir" ] && [ ! -L "$HOME/$dir" ]; then
    [ ! -e "$HOME/$dir.pre-home-manager" ] || die "$HOME/$dir.pre-home-manager exists; merge or remove it first"
    mv "$HOME/$dir" "$HOME/$dir.pre-home-manager"
    log "Moved ~/$dir aside to ~/$dir.pre-home-manager"
  fi
done
HOME_MANAGER_BACKUP_EXT=pre-home-manager "$generation/activate"
PATH="$HOME/.nix-profile/bin:$PATH"

if [ "$(getent passwd "$USER" | cut -d: -f7)" != /usr/bin/zsh ]; then
  sudo chsh -s /usr/bin/zsh "$USER"
  log "Login shell is now zsh"
fi

sudo systemctl enable --now tailscaled.service
sudo tailscale set --operator="$USER"
if ! tailscale status >/dev/null 2>&1; then
  needs_human "Join the tailnet under this machine's hostname: sudo tailscale up"
fi

# T3 Code runs from the user manager, which must start at boot without a login.
sudo loginctl enable-linger "$USER"
# T3 Code is reachable from localhost and the Tailnet, but not the LAN.
sudo ufw allow in on tailscale0 to any port 3773 proto tcp comment 'T3 Code' >/dev/null

# mise owns the developer CLIs and installs npm-based ones with pnpm. Omarchy
# also writes the global mise config, so change it only through mise.
# Omarchy's wrappers likewise skip mise's release cooldown for these tools.
mise settings set npm.package_manager pnpm
MISE_MINIMUM_RELEASE_AGE=0 mise use --global --quiet \
  pnpm@latest claude@latest codex@latest pi@latest opencode@latest

# Agent skills come from the vault, cloned next to this repository.
vault_dir="$(dirname "$REPO_DIR")/vault-public"
if [ ! -e "$vault_dir" ]; then
  git clone https://github.com/TobiasBak/vault-public.git "$vault_dir"
fi
bash "$vault_dir/scripts/install-skills.sh" --fix >/dev/null

# T3 Code. The background service owns the server: port 3773, Tailscale Serve
# and the state in ~/.t3/userdata. The desktop app is the upstream nightly from
# the AUR and only connects to it; its own backend would fight the service over
# the port and the database. The app holds those files while it runs, so the
# steps that change them wait until it is closed.
t3_desktop_running=false
if pgrep -u "$(id -u)" -f '^(/usr/lib/t3code[^/]*|/opt/t3code-nightly-bin)/' >/dev/null; then
  t3_desktop_running=true
fi

# The Omarchy repository carries a t3code-nightly-bin too, older than the AUR's.
# Take the AUR build when it is newer than what is installed. It conflicts with
# the stable t3code-bin, which pacman cannot remove unattended, so remove that
# first.
aur_t3="$(yay -Si aur/t3code-nightly-bin 2>/dev/null | awk -F': *' '$1 ~ /^Version/ { print $2 }')"
installed_t3="$(pacman -Q t3code-nightly-bin 2>/dev/null | awk '{ print $2 }')"
if [ -n "$aur_t3" ] && { [ -z "$installed_t3" ] || [ "$(vercmp "$aur_t3" "$installed_t3")" -gt 0 ]; }; then
  if $t3_desktop_running; then
    if [ -z "$installed_t3" ]; then
      needs_human "Quit the T3 Code desktop app, then rerun this script to install T3 Code Nightly"
    else
      log "T3 Code Nightly $aur_t3 is in the AUR; quit the app and rerun to update it."
    fi
  else
    if pacman -Q t3code-bin >/dev/null 2>&1; then
      sudo pacman -R --noconfirm t3code-bin
    fi
    log "Installing T3 Code Nightly $aur_t3 from the AUR"
    yay -S --noconfirm --answerdiff None --answerclean None aur/t3code-nightly-bin
  fi
elif [ -z "$aur_t3" ] && [ -z "$installed_t3" ]; then
  needs_human "Could not reach the AUR for t3code-nightly-bin; rerun this script"
fi

t3_settings="$HOME/.t3/userdata/desktop-settings.json"
if [ "$(jq -r '.localEnvironmentEnabled' "$t3_settings" 2>/dev/null)" != false ]; then
  if $t3_desktop_running; then
    needs_human "Quit the T3 Code desktop app, then rerun this script so the app stops starting its own server"
  else
    mkdir -p "$(dirname "$t3_settings")"
    staged="$(mktemp "$t3_settings.XXXXXX")"
    if [ -s "$t3_settings" ]; then
      jq '.localEnvironmentEnabled = false' "$t3_settings" >"$staged"
    else
      echo '{"localEnvironmentEnabled":false}' >"$staged"
    fi
    mv "$staged" "$t3_settings"
    log "The T3 Code desktop app no longer starts its own server"
  fi
fi

if [ -f "$HOME/.config/systemd/user/t3code.service" ]; then
  bash "$SCRIPT_DIR/t3-nightly.sh"
elif ss -Hltn 'sport = :3773' | grep -q .; then
  needs_human "Something other than t3code.service listens on port 3773 (ss -ltnp 'sport = :3773'); stop it, then rerun"
else
  bash "$SCRIPT_DIR/t3-nightly.sh" --install-service
fi
systemctl --user start t3code-update.timer

if $tpm2; then
  # Untested: the systemd initramfs and TPM2 unlock never booted in the VM.
  # Replace the busybox initramfs with systemd's so sd-encrypt can unlock the
  # root with the TPM. Without an enrolled TPM it still asks for the passphrase.
  # busybox's encrypt hook reads cryptdevice= from the kernel command line;
  # sd-encrypt reads only crypttab.initramfs. The installer's layouts differ
  # (Full disk maps "root" with no crypttab), so take the mapping from the
  # running system and write the entry before switching hooks.
  root_source="$(findmnt -nvo SOURCE /)"
  case "$root_source" in
    /dev/mapper/*) luks_name="${root_source#/dev/mapper/}" ;;
    *) die "/ is on $root_source, not a LUKS mapping" ;;
  esac
  luks_device="$(sudo cryptsetup status "$luks_name" | awk '$1 == "device:" { print $2 }')"
  sudo cryptsetup isLuks "$luks_device" || die "$luks_device (behind $root_source) is not LUKS"
  luks_uuid="$(sudo cryptsetup luksUUID "$luks_device")"
  # The kernel's root= must keep naming the mapping sd-encrypt creates.
  root_arg="$(tr ' ' '\n' </proc/cmdline | sed -n 's/^root=//p')"
  case "$root_arg" in
    "$root_source" | UUID=* | PARTUUID=*) ;;
    *) die "kernel root=$root_arg does not match $root_source; leaving the initramfs alone" ;;
  esac
  crypttab=/etc/crypttab.initramfs
  entry="$luks_name UUID=$luks_uuid none luks,discard,tpm2-device=auto"
  regenerate=false
  if ! sudo grep -qxF "$entry" "$crypttab" 2>/dev/null; then
    staged="$(mktemp)"
    { sudo awk -v name="$luks_name" '$1 != name' "$crypttab" 2>/dev/null || true; echo "$entry"; } >"$staged"
    sudo install -m 0600 "$staged" "$crypttab"
    rm -f "$staged"
    regenerate=true
  fi
  # Validate before the hooks change: the entry must resolve to the device
  # that holds the running root.
  [ "$(sudo awk -v name="$luks_name" '$1 == name' "$crypttab" | wc -l)" -eq 1 ] ||
    die "$crypttab must have exactly one $luks_name line"
  [ "$(readlink -f "/dev/disk/by-uuid/$luks_uuid")" = "$(readlink -f "$luks_device")" ] ||
    die "UUID=$luks_uuid does not resolve to $luks_device; leaving the initramfs alone"
  hooks=/etc/mkinitcpio.conf.d/zz-tpm2-unlock.conf
  if ! cmp -s "$SCRIPT_DIR/mkinitcpio-tpm2.conf" "$hooks"; then
    sudo install -m 0644 "$SCRIPT_DIR/mkinitcpio-tpm2.conf" "$hooks"
    regenerate=true
  fi
  if $regenerate; then
    log "Rebuilding the initramfs and boot entries for $luks_name (UUID=$luks_uuid)"
    if ! sudo limine-mkinitcpio; then
      sudo rm -f "$hooks"
      sudo limine-mkinitcpio || true
      die "limine-mkinitcpio failed; removed $hooks and rebuilt with the old hooks"
    fi
  fi
  if ! sudo cryptsetup luksDump "$luks_device" | grep -q systemd-tpm2; then
    needs_human "Unlock the disk with the TPM at boot (asks for the LUKS passphrase): sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=7 $luks_device"
  fi
else
  log "Skipped the TPM2 initramfs; rerun with --tpm2 once the rest works."
fi

[ -f "$HOME/.config/restic/t3-password" ] ||
  needs_human "Restore ~/.config/restic/t3-password for the nightly T3 backup (cold storage: /home/tobias/.config/restic on the NixOS root), and give this user an SSH key tobias@tobias-serv01 accepts"
gh auth status >/dev/null 2>&1 || needs_human "Sign in to GitHub: gh auth login"

log "T3 Code: $(systemctl --user is-active t3code.service)"
if [ "${#manual[@]}" -gt 0 ]; then
  log "Remaining manual steps, then rerun this script:"
  printf '  - %s\n' "${manual[@]}"
  log "Agent CLIs (claude, codex, pi) ask you to sign in on first use."
  exit 2
fi
log "Bootstrap complete."
