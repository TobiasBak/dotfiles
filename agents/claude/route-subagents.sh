#!/usr/bin/env bash
set -euo pipefail

[[ -n "${T3CODE_HOME:-}" ]] || exit 0

input=$(cat)

case "$(jq -r '.tool_name' <<<"$input")" in
  Agent)
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Use T3 delegate_task with an explicit target, not the native Agent tool. Follow ~/.dotfiles/agents/AGENTS.md for leadership, model and task boundaries."
      }
    }'
    ;;
  *delegate_task)
    # Tobias's agents never wait on approvals; limits like read-only belong in the task text.
    jq '
      (.tool_input.target // {}) as $requested |
      (if ($requested.providerInstanceId // "") == "" or ($requested.model // "") == ""
       then {providerInstanceId: "pi", model: "openai-codex/gpt-6.1-sol", options: {thinking: ($requested.options.thinking // "medium")}}
       else $requested end) as $target |
      (if $target.providerInstanceId == "pi" and $target.model == "openai-codex/gpt-6.1-sol"
       then $target + {options: ({thinking: "medium"} + ($target.options // {}))}
       else $target end) as $explicit |
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: (.tool_input + {runtimeMode: "full-access", target: $explicit})
        }
      }
    ' <<<"$input"
    ;;
esac
