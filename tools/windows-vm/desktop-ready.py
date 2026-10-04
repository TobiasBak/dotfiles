"""Bounded clone desktop preparation. SSH stdout is a JSON protocol, never a log."""

import argparse
import base64
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

GUEST_SCRIPT = "C:/ProgramData/OipVmDesktopReady.ps1"
DEADLINE_POLICY = {
    "boot": "300s operational deadline for an already-started Windows clone to accept SSH and prepare its disk/login; not a measured boot SLA.",
    "restart": "300s operational deadline for the single login restart and an unlocked console; not a measured boot SLA.",
    "command": "60s cap per SSH operation so a live connection cannot consume the entire boot/restart budget.",
    "cleanup": "30s separate failure-cleanup deadline for removing temporary Winlogon credentials over SSH.",
}
OBSERVATION_FIELDS = {
    "state", "bootTime", "provisionReady", "consoleSessionId", "consoleActive",
    "consoleUnlocked", "consoleAdministrator", "explorerRunning", "credentialsCleared",
    "partitionBytes", "supportedMaxBytes",
}


def positive_seconds(value):
    seconds = int(value)
    if seconds <= 0:
        raise argparse.ArgumentTypeError("deadline must be a positive number of seconds")
    return seconds


def encoded_command(script):
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    return f"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded}"


class ReadinessError(Exception):
    pass


class DesktopReady:
    def __init__(self, args):
        self.args = args
        self.diagnostic_path = args.runtime / "desktop-ready.json"
        self.diagnostic = {
            "state": "starting", "phase": "boot", "restartRequested": False,
            "budgetsSeconds": {name: getattr(args, f"{name}_timeout") for name in DEADLINE_POLICY},
            "deadlinePolicy": DEADLINE_POLICY, "observations": [],
        }
        self.persist()

    def persist(self):
        self.diagnostic["updatedAt"] = datetime.now(timezone.utc).isoformat()
        temporary = self.diagnostic_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.diagnostic, indent=2) + "\n")
        temporary.replace(self.diagnostic_path)

    def invoke(self, command, deadline, stdin=""):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            result = subprocess.run(
                [*self.args.ssh, command], input=stdin, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=min(self.args.command_timeout, remaining),
            )
        except subprocess.TimeoutExpired:
            self.diagnostic["lastFailure"] = "SSH command deadline exceeded"
            return None
        if result.returncode:
            self.diagnostic["lastFailure"] = f"SSH/guest command exited {result.returncode}"
            return None
        return result.stdout.lstrip("\ufeff").strip()

    def guest(self, mode, deadline, stdin=""):
        output = self.invoke(
            f"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {GUEST_SCRIPT} -Mode {mode}",
            deadline, stdin,
        )
        if output is None:
            return None
        try:
            result = json.loads(output)
            if not isinstance(result, dict):
                raise ValueError("not a JSON object")
        except (ValueError, TypeError):
            self.diagnostic["lastFailure"] = "Guest returned invalid readiness JSON"
            return None
        observation = {key: value for key, value in result.items() if key in OBSERVATION_FIELDS}
        self.diagnostic["observations"] = [*self.diagnostic["observations"][-1:], observation]
        self.persist()
        return observation

    def wait(self, phase, deadline, operation):
        self.diagnostic["phase"] = phase
        self.persist()
        while time.monotonic() < deadline:
            result = operation()
            if result:
                return result
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        raise ReadinessError(
            f"{phase} deadline exceeded: limit={getattr(self.args, f'{phase}_timeout')}s; "
            f"{self.diagnostic.get('lastFailure', 'guest not ready')}"
        )

    @staticmethod
    def ready(result, previous_boot):
        return result and result.get("state") == "ready" and result.get("bootTime") != previous_boot and all(
            result.get(field) is True for field in (
                "consoleActive", "consoleUnlocked", "consoleAdministrator", "explorerRunning",
            )
        ) and bool(result.get("bootTime")) and isinstance(result.get("partitionBytes"), int) and (
            result["partitionBytes"] > 0 and result["partitionBytes"] == result.get("supportedMaxBytes")
        )

    def run(self):
        password = self.args.password_file.read_text().rstrip("\r\n")
        if not password or "\n" in password or "\r" in password:
            raise ReadinessError("Administrator password file must contain one nonempty line")
        script = self.args.guest_script.read_text()
        boot_deadline = time.monotonic() + self.args.boot_timeout
        install = encoded_command(
            "$ErrorActionPreference='Stop'; "
            f"[IO.File]::WriteAllText('{GUEST_SCRIPT}', [Console]::In.ReadToEnd()); "
            "Write-Output 'installed'"
        )
        self.wait("boot", boot_deadline, lambda: self.invoke(install, boot_deadline, script) == "installed")
        prepared = self.guest("Prepare", boot_deadline, password)
        del password
        if not prepared or prepared.get("state") != "restart-scheduled" or not prepared.get("bootTime"):
            raise ReadinessError("Clone disk/login preparation failed or exceeded the boot deadline")
        self.diagnostic["restartRequested"] = True
        self.persist()
        restart_deadline = time.monotonic() + self.args.restart_timeout

        def probe():
            result = self.guest("Inspect", restart_deadline)
            return result if self.ready(result, prepared["bootTime"]) else None

        self.wait("restart", restart_deadline, probe)
        cleaned = self.guest("Cleanup", restart_deadline)
        if not self.ready(cleaned, prepared["bootTime"]) or cleaned.get("credentialsCleared") is not True:
            raise ReadinessError("Console readiness or Winlogon credential removal could not be verified")
        self.diagnostic.update(state="ready", phase="complete", credentialsCleared=True)
        self.diagnostic.pop("lastFailure", None)
        self.persist()
        print(json.dumps(self.diagnostic))

    def cleanup_after_failure(self):
        result = self.guest("Cleanup", time.monotonic() + self.args.cleanup_timeout)
        self.diagnostic["credentialsCleared"] = bool(result and result.get("credentialsCleared") is True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--password-file", type=Path, required=True)
    parser.add_argument("--guest-script", type=Path, required=True)
    for name, default in (("boot", 300), ("restart", 300), ("command", 60), ("cleanup", 30)):
        parser.add_argument(f"--{name}-timeout", type=positive_seconds, default=default, help=DEADLINE_POLICY[name])
    parser.add_argument("ssh", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.ssh and args.ssh[0] == "--":
        args.ssh.pop(0)
    if not args.ssh:
        parser.error("SSH command is required")
    runner = DesktopReady(args)
    try:
        runner.run()
    except (OSError, ReadinessError) as error:
        runner.diagnostic.update(state="failed", failure=str(error))
        runner.cleanup_after_failure()
        runner.persist()
        print(f"error: {error}; diagnostics: {runner.diagnostic_path}; credentialsCleared={runner.diagnostic['credentialsCleared']}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        runner.diagnostic.update(state="interrupted", failure="Interrupted by caller")
        runner.cleanup_after_failure()
        runner.persist()
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
