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
      def with_sol_thinking:
        if type == "array" then
          if any(.[]; .id == "thinking") then . else . + [{id: "thinking", value: "high"}] end
        else {thinking: "high"} + . end;
      (.tool_input.target // {}) as $requested |
      (if ($requested.providerInstanceId // "") == "" or ($requested.model // "") == ""
       then {providerInstanceId: "pi", model: "openai-codex/gpt-6.1-sol",
             options: (($requested.options // {}) |
                       if type == "array" then map(select(.id == "thinking"))
                       else {thinking: (.thinking // "high")} end)}
       else $requested end) as $target |
      (if $target.providerInstanceId == "pi" and $target.model == "openai-codex/gpt-6.1-sol"
       then $target + {options: (($target.options // {}) | with_sol_thinking)}
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
