#!/usr/bin/env bash
set -euo pipefail

[[ -n "${T3CODE_HOME:-}" ]] || exit 0

input=$(cat)

# The settings matcher also sends native Agent calls here; they pass untouched.
[[ $(jq -r '.tool_name' <<<"$input") == *delegate_task ]] || exit 0

# Claude Code keeps one hook's updatedInput, so gah's subagent stamp composes here.
gah=$HOME/.local/bin/gah
if [[ -x $gah ]] && stamped=$("$gah" hook claude <<<"$input" 2>/dev/null) &&
   jq -e '.hookSpecificOutput.updatedInput' <<<"$stamped" >/dev/null 2>&1; then
  input=$(jq --argjson s "$stamped" '.tool_input = $s.hookSpecificOutput.updatedInput' <<<"$input")
fi
# Tobias's agents never wait on approvals; limits like read-only belong in the task text.
jq '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: (.tool_input + {runtimeMode: "full-access"})
  }
}' <<<"$input"
