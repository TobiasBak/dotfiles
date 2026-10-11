#!/usr/bin/env bash
# Copy Tobias's agent state, code, credentials and the parked Orderready
# worktrees from the NixOS root into this Omarchy install, at the same paths.
# Run as tobias after bootstrap.sh, with the NixOS root mounted read-only and
# without journal replay. It runs once: a rerun would overwrite work done on
# Omarchy since, so it refuses unless given --force.
#
#   sudo mount -o ro,noload /dev/<NixOS root partition> /mnt/nixos
#   omarchy/migrate-home.sh --source /mnt/nixos [--tailscale] [--force]
#
# --tailscale also takes over NixOS's Tailscale identity, so this install
# becomes the tailnet's "pc". Do it once, at cut-over.
#
# Untested: never run end to end; check each copy as it goes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
TAILSCALE_STATE=var/lib/tailscale/tailscaled.state
MARKER="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/migrate-home.done"
# Orderready's worktrees, parked in the NixOS home before the data disk was
# wiped. They return to the path they had there, which T3's database records.
ORDERREADY_PARK=orderready-park
ORDERREADY=/mnt/data-2tb/orderready
# Paths relative to the home directory. Agent configs that Home Manager links
# are skipped below and relinked by the activation at the end.
paths=(
  .t3
  .pi
  .claude
  .claude.json
  .codex
  .agents
  code
  .cache/orderready
  .ssh
  .config/gh/hosts.yml
  .config/restic
)

usage() { echo "Usage: $0 --source <read-only NixOS root> [--tailscale] [--force]" >&2; exit 2; }
log() { printf '\033[0;36m[migrate]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[migrate]\033[0m %s\n' "$*" >&2; exit 1; }

source_root=""
tailscale=false
force=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || usage; source_root="${2%/}"; shift ;;
    --tailscale) tailscale=true ;;
    --force) force=true ;;
    *) usage ;;
  esac
  shift
done
[ -n "$source_root" ] || usage

[ "$(id -u)" -ne 0 ] || die "run as your user, not root"
if [ -e "$MARKER" ] && ! $force; then
  die "already migrated on $(cat "$MARKER"); a rerun overwrites changes made here since. Pass --force to do it anyway"
fi
[ -e "$source_root/etc/NIXOS" ] || die "$source_root is not a NixOS root"
# ext4 replays its journal even on a read-only mount unless told not to.
source_options="$(findmnt -no OPTIONS --target "$source_root" | tr , '\n')"
grep -qx ro <<<"$source_options" && grep -qxE 'noload|norecovery' <<<"$source_options" ||
  die "$source_root must be mounted with -o ro,noload"
source_home="$source_root$HOME"
[ -d "$source_home" ] || die "$source_home does not exist"

# T3 keeps SQLite state under ~/.t3; copy it only while the server is down.
systemctl --user stop t3code.service

# The NixOS Home Manager's links point into a Nix store this system lacks.
excludes="$(mktemp)"
trap 'rm -f "$excludes"' EXIT
(cd "$source_home" && find "${paths[@]}" -type l -lname '/nix/store/*' 2>/dev/null) | sed 's|^|/|' >"$excludes"
# Bootstrap installs T3's runtime for this system.
echo /.t3/runtime/ >>"$excludes"

for path in "${paths[@]}"; do
  if [ ! -e "$source_home/$path" ] && [ ! -L "$source_home/$path" ]; then
    log "Skipping $path (not on the source)"
    continue
  fi
  log "Copying ~/$path"
  mkdir -p "$(dirname "$HOME/$path")"
  # Relative paths keep the exclude list anchored at the home directory.
  (cd "$source_home" && rsync -aHAX --relative --exclude-from="$excludes" "./$path" "$HOME/")
done

if [ -d "$source_home/$ORDERREADY_PARK" ]; then
  log "Restoring ~/$ORDERREADY_PARK to $ORDERREADY"
  # bootstrap.sh creates /mnt/data-2tb owned by this user.
  rsync -aHAX --filter="merge $SCRIPT_DIR/orderready.rsync-filter" "$source_home/$ORDERREADY_PARK/" "$ORDERREADY/"
else
  log "Skipping $ORDERREADY (~/$ORDERREADY_PARK is not on the source)"
fi

# Home-level links Tobias made by hand, such as ~/vault.
while IFS= read -r -d '' link; do
  name="${link##*/}"
  target="$(readlink "$link")"
  case "$target" in /nix/store/*) continue ;; esac
  if [ ! -e "$HOME/$name" ] && [ ! -L "$HOME/$name" ]; then
    ln -s "$target" "$HOME/$name"
    log "Linked ~/$name -> $target"
  fi
done < <(find "$source_home" -maxdepth 1 -type l -print0)

if $tailscale; then
  [ -f "$source_root/$TAILSCALE_STATE" ] || die "$source_root/$TAILSCALE_STATE does not exist"
  log "Taking over NixOS's Tailscale identity"
  sudo systemctl stop tailscaled.service
  sudo install -D -m 0600 "$source_root/$TAILSCALE_STATE" "/$TAILSCALE_STATE"
  sudo systemctl start tailscaled.service
  sudo tailscale set --operator="$USER"
fi

# Restore the links the copies replaced and restart the user units.
bash "$SCRIPT_DIR/bootstrap.sh" || [ "$?" -eq 2 ]
systemctl --user restart t3code.service
mkdir -p "$(dirname "$MARKER")"
date -Is >"$MARKER"
log "Done. T3 Code: $(systemctl --user is-active t3code.service)"
