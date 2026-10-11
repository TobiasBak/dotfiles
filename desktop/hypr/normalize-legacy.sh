#!/usr/bin/bash
# One persisted migration, audited against installed Omarchy templates on 2026-10-11.
# monitors.lua differs only by the HDMI-A-1/DP-1 calls now in dotfiles.lua and comments.
# looknfeel.lua differs only by uncommenting the animations.enabled=false block.
# These hashes identify those exact legacy files, not arbitrary user overrides.
set -euo pipefail

defaults="${OMARCHY_PATH:-/usr/share/omarchy}/config/hypr"
live="$HOME/.config/hypr"
declare -A known=(
  [monitors.lua]=5834eb4fa4b32d7cc8fc5faba634874d53c48b5f4722d4a7881b46d215acbe28
  [looknfeel.lua]=7cebe08a98b62313f983a03a15512d246f792a1fe287e204178ec81a472a317b
)
pending=()
# Preflight both files before changing either. Unknown deltas remain capture drift.
for name in monitors.lua looknfeel.lua; do
  [[ -f "$defaults/$name" ]] || { echo "Missing Omarchy template: $defaults/$name" >&2; exit 1; }
  cmp -s -- "$defaults/$name" "$live/$name" && continue
  if [[ ! -f "$live/$name" || -L "$live/$name" ]] ||
     [[ $(sha256sum -- "$live/$name" | cut -d ' ' -f 1) != "${known[$name]}" ]]; then
    echo "Unrecognized customization: $live/$name; capture it before normalizing." >&2
    exit 1
  fi
  pending+=("$name")
done

for name in "${pending[@]}"; do
  backup="$live/$name.bak.$(date -u +%Y%m%dT%H%M%S.%NZ)"
  [[ ! -e "$backup" && ! -L "$backup" ]]
  cp -p -- "$live/$name" "$backup"
  cp -- "$defaults/$name" "$live/$name"
  echo "Restored Omarchy template: $live/$name (backup: $backup)"
done
