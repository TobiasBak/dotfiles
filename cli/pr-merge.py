#!/usr/bin/env python3
"""Post merge evidence or merge a PR after checking its exact head and base."""

import argparse
from dataclasses import dataclass
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import quote, urlsplit


SHA = re.compile(r"[0-9a-f]{40}\Z")
REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+\Z")
METRICS = re.compile(
    r"[ \t]*subagents: tasks=[0-9]+ accepted=[0-9]+ reworked=[0-9]+ "
    r"rejected=[0-9]+ throttled=[0-9]+[ \t]*"
)
CONFIG = ".github/merge-gate.toml"
CONTEXTS = ("gate", "review")


class Refusal(Exception):
    def __init__(self, *reasons):
        self.reasons = reasons


def one_line(value):
    return " ".join(str(value).splitlines())


def path_name(path):
    return json.dumps(path, ensure_ascii=True)


def run(command, check):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        detail = one_line(result.stderr.decode("utf-8", errors="replace").strip())
        raise Refusal(f"{check}: command failed" + (f": {detail}" if detail else ""))
    return result.stdout


def git(arguments, check, directory=None):
    command = ["git"]
    if directory is not None:
        command += ["-C", str(directory)]
    return run(command + arguments, check)


def gh_json(arguments, check):
    try:
        return json.loads(run(["gh", *arguments], check))
    except (ValueError, UnicodeError):
        raise Refusal(f"{check}: malformed GitHub JSON response") from None


def api(endpoint, check, paginate=False, fields=()):
    args = ["api", "--hostname", "github.com"]
    if paginate:
        args += ["--paginate", "--slurp"]
    args.append(endpoint)
    for key, value in fields:
        args += ["-f", f"{key}={value}"]
    return gh_json(args, check)


def full_sha(value):
    value = value.lower()
    if not SHA.fullmatch(value):
        raise argparse.ArgumentTypeError("expected a full 40-character commit SHA")
    return value


def repo_name(value):
    if not REPO.fullmatch(value) or value.split("/")[1] in (".", ".."):
        raise argparse.ArgumentTypeError("expected owner/name")
    return value


def target_url(value):
    try:
        parsed = urlsplit(value)
        valid = parsed.scheme in ("http", "https") and parsed.netloc
    except ValueError:
        valid = False
    if not valid or any(char.isspace() for char in value):
        raise argparse.ArgumentTypeError("expected an HTTP(S) target URL")
    return value


def pr_url(value):
    match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/pull/([1-9][0-9]*)/?", value)
    if match is None:
        raise argparse.ArgumentTypeError("expected https://github.com/owner/name/pull/NUMBER")
    repo_name(match[1])
    return value, match[1], int(match[2])


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, f"arguments: {one_line(message)}\n")


def arguments(argv):
    if argv and argv[0] == "post":
        parser = Parser(
            prog="pr-merge post", allow_abbrev=False,
            description="Post an exact gate or review commit status.",
        )
        parser.add_argument("context", choices=CONTEXTS)
        parser.add_argument("--sha", required=True, type=full_sha)
        parser.add_argument("--state", required=True, choices=("success", "failure"))
        parser.add_argument("--target", required=True, type=target_url)
        parser.add_argument("--repo", type=repo_name, help="owner/name; default: gh repo view")
        parser.epilog = (
            "gate requires a clean local Git tree, including untracked files, and HEAD == SHA. "
            "review does not check the local tree. Status contexts are exactly gate and review."
        )
        return "post", parser.parse_args(argv[1:])
    parser = Parser(
        prog="pr-merge", allow_abbrev=False,
        description="Check an exact GitHub PR head and merge it, printing only the merge SHA.",
        epilog=(
            "Requires latest gate/review statuses success, current base tip ancestry, "
            f"base-tip {CONFIG} with protected/tests string glob lists, no protected path changes, "
            "no removed test lines or changed binary tests, and a subagents: metrics line in the body. "
            "Globs use case-sensitive Python fnmatch against root-relative paths; * matches /, "
            "and ** has no special meaning. Both old/new rename paths are checked. "
            "cos-approved waives only protected/test diff restrictions, not config validity; "
            "label authorship is not verified. Rechecks observed metadata, base and statuses before "
            "merge; only the head match is atomic. See cli/pr-merge.md for the contract. "
            "Post evidence: pr-merge post <gate|review> --sha SHA --state <success|failure> "
            "--target URL [--repo owner/name]."
        ),
    )
    parser.add_argument("pr_url", metavar="PR_URL", type=pr_url)
    return "merge", parser.parse_args(argv)


