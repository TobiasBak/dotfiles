import ctypes
import fcntl
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest


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
if name == "docker":
    if args[0] == "inspect":
        print((home / "container").read_text() if (home / "container").exists() else "exited|old||/persistent/storage")
    elif args[0] == "rm":
        if (home / "hold-teardown").exists():
            print("teardown-ready", flush=True)
            with (home / "teardown-release").open() as stream:
                stream.read()
        (home / "container").unlink(missing_ok=True)
    else:
        sys.exit(97)
elif name == "docker-compose":
    if "up" in args:
        with (home / "calls.jsonl").open("a") as stream:
            stream.write(json.dumps(["allocation-boundary", {"cwd": os.getcwd(),
                "gah": {key: value for key, value in os.environ.items() if key.startswith("GAH_")}}]) + "\\n")
        start()
    else:
        sys.exit(98)
elif name == "omarchy-windows-vm":
    assert args == ["prepare"], args
    with (home / "calls.jsonl").open("a") as stream:
        stream.write(json.dumps(["prepare-boundary", {"cwd": os.getcwd(),
            "gah": {key: value for key, value in os.environ.items() if key.startswith("GAH_")}}]) + "\\n")
    if (home / "prepare-fails").exists():
        sys.exit(42)
    if not (home / "prepare-no-mounts").exists():
        (home / "mounts-ready").touch()
elif name == "ssh":
    print(" SESSIONNAME USERNAME ID STATE TYPE DEVICE\\n console tb 1 Active")
elif name == "systemd-run":
    command = args[args.index("--") + 1:]
    if "--scope" not in args:
        assert command == ["/usr/bin/omarchy-windows-vm", "prepare"], command
        # A service gets manager environment, not the launcher's. Model a manager
        # with stale gah context, then apply systemd's UnsetEnvironment property.
        os.environ["GAH_WORKSPACE"] = "stale-manager-workspace"
        for arg in args:
            if arg.startswith("--property=UnsetEnvironment="):
                for key in arg.split("=", 2)[2].split():
                    os.environ.pop(key, None)
        assert "--working-directory=/" in args, args
        os.chdir("/")
        command[0] = str(home / "bin/omarchy-windows-vm")
    os.execv(command[0], command)
elif name == "cp":
    shutil.copyfile(args[-2], args[-1])
elif name == "lsattr":
    print("---------------------- " + args[-1])
elif name != "chattr":
    sys.exit(99)
''')
        driver.chmod(0o755)
        for name in ("docker", "docker-compose", "omarchy-windows-vm", "ssh", "systemd-run", "cp", "lsattr", "chattr"):
            (tools / name).symlink_to(driver)
        self.runner = runner
        self.device_lock = self.home / ".cache/win-vm/device.lock"
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

    def spawn(self, *args):
        process = subprocess.Popen([str(self.runner), *args], env=self.env, cwd=self.home,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True, bufsize=0)
        self.processes.append(process)
        return process

    def wait_line(self, stream, expected):
        with selectors.DefaultSelector() as selector:
            selector.register(stream, selectors.EVENT_READ)
            while True:
                self.assertTrue(selector.select(timeout=10), f"missing {expected!r}")
                line = stream.readline()
                self.assertTrue(line, f"stream closed before {expected!r}")
                if line == expected:
                    return

    def watch_open(self, path):
        libc = ctypes.CDLL(None, use_errno=True)
        watch = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        self.assertGreaterEqual(watch, 0)
        self.addCleanup(os.close, watch)
        self.assertGreaterEqual(libc.inotify_add_watch(watch, os.fsencode(path), 0x20), 0)
        return watch

    def wait_open(self, watch):
        with selectors.DefaultSelector() as selector:
            selector.register(watch, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=10), "second VM owner did not open device lock")
            os.read(watch, 65536)

    def history(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def baseline(self):
        baseline = self.home / ".local/state/win-vm/baseline"
        baseline.mkdir(parents=True, exist_ok=True)
        (baseline / "baseline.json").write_text('{}')
        (baseline / "data.img").write_bytes(b"synthetic guest disk")

    def held_run(self):
        self.baseline()
        first = self.spawn("run", "--ephemeral", "--", sys.executable, "-c",
                           'import sys; print("payload-ready", flush=True); sys.stdin.readline()')
        self.wait_line(first.stdout, b"payload-ready\n")
        return first

    def test_startup_runs_directly(self):
        self.baseline()
        for arguments in (("up", "--class", "gate"),
                          ("run", "--class", "efficiency", "--ephemeral", "--", "/usr/bin/true")):
            with self.subTest(arguments=arguments):
                self.calls.write_text("")
                (self.home / "container").unlink(missing_ok=True)
                result = self.invoke(*arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(any(call[0] == "docker-compose" and "config" in call for call in self.history()))
                self.assertEqual(sum(call[0] == "docker-compose" and "up" in call for call in self.history()), 1)
                self.assertEqual(self.device_lock.stat().st_mode & 0o777, 0o600)

    def test_ephemeral_owner_keeps_device_lock_through_payload(self):
        self.baseline()
        # This independent nonblocking kernel probe must see the payload's owner.
        command = [sys.executable, "-c", '''import fcntl, sys
