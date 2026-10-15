#!/usr/bin/env python3
import argparse
import array
from datetime import datetime, timezone
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time


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


def run(lock, holder_path, command, try_only):
    context = git_context()
    fd = high_descriptor(os.open(lock, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600))
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            holder = read_holder(holder_path)
            token = os.environ.get("HEAVY_LEASE_TOKEN")
            if token and holder is not None and holder.get("token") == token:
                os.execvp(command[0], command)
            if try_only:
                print(f"busy: {holder_summary(holder)}", file=sys.stderr)
                return 2
            fcntl.flock(fd, fcntl.LOCK_EX)
        token = secrets.token_hex(16)
        holder = {
            "token": token,
            "pid": os.getpid(),
            "pgid": os.getpgrp(),
            "start_time": datetime.now(timezone.utc).isoformat(),
            **context,
            "command": command,
        }
        if "T3_THREAD_ID" in os.environ:
            holder["T3_THREAD_ID"] = os.environ["T3_THREAD_ID"]
        write_holder(holder_path, holder)
        os.set_inheritable(fd, True)
        os.environ["HEAVY_LEASE_FD"] = str(fd)
        os.environ["HEAVY_LEASE_TOKEN"] = token
        os.execvp(command[0], command)
    finally:
        os.close(fd)


