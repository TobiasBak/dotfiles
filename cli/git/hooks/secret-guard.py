#!/usr/bin/python3
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import tomllib


GIT = "/usr/bin/git"
TRUSTED = Path(__file__).resolve().parent
LEAK_EXIT = 10


class GuardFailure(Exception):
    pass


def run(args, *, env, cwd=None, input=None, discard=False, failure):
    result = subprocess.run(
        args,
        env=env,
        cwd=cwd,
        input=input,
        stdout=subprocess.DEVNULL if discard else subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        raise GuardFailure(failure)
    return result.stdout


def resolve_scanner():
    root = TRUSTED.parents[2]
    with (root / "mise.toml").open("rb") as manifest:
        tools = tomllib.load(manifest).get("tools")
    pin = tools.get("gitleaks") if isinstance(tools, dict) else None
    if not isinstance(pin, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", pin):
        raise GuardFailure("trusted Gitleaks version pin is invalid")
    failure = f"pinned Gitleaks is unavailable or invalid; run: mise install gitleaks@{pin}"
    try:
        home = Path.home()
        data_dir = Path(
            os.environ.get("MISE_DATA_DIR")
            or (Path(os.environ.get("XDG_DATA_HOME") or home / ".local/share") / "mise")
        )
        version_dir = data_dir / "installs/gitleaks" / pin
        scanner = version_dir / "gitleaks"
        if (
            not scanner.is_absolute()
            or version_dir.is_symlink()
            or not version_dir.is_dir()
            or not stat.S_ISREG(scanner.lstat().st_mode)
            or not os.access(scanner, os.X_OK)
        ):
            raise GuardFailure(failure)
        version = run(
            [str(scanner), "version"],
            env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
            cwd=root, input=b"", failure=failure,
        )
        if version not in (pin.encode("ascii"), pin.encode("ascii") + b"\n"):
            raise GuardFailure(failure)
        return scanner
    except (OSError, ValueError, UnicodeError):
        raise GuardFailure(failure) from None


def original_hook(hook, env):
    if env.get("GIT_COMMON_DIR"):
        common = Path(env["GIT_COMMON_DIR"]).absolute()
    elif env.get("GIT_DIR"):
        git_dir = Path(env["GIT_DIR"]).absolute()
        common_file = git_dir / "commondir"
        if common_file.is_file():
            common = git_dir / os.fsdecode(common_file.read_bytes().removesuffix(b"\n"))
        else:
            common = git_dir
    else:
        raw = run(
            [GIT, "rev-parse", "--path-format=absolute", "--git-common-dir"],
            env=env, failure="could not discover original Git hook",
        )
        common = Path(os.fsdecode(raw.removesuffix(b"\n"))).absolute()
    candidate = common / "hooks" / hook
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        return None
    if candidate.resolve().is_relative_to(TRUSTED):
        return None
    for name in ("pre-commit", "pre-push", "passthrough", "secret-guard.py"):
        if candidate.samefile(TRUSTED / name):
            return None
    return candidate


def passthrough(hook, argv):
    try:
        if not hook or hook in (".", "..") or Path(hook).name != hook:
            raise GuardFailure("invalid hook name")
        candidate = original_hook(hook, os.environ)
        if candidate is not None:
            os.execv(candidate, [str(candidate), *argv])
        return 0
    except (GuardFailure, OSError, ValueError, UnicodeError):
        print("git-hooks: original hook dispatch failed.", file=sys.stderr)
        return 1


class Source:
    def __init__(self, hook):
        self.env = dict(os.environ)
        self.env["GIT_NO_REPLACE_OBJECTS"] = "1"
        self.env["GIT_NO_LAZY_FETCH"] = "1"
        self.git_dir = self.path("--absolute-git-dir")
        self.hook = original_hook(hook, self.env)
        self.objects = self.path("--git-path", "objects")
        self.index = self.path("--git-path", "index")
        if self.git("rev-parse", "--is-shallow-repository").strip() != b"false":
            raise GuardFailure("shallow repositories cannot be scanned completely")
        self.object_format = self.git("rev-parse", "--show-object-format").strip().decode("ascii")
        if self.object_format not in ("sha1", "sha256"):
            raise GuardFailure("unsupported Git object format")
        self.oid_length = 40 if self.object_format == "sha1" else 64

    def git(self, *args):
        return run(
            [GIT, *args], env=self.env,
            failure="source Git command failed",
        )

    def path(self, *args):
        raw = self.git("rev-parse", "--path-format=absolute", *args)
        return Path(os.fsdecode(raw.removesuffix(b"\n"))).absolute()

    def oid(self, raw):
        if not re.fullmatch(rb"[0-9a-f]{" + str(self.oid_length).encode() + rb"}", raw):
            raise GuardFailure("invalid object ID in push input")
        return raw.decode("ascii")

    def staged_tree(self):
        tree = self.git("write-tree").strip()
        return self.oid(tree)

    def remote_refs(self, remote):
        output = self.git(
            "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/",
        )
        prefix = b"refs/remotes/" + os.fsencode(remote) + b"/"
        refs = []
        for line in output.splitlines():
            ref, oid = line.split(b" ")
            if ref.startswith(prefix):
                refs.append((os.fsdecode(ref), self.oid(oid)))
        return refs


class Isolated:
    def __init__(self, root, source, scanner):
        self.scanner = scanner
        self.root = root
        self.repo = root / "scan.git"
        self.env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(root),
            "XDG_CONFIG_HOME": str(root / "config"),
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_TERMINAL_PROMPT": "0",
        }
        run(
            [GIT, "init", "--bare", "--template=", f"--object-format={source.object_format}", str(self.repo)],
            env=self.env, cwd=root, discard=True,
            failure="could not create isolated scan repository",
        )
        objects = os.fsencode(source.objects)
        if b"\n" in objects or b"\r" in objects:
            raise GuardFailure("object database path cannot be isolated safely")
        (self.repo / "objects/info/alternates").write_bytes(objects + b"\n")

    def git(self, *args, input=None, discard=False, failure="isolated Git command failed"):
        return run(
            [GIT, "--git-dir", str(self.repo), *args],
            env=self.env, cwd=self.root, input=input, discard=discard,
            failure=failure,
        )

    def commit_oid(self, oid):
        return self.git(
            "rev-parse", "--verify", f"{oid}^{{commit}}",
            failure="push object is missing locally or does not resolve to a commit",
        ).strip().decode("ascii")

    def complete_graph(self, tips):
        self.git(
            "rev-list", "--objects", "--missing=error", *tips, "--",
            discard=True, failure="source object graph is incomplete",
        )

    def scan(self, revisions):
        report = self.root / "findings.jsonl"
        report.unlink(missing_ok=True)
        result = subprocess.run(
            [
                str(self.scanner), "git", str(self.repo),
                "--config", str(TRUSTED / "scanner.toml"),
                "--gitleaks-ignore-path", str(TRUSTED / "historical.gitleaksignore"),
                "--report-format=template",
                "--report-template", str(TRUSTED / "findings.tmpl"),
                "--report-path", str(report),
                "--redact=100", "--ignore-gitleaks-allow", "--no-banner",
                f"--exit-code={LEAK_EXIT}",
                "--log-opts=" + " ".join([
                    "--root", "--full-history", "-m", "--no-ext-diff",
                    "--no-textconv", *revisions, "--",
                ]),
            ],
            env=self.env, cwd=self.root,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if result.returncode not in (0, LEAK_EXIT) or not report.is_file():
            raise GuardFailure("scanner failed; no successful scan was recorded")
        findings = []
        for line in report.read_text(encoding="utf-8").splitlines():
            finding = json.loads(line)
            if (
                not isinstance(finding, dict)
                or set(finding) != {"File", "Commit", "RuleID"}
                or any(not isinstance(value, str) for value in finding.values())
            ):
                raise GuardFailure("scanner returned an invalid metadata report")
            findings.append(finding)
        if (result.returncode == LEAK_EXIT) != bool(findings):
            raise GuardFailure("scanner exit status does not match its metadata report")
        if findings:
            for finding in findings:
                print(json.dumps(finding, ensure_ascii=True), file=sys.stderr)
            raise GuardFailure("possible secrets found")

    def pre_commit(self, source):
        tree = source.staged_tree()
        result = subprocess.run(
            [GIT, "rev-parse", "--verify", "--quiet", "HEAD"],
            env=source.env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode == 0:
            parent = source.oid(result.stdout.strip())
        elif result.returncode == 1 and not result.stdout:
            parent = None
        else:
            raise GuardFailure("could not resolve source HEAD")
        parents = ["-p", parent] if parent is not None else []
        env = dict(self.env)
        env.update({
            "GIT_AUTHOR_NAME": "Secret guard", "GIT_AUTHOR_EMAIL": "guard@localhost",
            "GIT_COMMITTER_NAME": "Secret guard", "GIT_COMMITTER_EMAIL": "guard@localhost",
        })
        commit = run(
            [GIT, "--git-dir", str(self.repo), "commit-tree", tree, *parents],
            env=env, cwd=self.root, input=b"Staged snapshot\n",
            failure="could not create staged snapshot commit",
        ).strip().decode("ascii")
        self.complete_graph([commit])
        self.scan([f"{parent}..{commit}" if parent is not None else commit])

    def pre_push(self, source, argv, stdin):
        if len(argv) != 2:
            raise GuardFailure("invalid pre-push arguments")
        remote = argv[0]
        if not remote or any(char.isspace() or char in "*?[]" for char in remote):
            raise GuardFailure("remote name cannot be represented safely in scan options")
        updates = []
        zero = "0" * source.oid_length
        for line in stdin.splitlines():
            fields = line.split()
            if len(fields) != 4:
                raise GuardFailure("invalid pre-push input")
            local_ref, local_raw, remote_ref, remote_raw = fields
            local, old = source.oid(local_raw), source.oid(remote_raw)
            self.git("check-ref-format", os.fsdecode(remote_ref), failure="invalid destination ref in push input")
            if local != zero:
                updates.append((local, old))
        if not updates:
            return
        exclusion_names = [remote]
        if remote != "upstream" and b"upstream" in source.git("remote").splitlines():
            exclusion_names.append("upstream")
        refs = {
            ref: oid
            for name in exclusion_names
            for ref, oid in source.remote_refs(name)
        }
        remote_tips = []
        for ref, oid in refs.items():
            tip = self.commit_oid(oid)
            self.git("update-ref", ref, oid)
            remote_tips.append(tip)
        exclusions = ["--not", *(f"--remotes={name}" for name in exclusion_names)]
        for local, old in updates:
            local_commit = self.commit_oid(local)
            tips = [local_commit, *remote_tips]
            revisions = [local]
            if old != zero:
                tips.append(self.commit_oid(old))
                revisions = [f"{old}..{local}"]
            self.complete_graph(tips)
            self.scan([*revisions, *exclusions])


def chain_hook(source, hook, argv, stdin):
    candidate = source.hook
    if candidate is None:
        return 0
    result = subprocess.run([str(candidate), *argv], input=stdin, check=False)
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "passthrough":
        return passthrough(sys.argv[2], sys.argv[3:])
    try:
        if len(sys.argv) < 2 or sys.argv[1] not in ("pre-commit", "pre-push"):
            raise GuardFailure("invalid hook invocation")
        hook, argv = sys.argv[1], sys.argv[2:]
        stdin = sys.stdin.buffer.read() if hook == "pre-push" else None
        scanner = resolve_scanner()
        source = Source(hook)
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="secret-guard-", dir=scratch) as temp:
            isolated = Isolated(Path(temp), source, scanner)
            if hook == "pre-commit":
                isolated.pre_commit(source)
            else:
                isolated.pre_push(source, argv, stdin)
        return chain_hook(source, hook, argv, stdin)
    except GuardFailure as error:
        print(f"secret-guard: {error}. Stop and report; do not bypass the hook.", file=sys.stderr)
        return 1
    except (OSError, ValueError, UnicodeError):
        print("secret-guard: guard failed. Stop and report; do not bypass the hook.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
