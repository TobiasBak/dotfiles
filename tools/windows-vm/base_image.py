from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_NAME = "windows-server-2025-desktop-base.qcow2"
EXPIRY_WARNING_DAYS = 30


def qemu_json(*arguments: str) -> dict:
    return json.loads(subprocess.check_output(["qemu-img", *arguments], text=True))


def save(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def validate_identity(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Base identity must be a JSON object")
    recipe = value.get("recipeSha256")
    if not isinstance(recipe, str) or re.fullmatch(r"[0-9a-f]{64}", recipe) is None:
        raise ValueError("Base identity requires recipeSha256, a lowercase SHA-256")
    tools = value.get("tools")
    if not isinstance(tools, dict) or not tools or not all(
        isinstance(name, str) and name.strip() and isinstance(version, str) and version.strip()
        for name, version in tools.items()
    ):
        raise ValueError("Base identity requires nonempty tool names and installed version strings in tools")
    windows = value.get("windows")
    if not isinstance(windows, dict) or not all(
        isinstance(windows.get(key), str) and windows[key] for key in ("productName", "build")
    ):
        raise ValueError("Base identity requires windows.productName and windows.build")
    if "evaluationExpiresAt" not in windows:
        raise ValueError("Base identity requires windows.evaluationExpiresAt (null for non-evaluation)")
    expires = windows["evaluationExpiresAt"]
    evaluation = windows.get("isEvaluation")
    if not isinstance(evaluation, bool):
        raise ValueError("windows.isEvaluation must be a boolean")
    if expires is None and evaluation:
        raise ValueError("Windows evaluation base must report its evaluationExpiresAt")
    if expires is not None:
        if not isinstance(expires, str):
            raise ValueError("windows.evaluationExpiresAt must be an ISO timestamp or null")
        date = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if date.tzinfo is None:
            raise ValueError("windows.evaluationExpiresAt requires a timezone")
        now = datetime.now(timezone.utc)
        if date <= now:
            raise ValueError(
                f"Windows evaluation expired: expiry={expires}, now={now.isoformat()}. "
                "Provision a licensed or renewed Windows base before qualification."
            )
        if date - now <= timedelta(days=EXPIRY_WARNING_DAYS):
            print(
                f"warning: Windows evaluation expires at {expires}; renewal window="
                f"{EXPIRY_WARNING_DAYS} days (allow a month to refresh the release lab)",
                file=sys.stderr,
            )
    return value


class BaseImage:
    def __init__(self, home: Path):
        self.home = home
        self.base = home / "base"
        self.disk = self.base / BASE_NAME
        self.identity = self.base / "identity.json"
        self.previous = self.base / "previous"
        self.journal = self.base / "promotion-in-progress"

    def info(self) -> dict:
        if self.journal.exists():
            phase = self.transaction()["phase"]
            recovery = "base-confirm" if phase == "confirming" else "base-rollback"
            raise ValueError(f"Interrupted base transaction ({phase}). Stop/remove its clone, then run {recovery}.")
        identity = None
        if self.identity.exists():
            identity = validate_identity(json.loads(self.identity.read_text(encoding="utf-8")))
        return {
            "disk": str(self.disk),
            "sealed": (self.base / "sealed").is_file(),
            "identity": identity,
            "previousRetained": self.previous.exists(),
        }

    def clones(self) -> list[Path]:
        directory = self.home / "vms"
        return sorted(directory.iterdir()) if directory.exists() else []

    def require_no_clones(self) -> None:
        clones = self.clones()
        if clones:
            raise ValueError(f"Base operation requires no test clones; existing: {', '.join(p.name for p in clones)}")

    def promote(self, name: str, identity_path: Path) -> dict:
        if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", name) is None:
            raise ValueError("Invalid preparation clone name")
        clone = self.home / "vms" / name
        if self.clones() != [clone]:
            raise ValueError("Base promotion requires exactly the named stopped preparation clone")
        if not self.disk.is_file() or not (self.base / "sealed").is_file():
            raise ValueError("Base promotion requires an existing sealed base")
        if self.previous.exists() or self.journal.exists():
            raise ValueError("Previous base remains. Finish base-confirm or base-rollback before refreshing again.")
        identity = validate_identity(json.loads(identity_path.read_text(encoding="utf-8")))
        source = clone / "disk.qcow2"
        measure = qemu_json("measure", "--output=json", "-O", "qcow2", str(source))
        required = measure["required"]
        available = shutil.disk_usage(self.base).free
        old_allocated = self.disk.stat().st_blocks * 512
        if available < required:
            raise ValueError(
                f"Base promotion disk budget exceeded: available={available} bytes, "
                f"flattenRequired={required} bytes, retainedOldAllocated={old_allocated} bytes. "
                "The old image stays allocated through boot verification; a hard link adds no copy."
            )
        receipt = {
            "availableBytes": available,
            "flattenRequiredBytes": required,
            "retainedOldAllocatedBytes": old_allocated,
            "basis": "qemu-img measure required qcow2 allocation; existing old image retained by hard link",
        }
        candidate = self.base / "next.qcow2"
        if candidate.exists():
            raise ValueError(f"Unfinished flattened image exists: {candidate}; inspect and remove it before retrying")
        save(self.journal, {"phase": "preparing", "clone": name, "diskBudget": receipt})
        try:
            subprocess.run(["qemu-img", "convert", "-O", "qcow2", str(source), str(candidate)], check=True)
            subprocess.run(["qemu-img", "check", str(candidate)], check=True, stdout=sys.stderr)
            details = qemu_json("info", "--output=json", str(candidate))
            details["filename"] = str(self.disk)
            if details.get("backing-filename"):
                raise ValueError("Flattened base unexpectedly has a backing file")
            self.previous.mkdir()
            os.link(self.disk, self.previous / BASE_NAME)
            for filename in ("sealed", "identity.json", "provisioning-ready.json"):
                path = self.base / filename
                if path.exists():
                    shutil.copy2(path, self.previous / filename)
            save(self.journal, {"phase": "retained", "clone": name, "diskBudget": receipt})
            shutil.rmtree(clone)
            candidate.chmod(0o444)
            candidate.replace(self.disk)
            identity["promotionDiskBudget"] = receipt
            save(self.identity, identity)
            save(self.base / "sealed", {"sealedAt": datetime.now(timezone.utc).isoformat(), "image": details})
            (self.base / "provisioning-ready.json").unlink(missing_ok=True)
            self.journal.unlink()
        except BaseException:
            if self.transaction()["phase"] == "preparing":
                candidate.unlink(missing_ok=True)
                if self.previous.exists():
                    shutil.rmtree(self.previous)
                self.journal.unlink()
            raise
        return {"promoted": name, "identity": identity, "previousRetained": True}

    def transaction(self) -> dict:
        return json.loads(self.journal.read_text(encoding="utf-8"))

    def confirm(self) -> dict:
        self.require_no_clones()
        if self.journal.exists():
            if self.transaction()["phase"] != "confirming":
                raise ValueError("Interrupted base promotion/rollback; use base-rollback, not base-confirm")
        else:
            self.info()
            if not self.previous.is_dir() or not self.identity.is_file():
                raise ValueError("No complete promoted base awaiting confirmation")
            save(self.journal, {"phase": "confirming"})
        if self.previous.exists():
            shutil.rmtree(self.previous)
        self.journal.unlink()
        return {"confirmed": True, "previousRetained": False}

    def rollback(self) -> dict:
        self.require_no_clones()
        phase = self.transaction()["phase"] if self.journal.exists() else "retained"
        if phase == "confirming":
            raise ValueError("Base confirmation has started; finish base-confirm instead of rollback")
        if phase not in ("preparing", "restored"):
            old_disk = self.previous / BASE_NAME
            if not old_disk.is_file() or not (self.previous / "sealed").is_file():
                raise ValueError("No complete retained base available for rollback")
            save(self.journal, {"phase": "restoring"})
            temporary_disk = self.base / "rollback.qcow2"
            temporary_disk.unlink(missing_ok=True)
            os.link(old_disk, temporary_disk)
            temporary_disk.replace(self.disk)
            for filename in ("sealed", "identity.json", "provisioning-ready.json"):
                source = self.previous / filename
                destination = self.base / filename
                if source.exists():
                    temporary = destination.with_name(destination.name + ".restore")
                    shutil.copy2(source, temporary)
                    temporary.replace(destination)
                else:
                    destination.unlink(missing_ok=True)
            save(self.journal, {"phase": "restored"})
        if self.previous.exists():
            shutil.rmtree(self.previous)
        (self.base / "next.qcow2").unlink(missing_ok=True)
        self.journal.unlink(missing_ok=True)
        return {"rolledBack": True}


def main() -> int:
    try:
        home, command, *arguments = sys.argv[1:]
        image = BaseImage(Path(home))
        if command == "info" and not arguments:
            result = image.info()
        elif command == "promote" and len(arguments) == 2:
            result = image.promote(arguments[0], Path(arguments[1]))
        elif command == "confirm" and not arguments:
            result = image.confirm()
        elif command == "rollback" and not arguments:
            result = image.rollback()
        else:
            raise ValueError("Invalid base image operation")
        print(json.dumps(result))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
