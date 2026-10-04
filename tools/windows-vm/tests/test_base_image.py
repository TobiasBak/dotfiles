import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "base_image.py"
spec = importlib.util.spec_from_file_location("base_image", SCRIPT)
base_image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base_image)


class BaseImageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="base-image-scratch-")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.image = base_image.BaseImage(self.home)
        self.image.base.mkdir()
        subprocess.run(["qemu-img", "create", "-f", "qcow2", str(self.image.disk), "4M"], check=True, capture_output=True)
        subprocess.run(["qemu-io", "-c", "write -P 17 0 64k", str(self.image.disk)], check=True, capture_output=True)
        self.image.disk.chmod(0o444)
        (self.image.base / "sealed").write_text("original marker")
        self.clone = self.home / "vms" / "prepare"
        self.clone.mkdir(parents=True)
        subprocess.run(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(self.image.disk), str(self.clone / "disk.qcow2")], check=True, capture_output=True)
        subprocess.run(["qemu-io", "-c", "write -P 34 64k 64k", str(self.clone / "disk.qcow2")], check=True, capture_output=True)
        self.identity = self.home / "qualification.json"
        self.value = {
            "recipeSha256": "a" * 64,
            "tools": {"git": "2.55.0", "msvc": "14.44"},
            "windows": {"productName": "Windows Server Evaluation", "build": "26100", "isEvaluation": True, "evaluationExpiresAt": (datetime.now(timezone.utc) + timedelta(days=60)).isoformat()},
        }
        self.identity.write_text(json.dumps(self.value))

    def promote(self):
        return self.image.promote("prepare", self.identity)

    def read_pattern(self, path, pattern, offset):
        subprocess.run(["qemu-io", "-r", "-c", f"read -P {pattern} {offset} 64k", str(path)], check=True, capture_output=True)

    def test_flatten_retains_old_base_until_explicit_confirmation(self):
        old_inode = self.image.disk.stat().st_ino
        result = self.promote()
        self.assertFalse(self.clone.exists())
        self.assertEqual((self.image.previous / base_image.BASE_NAME).stat().st_ino, old_inode)
        self.assertEqual(self.image.info()["identity"]["recipeSha256"], "a" * 64)
        details = base_image.qemu_json("info", "--output=json", str(self.image.disk))
        self.assertNotIn("backing-filename", details)
        self.read_pattern(self.image.disk, 17, 0)
        self.read_pattern(self.image.disk, 34, "64k")
        self.assertGreater(result["identity"]["promotionDiskBudget"]["flattenRequiredBytes"], 0)
        self.image.confirm()
        self.assertFalse(self.image.previous.exists())
        self.read_pattern(self.image.disk, 34, "64k")

    def test_rollback_restores_original_without_preexisting_identity(self):
        self.promote()
        self.image.rollback()
        self.assertEqual((self.image.base / "sealed").read_text(), "original marker")
        self.assertIsNone(self.image.info()["identity"])
        self.read_pattern(self.image.disk, 17, 0)
        self.read_pattern(self.image.disk, 0, "64k")

    def test_disk_budget_failure_keeps_original_and_preparation_clone(self):
        old_inode = self.image.disk.stat().st_ino
        usage = type("Usage", (), {"free": 1})()
        with patch.object(base_image.shutil, "disk_usage", return_value=usage):
            with self.assertRaisesRegex(ValueError, "available=1 bytes, flattenRequired=.*retainedOldAllocated="):
                self.promote()
        self.assertEqual(self.image.disk.stat().st_ino, old_inode)
        self.assertTrue(self.clone.exists())
        self.assertFalse(self.image.previous.exists())

    def test_expired_evaluation_rejected_and_near_expiry_warned(self):
        self.value["windows"]["evaluationExpiresAt"] = "2000-01-01T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "Windows evaluation expired: expiry=2000"):
            base_image.validate_identity(self.value)
        self.value["windows"]["evaluationExpiresAt"] = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            base_image.validate_identity(self.value)
        self.assertIn("Windows evaluation expires", output.getvalue())
        self.value["windows"]["evaluationExpiresAt"] = None
        with self.assertRaisesRegex(ValueError, "must report"):
            base_image.validate_identity(self.value)

    def test_interrupted_promotion_fails_info_and_can_rollback(self):
        original_save = base_image.save

        def interrupted(path, value):
            if path == self.image.identity:
                raise OSError("simulated interruption after image swap")
            original_save(path, value)

        with patch.object(base_image, "save", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "simulated interruption"):
                self.promote()
        with self.assertRaisesRegex(ValueError, "Interrupted base transaction"):
            self.image.info()
        self.image.rollback()
        self.read_pattern(self.image.disk, 17, 0)
        self.assertIsNone(self.image.info()["identity"])

    def test_interrupted_rollback_is_retryable_and_never_exposes_stale_identity(self):
        self.promote()
        original_replace = Path.replace

        def interrupted(path, destination):
            result = original_replace(path, destination)
            if path.name == "rollback.qcow2":
                raise OSError("simulated interruption after rollback image swap")
            return result

        with patch.object(Path, "replace", interrupted):
            with self.assertRaisesRegex(OSError, "simulated interruption"):
                self.image.rollback()
        with self.assertRaisesRegex(ValueError, "Interrupted base transaction"):
            self.image.info()
        self.image.rollback()
        self.assertIsNone(self.image.info()["identity"])
        self.read_pattern(self.image.disk, 0, "64k")

    def test_process_exit_during_retention_can_abort_without_filesystem_surgery(self):
        program = f'''import sys, os
sys.path.insert(0, {str(SCRIPT.parent)!r})
import base_image
from pathlib import Path
original_link = base_image.os.link
def interrupted(source, destination):
    original_link(source, destination)
    os._exit(7)
base_image.os.link = interrupted
base_image.BaseImage(Path({str(self.home)!r})).promote("prepare", Path({str(self.identity)!r}))
'''
        result = subprocess.run([sys.executable, "-c", program], capture_output=True)
        self.assertEqual(result.returncode, 7, result.stderr)
        with self.assertRaisesRegex(ValueError, "Interrupted base transaction"):
            self.image.info()
        shutil.rmtree(self.clone)
        self.image.rollback()
        self.assertIsNone(self.image.info()["identity"])
        self.assertFalse(self.image.previous.exists())
        self.read_pattern(self.image.disk, 17, 0)

    def test_invalid_tool_versions_do_not_promote(self):
        self.value["tools"] = {"git": None, "msvc": ""}
        self.identity.write_text(json.dumps(self.value))
        with self.assertRaisesRegex(ValueError, "nonempty tool names and installed version strings"):
            self.promote()
        self.assertTrue(self.clone.exists())
        self.assertFalse(self.image.previous.exists())

    def test_confirm_and_rollback_refuse_existing_clone(self):
        self.promote()
        (self.home / "vms" / "held").mkdir()
        for operation in (self.image.confirm, self.image.rollback):
            with self.assertRaisesRegex(ValueError, "existing: held"):
                operation()
        self.assertTrue(self.image.previous.exists())


if __name__ == "__main__":
    unittest.main()