def local_gate(sha):
    failures = []
    head = git(["rev-parse", "--verify", "HEAD"], "gate HEAD").decode().strip()
    if head != sha:
        failures.append(f"gate HEAD: local HEAD {head} does not match {sha}")
    records = git(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
        "gate tree",
    ).split(b"\0")
    index = 0
    while index < len(records) - 1:
        record = records[index]
        if len(record) < 4 or record[2:3] != b" ":
            raise Refusal("gate tree: malformed git status output")
        failures.append(f"gate tree: dirty path {path_name(os.fsdecode(record[3:]))}")
        if b"R" in record[:2] or b"C" in record[:2]:
            index += 1
            if index >= len(records) - 1:
                raise Refusal("gate tree: missing rename source in git status")
            failures.append(f"gate tree: dirty path {path_name(os.fsdecode(records[index]))}")
        index += 1
    if failures:
        raise Refusal(*failures)


def post(args):
    if args.context == "gate":
        local_gate(args.sha)
    repo = args.repo
    if repo is None:
        metadata = gh_json(["repo", "view", "--json", "nameWithOwner"], "repository")
        try:
            repo = repo_name(metadata["nameWithOwner"])
        except (KeyError, TypeError, argparse.ArgumentTypeError):
            raise Refusal("repository: gh repo view did not return owner/name") from None
    api(
        f"repos/{repo}/statuses/{args.sha}",
        f"post {args.context}",
        fields=(("context", args.context), ("state", args.state), ("target_url", args.target)),
    )


@dataclass(frozen=True)
class Snapshot:
    head: str
    base_ref: str
    base: str
    body: str
    labels: tuple
    state: str
    merged: bool
    statuses: dict


def snapshot(repo, number):
    pr = api(f"repos/{repo}/pulls/{number}", "PR metadata")
    try:
        head = pr["head"]["sha"]
        base_ref = pr["base"]["ref"]
        base_repo = pr["base"]["repo"]["full_name"]
        body = pr["body"]
        labels = tuple(sorted(label["name"] for label in pr["labels"]))
        state = pr["state"]
        merged = pr["merged"]
        valid = (
            isinstance(head, str) and SHA.fullmatch(head)
            and isinstance(base_ref, str) and base_ref
            and isinstance(base_repo, str) and base_repo.lower() == repo.lower()
            and (body is None or isinstance(body, str))
            and all(isinstance(label, str) for label in labels)
            and state in ("open", "closed") and isinstance(merged, bool)
        )
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise Refusal("PR metadata: missing or malformed head/base/body/labels/state")
    base_response = api(
        f"repos/{repo}/git/ref/heads/{quote(base_ref, safe='')}", "current base tip"
    )
    try:
        base = base_response["object"]["sha"]
        valid = base_response["object"]["type"] == "commit" and isinstance(base, str) and SHA.fullmatch(base)
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise Refusal("current base tip: malformed branch reference")
    # The combined-status endpoint returns the latest status for each context.
    pages = api(f"repos/{repo}/commits/{head}/status?per_page=100", "commit statuses", paginate=True)
    statuses = dict.fromkeys(CONTEXTS)
    if not isinstance(pages, list) or not pages:
        raise Refusal("commit statuses: malformed status pages")
    for page in pages:
        if not isinstance(page, dict) or page.get("sha") != head or not isinstance(page.get("statuses"), list):
            raise Refusal(f"commit statuses: malformed response or SHA does not match {head}")
        for status in page["statuses"]:
            if not isinstance(status, dict) or not isinstance(status.get("context"), str):
                raise Refusal("commit statuses: malformed status")
            context = status["context"]
            if context not in CONTEXTS:
                continue
            if (
                type(status.get("id")) is not int or status["id"] <= 0
                or status.get("state") not in ("success", "failure", "pending", "error")
                or not all(key in status for key in ("target_url", "description"))
            ):
                raise Refusal(f"{context}: malformed commit status")
            if statuses[context] is not None:
                raise Refusal(f"{context}: duplicate latest commit status in API response")
            statuses[context] = {key: status[key] for key in ("id", "state", "target_url", "description")}
    return Snapshot(head, base_ref, base, body or "", labels, state, merged, statuses)


