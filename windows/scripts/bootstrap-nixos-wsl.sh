#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REAL_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
BOOTSTRAP_SCRIPT="$REAL_REPO_DIR/scripts/bootstrap-developer-tools.sh"

# Windows interop can put Windows npm/Codex ahead of the native NixOS tools.
# Keep this wrapper at the path used by the Windows installer, but delegate
# the portable developer-tool work to the repository-level bootstrap.
is_wsl_windows_path() {
  case "$1" in
    /mnt/[A-Za-z]/*) return 0 ;;
    *) return 1 ;;
  esac
}

remove_wsl_windows_path() {
  local old_ifs entry filtered_path
  old_ifs="$IFS"
  filtered_path=""
  IFS=:

  for entry in $PATH; do
    if [ -z "$entry" ] || is_wsl_windows_path "$entry"; then
      continue
    fi

    if [ -n "$filtered_path" ]; then
      filtered_path="$filtered_path:$entry"
    else
      filtered_path="$entry"
    fi
  done

  IFS="$old_ifs"
  PATH="$HOME/.local/bin:$HOME/bin:$filtered_path"
  export PATH
}

remove_wsl_windows_path

if [ ! -f "$BOOTSTRAP_SCRIPT" ]; then
  printf 'Missing developer-tool bootstrap: %s\n' "$BOOTSTRAP_SCRIPT" >&2
  exit 1
fi

exec bash "$BOOTSTRAP_SCRIPT" "$@"
