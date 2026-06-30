#!/usr/bin/env bash
set -euo pipefail

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "powershell.exe not found. Run this from WSL on Windows." >&2
  exit 1
fi

if ! command -v wslpath >/dev/null 2>&1; then
  echo "wslpath not found. Run this from WSL." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
setup_ps1="$(wslpath -w "$script_dir/setup.ps1")"
escaped_setup="$(printf '%s' "$setup_ps1" | sed "s/'/''/g")"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "\$ErrorActionPreference = 'Stop'; \$setup = '$escaped_setup'; Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', \$setup) -Verb RunAs -Wait"
