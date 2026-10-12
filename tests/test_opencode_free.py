import copy
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "agents/opencode-free/opencode-free"
FAKE_COMMAND = """#!PYTHON
import json
import os
from pathlib import Path
import sys

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
action = args[1] if tool == "gh" else "notify"
record = {"tool": tool, "args": args, "action": action}
if "--body-file" in args:
    record["body"] = Path(args[args.index("--body-file") + 1]).read_text()
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps(record) + "\\n")
if os.environ.get("FAKE_FAIL") == action:
    sys.exit(1)
issue = Path(os.environ["FAKE_ISSUE"])
if tool == "gh" and action == "list":
    print('[{"number": 7}]' if issue.exists() else '[]')
elif tool == "gh" and action == "create":
    issue.touch()
    print("https://github.com/TobiasBak/dotfiles/issues/7")
"""


class OpenCodeFreeTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="opencode-free-test-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.fixture = self.root / "fixture"
        self.fixture.mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for tool in ("gh", "notify-send"):
            path = bin_dir / tool
            path.write_text(FAKE_COMMAND.replace("#!PYTHON", f"#!{sys.executable}"))
            path.chmod(0o755)
        self.log = self.root / "calls.jsonl"
        self.env = {**os.environ, "HOME": str(self.root), "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "OPENCODE_FREE_STATE": str(self.state),
                    "OPENCODE_FREE_AA_KEY_FILE": str(self.root / "missing-key"),
                    "FAKE_LOG": str(self.log), "FAKE_ISSUE": str(self.root / "issue")}
        self.env.pop("FAKE_FAIL", None)
        self.catalog = {
            "opencode": {"models": {
                "step-5-preview-free": {"name": "Step 5 Preview Free", "cost": {"input": 0, "output": 0}},
                "deprecated-free": {"name": "Deprecated Free", "status": "deprecated", "cost": {"input": 0, "output": 0}},
                "shared": {"name": "Example Reasoner", "cost": {"input": 0, "output": 0}},
                "paid": {"name": "Next Model", "cost": {"input": 1, "output": 1}},
                "stale": {"name": "Stale Model", "cost": {"input": 0, "output": 0}},
                "claude-opus-5-5": {"name": "Claude Opus 5.5"},
                "gpt-6.1-sol": {"name": "GPT 6.1 Sol"},
                "claude-haiku-5-5": {"name": "Claude Haiku 5.5"},
            }},
            "opencode-go": {"models": {
                "shared": {"name": "Wrong Go Name", "cost": {"input": 3, "output": 3}},
                "paid": {"name": "Next Model", "cost": {"input": 1, "output": 1}},
            }},
        }
        self.zen = {"data": [{"id": model_id} for model_id in ("step-5-preview-free", "shared", "paid", "mystery-free", "deprecated-free")]}
        self.go = {"data": [{"id": "shared"}, {"id": "paid"}]}
        self.aa = {"data": [
            {"slug": "step-5-preview", "name": "Step 5 Preview", "evaluations": {
                "artificial_analysis_intelligence_index": 45, "artificial_analysis_coding_index": 40.24},
             "pricing": {"price_1m_blended_3_to_1": 0.3}, "median_output_tokens_per_second": 99.6},
            {"slug": "different-slug", "name": "Example Reasoner (medium effort)", "evaluations": {
                "artificial_analysis_intelligence_index": 41, "artificial_analysis_coding_index": 39},
             "pricing": {"price_1m_blended_3_to_1": 0.12}, "median_output_tokens_per_second": 80},
            {"slug": "another-slug", "name": "Example Reasoner (low effort)", "evaluations": {
                "artificial_analysis_intelligence_index": 10}},
            {"slug": "opus", "name": "Claude Opus 5.5", "evaluations": {
                "artificial_analysis_intelligence_index": 50}},
            {"slug": "gpt-6.1-sol", "name": "GPT 6.1 Sol", "evaluations": {
                "artificial_analysis_intelligence_index": 46}},
            {"slug": "claude-haiku-5-5", "name": "Claude Haiku 5.5", "evaluations": {
                "artificial_analysis_intelligence_index": 20}},
        ]}
        self.write_fixture()

    def write_fixture(self):
        for name, value in (("zen.json", self.zen), ("go.json", self.go),
                            ("models.dev.json", self.catalog), ("aa.json", self.aa)):
            (self.fixture / name).write_text(json.dumps(value))

    def cli(self, *args, code=0):
        result = subprocess.run([sys.executable, str(CLI), *args], env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def run_fixture(self, *args, code=0):
        return self.cli("run", "--fixture", str(self.fixture), *args, code=code)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def saved_state(self):
        return json.loads((self.state / "state.json").read_text())

    def events(self):
        return self.saved_state()["history"]

    def change_free_set(self):
        self.catalog["opencode"]["models"]["shared"]["cost"] = {"input": 0, "output": 1}
        self.catalog["opencode"]["models"]["paid"]["cost"] = {"input": 0, "output": 0}
        self.write_fixture()

    def test_baseline_changes_and_idempotent_publication(self):
        self.assertIn("run opencode-free run", self.cli(code=1).stderr)
        self.assertFalse(self.state.exists())
        self.run_fixture()
        self.assertEqual({path.name for path in self.state.iterdir()}, {"state.json", "lock", "published.md"})
        snapshot = self.saved_state()["snapshot"]
        self.assertEqual(snapshot["models"]["shared"]["plans"], ["go", "zen"])
        self.assertEqual(snapshot["models"]["shared"]["free_on"], ["zen"])
        self.assertEqual(snapshot["models"]["shared"]["name"], "Example Reasoner")
        self.assertEqual(snapshot["models"]["mystery-free"]["free_on"], [])
        self.assertEqual(snapshot["models"]["deprecated-free"]["free_on"], [])
        self.assertNotIn("stale", snapshot["models"])
        self.assertEqual([event["event"] for event in self.events()], ["first_seen_free"] * 2)
        table = self.cli("table").stdout
        self.assertEqual(self.cli().stdout, table)
        self.assertIn("[Artificial Analysis](https://artificialanalysis.ai/)", table)
        self.assertIn("| Step 5 Preview Free | step-5-preview-free | zen (free) | ≤ ", table)
        self.assertIn("| 45.0 | 40.2 | 100 | 0.30 | GPT 6.1 Sol (46.0) |", table)
        self.assertIn("| Example Reasoner | shared | go, zen (free) | ≤ ", table)
        self.assertIn("| 41.0 | 39.0 | 80 | 0.12 | GPT 6.1 Sol (46.0) |", table)
        self.assertNotIn("mystery-free", table)
        self.assertNotIn("Deprecated Free", table)
        self.assertNotIn("Next Model", table)
        self.assertLess(table.index("step-5-preview-free"), table.index("| shared |"))
        self.assertEqual([call["action"] for call in self.calls()], ["list", "create"])
        self.assertEqual(self.calls()[1]["body"], table)
        self.assertEqual((self.state / "published.md").read_text(), table)

        self.log.unlink()
        self.change_free_set()
        changed = self.run_fixture().stdout
        self.assertIn("newly_free: paid: Next Model", changed)
        self.assertIn("no_longer_free: shared: Example Reasoner", changed)
        calls = self.calls()
        self.assertEqual([call["action"] for call in calls], ["list", "edit", "notify", "comment"])
        lines = "Newly free: Next Model\nNo longer free: Example Reasoner"
        self.assertEqual(calls[2]["args"], ["OpenCode free models changed", lines])
        self.assertEqual(calls[3]["body"], lines + "\n\nTracker: https://github.com/TobiasBak/dotfiles/issues/7\n")
        self.assertIn("Free windows ended in the last 30 days", calls[1]["body"])
        history = self.cli("history").stdout
        today = snapshot["taken_at"][:10]
        self.assertIn(f"| Example Reasoner | shared | ≤ {today} | {today} |", history)
        self.assertIn(f"| Next Model | paid | {today} | ongoing |", history)
        self.assertEqual(self.saved_state()["pending"], [])

        self.log.unlink()
        published = (self.state / "published.md").read_text()
        self.assertEqual(self.run_fixture().stdout, "no changes\n")
        expected = ["list"] if self.cli("table").stdout == published else ["list", "edit"]
        self.assertEqual([call["action"] for call in self.calls()], expected)

    def test_failed_publication_retries_saved_changes(self):
        self.run_fixture()
        self.change_free_set()
        self.log.unlink()
        self.env["FAKE_FAIL"] = "edit"
        failed = self.run_fixture(code=1)
        self.assertIn("publish failed", failed.stderr)
        saved = self.saved_state()
        pending = saved["pending"]
        self.assertEqual([event["event"] for event in pending], ["newly_free", "no_longer_free"])
        self.assertEqual(saved["history"][-2:], pending)
        self.assertEqual(saved["snapshot"]["models"]["paid"]["free_on"], ["zen"])
        self.assertEqual(saved["snapshot"]["models"]["shared"]["free_on"], [])
        self.assertEqual([call["action"] for call in self.calls()], ["list", "edit"])
        self.env.pop("FAKE_FAIL")
        self.log.unlink()
        self.assertEqual(self.run_fixture().stdout, "no changes\n")
        self.assertEqual([call["action"] for call in self.calls()], ["list", "edit", "notify", "comment"])
        self.assertEqual(self.saved_state()["pending"], [])
        self.log.unlink()
        published = (self.state / "published.md").read_text()
        self.run_fixture()
        expected = ["list"] if self.cli("table").stdout == published else ["list", "edit"]
        self.assertEqual([call["action"] for call in self.calls()], expected)

        self.catalog["opencode"]["models"]["paid"]["cost"] = {"input": 1, "output": 1}
        self.write_fixture()
        self.env["FAKE_FAIL"] = "comment"
        self.run_fixture(code=1)
        self.assertEqual(len(self.saved_state()["pending"]), 1)
        self.env.pop("FAKE_FAIL")
        self.log.unlink()
        published = (self.state / "published.md").read_text()
        self.run_fixture()
        expected = ["list"] if self.cli("table").stdout == published else ["list", "edit"]
        self.assertEqual([call["action"] for call in self.calls()], expected + ["notify", "comment"])
        self.assertEqual(self.saved_state()["pending"], [])

    def test_critical_source_failure_preserves_all_state(self):
        self.run_fixture("--no-publish")
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        for filename in ("zen.json", "go.json", "models.dev.json"):
            with self.subTest(source=filename):
                path = self.fixture / filename
                content = path.read_bytes()
                path.unlink()
                self.assertIn("fetching", self.run_fixture("--no-publish", code=1).stderr)
                self.assertEqual({path.name: path.read_bytes() for path in self.state.iterdir()}, before)
                path.write_bytes(content)
        (self.fixture / "zen.json").write_text('{"unexpected": []}')
        self.run_fixture("--no-publish", code=1)
        self.assertEqual({path.name: path.read_bytes() for path in self.state.iterdir()}, before)
        self.assertEqual(self.calls(), [])

    def test_run_serializes_on_lock_without_blocking_readers(self):
        self.run_fixture("--no-publish")
        before = (self.state / "state.json").read_bytes()
        table = self.cli("table").stdout
        history = self.cli("history").stdout
        self.change_free_set()
        with (self.state / "lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            child = subprocess.Popen(
                [sys.executable, str(CLI), "run", "--fixture", str(self.fixture), "--no-publish"],
                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    child.communicate(timeout=0.5)
                self.assertEqual((self.state / "state.json").read_bytes(), before)
                self.assertEqual(self.cli("table").stdout, table)
                self.assertEqual(self.cli("history").stdout, history)
                fcntl.flock(lock, fcntl.LOCK_UN)
                stdout, stderr = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, stdout + stderr)
                self.assertIn("newly_free: paid", stdout)
                self.assertEqual(self.saved_state()["history"][-2:], self.saved_state()["pending"])
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate()
        self.assertEqual(self.run_fixture("--no-publish").stdout, "no changes\n")
        self.assertEqual(len(self.saved_state()["pending"]), 2)

    def test_scores_outages_and_removed_free_windows(self):
        self.run_fixture("--no-publish")
        self.aa["data"][0]["median_output_tokens_per_second"] = 123
        self.write_fixture()
        self.assertEqual(self.run_fixture("--no-publish").stdout, "no changes\n")
        self.aa["data"][0]["evaluations"]["artificial_analysis_intelligence_index"] = 47
        self.aa["data"][0]["evaluations"]["artificial_analysis_coding_index"] = 44
        self.aa["data"][0]["pricing"]["price_1m_blended_3_to_1"] = 0.5
        self.write_fixture()
        self.run_fixture("--no-publish")
        score = self.events()[-1]
        self.assertEqual(score["event"], "score_changed")
        self.assertEqual(score["detail"], "intelligence: 45→47; coding: 40.24→44; price: 0.3→0.5")
        before = copy.deepcopy(self.events())
        (self.fixture / "aa.json").unlink()
        self.assertEqual(self.run_fixture("--no-publish").stdout, "no changes\n")
        self.assertEqual(self.events(), before)
        table = self.cli("table").stdout
        self.assertIn("AA scores missing: missing in fixture.", table)
        self.assertIn("| — | — | — | — | — |", table)
        snapshot = self.saved_state()["snapshot"]
        self.assertTrue(all(model["aa"] is None for model in snapshot["models"].values()))
        self.write_fixture()
        self.assertEqual(self.run_fixture("--no-publish").stdout, "no changes\n")
        self.zen["data"] = [row for row in self.zen["data"] if row["id"] != "step-5-preview-free"]
        self.go["data"].append({"id": "new-free"})
        self.catalog["opencode-go"]["models"]["new-free"] = {"name": "New Free", "cost": {"input": 0, "output": 0}}
        self.write_fixture()
        changed = self.run_fixture("--no-publish").stdout
        self.assertIn("removed: step-5-preview-free", changed)
        self.assertIn("no_longer_free: step-5-preview-free", changed)
        self.assertIn("added: new-free", changed)
        self.assertIn("newly_free: new-free", changed)
        self.assertIn("| Step 5 Preview Free | step-5-preview-free | ≤ ", self.cli("history").stdout)
        self.assertIn("| New Free | new-free | go (free) |", self.cli("table").stdout)
        self.assertEqual(self.calls(), [])

        old_history = [event for event in self.events() if event["id"] != "new-free"]
        for event in old_history:
            event["at"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat(timespec="seconds")
        saved = self.saved_state()
        saved["history"] = old_history
        (self.state / "state.json").write_text(json.dumps(saved))
        self.assertNotIn("Free windows ended in the last 30 days", self.cli("table").stdout)
        self.assertIn("step-5-preview-free", self.cli("history").stdout)


if __name__ == "__main__":
    unittest.main()
