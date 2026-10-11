import json
import os
from pathlib import Path
import subprocess
import unittest


HOOK = Path(__file__).resolve().parents[1] / "agents/claude/route-subagents.sh"
SOL = {"providerInstanceId": "pi", "model": "openai-codex/gpt-6.1-sol",
       "options": {"thinking": "high"}}


class AgentRoutingTests(unittest.TestCase):
    def invoke(self, tool, payload):
        result = subprocess.run(
            ["bash", str(HOOK)], input=json.dumps({"tool_name": tool, "tool_input": payload}),
            text=True, capture_output=True, check=True,
            env={**os.environ, "T3CODE_HOME": "/unused/t3"},
        )
        return json.loads(result.stdout)["hookSpecificOutput"]

    def test_default_delegation_does_not_inherit_leader(self):
        for target in [None, {}, {"providerInstanceId": "claudeAgent"},
                       {"model": "openai-codex/gpt-6.1-sol"}]:
            with self.subTest(target=target):
                payload = {"task": "Execute the approved design", "role": "implementation",
                           "runtimeMode": "inherit", "target": target}
                actual = self.invoke("mcp__t3-code__delegate_task", payload)
                self.assertEqual(actual["updatedInput"],
                                 {**payload, "runtimeMode": "full-access", "target": SOL})
        xhigh = {**SOL, "options": {"thinking": "xhigh"}}
        haiku = {"providerInstanceId": "claudeAgent", "model": "claude-haiku-5-5",
                 "options": {"effort": "high"}}
        xhigh_array = {**SOL, "options": [{"id": "thinking", "value": "xhigh"}]}
        haiku_array = {**haiku, "options": [{"id": "effort", "value": "high"}]}
        for target in [xhigh, xhigh_array, haiku, haiku_array]:
            with self.subTest(target=target):
                payload = {"task": "Read-only check", "target": target}
                actual = self.invoke("mcp__t3-code__delegate_task", payload)
                self.assertEqual(actual["updatedInput"],
                                 {**payload, "runtimeMode": "full-access"})
        partial = {"model": xhigh_array["model"], "options": xhigh_array["options"]}
        actual = self.invoke("mcp__t3-code__delegate_task", {"task": "Review", "target": partial})
        self.assertEqual(actual["updatedInput"]["target"], xhigh_array)
        self.assertEqual(self.invoke("Agent", {"prompt": "Execute", "model": "opus"})
                         ["permissionDecision"], "deny")
