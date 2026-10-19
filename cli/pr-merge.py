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
    if argv and argv[0] == "base-proof":
        parser = Parser(prog="pr-merge base-proof", allow_abbrev=False,
                        description="Prove advanced-base history is disjoint from the original PR paths.")
        parser.add_argument("--base", required=True, type=full_sha)
        parser.add_argument("--head", required=True, type=full_sha)
        parser.add_argument("--advanced", required=True, type=full_sha)
        return "base-proof", parser.parse_args(argv[1:])
    if argv and argv[0] == "carry":
        parser = Parser(
            prog="pr-merge carry", allow_abbrev=False,
            description="Reproduce clean-rebase equivalence and carry successful gate/review statuses.",
        )
        parser.add_argument("pr_url", metavar="PR_URL", type=pr_url)
        parser.add_argument("--from", dest="source", required=True, type=full_sha)
        return "carry", parser.parse_args(argv[1:])
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
        parser.add_argument("--base", type=full_sha, help="Gate qualification base; required for later clean-rebase carry.")
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
            f"base-tip {CONFIG} with protected/tests string glob lists, and a subagents: metrics line in the body. "
            "Protected path changes, removed test lines and changed binary tests require the latest "
            "review status to link a formal review on this PR and exact head naming every flagged path. "
            "Globs use case-sensitive Python fnmatch against root-relative paths; * matches /, "
            "and ** has no special meaning. Both old/new rename paths are checked. "
            "Review authorship is not verified. Rechecks observed metadata, base and statuses before "
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
    if args.base is not None and args.context != "gate":
        raise Refusal("qualification base is only valid for gate statuses")
    if args.context == "gate":
        local_gate(args.sha)
        if args.base is not None and args.state == "success":
            git(["merge-base", "--is-ancestor", args.base, args.sha], "gate qualification base ancestry")
    repo = args.repo
    if repo is None:
        metadata = gh_json(["repo", "view", "--json", "nameWithOwner"], "repository")
        try:
            repo = repo_name(metadata["nameWithOwner"])
        except (KeyError, TypeError, argparse.ArgumentTypeError):
            raise Refusal("repository: gh repo view did not return owner/name") from None
    fields = [("context", args.context), ("state", args.state), ("target_url", args.target)]
    if args.base is not None and args.state == "success":
        fields.append(("description", f"Qualified base {args.base}"))
    api(f"repos/{repo}/statuses/{args.sha}", f"post {args.context}", fields=fields)


@dataclass(frozen=True)
class Snapshot:
    head: str
    base_ref: str
    base: str
    body: str
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
        state = pr["state"]
        merged = pr["merged"]
        valid = (
            isinstance(head, str) and SHA.fullmatch(head)
            and isinstance(base_ref, str) and base_ref
            and isinstance(base_repo, str) and base_repo.lower() == repo.lower()
            and (body is None or isinstance(body, str))
            and state in ("open", "closed") and isinstance(merged, bool)
        )
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise Refusal("PR metadata: missing or malformed head/base/body/state")
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
    return Snapshot(head, base_ref, base, body or "", state, merged, commit_statuses(repo, head))


def commit_statuses(repo, head):
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
    return statuses


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
    flagged = set()
    for old, new, deleted in diff_records(directory, observed.base, observed.head):
        names = tuple(dict.fromkeys((old, new)))
        protected = [path for path in names if any(fnmatch.fnmatchcase(path, glob) for glob in config["protected"])]
        tests = [path for path in names if any(fnmatch.fnmatchcase(path, glob) for glob in config["tests"])]
        flagged.update(protected)
        if tests and (deleted is None or deleted > 0):
            flagged.update(tests)
    return flagged


def review_attestation(flagged_paths, review_url, head, repo, number):
    if not flagged_paths:
        return []
    match = re.fullmatch(
        r"https://github\.com/([^/]+/[^/]+)/pull/([1-9][0-9]*)#pullrequestreview-([1-9][0-9]*)",
        review_url,
    ) if isinstance(review_url, str) else None
    if match is None or match[1].lower() != repo.lower() or int(match[2]) != number:
        return [
            f"protected/tests review: target URL {path_name(review_url)} must be "
            f"https://github.com/{repo}/pull/{number}#pullrequestreview-ID"
        ]
    review = api(f"repos/{repo}/pulls/{number}/reviews/{match[3]}", "protected/tests review")
    if not isinstance(review, dict):
        return ["protected/tests review: malformed review response"]
    failures = []
    if review.get("commit_id") != head:
        failures.append(
            f"protected/tests review: commit_id {path_name(review.get('commit_id'))} does not match head {head}"
        )
    body = review.get("body")
    for path in sorted(flagged_paths):
        if not isinstance(body, str) or path not in body:
            failures.append(f"protected/tests review: body does not name {path_name(path)}")
    return failures


CARRY_MARKER = "pr-merge clean-rebase proof v1\n```json\n"
CARRY_DESCRIPTION = "Carried {context} from {head} status {status}"


