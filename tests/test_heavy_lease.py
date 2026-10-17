import array
import ctypes
from datetime import datetime
import fcntl
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
POOL_SIZE = 4
MEMORY_PER_SLOT = 17 * 1024**3 // POOL_SIZE
FREE_TEXT = f"pool: 0/{POOL_SIZE} slots in use; 0 exclusive locks; 0 waiters\n"


def fake_memory_environment(home):
    meminfo = home / "meminfo"
    meminfo.write_text(f"MemAvailable: {64 * 1024**2} kB\n")
    root = home / "cgroup"
    for relative in ("", "parent", "parent/leaf"):
        group = root / relative
        group.mkdir(parents=True, exist_ok=True)
        (group / "memory.max").write_text("max\n")
        (group / "memory.current").write_text("0\n")
        (group / "memory.stat").write_text("inactive_file 0\n")
    membership = home / "self.cgroup"
    membership.write_text("0::/parent/leaf\n")
    return {
        "HEAVY_LEASE_MEMINFO": str(meminfo),
        "HEAVY_LEASE_CGROUP_ROOT": str(root),
        "HEAVY_LEASE_CGROUP_FILE": str(membership),
    }


def pool_summary(value):
    return {"busy": bool(value["slots"]), "holder": value["slots"][0]["holder"] if value["slots"] else None}

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
    extra = os.open(os.path.join(os.environ["HOME"], "extra-capability"), os.O_CREAT | os.O_RDWR, 0o600)
    os.set_inheritable(extra, True)
    capabilities = {}
    for name, number in [("lease", fd), ("extra", extra), *((str(number), number) for number in (3, 4, 8, 9))]:
        info = os.fstat(number)
        capabilities[name] = [info.st_dev, info.st_ino, info.st_mode]
    encoded = json.dumps(capabilities)
    environment = {**os.environ, "HEAVY_LEASE_FUTURE_FIELD": "future-capability", "HEAVY_LEASE_UNKNOWN_EMPTY": "", "HEAVY_LEASE_": ""}
    child = os.fork()
    if child == 0:
        peer.close()
        os.execve(cli, [cli, "isolate", "--", sys.executable, "-c", program, cli, path, encoded, "--try", "a b", "*"], environment)
    peer.sendall(json.dumps({"child": child, "extra_fd": extra, "capabilities": encoded, "environment": environment}).encode() + b"\\n")
    os.close(extra)
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
cli, path, encoded = sys.argv[1:4]
inherited = {}
for name in os.listdir("/proc/self/fd"):
    number = int(name)
    if number < 3:
        continue
    try:
        info = os.fstat(number)
    except OSError as error:
        if error.errno != errno.EBADF:
            raise
    else:
        inherited[number] = [info.st_dev, info.st_ino, info.st_mode]
