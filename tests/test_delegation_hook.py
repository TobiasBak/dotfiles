import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HOOK = Path(__file__).resolve().parents[1] / "agents/claude/route-subagents.sh"


class DelegationHookTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)

    def invoke(self, tool, payload):
        return subprocess.run(
            ["bash", str(HOOK)], input=json.dumps({"tool_name": tool, "tool_input": payload}),
            text=True, capture_output=True, check=True,
            env={**os.environ, "HOME": self.home.name, "T3CODE_HOME": "/unused/t3"},
        ).stdout

    def delegate(self, payload):
        return json.loads(self.invoke("mcp__t3-code__delegate_task", payload))["hookSpecificOutput"]

    def test_delegation_keeps_the_gah_subagent_stamp(self):
        gah = Path(self.home.name) / ".local/bin/gah"
        gah.parent.mkdir(parents=True)
        gah.write_text("#!/bin/sh\n"
                       "jq '{hookSpecificOutput: {hookEventName: \"PreToolUse\","
                       " updatedInput: (.tool_input + {task: (.tool_input.task + \" [gah]\")})}}'\n")
        gah.chmod(0o755)
        self.assertEqual(self.delegate({"task": "Execute"})["updatedInput"],
                         {"task": "Execute [gah]", "runtimeMode": "full-access"})

    def test_delegation_runs_full_access_on_the_target_the_agent_chose(self):
        for fields in [{}, {"target": None},
                       {"target": {"model": "gpt-6.1-sol"}},
                       {"target": {"providerInstanceId": "claudeAgent", "model": "claude-opus-5-5",
                                   "options": {"effort": "high"}}},
                       {"target": {"providerInstanceId": "claudeAgent", "model": "claude-haiku-5-5"}},
                       {"target": {"providerInstanceId": "pi", "model": "openai/gpt-6.1-sol",
                                   "options": [{"id": "thinking", "value": "xhigh"}]}}]:
            with self.subTest(fields=fields):
                payload = {"task": "Review", "runtimeMode": "approval-required", **fields}
                actual = self.delegate(payload)
                self.assertEqual(actual["permissionDecision"], "allow")
                self.assertEqual(actual["updatedInput"], {**payload, "runtimeMode": "full-access"})

    def test_native_agent_calls_pass_untouched(self):
        self.assertEqual(self.invoke("Agent", {"prompt": "Execute", "model": "opus"}), "")
