output="DP-0"
physical_mode="1920x1080"
physical_rate="239.76"
stretched_width="1280"
stretched_height="960"

# Steam performs shader processing before invoking its launch wrapper. The CS2
# process and window each appeared within 5 seconds after wrapper invocation on
# 2026-08-22.
process_timeout_seconds=30
window_timeout_seconds=30

fail() {
  message="$1"
  echo "$message" >&2
  notify-send --urgency=critical "CS2 stretched" "$message" || true
  exit 1
}

if [[ "${XDG_SESSION_TYPE:-}" != "x11" ]]; then
  fail "cs2-stretched requires an X11 session; current session: ${XDG_SESSION_TYPE:-unset}"
fi

if [[ "${1:-}" != "--" || "$#" -lt 2 ]]; then
  fail "Usage: cs2-stretched -- <Steam game command>"
fi
shift

exec 9>"${XDG_RUNTIME_DIR:-/tmp}/cs2-stretched.lock"
if ! flock -n 9; then
  fail "cs2-stretched is already running"
fi

if pgrep -x cs2 >/dev/null; then
  fail "CS2 is already running; exit it before using cs2-stretched"
fi

output_line="$(xrandr --query | grep -m1 "^${output} connected" || true)"
if [[ -z "$output_line" ]]; then
  fail "CS2 display not found: output=${output}"
fi

geometry="$(grep -oE '[0-9]+x[0-9]+\+[0-9]+\+[0-9]+' <<<"$output_line" | head -n1)"
if [[ -z "$geometry" ]]; then
  fail "Could not read ${output} geometry from: ${output_line}"
fi

IFS='x+' read -r original_width original_height original_x original_y <<<"$geometry"
if [[ "$original_width" != "1920" || "$original_height" != "1080" ]]; then
  fail "CS2 display size mismatch: expected=1920x1080 actual=${original_width}x${original_height}"
fi

current_rate="$(
  xrandr --query | awk -v output="$output" '
    $1 == output { in_output = 1; next }
    in_output && /^[^ ]/ { exit }
    in_output && /\*/ {
      for (field = 2; field <= NF; field++) {
        if ($field ~ /\*/) {
          gsub(/[+*]/, "", $field)
          print $field
          exit
        }
      }
    }
  '
)"
if [[ "$current_rate" != "$physical_rate" ]]; then
  fail "CS2 display refresh mismatch: expected=${physical_rate}Hz actual=${current_rate:-unknown}Hz"
fi

original_compositing="$(xfconf-query -c xfwm4 -p /general/use_compositing)"
display_changed=false
compositor_changed=false
cs2_pid=""
game_wrapper_pid=""

cleanup() {
  status=$?
  trap - EXIT
  cleanup_failed=false

  if [[ "$display_changed" == true ]]; then
    if ! xrandr \
      --output "$output" \
      --mode "$physical_mode" \
      --rate "$physical_rate" \
      --scale 1x1 \
      --pos "${original_x}x${original_y}"; then
      echo "Failed to restore ${output}: mode=${physical_mode} rate=${physical_rate}Hz position=${original_x}x${original_y}" >&2
      cleanup_failed=true
    fi
  fi

  if [[ "$compositor_changed" == true ]]; then
    if ! xfconf-query -c xfwm4 -p /general/use_compositing -s "$original_compositing"; then
      echo "Failed to restore XFCE compositing: requested=${original_compositing}" >&2
      cleanup_failed=true
    fi
  fi

  if [[ "$cleanup_failed" == true && "$status" -eq 0 ]]; then
    status=1
  fi
  if [[ "$cleanup_failed" == true ]]; then
    notify-send --urgency=critical "CS2 stretched" "Desktop restoration failed; inspect the terminal output" || true
  fi
  exit "$status"
}
trap cleanup EXIT

terminate() {
  if [[ -n "$cs2_pid" ]] && kill -0 "$cs2_pid" 2>/dev/null; then
    kill "$cs2_pid"
  fi
  if [[ -n "$game_wrapper_pid" ]] && kill -0 "$game_wrapper_pid" 2>/dev/null; then
    kill "$game_wrapper_pid"
  fi
  exit 130
}
trap terminate INT TERM

if [[ "$original_compositing" != false ]]; then
  compositor_changed=true
  if ! xfconf-query -c xfwm4 -p /general/use_compositing -s false; then
    fail "Failed to disable XFCE compositing"
  fi
fi

display_changed=true
if ! xrandr \
  --output "$output" \
  --mode "$physical_mode" \
  --rate "$physical_rate" \
  --scale-from "${stretched_width}x${stretched_height}" \
  --pos "${original_x}x${original_y}"; then
  fail "Failed to apply CS2 display mode: output=${output} render=${stretched_width}x${stretched_height} physical=${physical_mode}@${physical_rate}Hz"
fi

"$@" &
game_wrapper_pid=$!

for ((waited = 0; waited < process_timeout_seconds; waited++)); do
  cs2_pid="$(pgrep -xo cs2 || true)"
  [[ -n "$cs2_pid" ]] && break
  if ! kill -0 "$game_wrapper_pid" 2>/dev/null; then
    wait "$game_wrapper_pid" || true
    fail "Steam's CS2 command exited before the game process started"
  fi
  sleep 1
done
if [[ -z "$cs2_pid" ]]; then
  fail "CS2 process launch timeout: limit=${process_timeout_seconds}s waited=${process_timeout_seconds}s"
fi

cs2_window=""
for ((waited = 0; waited < window_timeout_seconds; waited++)); do
  cs2_window="$(wmctrl -lx | awk '$3 == "cs2.cs2" { print $1; exit }')"
  [[ -n "$cs2_window" ]] && break
  sleep 1
done
if [[ -z "$cs2_window" ]]; then
  fail "CS2 window timeout: limit=${window_timeout_seconds}s waited=${window_timeout_seconds}s"
fi

if ! wmctrl -ir "$cs2_window" -b add,fullscreen; then
  fail "Failed to fullscreen the CS2 window: id=${cs2_window}"
fi

while kill -0 "$cs2_pid" 2>/dev/null; do
  sleep 1
done

wait "$game_wrapper_pid" || true
