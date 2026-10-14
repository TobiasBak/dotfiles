#!/usr/bin/env python3
import argparse
import array
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
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
        if as_json:
            print(json.dumps({"busy": busy, "holder": holder}, sort_keys=True))
        else:
            print(f"busy: {holder_summary(holder)}" if busy else "free")
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
    status_parser = commands.add_parser("status", help="Probe the kernel lease, ignoring stale metadata.")
    status_parser.add_argument("--json", action="store_true", help="Print {busy: bool, holder: object|null}.")
    handoff_parser = commands.add_parser("handoff", help="Broker a held lease to a manager-launched command.")
    handoff_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- launcher [args ...]")
    adopt_parser = commands.add_parser("adopt", help="Receive a held lease descriptor and exec a command.")
    adopt_parser.add_argument("--socket", required=True, help="Private socket provided by handoff.")
    adopt_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command [args ...]")
    args = parser.parse_args()
    if args.action != "status" and (len(args.command) < 2 or args.command[0] != "--"):
        parser.error("expected -- followed by a command")
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
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"heavy-lease: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
