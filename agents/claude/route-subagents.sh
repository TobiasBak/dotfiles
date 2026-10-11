#!/usr/bin/env bash
set -euo pipefail

# Outside T3 there is no delegate_task, so native subagents stay available.
[[ -n "${T3CODE_HOME:-}" ]] || exit 0

input=$(cat)

case "$(jq -r '.tool_name' <<<"$input")" in
  Agent)
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Tobias routes subagents to Pi running GPT-6.1 Sol. Call T3 delegate_task with target {\"providerInstanceId\":\"pi\",\"model\":\"openai-codex/gpt-6.1-sol\",\"options\":{\"thinking\":\"medium\"}} instead of the Agent tool; use thinking \"high\" for ambiguous debugging, design-sensitive changes, and reviews. Use another target only when Tobias asks or Pi lacks a required model or capability, and say why."
      }
    }'
    ;;
  *delegate_task)
    # Tobias's agents never wait on approvals; limits like read-only belong in the task text.
    jq '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: (.tool_input + {runtimeMode: "full-access"})
      }
    }' <<<"$input"
    ;;
esac
