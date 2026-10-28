import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HOOK = Path(__file__).resolve().parents[1] / "agents/claude/route-subagents.sh"
SOL = {"providerInstanceId": "pi", "model": "openai/gpt-6.1-sol",
       "options": {"thinking": "high"}}
RETIRED_WORKER = {"providerInstanceId": "opencode", "model": "opencode/space-bunny-free"}


class AgentRoutingTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)

    def invoke(self, tool, payload):
        result = subprocess.run(
            ["bash", str(HOOK)], input=json.dumps({"tool_name": tool, "tool_input": payload}),
            text=True, capture_output=True, check=True,
            env={**os.environ, "HOME": self.home.name, "T3CODE_HOME": "/unused/t3"},
        )
        return json.loads(result.stdout)["hookSpecificOutput"]

    def test_delegation_keeps_the_gah_subagent_stamp(self):
        gah = Path(self.home.name) / ".local/bin/gah"
        gah.parent.mkdir(parents=True)
        gah.write_text("#!/bin/sh\n"
                       "jq '{hookSpecificOutput: {hookEventName: \"PreToolUse\","
                       " updatedInput: (.tool_input + {task: (.tool_input.task + \" [gah]\")})}}'\n")
        gah.chmod(0o755)
        actual = self.invoke("mcp__t3-code__delegate_task", {"task": "Execute"})
        self.assertEqual(actual["updatedInput"],
                         {"task": "Execute [gah]", "runtimeMode": "full-access", "target": SOL})

    def test_default_delegation_does_not_inherit_leader(self):
        for fields in [{}, {"target": None}, {"target": {}},
                       {"target": {"providerInstanceId": "claudeAgent"}},
                       {"target": {"providerInstanceId": "pi"}},
                       {"target": {"model": "other-model", "options": {"effort": "high"}}},
                       {"target": {"providerInstanceId": "", "model": "other-model"}},
                       {"target": {"providerInstanceId": "pi", "model": ""}}]:
            with self.subTest(fields=fields):
                payload = {"task": "Execute the approved design", "role": "implementation",
                           "runtimeMode": "inherit", **fields}
                actual = self.invoke("mcp__t3-code__delegate_task", payload)
                self.assertEqual(actual["updatedInput"],
                                 {**payload, "runtimeMode": "full-access", "target": SOL})
        for target, expected in [
            ({"model": SOL["model"]}, SOL),
            ({"providerInstanceId": "", "model": SOL["model"]}, SOL),
            ({"providerInstanceId": "pi", "model": SOL["model"]}, SOL),
            ({**SOL, "options": [{"id": "other", "value": "keep"}]},
             {**SOL, "options": [{"id": "other", "value": "keep"},
                                 {"id": "thinking", "value": "high"}]}),
        ]:
            with self.subTest(target=target):
                payload = {"task": "Review", "target": target}
                actual = self.invoke("mcp__t3-code__delegate_task", payload)
                self.assertEqual(actual["updatedInput"],
                                 {**payload, "runtimeMode": "full-access", "target": expected})
        xhigh = {**SOL, "options": {"thinking": "xhigh"}}
        haiku = {"providerInstanceId": "claudeAgent", "model": "claude-haiku-5-5",
                 "options": {"effort": "high"}}
        opus = {"providerInstanceId": "claudeAgent", "model": "claude-opus-5-5",
                "options": {"effort": "high"}}
        xhigh_array = {**SOL, "options": [{"id": "thinking", "value": "xhigh"}]}
        haiku_array = {**haiku, "options": [{"id": "effort", "value": "high"}]}
        for target in [xhigh, xhigh_array,
                       {"providerInstanceId": "other", "model": "other-model"}]:
            with self.subTest(target=target):
                payload = {"task": "Read-only check", "target": target}
                actual = self.invoke("mcp__t3-code__delegate_task", payload)
                self.assertEqual(actual["updatedInput"],
                                 {**payload, "runtimeMode": "full-access"})
        for target in [haiku, haiku_array, opus, {"model": opus["model"]}, RETIRED_WORKER,
                       {"model": RETIRED_WORKER["model"]}]:
            with self.subTest(target=target):
                actual = self.invoke("mcp__t3-code__delegate_task",
                                     {"task": "Read-only check", "target": target})
                self.assertEqual(actual["permissionDecision"], "deny")
        for expected in [xhigh, xhigh_array]:
            with self.subTest(partial=expected):
                partial = {"model": expected["model"], "options": expected["options"]}
                actual = self.invoke("mcp__t3-code__delegate_task",
                                     {"task": "Review", "target": partial})
                self.assertEqual(actual["updatedInput"]["target"], expected)
        self.assertEqual(self.invoke("Agent", {"prompt": "Execute", "model": "opus"})
                         ["permissionDecision"], "deny")
