#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
dir=$(jq -r '.workspace.current_dir' <<<"$input")
branch=$(git -C "$dir" branch --show-current 2>/dev/null || true)

jq -r --arg dir "${dir/#$HOME/\~}" --arg branch "$branch" '
  [
    (.model.display_name + (if .effort.level then " " + .effort.level else "" end)),
    $dir,
    "\(.context_window.used_percentage // 0 | floor)% of \(.context_window.context_window_size / 1000 | floor)k",
    (if $branch != "" then $branch else empty end)
  ] | join(" · ")
' <<<"$input"