retained = {name: identity in inherited.values() for name, identity in json.loads(encoded).items()}
contender = subprocess.run([cli, "run", "--try", "--", "true"], capture_output=True)
print("isolate-target-stdout", flush=True)
print("isolate-target-stderr", file=sys.stderr, flush=True)
with socket.socket(socket.AF_UNIX) as peer:
    peer.connect(path)
    peer.sendall(json.dumps({"pid": os.getpid(), "pgid": os.getpgrp(), "argv": sys.argv, "environment": dict(os.environ), "context": {name: value for name, value in os.environ.items() if name.startswith("HEAVY_LEASE_")}, "retained": retained, "descriptors": sorted(inherited), "try_exit": contender.returncode}).encode() + b"\\n")
    assert peer.recv(1) == b"x"
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
NESTED = '''
import json
import os
from pathlib import Path
import subprocess
import sys
holder = json.loads((Path.home() / ".local/state/heavy-lease/slot-0.json").read_text())
status = subprocess.run([sys.argv[1], "status", "--json"], capture_output=True, text=True, check=True)
wrong_token = subprocess.run(
    [sys.argv[1], "run", "--weight", "4", "--try", "--", sys.executable, "-c", "raise SystemExit(99)"],
    env={**os.environ, "HEAVY_LEASE_TOKEN": "not-matching-" + holder["token"]},
    capture_output=True, text=True,
)
print(json.dumps({"pid": os.getpid(), "holder": holder, "status": {"busy": bool(json.loads(status.stdout)["slots"]), "holder": json.loads(status.stdout)["slots"][0]["holder"]}, "wrong_token_exit": wrong_token.returncode, "inherited_fd": os.environ.get("HEAVY_LEASE_FD")}))
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
        self.env.update(fake_memory_environment(self.home))
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

    def invoke(self, *args, env=None, pass_fds=(), cwd=None, weight=POOL_SIZE):
        return subprocess.run(
            [str(CLI), *([args[0], "--weight", str(weight), *args[1:]] if args[0] == "run" and weight is not None else args)], env=self.env if env is None else env,
            cwd=self.home if cwd is None else cwd, pass_fds=pass_fds,
            capture_output=True, text=True, timeout=10,
        )

    def start(self, command, mode=(), cwd=None, weight=POOL_SIZE):
        process = subprocess.Popen(
            [str(CLI), "run", *(("--weight", str(weight)) if weight is not None else ()), *mode, "--", *command],
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
        value = json.loads(result.stdout)
        self.assertEqual(set(value), {"pool_size", "slots", "exclusive", "waiters"})
        self.assertEqual(value["pool_size"], POOL_SIZE)
        self.assertIsInstance(value["waiters"], list)
        if value["slots"]:
            self.assertEqual(len(value["slots"]), POOL_SIZE)
        return pool_summary(value)

    def watch_waiters(self):
        folder = self.state / "waiters"
        folder.mkdir(parents=True, exist_ok=True)
        libc = ctypes.CDLL(None, use_errno=True)
        fd = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        self.assertGreaterEqual(fd, 0)
        self.addCleanup(os.close, fd)
        self.assertGreaterEqual(libc.inotify_add_watch(fd, os.fsencode(folder), 0x00000080), 0)
        return fd

    def waiter_event(self, fd, process):
        target = f"{process.pid}.json".encode() + b"\0"
        while True:
            self.ready([fd])
            if target in os.read(fd, 65536):
                return

    def scheduler_status(self):
        result = self.invoke("status", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_class_priority_fifo_default_interactive_and_no_preemption(self):
        command = [sys.executable, "-c", CONTROLLED, str(self.home / "critical")]
        holder = self.start(command, mode=("--class", "efficiency"))
        self.event(holder, b"entered\n")
        notifications = self.watch_waiters()
        efficiency = self.start(command, mode=("--class", "efficiency"))
        self.waiter_event(notifications, efficiency)
        interactive_first = self.start(command, weight=None)
        self.waiter_event(notifications, interactive_first)
        interactive_second = self.start(command, mode=("--class", "interactive"))
        self.waiter_event(notifications, interactive_second)
        gate = self.start(command, mode=("--class", "gate"))
        self.waiter_event(notifications, gate)
        queued = self.scheduler_status()
        self.assertEqual({item["holder"]["pid"] for item in queued["slots"]}, {holder.pid})
        self.assertIsNone(holder.poll())
        expected_classes = {
            efficiency.pid: "efficiency", interactive_first.pid: "interactive",
            interactive_second.pid: "interactive", gate.pid: "gate",
        }
        self.assertEqual({item["pid"]: item["class"] for item in queued["waiters"]}, expected_classes)
        expected_peaks = {pid: POOL_SIZE * MEMORY_PER_SLOT for pid in expected_classes}
        expected_peaks[interactive_first.pid] = MEMORY_PER_SLOT
        self.assertEqual({item["pid"]: item["expected_peak"] for item in queued["waiters"]}, expected_peaks)
        self.release(holder)
        remaining = [gate, interactive_first, interactive_second, efficiency]
        for expected in tuple(remaining):
            self.assertIs(self.ready([process.stdout for process in remaining]), expected.stdout)
            self.assertEqual(expected.stdout.readline(), b"entered\n")
            admitted = self.scheduler_status()
            holders = [entry["holder"] for entry in admitted["slots"]]
            self.assertEqual({item["pid"] for item in holders}, {expected.pid})
            self.assertEqual({item["class"] for item in holders}, {expected_classes[expected.pid]})
            self.assertEqual({item["expected_peak"] for item in holders}, {expected_peaks[expected.pid]})
            remaining.remove(expected)
            self.release(expected)
        self.assertEqual(self.scheduler_status()["waiters"], [])

    def test_memory_head_cannot_be_skipped_and_rereads_host_and_ancestor_headroom(self):
        unit = MEMORY_PER_SLOT
        scenarios = (
            ("finite-parent-reclaims-inactive-file", 64 * unit, 4 * unit, 3 * unit, 0, "cache"),
            ("memavailable-minimum", unit, 4 * unit, 3 * unit, 2 * unit, "host"),
            ("unlimited-ancestors-still-use-host", unit, None, 0, 0, "host"),
            ("root-ancestor-cap", 64 * unit, 4 * unit, 0, 0, "root"),
            ("inactive-cache-cannot-make-usage-negative", 64 * unit, unit, unit, 2 * unit, "limit"),
        )
        for name, available, maximum, current, inactive, restore in scenarios:
            with self.subTest(headroom=name):
                self.env.update(fake_memory_environment(self.home))
                meminfo = Path(self.env["HEAVY_LEASE_MEMINFO"])
                meminfo.write_text(f"MemAvailable: {available // 1024} kB\n")
                root = Path(self.env["HEAVY_LEASE_CGROUP_ROOT"])
                parent = root / "parent"
                if maximum is not None:
                    (root / "memory.max").write_text(f"{32 * unit}\n")
                    (parent / "memory.max").write_text(f"{maximum}\n")
                    (parent / "memory.current").write_text(f"{current}\n")
                    (parent / "memory.stat").write_text(f"inactive_file {inactive}\n")
                    (parent / "leaf/memory.max").write_text(f"{16 * unit}\n")
                if restore == "root":
                    (root / "memory.max").write_text(f"{unit}\n")
                notifications = self.watch_waiters()
                head = self.start(
                    [sys.executable, "-c", CONTROLLED, str(self.home / "memory-head")],
                    mode=("--class", "gate"), weight=2,
                )
                self.waiter_event(notifications, head)
                blocked = self.scheduler_status()
                self.assertEqual(blocked["slots"], [])
                self.assertEqual(len(blocked["waiters"]), 1)
                self.assertEqual(
                    {key: blocked["waiters"][0][key] for key in ("pid", "class", "expected_peak", "admission_reason")},
                    {"pid": head.pid, "class": "gate", "expected_peak": 2 * unit, "admission_reason": "memory"},
                )
                small = self.start(
                    [sys.executable, "-c", CONTROLLED, str(self.home / "memory-small")],
                    mode=("--class", "efficiency"), weight=1,
                )
                self.waiter_event(notifications, small)
                blocked = self.scheduler_status()
                self.assertEqual(blocked["slots"], [])
                self.assertEqual({item["pid"] for item in blocked["waiters"]}, {head.pid, small.pid})
                by_pid = {item["pid"]: item for item in blocked["waiters"]}
                self.assertEqual(by_pid[head.pid]["admission_reason"], "memory")
                self.assertEqual(by_pid[small.pid]["class"], "efficiency")
                self.assertEqual(by_pid[small.pid]["expected_peak"], unit)
                rejected = self.invoke("run", "--try", "--class", "efficiency", "--", "true", weight=1)
                self.assertEqual(rejected.returncode, 2, rejected.stderr)
                with selectors.DefaultSelector() as selector:
                    selector.register(head.stdout, selectors.EVENT_READ)
                    selector.register(small.stdout, selectors.EVENT_READ)
                    self.assertEqual(selector.select(timeout=0), [])
                if restore == "cache":
                    restored, contents = parent / "memory.stat", f"inactive_file {2 * unit}\n"
                elif restore == "root":
                    restored, contents = root / "memory.max", f"{3 * unit}\n"
                elif restore == "limit":
                    restored, contents = parent / "memory.max", f"{3 * unit}\n"
                else:
                    restored, contents = meminfo, f"MemAvailable: {3 * unit // 1024} kB\n"
                replacement = restored.with_suffix(".next")
                replacement.write_text(contents)
                os.replace(replacement, restored)
                self.event(head, b"entered\n")
                self.event(small, b"entered\n")
                admitted = self.scheduler_status()
                self.assertEqual(len(admitted["slots"]), 3)
                self.assertEqual({item["holder"]["pid"] for item in admitted["slots"]}, {head.pid, small.pid})
                self.release(head)
                self.release(small)
                self.assertEqual(self.scheduler_status()["waiters"], [])

    def test_try_reports_live_holder_during_an_admission_transaction(self):
        holder = self.start([sys.executable, "-c", CONTROLLED, str(self.home / "critical")])
        self.event(holder, b"entered\n")
        with (self.state / "admission.lock").open("r+") as admission:
            fcntl.flock(admission, fcntl.LOCK_EX)
            rejected = self.invoke("run", "--try", "--", "true")
            self.assertEqual(rejected.returncode, 2, rejected.stderr)
            self.assertTrue(rejected.stderr.startswith("busy: pool admission in progress"), rejected.stderr)
            self.assertIn(str(holder.pid), rejected.stderr)
            self.assertIn("fixture-thread", rejected.stderr)
            self.assertEqual(rejected.stdout, "")
        self.release(holder)

    def test_zero_weight_exclusive_lane_has_zero_expected_peak_without_memory_headroom(self):
        Path(self.env["HEAVY_LEASE_MEMINFO"]).write_text("MemAvailable: 0 kB\n")
        holder = self.start(
            [sys.executable, "-c", CONTROLLED, str(self.home / "exclusive-critical")],
            mode=("--class", "gate", "--exclusive", "win-vm"), weight=0,
        )
        self.event(holder, b"entered\n")
        admitted = self.scheduler_status()
        self.assertEqual(admitted["slots"], [])
        self.assertEqual(len(admitted["exclusive"]), 1)
        metadata = admitted["exclusive"][0]["holder"]
        self.assertEqual(metadata["class"], "gate")
        self.assertEqual(metadata["expected_peak"], 0)
        self.assertEqual(metadata["pid"], holder.pid)
        self.release(holder)

    def test_weighted_sleep_pool_and_exclusive_lanes(self):
        sleeper = ["/bin/bash", "-c", 'echo entered; exec sleep 600']
        named_command = self.home / "or"
        named_command.write_text("#!/bin/sh\necho entered\nexec sleep 600\n")
        named_command.chmod(0o700)
        first = self.start([str(named_command), "test", "--full"], weight=None)
        self.event(first, b"entered\n")
        second = self.start(sleeper, mode=("--weight", "2"))
        self.event(second, b"entered\n")
        occupied = json.loads(self.invoke("status", "--json").stdout)
        self.assertEqual(len(occupied["slots"]), POOL_SIZE)
        self.assertEqual({entry["holder"]["pid"] for entry in occupied["slots"]}, {first.pid, second.pid})
        self.assertEqual(self.invoke("run", "--try", "--weight", "1", "--", "true").returncode, 2)
        notifications = self.watch_waiters()
        third = self.start(sleeper, mode=("--weight", "2"))
        self.waiter_event(notifications, third)
        queued = json.loads(self.invoke("status", "--json").stdout)["waiters"]
        self.assertEqual([(item["pid"], item["weight"]) for item in queued], [(third.pid, 2)])
        third.kill()
        self.finish(third, -signal.SIGKILL)
        self.assertEqual(json.loads(self.invoke("status", "--json").stdout)["waiters"], [])
        third = self.start(sleeper, mode=("--weight", "2"))
        self.waiter_event(notifications, third)
        with selectors.DefaultSelector() as selector:
            selector.register(third.stdout, selectors.EVENT_READ)
            self.assertEqual(selector.select(timeout=0), [])
        second.terminate()
        self.finish(second, -signal.SIGTERM)
        self.event(third, b"entered\n")
        self.assertIsNone(first.poll())
        third.kill()
        self.finish(third, -signal.SIGKILL)
        first.terminate()
        self.finish(first, -signal.SIGTERM)
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        vm = self.start(sleeper, mode=("--exclusive", "win-vm"), weight=None)
        self.event(vm, b"entered\n")
        exclusive = json.loads(self.invoke("status", "--json").stdout)
        self.assertEqual(exclusive["slots"], [])
        self.assertEqual([entry["name"] for entry in exclusive["exclusive"]], ["exclusive-win-vm"])
        blocked = self.start(sleeper, mode=("--exclusive", "win-vm"), weight=None)
        self.assertEqual(self.invoke("run", "--try", "--weight", "0", "--exclusive", "win-vm", "--", "true").returncode, 2)
        self.assertEqual(self.invoke("run", "--try", "--weight", "4", "--", "true").returncode, 0)
        vm.kill()
        self.finish(vm, -signal.SIGKILL)
        self.event(blocked, b"entered\n")
        blocked.terminate()
        self.finish(blocked, -signal.SIGTERM)
        self.assertEqual(json.loads(self.invoke("status", "--json").stdout)["exclusive"], [])
        combined = self.start(sleeper, mode=("--weight", "2", "--exclusive", "win-vm"))
        self.event(combined, b"entered\n")
        state = json.loads(self.invoke("status", "--json").stdout)
        self.assertEqual(len(state["slots"]), 2)
        self.assertEqual(len(state["exclusive"]), 1)
        self.assertEqual(self.invoke("run", "--try", "--weight", "2", "--", "true").returncode, 0)
        combined.kill()
        self.finish(combined, -signal.SIGKILL)

    def test_waiter_ignores_python3_on_project_path(self):
        project_bin = self.home / "project-bin"
        project_bin.mkdir()
        python = project_bin / "python3"
        python.write_text("#!/bin/sh\nexit 1\n")
        python.chmod(0o700)
        holders = []
        for slot in range(POOL_SIZE):
            holder = self.start(
                [sys.executable, "-c", CONTROLLED, str(self.home / f"critical-{slot}")],
                weight=1,
            )
            self.event(holder, b"entered\n")
            holders.append(holder)
        self.assertTrue(self.status()["busy"])
        notifications = self.watch_waiters()
        host_env = dict(self.env)
        self.env["PATH"] = str(project_bin) + os.pathsep + self.env["PATH"]
        waiter = self.start(["true"], mode=("--wait",), weight=None)
        event = self.ready([notifications, waiter.stdout])
        if event == notifications:
            self.waiter_event(notifications, waiter)
            queued = self.invoke("status", "--json", env=host_env)
            self.assertEqual(queued.returncode, 0, queued.stderr)
            self.assertEqual([item["pid"] for item in json.loads(queued.stdout)["waiters"]], [waiter.pid])
        self.release(holders.pop(0))
        output, error = waiter.communicate(timeout=10)
        self.assertEqual(waiter.returncode, 0, error.decode())
        self.assertEqual(output, b"")
        for holder in holders:
            self.release(holder)

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
        self.assertEqual(self.invoke("status").stdout, FREE_TEXT)
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
        self.assertEqual(json.loads((self.state / "slot-0.json").read_text()), original)
        self.assertEqual(self.status(), {"busy": False, "holder": None})

    def test_token_only_sibling_reentry_and_stale_token_rejection(self):
        self.state.mkdir(parents=True)
        stale = {"pid": os.getpid(), "command": ["stale-holder"], "token": "expired-context"}
        metadata = self.state / "slot-0.json"
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
        manager_bin = self.home / "manager-bin"
        manager_bin.mkdir()
        manager = manager_bin / "systemd-run"
        manager.write_text(f"#!{sys.executable}\n" + ISOLATE_MANAGER)
        manager.chmod(0o700)
        manager_events = manager_bin / "manager-events.jsonl"
        direct_bin = self.home / "direct-bin"
        direct_bin.mkdir()
        (direct_bin / "python3").symlink_to(sys.executable)
        (direct_bin / "true").symlink_to("/usr/bin/true")
        base_environment = self.env
        listener, ready_path = self.remote_listener()
        for ci in (None, "", "1"):
            with self.subTest(CI=ci):
                service = ci is None
                self.env = {**base_environment, "PATH": f"{manager_bin}:{base_environment['PATH']}" if service else str(direct_bin)}
                if ci is not None:
                    self.env["CI"] = ci
                events_before = manager_events.read_bytes() if manager_events.exists() else b""
                launcher = self.start([
                    str(CLI), "handoff", "--", sys.executable, "-c", FAKE_MANAGER,
                    str(CLI), "adopt", "/bin/bash", "-c",
                    'exec 3>&1 4>&2; exec 8>"$HOME/build.lock" 9>"$HOME/env.lock"; '
                    'exec "$@"', "fixture", sys.executable, "-c", ISOLATION_HOLDER,
                    str(CLI), ready_path, ISOLATED,
                ])
                parent, inherited, parent_exit = self.remote_ready(listener)
                original = self.status()["holder"]
                metadata = (self.state / "slot-0.json").read_bytes()
                parent_stream = parent.makefile("rb")
                self.addCleanup(parent_stream.close)
                parent.sendall(b"i")
                self.ready([parent_stream])
                forked = json.loads(parent_stream.readline())
                wrapper = forked["child"]
                wrapper_exit = os.pidfd_open(wrapper)
                self.addCleanup(os.close, wrapper_exit)
                isolated, _ = listener.accept()
                self.addCleanup(isolated.close)
                isolated.settimeout(10)
                isolated_stream = isolated.makefile("rb")
                self.addCleanup(isolated_stream.close)
                self.ready([isolated_stream])
                observed = json.loads(isolated_stream.readline())
                target_exit = os.pidfd_open(observed["pid"])
                self.addCleanup(os.close, target_exit)

                def kill_target(pidfd):
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

                self.addCleanup(kill_target, target_exit)
                if service:
                    self.assertNotEqual(observed["pid"], wrapper)
                    self.assertNotEqual(observed["pgid"], inherited["pid"])
                    self.assertEqual(observed["descriptors"], [])
                    events = [json.loads(line) for line in manager_events.read_text().splitlines()]
                    self.assertEqual(len(events), 1)
                    self.assertEqual(events[0], {"request_mode": 0o600, "directory_mode": 0o700, "pid": observed["pgid"]})
                else:
                    self.assertEqual(observed["pid"], wrapper)
                    self.assertEqual(observed["pgid"], inherited["pid"])
                    self.assertEqual(observed["descriptors"], sorted([3, 4, 8, 9, forked["extra_fd"]]))
                self.assertEqual(observed["argv"], ["-c", str(CLI), ready_path, forked["capabilities"], "--try", "a b", "*"])
                self.assertEqual(observed["context"], {})
                expected_environment = {name: value for name, value in forked["environment"].items() if not name.startswith("HEAVY_LEASE_")}
                self.assertEqual(observed["environment"], expected_environment)
                self.assertNotIn("MANAGER_ONLY_SENTINEL", observed["environment"])
                self.assertEqual(observed["retained"], {"lease": False, "extra": not service, **{str(number): not service for number in (3, 4, 8, 9)}})
                self.assertEqual(observed["try_exit"], 2)
                self.event(launcher, b"isolate-target-stdout\n")
                self.assertEqual(self.status(), {"busy": True, "holder": original})
                self.assertEqual((self.state / "slot-0.json").read_bytes(), metadata)
                self.assertTrue(Path(inherited["socket"]).is_socket())
                parent.sendall(b"a")
                self.ready([parent_stream])
                adoption = json.loads(parent_stream.readline())
                self.assertEqual(adoption["adopt_exit"], 0, adoption["error"])
                self.assertEqual(self.status(), {"busy": True, "holder": original})
                parent.sendall(b"x")
                self.ready([parent_exit])
                self.finish(launcher)
                os.kill(observed["pid"], 0)
                with selectors.DefaultSelector() as selector:
                    selector.register(target_exit, selectors.EVENT_READ)
                    self.assertEqual(selector.select(timeout=0), [])
                self.assertEqual(self.status(), {"busy": False, "holder": None})
                isolated.sendall(b"x")
                self.ready([target_exit])
                self.ready([wrapper_exit])
                output, error = launcher.communicate(timeout=10)
                self.assertEqual(output, b"")
                self.assertIn(b"isolate-target-stderr\n", error)
                self.assertFalse(Path(inherited["socket"]).parent.exists())
                self.assertFalse(list(self.home.glob("hl-isolate-*")))

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
                if not service:
                    self.assertEqual(manager_events.read_bytes(), events_before)
        self.env = base_environment

    def test_handoff_and_adopt_reject_bad_context_and_bound_missing_receiver(self):
        result = self.invoke("handoff", "--", "true")
        self.assertNotIn(result.returncode, (0, 2), result)
        result = self.invoke("adopt", "--socket", str(self.home / "missing"), "--", "true")
        self.assertNotIn(result.returncode, (0, 2), result)
        holder = self.start([sys.executable, "-c", CONTROLLED, str(self.home / "critical")])
        self.event(holder, b"entered\n")
        token = json.loads((self.state / "slot-0.json").read_text())["token"]
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
        token = json.loads((self.state / "slot-0.json").read_text())["token"]
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
                    with listener.accept()[0] as peer, (self.state / "slot-0.lock").open("r+") as file:
                        peer.settimeout(10)
                        self.assertEqual(peer.recv(128), token.encode())
                        names = [f"slot-{slot}" for slot in range(POOL_SIZE)] if count == 1 else ["slot-0"]
                        actual_count = POOL_SIZE if count == 1 else count
                        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [file.fileno()] * actual_count))] if actual_count else []
                        peer.sendmsg([json.dumps(names).encode()], ancillary)
                    _, error = process.communicate(timeout=10)
                    self.assertNotIn(process.returncode, (0, 2), error)
                    expected = b"not the current held lease" if count == 1 else b"exactly one descriptor"
                    self.assertIn(expected, error)
        self.release(holder)

    def test_command_exit_signal_and_cli_failures(self):
        result = self.invoke("run", "--", sys.executable, "-c", "import sys; print(repr(sys.argv[1:])); sys.exit(23)", "--try", "a b", "*")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(result.stdout, "['--try', 'a b', '*']\n")
        result = self.invoke("run", "--weight", "1", "--", str(CLI), "run", "--weight", "2", "--", "true")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("resources not held by its parent", result.stderr)
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
        for args in (("run",), ("run", "--"), ("run", "--wait", "--try", "--", "true"), ("run", "--weight", "0", "--", "true"), ("run", "--weight", str(POOL_SIZE + 1), "--", "true"), ("run", "--exclusive", "../escape", "--", "true"), ("status", "--unknown"), ("run", "--", "missing-fixture-command")):
            result = self.invoke(*args)
            self.assertNotIn(result.returncode, (0, 2), (args, result))
            self.assertTrue(result.stderr)
        self.assertEqual(self.status(), {"busy": False, "holder": None})
        (self.state / "slot-0.lock").unlink()
        (self.state / "slot-0.lock").mkdir()
        result = self.invoke("status", "--json")
        self.assertNotIn(result.returncode, (0, 2), result)
        self.assertTrue(result.stderr.startswith("heavy-lease: "), result.stderr)


ORPHAN_DIAGNOSTIC = '''
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
child = os.fork()
if child == 0:
    inherited = int(os.environ["HEAVY_LEASE_FD"])
    first = fcntl.fcntl(inherited, fcntl.F_DUPFD_CLOEXEC, 128)
    second = fcntl.fcntl(inherited, fcntl.F_DUPFD_CLOEXEC, 256)
    os.close(inherited)
    Path("/proc/self/comm").write_text("hl-pin)\\x1b[31m\\n")
    print(json.dumps({
        "pid": os.getpid(),
        "comm": Path("/proc/self/comm").read_text().removesuffix("\\n"),
        "cgroup": Path("/proc/self/cgroup").read_text().removesuffix("\\n").removeprefix("0::"),
        "fds": [first, second],
    }), flush=True)
    assert sys.stdin.readline() == "release\\n"
    os._exit(0)
