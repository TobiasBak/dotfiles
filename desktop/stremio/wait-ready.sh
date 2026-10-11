#!/usr/bin/bash
# ExecStartPost keeps systemd's start job pending until this server is ready.
# Socket ownership prevents an unrelated pre-existing server passing readiness.
set -euo pipefail
pid=${1:?expected Stremio MainPID}
[[ $pid =~ ^[0-9]+$ && $pid -gt 0 ]]
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  [[ -d /proc/$pid ]] || break
  if /usr/bin/ss -H -ltnp 'sport = :11470' | /usr/bin/grep -q "pid=$pid," &&
     /usr/bin/curl --fail --silent --max-time 1 http://127.0.0.1:11470/settings >/dev/null; then
    exit 0
  fi
  sleep 0.2
done

echo "Stremio PID $pid did not own a responding endpoint within 20 seconds." >&2
/usr/bin/ss -ltnp 'sport = :11470' >&2
exit 1