with open(sys.argv[1]) as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(23)
''', str(self.device_lock)]
        result = self.invoke("run", "--ephemeral", "--", *command)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertFalse((self.home / ".local/state/win-vm/ephemeral").exists())
        self.assertFalse((self.home / "container").exists())
        with self.device_lock.open() as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_guest_lease_rejects_outsiders_and_nested_holders_pass_through(self):
        first = self.held_run()
        result = self.invoke("exec", "exit 0")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("VM leased by pid", result.stderr)
        holder = json.loads((self.home / ".local/state/win-vm/lease.json").read_text())
        self.env["WIN_VM_LEASE"] = holder["token"]
        for args in (("up",), ("exec", "exit 0")):
            result = self.invoke(*args)
            self.assertEqual(result.returncode, 0, result.stderr)
        for args in (("run", "--ephemeral", "--", "/usr/bin/true"), ("baseline",), ("down",)):
            result = self.invoke(*args)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("is refused inside an ephemeral run", result.stderr)
        first.communicate(b"release\n", timeout=10)
        self.assertEqual(first.returncode, 0)

    def test_only_host_global_prepare_leaves_the_workspace_context(self):
        (self.home / "mounts-ready").unlink()
        gah = {"GAH_WORKSPACE": "fixture-workspace", "GAH_ROOT": "/fixture/repo",
               "GAH_BIN": "/fixture/gah", "GAH_LAUNCH_CONTEXT": "fixture-context", "GAH_EXTRA": "fixture-extra"}
        self.env.update(gah)
        result = self.invoke("up")
        self.assertEqual(result.returncode, 0, result.stderr)
        boundary = next(call[1] for call in self.history() if call[0] == "prepare-boundary")
        self.assertEqual(boundary, {"cwd": "/", "gah": {}})
        manager = next(call for call in self.history() if call[0] == "systemd-run")
        self.assertEqual(manager[1:], ["--user", "--wait", "--pipe", "--collect", "--quiet",
                                     "--service-type=exec", "--working-directory=/",
                                     "--property=UnsetEnvironment=GAH_WORKSPACE GAH_ROOT GAH_BIN GAH_LAUNCH_CONTEXT",
                                     "--", "/usr/bin/omarchy-windows-vm", "prepare"])
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
        for tool in ("omarchy-windows-vm", "systemd-run"):
            (self.home / "bin" / tool).unlink()
            result = self.invoke("up")
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertFalse((self.home / "container").exists())
        self.assertFalse(any(call[0] == "docker-compose" and "up" in call for call in self.history()))

    def test_concurrent_owners_queue_before_taking_guest_lease(self):
        for args in (("up",), ("run", "--ephemeral", "--", "/usr/bin/true")):
            with self.subTest(args=args):
                self.calls.write_text("")
                (self.home / "container").unlink(missing_ok=True)
                first = self.held_run()
                watch = self.watch_open(self.device_lock)
                second = self.spawn(*args)
                self.wait_open(watch)
                self.assertIsNone(second.poll())
                self.assertEqual(sum(call[0] == "docker-compose" and "up" in call for call in self.history()), 1)
                _, first_error = first.communicate(b"release\n", timeout=10)
                self.assertEqual(first.returncode, 0, first_error.decode())
                _, second_error = second.communicate(timeout=10)
                self.assertEqual(second.returncode, 0, second_error.decode())
                self.assertEqual(sum(call[0] == "docker-compose" and "up" in call for call in self.history()), 2)

    def test_crashed_owner_keeps_device_lock_until_guardian_teardown_finishes(self):
        first = self.held_run()
        (self.home / "hold-teardown").touch()
        os.mkfifo(self.home / "teardown-release")
        first.kill()
        first.wait(timeout=10)
        self.wait_line(first.stderr, b"teardown-ready\n")
        # The owner is dead. Only its guardian can still hold this descriptor.
        with self.device_lock.open() as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        watch = self.watch_open(self.device_lock)
        second = self.spawn("run", "--ephemeral", "--", "/usr/bin/true")
        self.wait_open(watch)
        self.assertIsNone(second.poll())
        (self.home / "hold-teardown").unlink()
        with (self.home / "teardown-release").open("w") as release:
            release.write("release\n")
        _, error = second.communicate(timeout=10)
        self.assertEqual(second.returncode, 0, error.decode())
        with self.device_lock.open() as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertFalse((self.home / ".local/state/win-vm/ephemeral").exists())
