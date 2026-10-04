"""Host lifecycle checks: tiny real QCOW2 images, stub services, no guest boot."""

import fcntl
import hashlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

SCRIPT = Path(__file__).resolve().parents[1] / "oip-windows-vm"
STUB = Path(__file__).with_name("vm_stub.py")


class VmLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="windows-vm-scratch-")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name) / "lab"
        self.home.mkdir()
        self.base = self.home / "base" / "windows-server-2025-desktop-base.qcow2"
        self.base.parent.mkdir()
        self.make_base()
        (self.base.parent / "sealed").touch()
        (self.home / "keys").mkdir()
        (self.home / "keys" / "id_ed25519").write_text("stub-only key")
        self.bin = Path(self.directory.name) / "bin"
        self.bin.mkdir()
        for name in ("ss", "qemu-system-x86_64", "systemd-run", "systemctl", "pc-workload", "socat", "ssh", "scp", "sleep"):
            wrapper = self.bin / name
            wrapper.write_text(f'#!/usr/bin/env bash\nexec python3 "{STUB}" {name} "$@"\n')
            wrapper.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "OIP_WINDOWS_VM_HOME": str(self.home),
            "OIP_WINDOWS_VM_NIX_SHELL": "deliberately-not-1",
        }
        self.addCleanup(self.cleanup_services)

    def make_base(self):
        subprocess.run(["qemu-img", "create", "-f", "qcow2", str(self.base), "1M"], check=True, capture_output=True)

    def cleanup_services(self):
        for pid_file in self.home.glob("**/qemu.pid"):
            try:
                os.kill(int(pid_file.read_text()), signal.SIGTERM)
            except (ProcessLookupError, ValueError):
                pass
        for pid_file in self.home.glob("*.supervisor"):
            try:
                os.kill(int(pid_file.read_text()), signal.SIGTERM)
            except (ProcessLookupError, ValueError):
                pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if all(p.read_text() == "inactive" for p in self.home.glob("*.state")):
                return
            time.sleep(0.02)
        self.fail("Stub service did not finish during cleanup")

    def run_cli(self, *arguments, **kwargs):
        return subprocess.run(["bash", str(SCRIPT), *arguments], env=self.environment, capture_output=True, text=True, timeout=15, **kwargs)

    def popen_cli(self, *arguments):
        process = subprocess.Popen(["bash", str(SCRIPT), *arguments], env=self.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        return process

    def ok(self, *arguments):
        result = self.run_cli(*arguments)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def wait_for(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail("Stub lifetime condition did not arrive")

    @property
    def runtime(self):
        return self.home / "vms" / "first" / "runtime"

    def start(self):
        self.ok("clone-create", "first")
        self.ok("start", "first")

    def test_second_vm_budget_and_explicit_replacement(self):
        self.ok("clone-create", "first")
        rejected = self.run_cli("clone-create", "second")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("test VM budget: limit=1, requested=2, existing: first", rejected.stderr)
        self.assertIn("reuse it or stop+destroy", rejected.stderr)
        self.assertIn("second", rejected.stderr)
        self.assertFalse((self.home / "vms" / "second").exists())
        self.ok("destroy", "first")
        self.assertTrue(self.base.is_file())
        self.ok("clone-create", "second")

    def test_concurrent_creates_leave_one_valid_clone(self):
        barrier = Barrier(2)

        def create(name):
            barrier.wait(timeout=5)
            return self.run_cli("clone-create", name)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(create, ["first", "second"]))
        self.assertEqual(sum(r.returncode == 0 for r in results), 1)
        clones = list((self.home / "vms").iterdir())
        self.assertEqual(len(clones), 1)
        subprocess.run(["qemu-img", "check", str(clones[0] / "disk.qcow2")], check=True, capture_output=True)
        self.assertIn("limit=1, requested=2", next(r.stderr for r in results if r.returncode))

    def test_failed_create_cleans_partial_directory(self):
        self.base.unlink()
        failed = self.run_cli("clone-create", "failed")
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(list((self.home / "vms").iterdir()), [])
        self.make_base()
        self.ok("clone-create", "first")

    def test_grown_clone_is_cow_and_preserves_sealed_base(self):
        subprocess.run(["qemu-io", "-f", "qcow2", "-c", "write -P 17 0 4k", str(self.base)], check=True, capture_output=True)
        self.base.chmod(0o444)
        before = hashlib.sha256(self.base.read_bytes()).hexdigest()
        self.ok("clone-create", "first", "2M")
        disk = self.home / "vms" / "first" / "disk.qcow2"
        info = json.loads(subprocess.check_output(["qemu-img", "info", "--output=json", str(disk)]))
        self.assertEqual(info["virtual-size"], 2 * 1024 * 1024)
        self.assertEqual(info["full-backing-filename"], str(self.base))
        subprocess.run(["qemu-io", "-f", "qcow2", "-c", "read -P 17 0 4k", "-c", "write -P 85 0 4k", str(disk)], check=True, capture_output=True)
        subprocess.run(["qemu-io", "-r", "-f", "qcow2", "-c", "read -P 17 0 4k", str(self.base)], check=True, capture_output=True)
        self.assertEqual(hashlib.sha256(self.base.read_bytes()).hexdigest(), before)
        self.assertEqual(self.base.stat().st_mode & 0o777, 0o444)
        self.assertIn("limit=1, requested=2", self.run_cli("clone-create", "second", "4M").stderr)

    def test_shrink_invalid_size_and_failed_resize_leave_no_partial_clone(self):
        for size in ("512K", "+1M", "--shrink", "bogus"):
            with self.subTest(size=size):
                failed = self.run_cli("clone-create", "failed", size)
                self.assertNotEqual(failed.returncode, 0)
                self.assertFalse((self.home / "vms" / "failed").exists())
        qemu_img = shutil.which("qemu-img")
        wrapper = self.bin / "qemu-img"
        wrapper.write_text(f'#!/usr/bin/env bash\nif [[ "$1" == resize ]]; then exit 23; fi\nexec "{qemu_img}" "$@"\n')
        wrapper.chmod(0o755)
        failed = self.run_cli("clone-create", "failed", "2M")
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("Cannot grow clone", failed.stderr)
        self.assertFalse((self.home / "vms" / "failed").exists())
        wrapper.unlink()
        self.ok("clone-create", "first")
        info = json.loads(subprocess.check_output(["qemu-img", "info", "--output=json", str(self.home / "vms" / "first" / "disk.qcow2")]))
        self.assertEqual(info["virtual-size"], 1024 * 1024)

    def test_public_scp_routes_clone_key_port_knownhosts_and_paths(self):
        self.start()
        source = Path(self.directory.name) / "payload file.txt"
        source.write_text("test upload")
        guest = "C:/ProgramData/qualification artifacts/payload.txt"
        self.ok("upload", "first", str(source), guest)
        upload = json.loads((self.home / "scp.json").read_text())
        destination = Path(self.directory.name) / "evidence file.json"
        self.ok("download", "first", guest, str(destination))
        download = json.loads((self.home / "scp.json").read_text())
        self.assertEqual(destination.read_bytes(), b"stub downloaded evidence")
        for invocation in (upload, download):
            self.assertEqual(invocation[invocation.index("-i") + 1], str(self.home / "keys" / "id_ed25519"))
            self.assertEqual(invocation[invocation.index("-P") + 1], "2223")
            self.assertIn(f"UserKnownHostsFile={self.runtime}/known_hosts", invocation)
            self.assertIn("IdentitiesOnly=yes", invocation)
            self.assertIn("BatchMode=yes", invocation)
        self.assertEqual(upload[-3:], ["--", str(source), f"Administrator@127.0.0.1:{guest}"])
        self.assertEqual(download[-3:], ["--", f"Administrator@127.0.0.1:{guest}", str(destination)])
        (self.home / "scp-failed").touch()
        self.assertIn("Upload failed for first", self.run_cli("upload", "first", str(source), guest).stderr)
        self.assertIn("Download failed for first", self.run_cli("download", "first", guest, str(destination)).stderr)
        self.assertIn("readable file", self.run_cli("upload", "first", str(source) + ".absent", guest).stderr)
        self.ok("stop", "first")
        self.assertIn("not running", self.run_cli("download", "first", guest, str(destination)).stderr)

    def desktop_ready(self, policy=None):
        (self.base.parent / "administrator-password.txt").write_text("scratch-ONLY-secret!\n")
        if policy:
            (self.home / "desktop-policy.json").write_text(json.dumps(policy))
        return self.run_cli("desktop-ready", "first", "--boot-timeout", "2", "--restart-timeout", "1", "--command-timeout", "1", "--cleanup-timeout", "1")

    def test_desktop_readiness_restarts_once_and_clears_temporary_credentials(self):
        self.start()
        before = hashlib.sha256(self.base.read_bytes()).hexdigest()
        result = self.desktop_ready()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        diagnostic = json.loads((self.runtime / "desktop-ready.json").read_text())
        model = json.loads((self.home / "desktop-model.json").read_text())
        self.assertEqual(diagnostic["state"], "ready")
        self.assertTrue(diagnostic["credentialsCleared"])
        self.assertEqual(model["prepared"], 1)
        self.assertFalse(model["credentials"])
        self.assertEqual(model["passwordSha256"], hashlib.sha256(b"scratch-ONLY-secret!").hexdigest())
        self.assertEqual(hashlib.sha256(self.base.read_bytes()).hexdigest(), before)
        ssh = json.loads((self.home / "ssh.json").read_text())
        self.assertEqual(ssh[ssh.index("-p") + 1], "2223")
        self.assertIn(f"UserKnownHostsFile={self.runtime}/known_hosts", ssh)
        for text in (result.stdout, result.stderr, (self.runtime / "desktop-ready.json").read_text(), (self.home / "ssh.json").read_text()):
            self.assertNotIn("scratch-ONLY-secret!", text)

    def test_desktop_readiness_rejects_locked_explorer_and_missing_restart(self):
        self.start()
        for policy in ({"locked": True}, {"noRestart": True}):
            with self.subTest(policy=policy):
                (self.home / "desktop-model.json").unlink(missing_ok=True)
                result = self.desktop_ready(policy)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("restart deadline exceeded: limit=1s", result.stderr)
                diagnostic = json.loads((self.runtime / "desktop-ready.json").read_text())
                self.assertEqual(diagnostic["state"], "failed")
                self.assertTrue(diagnostic["credentialsCleared"])
                self.assertFalse(json.loads((self.home / "desktop-model.json").read_text())["credentials"])

    def test_missing_bootstrap_is_observational_and_not_fabricated(self):
        self.start()
        result = self.desktop_ready({"missingBootstrap": True})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        diagnostic = json.loads((self.runtime / "desktop-ready.json").read_text())
        self.assertEqual(diagnostic["state"], "ready")
        self.assertTrue(all(observation["provisionReady"] is False for observation in diagnostic["observations"]))

    def test_uncleared_credentials_fail_readiness(self):
        self.start()
        result = self.desktop_ready({"cleanupFails": True})
        self.assertNotEqual(result.returncode, 0)
        diagnostic = json.loads((self.runtime / "desktop-ready.json").read_text())
        self.assertEqual(diagnostic["state"], "failed")
        self.assertIn("credential removal", result.stderr)
        self.assertFalse(diagnostic["credentialsCleared"])

    def test_desktop_boot_and_cleanup_are_bounded_even_with_hung_ssh(self):
        self.start()
        started = time.monotonic()
        result = self.desktop_ready({"hang": True})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("boot deadline exceeded: limit=2s", result.stderr)
        self.assertLess(time.monotonic() - started, 5)
        diagnostic = json.loads((self.runtime / "desktop-ready.json").read_text())
        self.assertEqual(diagnostic["state"], "failed")
        self.assertFalse(diagnostic["credentialsCleared"])

    def test_start_checks_old_home_budget(self):
        self.ok("clone-create", "first")
        shutil.copytree(self.home / "vms" / "first", self.home / "vms" / "second")
        rejected = self.run_cli("start", "first")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("limit=1, requested=2, existing: first second", rejected.stderr)
        self.assertFalse((self.home / "systemd-run.json").exists())

    def test_start_and_destroy_share_lock_without_service_inheriting_it(self):
        self.ok("clone-create", "first")
        (self.home / "hold-start").touch()
        starting = self.popen_cli("start", "first")
        self.wait_for(lambda: (self.home / "entered-start").exists())
        destroying = self.popen_cli("destroy", "first")
        time.sleep(0.1)
        self.assertIsNone(destroying.poll())
        (self.home / "hold-start").unlink()
        stdout, stderr = starting.communicate(timeout=5)
        self.assertEqual(starting.returncode, 0, stdout + stderr)
        stdout, stderr = destroying.communicate(timeout=5)
        self.assertNotEqual(destroying.returncode, 0, stdout + stderr)
        self.assertIn("process and service", stderr)
        self.ok("stop", "first")
        self.ok("destroy", "first")

    def test_create_obeys_persisted_lifecycle_lock(self):
        with (self.home / "clone.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            creating = self.popen_cli("clone-create", "first")
            time.sleep(0.1)
            self.assertIsNone(creating.poll())
            self.assertFalse((self.home / "vms" / "first").exists())
            fcntl.flock(lock, fcntl.LOCK_UN)
            stdout, stderr = creating.communicate(timeout=5)
            self.assertEqual(creating.returncode, 0, stdout + stderr)

    def test_foreground_service_lifetime_and_explicit_guest_queries(self):
        self.start()
        launch = json.loads((self.home / "systemd-run.json").read_text())
        self.assertIn("--service-type=exec", launch)
        self.assertIn(f"--working-directory={self.runtime}", launch)
        self.assertIn(f"--setenv=PATH={self.environment['PATH']}", launch)
        self.assertIn("--property=KillMode=mixed", launch)
        qemu = json.loads((self.home / "qemu.json").read_text())
        self.assertNotIn("-daemonize", qemu)
        self.assertIn("format=qcow2,media=disk,if=ide", " ".join(qemu))
        self.assertEqual(json.loads((self.home / "workload.json").read_text())[0], "--")
        unit = (self.runtime / "service.unit").read_text().strip()
        self.assertEqual((self.home / f"{unit}.state").read_text(), "active")
        status = self.ok("status", "first").stdout
        self.assertIn(f"pid={(self.runtime / 'qemu.pid').read_text()}", status)
        self.assertIn(f"service: {unit} state=active main-pid=", status)
        self.assertFalse((self.home / "ssh.json").exists())
        self.ok("ssh", "first", "cmd.exe", "/c", "echo hello")
        ssh = json.loads((self.home / "ssh.json").read_text())
        self.assertEqual(ssh[-4:], ["Administrator@127.0.0.1", "cmd.exe", "/c", "echo hello"])
        self.ok("guest-users", "first")
        self.assertIn("Win32_ComputerSystem", (self.home / "ssh.json").read_text())
        self.ok("stop", "first")
        self.assertEqual((self.home / f"{unit}.state").read_text(), "inactive")

    def test_service_sigterm_waits_for_sibling_qemu_scope(self):
        self.start()
        unit = (self.runtime / "service.unit").read_text().strip()
        supervisor = int((self.home / f"{unit}.supervisor").read_text())
        os.kill(supervisor, signal.SIGTERM)
        self.wait_for(lambda: (self.home / f"{unit}.state").read_text() == "inactive")
        self.assertIn("is stopped", self.ok("status", "first").stdout)
        self.assertTrue((self.home / "qemu-exited").exists())
        self.ok("destroy", "first")

    def test_service_sigterm_during_start_does_not_orphan_qemu(self):
        self.ok("clone-create", "first")
        (self.home / "hold-start").touch()
        starting = self.popen_cli("start", "first")
        self.wait_for(lambda: (self.home / "entered-start").exists())
        unit = (self.runtime / "service.unit").read_text().strip()
        supervisor = int((self.home / f"{unit}.supervisor").read_text())
        os.kill(supervisor, signal.SIGTERM)
        (self.home / "hold-start").unlink()
        starting.communicate(timeout=5)
        self.wait_for(lambda: (self.home / f"{unit}.state").read_text() == "inactive")
        self.assertTrue((self.home / "qemu-exited").exists())
        self.ok("destroy", "first")

    def test_bounded_stop_preserves_running_vm_and_reports_unit_errors(self):
        self.start()
        (self.home / "ignore-powerdown").touch()
        (self.home / "fast-wait").touch()
        failed = self.run_cli("stop", "first")
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("Shutdown timed out after 120 seconds", failed.stderr)
        self.assertNotEqual(self.run_cli("destroy", "first").returncode, 0)
        self.assertTrue((self.home / "vms" / "first" / "disk.qcow2").exists())
        (self.home / "ignore-powerdown").unlink()
        (self.home / "fast-wait").unlink()
        self.ok("stop", "first")
        (self.home / "unit-query-failed").touch()
        rejected = self.run_cli("destroy", "first")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Cannot inspect VM unit", rejected.stderr)
        (self.home / "unit-query-failed").unlink()

    def test_stopped_pid_is_not_enough_while_service_or_scope_remains(self):
        self.start()
        self.ok("stop", "first")
        (self.home / "fast-wait").touch()
        service = (self.runtime / "service.unit").read_text().strip()
        scope = "pc-workload-test.scope"
        (self.runtime / "scope.unit").write_text(scope)
        (self.home / f"{scope}.state").write_text("inactive")
        for unit in (service, scope):
            with self.subTest(unit=unit):
                state = self.home / f"{unit}.state"
                state.write_text("active")
                self.assertIn("not stopped", self.ok("status", "first").stdout)
                failed = self.run_cli("stop", "first")
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn("service/scope remains active", failed.stderr)
                self.assertNotEqual(self.run_cli("destroy", "first").returncode, 0)
                state.write_text("inactive")
        self.ok("destroy", "first")

    def test_help_paths_and_status_do_not_create_home(self):
        missing = Path(self.directory.name) / "missing"
        self.environment["OIP_WINDOWS_VM_HOME"] = str(missing)
        for arguments in (("--help",), ("paths",), ("base-status",)):
            self.ok(*arguments)
            self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
