import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "agents/windows-vm/win-vm"


class WinVmTests(unittest.TestCase):
    def test_invalid_commands_fail_before_contacting_vm(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="win-vm-cli-", dir=scratch) as home:
            env = {**os.environ, "HOME": home, "PATH": "/nonexistent"}
            for args in [("exec",), ("exec", "a", "b"), ("gui",), ("uia",),
                         ("up", "--timeout", "0"), ("down", "--froce")]:
                with self.subTest(args=args):
                    result = subprocess.run(
                        [sys.executable, str(CLI), *args], env=env,
                        capture_output=True, text=True, timeout=5,
                    )
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(result.stdout, "")
            self.assertEqual(list(Path(home).iterdir()), [])
