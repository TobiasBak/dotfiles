#!/usr/bin/bash
# Exact autostarts audited on 2026-10-11:
# com.stremio.service.desktop launches the native GUI/service, conflicting with
# our direct server. stremio-service.desktop launches that server with the shim.
# Retire both only when they are the known files, never another customization.
set -euo pipefail

autostart="$HOME/.config/autostart"
declare -A known=(
  [com.stremio.service.desktop]=4d820f0130887bf72a7fe6249f2170a73befd3938f7ca8e40908a9561734ca7d
  [stremio-service.desktop]=608c8a38f733551caa8f47f0c6b79df820046bc73601593233ce56d71c92d273
)
pending=()
for name in com.stremio.service.desktop stremio-service.desktop; do
  path="$autostart/$name"
  [[ ! -e "$path" && ! -L "$path" ]] && continue
  if [[ ! -f "$path" || -L "$path" ]] ||
     [[ $(sha256sum -- "$path" | cut -d ' ' -f 1) != "${known[$name]}" ]]; then
    echo "Unrecognized Stremio autostart: $path; capture it before migrating." >&2
    exit 1
  fi
  pending+=("$name")
done

(( ${#pending[@]} )) || exit 0
backups="$HOME/.local/state/dotfiles/desktop/autostart"
mkdir -p -- "$backups"
for name in "${pending[@]}"; do
  backup="$backups/$name.bak.$(date -u +%Y%m%dT%H%M%S.%NZ)"
  [[ ! -e "$backup" && ! -L "$backup" ]]
  mv -- "$autostart/$name" "$backup"
  echo "Retired Stremio autostart: $autostart/$name (backup: $backup)"
done
