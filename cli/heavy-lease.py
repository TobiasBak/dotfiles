#!/usr/bin/python3
import argparse
import array
import ctypes
from datetime import datetime, timezone
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time


POOL_MEASUREMENTS = {
    "date": "2026-10-17",
    "host_cores": 16,
    "host_memory_gib": 30.51,
    "source": "~/.cache/agent-tmp/heavy-lease-37/report.md",
    "orderready": {
        "command": "tools/or test --full",
        "sha": "8f08e1b2b050625f122c863b8a589f42df0c1edc",
        "elapsed_s": 391.420,
        "cpu_s_cgroup": 1392.674,
        "largest_process_rss_mib": 1814.79,
        "peak_cgroup_gib": 7.4018,
        "result": "exit 2: 139 obligations passed; GUI case blocked by 27s budget",
        "conditions": "empty verdict cache, warm toolchain/artifacts, four build jobs",
    },
    "stepkit-geometry": {
        "command": "tools/sg gate --json",
        "sha": "0d8011aa2372c67bfacd7b22811880d7c373a6ec",
        "elapsed_s": 6.912,
        "cpu_s_outer": 1.14,
        "cpu_s_worker": 9.064,
        "peak_worker_cgroup_mib": 517.8,
        "result": "exit 0: six static gates; no corpus/parity selected",
        "historical_sha": "e759c706ea2536e60394ab07dd6f279c704d41ff",
        "historical_parity_cpu_s": 543.440,
        "historical_parity_peak_cgroup_gib": 4,
        "conditions": "warm gate; historical 285-model parity capped at 4GiB/four cores",
    },
    "limits": "single runs; cgroup memory includes cache, not RSS; CPU is cumulative, not peak",
    "policy": "four 4GiB/four-core accounting units; two units per known heavy job; see heavy-lease.md",
}
POOL_SIZE = 4
PER_SLOT_PEAK = 17 * 1024**3 // POOL_SIZE
ADMISSION_CLASSES = ("gate", "interactive", "efficiency")
DEFAULT_WEIGHTS = (("orderready", 2), ("stepkit-geometry", 2))
REQUEST_RETENTION = 1024
REQUEST_MAX_AGE = 7 * 24 * 60 * 60


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(1, f"{self.prog}: error: {message}\n")


def read_holder(path):
    try:
        holder = json.loads(path.read_text())
        return holder if isinstance(holder, dict) else None
    except (OSError, ValueError):
        return None


def holder_summary(holder):
    return json.dumps(holder, sort_keys=True) if holder else "holder unavailable"


def git_context():
    def git(*args):
        try:
            result = subprocess.run(
                ["git", *args], capture_output=True, text=True, check=False,
            )
            return result.stdout.strip() if result.returncode == 0 else None
        except OSError:
            return None

    worktree = git("rev-parse", "--show-toplevel")
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir")
    repo = str(Path(common).parent) if common and Path(common).name == ".git" else common
    return {
        "repo": repo,
        "worktree": worktree,
        "branch": git("symbolic-ref", "--quiet", "--short", "HEAD"),
    }


def write_holder(path, holder):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".holder-", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(holder, stream, sort_keys=True)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def append_request(path, event):
    temporary = None
    try:
        if event["event"] == "queued":
            descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".request-")
            temporary = Path(name)
        else:
            descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        if temporary is not None:
            os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class RequestJournal:
    def __init__(self, path):
        self.path = path
        self.failed = False

    def append(self, event):
        if self.failed:
            return False
        try:
            append_request(self.path, event)
            return True
        except (OSError, ValueError) as error:
            self.failed = True
            print(f"heavy-lease: request journal {self.path}: {error}", file=sys.stderr)
            return False


def request_alive(request):
    if request.get("boot_id") != Path("/proc/sys/kernel/random/boot_id").read_text().strip():
        return False
    try:
        state, started = process_identity(Path(f"/proc/{request['pid']}"))
        return state not in ("Z", "X", "x") and started == request["process_start_ticks"]
    except FileNotFoundError:
        return False


def read_requests(directory):
    requests = []
    for path in (directory / "requests").glob("*.jsonl"):
        try:
            lines = path.read_text().splitlines(keepends=True)
        except FileNotFoundError:
            continue
        except OSError as error:
            print(f"heavy-lease: cannot read request journal {path}: {error}", file=sys.stderr)
            continue
        request = {}
        damaged = False
        for line in lines:
            try:
                if not line.endswith("\n"):
                    raise ValueError("partial event")
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError("invalid event")
            except ValueError:
                damaged = True
                break
            request.update(event)
        if request:
            request["state"] = request.pop("event")
            if damaged or request["exited_at"] is None and not request_alive(request):
                request["state"] = "interrupted"
            requests.append(request)
    return sorted(requests, key=lambda entry: (entry["queued_at"], entry["request_id"]))


def prune_requests(directory):
    try:
        inactive = [entry for entry in read_requests(directory) if entry["state"] in ("exited", "interrupted")]
        cutoff = time.time() - REQUEST_MAX_AGE
        for index, entry in enumerate(inactive):
            if index < len(inactive) - REQUEST_RETENTION or datetime.fromisoformat(entry["queued_at"]).timestamp() < cutoff:
                (directory / "requests" / f"{entry['request_id']}.jsonl").unlink(missing_ok=True)
    except (OSError, ValueError) as error:
        print(f"heavy-lease: request retention failed: {error}", file=sys.stderr)


