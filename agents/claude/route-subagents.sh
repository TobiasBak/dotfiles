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
        permissionDecisionReason: "Do this work yourself. Delegate only whole packages of a large task, or a review, through T3 delegate_task without a target; this hook routes it. Size the task after reading its targets: it is large when the change it needs is large, not when its files are."
      }
    }'
    ;;
  *delegate_task)
    if jq -e '.tool_input.target.model // "" | test("haiku|opus|space-bunny")' <<<"$input" >/dev/null; then
      jq -n '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Opus, Haiku and Space Bunny are not delegation targets; Opus has no quota for subagents (Tobias, 2026-10-25). Omit the target and this hook routes to Sol."
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
      def sol: {"gpt-6.1-sol": {provider: "codex", effort: "reasoningEffort"},
                "openai/gpt-6.1-sol": {provider: "pi", effort: "thinking"}};
      def with_effort($key):
        if type == "array" then
          if any(.[]; .id == $key) then . else . + [{id: $key, value: "high"}] end
        else {($key): "high"} + . end;
      def only_effort($key):
        if type == "array" then map(select(.id == $key)) else {($key): .[$key]} | with_entries(select(.value != null)) end;
      (.tool_input.target // {}) as $requested |
      (if sol[$requested.model // ""] != null and $requested.providerInstanceId != sol[$requested.model].provider
       then sol[$requested.model] as $s |
            {providerInstanceId: $s.provider, model: $requested.model,
             options: (($requested.options // {}) | only_effort($s.effort))}
       elif ($requested.providerInstanceId // "") != "" and ($requested.model // "") != ""
       then $requested
       else {providerInstanceId: "codex", model: "gpt-6.1-sol", options: {}} end) as $target |
      (sol[$target.model] as $s |
       if $s != null and $target.providerInstanceId == $s.provider
       then $target + {options: (($target.options // {}) | with_effort($s.effort))}
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
