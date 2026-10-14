import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PiReportToCosTests(unittest.TestCase):
    def test_retargeting(self):
        with tempfile.TemporaryDirectory(prefix="pi-cos-test-") as home:
            result = subprocess.run(
                ["pi", "--no-extensions", "--no-skills", "--no-prompt-templates",
                 "--no-session", "--mode", "rpc", "--extension",
                 str(ROOT / "tests/pi_report_to_cos.ts")],
                cwd=home, input="", text=True, capture_output=True, timeout=60,
                env={**os.environ, "HOME": home, "PI_CODING_AGENT_DIR": home},
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS report-to-cos:", result.stdout, result.stdout + result.stderr)
