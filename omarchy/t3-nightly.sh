#!/usr/bin/env bash
# Move T3 Code's CLI and its background service to the newest nightly. The
# t3code-update timer runs this daily; bootstrap.sh runs it with
# --install-service the first time. Safe to rerun: when nothing changed it
# installs nothing and leaves the service running.
#
# The CLI is the mise tool npm:t3, which mise installs with pnpm. pnpm 11 holds
# back releases younger than its minimum release age when asked for a tag, so
# resolve the nightly dist-tag here and install that exact version.
#
# The service does not run the CLI's copy: `t3 service install` and
# `t3 update` download the release into ~/.t3/runtime/versions and point
# t3code.service at it. `t3 update <version> --yes` returns early when the
# service already runs that version and restarts it only after a change.
set -euo pipefail

install_service=false
case "${1:-}" in
  "") ;;
  --install-service) install_service=true ;;
  *) echo "Usage: $0 [--install-service]" >&2; exit 2 ;;
esac

log() { printf '[t3-nightly] %s\n' "$*"; }
die() { printf '[t3-nightly] %s\n' "$*" >&2; exit 1; }

cd "$HOME"
# Omarchy's mise wrappers do the same: the version is chosen explicitly.
export MISE_MINIMUM_RELEASE_AGE=0
t3="$HOME/.local/share/mise/shims/t3"
cli_version() { "$t3" --version 2>/dev/null | sed -n 's/^t3 v//p'; }

# mise installs npm tools with the configured Node and pnpm, so make sure both exist.
mise install --quiet node pnpm
version="$(mise exec pnpm -- pnpm view t3 dist-tags.nightly)"
case "$version" in
  [0-9]*-nightly.*) ;;
  *) die "unexpected t3 nightly dist-tag: '$version'" ;;
esac

current="$(cli_version || true)"
if [ "$current" != "$version" ]; then
  log "CLI ${current:-not installed} -> $version"
  mise use --global --quiet "npm:t3@$version"
  [ "$(cli_version)" = "$version" ] ||
    die "$t3 reports '$(cli_version)', not $version, after installing it"
  if [ -n "$current" ]; then
    mise uninstall "npm:t3@$current" >/dev/null || true
  fi
fi

# T3 writes the unit itself; Home Manager supplies only a drop-in, which
# alone would make `systemctl --user cat t3code.service` succeed.
if [ -f "$HOME/.config/systemd/user/t3code.service" ]; then
  "$t3" update "$version" --yes
elif $install_service; then
  log "Installing T3 Code's background service (t3@$version)"
  "$t3" service install
else
  log "No t3code.service installed; omarchy/bootstrap.sh installs it."
fi
