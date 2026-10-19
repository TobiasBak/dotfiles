import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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


FAKE_GH = '''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
path = Path(os.environ["FAKE_GH_STATE"])
state = json.loads(path.read_text())
args = sys.argv[1:]
if args[:2] == ["pr", "merge"]:
    state["pr"]["merged"] = True
    state["pr"]["state"] = "closed"
    state["pr"]["merge_commit_sha"] = "f" * 40
    result = None
else:
    assert args[0] == "api", args
    endpoint = next(value for value in args if value.startswith("repos/"))
    fields = dict(args[index + 1].split("=", 1) for index, value in enumerate(args) if value == "-f")
    prefix = "repos/example/project/"
    assert endpoint.startswith(prefix), endpoint
    route = endpoint[len(prefix):]
    if route == "pulls/12":
        result = state["pr"]
    elif route.startswith("git/ref/heads/"):
        result = {"object": {"type": "commit", "sha": state["base"]}}
    elif route.startswith("commits/"):
        sha = route.split("/")[1]
        result = [{"sha": sha, "statuses": list(state["statuses"].get(sha, {}).values())}]
    elif route == "pulls/12/reviews/34":
        result = state["review"]
    elif route == "issues/12/comments":
        result = {"body": fields["body"], "html_url": "https://github.com/example/project/pull/12#issuecomment-56", "issue_url": "https://api.github.com/repos/example/project/issues/12"}
        state["comment"] = result
    elif route == "issues/comments/56":
        result = state["comment"]
    elif route.startswith("statuses/"):
        sha = route.split("/")[1]
        result = {"id": state["next_id"], "description": None, **fields}
        state["next_id"] += 1
        state["statuses"].setdefault(sha, {})[fields["context"]] = result
    else:
        raise AssertionError(route)
path.write_text(json.dumps(state))
print(json.dumps(result))
'''


class CleanRebaseCarryTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".cache/agent-tmp/pr-merge-carry-tests"
        scratch.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repository = self.root / "repo"
        self.repository.mkdir()
        self.home = self.root / "home"
        self.home.mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.state_path = self.root / "state.json"
        self.env = {**os.environ, "HOME": str(self.home), "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_GH_STATE": str(self.state_path), "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Synthetic carry", "GIT_AUTHOR_EMAIL": "carry@example.invalid", "GIT_COMMITTER_NAME": "Synthetic carry", "GIT_COMMITTER_EMAIL": "carry@example.invalid"}
        for name in tuple(self.env):
            if name.startswith("GIT_") and name not in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
                del self.env[name]
        self.git("init", "--initial-branch=main")
        self.put(".github/merge-gate.toml", "protected = ['src/*']\ntests = ['tests/*']\n")
        self.put("src/value.py", "VALUE = 1\n")
        self.put("other.txt", "base\n")
        self.commit("base")
        self.base = self.git("rev-parse", "HEAD")
        self.git("switch", "-c", "original")
        self.put("src/value.py", "VALUE = 2\n")
        self.commit("change value")
        self.source = self.git("rev-parse", "HEAD")
        self.advance("other.txt", "new base\n")
        self.env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": f"url.{self.repository}.insteadOf", "GIT_CONFIG_VALUE_0": f"https://github.com/{REPO}.git"})

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.repository), *args], env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def put(self, name, value):
        path = self.repository / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)

    def advance(self, name, content):
        self.git("switch", "main")
        self.git("reset", "--hard", self.base)
        self.put(name, content)
        self.commit("advance main")
        new_base = self.git("rev-parse", "HEAD")
        self.git("switch", "-C", "rebased")
        if name == "src/value.py":
            self.put(name, "VALUE = 2\n")
            self.commit("change value")
        else:
            self.git("cherry-pick", self.source)
        head = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/pull/12/head", head)
        statuses = {context: {"id": index, "context": context, "state": "success", "description": None, "target_url": REVIEW_URL if context == "review" else "https://github.com/example/project/pull/12#issuecomment-20"} for index, context in enumerate(PR_MERGE.CONTEXTS, 1)}
        self.save({"base": new_base, "pr": {"head": {"sha": head}, "base": {"ref": "main", "repo": {"full_name": REPO}}, "body": "subagents: tasks=1 accepted=1 reworked=0 rejected=0 throttled=0", "state": "open", "merged": False}, "statuses": {self.source: statuses}, "review": {"commit_id": self.source, "body": "Protected surfaces\nsrc/value.py: authorized"}, "next_id": 10})

    def load(self):
        return json.loads(self.state_path.read_text())

    def save(self, state):
        self.state_path.write_text(json.dumps(state))

    def invoke(self, *args):
        return subprocess.run([sys.executable, str(CLI), *args], env=self.env, cwd=self.repository, capture_output=True, text=True, timeout=20)

    def carry(self):
        return self.invoke("carry", f"https://github.com/{REPO}/pull/12", "--from", self.source)

    def test_real_cli_carries_and_merge_reproduces_original_review(self):
        result = self.carry()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.load()
        head = state["pr"]["head"]["sha"]
        for context in PR_MERGE.CONTEXTS:
            carried = state["statuses"][head][context]
            self.assertEqual(carried["state"], "success")
            self.assertIn(self.source, carried["description"])
            self.assertIn("#issuecomment-56", carried["target_url"])
        proof = json.loads(state["comment"]["body"][len(PR_MERGE.CARRY_MARKER):-4])
        self.assertEqual(proof["oldBase"], self.base)
        self.assertEqual(proof["newBase"], state["base"])
        self.assertIn(" = ", proof["rangeDiff"])
        merged = self.invoke(f"https://github.com/{REPO}/pull/12")
        self.assertEqual(merged.returncode, 0, merged.stderr)
        self.assertEqual(merged.stdout.strip(), "f" * 40)

    def test_base_path_overlap_refuses_even_when_final_pr_content_matches(self):
        self.advance("src/value.py", "VALUE = 3\n")
        result = self.carry()
        self.assertEqual(result.returncode, 1)
        self.assertIn("advanced base touches PR paths", result.stderr)
        self.assertNotIn("comment", self.load())

    def test_changed_patch_refuses(self):
        self.put("src/value.py", "VALUE = 4\n")
        self.git("commit", "-am", "different patch")
        head = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/pull/12/head", head)
        state = self.load()
        state["pr"]["head"]["sha"] = head
        self.save(state)
        result = self.carry()
        self.assertEqual(result.returncode, 1)
        self.assertIn("range-diff is not entirely '='", result.stderr)

    def test_failed_source_and_recursive_carry_refuse(self):
        for field, value in (("state", "failure"), ("description", "Carried gate from somewhere")):
            state = self.load()
            state["statuses"][self.source]["gate"][field] = value
            self.save(state)
            result = self.carry()
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("comment", self.load())
            state["statuses"][self.source]["gate"][field] = "success" if field == "state" else None
            self.save(state)

    def test_merge_rejects_tampered_proof_and_changed_source_status(self):
        self.assertEqual(self.carry().returncode, 0)
        original = self.load()
        for mutation in ("proof", "status", "partial"):
            state = json.loads(json.dumps(original))
            if mutation == "proof":
                state["comment"]["body"] = state["comment"]["body"].replace(self.base, "0" * 40)
            elif mutation == "status":
                state["statuses"][self.source]["gate"]["state"] = "failure"
            else:
                state["statuses"][state["pr"]["head"]["sha"]]["review"]["description"] = None
            self.save(state)
            result = self.invoke(f"https://github.com/{REPO}/pull/12")
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertFalse(self.load()["pr"]["merged"])
            self.assertIn("carry:", result.stderr)


if __name__ == "__main__":
    unittest.main()
