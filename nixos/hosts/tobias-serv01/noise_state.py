import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid


CPU = Path("/sys/devices/system/cpu")
UNITS = ("nix-gc.service", "nix-optimise.service", "systemd-journald.service")


def require(condition, message):
    if not condition:
        raise RuntimeError(message + ". Approved fix: restore the recorded control state through the Nix-owned noise helper and inspect its readbacks before another comparison")


def readback():
    governors = {str(path): path.read_text().strip() for path in sorted(CPU.glob("cpu[0-9]*/cpufreq/scaling_governor"))}
    turbo = CPU / "intel_pstate/no_turbo"
    policy_files = ("scaling_driver", "energy_performance_preference", "scaling_min_freq", "scaling_max_freq", "base_frequency")
    policies = {str(Path(name).parent): {field: (Path(name).parent / field).read_text().strip()
                                        for field in policy_files if (Path(name).parent / field).exists()}
                for name in governors}
    return {"governors": governors, "no_turbo": turbo.read_text().strip() if turbo.exists() else None,
            "policies": policies,
            "frequencies_khz": {str(path): path.read_text().strip() for path in sorted(CPU.glob("cpu[0-9]*/cpufreq/scaling_cur_freq"))}}


def background(weight):
    states = {}
    for unit in UNITS:
        subprocess.run(["systemctl", "set-property", "--runtime", unit, f"CPUWeight={weight}", f"IOWeight={weight}"], check=True, capture_output=True, timeout=20)
        result = subprocess.run(["systemctl", "show", unit, "-p", "CPUWeight", "-p", "IOWeight"], check=True, capture_output=True, text=True, timeout=10)
        states[unit] = dict(line.split("=", 1) for line in result.stdout.splitlines())
        require(states[unit] == {"CPUWeight": str(weight), "IOWeight": str(weight)}, "background priority readback differs")
    return states


def apply(factor, arm, defaults):
    require(socket.gethostname() == "tobias-serv01" and os.geteuid() == 0, "noise helper requires root on disposable tobias-serv01 only")
    require(factor in {"governor", "turbo", "background", "restore"} and arm in {"control", "candidate"}, "unknown factor or arm")
    started_ns = time.time_ns()
    started_monotonic_ns = time.monotonic_ns()
    before = readback()
    service_state = None
    if factor in {"governor", "restore"}:
        value = defaults["governor"] if factor == "restore" else ("powersave" if arm == "control" else "performance")
        require(bool(before["governors"]), "CPU frequency governor is unavailable")
        for name in before["governors"]:
            path = Path(name)
            available = (path.parent / "scaling_available_governors").read_text().split()
            require(value in available, "requested governor is unsupported")
            path.write_text(value)
        require(set(readback()["governors"].values()) == {value}, "governor readback differs")
    if factor in {"turbo", "restore"}:
        value = str(int(not defaults["turbo"])) if factor == "restore" else ("0" if arm == "control" else "1")
        require(before["no_turbo"] is not None, "Intel turbo control is unavailable")
        (CPU / "intel_pstate/no_turbo").write_text(value)
        require(readback()["no_turbo"] == value, "turbo readback differs")
    if factor == "background":
        service_state = background(100 if arm == "control" else 10)
    after = readback()
    result = {"epoch_id": uuid.uuid4().hex, "factor": factor, "arm": arm,
              "system_closure": str(Path("/run/current-system").resolve()),
              "helper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "started_unix_ns": started_ns, "ended_unix_ns": time.time_ns(),
              "started_monotonic_ns": started_monotonic_ns, "ended_monotonic_ns": time.monotonic_ns(),
              "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
              "before": before, "after": after, "background": service_state}
    directory = Path("/var/lib/dev-loop-lab-noise")
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    with (directory / "epochs.jsonl").open("a") as stream:
        stream.write(json.dumps(result, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return result


def main():
    try:
        require(len(sys.argv) == 3, "use dev-loop-lab-noise-state FACTOR control|candidate")
        defaults = json.loads(Path("/etc/dev-loop-lab-noise.json").read_text())
        print(json.dumps(apply(sys.argv[1], sys.argv[2], defaults), sort_keys=True))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
