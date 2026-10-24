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
        permissionDecisionReason: "Do this work yourself. Only a coordinator or large-project lead delegates, and only whole outcomes through T3 delegate_task with an explicit target; see How to orchestrate in ~/.dotfiles/agents/AGENTS.md."
      }
    }'
    ;;
  *delegate_task)
    if jq -e '.tool_input.target.model // "" | test("haiku|space-bunny")' <<<"$input" >/dev/null; then
      jq -n '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Haiku and Space Bunny are retired from delegation. Use Pi GPT-6.1 Sol at thinking high (Tobias, 2026-10-13)."
        }
      }'
      exit 0
    fi
    # Claude Code keeps one hook's updatedInput, so gah's subagent stamp composes here.
    gah=$HOME/.local/bin/gah
    if [[ -x $gah ]] && stamped=$("$gah" hook claude <<<"$input" 2>/dev/null) &&
       jq -e '.hookSpecificOutput.updatedInput' <<<"$stamped" >/dev/null 2>&1; then
      input=$(jq --argjson s "$stamped" '.tool_input = $s.hookSpecificOutput.updatedInput' <<<"$input")
    fi
    # Tobias's agents never wait on approvals; limits like read-only belong in the task text.
    jq '
      def with_sol_thinking:
        if type == "array" then
          if any(.[]; .id == "thinking") then . else . + [{id: "thinking", value: "high"}] end
        else {thinking: "high"} + . end;
      (.tool_input.target // {}) as $requested |
      (if ($requested.providerInstanceId // "") == "" or ($requested.model // "") == ""
       then if $requested.model == "openai-codex/gpt-6.1-sol"
            then {providerInstanceId: "pi", model: "openai-codex/gpt-6.1-sol",
                  options: (($requested.options // {}) |
                            if type == "array" then map(select(.id == "thinking"))
                            else {thinking: (.thinking // "high")} end)}
            else {providerInstanceId: "pi", model: "openai-codex/gpt-6.1-sol",
                  options: {thinking: "high"}} end
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
