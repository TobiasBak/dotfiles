#!/usr/bin/env bash
# Nightly restic backup of T3, Pi and Orderready's irreplaceable data to serv01.
set -euo pipefail

export RESTIC_REPOSITORY="sftp:tobias@tobias-serv01:/srv/nas/files/.backups/t3-pc"
export RESTIC_PASSWORD_FILE="$HOME/.config/restic/t3-password"
state="$HOME/.local/state/t3-backup"
orderready="$HOME/.local/share/orderready"

# T3 keeps its database open, so back up a consistent copy instead. VACUUM INTO
# reads one snapshot; .backup restarts on every T3 write and never finishes.
# The unit's ExecStopPost removes the copy; clear leftovers from manual runs.
rm -rf "$state"
install -d -m 0700 "$state"
sqlite3 -readonly "$HOME/.t3/userdata/statev2.sqlite" "VACUUM INTO '$state/statev2.sqlite'"
cp -L "$HOME/.pi/agent/settings.json" "$state/pi-settings.json"
cp -L "$HOME/.pi/agent/APPEND_SYSTEM.md" "$state/pi-APPEND_SYSTEM.md"

restic backup --host pc --tag t3 \
  --exclude "$HOME/.t3/userdata/state*.sqlite*" \
  --exclude "$HOME/.t3/userdata/logs" \
  --exclude "$HOME/.t3/userdata/usage-*cache*.json" \
  --exclude "$HOME/.t3/userdata/model-manifest.json" \
  --exclude "$HOME/.pi/agent/bin" \
  "$state" "$HOME/.t3/userdata" "$HOME/.pi/agent"

# Customer data: the content-addressed fixture store and the corpus. A missing
# tree means moved or lost data; empty snapshots would age out the good ones.
for dir in "$orderready/fixtures" "$orderready/corpus"; do
  [[ -d $dir ]] || { echo "missing $dir" >&2; exit 1; }
done
restic backup --host pc --tag orderready "$orderready/fixtures" "$orderready/corpus"

# A week of dailies for recent mistakes, four weeklies for about a month of rollback.
restic forget --prune --keep-daily 7 --keep-weekly 4
restic check --with-cache
