#!/usr/bin/env bash
set -euo pipefail

AUTHORIZED_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDcfYHFOxRxSQzxA9AixpvoJTW5xF16LVvIgkkBiEl5F tobias-nixos-wsl"
STATE_DIR="/var/lib/dotfiles-ssh-access"
SERVICE_NAME="dotfiles-ssh-access"

log() { printf '\033[0;36m[ssh-access]\033[0m %s\n' "$*"; }

if [ ! -f /etc/NIXOS ]; then
  echo "This script must be run on NixOS." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this script as the user who should receive SSH access, not root." >&2
  exit 1
fi

log "Authorizing the support key for $USER..."
install -d -m 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
if ! grep -qxF "$AUTHORIZED_KEY" "$HOME/.ssh/authorized_keys"; then
  printf '%s\n' "$AUTHORIZED_KEY" >> "$HOME/.ssh/authorized_keys"
fi

log "Preparing a temporary key-only SSH server..."
dropbear_bin="$(nix-shell -p dropbear --run 'command -v dropbear')"
dropbearkey_bin="$(nix-shell -p dropbear --run 'command -v dropbearkey')"
iptables_bin="$(nix-shell -p iptables --run 'command -v iptables')"

sudo install -d -m 700 "$STATE_DIR"
if ! sudo test -f "$STATE_DIR/ssh_host_ed25519_key"; then
  sudo "$dropbearkey_bin" -t ed25519 -f "$STATE_DIR/ssh_host_ed25519_key" >/dev/null
fi

if ! ss -H -ltn 'sport = :22' | grep -q .; then
  sudo systemctl stop "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  sudo systemd-run \
    --unit="$SERVICE_NAME" \
    --description="Temporary key-only SSH access" \
    --collect \
    "$dropbear_bin" -F -E -w -s -p 22 -r "$STATE_DIR/ssh_host_ed25519_key" \
    >/dev/null
fi

if ! sudo "$iptables_bin" -C INPUT -p tcp --dport 22 -j ACCEPT >/dev/null 2>&1; then
  sudo "$iptables_bin" -I INPUT 1 -p tcp --dport 22 -j ACCEPT
fi

sleep 1
if ! ss -H -ltn 'sport = :22' | grep -q .; then
  echo "The temporary SSH server did not start." >&2
  sudo systemctl status "$SERVICE_NAME.service" --no-pager >&2 || true
  exit 1
fi

local_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([^ ]*\).*/\1/p' | head -n 1)"
if [ -z "$local_ip" ]; then
  local_ip="$(hostname -I | awk '{print $1}')"
fi

log "Temporary SSH access is ready for $USER on port 22. It will stop at reboot."
printf 'Local IP address: %s\n' "$local_ip"
