#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
import tempfile

path = Path.home() / ".claude/settings.json"
settings = json.loads(path.read_text()) if path.exists() else {}
models = settings.get("modelSettings", {})
if "--check" in sys.argv:
    sys.exit(int("claude-sonnet-5-5" in models))
if models.pop("claude-sonnet-5-5", None) is not None:
    mode = path.stat().st_mode & 0o777
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".settings.")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(settings, stream, indent=2)
            stream.write("\n")
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
