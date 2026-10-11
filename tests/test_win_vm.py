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
            for args in [("exec",), ("exec", "a", "b"), ("gui",), ("gui", "--wait"), ("gui", "--timeout", "2592000", "--wait", "app.exe"), ("uia",),
                         ("up", "--timeout", "0"), ("down", "--froce"),
                         ("run",), ("run", "--", "true"), ("run", "--ephemeral")]:
                with self.subTest(args=args):
                    result = subprocess.run(
                        [sys.executable, str(CLI), *args], env=env,
                        capture_output=True, text=True, timeout=5,
                    )
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(result.stdout, "")
            self.assertEqual(list(Path(home).iterdir()), [])

    def test_ephemeral_run_refuses_persistent_holder(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="win-vm-holder-", dir=scratch) as folder:
            home = Path(folder)
            bin_dir = home / "bin"
            bin_dir.mkdir()
            docker = bin_dir / "docker"
            docker.write_text("#!/bin/sh\nprintf 'running|2026-10-11T20:00:00Z|172.18.0.2|/persistent/storage\\n'\n")
            docker.chmod(0o755)
            ssh = bin_dir / "ssh"
            ssh.write_text("#!/bin/sh\nprintf ' console tb 1 Active\\n'\n")
            ssh.chmod(0o755)
            keys = home / ".keys"
            keys.mkdir()
            (keys / "windows-vm.env").write_text("WINDOWS_VM_USERNAME=tb\n")
            env = {**os.environ, "HOME": str(home), "PATH": str(bin_dir)}
            env.pop("WIN_VM_LEASE", None)
            marker = home / ".cache/win-vm/started-by-win-vm"
            marker.parent.mkdir(parents=True)
            for owned in (False, True):
                with self.subTest(owned=owned):
                    if owned:
                        marker.write_text("2026-10-11T20:00:00Z\n")
                    result = subprocess.run(
                        [sys.executable, str(CLI), "run", "--ephemeral", "--", "true"],
                        env=env, capture_output=True, text=True, timeout=5,
                    )
                    who = "win-vm up" if owned else "not win-vm (Tobias or an Omarchy launch)"
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(result.stderr, f"win-vm: persistent VM is running; refusing ephemeral run (holder: {who}, started 2026-10-11T20:00:00Z), session: console\n")
            ssh.write_text("#!/bin/sh\nexit 1\n")
            result = subprocess.run(
                [sys.executable, str(CLI), "run", "--ephemeral", "--", "true"],
                env=env, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(result.stderr, "win-vm: persistent VM is running; refusing ephemeral run (holder: win-vm up, started 2026-10-11T20:00:00Z)\n")
            self.assertFalse((home / ".local/state/win-vm/ephemeral").exists())
