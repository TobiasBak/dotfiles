import array
from datetime import datetime
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "cli/heavy-lease.py"
CONTROLLED = '''
import os
from pathlib import Path
import sys
critical = Path(sys.argv[1])
critical.mkdir()
print("entered", flush=True)
assert sys.stdin.readline() == "release\\n"
critical.rmdir()
print("exited", flush=True)
'''
ORPHAN = '''
import os
import signal
import sys
child = os.fork()
if child == 0:
    print(os.getpid(), flush=True)
    assert sys.stdin.readline() == "release\\n"
    os._exit(0)
signal.pause()
'''
FAKE_MANAGER = '''
import os
import subprocess
import sys
cli, mode = sys.argv[1:3]
if mode == "adopt":
    command = [cli, "adopt", "--socket", os.environ["HEAVY_LEASE_SOCKET"], "--", *sys.argv[3:]]
else:
    command = [cli, "handoff", "--", *sys.argv[3:]]
service = subprocess.Popen(command, close_fds=True, start_new_session=True)
sys.exit(service.wait())
'''
REMOTE = '''
import json
import os
import socket
import sys
with socket.socket(socket.AF_UNIX) as peer:
    peer.connect(sys.argv[1])
    peer.sendall(json.dumps({"pid": os.getpid(), "fd": int(os.environ["HEAVY_LEASE_FD"]), "socket": os.environ["HEAVY_LEASE_SOCKET"]}).encode() + b"\\n")
    assert peer.recv(1) == b"x"
'''
ISOLATION_HOLDER = '''
import json
import os
import socket
import subprocess
import sys
cli, path, program = sys.argv[1:]
fd = int(os.environ["HEAVY_LEASE_FD"])
with socket.socket(socket.AF_UNIX) as peer:
    peer.connect(path)
    peer.sendall(json.dumps({"pid": os.getpid(), "fd": fd, "socket": os.environ["HEAVY_LEASE_SOCKET"]}).encode() + b"\\n")
    assert peer.recv(1) == b"i"
    control = socket.socket(socket.AF_UNIX)
    control.connect(path)
    control.set_inheritable(True)
    child = os.fork()
    if child == 0:
        peer.close()
        os.environ["HEAVY_LEASE_FUTURE_FIELD"] = "future-capability"
        os.execv(cli, [cli, "isolate", "--", sys.executable, "-c", program, cli, str(fd), str(control.fileno()), "--try", "a b", "*"])
    peer.sendall(json.dumps({"child": child, "control_fd": control.fileno()}).encode() + b"\\n")
    control.close()
    assert peer.recv(1) == b"a"
    adopted = subprocess.run([cli, "adopt", "--socket", os.environ["HEAVY_LEASE_SOCKET"], "--", "true"], capture_output=True)
    peer.sendall(json.dumps({"adopt_exit": adopted.returncode, "error": adopted.stderr.decode()}).encode() + b"\\n")
    assert peer.recv(1) == b"x"
'''
ISOLATED = '''
import errno
import json
import os
import socket
import subprocess
import sys
cli, fd, control = sys.argv[1:4]
try:
    os.fstat(int(fd))
except OSError as error:
    closed = error.errno == errno.EBADF
else:
    closed = False
scratch = [number for number in (3, 4, 8, 9) if os.fstat(number)]
contender = subprocess.run([cli, "run", "--try", "--", "true"], capture_output=True)
with socket.socket(fileno=int(control)) as peer:
    peer.sendall(json.dumps({"pid": os.getpid(), "argv": sys.argv, "context": {name: value for name, value in os.environ.items() if name.startswith("HEAVY_LEASE_")}, "closed": closed, "scratch": scratch, "try_exit": contender.returncode}).encode() + b"\\n")
    assert peer.recv(1) == b"x"
'''
NESTED = '''
import json
import os
from pathlib import Path
import subprocess
import sys
holder = json.loads((Path.home() / ".local/state/heavy-lease/holder.json").read_text())
status = subprocess.run([sys.argv[1], "status", "--json"], capture_output=True, text=True, check=True)
wrong_token = subprocess.run(
    [sys.argv[1], "run", "--try", "--", sys.executable, "-c", "raise SystemExit(99)"],
    env={**os.environ, "HEAVY_LEASE_TOKEN": "not-matching-" + holder["token"]},
    capture_output=True, text=True,
)
print(json.dumps({"pid": os.getpid(), "holder": holder, "status": json.loads(status.stdout), "wrong_token_exit": wrong_token.returncode, "inherited_fd": os.environ.get("HEAVY_LEASE_FD")}))
sys.exit(37)
'''


class HeavyLeaseTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".cache/agent-tmp/heavy-lease"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.state = self.home / ".local/state/heavy-lease"
        self.env = {"HOME": str(self.home), "PATH": os.environ["PATH"], "LC_ALL": "C", "T3_THREAD_ID": "fixture-thread", "XDG_RUNTIME_DIR": str(self.home)}
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

    def invoke(self, *args, env=None, pass_fds=(), cwd=None):
        return subprocess.run(
            [str(CLI), *args], env=self.env if env is None else env,
            cwd=self.home if cwd is None else cwd, pass_fds=pass_fds,
            capture_output=True, text=True, timeout=10,
        )

    def start(self, command, mode=(), cwd=None):
        process = subprocess.Popen(
            [str(CLI), "run", *mode, "--", *command],
            env=self.env, cwd=self.home if cwd is None else cwd,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, bufsize=0,
        )
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

    def finish(self, process, code=0):
        self.assertEqual(process.wait(timeout=10), code)

    def release(self, process):
        process.stdin.write(b"release\n")
        self.event(process, b"exited\n")
        self.finish(process)

    def status(self):
        result = self.invoke("status", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_contenders_serialize_across_directories_and_report_holder(self):
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        critical = self.home / "critical"
        command = [sys.executable, "-c", CONTROLLED, str(critical)]
        first = self.start(command)
        self.event(first, b"entered\n")
        busy = self.status()
        self.assertEqual(set(busy), {"busy", "holder"})
        self.assertIs(busy["busy"], True)
        self.assertEqual(busy["holder"]["pid"], first.pid)
        self.assertEqual(busy["holder"]["pgid"], first.pid)
        self.assertEqual(busy["holder"]["command"], command)
        self.assertIsNotNone(datetime.fromisoformat(busy["holder"]["start_time"]).tzinfo)
        self.assertEqual(busy["holder"]["T3_THREAD_ID"], "fixture-thread")
        self.assertEqual([busy["holder"][key] for key in ("repo", "worktree", "branch")], [None, None, None])
        elsewhere = self.home / "elsewhere"
        elsewhere.mkdir()
        contenders = [self.start(command, mode=("--wait",), cwd=elsewhere), self.start(command)]
        rejected = self.invoke("run", "--try", "--", sys.executable, "-c", "raise SystemExit(99)")
        self.assertEqual(rejected.returncode, 2)
        self.assertTrue(rejected.stderr.startswith("busy: "), rejected.stderr)
        self.assertIn(str(first.pid), rejected.stderr)
        self.assertIn("fixture-thread", rejected.stderr)
        self.assertEqual(rejected.stdout, "")
        self.release(first)
        for _ in range(2):
            stream = self.ready([process.stdout for process in contenders])
            active = next(process for process in contenders if process.stdout is stream)
            self.assertEqual(stream.readline(), b"entered\n")
            self.assertEqual(self.status()["holder"]["pid"], active.pid)
            self.release(active)
            contenders.remove(active)
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        self.assertEqual(self.invoke("status").stdout, "free\n")
        self.assertFalse(critical.exists())

    def test_killed_holder_leaves_live_orphan_holding_lease(self):
        holder = self.start([sys.executable, "-c", ORPHAN])
        self.ready([holder.stdout])
        child = int(holder.stdout.readline())
        child_exit = os.pidfd_open(child)
        self.addCleanup(os.close, child_exit)
        holder.kill()
        self.finish(holder, -signal.SIGKILL)
        busy = self.status()
        self.assertIs(busy["busy"], True)
        self.assertEqual(busy["holder"]["pid"], holder.pid)
        rejected = self.invoke("run", "--try", "--", "true")
        self.assertEqual(rejected.returncode, 2, rejected.stderr)
        holder.stdin.write(b"release\n")
        self.ready([child_exit])
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def test_nested_exec_preserves_pid_holder_and_git_worktree_context(self):
        repo = self.home / "repo"
        worktree = self.home / "worktree"
        for args in (
            ["init", "-b", "main", str(repo)],
            ["-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"],
            ["-C", str(repo), "worktree", "add", "-b", "fixture-branch", str(worktree)],
        ):
            result = subprocess.run(["git", *args], env=self.env, cwd=self.home, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        command = [str(CLI), "run", "--try", "--", str(CLI), "run", "--", sys.executable, "-c", NESTED, str(CLI)]
        process = self.start(command, cwd=worktree)
        output, error = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 37, error.decode())
        observed = json.loads(output)
        self.assertEqual(observed["pid"], process.pid)
        original = observed["holder"]
        self.assertEqual(original["pid"], process.pid)
        self.assertEqual(original["command"], command)
        self.assertEqual(original["repo"], str(repo))
        self.assertEqual(original["worktree"], str(worktree))
        self.assertEqual(original["branch"], "fixture-branch")
        self.assertEqual(observed["status"], {"busy": True, "holder": original})
        self.assertEqual(observed["wrong_token_exit"], 2)
        self.assertEqual(json.loads((self.state / "holder.json").read_text()), original)
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def test_token_only_sibling_reentry_and_stale_token_rejection(self):
        self.state.mkdir(parents=True)
        stale = {"pid": os.getpid(), "command": ["stale-holder"], "token": "expired-context"}
        metadata = self.state / "holder.json"
        metadata.write_text(json.dumps(stale))
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        command = [sys.executable, "-c", CONTROLLED, str(self.home / "critical")]
        holder = self.start(command)
        self.event(holder, b"entered\n")
        original = json.loads(metadata.read_text())
        token = original["token"]
        self.assertEqual(len(token), 32)
        int(token, 16)
        transferred = {**self.env, "HEAVY_LEASE_TOKEN": token}
        result = self.invoke("run", "--try", "--", sys.executable, "-c", NESTED, str(CLI), env=transferred)
        self.assertEqual(result.returncode, 37, result.stderr)
        observed = json.loads(result.stdout)
        self.assertNotEqual(observed["pid"], holder.pid)
        self.assertIsNone(observed["inherited_fd"])
        self.assertEqual(observed["holder"], original)
        self.assertEqual(observed["status"], {"busy": True, "holder": original})
        self.assertEqual(observed["wrong_token_exit"], 2)
        self.assertEqual(json.loads(metadata.read_text()), original)
        expired = {**self.env, "HEAVY_LEASE_TOKEN": stale["token"]}
        result = self.invoke("run", "--try", "--", "true", env=expired)
        self.assertEqual(result.returncode, 2, result.stderr)
        metadata.write_text(json.dumps({**original, "token": "mismatched-holder-token"}))
        result = self.invoke("run", "--try", "--", "true", env=transferred)
        self.assertEqual(result.returncode, 2, result.stderr)
        metadata.write_text("not valid JSON")
        self.assertEqual(self.status(), {"busy": True, "holder": None})
        result = self.invoke("run", "--try", "--", "true", env=transferred)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(result.stderr.startswith("busy: "), result.stderr)
        self.release(holder)
        result = self.invoke("run", "--try", "--", sys.executable, "-c", NESTED, str(CLI), env=transferred)
        self.assertEqual(result.returncode, 37, result.stderr)
        observed = json.loads(result.stdout)
        self.assertIs(observed["status"]["busy"], True)
        self.assertEqual(observed["status"]["holder"], observed["holder"])
        self.assertEqual(observed["wrong_token_exit"], 2)
        self.assertEqual(observed["holder"]["pid"], observed["pid"])
        self.assertNotEqual(observed["holder"]["token"], token)
        self.assertIsNotNone(observed["inherited_fd"])
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        subsequent = self.start(command)
        self.event(subsequent, b"entered\n")
        result = self.invoke("run", "--try", "--", "true", env=transferred)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.release(subsequent)
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def test_shell_scratch_descriptors_do_not_release_nested_lease(self):
        command = [
            "/bin/bash", "-c",
            'exec 3>&1 4>&2; exec 8>"$HOME/build.lock" 9>"$HOME/env.lock"; '
            'flock 8; flock 9; exec "$@"', "fixture",
            str(CLI), "run", "--try", "--", sys.executable, "-c", CONTROLLED,
            str(self.home / "critical"),
        ]
        process = self.start(command)
        self.event(process, b"entered\n")
        self.assertIs(self.status()["busy"], True)
        result = self.invoke("run", "--try", "--", "true")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.release(process)
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def remote_listener(self):
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        path = str(self.home / "ready")
        listener.bind(path)
        listener.listen()
        listener.settimeout(10)
        return listener, path

    def remote_ready(self, listener):
        peer, _ = listener.accept()
        self.addCleanup(peer.close)
        peer.settimeout(10)
        stream = peer.makefile("rb")
        self.addCleanup(stream.close)
        observed = json.loads(stream.readline())
        pid = observed["pid"]
        self.addCleanup(self.kill_group, pid)
        pidfd = os.pidfd_open(pid)
        self.addCleanup(os.close, pidfd)
        self.assertGreaterEqual(observed["fd"], 64)
        self.assertEqual(stat.S_IMODE(Path(observed["socket"]).parent.stat().st_mode), 0o700)
        return peer, observed, pidfd

    def kill_group(self, pid):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def test_detached_manager_service_retains_lease_after_launcher_group_dies(self):
        listener, ready_path = self.remote_listener()
        launcher = self.start([
            str(CLI), "handoff", "--", sys.executable, "-c", FAKE_MANAGER,
            str(CLI), "adopt", sys.executable, "-c", REMOTE, ready_path,
        ])
        peer, observed, service_exit = self.remote_ready(listener)
        self.assertNotEqual(observed["pid"], launcher.pid)
        self.kill_group(launcher.pid)
        self.finish(launcher, -signal.SIGKILL)
        os.kill(observed["pid"], 0)
        self.assertIs(self.status()["busy"], True)
        result = self.invoke("run", "--try", "--", "true")
        self.assertEqual(result.returncode, 2, result.stderr)
        peer.sendall(b"x")
        self.ready([service_exit])
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def test_nested_handoff_recovers_fd_dropped_by_fixture_driver(self):
        listener, ready_path = self.remote_listener()
        launcher = self.start([
            str(CLI), "handoff", "--", sys.executable, "-c", FAKE_MANAGER,
            str(CLI), "handoff", sys.executable, "-c", FAKE_MANAGER,
            str(CLI), "adopt", "/bin/bash", "-c",
            'exec 3>&1 4>&2; exec 8>"$HOME/build.lock" 9>"$HOME/env.lock"; '
            'flock 8; flock 9; exec "$@"', "fixture", sys.executable, "-c", REMOTE, ready_path,
        ])
        peer, observed, service_exit = self.remote_ready(listener)
        self.assertIs(self.status()["busy"], True)
        result = self.invoke("run", "--try", "--", "true")
        self.assertEqual(result.returncode, 2, result.stderr)
        peer.sendall(b"x")
        self.ready([service_exit])
        self.finish(launcher)
        self.assertFalse(Path(observed["socket"]).parent.exists())
        self.assertFalse(list(self.home.glob("hl-*")))
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def test_isolate_discards_adopted_context_without_releasing_parent_or_retaining_lease(self):
        listener, ready_path = self.remote_listener()
        launcher = self.start([
            str(CLI), "handoff", "--", sys.executable, "-c", FAKE_MANAGER,
            str(CLI), "adopt", "/bin/bash", "-c",
            'exec 3>&1 4>&2; exec 8>"$HOME/build.lock" 9>"$HOME/env.lock"; '
            'exec "$@"', "fixture", sys.executable, "-c", ISOLATION_HOLDER,
            str(CLI), ready_path, ISOLATED,
        ])
        parent, inherited, parent_exit = self.remote_ready(listener)
        original = self.status()["holder"]
        metadata = (self.state / "holder.json").read_bytes()
        parent_stream = parent.makefile("rb")
        self.addCleanup(parent_stream.close)
        parent.sendall(b"i")
        self.ready([parent_stream])
        forked = json.loads(parent_stream.readline())
        child = forked["child"]
        child_exit = os.pidfd_open(child)
        self.addCleanup(os.close, child_exit)
        isolated, _ = listener.accept()
        self.addCleanup(isolated.close)
        isolated.settimeout(10)
        isolated_stream = isolated.makefile("rb")
        self.addCleanup(isolated_stream.close)
        self.ready([isolated_stream])
        observed = json.loads(isolated_stream.readline())
        self.assertEqual(observed["pid"], child)
        self.assertEqual(observed["argv"], ["-c", str(CLI), str(inherited["fd"]), str(forked["control_fd"]), "--try", "a b", "*"])
        self.assertEqual(observed["context"], {})
        self.assertIs(observed["closed"], True)
        self.assertEqual(observed["scratch"], [3, 4, 8, 9])
        self.assertEqual(observed["try_exit"], 2)
        self.assertEqual(self.status(), {"busy": True, "holder": original})
        self.assertEqual((self.state / "holder.json").read_bytes(), metadata)
        self.assertTrue(Path(inherited["socket"]).is_socket())
        parent.sendall(b"a")
        self.ready([parent_stream])
        adoption = json.loads(parent_stream.readline())
        self.assertEqual(adoption["adopt_exit"], 0, adoption["error"])
        self.assertEqual(self.status(), {"busy": True, "holder": original})
        parent.sendall(b"x")
        self.ready([parent_exit])
        self.finish(launcher)
        os.kill(child, 0)
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        isolated.sendall(b"x")
        self.ready([child_exit])
        self.assertFalse(Path(inherited["socket"]).parent.exists())

        unavailable_home = self.home / "not-a-directory"
        unavailable_home.write_text("fixture")
        environment = {**self.env, "HOME": str(unavailable_home), "HEAVY_LEASE_FD": str(1 << 80), "HEAVY_LEASE_FUTURE_FIELD": "discard"}
        result = self.invoke("isolate", "--", sys.executable, "-c", "raise SystemExit(23)", env=environment)
        self.assertEqual(result.returncode, 23, result.stderr)
        result = self.invoke("isolate", "--", sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)", env=environment)
        self.assertEqual(result.returncode, -signal.SIGTERM, result.stderr)
        result = self.invoke("isolate", "true", env=environment)
        self.assertEqual(result.returncode, 1)
        self.assertIn("expected -- followed by a command", result.stderr)

    def test_handoff_and_adopt_reject_bad_context_and_bound_missing_receiver(self):
        result = self.invoke("handoff", "--", "true")
        self.assertNotIn(result.returncode, (0, 2), result)
        result = self.invoke("adopt", "--socket", str(self.home / "missing"), "--", "true")
        self.assertNotIn(result.returncode, (0, 2), result)
        holder = self.start([sys.executable, "-c", CONTROLLED, str(self.home / "critical")])
        self.event(holder, b"entered\n")
        token = json.loads((self.state / "holder.json").read_text())["token"]
        result = self.invoke("handoff", "--", "true", env={**self.env, "HEAVY_LEASE_TOKEN": token, "HEAVY_LEASE_SOCKET": str(self.home / "dead")})
        self.assertNotIn(result.returncode, (0, 2), result)
        self.release(holder)
        bad_adoption = '''
import os
import subprocess
import sys
result = subprocess.run([sys.argv[1], "adopt", "--socket", os.environ["HEAVY_LEASE_SOCKET"], "--", "true"], env={**os.environ, "HEAVY_LEASE_TOKEN": "wrong-token"})
sys.exit(result.returncode)
'''
        result = self.invoke("run", "--", str(CLI), "handoff", "--", sys.executable, "-c", bad_adoption, str(CLI))
        self.assertNotIn(result.returncode, (0, 2), result)
        self.assertIn("exactly one descriptor", result.stderr)
        result = self.invoke("run", "--", str(CLI), "handoff", "--", sys.executable, "-c", "import signal; signal.pause()")
        self.assertNotIn(result.returncode, (0, 2), result)
        self.assertIn("no lease receiver within 5 seconds", result.stderr)
        self.assertFalse(list(self.home.glob("hl-*")))
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def test_adopt_rejects_missing_extra_or_unlocked_descriptors(self):
        holder = self.start([sys.executable, "-c", CONTROLLED, str(self.home / "critical")])
        self.event(holder, b"entered\n")
        token = json.loads((self.state / "holder.json").read_text())["token"]
        for count in (0, 1, 2):
            with self.subTest(descriptors=count):
                path = self.home / f"bad-broker-{count}"
                with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as listener:
                    listener.bind(str(path))
                    listener.listen()
                    listener.settimeout(10)
                    process = subprocess.Popen(
                        [str(CLI), "adopt", "--socket", str(path), "--", "true"],
                        env={**self.env, "HEAVY_LEASE_TOKEN": token}, cwd=self.home,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                    )
                    self.processes.append(process)
                    with listener.accept()[0] as peer, (self.state / "lock").open("r+") as file:
                        peer.settimeout(10)
                        self.assertEqual(peer.recv(128), token.encode())
                        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [file.fileno()] * count))] if count else []
                        peer.sendmsg([b"lease"], ancillary)
                    _, error = process.communicate(timeout=10)
                    self.assertNotIn(process.returncode, (0, 2), error)
                    expected = b"not the current held lease" if count == 1 else b"exactly one descriptor"
                    self.assertIn(expected, error)
        self.release(holder)

    def test_command_exit_signal_and_cli_failures(self):
        result = self.invoke("run", "--", sys.executable, "-c", "import sys; print(repr(sys.argv[1:])); sys.exit(23)", "--try", "a b", "*")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(result.stdout, "['--try', 'a b', '*']\n")
        result = self.invoke("run", "--", sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)")
        self.assertEqual(result.returncode, -signal.SIGTERM, result.stderr)
        launcher = '''
import os
import sys
os.execv(sys.argv[1], [sys.argv[1], "adopt", "--socket", os.environ["HEAVY_LEASE_SOCKET"], "--", sys.executable, "-c", sys.argv[2]])
'''
        for program, expected in (("raise SystemExit(37)", 37), ("import os, signal; os.kill(os.getpid(), signal.SIGTERM)", -signal.SIGTERM)):
            result = self.invoke("run", "--", str(CLI), "handoff", "--", sys.executable, "-c", launcher, str(CLI), program)
            self.assertEqual(result.returncode, expected, result.stderr)
        for args in (("run",), ("run", "--"), ("run", "--wait", "--try", "--", "true"), ("status", "--unknown"), ("run", "--", "missing-fixture-command")):
            result = self.invoke(*args)
            self.assertNotIn(result.returncode, (0, 2), (args, result))
            self.assertTrue(result.stderr)
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        (self.state / "lock").unlink()
        (self.state / "lock").mkdir()
        result = self.invoke("status", "--json")
        self.assertNotIn(result.returncode, (0, 2), result)
        self.assertTrue(result.stderr.startswith("heavy-lease: "), result.stderr)


if __name__ == "__main__":
    unittest.main()
