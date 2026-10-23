#!/usr/bin/python3
"""Transitional named locks and independent process lifetimes, without admission."""
import argparse
from datetime import datetime, timezone
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile


PASSTHROUGH_TOKEN = "no-host-admission"


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


def write_holder(path, holder):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".holder-", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(holder, stream)
    os.replace(temporary, path)


def high_descriptor(fd):
    try:
        return fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 64)
    finally:
        os.close(fd)


def probe_lock(lock):
    fd = os.open(lock, os.O_RDWR | os.O_CLOEXEC)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"name": lock.stem, "holder": read_holder(lock.with_suffix(".json"))}
        return None
    finally:
        os.close(fd)


def held_locks(directory):
    return [entry for lock in sorted(directory.glob("exclusive-*.lock"))
            if (entry := probe_lock(lock))]


def status(directory, as_json):
    exclusive = held_locks(directory)
    waiters = [entry["holder"] for lock in sorted((directory / "waiters").glob("*.lock"))
               if (entry := probe_lock(lock)) and entry["holder"]]
    result = {"exclusive": exclusive, "waiters": waiters,
              "holder": exclusive[0]["holder"] if exclusive else None}
    if as_json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(f"{len(exclusive)} exclusive locks; {len(waiters)} waiters")
        for entry in exclusive:
            print(f"{entry['name']}: {json.dumps(entry['holder'], sort_keys=True)}")
        for waiter in waiters:
            print(f"waiting: {json.dumps(waiter, sort_keys=True)}")
    return 0


def run(directory, command, try_only, exclusive):
    if not exclusive:
        # Orderready still uses TOKEN to bypass its old local capacity pool and
        # authorize private workers. This marker owns no resource or descriptor.
        os.environ.setdefault("HEAVY_LEASE_TOKEN", PASSTHROUGH_TOKEN)
        os.execvp(command[0], command)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    name = f"exclusive-{exclusive}"
    lock = directory / f"{name}.lock"
    fd = high_descriptor(os.open(lock, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600))
    holder = read_holder(lock.with_suffix(".json"))
    # subprocess callers may drop descriptors but still borrow a live parent's
    # named ownership. The matching token is valid only while its lock is held.
    token = os.environ.get("HEAVY_LEASE_TOKEN")
    if token and holder and holder.get("token") == token and probe_lock(lock):
        os.close(fd)
        os.execvp(command[0], command)
    holder = {"pid": os.getpid(), "command": command,
              "started_at": datetime.now(timezone.utc).isoformat(),
              "token": token if token and token != PASSTHROUGH_TOKEN else secrets.token_hex(16),
              "resources": [name]}
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        if try_only:
            os.close(fd)
            print(f"busy: {name}: {json.dumps(read_holder(lock.with_suffix('.json')))}", file=sys.stderr)
            return 2
        folder = directory / "waiters"
        folder.mkdir(mode=0o700, exist_ok=True)
        waiter = folder / f"{os.getpid()}.lock"
        waiter_fd = os.open(waiter, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(waiter_fd, fcntl.LOCK_EX)
            write_holder(waiter.with_suffix(".json"), {**holder, "exclusive": exclusive})
            fcntl.flock(fd, fcntl.LOCK_EX)
        finally:
            waiter.with_suffix(".json").unlink(missing_ok=True)
            # Leave the tiny lock inode in place so status can probe it while
            # registrations disappear. Unlocked metadata is never reported.
            os.close(waiter_fd)
    write_holder(lock.with_suffix(".json"), holder)
    try:
        inherited = json.loads(os.environ.get("HEAVY_LEASE_FDS", "{}"))
    except ValueError:
        inherited = {}
    if not isinstance(inherited, dict):
        inherited = {}
    inherited[name] = fd
    os.environ["HEAVY_LEASE_FDS"] = json.dumps(inherited)
    os.environ["HEAVY_LEASE_FD"] = str(fd)
    os.environ["HEAVY_LEASE_TOKEN"] = holder["token"]
    os.set_inheritable(fd, True)
    os.execvp(command[0], command)


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


def main():
    parser = Parser(description="Named mutual-exclusion locks and independent process lifetimes. No host admission.")
    commands = parser.add_subparsers(dest="action", required=True)
    run_parser = commands.add_parser("run", help="Exec immediately, optionally holding a named lock.")
    mode = run_parser.add_mutually_exclusive_group()
    mode.add_argument("--wait", action="store_true", help="Wait for the named lock (default).")
    mode.add_argument("--try", dest="try_only", action="store_true", help="Exit 2 if the named lock is held.")
    run_parser.add_argument("--exclusive", help="Named mutual-exclusion lock.")
    run_parser.add_argument("--weight", type=int, help="Accepted and ignored during removal.")
    run_parser.add_argument("--memory", type=int, metavar="BYTES", help="Accepted and ignored during removal.")
    run_parser.add_argument("--class", dest="old_class", help="Accepted and ignored during removal.")
    run_parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command [args ...]")
    status_parser = commands.add_parser("status", help="Report held named locks and their waiters.")
    status_parser.add_argument("--json", action="store_true")
    for action in ("handoff", "adopt"):
        compatibility = commands.add_parser(action, help="Transitional direct exec; no lease transfer.")
        if action == "adopt":
            compatibility.add_argument("--socket", required=True, help="Accepted and ignored.")
        compatibility.add_argument("command", nargs=argparse.REMAINDER, help="-- command [args ...]")
    isolate_parser = commands.add_parser(
        "isolate", help="Discard inherited lock context and run in an independent user service (direct exec in CI).",
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
    if args.action == "status":
        return status(Path.home() / ".local/state/heavy-lease", args.json)
    if args.action in ("handoff", "adopt"):
        if args.action == "handoff":
            # Older bounded runners expand this variable before calling adopt.
            # There is no socket or descriptor-transfer protocol anymore.
            os.environ["HEAVY_LEASE_SOCKET"] = ""
        os.execvp(args.command[1], args.command[1:])
    if args.exclusive and not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", args.exclusive):
        parser.error("exclusive name must contain 1..80 letters, digits, underscores or hyphens")
    return run(Path.home() / ".local/state/heavy-lease", args.command[1:], args.try_only, args.exclusive)


if __name__ == "__main__":
    try:
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
