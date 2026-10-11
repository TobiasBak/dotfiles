#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

def main():
    parser = argparse.ArgumentParser(description="Remove the retired workspace-view snapshot entry, preserving other Pi resources.")
    parser.add_argument("snapshot")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = Path.home() / ".pi/agent/settings.json"
    if not path.exists():
        return 0
    original = path.read_bytes()
    settings = json.loads(original)
    entries = settings.get("extensions", [])
    if not isinstance(entries, list) or not all(isinstance(entry, str) for entry in entries):
        raise ValueError("Pi extensions must be a list of strings")
    snapshot = Path(args.snapshot).expanduser().resolve()

    def retired(entry):
        if entry.startswith(("-", "!")):
            return False
        candidate = Path(entry.removeprefix("+")).expanduser()
        if not candidate.is_absolute():
            candidate = path.parent / candidate
        return candidate.resolve() == snapshot

    kept = [entry for entry in entries if not retired(entry)]
    if kept == entries:
        return 0
    if args.check:
        return 1
    settings["extensions"] = kept
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".settings.")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(settings, stream, indent=2)
            stream.write("\n")
        os.chmod(name, stat.S_IMODE(path.stat().st_mode))
        if path.read_bytes() != original:
            raise RuntimeError("Pi settings changed during validation; refusing to overwrite")
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f"workspace-view disable: {error}", file=sys.stderr)
        sys.exit(2)
