import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


CLI = Path(__file__).resolve().parents[1] / "cli/pr-merge.py"
SPEC = importlib.util.spec_from_file_location("pr_merge", CLI)
PR_MERGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PR_MERGE
SPEC.loader.exec_module(PR_MERGE)
HEAD = "a" * 40
REPO = "example/project"
REVIEW_URL = f"https://github.com/{REPO}/pull/12#pullrequestreview-34"
PATHS = {"AGENTS.md", "tests/test_checkout.py"}


class ReviewAttestationTests(unittest.TestCase):
    def attest(self, flagged=PATHS, url=REVIEW_URL):
        return PR_MERGE.review_attestation(flagged, url, HEAD, REPO, 12)

    def test_named_paths_pass(self):
        review = {
            "commit_id": HEAD,
            "body": "Protected surfaces\nAGENTS.md: authorized\ntests/test_checkout.py: authorized",
        }
        with patch.object(PR_MERGE, "api", return_value=review) as api:
            self.assertEqual(self.attest(), [])
        api.assert_called_once_with(
            f"repos/{REPO}/pulls/12/reviews/34", "protected/tests review",
        )

    def test_missing_path_refuses_and_names_only_missing_paths(self):
        with patch.object(PR_MERGE, "api", return_value={"commit_id": HEAD, "body": "AGENTS.md"}):
            self.assertEqual(self.attest(), [
                'protected/tests review: body does not name "tests/test_checkout.py"',
            ])

    def test_commit_mismatch_refuses(self):
        with patch.object(PR_MERGE, "api", return_value={"commit_id": "b" * 40, "body": "\n".join(PATHS)}):
            failures = self.attest()
        self.assertEqual(len(failures), 1)
        self.assertIn("commit_id", failures[0])
        self.assertIn(f"does not match head {HEAD}", failures[0])

    def test_wrong_or_malformed_review_url_refuses_without_fetch(self):
        for url in [
            REVIEW_URL.replace("/pull/12", "/pull/13"),
            REVIEW_URL.replace(REPO, "other/project"),
            REVIEW_URL.replace("https:", "http:"),
            REVIEW_URL.replace("github.com/", "github.com.evil.example/"),
            REVIEW_URL.replace("#pullrequestreview-34", "#issuecomment-34"),
            REVIEW_URL + "?extra=1",
            None,
        ]:
            with self.subTest(url=url), patch.object(PR_MERGE, "api") as api:
                failures = self.attest(url=url)
                self.assertEqual(len(failures), 1)
                self.assertIn("target URL", failures[0])
                api.assert_not_called()

    def test_empty_flagged_set_needs_no_review(self):
        with patch.object(PR_MERGE, "api") as api:
            self.assertEqual(self.attest(flagged=set(), url=None), [])
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
