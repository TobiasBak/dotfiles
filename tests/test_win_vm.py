import json
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
            ssh.write_text("#!/bin/sh\nprintf ' SESSIONNAME USERNAME ID STATE TYPE DEVICE\\n console tb 1 Active\\n'\n")
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

    def test_reboot_residue_recovers_or_names_cleanup(self):
        # A host reboot mid-run frees the lease lock but leaves the clone, its container and lease.json.
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="win-vm-reboot-", dir=scratch) as folder:
            home = Path(folder)
            fake = home / "fake"
            bin_dir = home / "bin"
            fake.mkdir()
            bin_dir.mkdir()
            (bin_dir / "docker").write_text(f"""#!/bin/sh
echo "docker $*" >> {fake}/calls
case "$1" in
  inspect) [ -f {fake}/container ] && exec /usr/bin/cat {fake}/container
           echo "Error: No such object: omarchy-windows" >&2; exit 1 ;;
  rm) [ -f {fake}/rm-fails ] && exit 1; exec /usr/bin/rm -f {fake}/container ;;
esac
exit 99
""")
            (bin_dir / "docker-compose").write_text(f"#!/bin/sh\necho \"docker-compose $*\" >> {fake}/calls\nexit 99\n")
            for tool in bin_dir.iterdir():
                tool.chmod(0o755)
            keys = home / ".keys"
            keys.mkdir()
            (keys / "windows-vm.env").write_text("WINDOWS_VM_USERNAME=tb\n")
            env = {**os.environ, "HOME": str(home), "PATH": str(bin_dir)}
            env.pop("WIN_VM_LEASE", None)
            state = home / ".local/state/win-vm"
            clone = state / "ephemeral"
            dead = subprocess.Popen(["/usr/bin/true"])
            dead.wait()

            def leave_residue(container):
                (clone / "storage").mkdir(parents=True, exist_ok=True)
                (clone / "storage/data.img").write_bytes(b"stale clone")
                (clone / "shared").mkdir(exist_ok=True)
                (state / "lease").touch()
                (state / "lease.json").write_text(
                    f'{{"pid": {dead.pid}, "guardian_pid": {dead.pid}, "command": ["lane"], '
                    f'"started_at": "2026-10-11T22:00:00+00:00", "token": "stale"}}\n')
                (fake / "container").write_text(f"{container}|2026-10-11T22:00:00Z||{clone}/storage\n")
                (fake / "calls").unlink(missing_ok=True)

            def win_vm(*args):
                return subprocess.run([sys.executable, str(CLI), *args], env=env,
                                      capture_output=True, text=True, timeout=10)

            recoveries = [
                (("status",), 0, None),
                (("exec", "hostname"), 1, "win-vm: Windows VM has no container IP; run win-vm up\n"),
                (("run", "--ephemeral", "--", "true"), 1, "win-vm: no pinned baseline; run win-vm baseline with the VM stopped\n"),
            ]
            for container in ("exited", "running"):
                for args, code, stderr in recoveries:
                    with self.subTest(container=container, args=args):
                        leave_residue(container)
                        result = win_vm(*args)
                        self.assertEqual(result.returncode, code, result.stderr)
                        if stderr is not None:
                            self.assertEqual(result.stderr, stderr)
                        calls = (fake / "calls").read_text()
                        self.assertIn("docker rm -f omarchy-windows", calls)
                        self.assertNotIn("docker-compose", calls)
                        self.assertFalse(clone.exists())
                        self.assertFalse((fake / "container").exists())
                        info = json.loads(win_vm("status").stdout)
                        self.assertEqual((info["container"], info["mode"], info["lease"]),
                                         ("absent", "persistent", None))

            # When cleanup itself fails, every command names the exact cleanup and boots nothing.
            (fake / "rm-fails").touch()
            for args in [("status",), ("exec", "hostname"), ("run", "--ephemeral", "--", "true")]:
                with self.subTest(cleanup_fails=args):
                    leave_residue("exited")
                    result = win_vm(*args)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn(f"clean up by hand: docker rm -f omarchy-windows; rm -rf {clone}", result.stderr)
                    self.assertNotIn("docker-compose", (fake / "calls").read_text())
                    self.assertTrue((clone / "storage/data.img").exists())
            # Once the blocker is gone, the next command recovers: nothing stays wedged.
            (fake / "rm-fails").unlink()
            self.assertEqual(win_vm("status").returncode, 0)
            self.assertFalse(clone.exists())