def resource_paths(directory, name):
    if not re.fullmatch(r"slot-[0-9]+|exclusive-[a-zA-Z0-9_-]+", name):
        raise ValueError("invalid lease resource")
    return directory / f"{name}.lock", directory / f"{name}.json"


def open_resource(directory, name):
    lock, _ = resource_paths(directory, name)
    return high_descriptor(os.open(lock, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600))


def default_weight(command):
    executable = Path(command[0]).name
    context = str(Path.cwd()) + " " + " ".join(command)
    if executable == "or" and any(arg in ("--full", "--strict") for arg in command):
        return dict(DEFAULT_WEIGHTS)["orderready"]
    if executable == "sg" and any(arg in ("gate", "corpus", "parity") for arg in command):
        return dict(DEFAULT_WEIGHTS)["stepkit-geometry"]
    for pattern, weight in DEFAULT_WEIGHTS:
        if pattern in context:
            return weight
    return 1


def probe_resource(directory, name):
    lock, metadata = resource_paths(directory, name)
    fd = open_resource(directory, name)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            result = {"name": name, "holder": read_holder(metadata)}
            if sys.platform.startswith("linux") and metadata_owner_dead(result["holder"]):
                holders, incomplete = orphan_lock_holders(os.fstat(fd))
                result.update(orphan_pin=True, lock_holders=holders, lock_holders_incomplete=incomplete)
            return result
        return None
    finally:
        os.close(fd)


def nested_holder(directory, token):
    if not token:
        return None
    for path in sorted(directory.glob("*.json")):
        holder = read_holder(path)
        if not holder or holder.get("token") != token:
            continue
        resources = holder.get("resources", [])
        if resources and all(
            (entry := probe_resource(directory, name)) is not None
            and (entry["holder"] or {}).get("token") == token for name in resources
        ):
            return holder
    return None


def wait_slot_worker(directory, name, parent):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) < 0:
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG")
    if os.getppid() != parent:
        return 1
    fd = open_resource(Path(directory), name)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
    finally:
        os.close(fd)
    return 0


def nonnegative_integer(value, source):
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError(f"invalid nonnegative integer in {source}")
    return int(value)


def memory_headroom(pid=None):
    meminfo = Path(os.environ.get("HEAVY_LEASE_MEMINFO", "/proc/meminfo"))
    available = [line.split() for line in meminfo.read_text().splitlines() if line.startswith("MemAvailable:")]
    if len(available) != 1 or len(available[0]) != 3 or available[0][2] != "kB":
        raise ValueError(f"missing or invalid MemAvailable in {meminfo}")
    headroom = nonnegative_integer(available[0][1], meminfo) * 1024
    membership = Path(os.environ.get("HEAVY_LEASE_CGROUP_FILE", f"/proc/{pid}/cgroup" if pid is not None else "/proc/self/cgroup"))
    paths = [line[3:] for line in membership.read_text().splitlines() if line.startswith("0::")]
    if len(paths) != 1 or not paths[0].startswith("/") or ".." in Path(paths[0]).parts:
        raise ValueError(f"missing or invalid unified cgroup in {membership}")
    root = Path(os.environ.get("HEAVY_LEASE_CGROUP_ROOT", "/sys/fs/cgroup")).resolve(strict=True)
    current = (root / paths[0].lstrip("/")).resolve(strict=True)
    if not current.is_relative_to(root):
        raise ValueError("caller cgroup is outside the cgroup mount")
    while True:
        maximum_path = current / "memory.max"
        try:
            maximum = maximum_path.read_text().strip()
        except FileNotFoundError:
            if current != root:
                raise
            maximum = "max"
        if maximum != "max":
            limit = nonnegative_integer(maximum, maximum_path)
            usage_path = current / "memory.current"
            usage = nonnegative_integer(usage_path.read_text().strip(), usage_path)
            stat_path = current / "memory.stat"
            inactive = [line.split() for line in stat_path.read_text().splitlines() if line.split()[:1] == ["inactive_file"]]
            if len(inactive) != 1 or len(inactive[0]) != 2:
                raise ValueError(f"missing or invalid inactive_file in {stat_path}")
            cache = nonnegative_integer(inactive[0][1], stat_path)
            headroom = min(headroom, max(0, limit - max(0, usage - cache)))
        if current == root:
            return headroom
        current = current.parent


def named_resource_head(request, waiters):
    if not request["exclusive"]:
        return None
    return next((entry for entry in waiters if entry["exclusive"] == request["exclusive"]), None)


def named_lock_eligible_pool_waiters(waiters, occupied):
    for entry in waiters:
        if not entry["weight"]:
            continue
        if entry["exclusive"]:
            if f"exclusive-{entry['exclusive']}" in occupied:
                continue
            if named_resource_head(entry, waiters)["pid"] != entry["pid"]:
                continue
        yield entry


def named_lock_eligible_pool_head(waiters, occupied):
    return next(named_lock_eligible_pool_waiters(waiters, occupied), None)


def pool_candidate(waiters, occupied):
    eligible = list(named_lock_eligible_pool_waiters(waiters, occupied))
    if not eligible:
        return None
    head = eligible[0]
    free = POOL_SIZE - sum(name.startswith("slot-") for name in occupied)
    if head["weight"] <= free:
        return head
    credit = POOL_SIZE - head.get("backfill_used", 0)
    return next((entry for entry in eligible[1:] if entry["weight"] <= min(free, credit)), head)


def queue_blocker(request, waiters, occupied):
    named_head = named_resource_head(request, waiters)
    if named_head is not None and named_head["pid"] != request["pid"]:
        return named_head
    if request["weight"]:
        candidate = pool_candidate(waiters, occupied)
        if candidate is not None and candidate["pid"] != request["pid"]:
            return candidate
    return None


