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


CLI = Path(__file__).resolve().parents[1] / "cli/heavy-lease.py"

CONTROLLED = '''
from pathlib import Path
import sys
critical = Path(sys.argv[1])
critical.mkdir()
print("entered", flush=True)
assert sys.stdin.readline() == "release\\n"
critical.rmdir()
print("exited", flush=True)
'''
ISOLATE_MANAGER = '''
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
command = sys.argv[sys.argv.index("--") + 1:]
request = Path(command[-1])
receipt = {"request_mode": stat.S_IMODE(request.stat().st_mode), "directory_mode": stat.S_IMODE(request.parent.stat().st_mode)}
service = subprocess.Popen(command, env={"PATH": os.defpath, "MANAGER_ONLY_SENTINEL": "manager-environment"}, close_fds=True, start_new_session=True)
with Path(__file__).with_name("manager-events.jsonl").open("a") as stream:
    stream.write(json.dumps({**receipt, "pid": service.pid}) + "\\n")
sys.exit(service.wait())
'''


class HeavyLeaseTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="heavy-lock-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.state = self.home / ".local/state/heavy-lease"
        self.env = {"HOME": str(self.home), "PATH": os.environ["PATH"], "LC_ALL": "C",
                    "XDG_RUNTIME_DIR": str(self.home)}
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
                if stream is not None:
                    stream.close()

    def invoke(self, *args, env=None, cwd=None):
        return subprocess.run([str(CLI), *args], env=self.env if env is None else env,
                              cwd=self.home if cwd is None else cwd,
                              capture_output=True, text=True, timeout=10)

    def start(self, command, mode=()):
        process = subprocess.Popen([str(CLI), "run", *mode, "--", *command],
                                   env=self.env, cwd=self.home,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
        self.processes.append(process)
        return process

    def ready(self, streams):
        with selectors.DefaultSelector() as selector:
            for stream in streams:
                selector.register(stream, selectors.EVENT_READ)
            events = selector.select(timeout=10)
            self.assertTrue(events, "timed out waiting for process event")
            return events[0][0].fileobj

    def event(self, process, expected):
        self.ready([process.stdout])
        self.assertEqual(process.stdout.readline(), expected)

    def release(self, process):
        process.stdin.write(b"release\n")
        self.event(process, b"exited\n")
        self.assertEqual(process.wait(timeout=10), 0)

    def status(self):
        result = self.invoke("status", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_run_preserves_exit_status_pid_and_signal(self):
        result = self.invoke("run", "--", sys.executable, "-c", "raise SystemExit(37)")
        self.assertEqual(result.returncode, 37, result.stderr)
        for mode in ((), ("--exclusive", "device")):
            with self.subTest(mode=mode):
                process = self.start([sys.executable, "-c",
                                      "import os,signal; print(os.getpid(), flush=True); signal.pause()"], mode)
                self.ready([process.stdout])
                self.assertEqual(int(process.stdout.readline()), process.pid)
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=10), -signal.SIGTERM)
        self.assertEqual(self.status()["exclusive"], [])

    def test_named_lock_exclusion_try_waiters_and_unrestricted_run(self):
        # Sibling callers can share the resource-free transition marker; that
        # marker must never grant reentry to another sibling\'s named lock.
        self.env["HEAVY_LEASE_TOKEN"] = "no-host-admission"
        critical = str(self.home / "critical")
        first = self.start([sys.executable, "-c", CONTROLLED, critical], ("--exclusive", "device"))
        self.event(first, b"entered\n")
        busy = self.invoke("run", "--try", "--exclusive", "device", "--", "/usr/bin/true")
        self.assertEqual(busy.returncode, 2, busy.stderr)
        self.assertIn("busy: exclusive-device", busy.stderr)
        immediate = self.invoke(
            "run", "--try", "--weight", "4", "--class", "gate", "--memory", str(1 << 60),
            "--", sys.executable, "-c", "raise SystemExit(23)")
        self.assertEqual(immediate.returncode, 23, immediate.stderr)
        folder = self.state / "waiters"
        folder.mkdir(exist_ok=True)
        libc = ctypes.CDLL(None, use_errno=True)
        watch = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        self.assertGreaterEqual(watch, 0)
        self.addCleanup(os.close, watch)
        self.assertGreaterEqual(libc.inotify_add_watch(watch, os.fsencode(folder), 0x80), 0)
        second = self.start([sys.executable, "-c", CONTROLLED, critical],
                            ("--wait", "--exclusive", "device"))
        self.ready([watch])
        os.read(watch, 65536)
        snapshot = self.status()
        self.assertEqual([entry["name"] for entry in snapshot["exclusive"]], ["exclusive-device"])
        self.assertEqual(snapshot["holder"]["pid"], first.pid)
        self.assertEqual([waiter["pid"] for waiter in snapshot["waiters"]], [second.pid])
        self.assertIsNone(second.poll())
        self.release(first)
        self.event(second, b"entered\n")
        self.release(second)
        self.assertEqual(self.status(), {"exclusive": [], "holder": None, "waiters": []})

    def test_old_flags_nested_named_lock_and_direct_handoff_adopt(self):
        result = self.invoke("run", "--weight", "2", "--class", "gate", "--memory", "0", "--",
                             sys.executable, "-c",
                             'import os; assert os.environ["HEAVY_LEASE_TOKEN"]; '
                             'assert "HEAVY_LEASE_FDS" not in os.environ; assert "HEAVY_LEASE_FD" not in os.environ')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.state.exists())
        nested = [str(CLI), "run", "--try", "--weight", "0", "--memory", "0",
                  "--class", "efficiency", "--exclusive", "device", "--",
                  sys.executable, "-c", "raise SystemExit(29)"]
        # subprocess drops the descriptor; the live parent's token still borrows
        # the same named lock, as win-vm's nested callers do.
        program = "import subprocess,sys; sys.exit(subprocess.run(sys.argv[1:]).returncode)"
        result = self.invoke("run", "--wait", "--exclusive", "device", "--",
                             sys.executable, "-c", program, *nested)
        self.assertEqual(result.returncode, 29, result.stderr)
        for action in (("handoff",), ("adopt", "--socket", "/no/such/socket")):
            result = self.invoke(*action, "--", sys.executable, "-c", "raise SystemExit(31)")
            self.assertEqual(result.returncode, 31, result.stderr)
        result = self.invoke("handoff", "--", "/bin/bash", "-uc",
                             'exec "$1" adopt --socket "$HEAVY_LEASE_SOCKET" -- "$2" -c "raise SystemExit(33)"',
                             "fixture", str(CLI), sys.executable)
        self.assertEqual(result.returncode, 33, result.stderr)

    def test_isolate_discards_lock_context_without_releasing_parent(self):
        manager_bin = self.home / "manager-bin"
        manager_bin.mkdir()
        manager = manager_bin / "systemd-run"
        manager.write_text(f"#!{sys.executable}\n" + ISOLATE_MANAGER)
        manager.chmod(0o700)
        payload = '''
import json, os, subprocess, sys
fd = int(sys.argv[2])
try:
    os.fstat(fd)
    inherited = True
except OSError:
    inherited = False
contender = subprocess.run([sys.argv[1], "run", "--try", "--exclusive", "device", "--", "/usr/bin/true"],
                           env={"HOME": os.environ["HOME"]}, capture_output=True)
print(json.dumps({"inherited": inherited, "context": [key for key in os.environ if key.startswith("HEAVY_LEASE_")],
                  "busy": contender.returncode, "args": sys.argv[3:]}))
raise SystemExit(23)
'''
        parent = '''
import json, os, subprocess, sys
fd = int(os.environ["HEAVY_LEASE_FD"])
result = subprocess.run([sys.argv[1], "isolate", "--", sys.executable, "-c", sys.argv[2], sys.argv[1], str(fd),
                         "--try", "a b", "*"], pass_fds=(fd,), capture_output=True, text=True)
assert result.returncode == 23, result.stderr
print(result.stdout, end="")
os.fstat(fd)
'''
        for ci in (None, "", "1"):
            environment = {**self.env, "PATH": f"{manager_bin}:{self.env['PATH']}"}
            if ci is not None:
                environment["CI"] = ci
            with self.subTest(CI=ci):
                result = self.invoke("run", "--exclusive", "device", "--", sys.executable,
                                     "-c", parent, str(CLI), payload, env=environment)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"inherited": False, "context": [], "busy": 2,
                                                             "args": ["--try", "a b", "*"]})
                self.assertEqual(self.status()["exclusive"], [])

    def test_isolate_reenters_gah_workspace_and_fails_closed_without_its_cli(self):
        manager_bin = self.home / "manager-bin"
        manager_bin.mkdir()
        manager = manager_bin / "systemd-run"
        manager.write_text(f"#!{sys.executable}\n" + ISOLATE_MANAGER)
        manager.chmod(0o700)
        root = self.home / "repos"
        main = root / "r/main/subdir"
        private = root / "r/ws/abc123/subdir"
        for directory, content in ((main, "main"), (private, "private")):
            directory.mkdir(parents=True)
            (directory / "tree").write_text(content)
        entry = '''
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
assert args[:3] == ["enter", "r/abc123", "--"], args
root = Path(os.environ["GAH_ROOT"]) / "r"
relative = Path.cwd().relative_to(root / "main")
os.chdir(root / "ws/abc123" / relative)
import subprocess
code = subprocess.run(args[3:], check=False).returncode
raise SystemExit(code if code >= 0 else 128 - code)
'''
        for name in ("gah", "selected-gah"):
            binary = manager_bin / name
            binary.write_text(f"#!{sys.executable}\n" + entry)
            binary.chmod(0o700)
        payload = '''
import json
import os
from pathlib import Path
import sys
print(json.dumps({"tree": Path("tree").read_text(), "cwd": str(Path.cwd()), "workspace": os.environ["GAH_WORKSPACE"], "root": os.environ["GAH_ROOT"], "args": sys.argv[1:]}))
raise SystemExit(23)
'''
        environment = {**self.env, "PATH": f"{manager_bin}:{self.env['PATH']}", "GAH_WORKSPACE": "r/abc123", "GAH_ROOT": str(root)}
        for binary in (None, str(manager_bin / "selected-gah")):
            with self.subTest(GAH_BIN=binary):
                current = {**environment, **({"GAH_BIN": binary} if binary else {})}
                result = self.invoke("isolate", "--", sys.executable, "-c", payload, "--try", "a b", "*", env=current, cwd=main)
                self.assertEqual(result.returncode, 23, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"tree": "private", "cwd": str(private), "workspace": "r/abc123", "root": str(root), "args": ["--try", "a b", "*"]})
        for program, code in (("raise SystemExit(143)", 143), ("import os, signal; os.kill(os.getpid(), signal.SIGTERM)", -signal.SIGTERM)):
            result = self.invoke("isolate", "--", sys.executable, "-c", program, env=environment, cwd=main)
            self.assertEqual(result.returncode, code, result.stderr)
        unavailable = {**environment, "GAH_BIN": str(self.home / "missing-gah")}
        result = self.invoke("isolate", "--", sys.executable, "-c", "raise SystemExit(99)", env=unavailable, cwd=main)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("gah executable is unavailable", result.stderr)
        result = self.invoke("isolate", "--", sys.executable, "-c", "raise SystemExit(99)", env={**environment, "GAH_WORKSPACE": ""}, cwd=main)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("GAH_WORKSPACE is empty", result.stderr)
        result = self.invoke("isolate", "--", sys.executable, "-c", payload, env={**unavailable, "CI": "1"}, cwd=main)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(json.loads(result.stdout)["tree"], "main")
        self.assertFalse(list(self.home.glob("hl-isolate-*")))
