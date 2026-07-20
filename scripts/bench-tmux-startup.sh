#!/usr/bin/env bash
set -euo pipefail

iterations="${1:-25}"
tmux_conf="${TMUX_CONF:-$HOME/.config/tmux/tmux.conf}"
session_prefix="dotfiles-bench-$$"
socket_name="$session_prefix"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found on PATH" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found on PATH" >&2
  exit 1
fi

time_ms() {
  local start end
  start="$(date +%s%N)"
  "$@" >/dev/null 2>&1
  end="$(date +%s%N)"
  echo $(((end - start) / 1000000))
}

cleanup() {
  tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
}
trap cleanup EXIT

measure() {
  local name="$1"
  local results
  shift

  results="$(mktemp)"
  echo "## $name"
  for i in $(seq 1 "$iterations"); do
    "$@"
  done >"$results"

  python3 - "$results" <<'PY'
import statistics
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    values = [int(line.strip()) for line in handle if line.strip()]
values.sort()
if not values:
    raise SystemExit("no measurements collected")

def percentile(sorted_values, pct):
    index = round((len(sorted_values) - 1) * pct / 100)
    return sorted_values[index]

print(f"runs: {len(values)}")
print(f"min: {values[0]} ms")
print(f"median: {statistics.median(values):.0f} ms")
print(f"p95: {percentile(values, 95)} ms")
print(f"max: {values[-1]} ms")
PY
  rm -f "$results"
  echo
}

bench_new_session() {
  local session="$session_prefix-new-$RANDOM-$RANDOM"
  local ready="$session-ready"
  time_ms bash -c '
    tmux -L "$1" -f "$2" new-session -d -s "$3" zsh -i -c "tmux -L $1 wait-for -S $4"
    tmux -L "$1" wait-for "$4"
  ' bash "$socket_name" "$tmux_conf" "$session" "$ready"
  tmux -L "$socket_name" kill-session -t "$session" >/dev/null 2>&1 || true
}

bench_new_window() {
  local session="$session_prefix-window"
  tmux -L "$socket_name" has-session -t "$session" 2>/dev/null \
    || tmux -L "$socket_name" -f "$tmux_conf" new-session -d -s "$session" zsh -i -c 'sleep 3600'

  local window="$session_prefix-$RANDOM-$RANDOM"
  local ready="$window-ready"
  time_ms bash -c '
    tmux -L "$1" new-window -d -t "$2" -n "$3" zsh -i -c "tmux -L $1 wait-for -S $4"
    tmux -L "$1" wait-for "$4"
  ' bash "$socket_name" "$session" "$window" "$ready"
  tmux -L "$socket_name" kill-window -t "$session:$window" >/dev/null 2>&1 || true
}

bench_new_window_prompt() {
  local session="$session_prefix-window-prompt"
  tmux -L "$socket_name" has-session -t "$session" 2>/dev/null \
    || tmux -L "$socket_name" -f "$tmux_conf" new-session -d -s "$session" zsh -i -c 'sleep 3600'

  local window="$session_prefix-$RANDOM-$RANDOM"
  local ready="$window-ready"
  time_ms bash -c '
    tmux -L "$1" new-window -d -t "$2" -n "$3" zsh -i -c "print -P \"\$PROMPT\" >/dev/null; tmux -L $1 wait-for -S $4"
    tmux -L "$1" wait-for "$4"
  ' bash "$socket_name" "$session" "$window" "$ready"
  tmux -L "$socket_name" kill-window -t "$session:$window" >/dev/null 2>&1 || true
}

bench_attach_existing() {
  local session="$session_prefix-attach"
  tmux -L "$socket_name" has-session -t "$session" 2>/dev/null \
    || tmux -L "$socket_name" -f "$tmux_conf" new-session -d -s "$session" zsh -i -c 'sleep 3600'

  time_ms tmux -L "$socket_name" display-message -p -t "$session" '#S'
}

bench_zsh_interactive() {
  time_ms zsh -i -c exit
}

bench_zsh_tmux_fast() {
  time_ms env ZSH_TMUX_FAST=1 zsh -i -c exit
}

bench_zsh_prompt() {
  time_ms zsh -i -c 'print -P "$PROMPT" >/dev/null'
}

bench_zsh_tmux_fast_prompt() {
  time_ms env ZSH_TMUX_FAST=1 zsh -i -c 'print -P "$PROMPT" >/dev/null'
}

echo "tmux: $(tmux -V)"
echo "shell: ${SHELL:-unknown}"
echo "tmux config: $tmux_conf"
echo "iterations: $iterations"
echo

measure "zsh interactive startup" bench_zsh_interactive
measure "zsh tmux fast startup" bench_zsh_tmux_fast
measure "zsh startup plus first prompt render" bench_zsh_prompt
measure "zsh tmux fast startup plus first prompt render" bench_zsh_tmux_fast_prompt
measure "tmux new detached session with zsh" bench_new_session
measure "tmux command against existing server" bench_attach_existing
measure "tmux new window with zsh" bench_new_window
measure "tmux new window with first prompt render" bench_new_window_prompt