def success_statuses(statuses):
    if any(statuses[context] is None or statuses[context]["state"] != "success" for context in CONTEXTS):
        raise Refusal("carry: source gate and review must both be latest successful statuses")
    if any(str(statuses[context]["description"]).startswith("Carried ") for context in CONTEXTS):
        raise Refusal("carry: source must be original qualification, not another carry")


def fetch_source(directory, repo, source):
    git(
        ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
         "fetch", "--no-tags", "--no-recurse-submodules", "--",
         f"https://github.com/{repo}.git", source],
        "fetch original head", directory,
    )


def changed_paths(directory, base, head):
    return set(filter(None, git(
        ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, head, "--"],
        "carry changed paths", directory,
    ).split(b"\0")))


def advanced_base_paths(directory, base, head):
    return set(filter(None, git(
        ["log", "--format=", "--name-only", "--no-renames", "--diff-merges=first-parent", "-z", f"{base}..{head}", "--"],
        "carry advanced-base history paths", directory,
    ).split(b"\0")))


def disjoint_base_proof(directory, base, advanced, paths):
    if git(["rev-parse", "--is-shallow-repository"], "base proof history", directory).strip() != b"false":
        raise Refusal("base proof: complete history is required")
    git(["merge-base", "--is-ancestor", base, advanced], "base advancement ancestry", directory)
    overlap = paths & advanced_base_paths(directory, base, advanced)
    if overlap:
        raise Refusal("advanced base touches PR paths: " + ", ".join(path_name(os.fsdecode(path)) for path in sorted(overlap)))
    commits = git(["rev-list", "--reverse", f"{base}..{advanced}"], "base advancement commits", directory).decode().splitlines()
    return {"oldBase": base, "newBase": advanced, "paths": [os.fsdecode(path) for path in sorted(paths)], "commits": commits}


def gate_base_proof(directory, base, head, advanced):
    git(["merge-base", "--is-ancestor", base, head], "qualification base ancestry", directory)
    paths = changed_paths(directory, base, head)
    if not paths:
        raise Refusal("base proof: original PR paths must be nonempty")
    return {"head": head, **disjoint_base_proof(directory, base, advanced, paths)}


def qualified_base(statuses):
    description = statuses["gate"].get("description")
    match = re.fullmatch(r"Qualified base ([0-9a-f]{40})", description) if isinstance(description, str) else None
    if match is None:
        raise Refusal("carry: original gate lacks qualified base provenance")
    return match[1]


def rebase_proof(directory, source, head, base, old_base):
    git(["merge-base", "--is-ancestor", old_base, source], "carry original base ancestry", directory)
    git(["merge-base", "--is-ancestor", base, head], "carry new base ancestry", directory)
    if source == head or old_base == base:
        raise Refusal("carry: requires a new head rebased onto an advanced base")
    old_paths = changed_paths(directory, old_base, source)
    new_paths = changed_paths(directory, base, head)
    disjoint_base_proof(directory, old_base, base, old_paths | new_paths)
    if old_paths != new_paths or not old_paths:
        raise Refusal("carry: original and rebased PR path sets must be identical and nonempty")
    summary = git(
        ["range-diff", "--no-color", "--no-dual-color", "--no-notes", "--no-patch", "--abbrev=40",
         f"{old_base}..{source}", f"{base}..{head}"],
        "carry range-diff", directory,
    ).decode("utf-8", errors="replace")
    entries = summary.splitlines()
    pattern = re.compile(r"\s*[1-9][0-9]*: +[0-9a-f]{40} = +[1-9][0-9]*: +[0-9a-f]{40}(?: .*|)$")
    if not entries or any(pattern.fullmatch(line) is None for line in entries):
        raise Refusal("carry: range-diff is not entirely '='")
    for path in sorted(old_paths):
        entries = [git(["ls-tree", "-z", revision, "--", os.fsdecode(path)], "carry path identity", directory) for revision in (source, head)]
        if entries[0] != entries[1]:
            raise Refusal(f"carry: rebased path content or mode differs: {path_name(os.fsdecode(path))}")
    return {"oldBase": old_base, "newBase": base, "rangeDiff": summary}


def carry_description(context, proof):
    return CARRY_DESCRIPTION.format(context=context, head=proof["oldHead"], status=proof["statuses"][context]["id"])


