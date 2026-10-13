import json
import os
from pathlib import Path
import random
import shutil
import string
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SYSTEM_PATH = '/usr/bin:/bin'
SCANNER_VERSION = '8.30.1'
ALLOW_CONFIG = "[extend]\nuseDefault = true\n[allowlist]\nregexes = ['.*']\n"


class SecretGuardTests(unittest.TestCase):
    def setUp(self):
        cache = Path.home() / '.cache/agent-tmp'
        cache.mkdir(parents=True, exist_ok=True)
        self.temp = Path(tempfile.mkdtemp(prefix='secret-guard-test-', dir=cache))
        self.addCleanup(shutil.rmtree, self.temp)
        self.home = self.temp / 'home'
        self.home.mkdir()
        self.dotfiles = self.temp / 'dotfiles'
        hooks = ROOT / 'cli/git/hooks'
        self.assertTrue(hooks.is_dir(), 'Hook implementation unavailable; tests are ready for run')
        shutil.copytree(hooks, self.dotfiles / 'cli/git/hooks')
        shutil.copy2(ROOT / 'cli/git/overrides', self.dotfiles / 'cli/git/overrides')
        shutil.copy2(ROOT / 'mise.toml', self.dotfiles / 'mise.toml')
        (self.home / '.dotfiles').symlink_to(self.dotfiles, target_is_directory=True)
        (self.home / '.gitconfig').write_text(
            '[include]\n\tpath = ~/.dotfiles/cli/git/overrides\n'
            '[gc]\n\tauto = 0\n\tautoPackLimit = 0\n'
            '[maintenance]\n\tauto = false\n'
        )
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('GIT_', 'GITLEAKS_', 'MISE_', 'XDG_', 'SECRET_GUARD_'))
                    and key not in ('BASH_ENV', 'ENV', 'PYTHONPATH', 'PYTHONHOME')}
        self.env.update(
            HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / '.config'),
            XDG_CACHE_HOME=str(self.home / '.cache'),
            XDG_DATA_HOME=str(self.home / '.local/share'),
            XDG_STATE_HOME=str(self.home / '.local/state'),
            PATH=SYSTEM_PATH, TMPDIR=str(self.temp), PYTHONDONTWRITEBYTECODE='1',
            LC_ALL='C', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_SYSTEM='/dev/null',
            GIT_CONFIG_GLOBAL=str(self.home / '.gitconfig'), GIT_TERMINAL_PROMPT='0',
        )
        self.git_bin = shutil.which('git', path=SYSTEM_PATH)
        self.assertIsNotNone(self.git_bin, 'Real git is required')
        self.token = 'gh' + 'p_' + 'aB3' + ''.join(
            random.Random(20261012).choices(string.ascii_letters + string.digits, k=33)
        )
        self.repo = self.temp / 'repo'
        self.remote = self.temp / 'remote.git'
        self.git(self.temp, 'init', '--initial-branch=main', str(self.repo))
        self.git(self.temp, 'init', '--bare', '--initial-branch=main', str(self.remote))
        self.git(self.repo, 'config', 'user.name', 'Secret Guard Test')
        self.git(self.repo, 'config', 'user.email', 'secret-guard@example.invalid')
        self.git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        self.record = self.temp / 'local-hooks.jsonl'
        self.recorder = self.temp / 'record-hook.py'
        self.recorder.write_text(
            'import json, os, sys\n'
            'from pathlib import Path\n'
            'event = {"hook": sys.argv[1], "args": sys.argv[2:],\n'
            '         "stdin": sys.stdin.read() if sys.argv[1] != "pre-commit" else ""}\n'
            'if sys.argv[1] in ("commit-msg", "post-checkout"):\n'
            '    event["cwd"] = os.getcwd()\n'
            'with Path(os.environ["SECRET_GUARD_RECORD"]).open("a") as out:\n'
            '    out.write(json.dumps(event) + "\\n")\n'
            'status = int(os.environ.get("SECRET_GUARD_LOCAL_EXIT", "0"))\n'
            'if status and sys.argv[1] in ("commit-msg", "post-checkout"):\n'
            '    print("local hook veto", file=sys.stderr)\n'
            'sys.exit(status)\n'
        )
        self.env['SECRET_GUARD_RECORD'] = str(self.record)

    def require_scanner(self):
        data_dir = Path.home() / '.local/share/mise'
        install = data_dir / 'installs/gitleaks' / SCANNER_VERSION
        scanner = install / 'gitleaks'
        self.assertFalse(install.is_symlink(), 'Pinned version directory must not be a symlink')
        self.assertTrue(scanner.is_file() and not scanner.is_symlink()
                        and os.access(scanner, os.X_OK),
                        'BLOCKED: pinned user-level gitleaks is missing or not executable; '
                        f'run: mise install gitleaks@{SCANNER_VERSION}')
        self.assertTrue(scanner.resolve().is_relative_to(install.resolve()),
                        'Resolved scanner must belong to the pinned user-level mise installation')
        result = subprocess.run(
            [str(scanner), 'version'], cwd=self.dotfiles,
            env={'HOME': str(self.home), 'PATH': SYSTEM_PATH},
            stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, 'BLOCKED: real scanner version command failed')
        self.assertIn(result.stdout, (SCANNER_VERSION, SCANNER_VERSION + '\n'),
                      'BLOCKED: real scanner version does not match the trusted pin')
        self.env['MISE_DATA_DIR'] = str(data_dir)

    def git(self, repo, *args, ok=True, env=None, input_text=None):
        self.assertTrue(Path(repo).resolve().is_relative_to(self.temp.resolve()))
        isolated = {key: value for key, value in self.env.items()
                    if not key.startswith('GIT_')}
        isolated.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_SYSTEM='/dev/null',
                        GIT_CONFIG_GLOBAL=str(self.home / '.gitconfig'),
                        GIT_TERMINAL_PROMPT='0')
        isolated.update(env or {})
        result = subprocess.run(
            [self.git_bin, *args], cwd=repo, env=isolated, text=True,
            capture_output=True, timeout=30,
            **({'stdin': subprocess.DEVNULL} if input_text is None else {'input': input_text}),
        )
        output = result.stdout + result.stderr
        if ok:
            self.assertEqual(result.returncode, 0, f'git {args!r}\n{output}')
        else:
            self.assertNotEqual(result.returncode, 0, f'git {args!r} unexpectedly succeeded\n{output}')
        return result

    def put(self, repo, name, content):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def head(self, repo=None):
        return self.git(repo or self.repo, 'rev-parse', 'HEAD').stdout.strip()

    def refs(self):
        return self.git(self.remote, 'for-each-ref', '--format=%(refname) %(objectname)').stdout

    def commit(self, message, repo=None, bypass=False, ok=True, env=None):
        repo = repo or self.repo
        self.git(repo, 'add', '--all')
        prefix = ('-c', 'core.hooksPath=/dev/null') if bypass else ()
        return self.git(repo, *prefix, 'commit', '-m', message, ok=ok, env=env)

    def seed(self, bypass=False):
        self.put(self.repo, 'README', 'clean seed\n')
        self.commit('clean seed', bypass=bypass)
        return self.head()

    def install_local_hooks(self, repo=None, names=('pre-commit', 'pre-push')):
        repo = repo or self.repo
        common = self.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip()
        hooks = Path(common) / 'hooks'
        self.assertTrue(hooks.resolve().is_relative_to(self.temp.resolve()))
        hooks.mkdir(parents=True, exist_ok=True)
        for name in names:
            hook = hooks / name
            hook.write_text(f'#!/bin/sh\nexec python3 "{self.recorder}" {name} "$@"\n')
            hook.chmod(0o755)

    def events(self):
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def clear_events(self):
        self.record.write_text('')

    def blocked_commit(self, repo=None, env=None):
        repo = repo or self.repo
        before = self.head(repo)
        events = self.events()
        result = self.git(repo, 'commit', '-m', 'must be rejected', ok=False, env=env)
        self.assertTrue((result.stdout + result.stderr).strip(),
                        'Rejected Git operations need a diagnostic')
        self.assertEqual(self.head(repo), before)
        self.assertEqual(self.events(), events, 'Local pre-commit ran before a failed scan')
        return result

    def blocked_push(self, *refspecs, repo=None, force=False, env=None):
        before = self.refs()
        events = self.events()
        options = ('--force',) if force else ()
        result = self.git(repo or self.repo, 'push', *options, 'origin', *refspecs, ok=False, env=env)
        self.assertTrue((result.stdout + result.stderr).strip(),
                        'Rejected Git operations need a diagnostic')
        self.assertEqual(self.refs(), before, 'Rejected push changed remote refs')
        self.assertEqual(self.events(), events, 'Local pre-push ran before a failed scan')
        return result

    def test_staged_diff_fresh_clone_worktree_and_commit_chaining(self):
        self.require_scanner()
        self.install_local_hooks()
        base = self.seed()
        self.assertEqual(self.events(), [{'hook': 'pre-commit', 'args': [], 'stdin': ''}])
        self.clear_events()
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.git(self.repo, 'add', 'credentials.env')
        self.put(self.repo, 'credentials.env', 'GITHUB_TOKEN=masked\n')
        self.blocked_commit()
        self.assertIn(self.token, self.git(self.repo, 'show', ':credentials.env').stdout)
        self.git(self.repo, 'reset', '--hard', base)
        self.put(self.repo, 'README', 'clean edit\n')
        self.commit('local hook can veto', ok=False, env={'SECRET_GUARD_LOCAL_EXIT': '19'})
        self.assertEqual(self.head(), base)
        self.assertEqual(self.events(), [{'hook': 'pre-commit', 'args': [], 'stdin': ''}])
        self.commit('clean edit')
        self.git(self.repo, 'push', 'origin', 'main')
        clone = self.temp / 'clone'
        self.git(self.temp, 'clone', str(self.remote), str(clone))
        worktree = self.temp / 'worktree'
        self.git(clone, 'worktree', 'add', '-b', 'worktree-test', str(worktree))
        for repo in (clone, worktree):
            with self.subTest(repo=repo.name):
                self.put(repo, 'fresh.txt', 'fresh clean content\n')
                self.commit('fresh repository adopts global hooks', repo=repo)
                self.put(repo, 'runtime-generated/dummy.env', f'GITHUB_TOKEN={self.token}\n')
                self.git(repo, 'add', 'runtime-generated/dummy.env')
                self.blocked_commit(repo)
                self.commit('controlled secret setup', repo=repo, bypass=True)
                secret_head = self.head(repo)
                self.put(repo, 'fresh.txt', 'unrelated clean edit\n')
                self.commit('unrelated clean edit beyond existing secret', repo=repo)
                self.assertNotEqual(self.head(repo), secret_head)
                self.assertIn(self.token, self.git(
                    repo, 'show', 'HEAD:runtime-generated/dummy.env').stdout)
                self.put(repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
                self.git(repo, 'add', 'credentials.env')
                self.blocked_commit(repo)
                self.blocked_push('HEAD:refs/heads/main', repo=repo)

    def test_push_ranges_tags_force_push_and_local_chaining(self):
        self.require_scanner()
        self.install_local_hooks()
        base = self.seed()
        self.clear_events()
        self.git(self.repo, 'push', 'origin', 'main')
        zero = '0' * 40
        self.assertEqual(self.events(), [{
            'hook': 'pre-push', 'args': ['origin', str(self.remote)],
            'stdin': f'refs/heads/main {base} refs/heads/main {zero}\n',
        }])
        self.put(self.repo, 'README', 'clean update\n')
        self.commit('clean update')
        updated = self.head()
        self.clear_events()
        before = self.refs()
        self.git(self.repo, 'push', 'origin', 'main', ok=False,
                 env={'SECRET_GUARD_LOCAL_EXIT': '19'})
        self.assertEqual(self.refs(), before)
        expected = {'hook': 'pre-push', 'args': ['origin', str(self.remote)],
                    'stdin': f'refs/heads/main {updated} refs/heads/main {base}\n'}
        self.assertEqual(self.events(), [expected])
        self.clear_events()
        self.git(self.repo, 'push', 'origin', 'main')
        self.assertEqual(self.events(), [expected])
        self.assertIn(f'refs/heads/main {updated}\n', self.refs())
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled secret setup', bypass=True)
        secret = self.head()
        self.put(self.repo, 'credentials.env', 'removed token\n')
        self.commit('clean tip after secret')
        clean_tip = self.head()
        self.blocked_push('main')
        self.git(self.repo, 'branch', 'leaky-new', clean_tip)
        self.git(self.repo, 'tag', 'leaky-lightweight', secret)
        self.git(self.repo, 'tag', '-a', 'leaky-annotated', '-m', 'history contains secret', clean_tip)
        for ref in ('leaky-new', 'leaky-lightweight', 'leaky-annotated'):
            with self.subTest(ref=ref):
                self.blocked_push(ref)
        self.git(self.repo, 'switch', '-c', 'replacement', base)
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled replacement secret', bypass=True)
        self.put(self.repo, 'credentials.env', 'removed replacement token\n')
        self.commit('clean replacement tip')
        self.blocked_push('HEAD:refs/heads/main', force=True)
        self.git(self.repo, 'reset', '--hard', base)
        self.put(self.repo, 'README', 'clean rewritten history\n')
        self.commit('clean replacement')
        replacement = self.head()
        self.clear_events()
        self.git(self.repo, 'push', '--force', 'origin', 'HEAD:refs/heads/main')
        self.assertEqual(self.events(), [{
            'hook': 'pre-push', 'args': ['origin', str(self.remote)],
            'stdin': f'HEAD {replacement} refs/heads/main {updated}\n',
        }])
        self.git(self.repo, 'branch', 'clean-new', replacement)
        self.git(self.repo, 'tag', 'clean-tag', replacement)
        self.clear_events()
        self.git(self.repo, 'push', 'origin', 'clean-new', 'clean-tag')
        event, = self.events()
        self.assertEqual(event['args'], ['origin', str(self.remote)])
        self.assertEqual(set(event['stdin'].splitlines()), {
            f'refs/heads/clean-new {replacement} refs/heads/clean-new {zero}',
            f'refs/tags/clean-tag {replacement} refs/tags/clean-tag {zero}',
        })
        self.git(self.repo, 'switch', '-c', 'legacy', base)
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled preexisting remote history', bypass=True)
        old_secret = self.head()
        self.git(self.remote, 'fetch', '--no-tags', str(self.repo), old_secret)
        self.git(self.remote, 'update-ref', 'refs/heads/legacy', old_secret)
        self.put(self.repo, 'README', 'unrelated update beyond old secret\n')
        self.commit('controlled clean update beyond old secret', bypass=True)
        legacy_tip = self.head()
        self.git(self.repo, 'push', 'origin', 'legacy')
        self.assertIn(f'refs/heads/legacy {legacy_tip}\n', self.refs())
        self.git(self.repo, 'branch', 'legacy-new', legacy_tip)
        self.git(self.repo, 'tag', 'legacy-lightweight', old_secret)
        self.git(self.repo, 'tag', '-a', 'legacy-annotated', '-m', 'already remote', legacy_tip)
        self.git(self.repo, 'push', 'origin', 'legacy-new', 'legacy-lightweight', 'legacy-annotated')
        remote_refs = self.refs()
        for ref, oid in (('refs/heads/legacy-new', legacy_tip),
                         ('refs/tags/legacy-lightweight', old_secret),
                         ('refs/tags/legacy-annotated', self.git(
                             self.repo, 'rev-parse', 'legacy-annotated').stdout.strip())):
            self.assertIn(f'{ref} {oid}\n', remote_refs)
        self.git(self.repo, 'switch', '-c', 'merge-secret', base)
        self.put(self.repo, 'left.txt', 'clean left parent\n')
        self.commit('clean left parent')
        left = self.head()
        self.git(self.repo, 'switch', '-c', 'merge-right', base)
        self.put(self.repo, 'right.txt', 'clean right parent\n')
        self.commit('clean right parent')
        right = self.head()
        self.git(self.repo, 'switch', 'merge-secret')
        self.git(self.repo, '-c', 'core.hooksPath=/dev/null',
                 'merge', '--no-ff', '--no-commit', 'merge-right')
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled secret introduced only by merge', bypass=True)
        merge = self.head()
        self.assertEqual(self.git(self.repo, 'show', '-s', '--format=%P', merge).stdout.strip(),
                         f'{left} {right}')
        for parent in (left, right):
            self.assertNotIn('credentials.env', self.git(
                self.repo, 'ls-tree', '-r', '--name-only', parent).stdout.splitlines())
        self.assertIn(self.token, self.git(self.repo, 'show', f'{merge}:credentials.env').stdout)
        (self.repo / 'credentials.env').unlink()
        self.commit('clean tip after merge-only secret')
        self.blocked_push('merge-secret')

    def test_untrusted_suppressions_do_not_bypass_commit_or_push(self):
        self.require_scanner()
        self.seed()
        self.install_local_hooks()
        hostile_config = self.put(self.repo, '.gitleaks.toml', ALLOW_CONFIG)
        self.put(self.dotfiles, '.gitleaks.toml', ALLOW_CONFIG)
        self.put(self.dotfiles, '.gitleaksignore', '*\n')
        hostile_mise = self.put(self.home, '.config/mise/config.toml',
                                '[tools]\ngitleaks = "0.0.0"\n')
        self.put(self.repo, 'mise.toml', '[tools]\ngitleaks = "0.0.0"\n')
        hostile_env = {'GITLEAKS_CONFIG': str(hostile_config),
                       'GITLEAKS_CONFIG_TOML': ALLOW_CONFIG,
                       'GITLEAKS_ENABLE_COMMENTS': 'true',
                       'MISE_CONFIG_FILE': str(hostile_mise),
                       'MISE_ENV': 'hostile',
                       'MISE_GITLEAKS_VERSION': '0.0.0'}
        self.put(self.repo, '.gitleaksignore', '*\n')
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token} # gitleaks:allow\n')
        self.git(self.repo, 'add', '--all')
        self.blocked_commit(env=hostile_env)
        self.commit('controlled suppression attempt', bypass=True)
        secret_commit = self.head()
        self.put(self.repo, '.gitleaksignore', f'{secret_commit}:credentials.env:github-pat:1\n')
        self.put(self.repo, 'credentials.env', 'removed token\n')
        self.commit('clean tip with hostile settings', env=hostile_env)
        self.blocked_push('main', env=hostile_env)

    def install_fake_scanner(self):
        data_dir = Path(self.env.get('MISE_DATA_DIR')
                        or str(Path(self.env['XDG_DATA_HOME']) / 'mise'))
        self.scanner = data_dir / 'installs/gitleaks' / SCANNER_VERSION / 'gitleaks'
        self.assertTrue(self.scanner.resolve().is_relative_to(self.home.resolve()))
        self.scanner.parent.mkdir(parents=True, exist_ok=True)
        scanner = self.scanner
        control = self.temp / 'scanner-mode'
        calls = self.temp / 'scanner-calls.jsonl'
        scanner.write_text(
            '#!/usr/bin/python3\n'
            'import json, os, subprocess, sys\n'
            'from pathlib import Path\n'
            f'control = Path({str(control)!r})\n'
            f'calls = Path({str(calls)!r})\n'
            f'token = {self.token!r}\n'
            'args = sys.argv[1:]\n'
            'if args == ["version"]:\n'
            f'    print({SCANNER_VERSION!r})\n'
            '    raise SystemExit(0)\n'
            'with calls.open("a") as out:\n'
            '    out.write(json.dumps({"args": args, "env": dict(os.environ)}) + "\\n")\n'
            'def option(name):\n'
            '    for index, arg in enumerate(args):\n'
            '        if arg == name:\n'
            '            return args[index + 1]\n'
            '        if arg.startswith(name + "="):\n'
            '            return arg.split("=", 1)[1]\n'
            '    raise SystemExit(3)\n'
            'report = Path(option("--report-path"))\n'
            'mode = control.read_text()\n'
            'finding = {"File": "credentials.env", "Commit": "1" * 40, "RuleID": "github-pat"}\n'
            'print(token)\n'
            'print(token, file=sys.stderr)\n'
            'if mode == "missing-report":\n'
            '    raise SystemExit(0)\n'
            'if mode == "error":\n'
            '    report.write_text(json.dumps(finding) + "\\n")\n'
            '    raise SystemExit(2)\n'
            'if mode == "partial":\n'
            '    report.write_text(json.dumps(finding) + "\\n{" )\n'
            '    raise SystemExit(10)\n'
            'if mode == "unsafe-metadata":\n'
            '    finding["Secret"] = token\n'
            'if mode == "history":\n'
            '    diff = subprocess.run(["/usr/bin/git", "--git-dir", args[1], "log", "-p", "-U0",\n'
            '                           *option("--log-opts").split()], capture_output=True, text=True)\n'
            '    if diff.returncode:\n'
            '        raise SystemExit(2)\n'
            '    if token not in diff.stdout:\n'
            '        mode = "green"\n'
            'if mode == "green":\n'
            '    report.write_text("")\n'
            '    raise SystemExit(0)\n'
            'report.write_text(json.dumps(finding) + "\\n")\n'
            'raise SystemExit(0 if mode == "status-mismatch" else 10)\n'
        )
        scanner.chmod(0o755)
        return control, calls

    def test_staged_diff_excludes_existing_secret_but_push_scans_new_history(self):
        self.env['XDG_DATA_HOME'] = str(self.home / 'custom-data')
        control, _ = self.install_fake_scanner()
        control.write_text('history')
        self.install_local_hooks()
        self.seed()
        self.git(self.repo, 'push', 'origin', 'main')
        self.put(self.repo, 'runtime-generated/dummy.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled secret setup', bypass=True)
        secret_head = self.head()
        self.clear_events()
        self.put(self.repo, 'README', 'unrelated clean edit\n')
        self.commit('unrelated clean edit beyond existing secret')
        self.assertNotEqual(self.head(), secret_head)
        self.assertIn(self.token, self.git(
            self.repo, 'show', 'HEAD:runtime-generated/dummy.env').stdout)
        self.assertEqual(self.events(), [{'hook': 'pre-commit', 'args': [], 'stdin': ''}])
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.git(self.repo, 'add', 'credentials.env')
        self.put(self.repo, 'credentials.env', 'GITHUB_TOKEN=masked\n')
        self.blocked_commit()
        self.assertIn(self.token, self.git(self.repo, 'show', ':credentials.env').stdout)
        self.blocked_push('main')

    def assert_metadata_only_finding(self, result):
        output = result.stdout + result.stderr
        self.assertNotIn(self.token, output)
        self.assertNotIn('GITHUB_TOKEN=', output)
        findings = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        self.assertTrue(findings, 'Rejected secret push must identify the finding using metadata')
        for finding in findings:
            self.assertEqual(set(finding), {'File', 'Commit', 'RuleID'})
            self.assertEqual(finding['RuleID'], 'github-pat')
            self.assertRegex(finding['Commit'], r'^[0-9a-f]{40}$')
            self.assertTrue(finding['File'])

    def check_fetched_upstream_sync_and_fork_secret(self):
        self.install_local_hooks()
        base = self.seed()
        self.git(self.repo, 'push', 'origin', 'main')
        self.git(self.repo, 'fetch', 'origin')
        upstream = self.temp / 'upstream.git'
        self.git(self.temp, 'init', '--bare', '--initial-branch=main', str(upstream))
        self.git(self.repo, 'switch', '-c', 'upstream-source')
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled upstream secret history', bypass=True)
        upstream_tip = self.head()
        self.git(upstream, 'fetch', '--no-tags', str(self.repo),
                 'upstream-source:refs/heads/main')
        self.git(self.repo, 'remote', 'add', 'upstream', str(upstream))
        self.git(self.repo, 'fetch', 'upstream')
        self.assertEqual(self.git(self.repo, 'rev-parse', 'refs/remotes/upstream/main').stdout.strip(),
                         upstream_tip)
        upstream.rename(self.temp / 'offline-upstream.git')
        self.git(self.repo, 'switch', 'main')
        self.git(self.repo, 'merge', '--ff-only', 'upstream/main')
        self.assertEqual(self.head(), upstream_tip)
        self.assertIn(f'refs/heads/main {base}\n', self.refs())
        self.git(self.repo, 'config', '--remove-section', 'remote.upstream')
        self.assertNotIn('upstream', self.git(self.repo, 'remote').stdout.splitlines())
        self.assertEqual(self.git(self.repo, 'rev-parse', 'refs/remotes/upstream/main').stdout.strip(),
                         upstream_tip)
        self.clear_events()
        for refspec in ('main', 'HEAD:refs/heads/upstream-sync-new'):
            with self.subTest(unconfigured_upstream=refspec):
                self.assert_metadata_only_finding(self.blocked_push(refspec))
        self.git(self.repo, 'remote', 'add', 'upstream', str(upstream))
        self.git(self.repo, 'push', 'origin', 'main', 'HEAD:refs/heads/upstream-sync-new')
        remote_refs = self.refs()
        for ref in ('refs/heads/main', 'refs/heads/upstream-sync-new'):
            self.assertIn(f'{ref} {upstream_tip}\n', remote_refs)
        event, = self.events()
        self.assertEqual(event['hook'], 'pre-push')
        self.assertEqual(event['args'], ['origin', str(self.remote)])
        self.assertEqual(set(event['stdin'].splitlines()), {
            f'refs/heads/main {upstream_tip} refs/heads/main {base}',
            f'HEAD {upstream_tip} refs/heads/upstream-sync-new {"0" * 40}',
        })
        self.put(self.repo, 'fork.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled fork-owned secret absent from upstream', bypass=True)
        fork_tip = self.head()
        self.assertNotEqual(fork_tip, upstream_tip)
        self.assertNotIn('fork.env', self.git(
            self.repo, 'ls-tree', '-r', '--name-only', 'upstream/main').stdout.splitlines())
        unrelated = self.temp / 'unrelated.git'
        self.git(self.temp, 'init', '--bare', '--initial-branch=main', str(unrelated))
        self.git(unrelated, 'fetch', '--no-tags', str(self.repo), 'main:refs/heads/main')
        self.git(self.repo, 'remote', 'add', 'unrelated', str(unrelated))
        self.git(self.repo, 'fetch', 'unrelated')
        self.assertEqual(self.git(self.repo, 'rev-parse', 'unrelated/main').stdout.strip(), fork_tip)
        self.clear_events()
        for refspec in ('main', 'HEAD:refs/heads/fork-secret-new'):
            with self.subTest(fork_owned_secret=refspec):
                self.assert_metadata_only_finding(self.blocked_push(refspec))
        self.git(self.remote, 'fetch', '--no-tags', str(self.repo),
                 'main:refs/heads/already-known-secret')
        self.git(self.repo, 'fetch', 'origin')
        self.git(self.repo, 'config', '--remove-section', 'remote.upstream')
        self.assertEqual(self.git(self.repo, 'rev-parse',
                                 'origin/already-known-secret').stdout.strip(), fork_tip)
        self.git(self.repo, 'push', 'origin', 'main', 'HEAD:refs/heads/fork-secret-new')
        remote_refs = self.refs()
        for ref in ('refs/heads/main', 'refs/heads/fork-secret-new'):
            self.assertIn(f'{ref} {fork_tip}\n', remote_refs)
        event, = self.events()
        self.assertEqual(event['hook'], 'pre-push')
        self.assertEqual(event['args'], ['origin', str(self.remote)])
        self.assertEqual(set(event['stdin'].splitlines()), {
            f'refs/heads/main {fork_tip} refs/heads/main {upstream_tip}',
            f'HEAD {fork_tip} refs/heads/fork-secret-new {"0" * 40}',
        })

    def test_fetched_upstream_sync_and_fork_secret_history_algorithm(self):
        control, _ = self.install_fake_scanner()
        control.write_text('history')
        self.check_fetched_upstream_sync_and_fork_secret()

    def test_fetched_upstream_sync_and_fork_secret_real_scanner(self):
        self.require_scanner()
        self.check_fetched_upstream_sync_and_fork_secret()

    def test_missing_original_hooks_skip_python_but_failed_discovery_does_not(self):
        marker = self.temp / 'passthrough-python-called'
        hooks = self.dotfiles / 'cli/git/hooks'
        (hooks / 'secret-guard.py').write_text(
            'import sys\n'
            'from pathlib import Path\n'
            f'Path({str(marker)!r}).write_text("called\\n")\n'
            'sys.exit(71)\n'
        )
        for name in ('post-index-change', 'post-checkout'):
            with self.subTest(hook=name):
                self.assertFalse((self.repo / '.git/hooks' / name).exists())
                self.git(self.repo, 'hook', 'run', name)
                self.assertFalse(marker.exists(), 'Missing original hook must not start Python')
        self.git(self.temp, 'rev-parse', '--path-format=absolute', '--git-common-dir', ok=False)
        result = subprocess.run(
            [str(hooks / 'post-checkout')], cwd=self.temp, env=self.env,
            stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 71, 'Failed discovery must dispatch to Python')
        self.assertEqual(marker.read_text(), 'called\n')

    def test_standard_hooks_preserve_commit_msg_veto_and_checkout_io(self):
        control, calls = self.install_fake_scanner()
        control.write_text('green')
        base = self.seed()
        self.install_local_hooks(names=('commit-msg', 'post-checkout'))
        self.put(self.repo, 'README', 'clean edit checked by commit-msg\n')
        self.commit('commit-msg veto', ok=False, env={'SECRET_GUARD_LOCAL_EXIT': '19'})
        self.assertEqual(self.head(), base)
        expected_commit = {'hook': 'commit-msg', 'args': ['.git/COMMIT_EDITMSG'],
                           'stdin': '', 'cwd': str(self.repo)}
        self.assertEqual(self.events(), [expected_commit])
        self.clear_events()
        self.commit('commit-msg permits clean edit')
        tip = self.head()
        self.assertNotEqual(tip, base)
        self.assertEqual(self.events(), [expected_commit])
        self.git(self.repo, 'branch', 'checkout-target', base)
        self.clear_events()
        control.write_text('error')
        self.scanner.unlink()
        scanner_before = calls.read_text()
        payload = 'checkout stdin remains intact\nsecond line\n'
        result = self.git(self.repo, 'checkout', 'checkout-target', ok=False,
                          env={'SECRET_GUARD_LOCAL_EXIT': '23'}, input_text=payload)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.head(), base)
        self.assertEqual(self.events(), [{
            'hook': 'post-checkout', 'args': [tip, base, '1'],
            'stdin': '', 'cwd': str(self.repo),
        }])
        self.clear_events()
        self.git(self.repo, 'checkout', 'main', input_text=payload)
        self.assertEqual(self.head(), tip)
        self.assertEqual(self.events(), [{
            'hook': 'post-checkout', 'args': [base, tip, '1'],
            'stdin': '', 'cwd': str(self.repo),
        }])
        self.clear_events()
        result = self.git(self.repo, 'hook', 'run', 'post-checkout', '--', tip, base, '1',
                          ok=False, env={'SECRET_GUARD_LOCAL_EXIT': '23'}, input_text=payload)
        self.assertEqual(result.returncode, 23)
        self.assertEqual(self.events(), [{
            'hook': 'post-checkout', 'args': [tip, base, '1'],
            'stdin': '', 'cwd': str(self.repo),
        }])
        self.git(self.remote, 'fetch', '--no-tags', str(self.repo), 'main:refs/heads/main')
        shallow = self.temp / 'shallow-hooks'
        self.git(self.temp, 'clone', '--depth=1', self.remote.as_uri(), str(shallow))
        self.assertEqual(self.git(shallow, 'rev-parse', '--is-shallow-repository').stdout.strip(),
                         'true')
        self.install_local_hooks(shallow, names=('post-checkout',))
        self.clear_events()
        result = self.git(shallow, 'checkout', 'main', ok=False,
                          env={'SECRET_GUARD_LOCAL_EXIT': '23'}, input_text=payload)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.head(shallow), tip)
        self.assertEqual(self.events(), [{
            'hook': 'post-checkout', 'args': [tip, tip, '1'],
            'stdin': '', 'cwd': str(shallow),
        }])
        self.assertEqual(calls.read_text(), scanner_before,
                         'Passthrough hooks must not invoke or require a scanner')

    def test_external_scanner_failures_metadata_isolation_and_chaining(self):
        self.env['MISE_DATA_DIR'] = str(self.home / 'custom-mise-data')
        control, calls = self.install_fake_scanner()
        base = self.seed(bypass=True)
        self.install_local_hooks()
        hostile = self.put(self.repo, '.gitleaks.toml', ALLOW_CONFIG)
        hostile_env = {'GITLEAKS_CONFIG': str(hostile),
                       'GITLEAKS_CONFIG_TOML': ALLOW_CONFIG,
                       'GITLEAKS_ENABLE_COMMENTS': 'true',
                       'MISE_CONFIG_FILE': str(hostile),
                       'MISE_ENV': 'hostile',
                       'MISE_GITLEAKS_VERSION': '0.0.0'}
        self.put(self.repo, 'README', 'clean content for external-tool contract\n')
        self.git(self.repo, 'add', 'README')
        for mode in ('error', 'partial', 'missing-report', 'unsafe-metadata', 'status-mismatch', 'finding'):
            control.write_text(mode)
            commit_result = self.blocked_commit(env=hostile_env)
            push_result = self.blocked_push('main', env=hostile_env)
            for result in (commit_result, push_result):
                self.assertNotIn(self.token, result.stdout + result.stderr, mode)
        control.write_text('green')
        self.git(self.repo, 'commit', '-m', 'external scanner reports success', env=hostile_env)
        tip = self.head()
        self.assertNotEqual(tip, base)
        self.assertEqual(self.events(), [{'hook': 'pre-commit', 'args': [], 'stdin': ''}])
        self.clear_events()
        self.git(self.repo, 'push', 'origin', 'main', env=hostile_env)
        self.assertEqual(self.events(), [{
            'hook': 'pre-push', 'args': ['origin', str(self.remote)],
            'stdin': f'refs/heads/main {tip} refs/heads/main {"0" * 40}\n',
        }])
        self.assertIn(f'refs/heads/main {tip}\n', self.refs())
        invocations = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertTrue(invocations, 'External scanner was never invoked')
        for invocation in invocations:
            args = invocation['args']
            options = {}
            for index, arg in enumerate(args):
                if arg.startswith('--') and '=' in arg:
                    key, value = arg.split('=', 1)
                    options[key] = value
                elif arg.startswith('--') and index + 1 < len(args):
                    options[arg] = args[index + 1]
            self.assertEqual(options.get('--config'), str(self.dotfiles / 'cli/git/hooks/scanner.toml'))
            self.assertIn('--ignore-gitleaks-allow', args)
            scanner_env = invocation['env']
            self.assertEqual(scanner_env.get('PATH'), SYSTEM_PATH)
            self.assertFalse(any(key.startswith(('GITLEAKS_', 'MISE_')) for key in scanner_env))
            self.assertNotEqual(scanner_env.get('HOME'), str(self.home))
            self.assertEqual(scanner_env.get('GIT_CONFIG_NOSYSTEM'), '1')
            self.assertEqual(scanner_env.get('GIT_CONFIG_GLOBAL'), '/dev/null')
        self.put(self.repo, 'credentials.env', f'GITHUB_TOKEN={self.token}\n')
        self.commit('controlled already-remote secret', bypass=True)
        remote_secret = self.head()
        self.git(self.remote, 'fetch', '--no-tags', str(self.repo), remote_secret)
        self.git(self.remote, 'update-ref', 'refs/heads/legacy-secret', remote_secret)
        self.git(self.repo, 'fetch', 'origin')
        self.git(self.repo, 'branch', 'already-remote-new', remote_secret)
        self.git(self.repo, 'tag', 'already-remote-lightweight', remote_secret)
        self.git(self.repo, 'tag', '-a', 'already-remote-annotated',
                 '-m', 'already remote secret history', remote_secret)
        control.write_text('history')
        self.clear_events()
        self.git(self.repo, 'push', 'origin', 'already-remote-new',
                 'already-remote-lightweight', 'already-remote-annotated')
        annotated = self.git(self.repo, 'rev-parse', 'already-remote-annotated').stdout.strip()
        remote_refs = self.refs()
        for ref, oid in (('refs/heads/already-remote-new', remote_secret),
                         ('refs/tags/already-remote-lightweight', remote_secret),
                         ('refs/tags/already-remote-annotated', annotated)):
            self.assertIn(f'{ref} {oid}\n', remote_refs)
        event, = self.events()
        self.assertEqual(event['hook'], 'pre-push')
        self.assertEqual(event['args'], ['origin', str(self.remote)])
        self.assertEqual(set(event['stdin'].splitlines()), {
            f'refs/heads/already-remote-new {remote_secret} refs/heads/already-remote-new {"0" * 40}',
            f'refs/tags/already-remote-lightweight {remote_secret} refs/tags/already-remote-lightweight {"0" * 40}',
            f'refs/tags/already-remote-annotated {annotated} refs/tags/already-remote-annotated {"0" * 40}',
        })
        control.write_text('green')
        (self.repo / 'credentials.env').unlink()
        self.commit('clean snapshot beyond excluded secret')
        clean_tip = self.head()
        self.git(self.repo, 'push', 'origin', 'HEAD:refs/heads/legacy-secret')
        self.assertIn(f'refs/heads/legacy-secret {clean_tip}\n', self.refs())
        old_blob = self.git(self.repo, 'rev-parse', f'{base}:README').stdout.strip()
        self.assertNotEqual(old_blob, self.git(self.repo, 'rev-parse', 'HEAD:README').stdout.strip())
        common = Path(self.git(self.repo, 'rev-parse', '--path-format=absolute',
                               '--git-common-dir').stdout.strip())
        blob_path = common / 'objects' / old_blob[:2] / old_blob[2:]
        self.assertTrue(blob_path.resolve().is_relative_to(self.temp.resolve()))
        self.assertTrue(blob_path.is_file(), 'Fixture needs an unpacked historical blob')
        blob_path.unlink()
        self.git(self.repo, 'cat-file', 'blob', old_blob, ok=False)
        self.put(self.repo, 'README', 'new clean staged content with a broken ancestor\n')
        self.git(self.repo, 'add', 'README')
        staged_blob = self.git(self.repo, 'rev-parse', ':README').stdout.strip()
        staged_path = common / 'objects' / staged_blob[:2] / staged_blob[2:]
        self.assertTrue(staged_path.resolve().is_relative_to(self.temp.resolve()))
        self.assertTrue(staged_path.is_file(), 'Fixture needs an unpacked staged blob')
        staged_path.unlink()
        self.clear_events()
        self.blocked_commit()
        self.blocked_push('HEAD:refs/heads/missing-history-new')

    def test_missing_scanner_fails_closed_for_commit_and_push(self):
        self.seed(bypass=True)
        self.install_local_hooks()
        _, calls = self.install_fake_scanner()
        scanner_content = self.scanner.read_text()
        version_dir = self.scanner.parent
        private_install = self.temp / 'private-scanner-install'
        self.put(self.repo, 'README', 'clean change without a valid scanner\n')
        self.git(self.repo, 'add', 'README')
        for mode in ('missing', 'version-mismatch', 'symlinked-version-directory'):
            with self.subTest(scanner=mode):
                if mode == 'missing':
                    self.scanner.unlink()
                elif mode == 'version-mismatch':
                    self.scanner.write_text(scanner_content.replace(
                        f'print({SCANNER_VERSION!r})', "print('0.0.0')"))
                else:
                    version_dir.rename(private_install)
                    self.assertFalse(private_install.is_symlink())
                    self.assertTrue(private_install.resolve().is_relative_to(self.temp.resolve()))
                    version_dir.symlink_to(private_install, target_is_directory=True)
                try:
                    result = self.blocked_commit()
                    self.assertRegex(result.stdout + result.stderr, '(?i)(gitleaks|scanner)')
                    self.assertIn(f'run: mise install gitleaks@{SCANNER_VERSION}',
                                  result.stdout + result.stderr)
                    result = self.blocked_push('main')
                    self.assertRegex(result.stdout + result.stderr, '(?i)(gitleaks|scanner)')
                    self.assertIn(f'run: mise install gitleaks@{SCANNER_VERSION}',
                                  result.stdout + result.stderr)
                    self.assertFalse(calls.exists(), 'Failed resolution must not invoke a scan')
                    if mode == 'missing':
                        self.assertFalse(self.scanner.exists(), 'Hook must not auto-install a scanner')
                finally:
                    if mode == 'symlinked-version-directory':
                        version_dir.unlink()
                        private_install.rename(version_dir)
                    self.scanner.write_text(scanner_content)
                    self.scanner.chmod(0o755)

    def test_shallow_history_fails_closed_for_commit_and_push(self):
        self.require_scanner()
        self.seed()
        self.put(self.repo, 'README', 'second clean commit\n')
        self.commit('second clean commit')
        self.git(self.repo, 'push', 'origin', 'main')
        self.git(self.remote, 'config', 'receive.shallowUpdate', 'true')
        shallow = self.temp / 'shallow'
        self.git(self.temp, 'clone', '--depth=1', self.remote.as_uri(), str(shallow))
        self.assertEqual(self.git(shallow, 'rev-parse', '--is-shallow-repository').stdout.strip(), 'true')
        self.install_local_hooks(shallow)
        self.put(shallow, 'README', 'clean change with incomplete history\n')
        self.git(shallow, 'add', 'README')
        result = self.blocked_commit(shallow)
        self.assertRegex(result.stdout + result.stderr, '(?i)(shallow|history)')
        result = self.blocked_push('HEAD:refs/heads/shallow-new', repo=shallow)
        self.assertRegex(result.stdout + result.stderr, '(?i)(shallow|history)')


if __name__ == '__main__':
    unittest.main()
