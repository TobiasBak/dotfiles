#!/usr/bin/env python3
"""Inspect NAS configuration without touching the mount or reading credentials."""

import argparse
import errno
import os
from pathlib import Path
import stat
import subprocess
import sys


UNITS = ("mnt-nas.mount", "mnt-nas.automount")
PROPERTIES = (
    "FragmentPath", "DropInPaths", "NeedDaemonReload", "UnitFileState", "ActiveState"
)


class Findings:
    def __init__(self):
        self.status = 0

    def drift(self, message):
        self.status = max(self.status, 1)
        print(message, file=sys.stderr)

    def error(self, message):
        self.status = 2
        print(message, file=sys.stderr)


def inspect_metadata(path, uid, gid, mode, findings):
    """Use lstat only; credentials must never be opened."""
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        findings.drift(f"{path}: missing")
        return None
    except OSError as exc:
        findings.error(f"{path}: cannot inspect metadata ({exc.strerror})")
        return None

    if not stat.S_ISREG(metadata.st_mode):
        findings.drift(f"{path}: must be a regular file, not a symlink or special file")
        return None
    if metadata.st_uid != uid:
        findings.drift(f"{path}: owner UID must be {uid}")
    if gid is not None and metadata.st_gid != gid:
        findings.drift(f"{path}: owner GID must be {gid}")
    if stat.S_IMODE(metadata.st_mode) != mode:
        findings.drift(f"{path}: mode must be {mode:04o}")
    return metadata


def check_credentials(args):
    findings = Findings()
    metadata = inspect_metadata(args.path, os.getuid(), None, 0o600, findings)
    if metadata is not None and metadata.st_size == 0:
        findings.drift(f"{args.path}: must not be empty")
    return findings.status


def check_unit_bytes(path, declaration, metadata, findings):
    try:
        expected = declaration.read_bytes()
    except OSError as exc:
        findings.error(f"{declaration}: cannot read repository declaration ({exc.strerror})")
        return

    # Do not follow a replaced symlink or block on a replaced FIFO after lstat.
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            current = os.fstat(source.fileno())
            if not stat.S_ISREG(current.st_mode):
                findings.drift(f"{path}: no longer a regular file")
                return
            if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                findings.error(f"{path}: changed during inspection; retry")
                return
            actual = source.read()
    except FileNotFoundError:
        findings.drift(f"{path}: missing")
        return
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            findings.drift(f"{path}: must not be a symlink")
        else:
            findings.error(f"{path}: cannot read unit definition ({exc.strerror})")
        return
    if actual != expected:
        findings.drift(f"{path}: bytes differ from repository declaration")


def inspect_systemd(unit, findings):
    command = [
        "systemctl", "--system", "show",
        "--property=" + ",".join(PROPERTIES), unit,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        findings.error(f"{unit}: systemctl inspection timed out after 5 seconds")
        return None
    except (OSError, UnicodeError) as exc:
        detail = exc.strerror if isinstance(exc, OSError) else "invalid text output"
        findings.error(f"{unit}: cannot run systemctl inspection ({detail})")
        return None
    if result.returncode != 0:
        findings.error(f"{unit}: systemctl inspection exited {result.returncode}")
        return None

    properties = {}
    for line in result.stdout.splitlines():
        name, separator, value = line.partition("=")
        if not separator or name not in PROPERTIES or name in properties:
            findings.error(f"{unit}: malformed systemctl property output")
            return None
        properties[name] = value
    if set(properties) != set(PROPERTIES):
        findings.error(f"{unit}: incomplete systemctl property output")
        return None
    return properties


def check_units(args):
    findings = Findings()
    unit_dir = Path(os.path.abspath(args.unit_dir))
    declarations = Path(__file__).absolute().parent
    for unit in UNITS:
        path = unit_dir / unit
        metadata = inspect_metadata(path, args.owner_uid, args.owner_gid, 0o644, findings)
        if metadata is not None:
            check_unit_bytes(path, declarations / unit, metadata, findings)

        properties = inspect_systemd(unit, findings)
        if properties is None:
            continue
        if properties["FragmentPath"] != str(path):
            findings.drift(f"{unit}: loaded FragmentPath must be {path}")
        if properties["DropInPaths"]:
            findings.drift(f"{unit}: unexpected loaded drop-ins")
        if properties["NeedDaemonReload"] != "no":
            findings.drift(f"{unit}: systemd needs a daemon reload")
        if unit.endswith(".automount"):
            expected_state = "enabled"
            allowed_active = {"active"}
        else:
            expected_state = "static"
            # An unavailable NAS is not configuration drift.
            allowed_active = {"inactive", "active", "failed"}
        if properties["UnitFileState"] != expected_state:
            findings.drift(f"{unit}: UnitFileState must be {expected_state}")
        if properties["ActiveState"] not in allowed_active:
            findings.drift(f"{unit}: ActiveState must be {' or '.join(sorted(allowed_active))}")
    return findings.status


def nonnegative_id(value):
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a nonnegative integer") from None
    if number < 0:
        raise argparse.ArgumentTypeError("must be a nonnegative integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    credentials = commands.add_parser("credentials", help="check credential file metadata only")
    credentials.add_argument("--path", type=Path)
    credentials.set_defaults(check=check_credentials)
    units = commands.add_parser("units", help="check installed and loaded unit definitions")
    units.add_argument("--unit-dir", type=Path, default=Path("/etc/systemd/system"))
    units.add_argument("--owner-uid", type=nonnegative_id, default=0)
    units.add_argument("--owner-gid", type=nonnegative_id, default=0)
    units.set_defaults(check=check_units)
    args = parser.parse_args()
    if args.command == "credentials" and args.path is None:
        args.path = Path.home() / ".config/samba/nas.credentials"
    return args.check(args)


if __name__ == "__main__":
    sys.exit(main())
