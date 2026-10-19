import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


CLI = Path(__file__).resolve().parents[1] / "agents/windows-vm/win-vm"


class WinVmJobTests(unittest.TestCase):
    def test_connection_recovery_observes_one_job_and_script_errors_fail(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        for fault in ("transport", "script"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory(prefix="win-vm-health-", dir=scratch) as folder:
                home = Path(folder)
                tools = home / "bin"
                tools.mkdir()
                (home / ".keys").mkdir()
                (home / ".keys/windows-vm.env").write_text("WINDOWS_VM_USERNAME=tb\n")
                calls = home / "calls.jsonl"
                ssh = tools / "ssh"
                ssh.write_text(f'''#!{sys.executable}
import base64, json, pathlib, sys
script = base64.b64decode(sys.argv[-1]).decode('utf-16le')
calls = pathlib.Path({str(calls)!r})
prior = calls.read_text().splitlines() if calls.exists() else []
if 'query.exe session' in script:
    kind = 'session'; result = ' console tb 1 Active'
elif 'Register-ScheduledTask' in script:
    kind = 'submit'; result = '123'
elif 'Get-ScheduledTaskInfo' in script:
    kind = 'observe'; result = json.dumps(dict(done=True, code=0, stdout=base64.b64encode(b'{{"pid":42,"exit_code":0}}').decode(), stderr=''))
elif 'cleanup-job.ps1' in script and '-TaskName' in script:
    kind = 'cleanup'; result = ''
else:
    kind = 'prepare'; result = '[]'
with calls.open('a') as stream: stream.write(json.dumps(kind) + '\\n')
if kind == 'observe' and '"observe"' not in prior:
    print('synthetic banner timeout' if {fault!r} == 'transport' else 'synthetic guest script error', file=sys.stderr)
    sys.exit(255 if {fault!r} == 'transport' else 1)
print(result)
''')
                ssh.chmod(0o755)
                docker = tools / "docker"
                docker.write_text("#!/bin/sh\nprintf 'running|2026-10-19T18:00:00Z|172.18.0.2|/persistent/storage\\n'\n")
                docker.chmod(0o755)
                scp = tools / "scp"
                scp.write_text("#!/bin/sh\nexit 0\n")
                scp.chmod(0o755)
                env = {**os.environ, "HOME": str(home), "PATH": str(tools)}
                env.pop("WIN_VM_LEASE", None)
                result = subprocess.run(
                    [sys.executable, str(CLI), "gui", "--wait", "--timeout", "30", "powershell.exe", "-Command", "exit 0"],
                    env=env, capture_output=True, text=True, timeout=10,
                )
                history = [json.loads(line) for line in calls.read_text().splitlines()]
                self.assertEqual(history.count("submit"), 1, history)
                self.assertEqual(history.count("cleanup"), 1, history)
                if fault == "transport":
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), {"pid": 42, "exit_code": 0})
                    self.assertEqual(history.count("observe"), 2)
                    self.assertIn("guest control recovered", result.stderr)
                else:
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(history.count("observe"), 1)
                    self.assertIn("synthetic guest script error", result.stderr)
                    self.assertNotIn("guest control recovered", result.stderr)

    def test_full_control_timeout_starts_recovery_before_reobserving_same_job(self):
        module = runpy.run_path(str(CLI))
        query = module["job_query"]
        transport_failure = module["TransportFailure"]
        clock = [0]
        def observe(ip, script, timeout):
            if clock[0] == 0:
                clock[0] += timeout
                raise transport_failure("synthetic control timeout")
            return "same-job-result"
        remote = Mock(side_effect=observe)
        with patch.dict(query.__globals__, remote=remote), patch.object(module["time"], "monotonic", side_effect=lambda: clock[0]), patch.object(module["time"], "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            self.assertEqual(query("synthetic", "read-only", 100), "same-job-result")
        self.assertEqual([call.args for call in remote.call_args_list], [("synthetic", "read-only"), ("synthetic", "read-only")])
        self.assertEqual([call.kwargs["timeout"] for call in remote.call_args_list], [30, 29])

    def test_transport_health_window_is_bounded_by_original_job_deadline(self):
        module = runpy.run_path(str(CLI))
        query = module["job_query"]
        transport_failure = module["TransportFailure"]
        for deadline in (10, 100):
            with self.subTest(deadline=deadline):
                clock = [0]
                def observe(ip, script, timeout):
                    clock[0] += timeout
                    raise transport_failure("synthetic outage")
                remote = Mock(side_effect=observe)
                with patch.dict(query.__globals__, remote=remote), patch.object(module["time"], "monotonic", side_effect=lambda: clock[0]), patch.object(module["time"], "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
                    with self.assertRaisesRegex(transport_failure, "job was not resubmitted"):
                        query("synthetic", "read-only", deadline)
                self.assertEqual(clock[0], min(60, deadline))
                self.assertEqual([call.kwargs["timeout"] for call in remote.call_args_list], [10] if deadline == 10 else [30, 29])
