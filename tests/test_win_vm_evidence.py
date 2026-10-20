import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest


CLI = Path(__file__).resolve().parents[1] / "agents/windows-vm/win-vm"
TOKEN = "a" * 32


class WinVmEvidenceTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="win-vm-evidence-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.state = self.home / ".local/state/win-vm"
        self.clone = self.state / "ephemeral"
        self.clone.mkdir(parents=True)
        (self.state / "lease.json").write_text(json.dumps({"token": TOKEN}))
        (self.home / "container").touch()
        (self.home / "omarchy-lock").mkdir()
        tools = self.home / "bin"
        tools.mkdir()
        (self.home / ".keys").mkdir()
        (self.home / ".keys/windows-vm.env").write_text("WINDOWS_VM_USERNAME=tb\n")
        self.env = {"HOME": str(self.home), "PATH": str(tools), "WIN_VM_LEASE": TOKEN}
        self.mode("success")
        runner = tools / "runner"
        runner.write_text(f'''#!{sys.executable}
import json, runpy, sys
from pathlib import Path
module = runpy.run_path({str(CLI)!r})
globals = module["job"].__globals__
globals["VM_LOCK"] = str(Path.home() / "omarchy-lock")
globals["leased_state"] = lambda: {{"ip": "172.18.0.2", "container": "running", "mode": "ephemeral"}}
settings = json.loads((Path.home() / "mode.json").read_text())
mode = settings["outcome"]
if settings.get("retention_fail"):
    def failed_protection(*args):
        raise OSError(28, "synthetic retention ENOSPC")
    globals["retain_job_guest"] = failed_protection
if mode in ("timeout", "transport"):
    def failed_query(*args):
        error = module["TransportFailure"] if mode == "transport" else module["Failure"]
        raise error("synthetic " + mode)
    globals["job_query"] = failed_query
try:
    if sys.argv[1:] == ["fixture-teardown"]:
        module["teardown"]()
    else:
        sys.exit(module["main"]())
except (module["Failure"], OSError, ValueError) as error:
    print(f"win-vm: {{error}}", file=sys.stderr)
    sys.exit(1)
''')
        runner.chmod(0o755)
        self.runner = runner
        driver = tools / "driver"
        driver.write_text(f'''#!{sys.executable}
import base64, json, os, re, shutil, sys
from pathlib import Path
home = Path.home()
state = home / ".local/state/win-vm"
mode = json.loads((home / "mode.json").read_text())
name, args = Path(sys.argv[0]).name, sys.argv[1:]
def event(kind, **fields):
    with (home / "events.jsonl").open("a") as stream:
        stream.write(json.dumps(dict(kind=kind, **fields)) + "\\n")
def job_path(ident):
    return state / "ephemeral/storage/jobs" / ident
if name == "docker":
    if args[0] == "inspect":
        if (home / "container").exists():
            print("running|fixture|172.18.0.2|" + str(state / "ephemeral/storage"))
        else:
            print("exited|fixture||/persistent/storage")
    elif args[0] == "rm":
        event("container-remove")
        (home / "container").unlink()
    else:
        sys.exit(98)
elif name == "scp":
    source, destination = args[args.index("--") + 1:]
    upload = "@" in destination
    remote = destination if upload else source
    ident = re.search(r"/jobs/([a-f0-9]{{32}})", remote)[1]
    directory = job_path(ident)
    if upload:
        directory.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, directory / "job.ps1")
    else:
        assert "-r" in args
        event("export", ident=ident)
        target = Path(destination)
        if mode["export_fail"]:
            target.mkdir()
            shutil.copyfile(directory / "stdout.txt", target / "stdout.txt")
            print("synthetic export interruption", file=sys.stderr)
            sys.exit(9)
        shutil.copytree(directory, target)
elif name == "ssh":
    script = base64.b64decode(args[-1]).decode("utf-16le")
    if "query.exe session" in script:
        print(" SESSIONNAME USERNAME ID STATE TYPE DEVICE\\n console tb 1 Active")
    elif "cleanup-job.ps1" in script and "-TaskName" in script:
        ident = re.search(r"win-vm-([a-f0-9]{{32}})", script)[1]
        directory = job_path(ident)
        keep = "-KeepDirectory" in script
        evidence = state / "evidence" / ident
        if mode["outcome"] != "success":
            record = json.loads((evidence / "manifest.json").read_text())
            assert str(evidence) in (home / "stderr.log").read_text()
            assert record["guest_retained"] == keep
        event("cleanup", ident=ident, keep=keep)
        (directory / "late-output.txt").write_text("written while task was being stopped")
        if not keep:
            shutil.rmtree(directory)
        print("")
    elif "Register-ScheduledTask" in script:
        ident = re.search(r"win-vm-([a-f0-9]{{32}})", script)[1]
        (home / "job-id").write_text(ident)
        directory = job_path(ident)
        if mode["outcome"] == "gui-timeout":
            result = dict(pid=42, timed_out=True)
        else:
            result = dict(pid=42, exit_code=17 if mode["outcome"] == "nonzero" else 0)
        (directory / "stdout.txt").write_text(json.dumps(result))
        (directory / "stderr.txt").write_text("synthetic diagnostic\\n")
        (directory / "extra").mkdir()
        (directory / "extra/trace.bin").write_bytes(b"synthetic trace")
        event("submit", ident=ident)
        print("123")
    elif "Get-ScheduledTaskInfo" in script:
        ident = (home / "job-id").read_text()
        directory = job_path(ident)
        event("observe", ident=ident)
        print(json.dumps(dict(done=True, code=23 if mode["outcome"] == "wrapper-nonzero" else 0,
            stdout=base64.b64encode((directory / "stdout.txt").read_bytes()).decode(),
            stderr=base64.b64encode((directory / "stderr.txt").read_bytes()).decode())))
    else:
        print("[]")
else:
    sys.exit(99)
''')
        driver.chmod(0o755)
        for tool in ("ssh", "scp", "docker"):
            (tools / tool).symlink_to(driver)

    def mode(self, outcome, export_fail=False, retention_fail=False):
        (self.home / "mode.json").write_text(json.dumps({"outcome": outcome, "export_fail": export_fail,
                                                       "retention_fail": retention_fail}))

    def invoke(self, *args):
        with (self.home / "stderr.log").open("w") as error:
            process = subprocess.run([str(self.runner), *args], env=self.env, cwd=self.home,
                                     stdout=subprocess.PIPE, stderr=error, text=True, timeout=10)
        return SimpleNamespace(returncode=process.returncode, stdout=process.stdout,
                               stderr=(self.home / "stderr.log").read_text())

    def gui(self):
        return self.invoke("gui", "--wait", "--timeout", "30", "fixture.exe")

    def evidence(self):
        ident = (self.home / "job-id").read_text()
        path = self.state / "evidence" / ident
        return ident, path, json.loads((path / "manifest.json").read_text())

    def events(self):
        return [json.loads(line) for line in (self.home / "events.jsonl").read_text().splitlines()]

    def test_gui_nonzero_is_classified_before_cleanup_and_exports_all_files(self):
        self.mode("nonzero")
        result = self.gui()
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"pid": 42, "exit_code": 17})
        ident, evidence, record = self.evidence()
        self.assertEqual(record["exit_code"], 17)
        self.assertTrue(record["completed"])
        self.assertTrue(record["export_complete"])
        self.assertFalse(record["guest_retained"])
        self.assertEqual((evidence / "job/extra/trace.bin").read_bytes(), b"synthetic trace")
        self.assertEqual((evidence / "job/stderr.txt").read_text(), "synthetic diagnostic\n")
        self.assertEqual((evidence / "stdout.txt").read_bytes(), (evidence / "job/stdout.txt").read_bytes())
        self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((evidence / "manifest.json").stat().st_mode), 0o600)
        self.assertEqual([event["kind"] for event in self.events()], ["submit", "observe", "export", "cleanup"])
        self.assertFalse((self.clone / "storage/jobs" / ident).exists())
        self.assertFalse((self.clone / "retain-evidence").exists())
        teardown = self.invoke("fixture-teardown")
        self.assertEqual(teardown.returncode, 0, teardown.stderr)
        self.assertFalse(self.clone.exists())
        self.assertTrue(evidence.exists())

    def test_nonzero_scheduled_script_exports_before_normal_cleanup(self):
        self.mode("wrapper-nonzero")
        result = self.invoke("uia", "--timeout", "30", "tree")
        self.assertEqual(result.returncode, 23, result.stderr)
        ident, evidence, record = self.evidence()
        self.assertEqual(record["exit_code"], 23)
        self.assertTrue(record["completed"])
        self.assertTrue(record["export_complete"])
        self.assertFalse(record["guest_retained"])
        self.assertTrue((evidence / "job/extra/trace.bin").exists())
        self.assertEqual([event["kind"] for event in self.events()], ["submit", "observe", "export", "cleanup"])
        self.assertFalse((self.clone / "storage/jobs" / ident).exists())

    def test_unknown_completion_preserves_late_guest_outputs_and_clone(self):
        for outcome in ("gui-timeout", "timeout", "transport"):
            with self.subTest(outcome=outcome):
                self.mode(outcome)
                result = self.gui()
                self.assertEqual(result.returncode, 1, result.stderr)
                ident, evidence, record = self.evidence()
                self.assertFalse(record["completed"])
                self.assertTrue(record["snapshot_complete"])
                self.assertFalse(record["export_complete"])
                self.assertTrue(record["guest_retained"])
                self.assertFalse((evidence / "job/late-output.txt").exists())
                guest = self.clone / "storage/jobs" / ident
                self.assertTrue((guest / "late-output.txt").exists())
                events = [event["kind"] for event in self.events() if event.get("ident") == ident]
                self.assertLess(events.index("export"), events.index("cleanup"))
        retained = self.state / "evidence/guests" / TOKEN
        teardown = self.invoke("fixture-teardown")
        self.assertEqual(teardown.returncode, 0, teardown.stderr)
        self.assertIn(str(retained), teardown.stderr)
        self.assertFalse(self.clone.exists())
        self.assertTrue((retained / "storage/jobs" / ident / "late-output.txt").exists())
        self.assertEqual(record["retained_guest"], str(retained))
        # A later clone's normal deletion cannot erase the retained guest.
        self.clone.mkdir()
        teardown = self.invoke("fixture-teardown")
        self.assertEqual(teardown.returncode, 0, teardown.stderr)
        self.assertFalse(self.clone.exists())
        self.assertTrue(retained.exists())

    def test_failed_export_preserves_partial_host_and_only_guest_copy(self):
        self.mode("nonzero", export_fail=True)
        result = self.gui()
        self.assertEqual(result.returncode, 17, result.stderr)
        ident, evidence, record = self.evidence()
        self.assertFalse(record["export_complete"])
        self.assertTrue(record["guest_retained"])
        self.assertTrue(record["errors"])
        self.assertIn("export failed", result.stderr)
        self.assertTrue((evidence / "job/stdout.txt").exists())
        self.assertTrue((evidence / "stderr.txt").exists())
        self.assertFalse((evidence / "job/extra/trace.bin").exists())
        teardown = self.invoke("fixture-teardown")
        self.assertEqual(teardown.returncode, 0, teardown.stderr)
        retained = Path(record["retained_guest"])
        self.assertEqual((retained / "storage/jobs" / ident / "extra/trace.bin").read_bytes(), b"synthetic trace")
        self.assertTrue((retained / "storage/jobs" / ident / "late-output.txt").exists())

    def test_retention_write_failure_refuses_job_submission(self):
        self.mode("nonzero", export_fail=True, retention_fail=True)
        result = self.gui()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("synthetic retention ENOSPC", result.stderr)
        self.assertFalse((self.home / "job-id").exists(), "job submitted without retention protection")
        self.assertFalse((self.clone / "storage/jobs").exists())
        self.assertFalse((self.home / "events.jsonl").exists())

    def test_success_keeps_normal_cleanup_without_failure_evidence(self):
        result = self.gui()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"pid": 42, "exit_code": 0})
        self.assertEqual([event["kind"] for event in self.events()], ["submit", "observe", "cleanup"])
        self.assertFalse((self.state / "evidence").exists())
        self.assertEqual(list((self.clone / "storage/jobs").iterdir()), [])
        teardown = self.invoke("fixture-teardown")
        self.assertEqual(teardown.returncode, 0, teardown.stderr)
        self.assertFalse(self.clone.exists())