def admission_reason(request, waiters, headroom, occupied):
    if request["exclusive"] and f"exclusive-{request['exclusive']}" in occupied:
        return "exclusive"
    if queue_blocker(request, waiters, occupied) is not None:
        return "queue"
    held_slots = sum(name.startswith("slot-") for name in occupied)
    if request["weight"] > POOL_SIZE - held_slots:
        return "slots"
    if held_slots and request["weight"] * PER_SLOT_PEAK > headroom:
        return "memory"
    return "ready"


def resource_occupancy(directory, request, waiters=()):
    names = [f"slot-{slot}" for slot in range(POOL_SIZE)]
    names.extend(sorted({f"exclusive-{entry['exclusive']}" for entry in [request, *waiters] if entry["exclusive"]}))
    occupied = {}
    for name in names:
        fd = open_resource(directory, name)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                occupied[name] = read_holder(resource_paths(directory, name)[1])
        finally:
            os.close(fd)
    return occupied


def admission_snapshot(directory, request, waiters):
    occupied = resource_occupancy(directory, request, waiters)
    return admission_reason(request, waiters, memory_headroom(), occupied), occupied


def report_busy(reason, occupied, request):
    summaries = "; ".join(holder_summary(holder) for name, holder in occupied.items() if name.startswith("slot-"))
    if request["exclusive"] and f"exclusive-{request['exclusive']}" in occupied:
        summaries = holder_summary(occupied[f"exclusive-{request['exclusive']}"])
    print(f"busy: {reason}" + (f": {summaries}" if summaries else ""), file=sys.stderr)


def acquire_resources(directory, request):
    names = [f"exclusive-{request['exclusive']}"] if request["exclusive"] else []
    names.extend(f"slot-{slot}" for slot in range(POOL_SIZE) if request["weight"])
    held = {}
    slots = 0
    complete = False
    try:
        for name in names:
            fd = open_resource(directory, name)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                if name.startswith("exclusive-"):
                    return None
                continue
            except BaseException:
                os.close(fd)
                raise
            held[name] = fd
            if name.startswith("slot-"):
                slots += 1
            if slots == request["weight"]:
                complete = True
                return held
        return None
    finally:
        if not complete:
            for fd in held.values():
                os.close(fd)