def isolate(command):
    raw_fd = os.environ.get("HEAVY_LEASE_FD", "-1")
    for name in list(os.environ):
        if name.startswith("HEAVY_LEASE_"):
            del os.environ[name]
    try:
        fd = int(raw_fd)
    except ValueError:
        fd = -1
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
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", str(Path.home() / ".cache/agent-tmp/heavy-lease")))
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="hl-isolate-", dir=runtime))
    request = folder / "request.json"
    cwd = os.getcwd()
    try:
        with os.fdopen(os.open(request, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            json.dump({"env": dict(os.environ), "cwd": cwd, "argv": command}, stream)
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


def isolate_worker(request):
    request = Path(request)
    try:
        payload = json.loads(request.read_text())
    finally:
        request.unlink(missing_ok=True)
    code = subprocess.run(payload["argv"], env=payload["env"], cwd=payload["cwd"], check=False).returncode
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


def status(lock, holder_path, as_json):
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            busy = True
        else:
            busy = False
        holder = read_holder(holder_path) if busy else None
        result = {"busy": busy, "holder": holder}
        if busy and sys.platform.startswith("linux") and metadata_owner_dead(holder):
            holders, incomplete = orphan_lock_holders(os.fstat(fd))
            result.update(orphan_pin=True, lock_holders=holders, lock_holders_incomplete=incomplete)
        if as_json:
            print(json.dumps(result, sort_keys=True))
        else:
            print(f"busy: {holder_summary(holder)}" if busy else "free")
            if result.get("orphan_pin"):
                print("orphan pin: metadata owner is dead; lock holders (best effort):")
                for process in result["lock_holders"]:
                    print(f"  pid={process['pid']} comm={process['comm']!r} cgroup={process['cgroup']!r} fds={process['fds']}")
                if result["lock_holders_incomplete"]:
                    print("  lock holder scan incomplete")
    finally:
        os.close(fd)
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
    data, ancillary, flags, _ = peer.recvmsg(128, socket.CMSG_SPACE(4 * 2), socket.MSG_CMSG_CLOEXEC)
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


def receive_lease(path, lock, holder_path, token):
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
        if unexpected or data != b"lease" or len(descriptors) != 1:
            raise ValueError("lease adoption requires exactly one descriptor and a valid reply")
        fd = descriptors[0]
        if not held_descriptor(fd, lock, holder_path, token):
            raise ValueError("adopted descriptor is not the current held lease")
        return high_descriptor(descriptors.pop())
    finally:
        for fd in descriptors:
            os.close(fd)


def export_descriptor(fd):
    os.set_inheritable(fd, True)
    os.environ["HEAVY_LEASE_FD"] = str(fd)


def adopt(path, lock, holder_path, command):
    fd = receive_lease(path, lock, holder_path, os.environ.get("HEAVY_LEASE_TOKEN"))
    try:
        export_descriptor(fd)
        os.environ["HEAVY_LEASE_SOCKET"] = path
        os.execvp(command[0], command)
    finally:
        os.close(fd)


def serve_adoption(peer, fd, lock, holder_path, token):
    descriptors = []
    try:
        data, descriptors, unexpected = receive_message(peer)
        if unexpected or descriptors or data != token.encode() or not held_descriptor(fd, lock, holder_path, token):
            peer.sendall(b"rejected")
            return False
        peer.sendmsg([b"lease"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])
        return True
    except (OSError, ValueError):
        return False
    finally:
        for received in descriptors:
            os.close(received)


def broker(listener, fd, lock, holder_path, token, command, path):
    environment = {**os.environ, "HEAVY_LEASE_FD": str(fd), "HEAVY_LEASE_SOCKET": path}
    process = subprocess.Popen(command, env=environment, pass_fds=(fd,))
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
                        adopted = serve_adoption(peer, fd, lock, holder_path, token) or adopted
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


def handoff(lock, holder_path, command):
    token = os.environ.get("HEAVY_LEASE_TOKEN")
    try:
        fd = int(os.environ.get("HEAVY_LEASE_FD", "-1"))
    except ValueError:
        fd = -1
    if not held_descriptor(fd, lock, holder_path, token):
        inherited_socket = os.environ.get("HEAVY_LEASE_SOCKET")
        if not inherited_socket:
            raise ValueError("handoff requires a held lease descriptor or a live inherited lease socket")
        fd = receive_lease(inherited_socket, lock, holder_path, token)
    fd = high_descriptor(fd)
    try:
        runtime = Path(os.environ.get("XDG_RUNTIME_DIR", str(Path.home() / ".cache/agent-tmp/heavy-lease")))
        runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="hl-", dir=runtime) as folder:
            path = str(Path(folder) / "socket")
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as listener:
                listener.bind(path)
                listener.listen()
                code = broker(listener, fd, lock, holder_path, token, command, path)
    finally:
        os.close(fd)
    if code < 0:
        if -code != signal.SIGKILL:
            signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code


def main():
    parser = Parser(description="Serialize heavy commands with a process-inherited Linux lease.")
    commands = parser.add_subparsers(dest="action", required=True)
    run_parser = commands.add_parser("run", help="Exec a command while holding the lease.")
    mode = run_parser.add_mutually_exclusive_group()
    mode.add_argument("--wait", action="store_true", help="Wait in the kernel for the lease (default).")
    mode.add_argument("--try", dest="try_only", action="store_true", help="Exit 2 if the lease is busy.")
    run_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command [args ...]")
    status_parser = commands.add_parser(
        "status", help="Probe the kernel lease, ignoring stale metadata.",
        description="Probe the kernel lease. On Linux, a busy lease with a demonstrably dead metadata PID "
        "reports an orphan pin and a point-in-time, best-effort list of held FLOCK descriptors from /proc. "
        "Process exits and /proc visibility or permissions may limit this list; lock_holders_incomplete "
        "reports unreadable evidence. The metadata stores only a numeric PID, so a reused live PID "
        "cannot be distinguished from the original owner and suppresses orphan diagnostics.",
    )
    status_parser.add_argument("--json", action="store_true", help="Print {busy: bool, holder: object|null}; orphan pins also add orphan_pin, lock_holders and lock_holders_incomplete.")
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
    lock = directory / "lock"
    holder = directory / "holder.json"
    if args.action == "status":
        return status(lock, holder, args.json)
    if args.action == "handoff":
        return handoff(lock, holder, args.command[1:])
    if args.action == "adopt":
        return adopt(args.socket, lock, holder, args.command[1:])
    return run(lock, holder, args.command[1:], args.try_only)


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["--internal-isolate-worker"]:
            if len(sys.argv) != 3:
                raise ValueError("isolate worker requires a request path")
            sys.exit(isolate_worker(sys.argv[2]))
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"heavy-lease: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
