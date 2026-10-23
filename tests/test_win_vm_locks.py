import ctypes
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest

from test_heavy_lease import CLI as HEAVY_LEASE


VM = Path(__file__).resolve().parents[1] / "agents/windows-vm/win-vm"


class WinVmLockTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="win-vm-lock-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        tools = self.home / "bin"
        tools.mkdir()
        self.env = {"HOME": str(self.home), "PATH": str(tools), "LC_ALL": "C"}
        self.env["REAL_HEAVY_LEASE"] = str(HEAVY_LEASE)
        self.calls = self.home / "calls.jsonl"
        self.calls.touch()
        (self.home / "omarchy-lock").mkdir()
        (self.home / "mounts-ready").touch()
        (self.home / ".keys").mkdir()
        (self.home / ".keys/windows-vm.env").write_text("WINDOWS_VM_USERNAME=tb\n")
        for directory in (".windows", "Windows"):
            (self.home / directory).mkdir()
        runner = tools / "win-vm"
        runner.write_text(f'''#!/usr/bin/python3
import importlib.machinery, importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_loader("win_vm", importlib.machinery.SourceFileLoader("win_vm", {str(VM)!r}))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.SOURCE = Path(__file__).parent
module.VM_LOCK = str(Path.home() / "omarchy-lock")
module.mounts_ready = lambda: (Path.home() / "mounts-ready").exists()
try:
    sys.exit(module.main())
except (module.Failure, OSError, ValueError) as error:
    print(f"win-vm: {{error}}", file=sys.stderr)
    sys.exit(1)
''')
        runner.chmod(0o755)
        driver = tools / "driver"
        driver.write_text('''#!/usr/bin/python3
import json, os, shutil, sys
from pathlib import Path
home = Path.home()
name, args = Path(sys.argv[0]).name, sys.argv[1:]
with (home / "calls.jsonl").open("a") as stream:
    stream.write(json.dumps([name, *args]) + "\\n")
def start():
    storage = str(home / ".local/state/win-vm/ephemeral/storage") if "--force-recreate" in args else "/persistent/storage"
    (home / "container").write_text("running|new|172.18.0.2|" + storage)
if name == "heavy-lease":
    if args[:1] == ["isolate"]:
        assert args == ["isolate", "--", "/usr/bin/omarchy-windows-vm", "prepare"], args
        with (home / "calls.jsonl").open("a") as stream:
            stream.write(json.dumps(["prepare-boundary", {"argv": args, "cwd": os.getcwd(),
                "gah": {key: os.environ[key] for key in ("GAH_WORKSPACE", "GAH_ROOT", "GAH_BIN", "GAH_LAUNCH_CONTEXT") if key in os.environ}}]) + "\\n")
        os.execv(str(home / "bin/omarchy-windows-vm"), ["omarchy-windows-vm", "prepare"])
    os.execv(os.environ["REAL_HEAVY_LEASE"], [os.environ["REAL_HEAVY_LEASE"], *args])
elif name == "docker":
    if args[0] == "inspect":
        print((home / "container").read_text() if (home / "container").exists() else "exited|old||/persistent/storage")
    elif args[0] == "rm":
        (home / "container").unlink(missing_ok=True)
    else:
        sys.exit(97)
elif name == "docker-compose":
    if "up" in args:
        with (home / "calls.jsonl").open("a") as stream:
            stream.write(json.dumps(["allocation-boundary", {"cwd": os.getcwd(),
                "gah": {key: os.environ[key] for key in ("GAH_WORKSPACE", "GAH_ROOT", "GAH_BIN", "GAH_LAUNCH_CONTEXT") if key in os.environ}}]) + "\\n")
        start()
    else:
        sys.exit(98)
elif name == "omarchy-windows-vm":
    assert args == ["prepare"], args
    if (home / "prepare-fails").exists():
        sys.exit(42)
    if not (home / "prepare-no-mounts").exists():
        (home / "mounts-ready").touch()
elif name == "ssh":
    print(" SESSIONNAME USERNAME ID STATE TYPE DEVICE\\n console tb 1 Active")
elif name == "systemd-run":
    command = args[args.index("--") + 1:]
    os.execv(command[0], command)
elif name == "cp":
    shutil.copyfile(args[-2], args[-1])
elif name == "lsattr":
    print("---------------------- " + args[-1])
elif name != "chattr":
    sys.exit(99)
''')
        driver.chmod(0o755)
        for name in ("heavy-lease", "docker", "docker-compose", "omarchy-windows-vm", "ssh", "systemd-run", "cp", "lsattr", "chattr"):
            (tools / name).symlink_to(driver)
        self.runner = runner
        self.processes = []
        self.addCleanup(self.stop_processes)

    def stop_processes(self):
        for process in self.processes:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for process in self.processes:
            process.wait(timeout=10)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()

    def invoke(self, *args):
        return subprocess.run([str(self.runner), *args], env=self.env, cwd=self.home,
                              capture_output=True, text=True, timeout=10)

    def history(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def baseline(self):
        baseline = self.home / ".local/state/win-vm/baseline"
        baseline.mkdir(parents=True)
        (baseline / "baseline.json").write_text('{}')
        (baseline / "data.img").write_bytes(b"synthetic guest disk")

    def test_startup_has_no_memory_admission(self):
        self.baseline()
        for arguments in (("up", "--class", "gate"),
                          ("run", "--class", "efficiency", "--ephemeral", "--", "/usr/bin/true")):
            with self.subTest(arguments=arguments):
                self.calls.write_text("")
                (self.home / "container").unlink(missing_ok=True)
                result = self.invoke(*arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                locks = [call for call in self.history() if call[0] == "heavy-lease"]
                self.assertEqual(len(locks), 1)
                self.assertEqual(locks[0][1:6], ["run", "--wait", "--exclusive", "win-vm", "--"])
                self.assertFalse(any(call[0] == "docker-compose" and "config" in call for call in self.history()))
                self.assertEqual(sum(call[0] == "docker-compose" and "up" in call for call in self.history()), 1)

    def test_ephemeral_owner_keeps_named_lock_through_payload(self):
        self.baseline()
        command = [sys.executable, "-c", 'import subprocess,sys; sys.exit(subprocess.run([sys.argv[1], "run", "--try", "--exclusive", "win-vm", "--", "/usr/bin/true"], env={"HOME":sys.argv[2]}).returncode)', str(HEAVY_LEASE), str(self.home)]
        result = self.invoke("run", "--ephemeral", "--", *command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("busy: exclusive", result.stderr)
        self.assertFalse((self.home / ".local/state/win-vm/ephemeral").exists())
        self.assertFalse((self.home / "container").exists())

    def test_missing_lock_tool_never_starts_vm(self):
        (self.home / "bin/heavy-lease").unlink()
        result = self.invoke("up")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse((self.home / "container").exists())

    def test_only_host_global_prepare_leaves_the_workspace_context(self):
        (self.home / "mounts-ready").unlink()
        gah = {"GAH_WORKSPACE": "fixture-workspace", "GAH_ROOT": "/fixture/repo",
               "GAH_BIN": "/fixture/gah", "GAH_LAUNCH_CONTEXT": "fixture-context"}
        self.env.update(gah)
        result = self.invoke("up")
        self.assertEqual(result.returncode, 0, result.stderr)
        boundary = next(call[1] for call in self.history() if call[0] == "prepare-boundary")
        self.assertEqual(boundary, {"argv": ["isolate", "--", "/usr/bin/omarchy-windows-vm", "prepare"],
                                    "cwd": "/", "gah": {}})
        allocation = next(call[1] for call in self.history() if call[0] == "allocation-boundary")
        self.assertEqual(allocation, {"cwd": str(self.home), "gah": gah})
        self.assertEqual(sum(call == ["omarchy-windows-vm", "prepare"] for call in self.history()), 1)

    def test_missing_failed_or_incomplete_prepare_never_falls_back_to_startup(self):
        (self.home / "mounts-ready").unlink()
        for marker in ("prepare-fails", "prepare-no-mounts"):
            with self.subTest(marker=marker):
                (self.home / marker).touch()
                try:
                    result = self.invoke("up")
                finally:
                    (self.home / marker).unlink()
                self.assertEqual(result.returncode, 1, result.stderr)
                diagnostic = "exit code 42" if marker == "prepare-fails" else "did not provide safe VM mounts"
                self.assertIn(diagnostic, result.stderr)
                self.assertFalse((self.home / "container").exists())
        (self.home / "bin/omarchy-windows-vm").unlink()
        result = self.invoke("up")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse((self.home / "container").exists())
        self.assertFalse(any(call[0] == "docker-compose" and "up" in call for call in self.history()))

    def test_concurrent_ephemeral_owner_queues_before_taking_guest_lease(self):
        self.baseline()
        first = subprocess.Popen(
            [str(self.runner), "run", "--ephemeral", "--", sys.executable, "-c",
             'import sys; print("payload-ready", flush=True); sys.stdin.readline()'],
            env=self.env, cwd=self.home, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True, bufsize=0,
        )
        self.processes.append(first)
        with selectors.DefaultSelector() as selector:
            selector.register(first.stdout, selectors.EVENT_READ)
            while True:
                self.assertTrue(selector.select(timeout=10), "first VM payload did not start")
                line = first.stdout.readline()
                if not line:
                    self.fail(first.stderr.read().decode())
                if line == b"payload-ready\n":
                    break
        waiter_folder = self.home / ".local/state/heavy-lease/waiters"
        waiter_folder.mkdir(exist_ok=True)
        libc = ctypes.CDLL(None, use_errno=True)
        watch = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        self.assertGreaterEqual(watch, 0)
        self.addCleanup(os.close, watch)
        self.assertGreaterEqual(libc.inotify_add_watch(watch, os.fsencode(waiter_folder), 0x80), 0)
        second = subprocess.Popen(
            [str(self.runner), "run", "--class", "gate", "--ephemeral", "--", "/usr/bin/true"],
            env=self.env, cwd=self.home, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self.processes.append(second)
        with selectors.DefaultSelector() as selector:
            selector.register(watch, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=10), "second VM owner did not queue")
            os.read(watch, 65536)
        self.assertIsNone(second.poll())
        self.assertEqual(sum(call[0] == "docker-compose" and "up" in call for call in self.history()), 1)
        first.stdin.write(b"release\n")
        first_output, first_error = first.communicate(timeout=10)
        self.assertEqual(first.returncode, 0, first_error.decode())
        second_output, second_error = second.communicate(timeout=10)
        self.assertEqual(second.returncode, 0, second_error.decode())
        self.assertEqual(sum(call[0] == "docker-compose" and "up" in call for call in self.history()), 2)