class AdmissionObserver:
    def __init__(self, directory):
        self.directory = directory
        self.selector = selectors.DefaultSelector()
        self.workers = []
        self.descriptors = []
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            descriptor = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
            if descriptor < 0:
                raise OSError(ctypes.get_errno(), "inotify_init1")
            self.descriptors.append(descriptor)
            if libc.inotify_add_watch(descriptor, os.fsencode(directory / "waiters"), 0x00000100 | 0x00000200 | 0x00000080) < 0:
                raise OSError(ctypes.get_errno(), "inotify_add_watch")
            self.selector.register(descriptor, selectors.EVENT_READ)
        except BaseException:
            self.close()
            raise

    def observe_blockers(self, request, waiters, reason, occupied):
        head = queue_blocker(request, waiters, occupied) if reason == "queue" else None
        if head is not None:
            try:
                descriptor = os.pidfd_open(head["pid"])
            except ProcessLookupError:
                return False
            self.descriptors.append(descriptor)
            self.selector.register(descriptor, selectors.EVENT_READ)
        if reason == "memory":
            descriptor = os.timerfd_create(time.CLOCK_MONOTONIC, flags=os.TFD_CLOEXEC | os.TFD_NONBLOCK)
            self.descriptors.append(descriptor)
            os.timerfd_settime(descriptor, initial=1.0)
            self.selector.register(descriptor, selectors.EVENT_READ)
        if reason in ("slots", "exclusive", "memory", "queue"):
            blocked = [name for name in occupied if name.startswith("slot-")] if reason != "exclusive" else [f"exclusive-{request['exclusive']}"]
            for name in blocked:
                worker = subprocess.Popen([
                    sys.executable, str(Path(__file__).resolve()), "--internal-wait-slot",
                    str(self.directory), name, str(os.getpid()),
                ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
                self.workers.append(worker)
                descriptor = os.pidfd_open(worker.pid)
                self.descriptors.append(descriptor)
                self.selector.register(descriptor, selectors.EVENT_READ, worker)
        return True

    def wait(self):
        for key, _ in self.selector.select():
            if key.data is not None and key.data.wait() != 0:
                raise ValueError("pool resource waiter failed")

    def close(self):
        for worker in self.workers:
            if worker.poll() is None:
                worker.kill()
        for worker in self.workers:
            worker.wait()
        self.selector.close()
        for descriptor in self.descriptors:
            os.close(descriptor)


def acquire_admission(directory, metadata, try_only, waiter):
    admission = high_descriptor(os.open(directory / "admission.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600))
    folder = directory / "waiters"
    folder.mkdir(mode=0o700, exist_ok=True)
    try:
        while True:
            observer = AdmissionObserver(directory) if not try_only else None
            try:
                try:
                    fcntl.flock(admission, fcntl.LOCK_EX | (fcntl.LOCK_NB if try_only else 0))
                except BlockingIOError:
                    report_busy("pool admission in progress", resource_occupancy(directory, metadata), metadata)
                    return None
                try:
                    if not waiter:
                        waiter.extend(register_waiter(directory, metadata))
                    waiters = read_waiters(directory)
                    reason, occupied = admission_snapshot(directory, metadata, waiters)
                    if reason == "ready":
                        held = acquire_resources(directory, metadata)
                        if held is not None:
                            try:
                                head = named_lock_eligible_pool_head(waiters, occupied)
                                if metadata["weight"] and head is not None and head["pid"] != metadata["pid"]:
                                    head["backfill_used"] = head.get("backfill_used", 0) + metadata["weight"]
                                    write_holder(folder / f"{head['pid']}.json", head)
                                clear_waiter(waiter)
                            except BaseException:
                                for descriptor in held.values():
                                    os.close(descriptor)
                                raise
                            return held
                        reason, occupied = admission_snapshot(directory, metadata, waiters)
                    if try_only:
                        report_busy(reason, occupied, metadata)
                        return None
                    retry = reason == "ready" or not observer.observe_blockers(metadata, waiters, reason, occupied)
                finally:
                    fcntl.flock(admission, fcntl.LOCK_UN)
                if not retry:
                    observer.wait()
            finally:
                if observer is not None:
                    observer.close()
    finally:
        os.close(admission)


def register_waiter(directory, metadata):
    folder = directory / "waiters"
    folder.mkdir(mode=0o700, exist_ok=True)
    lock = folder / f"{os.getpid()}.lock"
    holder = lock.with_suffix(".json")
    fd = high_descriptor(os.open(lock, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600))
    waiter = [fd, lock, holder]
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        holder.unlink(missing_ok=True)
        metadata["sequence"] = max((entry["sequence"] for entry in read_waiters(directory)), default=0) + 1
        write_holder(holder, metadata)
        return waiter
    except BaseException:
        clear_waiter(waiter)
        raise


def clear_waiter(waiter):
    if waiter:
        fd, lock, holder = waiter
        waiter.clear()
        holder.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)
        os.close(fd)


def read_waiters(directory):
    waiters = []
    for lock in sorted((directory / "waiters").glob("*.lock")):
        try:
            fd = os.open(lock, os.O_RDWR | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                holder = read_holder(lock.with_suffix(".json"))
                if (
                    holder and type(holder.get("pid")) is int and str(holder["pid"]) == lock.stem
                    and 0 < holder["pid"] < 2**31
                    and holder.get("class") in ADMISSION_CLASSES
                    and type(holder.get("sequence")) is int and holder["sequence"] > 0
                    and type(holder.get("weight")) is int and 0 <= holder["weight"] <= POOL_SIZE
                    and "exclusive" in holder
                    and (holder["exclusive"] is None or isinstance(holder["exclusive"], str)
                         and re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", holder["exclusive"]))
                    and (holder["weight"] > 0 or holder["exclusive"])
                ):
                    waiters.append(holder)
        finally:
            os.close(fd)
    return sorted(waiters, key=lambda entry: (ADMISSION_CLASSES.index(entry["class"]), entry["sequence"]))


def run(directory, command, try_only, weight, exclusive, admission_class):
    token = os.environ.get("HEAVY_LEASE_TOKEN")
    inherited = nested_holder(directory, token)
    if inherited:
        resources = inherited["resources"]
        held_weight = sum(name.startswith("slot-") for name in resources)
        if weight is None:
            weight = held_weight
        if held_weight < weight or (
            exclusive and f"exclusive-{exclusive}" not in resources
        ):
            raise ValueError("nested run requests resources not held by its parent; use isolate for independent work")
        os.execvp(command[0], command)
    if weight is None:
        weight = 0 if exclusive else default_weight(command)
    started = datetime.now(timezone.utc).isoformat()
    request_id = secrets.token_hex(16)
    folder = directory / "requests"
    folder.mkdir(mode=0o700, exist_ok=True)
    journal = RequestJournal(folder / f"{request_id}.jsonl")
    if not journal.append({
        "event": "queued", "request_id": request_id, "pid": os.getpid(),
        "process_start_ticks": process_identity(Path("/proc/self"))[1],
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "start_time": started, "class": admission_class, "weight": weight,
        "exclusive": exclusive, "cwd": os.getcwd(),
        "command_head": [part[:256] for part in command[:4]],
        "queued_at": started, "admitted_at": None, "exited_at": None, "exit_code": None,
    }):
        return 1
    prune_requests(directory)
    context = git_context()
    held = {}
    metadata = {
        "pid": os.getpid(), "command": command, "weight": weight, "exclusive": exclusive,
        "class": admission_class, "expected_peak": weight * PER_SLOT_PEAK,
        "start_time": started, "queued_at": started, "request_id": request_id, **context,
        **({"T3_THREAD_ID": os.environ["T3_THREAD_ID"]} if "T3_THREAD_ID" in os.environ else {}),
    }
    waiter = []
    code = 1
    try:
        allocation = acquire_admission(directory, metadata, try_only, waiter)
        if allocation is None:
            code = 2
            return code
        held.update(allocation)
        token = secrets.token_hex(16)
        holder = {
            "token": token, "pid": os.getpid(), "pgid": os.getpgrp(),
            "start_time": started, "queued_at": started, "request_id": request_id, **context,
            "command": command, "resources": list(held), "weight": weight,
            "class": admission_class, "expected_peak": weight * PER_SLOT_PEAK,
        }
        if "T3_THREAD_ID" in os.environ:
            holder["T3_THREAD_ID"] = os.environ["T3_THREAD_ID"]
        export_descriptors(held)
        os.environ["HEAVY_LEASE_TOKEN"] = token
        code = supervise_command(directory, command, held, holder, journal)
        return code
    except KeyboardInterrupt:
        code = 130
        raise
    finally:
        clear_waiter(waiter)
        for fd in held.values():
            os.close(fd)
        journal.append({
            "event": "exited", "exited_at": datetime.now(timezone.utc).isoformat(), "exit_code": code,
        })
        prune_requests(directory)


def supervise_command(directory, command, held, holder, journal):
    forwarded = (signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGTERM, signal.SIGUSR1, signal.SIGUSR2, signal.SIGALRM)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, forwarded)
    reader, writer = os.pipe2(os.O_CLOEXEC)
    parent = os.getpid()
    try:
        child = os.fork()
    except BaseException:
        os.close(reader)
        os.close(writer)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        raise
    if child == 0:
        try:
            os.close(writer)
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) < 0:
                raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG")
            if os.getppid() != parent:
                os._exit(1)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            if os.read(reader, 1) != b"x":
                os._exit(1)
            os.close(reader)
            os.execvp(command[0], command)
        except (OSError, ValueError) as error:
            print(f"heavy-lease: {error}", file=sys.stderr, flush=True)
            os._exit(1)
    os.close(reader)
    previous_handlers = {}

    def forward(signum, frame):
        try:
            os.kill(child, signum)
        except ProcessLookupError:
            pass

    try:
        try:
            for signum in forwarded:
                previous_handlers[signum] = signal.signal(signum, forward)
            holder["command_pid"] = child
            holder["admitted_at"] = datetime.now(timezone.utc).isoformat()
            for name in held:
                write_holder(resource_paths(directory, name)[1], holder)
            if not journal.append({
                "event": "admitted", "admitted_at": holder["admitted_at"], "command_pid": child,
            }):
                raise ValueError("cannot record admission; command not started")
            os.write(writer, b"x")
        finally:
            os.close(writer)
            for entry in list(Path("/proc/self/fd").iterdir()):
                fd = int(entry.name)
                if fd > 2:
                    try:
                        os.close(fd)
                    except OSError as error:
                        if error.errno != errno.EBADF:
                            raise
            held.clear()
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            result = os.waitid(os.P_PID, child, os.WEXITED | os.WNOWAIT)
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        os.waitpid(child, 0)
    return result.si_status if result.si_code == os.CLD_EXITED else -result.si_status


def isolate(command):
    raw_fds = [os.environ.get("HEAVY_LEASE_FD", "-1")]
    try:
        raw_fds.extend(json.loads(os.environ.get("HEAVY_LEASE_FDS", "{}")).values())
    except (ValueError, AttributeError):
        pass
    for name in list(os.environ):
        if name.startswith("HEAVY_LEASE_"):
            del os.environ[name]
    for raw_fd in set(map(str, raw_fds)):
        try:
            fd = int(raw_fd)
        except ValueError:
            continue
        if fd >= 64:
            try:
                os.close(fd)
            except OverflowError:
                pass
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
    if "CI" in os.environ or not sys.platform.startswith("linux"):
        os.execvp(command[0], command)
    gah_binary = None
    if "GAH_WORKSPACE" in os.environ:
        reference = os.environ["GAH_WORKSPACE"]
        if not reference:
            raise ValueError("GAH_WORKSPACE is empty; cannot preserve the caller's workspace")
        gah = shutil.which(os.environ.get("GAH_BIN", "gah"))
        if gah is None:
            raise ValueError("cannot preserve GAH_WORKSPACE: gah executable is unavailable; set GAH_BIN to the gah CLI")
        gah_binary = str(Path(gah).resolve())
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", str(Path.home() / ".cache/agent-tmp/heavy-lease")))
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="hl-isolate-", dir=runtime))
    request = folder / "request.json"
    cwd = os.getcwd()
    try:
        with os.fdopen(os.open(request, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            json.dump({"env": dict(os.environ), "cwd": cwd, "argv": command, "gah": gah_binary}, stream)
        basename = re.sub(r"[^a-zA-Z0-9_-]", "-", Path(command[0]).name)[:80] or "command"
        unit = f"heavy-lease-{basename}-{secrets.token_hex(8)}.service"
        print(f"heavy-lease isolate unit: {unit}", file=sys.stderr, flush=True)
        launcher = subprocess.Popen([
            "systemd-run", "--user", "--collect", "--wait", "--pipe", "--quiet",
            "--service-type=exec", "--slice=app.slice",
            f"--working-directory={cwd}", "--expand-environment=no", f"--unit={unit}",
            "--", sys.executable, str(Path(__file__).resolve()), "--internal-isolate-worker", str(request),
        ])
    except OSError:
        request.unlink(missing_ok=True)
        folder.rmdir()
        raise
    launcher.wait()
    result = folder / "result.json"
    try:
        code = json.loads(result.read_text())
        if type(code) is not int:
            raise ValueError("invalid isolate result receipt")
    except (OSError, ValueError) as error:
        raise ValueError(f"isolate service {unit} has no valid result receipt (systemd-run exit {launcher.returncode}); private runtime: {folder}") from error
    result.unlink()
    folder.rmdir()
    if launcher.returncode != 0:
        raise ValueError(f"isolate service {unit}: systemd-run exited {launcher.returncode}")
    if code < 0:
        if -code != signal.SIGKILL:
            signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code


def isolate_worker(request, *, entered=False):
    request = Path(request)
    payload = json.loads(request.read_text())
    if "GAH_WORKSPACE" in payload["env"] and not entered:
        if not payload.get("gah"):
            raise ValueError("incomplete gah isolation context; restart through heavy-lease isolate")
        return subprocess.run([
            payload["gah"], "enter", payload["env"]["GAH_WORKSPACE"], "--",
            sys.executable, str(Path(__file__).resolve()), "--internal-isolate-entered", str(request),
        ], env=payload["env"], cwd=payload["cwd"], check=False).returncode
    request.unlink(missing_ok=True)
    code = subprocess.run(payload["argv"], env=payload["env"], cwd=os.getcwd() if entered else payload["cwd"], check=False).returncode
    with tempfile.NamedTemporaryFile(mode="w", dir=request.parent, prefix=".result-", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(code, stream)
    os.replace(temporary, request.parent / "result.json")
    return 0


def process_identity(directory):
    fields = (directory / "stat").read_text(errors="replace").rsplit(")", 1)[1].split()
    return fields[0], int(fields[19])


def metadata_owner_dead(holder):
    pid = holder.get("pid") if holder else None
    if type(pid) is not int or not 0 < pid < 2**31:
        return False
    try:
        state, _ = process_identity(Path(f"/proc/{pid}"))
        return state in ("Z", "X", "x")
    except FileNotFoundError:
        try:
            descriptor = os.pidfd_open(pid)
        except ProcessLookupError:
            return True
        except OSError:
            return False
        else:
            os.close(descriptor)
            return False
    except (OSError, ValueError, IndexError):
        return False


def orphan_lock_holders(identity):
    holders = []
    incomplete = False
    expected = (identity.st_dev, identity.st_ino)
    try:
        processes = sorted((path for path in Path("/proc").iterdir() if path.name.isdecimal()), key=lambda path: int(path.name))
    except OSError:
        return holders, True
    for directory in processes:
        try:
            before = process_identity(directory)
            if before[0] in ("Z", "X", "x"):
                continue
            fds = []
            unreadable = False
            for entry in (directory / "fdinfo").iterdir():
                if not entry.name.isdecimal():
                    continue
                candidate = False
                try:
                    descriptor = directory / "fd" / entry.name
                    target = descriptor.stat()
                    if (target.st_dev, target.st_ino) != expected:
                        continue
                    candidate = True
                    held = False
                    for line in entry.read_text(errors="replace").splitlines():
                        fields = line.split()
                        if fields[:1] != ["lock:"] or fields[2:5] != ["FLOCK", "ADVISORY", "WRITE"]:
                            continue
                        held = True
                        break
                    target = descriptor.stat()
                    if (target.st_dev, target.st_ino) != expected:
                        unreadable = True
                        continue
                    if held:
                        fds.append(int(entry.name))
                except FileNotFoundError:
                    unreadable = unreadable or candidate
                    continue
                except (OSError, ValueError, IndexError):
                    unreadable = True
            if fds:
                comm = (directory / "comm").read_text(errors="replace").removesuffix("\n")
                cgroup = (directory / "cgroup").read_text(errors="replace").removesuffix("\n")
                if cgroup.startswith("0::"):
                    cgroup = cgroup[3:]
            after = process_identity(directory)
            if after[0] in ("Z", "X", "x"):
                continue
            if before[1] != after[1]:
                incomplete = True
                continue
            incomplete = incomplete or unreadable
            if fds:
                holders.append({"pid": int(directory.name), "comm": comm, "cgroup": cgroup, "fds": sorted(set(fds))})
        except FileNotFoundError:
            continue
        except (OSError, ValueError, IndexError):
            incomplete = True
    return holders, incomplete


def status(directory, as_json):
    slots = [entry for slot in range(POOL_SIZE) if (entry := probe_resource(directory, f"slot-{slot}"))]
    exclusive = [entry for path in sorted(directory.glob("exclusive-*.lock")) if (entry := probe_resource(directory, path.stem))]
    waiters = read_waiters(directory)
    headrooms = {}
    for waiter in waiters:
        try:
            headrooms[waiter["pid"]] = memory_headroom(waiter["pid"])
        except (FileNotFoundError, ProcessLookupError):
            if any(entry["pid"] == waiter["pid"] and entry["sequence"] == waiter["sequence"] for entry in read_waiters(directory)):
                raise
    waiters = [waiter for waiter in waiters if waiter["pid"] in headrooms]
    occupied = {entry["name"]: entry["holder"] for entry in [*slots, *exclusive]}
    for waiter in waiters:
        waiter["expected_peak"] = waiter["weight"] * PER_SLOT_PEAK
        waiter["admission_reason"] = admission_reason(waiter, waiters, headrooms[waiter["pid"]], occupied)
    result = {"pool_size": POOL_SIZE, "slots": slots, "exclusive": exclusive, "waiters": waiters, "requests": read_requests(directory)}
    if as_json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(f"pool: {len(slots)}/{POOL_SIZE} slots in use; {len(exclusive)} exclusive locks; {len(result['waiters'])} waiters")
        for entry in [*slots, *exclusive]:
            print(f"{entry['name']}: {holder_summary(entry['holder'])}")
            if entry.get("orphan_pin"):
                print("orphan pin: metadata owner is dead; lock holders (best effort):")
                for process in entry["lock_holders"]:
                    print(f"  pid={process['pid']} comm={process['comm']!r} cgroup={process['cgroup']!r} fds={process['fds']}")
                if entry["lock_holders_incomplete"]:
                    print("  lock holder scan incomplete")
    return 0


def high_descriptor(fd):
    if fd >= 64:
        return fd
    try:
        return fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 64)
    finally:
        os.close(fd)


def held_descriptor(fd, lock, holder_path, token):
    try:
        if not token or (read_holder(holder_path) or {}).get("token") != token:
            return False
        inherited = os.fstat(fd)
        canonical = lock.stat()
        if (inherited.st_dev, inherited.st_ino) != (canonical.st_dev, canonical.st_ino):
            return False
        for line in Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines():
            fields = line.split()
            if fields[:1] == ["lock:"] and fields[2:5] == ["FLOCK", "ADVISORY", "WRITE"]:
                return True
    except (OSError, ValueError):
        pass
    return False


def same_uid(peer):
    _, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    if uid != os.getuid():
        raise ValueError("lease socket peer has a different uid")


def receive_message(peer):
    data, ancillary, flags, _ = peer.recvmsg(16384, socket.CMSG_SPACE(4 * (POOL_SIZE + 2)), socket.MSG_CMSG_CLOEXEC)
    descriptors = []
    unexpected = bool(flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC))
    for level, kind, content in ancillary:
        if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
            values = array.array("i")
            values.frombytes(content[:len(content) - len(content) % values.itemsize])
            descriptors.extend(values)
        else:
            unexpected = True
    return data, descriptors, unexpected


def valid_descriptors(held, directory, token):
    if not held:
        return False
    for name, fd in held.items():
        lock, holder_path = resource_paths(directory, name)
        holder = read_holder(holder_path) or {}
        if set(holder.get("resources", [])) != set(held) or not held_descriptor(fd, lock, holder_path, token):
            return False
    return True


def inherited_descriptors():
    try:
        held = json.loads(os.environ.get("HEAVY_LEASE_FDS", "{}"))
        if not isinstance(held, dict) or any(not isinstance(name, str) or type(fd) is not int for name, fd in held.items()):
            return {}
        return held
    except ValueError:
        return {}


def receive_lease(path, directory, token):
    if not token:
        raise ValueError("HEAVY_LEASE_TOKEN is required for adoption")
    descriptors = []
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as peer:
            peer.settimeout(5)
            peer.connect(path)
            same_uid(peer)
            peer.sendall(token.encode())
            data, descriptors, unexpected = receive_message(peer)
        try:
            names = json.loads(data)
        except ValueError:
            names = None
        if unexpected or not isinstance(names, list) or not names or any(not isinstance(name, str) for name in names) or len(names) != len(descriptors) or len(set(names)) != len(names):
            raise ValueError("lease adoption requires exactly one descriptor per resource and a valid reply")
        held = dict(zip(names, descriptors))
        if not valid_descriptors(held, directory, token):
            raise ValueError("adopted descriptor is not the current held lease")
        promoted = {}
        while descriptors:
            fd = descriptors.pop(0)
            promoted[names[len(promoted)]] = high_descriptor(fd)
        return promoted
    finally:
        for fd in descriptors:
            os.close(fd)


def export_descriptors(held):
    for fd in held.values():
        os.set_inheritable(fd, True)
    os.environ["HEAVY_LEASE_FDS"] = json.dumps(held)
    os.environ["HEAVY_LEASE_FD"] = str(next(iter(held.values())))


def adopt(path, directory, command):
    held = receive_lease(path, directory, os.environ.get("HEAVY_LEASE_TOKEN"))
    try:
        export_descriptors(held)
        os.environ["HEAVY_LEASE_SOCKET"] = path
        os.execvp(command[0], command)
    finally:
        for fd in held.values():
            os.close(fd)


def serve_adoption(peer, held, directory, token):
    descriptors = []
    try:
        data, descriptors, unexpected = receive_message(peer)
        if unexpected or descriptors or data != token.encode() or not valid_descriptors(held, directory, token):
            peer.sendall(b"rejected")
            return False
        peer.sendmsg([json.dumps(list(held)).encode()], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", held.values()))])
        return True
    except (OSError, ValueError):
        return False
    finally:
        for received in descriptors:
            os.close(received)


def broker(listener, held, directory, token, command, path):
    export_descriptors(held)
    environment = {**os.environ, "HEAVY_LEASE_SOCKET": path}
    process = subprocess.Popen(command, env=environment, pass_fds=tuple(held.values()))
    exited, notification = socket.socketpair()

    def wait_launcher():
        process.wait()
        try:
            notification.sendall(b"exited")
        finally:
            notification.close()

    waiter = threading.Thread(target=wait_launcher)
    waiter.start()
    clients = set()
    adopted = False
    deadline = time.monotonic() + 5
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(listener, selectors.EVENT_READ)
            selector.register(exited, selectors.EVENT_READ)
            while True:
                remaining = None if adopted else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise ValueError("no lease receiver within 5 seconds")
                events = selector.select(remaining)
                if not events:
                    raise ValueError("no lease receiver within 5 seconds")
                for key, _ in events:
                    if key.fileobj is exited:
                        if not adopted and process.returncode == 0:
                            raise ValueError("launcher exited without a lease receiver")
                        return process.returncode
                    if key.fileobj is listener:
                        peer, _ = listener.accept()
                        try:
                            same_uid(peer)
                            peer.setblocking(False)
                            selector.register(peer, selectors.EVENT_READ)
                            clients.add(peer)
                        except (OSError, ValueError):
                            peer.close()
                    else:
                        peer = key.fileobj
                        adopted = serve_adoption(peer, held, directory, token) or adopted
                        selector.unregister(peer)
                        clients.remove(peer)
                        peer.close()
    finally:
        if process.returncode is None:
            process.terminate()
            exited.settimeout(1)
            try:
                exited.recv(16)
            except TimeoutError:
                process.kill()
        waiter.join()
        exited.close()
        for peer in clients:
            peer.close()


def handoff(directory, command):
    token = os.environ.get("HEAVY_LEASE_TOKEN")
    held = inherited_descriptors()
    if not valid_descriptors(held, directory, token):
        inherited_socket = os.environ.get("HEAVY_LEASE_SOCKET")
        if not inherited_socket:
            raise ValueError("handoff requires a held lease descriptor or a live inherited lease socket")
        held = receive_lease(inherited_socket, directory, token)
    try:
        runtime = Path(os.environ.get("XDG_RUNTIME_DIR", str(Path.home() / ".cache/agent-tmp/heavy-lease")))
        runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="hl-", dir=runtime) as folder:
            path = str(Path(folder) / "socket")
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as listener:
                listener.bind(path)
                listener.listen()
                code = broker(listener, held, directory, token, command, path)
    finally:
        for fd in held.values():
            os.close(fd)
    if code < 0:
        if -code != signal.SIGKILL:
            signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code


def main():
    parser = Parser(description="Admit heavy commands to a measured, process-inherited Linux slot pool.")
    commands = parser.add_subparsers(dest="action", required=True)
    run_parser = commands.add_parser("run", help="Run and record a command holding weighted slots or a named exclusive lock.")
    mode = run_parser.add_mutually_exclusive_group()
    mode.add_argument("--wait", action="store_true", help="Wait in the kernel for the lease (default).")
    mode.add_argument("--try", dest="try_only", action="store_true", help="Exit 2 if the lease is busy.")
    run_parser.add_argument("--weight", type=int, help=f"Pool slots, 1..{POOL_SIZE}; nested default is the parent allocation, otherwise command table or 1. Top-level --exclusive defaults to 0.")
    run_parser.add_argument("--exclusive", help="Separate named lock, e.g. win-vm; takes no slots unless --weight is given.")
    run_parser.add_argument("--class", dest="admission_class", choices=ADMISSION_CLASSES, default="interactive", help="Admission priority, then FIFO within each class (default: interactive).")
    run_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command [args ...]")
    status_parser = commands.add_parser(
        "status", help="Probe pool slots and named exclusive locks, ignoring stale metadata.",
        description="Probe kernel locks. Waiters use per-process flock metadata; no daemon is used. "
        "On Linux, a busy resource with a demonstrably dead metadata PID "
        "reports an orphan pin and a point-in-time, best-effort list of held FLOCK descriptors from /proc. "
        "Process exits and /proc visibility or permissions may limit this list; lock_holders_incomplete "
        "reports unreadable evidence. The metadata stores only a numeric PID, so a reused live PID "
        "cannot be distinguished from the original owner and suppresses orphan diagnostics.",
    )
    status_parser.add_argument("--json", action="store_true", help="Print pool_size, occupied slots, exclusive locks, live waiters and retained request lifecycles. Interrupted records have unknown exit time/code; orphan pins add diagnostics.")
    handoff_parser = commands.add_parser("handoff", help="Broker a held lease to a manager-launched command.")
    handoff_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- launcher [args ...]")
    adopt_parser = commands.add_parser("adopt", help="Receive a held lease descriptor and exec a command.")
    adopt_parser.add_argument("--socket", required=True, help="Private socket provided by handoff.")
    adopt_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command [args ...]")
    isolate_parser = commands.add_parser(
        "isolate", help="Discard inherited lease context and run in an independent user service (direct exec in CI).",
        description="Run independently of the caller's service or scope, preserving foreground I/O and exit status. "
        "The service inherits only stdin, stdout and stderr, not other file descriptors. "
        "Acquire locks inside the isolated process, not before calling isolate. "
        "A gah workspace is re-entered before the service payload runs. "
        "The unit name is printed on stderr. Interrupted callers may leave a private hl-isolate-* runtime directory; "
        "the worker removes the environment request before starting the command.",
    )
    isolate_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command [args ...]")
    args = parser.parse_args()
    if args.action != "status" and (len(args.command) < 2 or args.command[0] != "--"):
        parser.error("expected -- followed by a command")
    if args.action == "isolate":
        return isolate(args.command[1:])
    directory = Path.home() / ".local/state/heavy-lease"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.action == "status":
        return status(directory, args.json)
    if args.action == "handoff":
        return handoff(directory, args.command[1:])
    if args.action == "adopt":
        return adopt(args.socket, directory, args.command[1:])
    if args.exclusive and not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", args.exclusive):
        parser.error("exclusive name must contain 1..80 letters, digits, underscores or hyphens")
    if args.weight is not None and (not 0 <= args.weight <= POOL_SIZE or (args.weight == 0 and not args.exclusive)):
        parser.error(f"weight must be 1..{POOL_SIZE}, or 0 with --exclusive")
    return run(directory, args.command[1:], args.try_only, args.weight, args.exclusive, args.admission_class)


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["--internal-wait-slot"]:
            if len(sys.argv) != 5:
                raise ValueError("slot waiter requires directory, resource and parent PID")
            sys.exit(wait_slot_worker(sys.argv[2], sys.argv[3], int(sys.argv[4])))
        if sys.argv[1:2] in (["--internal-isolate-worker"], ["--internal-isolate-entered"]):
            if len(sys.argv) != 3:
                raise ValueError("isolate worker requires a request path")
            sys.exit(isolate_worker(sys.argv[2], entered=sys.argv[1] == "--internal-isolate-entered"))
        code = main()
        if code < 0:
            if -code != signal.SIGKILL:
                signal.signal(-code, signal.SIG_DFL)
            os.kill(os.getpid(), -code)
        sys.exit(code)
    except (OSError, ValueError) as error:
        print(f"heavy-lease: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
