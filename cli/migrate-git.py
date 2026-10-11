#!/usr/bin/env python3
import argparse
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


AUDITED_SHA256 = "ed1cbbd3d2c74d7dd60f17de95960f2401a62cc1a3ade13fbdcab1f941630894"
TEMPLATE = Path("/usr/share/omarchy/config/git/config")
OVERRIDES = Path(__file__).resolve().parent / "git" / "overrides"


def config_values(content: bytes) -> dict[bytes, list[bytes]]:
    result = subprocess.run(
        ["git", "config", "--file", "-", "--no-includes", "--null", "--list"],
        input=content,
        capture_output=True,
        check=True,
    )
    values: dict[bytes, list[bytes]] = {}
    for entry in result.stdout.split(b"\0"):
        if entry:
            key, separator, value = entry.partition(b"\n")
            values.setdefault(key, []).append(separator + value)
    return values


def migrate(check_only: bool) -> int:
    live = Path.home() / ".config/git/config"
    original = live.read_bytes()
    template = TEMPLATE.read_bytes()
    if original == template:
        print("Git config already matches the installed Omarchy template.")
        return 0

    if hashlib.sha256(original).hexdigest() != AUDITED_SHA256:
        print(f"Refusing unrecognized Git config: {live}", file=sys.stderr)
        return 2

    expected = config_values(template)
    for key, values in config_values(OVERRIDES.read_bytes()).items():
        expected.setdefault(key, []).extend(values)
    if config_values(original) != expected:
        print("Refusing migration: Git deltas do not match the personal overrides.", file=sys.stderr)
        return 2
    if live.is_symlink() or not stat.S_ISREG(live.stat().st_mode):
        print(f"Refusing to replace a non-regular Git config: {live}", file=sys.stderr)
        return 2
    if check_only:
        print("Audited legacy Git config needs migration.")
        return 1

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = live.with_name(f"config.backup-{timestamp}")
    mode = stat.S_IMODE(live.stat().st_mode)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=live.parent, prefix=".config-", delete=False) as replacement:
            temporary = Path(replacement.name)
            replacement.write(template)
            replacement.flush()
            os.fchmod(replacement.fileno(), mode)
            os.fsync(replacement.fileno())
        if live.is_symlink() or live.read_bytes() != original or TEMPLATE.read_bytes() != template:
            print("Refusing migration: Git config or template changed during validation.", file=sys.stderr)
            return 2
        with backup.open("xb") as saved:
            os.fchmod(saved.fileno(), mode)
            saved.write(original)
            saved.flush()
            os.fsync(saved.fileno())
        os.replace(temporary, live)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(f"Restored the installed Omarchy template; backup: {backup}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Move the audited personal Git settings out of Omarchy's default config."
    )
    parser.add_argument("--check", action="store_true", help="Inspect only: 0 identical, 1 audited legacy, 2 unrecognized.")
    args = parser.parse_args()
    try:
        return migrate(args.check)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"Git config migration failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
