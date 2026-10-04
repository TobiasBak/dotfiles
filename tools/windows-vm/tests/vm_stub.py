"""Scratch-only subprocess doubles used by test_vm_lifecycle.py."""

import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

home = Path(os.environ["OIP_WINDOWS_VM_HOME"])
assert "windows-vm-scratch-" in str(home), "Never run these doubles outside scratch"
mode, *args = sys.argv[1:]


def record(name, arguments):
    (home / f"{name}.json").write_text(json.dumps(arguments))


if mode == "systemd-run":
    record(mode, args)
    unit = next(a.split("=", 1)[1] for a in args if a.startswith("--unit="))
    command = args[args.index("--") + 1 :]
    (home / f"{unit}.state").write_text("activating")
    subprocess.Popen(
        [sys.executable, __file__, "service-worker", unit, *command],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
elif mode == "service-worker":
    unit, *command = args
    process = subprocess.Popen(command)
    (home / f"{unit}.supervisor").write_text(str(process.pid))
    (home / f"{unit}.state").write_text("active")
    process.wait()
    (home / f"{unit}.state").write_text("inactive")
elif mode == "systemctl":
    if (home / "unit-query-failed").exists():
        sys.exit(1)
    unit = args[-1]
    if "--property=ActiveState" in args:
        state = home / f"{unit}.state"
        print(state.read_text() if state.exists() else "inactive")
    elif "--property=MainPID" in args:
        pid = home / f"{unit}.supervisor"
        print(pid.read_text() if pid.exists() else "0")
    else:
        raise ValueError(args)
elif mode == "pc-workload":
    record("workload", args)
    assert args[0] == "--"
    sys.exit(subprocess.call(args[1:]))
elif mode == "qemu-system-x86_64":
    record("qemu", args)
    assert "-daemonize" not in args
    (home / "entered-start").touch()
    while (home / "hold-start").exists():
        time.sleep(0.01)
    pidfile = Path(args[args.index("-pidfile") + 1])
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(str(pidfile.parent / "qmp.sock"))
    pidfile.write_text(str(os.getpid()))
    stopped = False

    def terminate(_signum, _frame):
        global stopped
        stopped = True

    signal.signal(signal.SIGTERM, terminate)
    while not stopped:
        time.sleep(0.01)
    sock.close()
    (home / "qemu-exited").touch()
elif mode == "socat":
    request = sys.stdin.read()
    record("qmp", [json.loads(line) for line in request.splitlines()])
    assert "system_powerdown" in request or '"quit"' in request
    if '"quit"' in request or not (home / "ignore-powerdown").exists():
        runtime = Path(args[-1].removeprefix("UNIX-CONNECT:")).parent
        os.kill(int((runtime / "qemu.pid").read_text()), signal.SIGTERM)
elif mode == "scp":
    record(mode, args)
    if (home / "scp-failed").exists():
        print("stub SCP transfer refused", file=sys.stderr)
        sys.exit(1)
    if args[-2].startswith("Administrator@"):
        Path(args[-1]).write_bytes(b"stub downloaded evidence")
elif mode == "ssh":
    record(mode, args)
    command = args[-1]
    if "-EncodedCommand" in command or "-Mode" in command:
        policy_path = home / "desktop-policy.json"
        policy = json.loads(policy_path.read_text()) if policy_path.exists() else {}
        if policy.get("hang"):
            time.sleep(10)
        state_path = home / "desktop-model.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {
            "installed": False, "prepared": 0, "credentials": False, "boot": "initial",
        }
        if "-EncodedCommand" in command:
            state["installed"] = bool(sys.stdin.read())
            print("installed")
        else:
            assert state["installed"]
            operation = command.split("-Mode ")[1]
            if operation == "Prepare":
                password = sys.stdin.read()
                expected = (home / "base" / "administrator-password.txt").read_text().strip()
                assert password == expected
                state["passwordSha256"] = hashlib.sha256(password.encode()).hexdigest()
                state["prepared"] += 1
                state["credentials"] = True
                state["boot"] = "restarted" if not policy.get("noRestart") else "initial"
            elif operation == "Cleanup":
                state["credentials"] = bool(policy.get("cleanupFails"))
            else:
                assert operation == "Inspect"
            ready = not policy.get("locked")
            print(json.dumps({
                "state": "restart-scheduled" if operation == "Prepare" else "ready" if ready else "waiting",
                "bootTime": "initial" if operation == "Prepare" else state["boot"],
                "provisionReady": not policy.get("missingBootstrap"),
                "consoleSessionId": 1,
                "consoleActive": True,
                "consoleUnlocked": not policy.get("locked"),
                "consoleAdministrator": True,
                "explorerRunning": True,
                "credentialsCleared": not state["credentials"],
                "partitionBytes": 2097152,
                "supportedMaxBytes": 2097152,
            }))
        state_path.write_text(json.dumps(state))
    else:
        print("stub guest response")
elif mode == "sleep":
    seconds = float(args[0])
    time.sleep(0.001 if (home / "fast-wait").exists() else min(seconds, 0.02))
elif mode == "ss":
    pass
else:
    raise ValueError(mode)