def read_carry(repo, number, observed):
    carried = [context for context in CONTEXTS if observed.statuses[context] is not None and str(observed.statuses[context]["description"]).startswith("Carried ")]
    if not carried:
        return None
    if len(carried) != len(CONTEXTS):
        raise Refusal("carry: gate and review must refer to the same complete carry proof")
    urls = {observed.statuses[context]["target_url"] for context in CONTEXTS}
    if len(urls) != 1:
        raise Refusal("carry: gate and review proof URLs differ")
    url = next(iter(urls))
    match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/pull/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)", url) if isinstance(url, str) else None
    if match is None or match[1].lower() != repo.lower() or int(match[2]) != number:
        raise Refusal("carry: malformed proof comment URL")
    comment = api(f"repos/{repo}/issues/comments/{match[3]}", "carry proof comment")
    try:
        body = comment["body"]
        if comment["html_url"] != url or comment["issue_url"] != f"https://api.github.com/repos/{repo}/issues/{number}" or not body.startswith(CARRY_MARKER) or not body.endswith("\n```"):
            raise ValueError
        proof = json.loads(body[len(CARRY_MARKER):-4])
        if not isinstance(proof, dict) or proof.get("newHead") != observed.head or proof.get("newBase") != observed.base or proof.get("repo") != repo or proof.get("pr") != number or not isinstance(proof.get("oldHead"), str) or SHA.fullmatch(proof["oldHead"]) is None:
            raise ValueError
        for context in CONTEXTS:
            if observed.statuses[context]["description"] != carry_description(context, proof):
                raise ValueError
    except (KeyError, TypeError, ValueError):
        raise Refusal("carry: malformed or mismatched proof comment") from None
    original = commit_statuses(repo, proof["oldHead"])
    success_statuses(original)
    if original != proof["statuses"]:
        raise Refusal("carry: original qualification statuses changed")
    return proof


def reproduce_carry(directory, repo, observed, proof):
    fetch_source(directory, repo, proof["oldHead"])
    computed = rebase_proof(directory, proof["oldHead"], observed.head, observed.base, qualified_base(proof["statuses"]))
    if any(proof.get(key) != value for key, value in computed.items()):
        raise Refusal("carry: published equivalence proof does not reproduce")


def carry(url, repo, number, source):
    observed = snapshot(repo, number)
    if observed.state != "open" or observed.merged or observed.base_ref != "main":
        raise Refusal("carry: requires an open unmerged PR targeting main")
    originals = commit_statuses(repo, source)
    success_statuses(originals)
    old_base = qualified_base(originals)
    cache = Path.home() / ".cache" / "agent-tmp"
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pr-merge-carry-", dir=cache) as temporary:
        directory = Path(temporary) / "repo.git"
        fetch_snapshot(directory, repo, number, observed)
        fetch_source(directory, repo, source)
        proof = {"repo": repo, "pr": number, "oldHead": source, "newHead": observed.head, "statuses": originals, **rebase_proof(directory, source, observed.head, observed.base, old_base)}
        failures = []
        flagged = inspect_git(directory, observed, failures)
        failures.extend(review_attestation(flagged, originals["review"]["target_url"], source, repo, number))
        if failures:
            raise Refusal(*failures)
    if snapshot(repo, number) != observed or commit_statuses(repo, source) != originals:
        raise Refusal("carry: PR snapshot or source qualification changed before publication")
    comment = api(f"repos/{repo}/issues/{number}/comments", "publish carry proof", fields=(("body", CARRY_MARKER + json.dumps(proof, indent=2, sort_keys=True) + "\n```"),))
    target = comment.get("html_url") if isinstance(comment, dict) else None
    if not isinstance(target, str) or re.fullmatch(re.escape(url) + r"#issuecomment-[1-9][0-9]*", target) is None:
        raise Refusal("carry: publication returned a malformed proof URL")
    if snapshot(repo, number) != observed or commit_statuses(repo, source) != originals:
        raise Refusal("carry: PR snapshot or source qualification changed during publication")
    for context in CONTEXTS:
        api(f"repos/{repo}/statuses/{observed.head}", f"carry {context}", fields=(("context", context), ("state", "success"), ("target_url", target), ("description", carry_description(context, proof))))
    published = snapshot(repo, number)
    if any(getattr(published, field) != getattr(observed, field) for field in ("head", "base_ref", "base", "body", "state", "merged")) or read_carry(repo, number, published) != proof:
        raise Refusal("carry: published statuses did not read back against the same PR snapshot")
    print(target)


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
            flagged = inspect_git(directory, observed, failures)
            proof = read_carry(repo, number, observed)
            if proof is not None:
                reproduce_carry(directory, repo, observed, proof)
            review = proof["statuses"]["review"] if proof else observed.statuses["review"]
            failures.extend(review_attestation(
                flagged, review["target_url"] if review else None, proof["oldHead"] if proof else observed.head, repo, number,
            ))
    except Refusal as error:
        failures.extend(error.reasons)
    if failures:
        raise Refusal(*failures)
    current = snapshot(repo, number)
    for field in ("head", "base_ref", "base", "body", "state", "merged"):
        if getattr(current, field) != getattr(observed, field):
            failures.append(f"snapshot {field}: changed before merge; rerun checks")
    for context in CONTEXTS:
        if current.statuses[context] != observed.statuses[context]:
            failures.append(f"{context}: latest commit status changed before merge; rerun checks")
    if failures:
        raise Refusal(*failures)
    if proof is not None and commit_statuses(repo, proof["oldHead"]) != proof["statuses"]:
        raise Refusal("carry: original qualification changed before merge")
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
        if mode == "base-proof":
            print(json.dumps(gate_base_proof(Path.cwd(), args.base, args.head, args.advanced), sort_keys=True))
        elif mode == "post":
            post(args)
        elif mode == "carry":
            carry(*args.pr_url, args.source)
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