def fetch_snapshot(directory, repo, number, observed):
    git(["init", "--bare", "--quiet", str(directory)], "temporary Git repository")
    # Detached writers must not outlive this temporary repository's cleanup.
    for key, value in (("gc.auto", "0"), ("maintenance.auto", "false"), ("fetch.writeCommitGraph", "false")):
        git(["config", key, value], "disable automatic Git maintenance", directory)
    git(
        ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
         "fetch", "--no-tags", "--no-recurse-submodules", "--",
         f"https://github.com/{repo}.git",
         f"refs/heads/{observed.base_ref}:refs/pr-merge/base",
         f"refs/pull/{number}/head:refs/pr-merge/head"],
        "fetch base/head", directory,
    )
    failures = []
    for name, expected in (("base", observed.base), ("head", observed.head)):
        actual = git(["rev-parse", f"refs/pr-merge/{name}"], f"fetched {name}", directory).decode().strip()
        if actual != expected:
            failures.append(f"{name}: fetched tip {actual} changed from snapshot {expected}")
    if failures:
        raise Refusal(*failures)


def policy(directory, base):
    content = git(["show", f"{base}:{CONFIG}"], f"config {CONFIG}", directory)
    try:
        config = tomllib.loads(content.decode("utf-8"))
    except (UnicodeError, tomllib.TOMLDecodeError):
        raise Refusal(f"config {CONFIG}: malformed UTF-8 TOML at base {base}") from None
    failures = []
    for key in ("protected", "tests"):
        if not isinstance(config.get(key), list) or not all(isinstance(glob, str) for glob in config[key]):
            failures.append(f"config {CONFIG}: {key} must be a list of string globs")
    if failures:
        raise Refusal(*failures)
    return config


def diff_records(directory, base, head):
    # Raw records include mode-only changes; numstat supplies deletion/binary evidence.
    options = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-M", "-l0", "-z"]
    raw = git(options + ["--raw", "--no-abbrev", base, head, "--"], "diff paths", directory).split(b"\0")
    paths = {}
    index = 0
    while index < len(raw) - 1:
        header = raw[index].split()
        if len(header) != 5 or not header[0].startswith(b":"):
            raise Refusal("diff paths: malformed raw Git record")
        index += 1
        if index >= len(raw) - 1:
            raise Refusal("diff paths: missing path")
        old = new = raw[index]
        if header[4].startswith((b"R", b"C")):
            index += 1
            if index >= len(raw) - 1:
                raise Refusal("diff paths: missing rename destination")
            new = raw[index]
        paths[(old, new)] = header[2] == header[3]
        index += 1
    records = {}
    stats = git(options + ["--numstat", base, head, "--"], "diff test lines", directory).split(b"\0")
    index = 0
    while index < len(stats) - 1:
        fields = stats[index].split(b"\t", 2)
        if len(fields) != 3:
            raise Refusal("diff test lines: malformed numstat record")
        added, deleted, path = fields
        old = new = path
        if not path:
            if index + 2 >= len(stats) - 1:
                raise Refusal("diff test lines: missing rename paths")
            old, new = stats[index + 1:index + 3]
            index += 2
        if (added, deleted) == (b"-", b"-"):
            deletion = None
        elif added.isdigit() and deleted.isdigit():
            deletion = int(deleted)
        else:
            raise Refusal("diff test lines: malformed line counts")
        key = (old, new)
        if key in records:
            raise Refusal("diff test lines: duplicate path record")
        records[key] = deletion
        index += 1
    if len(paths) != len(records) or set(paths) != set(records):
        raise Refusal("diff paths: raw and numstat paths disagree")
    return [
        (os.fsdecode(old), os.fsdecode(new), 0 if unchanged else records[(old, new)])
        for (old, new), unchanged in paths.items()
    ]


