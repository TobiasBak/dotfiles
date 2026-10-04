"""Run the real guest PowerShell script against isolated cmdlet/session doubles."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PWSH = shutil.which("pwsh")
HERE = Path(__file__).resolve().parent


@unittest.skipUnless(PWSH, "PowerShell is required for executable guest-script checks")
class DesktopGuestTests(unittest.TestCase):
    def test_disk_growth_console_unlock_and_credential_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="windows-vm-guest-scratch-") as scratch:
            result = subprocess.run(
                [PWSH, "-NoProfile", "-NonInteractive", "-File", str(HERE / "desktop_guest_stub.ps1"),
                 "-GuestScript", str(HERE.parent / "desktop-ready.ps1"), "-Scratch", scratch],
                input="scratch-ONLY-secret!", text=True, capture_output=True, timeout=15,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS:", result.stdout)
        self.assertNotIn("scratch-ONLY-secret!", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
