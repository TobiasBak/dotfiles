import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]


STUB = r'''#!/bin/bash
set -eu
name=${0##*/}
printf '%s' "$name" >> "$DOT_STATE/calls"
printf '\t%s' "$@" >> "$DOT_STATE/calls"
printf '\n' >> "$DOT_STATE/calls"
case "$name" in
pacman)
  case "$1" in
    -Qq) cat "$DOT_STATE/packages" ;;
    -Qqe) cat "$DOT_STATE/explicit" ;;
    *) exit 91 ;;
  esac
  ;;
pkexec)
  printf 'pkexec\n' >> "$DOT_STATE/mutations"
  exec "$@"
  ;;
omarchy-pkg-add)
  printf 'packages\n' >> "$DOT_STATE/mutations"
  printf '%s\n' "$@" >> "$DOT_STATE/packages"
  printf '%s\n' "$@" >> "$DOT_STATE/explicit"
  ;;
mise)
  case "$1" in
    exec)
      if [[ ${MISE_AUTO_INSTALL-unset} != 0 || ${MISE_EXEC_AUTO_INSTALL-unset} != 0 ]]; then
        printf 'auto-install\n' >> "$DOT_STATE/mutations"
        touch "$HOME/auto-installed-tool"
      fi
      exit 1
      ;;
    ls) cat "$DOT_STATE/mise.json" ;;
    use|settings|set|install)
      printf 'mise\n' >> "$DOT_STATE/mutations"
      printf '%s\n' "${MISE_MINIMUM_RELEASE_AGE-unset}" >> "$DOT_STATE/release-age"
      exec "$DOT_PYTHON" "$DOT_STATE/update_mise.py" "$@"
      ;;
    *) exit 92 ;;
  esac
  ;;
systemctl)
  [[ "$1" == --user ]] && shift
  case "$1" in
    is-enabled) test -f "$DOT_STATE/enabled-$2" && echo enabled || { echo disabled; exit 1; } ;;
    is-active) test -f "$DOT_STATE/active-$2" && echo active || { echo inactive; exit 3; } ;;
    show)
      if [[ " $* " == *' NeedDaemonReload '* || " $* " == *'NeedDaemonReload'* ]]; then
        if [[ -f "$DOT_STATE/reload" ]]; then echo yes; else echo no; fi
      else
        exit 93
      fi
      ;;
    daemon-reload)
      printf 'reload\n' >> "$DOT_STATE/mutations"
      rm -f "$DOT_STATE/reload"
      ;;
    enable)
      printf 'enable\n' >> "$DOT_STATE/mutations"
      shift
      for unit in "$@"; do
        [[ "$unit" == --* ]] && continue
        touch "$DOT_STATE/enabled-$unit" "$DOT_STATE/active-$unit"
      done
      ;;
    *) exit 94 ;;
  esac
  ;;
omarchy) exit 95 ;;
*) exit 96 ;;
esac
'''


UPDATE_MISE = r'''import json, os, re, sys
from pathlib import Path
path = Path(os.environ["DOT_STATE"]) / "mise.json"
config = Path(os.environ["HOME"]) / ".config/mise/config.toml"
text = config.read_text() if config.exists() else ""
data = json.loads(path.read_text())

def assign(section, key, value):
    global text
    pattern = r'(?ms)^\[' + re.escape(section) + r'\]\n(.*?)(?=^\[|\Z)'
    found = re.search(pattern, text)
    body = found[1] if found else ""
    key = key if re.fullmatch(r'[A-Za-z0-9_-]+', key) else json.dumps(key)
    key_pattern = r'(?m)^' + re.escape(key) + r'\s*=.*$'
    if isinstance(value, dict):
        line = key + ' = { ' + ', '.join(k + ' = ' + json.dumps(v) for k, v in value.items()) + ' }'
    else:
        line = key + ' = ' + json.dumps(value)
    body = re.sub(key_pattern, line, body) if re.search(key_pattern, body) else body + line + '\n'
    table = '[' + section + ']\n' + body
    text = text[:found.start()] + table + text[found.end():] if found else text + '\n' + table

args = sys.argv[1:]
if args[0] == 'use':
    for arg in args[1:]:
        if arg.startswith('-'):
            continue
        tool, version = arg.rsplit('@', 1)
        options = re.fullmatch(r'(.*)\[(.*)\]', tool)
        value = version
        if options:
            tool = options[1]
            pairs = (o.split('=', 1) for o in options[2].split(','))
            value = {'version': version, **{k: json.loads(v) for k, v in pairs}}
        data[tool] = [{'version': version, 'requested_version': version, 'installed': True,
                       'source': {'type': 'mise.toml', 'path': str(config)}}]
        assign('tools', tool, value)
elif args[0] == 'settings':
    value = json.loads(args[3]) if args[3] in ('true', 'false') else args[3]
    assign('settings', args[2], value)
elif args[0] == 'set':
    key, value = args[-1].split('=', 1)
    assign('env', key, value)
elif args[0] == 'install':
    for entry in data[args[1]]:
        entry['installed'] = True
path.write_text(json.dumps(data))
config.parent.mkdir(parents=True, exist_ok=True)
config.write_text(text)
'''