def inspect_git(directory, observed, failures):
    ancestry = subprocess.run(
        ["git", "-C", str(directory), "merge-base", "--is-ancestor", observed.base, observed.head],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if ancestry.returncode == 1:
        failures.append(f"ancestry: current base {observed.base} is not an ancestor of head {observed.head}")
    elif ancestry.returncode:
        raise Refusal("ancestry: git merge-base failed: " + one_line(ancestry.stderr.decode(errors="replace")))
    config = policy(directory, observed.base)
    if "cos-approved" in observed.labels:
        return
    for old, new, deleted in diff_records(directory, observed.base, observed.head):
        names = tuple(dict.fromkeys((old, new)))
        protected = [path for path in names if any(fnmatch.fnmatchcase(path, glob) for glob in config["protected"])]
        tests = [path for path in names if any(fnmatch.fnmatchcase(path, glob) for glob in config["tests"])]
        for path in protected:
            failures.append(f"protected: diff touches {path_name(path)}")
        if tests and (deleted is None or deleted > 0):
            reason = "binary test change" if deleted is None else f"{deleted} removed test lines"
            for path in tests:
                failures.append(f"tests: {reason} at {path_name(path)}")


def merge(url, repo, number):
    observed = snapshot(repo, number)
    failures = []
    if observed.state != "open" or observed.merged:
        failures.append("PR state: PR is not open and unmerged")
    for context in CONTEXTS:
        status = observed.statuses[context]
        if status is None or status["state"] != "success":
            state = "missing" if status is None else status["state"]
            failures.append(f"{context}: latest commit status on {observed.head} is {state}, not success")
    if not any(METRICS.fullmatch(line) for line in observed.body.splitlines()):
        failures.append("body: missing subagents: tasks=N accepted=N reworked=N rejected=N throttled=N line")
    cache = Path.home() / ".cache" / "agent-tmp"
    cache.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="pr-merge-", dir=cache) as temporary:
            directory = Path(temporary) / "repo.git"
            fetch_snapshot(directory, repo, number, observed)
            inspect_git(directory, observed, failures)
    except Refusal as error:
        failures.extend(error.reasons)
    if failures:
        raise Refusal(*failures)
    current = snapshot(repo, number)
    for field in ("head", "base_ref", "base", "body", "labels", "state", "merged"):
        if getattr(current, field) != getattr(observed, field):
            failures.append(f"snapshot {field}: changed before merge; rerun checks")
    for context in CONTEXTS:
        if current.statuses[context] != observed.statuses[context]:
            failures.append(f"{context}: latest commit status changed before merge; rerun checks")
    if failures:
        raise Refusal(*failures)
    run(["gh", "pr", "merge", url, "--merge", "--match-head-commit", observed.head], "merge")
    merged = api(f"repos/{repo}/pulls/{number}", "merged PR")
    try:
        sha = merged["merge_commit_sha"]
        valid = (
            merged["merged"] is True and merged["head"]["sha"] == observed.head
            and isinstance(sha, str) and SHA.fullmatch(sha)
        )
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise Refusal("merged PR: API did not confirm a merge SHA for the checked head")
    print(sha)


def main():
    mode, args = arguments(sys.argv[1:])
    try:
        if mode == "post":
            post(args)
        else:
            merge(*args.pr_url)
    except Refusal as error:
        for reason in error.reasons:
            print(one_line(reason), file=sys.stderr)
        return 1
    except OSError as error:
        print(f"environment: {one_line(error)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