signal.pause()
'''


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux /proc lock diagnostics")
class HeavyLeaseOrphanStatusTests(unittest.TestCase):
    def ready(self, descriptor):
        with selectors.DefaultSelector() as selector:
            selector.register(descriptor, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=10), "timed out waiting for owned process event")

    def stop_owned(self, descriptor):
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.ready(descriptor)

    def close_streams(self, process):
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()

    def test_orphan_status_identifies_inherited_flocks_not_plain_openers(self):
        scratch = Path.home() / ".cache/agent-tmp/heavy-lease"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="heavy-lease-orphan-", dir=scratch)
        self.addCleanup(temporary.cleanup)
        home = Path(temporary.name)
        environment = {"HOME": str(home), "PATH": os.environ["PATH"], "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1", "TMPDIR": os.environ.get("TMPDIR", str(Path.home() / ".cache/agent-tmp"))}

        environment.update(fake_memory_environment(home))

        def invoke(*args):
            return subprocess.run([str(CLI), *args], env=environment, cwd=home, capture_output=True, text=True, timeout=10)

        root = subprocess.Popen(
            [str(CLI), "run", "--weight", str(POOL_SIZE), "--", sys.executable, "-c", ORPHAN_DIAGNOSTIC],
            env=environment, cwd=home, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0,
        )
        self.addCleanup(self.close_streams, root)
        self.addCleanup(root.wait, timeout=10)
        root_exit = os.pidfd_open(root.pid)
        self.addCleanup(os.close, root_exit)
        self.addCleanup(self.stop_owned, root_exit)
        self.ready(root.stdout)
        expected = json.loads(root.stdout.readline())
        child_exit = os.pidfd_open(expected["pid"])
        self.addCleanup(os.close, child_exit)
        self.addCleanup(self.stop_owned, child_exit)
        self.assertGreaterEqual(min(expected["fds"]), 128)
        state = home / ".local/state/heavy-lease"
        metadata = (state / "slot-0.json").read_bytes()
        holder = json.loads(metadata)
        self.assertEqual(holder["pid"], root.pid)
        ordinary = invoke("status", "--json")
        self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
        self.assertEqual(pool_summary(json.loads(ordinary.stdout)), {"busy": True, "holder": holder})
        self.assertIn("slot-0: " + json.dumps(holder, sort_keys=True), invoke("status").stdout)
        opener = (state / "slot-0.lock").open("r+")
        self.addCleanup(opener.close)
        signal.pidfd_send_signal(root_exit, signal.SIGKILL)
        self.ready(root_exit)
        self.assertEqual(root.wait(timeout=10), -signal.SIGKILL)

        result = invoke("status", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        pool = json.loads(result.stdout)
        self.assertEqual(len(pool["slots"]), POOL_SIZE)
        observed = pool["slots"][0]
        self.assertEqual(set(observed), {"name", "holder", "orphan_pin", "lock_holders", "lock_holders_incomplete"})
        self.assertEqual(observed["name"], "slot-0")
        self.assertIs(observed["orphan_pin"], True)
        self.assertEqual(observed["holder"], holder)
        self.assertEqual(observed["lock_holders"], [expected])
        self.assertIsInstance(observed["lock_holders_incomplete"], bool)
        self.assertEqual((state / "slot-0.json").read_bytes(), metadata)
        rejected = invoke("run", "--try", "--", "true")
        self.assertEqual(rejected.returncode, 2, rejected.stderr)
        text = invoke("status")
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertIn("orphan pin:", text.stdout)
        self.assertIn(f"pid={expected['pid']}", text.stdout)
        self.assertIn(f"comm={expected['comm']!r}", text.stdout)
        self.assertIn(f"cgroup={expected['cgroup']!r}", text.stdout)
        self.assertIn(f"fds={expected['fds']}", text.stdout)
        self.assertNotIn("\x1b", text.stdout)
        root.stdin.write(b"release\n")
        self.ready(child_exit)
        output, error = root.communicate(timeout=10)
        self.assertEqual((output, error), (b"", b""))
        released = invoke("status", "--json")
        self.assertEqual(released.returncode, 0, released.stderr)
        self.assertEqual(pool_summary(json.loads(released.stdout)), {"busy": False, "holder": None})
        self.assertEqual(invoke("status").stdout, FREE_TEXT)


if __name__ == "__main__":
    unittest.main()
