#!/usr/bin/bash
set -euo pipefail
bash "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/migrate-autostart.sh"

# Do not start a second server or kill the first. Keep its PID/command in the
# journal so the first-apply handoff can be made explicitly by the operator.
listeners=$(/usr/bin/ss -H -ltnp 'sport = :11470')
if [[ -n "$listeners" ]]; then
  echo "Stremio port 11470 is already occupied; stop the existing server explicitly before applying desktop." >&2
  printf '%s\n' "$listeners" >&2
  exit 1
fi