class DotTests(unittest.TestCase):
    def setUp(self):
        cache = Path.home() / '.cache/agent-tmp'
        cache.mkdir(parents=True, exist_ok=True)
        self.temp = Path(tempfile.mkdtemp(prefix='dot-test-', dir=cache))
        self.addCleanup(shutil.rmtree, self.temp)
        self.repo = self.temp / 'dotfiles'
        self.home = self.temp / 'home'
        self.omarchy = self.temp / 'omarchy'
        self.state = self.temp / 'state'
        self.bin = self.temp / 'bin'
        for path in (self.repo, self.home, self.omarchy / 'config',
                     self.omarchy / 'install', self.omarchy / 'bin', self.state, self.bin):
            path.mkdir(parents=True, exist_ok=True)
        self.assertTrue((ROOT / 'dot').is_file(), 'root dot is missing')
        shutil.copy2(ROOT / 'dot', self.repo / 'dot')
        (self.home / '.dotfiles').symlink_to(self.repo, target_is_directory=True)
        for name in ('pacman', 'mise', 'systemctl', 'pkexec', 'omarchy'):
            self.put(self.bin / name, STUB, mode=0o755)
        self.put(self.omarchy / 'bin/omarchy-pkg-add', STUB, mode=0o755)
        for name in ('packages', 'explicit', 'calls', 'mutations'):
            self.put(self.state / name, '')
        self.put(self.state / 'mise.json', '{}')
        self.put(self.state / 'update_mise.py', UPDATE_MISE)
        self.env = dict(os.environ, HOME=str(self.home), OMARCHY_PATH=str(self.omarchy),
                        PATH=f'{self.bin}:/usr/bin:/bin', DOT_STATE=str(self.state),
                        DOT_PYTHON=sys.executable, XDG_CONFIG_HOME=str(self.home / '.config'),
                        XDG_CACHE_HOME=str(self.home / '.cache'),
                        XDG_DATA_HOME=str(self.home / '.local/share'),
                        XDG_STATE_HOME=str(self.home / '.local/state'),
                        TMPDIR=str(self.temp), PYTHONDONTWRITEBYTECODE='1')
        for key in ('MISE_CONFIG_FILE', 'MISE_GLOBAL_CONFIG_FILE', 'MISE_DATA_DIR',
                    'MISE_CONFIG_DIR', 'MISE_ENV'):
            self.env.pop(key, None)

    def put(self, path, text, mode=None):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        if mode is not None:
            path.chmod(mode)
        return path

    def module(self, name, manifest):
        return self.put(self.repo / name / 'module.toml', manifest)

    def run_dot(self, operation='check', *names, code=None, dry_run=False):
        argv = [str(self.repo / 'dot'), operation, '--json']
        if dry_run:
            argv.append('--dry-run')
        argv.extend(names)
        result = subprocess.run(argv, cwd=self.repo, env=self.env, capture_output=True,
                                text=True, stdin=subprocess.DEVNULL, timeout=15)
        if code is not None:
            self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        else:
            self.assertIn(result.returncode, (0, 1), result.stdout + result.stderr)
        if code == 2 and not result.stdout:
            self.assertTrue(result.stderr.strip(), 'Errors need a diagnostic')
            return []
        try:
            output = json.loads(result.stdout)
        except ValueError:
            self.fail(f'Invalid JSON from {argv}: {result.stdout!r} {result.stderr!r}')
        items = output if isinstance(output, list) else output['items']
        self.assertIsInstance(items, list)
        for item in items:
            self.assertTrue({'module', 'kind', 'target', 'state', 'detail', 'fix'} <= item.keys(), item)
        return items

    def calls(self, name=None):
        calls = [line.split('\t') for line in (self.state / 'calls').read_text().splitlines()]
        return [call for call in calls if name is None or call[0] == name]

    def snapshot(self):
        result = {}
        for root in (self.home, self.repo, self.omarchy, self.state):
            for path in (root, *root.rglob('*')):
                if path in (self.state / 'calls',):
                    continue
                metadata = path.lstat()
                payload = os.readlink(path) if path.is_symlink() else (path.read_bytes() if path.is_file() else None)
                result[str(path.relative_to(self.temp))] = (stat.S_IMODE(metadata.st_mode), payload)
        return result

    def assert_clean(self, *names):
        self.assertEqual(self.run_dot('check', *names, code=0), [])

    def test_optional_manifests_exit_codes_and_unknown_table(self):
        self.assert_clean()
        self.assertEqual(self.run_dot('apply', code=0), [])
        self.module('links', '[links]\n"~/.config/sample" = "configs/sample"\n')
        self.put(self.repo / 'configs/sample', 'managed\n')
        self.assertTrue(self.run_dot('check', 'links', code=1))
        self.run_dot('check', 'does-not-exist', code=2)
        self.module('invalid', '[typo]\nvalue = true\n')
        self.run_dot('check', 'invalid', code=2)
        (self.repo / 'invalid/module.toml').unlink()
        self.put(self.repo / 'packages.toml', '[repo]\nsample = "needed"\n')
        (self.bin / 'pacman').unlink()
        (self.bin / 'python3').symlink_to(sys.executable)
        self.env['PATH'] = str(self.bin)
        items = self.run_dot('check', 'packages', code=2)
        self.assertEqual([(i['state'], i['fix']) for i in items], [('error', 'capture')])

    def test_stable_missing_created_before_links_and_foreign_left_untouched(self):
        stable = self.home / '.dotfiles'
        stable.unlink()
        self.module('links', '[links]\n"~/.config/plain" = "links/plain"\n"~/.config/plugins/*" = "links/plugins/*"\n')
        self.put(self.repo / 'links/plain', 'managed\n')
        self.put(self.repo / 'links/plugins/one', 'repo owned\n')
        self.module('desktop', '[omarchy]\n')
        self.put(self.omarchy / 'config/plugins/one', 'template\n')
        self.put(self.repo / 'links/tree/config', 'linked directory content\n')
        self.module('tree', '[links]\n"~/.config/tree" = "links/tree"\n')
        self.put(self.omarchy / 'config/tree/config', 'different template\n')
        self.module('desktop', '[omarchy.append]\n"tree/config" = "must not write through linked parent"\n')
        before = self.snapshot()
        items = self.run_dot('apply', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.assertTrue(any(i['module'] == 'dot' and i['kind'] == 'stable' and i['fix'] == 'apply' for i in items))
        self.run_dot('apply', code=0)
        self.assertEqual(os.readlink(stable), str(self.repo))
        self.assertEqual(os.readlink(self.home / '.config/plain'), str(stable / 'links/plain'))
        self.assertEqual((self.home / '.config/plugins/one').read_text(), 'repo owned\n')
        self.assertEqual((self.repo / 'links/tree/config').read_text(), 'linked directory content\n')
        self.assert_clean()
        for replacement in ('directory', 'dangling', 'foreign'):
            with self.subTest(replacement=replacement):
                stable.unlink()
                if replacement == 'directory':
                    stable.mkdir()
                else:
                    foreign = self.temp / replacement
                    if replacement == 'foreign':
                        foreign.mkdir()
                    stable.symlink_to(foreign)
                before = self.snapshot()
                items = self.run_dot('apply', 'dot', code=1, dry_run=True)
                self.assertEqual(before, self.snapshot())
                self.run_dot('apply', 'dot', code=2)
                self.assertEqual(before, self.snapshot())
                self.assertEqual([(i['kind'], i['fix']) for i in items], [('stable', 'capture')])
                if stable.is_symlink():
                    stable.unlink()
                else:
                    stable.rmdir()
                stable.symlink_to(self.repo)
        alternate = self.temp / 'alternate'
        self.put(alternate / 'dot', '#!/bin/bash\nexit 0\n', mode=0o755)
        stable.unlink()
        stable.symlink_to(alternate)
        self.assert_clean('dot')

    def test_worktree_preview_uses_proposed_sources_and_refuses_real_apply(self):
        stable = self.home / '.dotfiles'
        old_checkout = self.temp / 'main/dotfiles'
        old_checkout.mkdir(parents=True)
        stable.unlink()
        stable.symlink_to(old_checkout)
        self.module('links', '''[links]
"~/.config/plain" = "links/proposed"
"~/.config/plugins/*" = "links/plugins/*"
"~/.agents/skills/*" = "../vault/skills/*"
''')
        self.put(self.repo / 'links/proposed', 'proposed\n')
        self.put(self.repo / 'links/plugins/new', 'new\n')
        self.put(self.home / '.config/plain', 'proposed\n')
        foreign_skill = self.home / '.agents/skills/old'
        foreign_skill.parent.mkdir(parents=True)
        foreign_skill.symlink_to(old_checkout.parent / 'vault/skills/old')
        before = self.snapshot()
        items = self.run_dot('apply', code=1, dry_run=True)
        states = {i['target']: i['state'] for i in items}
        self.assertEqual(states[str(self.home / '.config/plain')], 'real-identical')
        self.assertEqual(states[str(self.home / '.config/plugins/new')], 'missing')
        self.assertEqual(states[str(self.home / '.agents/skills/*')], 'source-missing')
        self.assertTrue(any(i['kind'] == 'stable' and 'pre-merge' in i['detail'] for i in items))
        self.assertEqual(before, self.snapshot())
        self.run_dot('apply', code=2)
        self.assertEqual(before, self.snapshot())
        self.assertEqual((self.state / 'mutations').read_text(), '')

    def test_links_backups_globs_sibling_sources_and_filter(self):
        self.module('links', '''[links]
"~/.config/missing" = "configs/plain"
"~/.config/identical" = "configs/plain"
"~/.config/different" = "configs/plain"
"~/.config/sibling" = "../vault/file"
"~/.config/plugins/*" = "configs/plugins/*"
''')
        source = self.put(self.repo / 'configs/plain', 'managed\n')
        self.put(self.temp / 'vault/file', 'sibling\n')
        self.put(self.repo / 'configs/plugins/new', 'new\n')
        self.put(self.home / '.config/identical', 'managed\n', mode=0o640)
        different = self.put(self.home / '.config/different', 'local\n', mode=0o600)
        directory = self.home / '.config/plugins'
        directory.mkdir()
        (directory / 'stale').symlink_to(self.home / '.dotfiles/configs/plugins/gone')
        (directory / 'new').symlink_to(self.home / '.dotfiles/configs/plugins/gone')
        foreign = self.put(self.temp / 'foreign', 'foreign\n')
        (directory / 'foreign').symlink_to(foreign)
        self.module('other', '[links]\n"~/.config/untouched" = "configs/plain"\n')
        before = self.snapshot()
        self.run_dot('check', 'links', code=1)
        self.assertEqual(before, self.snapshot())
        self.run_dot('apply', 'links', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.assertEqual((self.state / 'mutations').read_text(), '')
        self.run_dot('apply', 'links')
        for name in ('missing', 'identical', 'different'):
            target = self.home / '.config' / name
            self.assertTrue(target.is_symlink())
            self.assertEqual(os.readlink(target), str(self.home / '.dotfiles/configs/plain'))
            self.assertEqual(target.read_bytes(), source.read_bytes())
        self.assertEqual((self.home / '.config/sibling').resolve(), self.temp / 'vault/file')
        backups = list(different.parent.glob('different.dotfiles-backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'local\n')
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        self.assertEqual(list(different.parent.glob('identical.dotfiles-backup-*')), [])
        self.assertFalse((directory / 'stale').is_symlink())
        self.assertTrue((directory / 'new').is_symlink())
        self.assertEqual((directory / 'foreign').resolve(), foreign)
        self.assertFalse((self.home / '.config/untouched').exists())
        self.assert_clean('links')
        self.assertEqual(self.run_dot('apply', 'links', code=0), [])
        self.assertEqual(len(list(different.parent.glob('different.dotfiles-backup-*'))), 1)

    def test_json_and_toml_merge_preserve_foreign_and_replace_lists(self):
        self.module('merge', '''[merge]
"~/.config/sample.json" = "configs/sample.json"
"~/.config/through-link.json" = "configs/sample.json"
"~/.config/sample.toml" = "configs/sample.toml"
''')
        self.put(self.repo / 'configs/sample.json', '{"nested":{"managed":2},"list":[2,3],"boolean-list":[true]}')
        live_json = self.put(self.home / '.config/sample.json',
                             '{"nested":{"managed":1,"foreign":true},"list":[1],"boolean-list":[1],"foreign":"keep"}', mode=0o640)
        referent = self.put(self.temp / 'app-owned.json', '{"foreign":"keep"}', mode=0o640)
        through_link = self.home / '.config/through-link.json'
        through_link.symlink_to(referent)
        self.put(self.repo / 'configs/sample.toml', '''"quoted.key" = "managed"
escaped = "\\u007f😀\\t"
list = [2, 3]
["table.with.dots"]
"key with spaces" = 2
''')
        live_toml = self.put(self.home / '.config/sample.toml', '''"quoted.key" = "old"
foreign = true
list = [1]
["table.with.dots"]
"key with spaces" = 1
foreign = "keep"
''')
        self.run_dot('check', 'merge', code=1)
        before = self.snapshot()
        self.run_dot('apply', 'merge', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.run_dot('apply', 'merge')
        self.assertEqual(json.loads(live_json.read_text()),
                         {'nested': {'managed': 2, 'foreign': True}, 'list': [2, 3], 'boolean-list': [True], 'foreign': 'keep'})
        self.assertIs(json.loads(live_json.read_text())['boolean-list'][0], True)
        self.assertEqual(tomllib.loads(live_toml.read_text()),
                         {'quoted.key': 'managed', 'escaped': '\x7f😀\t', 'foreign': True, 'list': [2, 3],
                          'table.with.dots': {'key with spaces': 2, 'foreign': 'keep'}})
        self.assertFalse(through_link.is_symlink())
        self.assertEqual(referent.read_text(), '{"foreign":"keep"}')
        self.assertEqual(stat.S_IMODE(through_link.stat().st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(live_json.stat().st_mode), 0o640)
        self.assert_clean('merge')
        data = json.loads(live_json.read_text())
        data['boolean-list'] = [1]
        live_json.write_text(json.dumps(data))
        self.assertTrue(self.run_dot('check', 'merge', code=1))
        self.run_dot('apply', 'merge', code=0)
        self.assertIs(json.loads(live_json.read_text())['boolean-list'][0], True)
        before = self.snapshot()
        self.run_dot('apply', 'merge', code=0)
        self.assertEqual(before, self.snapshot())

    def test_assertions_run_in_home_apply_once_and_manual_fix(self):
        self.module('assertions', '''[[assert]]
name = "automatic repair"
check = "test -f repaired && test \\\"$PWD\\\" = \\\"$HOME\\\""
apply = "printf x >> attempts; touch repaired"
[[assert]]
name = "manual repair"
check = "test -f manual"
fix = "touch manual"
[[assert]]
name = "expected output"
check = "printf ready"
expect = "ready"
fix = "printf ready"
''')
        self.run_dot('check', 'assertions', code=1)
        before = self.snapshot()
        self.run_dot('apply', 'assertions', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.run_dot('apply', 'assertions')
        self.assertEqual((self.home / 'attempts').read_text(), 'x')
        items = self.run_dot('check', 'assertions', code=1)
        self.assertTrue(any(item['fix'] == 'tobias' and item.get('command') == 'touch manual' for item in items), items)
        self.assertFalse((self.home / 'manual').exists())
        self.put(self.home / 'manual', '')
        self.assert_clean('assertions')
        self.run_dot('apply', 'assertions', code=0)
        self.assertEqual((self.home / 'attempts').read_text(), 'x')
        self.module('missing_tool', '''[[assert]]
name = "missing tool stays absent during checks"
check = "mise exec absent-tool -- absent-command"
apply = "mise exec absent-tool -- absent-command"
''')
        before = self.snapshot()
        self.run_dot('check', 'missing_tool', code=1)
        self.run_dot('apply', 'missing_tool', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.home / 'auto-installed-tool').exists())
        self.run_dot('apply', 'missing_tool', code=2)
        self.assertTrue((self.home / 'auto-installed-tool').exists())

    def test_retired_pi_snapshot_disable_preserves_other_extensions(self):
        helper = self.repo / 'agents/pi/disable-workspace-view.py'
        helper.parent.mkdir(parents=True)
        shutil.copy2(ROOT / 'agents/pi/disable-workspace-view.py', helper)
        self.put(self.repo / 'agents/pi/settings.json', (ROOT / 'agents/pi/settings.json').read_text())
        self.module('pi', '''[merge]
"~/.pi/agent/settings.json" = "agents/pi/settings.json"
[[assert]]
name = "retired snapshot disabled"
check = 'python3 "{repo}/agents/pi/disable-workspace-view.py" --check "{siblings}/pi-workspace-view/src/snapshot.ts"'
apply = 'python3 "{repo}/agents/pi/disable-workspace-view.py" "{siblings}/pi-workspace-view/src/snapshot.ts"'
''')
        snapshot = self.put(self.repo.parent / 'pi-workspace-view/src/snapshot.ts', 'retired extension\n')
        live = self.home / '.pi/agent/settings.json'
        other = ['/other/context-experiments/context.ts', '-builtin:mcp']
        original = {'theme': 'local-theme', 'foreign': {'keep': True},
                    'extensions': [str(snapshot), '+' + str(snapshot),
                                   os.path.relpath(snapshot, live.parent), *other]}
        self.put(live, json.dumps(original), mode=0o600)
        before = self.snapshot()
        self.run_dot('apply', 'pi', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.run_dot('apply', 'pi', code=0)
        actual = json.loads(live.read_text())
        self.assertEqual(actual['extensions'], other)
        self.assertEqual(actual['theme'], original['theme'])
        self.assertEqual(actual['foreign'], original['foreign'])
        self.assertEqual(stat.S_IMODE(live.stat().st_mode), 0o600)
        self.assertEqual(snapshot.read_text(), 'retired extension\n')
        before = self.snapshot()
        self.run_dot('apply', 'pi', code=0)
        self.assertEqual(before, self.snapshot())

    def test_assertion_manifest_requires_exactly_one_remedy(self):
        for body in ('', 'apply = "true"\nfix = "true"\n'):
            with self.subTest(body=body):
                self.module('invalid', '[[assert]]\nname = "invalid remedy"\ncheck = "false"\n' + body)
                self.run_dot('check', 'invalid', code=2)

    def test_packages_bulk_install_base_exclusion_aur_and_capture(self):
        self.put(self.repo / 'packages.toml', '''[repo]
ripgrep = "search"
fd = "find"
[aur]
special-aur = "manual package"
[installer]
custom-installer = "installed externally"
''')
        self.put(self.omarchy / 'install/base.packages', 'base-package\n')
        self.put(self.state / 'packages', 'base-package\ncustom-installer\nlocal-package\n')
        self.put(self.state / 'explicit', 'base-package\ncustom-installer\nlocal-package\n')
        items = self.run_dot('check', code=1)
        self.assertTrue(any('special-aur' in str(item) and item['fix'] == 'tobias' for item in items), items)
        self.assertTrue(any('local-package' in str(item) and item['fix'] == 'capture' for item in items), items)
        self.assertFalse(any(item['fix'] == 'capture' and 'base-package' in str(item) for item in items), items)
        before = self.snapshot()
        self.run_dot('apply', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.calls('pkexec'), [])
        self.run_dot('apply')
        installs = self.calls('pkexec')
        self.assertEqual(len(installs), 1, installs)
        self.assertEqual(installs[0][1], str(self.omarchy / 'bin/omarchy-pkg-add'))
        self.assertEqual(set(installs[0][2:]), {'ripgrep', 'fd'})
        items = self.run_dot('check', code=1)
        self.assertFalse(any(item['fix'] == 'apply' and ('ripgrep' in str(item) or "'fd'" in str(item)) for item in items), items)
        self.put(self.state / 'packages', 'base-package\ncustom-installer\nripgrep\nfd\nspecial-aur\n')
        self.put(self.state / 'explicit', 'base-package\ncustom-installer\nripgrep\nfd\nspecial-aur\n')
        self.assert_clean()

    def test_omarchy_templates_append_merge_capture_and_link_exclusion(self):
        self.module('desktop', '''[omarchy.append]
"hypr/hyprland.conf" = "source = ~/.config/hypr/custom.conf"
[omarchy.merge]
"app/settings.json" = "desktop/settings.json"
''')
        self.put(self.repo / 'desktop/settings.json', '{"managed":{"value":2}}')
        self.put(self.omarchy / 'config/hypr/hyprland.conf', 'baseline\n')
        self.put(self.omarchy / 'config/app/settings.json', '{"managed":{"value":1},"default":true}')
        self.put(self.omarchy / 'config/plain/config', 'template\n')
        self.put(self.omarchy / 'config/linked/config', 'template linked\n')
        live_append = self.put(self.home / '.config/hypr/hyprland.conf', 'baseline\n')
        live_merge = self.put(self.home / '.config/app/settings.json',
                              '{"managed":{"value":1},"default":true,"foreign":{"keep":1}}')
        self.put(self.home / '.config/plain/config', 'locally modified\n')
        self.module('linked', '[links]\n"~/.config/linked/config" = "linked/config"\n')
        self.put(self.repo / 'linked/config', 'repo owned\n')
        linked = self.home / '.config/linked/config'
        linked.parent.mkdir(parents=True)
        linked.symlink_to(self.home / '.dotfiles/linked/config')
        items = self.run_dot('check', 'desktop', code=1)
        self.assertFalse(any('linked/config' in item['target'] for item in items), items)
        before = self.snapshot()
        self.run_dot('apply', 'desktop', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.run_dot('apply', 'desktop')
        self.assertEqual(live_append.read_text(), 'baseline\nsource = ~/.config/hypr/custom.conf\n')
        self.assertEqual(json.loads(live_merge.read_text()),
                         {'managed': {'value': 2}, 'default': True, 'foreign': {'keep': 1}})
        self.run_dot('apply', 'desktop')
        self.assertEqual(live_append.read_text().count('source = ~/.config/hypr/custom.conf'), 1)
        items = self.run_dot('check', code=1)
        captures = [item for item in items if item['fix'] == 'capture']
        plain = [item for item in captures if 'plain/config' in item['target']]
        self.assertEqual(len(plain), 1, items)
        self.assertIn('diff', plain[0])
        self.assertIn('locally modified', plain[0]['diff'])
        self.assertTrue(any('app/settings.json' in item['target'] for item in captures), items)
        self.assertFalse(any('hyprland.conf' in item['target'] for item in captures), items)
        live_merge.write_text('{"managed":{"value":2},"default":true}')
        items = self.run_dot('check', code=1)
        self.assertFalse(any('app/settings.json' in item['target'] and item['fix'] == 'capture' for item in items), items)
        live_append.write_text('locally modified\nsource = ~/.config/hypr/custom.conf\n')
        items = self.run_dot('check', code=1)
        self.assertTrue(any('hyprland.conf' in item['target'] and item['fix'] == 'capture' for item in items), items)
        self.assertEqual(linked.read_text(), 'repo owned\n')

    def test_systemd_reload_then_enable_disabled_and_inactive_units(self):
        self.module('services', '''[links]
"~/.config/systemd/user/new.service" = "services/new.service"
"~/.config/systemd/user/linked.service.d/override.conf" = "services/override.conf"
[systemd]
enable = ["new.service", "inactive.timer", "disabled.timer", "healthy.timer"]
''')
        self.put(self.repo / 'services/new.service', '[Service]\nExecStart=/bin/true\n')
        self.put(self.repo / 'services/override.conf', '[Service]\nEnvironment=TEST=1\n')
        for unit in ('inactive.timer', 'healthy.timer'):
            self.put(self.state / f'enabled-{unit}', '')
        for unit in ('disabled.timer', 'healthy.timer'):
            self.put(self.state / f'active-{unit}', '')
        before = self.snapshot()
        self.run_dot('apply', 'services', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.assertEqual((self.state / 'mutations').read_text(), '')
        self.run_dot('apply', 'services')
        calls = self.calls('systemctl')
        reloads = [index for index, call in enumerate(calls) if 'daemon-reload' in call]
        enables = [(index, call) for index, call in enumerate(calls) if 'enable' in call]
        self.assertEqual(len(reloads), 1, calls)
        self.assertTrue(enables, calls)
        for index, call in enables:
            self.assertLess(reloads[0], index)
            self.assertIn('--user', call)
            self.assertIn('--now', call)
            self.assertNotIn('healthy.timer', call)
        enabled = {arg for _, call in enables for arg in call if arg.endswith(('.service', '.timer'))}
        self.assertEqual(enabled, {'new.service', 'inactive.timer', 'disabled.timer'})
        self.assert_clean('services')
        self.put(self.state / 'calls', '')
        self.run_dot('apply', 'services', code=0)
        self.assertFalse(any('enable' in call or 'daemon-reload' in call for call in self.calls('systemctl')))
        dropin = self.home / '.config/systemd/user/linked.service.d/override.conf'
        dropin.unlink()
        dropin.write_text('[Service]\nEnvironment=TEST=1\n')
        self.put(self.state / 'calls', '')
        self.run_dot('apply', 'services')
        calls = self.calls('systemctl')
        self.assertEqual(sum('daemon-reload' in call for call in calls), 1, calls)
        self.assertFalse(any('enable' in call for call in calls), calls)
        self.assert_clean('services')
        (self.state / 'active-new.service').unlink()
        self.put(self.state / 'reload', '')
        self.put(self.state / 'calls', '')
        self.run_dot('apply', 'services')
        calls = self.calls('systemctl')
        self.assertLess(next(i for i, call in enumerate(calls) if 'daemon-reload' in call),
                        next(i for i, call in enumerate(calls) if 'enable' in call))
        self.assert_clean('services')

    def test_stale_glob_systemd_unit_removal_reloads(self):
        self.module('services', '[links]\n"~/.config/systemd/user/*" = "services/units/*"\n')
        (self.repo / 'services/units').mkdir()
        stale = self.home / '.config/systemd/user/old.service'
        stale.parent.mkdir(parents=True)
        stale.symlink_to(self.home / '.dotfiles/services/units/old.service')
        self.run_dot('apply', 'services', code=0)
        self.assertFalse(stale.is_symlink())
        self.assertEqual([call for call in self.calls('systemctl') if 'daemon-reload' in call],
                         [['systemctl', '--user', 'daemon-reload']])

    def test_mise_links_preserve_foreign_content_and_install_missing_tools(self):
        managed = '''[tools]
python = "3.14"
# Keep backend options and comments in the authoritative file.
"npm:built" = { version = "latest", allow_builds = "built" }
"github:example/lazy-cli" = { version = "path:~/tools/lazy-cli", lazy = true, lazy_bins = ["lazy-cli"] }
node = "26.8.2"
[settings]
experimental = true
[env]
PROJECT_FLAG = "enabled"
'''
        self.put(self.repo / 'mise.toml', managed)
        self.put(self.repo / 'mise.lock', '[tools.python]\nversion = "3.14"\n')
        live_path = self.home / '.config/mise/config.toml'
        foreign = '''[tools]
python = "3.13"
unknown = "1"
[settings]
foreign = true
[env]
FOREIGN = "keep"
'''
        self.put(live_path, foreign)
        lock_path = live_path.parent / 'mise.lock'
        old_lock = '[tools.python]\nversion = "3.13"\n'
        self.put(lock_path, old_lock)
        local_path = live_path.parent / 'config.local.toml'
        local = '[tools]\n"npm:t3" = "nightly"\n'
        self.put(local_path, local)
        self.put(self.state / 'mise.json', json.dumps({
            name: [{'version': version, 'requested_version': version, 'installed': False,
                    'source': {'type': 'mise.toml', 'path': str(live_path)}}]
            for name, version in [('python', '3.14'), ('npm:built', 'latest'),
                                  ('node', '26.8.2'), ('github:example/lazy-cli', 'path:~/tools/lazy-cli')]
        }))
        items = self.run_dot('check', 'mise', code=1)
        self.assertEqual({item['target'] for item in items if item['kind'] == 'link'},
                         {str(live_path), str(lock_path)})
        before = self.snapshot()
        self.run_dot('apply', 'mise', code=1, dry_run=True)
        self.assertEqual(before, self.snapshot())
        self.assertEqual((self.state / 'mutations').read_text(), '')
        self.run_dot('apply', 'mise', code=0)
        self.assertEqual(live_path.readlink(), self.home / '.dotfiles/mise.toml')
        self.assertEqual(lock_path.readlink(), self.home / '.dotfiles/mise.lock')
        self.assertEqual(live_path.read_text(), managed)
        self.assertEqual(lock_path.read_bytes(), (self.repo / 'mise.lock').read_bytes())
        self.assertEqual([p.read_text() for p in live_path.parent.glob('config.toml.dotfiles-backup-*')],
                         [foreign])
        self.assertEqual([p.read_text() for p in live_path.parent.glob('mise.lock.dotfiles-backup-*')],
                         [old_lock])
        self.assertEqual(local_path.read_text(), local)
        installs = [call for call in self.calls('mise') if call[1] == 'install']
        self.assertEqual(installs, [['mise', 'install', 'github:example/lazy-cli'],
                                   ['mise', 'install', 'node'], ['mise', 'install', 'npm:built'],
                                   ['mise', 'install', 'python']])
        self.assertFalse(any(call[1] in ('use', 'settings', 'set') for call in self.calls('mise')))
        self.assertIn(['mise', 'ls', '--global', '--json'], self.calls('mise'))
        before = self.snapshot()
        self.run_dot('apply', 'mise', code=0)
        self.assertEqual(before, self.snapshot())
        result = subprocess.run(['mise', 'use', '-g', 'python@3.15'], cwd=self.home,
                                env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(live_path.is_symlink())
        self.assertEqual(tomllib.loads((self.repo / 'mise.toml').read_text())['tools']['python'], '3.15')
        self.assertIn('# Keep backend options and comments', live_path.read_text())
        self.run_dot('check', 'mise', code=0)
        self.put(self.repo / 'mise.toml', '[tools]\npython = { version = false, lazy = true }\n')
        self.run_dot('check', 'mise', code=2)


if __name__ == '__main__':
    unittest.main()
