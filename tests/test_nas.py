import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
CHECK = REPO / "desktop/nas/check.py"
DECLARATIONS = ("mnt-nas.mount", "mnt-nas.automount")
PROPERTIES = {"FragmentPath", "DropInPaths", "NeedDaemonReload", "UnitFileState", "ActiveState"}
MUTATIONS = {"start", "stop", "restart", "reload", "reload-or-restart", "enable", "disable",
             "reenable", "mask", "unmask", "link", "revert", "preset", "set-property",
             "daemon-reload", "daemon-reexec", "edit", "kill", "isolate", "import", "cat"}
SECRET = "nas-test-password"

FAKE_SYSTEMCTL = """#!{python}
import json
from pathlib import Path
import sys

LOG = Path({log})
FIXTURES = Path({fixtures})
argv = sys.argv[1:]
with LOG.open("a") as handle:
    handle.write(json.dumps(argv) + "\\n")

if "show" not in argv:
    sys.exit(97)

properties, unit, values = [], None, False
index = 0
while index < len(argv):
    token = argv[index]
    if token in ("--value", "-V"):
        values = True
    elif token in ("-p", "--property"):
        index += 1
        properties.extend(argv[index].split(","))
    elif token.startswith("--property="):
        properties.extend(token.split("=", 1)[1].split(","))
    elif not token.startswith("-") and token != "show" and unit is None:
        unit = token
    index += 1

fixture = FIXTURES / unit if unit else None
if fixture is None or not fixture.exists():
    for suffix in (".mount", ".automount", ".service"):
        if unit and (FIXTURES / (unit + suffix)).exists():
            fixture = FIXTURES / (unit + suffix)
            break
if fixture is None or not fixture.exists():
    loaded = {{"LoadState": "not-found"}}
else:
    loaded = json.loads(fixture.read_text())
for name in properties or sorted(loaded):
    print(name if values else name + "=" + loaded.get(name, ""))
"""


class NasCheckTests(unittest.TestCase):
    def setUp(self):
        absent = [str(path) for path in (CHECK, *(CHECK.parent / name for name in DECLARATIONS))
                  if not path.exists()]
        if absent:
            self.fail("the NAS checker and its declarations must land together: " + ", ".join(absent))
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="nas-check-", dir=scratch))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.home = self.root / "home"
        self.unit_dir = self.root / "systemd/system"
        self.unit_dir.mkdir(parents=True)
        self.home.mkdir()
        self.calls_log = self.root / "calls"
        self.fixtures = self.root / "fixtures"
        self.fixtures.mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        systemctl = bin_dir / "systemctl"
        systemctl.write_text(FAKE_SYSTEMCTL.format(python=sys.executable,
                                                   log=json.dumps(str(self.calls_log)),
                                                   fixtures=json.dumps(str(self.fixtures))))
        systemctl.chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.home), "PATH": str(bin_dir)}
        self.env.pop("XDG_CONFIG_HOME", None)
        self.restore_declarations()
        self.loaded()

    def restore_declarations(self):
        shutil.rmtree(self.unit_dir / (DECLARATIONS[0] + ".d"), ignore_errors=True)
        for name in DECLARATIONS:
            (self.unit_dir / name).unlink(missing_ok=True)
            shutil.copyfile(CHECK.parent / name, self.unit_dir / name)
            (self.unit_dir / name).chmod(0o644)

    def loaded(self, mount_active="active"):
        self.properties("mnt-nas.mount", FragmentPath=str(self.unit_dir / "mnt-nas.mount"),
                        DropInPaths="", NeedDaemonReload="no", UnitFileState="static",
                        ActiveState=mount_active)
        self.properties("mnt-nas.automount", FragmentPath=str(self.unit_dir / "mnt-nas.automount"),
                        DropInPaths="", NeedDaemonReload="no", UnitFileState="enabled",
                        ActiveState="active")

    def properties(self, unit, **values):
        path = self.fixtures / unit
        loaded = json.loads(path.read_text()) if path.exists() else {}
        loaded.update(values)
        path.write_text(json.dumps(loaded) + "\n")

    def credentials(self, mode=0o600, text=SECRET + "\n", symlink=False):
        path = self.home / ".config/samba/nas.credentials"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        if symlink:
            target = self.root / "credentials-real"
            target.write_text(text)
            target.chmod(0o600)
            path.symlink_to(target)
            return path
        path.write_text(text)
        path.chmod(mode)
        return path

    def check(self, *args, env=None):
        return subprocess.run([sys.executable, str(CHECK), *args], env=env or self.env,
                              cwd=REPO, capture_output=True, text=True, timeout=20)

    def units(self, *extra, env=None):
        return self.check("units", "--unit-dir", str(self.unit_dir),
                          "--owner-uid", str(os.getuid()), "--owner-gid", str(os.getgid()),
                          *extra, env=env)

    def calls(self):
        if not self.calls_log.exists():
            return []
        return [json.loads(line) for line in self.calls_log.read_text().splitlines() if line]

    def snapshot(self):
        # The call log is our own instrument; everything the fake owns must survive untouched.
        state = []
        for path in [self.root, *sorted(self.root.rglob("*"))]:
            relative = str(path.relative_to(self.root))
            if relative == self.calls_log.name:
                continue
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                state.append((relative, "link", os.readlink(path)))
            elif stat.S_ISDIR(info.st_mode):
                state.append((relative, "dir", ""))
            else:
                state.append((relative, oct(stat.S_IMODE(info.st_mode)),
                              hashlib.sha256(path.read_bytes()).hexdigest()))
        return state

    def assert_read_only_systemctl(self):
        calls = self.calls()
        self.assertTrue(calls, "the checker must read loaded unit state through systemctl")
        requested = set()
        for argv in calls:
            self.assertIn("show", argv, f"systemctl must only be used read-only: {argv}")
            self.assertFalse(set(argv) & MUTATIONS, f"systemctl must only be used read-only: {argv}")
            index = 0
            while index < len(argv):
                token = argv[index]
                if token in ("-p", "--property"):
                    requested.update(argv[index + 1].split(","))
                    index += 2
                    continue
                if token.startswith("--property="):
                    requested.update(token.split("=", 1)[1].split(","))
                index += 1
        self.assertLessEqual(PROPERTIES, requested,
                             "the contract properties must come from systemctl show")
        self.assertLessEqual(set(DECLARATIONS), {token for argv in calls for token in argv})

    def test_units_accept_matching_declarations_through_a_mount_outage(self):
        for mount_active in ("active", "inactive", "failed"):
            with self.subTest(mount_active=mount_active):
                self.loaded(mount_active=mount_active)
                before = self.snapshot()
                result = self.units()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.snapshot(), before, "the check must not mutate what it inspects")
        self.assert_read_only_systemctl()

    def test_units_report_drift_for_each_divergence(self):
        mount, automount = DECLARATIONS

        def edited():
            (self.unit_dir / mount).write_text("# edited away from the repo by hand\n")

        def unreadable_by_others():
            (self.unit_dir / mount).chmod(0o600)

        def symlinked():
            (self.unit_dir / automount).unlink()
            target = self.root / "automount-declaration"
            shutil.copyfile(CHECK.parent / automount, target)
            target.chmod(0o644)
            (self.unit_dir / automount).symlink_to(target)

        def override():
            dropin = self.unit_dir / (mount + ".d")
            dropin.mkdir()
            (dropin / "override.conf").write_text("[Mount]\nOptions=ro\n")
            self.properties(mount, DropInPaths=str(dropin / "override.conf"))

        def stale_daemon():
            self.properties(automount, NeedDaemonReload="yes")

        def disabled():
            self.properties(automount, UnitFileState="disabled")

        def inactive():
            self.properties(automount, ActiveState="inactive")

        owner = ("owner", "uid", "gid", "group", mount, automount)
        cases = [
            (f"{mount} absent", lambda: (self.unit_dir / mount).unlink(), (), (mount,)),
            ("declaration edited away from the repo", edited, (), (mount,)),
            ("declaration not 0644", unreadable_by_others, (), (mount,)),
            (f"{automount} replaced by a symlink", symlinked, (), (automount,)),
            ("local override drop-in", override, (), (mount,)),
            ("systemd never reloaded the declaration", stale_daemon, (), (automount,)),
            ("automount not enabled", disabled, (), (automount,)),
            ("automount not active", inactive, (), (automount,)),
            ("declarations owned by somebody else", lambda: None,
             ("--owner-uid", str(os.getuid() + 1)), owner),
            ("declarations in the wrong group", lambda: None,
             ("--owner-gid", str(os.getgid() + 1)), owner),
        ]
        for label, diverge, extra, tokens in cases:
            with self.subTest(label=label):
                self.restore_declarations()
                self.loaded()
                diverge()
                before = self.snapshot()
                result = self.units(*extra)
                output = result.stdout + result.stderr
                self.assertEqual(result.returncode, 1, output)
                self.assertTrue(output.strip(), "drift must say what drifted")
                self.assertTrue(any(token in output for token in tokens), output)
                self.assertEqual(self.snapshot(), before, "the check must not mutate what it inspects")
        self.restore_declarations()
        self.loaded()
        self.assertEqual(self.units().returncode, 0, "the host stays clean once every divergence is gone")

    def test_credentials_require_a_private_nonempty_regular_file(self):
        cases = [
            ("never created", lambda: self.credentials().unlink(), 1),
            ("empty", lambda: self.credentials(text=""), 1),
            ("a symlink to the real thing", lambda: self.credentials(symlink=True), 1),
            ("readable by the group", lambda: self.credentials(mode=0o640), 1),
            ("readable by everyone", lambda: self.credentials(mode=0o604), 1),
            ("private but not writable", lambda: self.credentials(mode=0o400), 1),
            ("private and nonempty", lambda: self.credentials(), 0),
        ]
        path = self.home / ".config/samba/nas.credentials"
        for label, build, code in cases:
            with self.subTest(label=label):
                build()
                before = self.snapshot()
                for args in (("credentials", "--path", str(path)), ("credentials",)):
                    result = self.check(*args)
                    output = result.stdout + result.stderr
                    self.assertEqual(result.returncode, code, output)
                    self.assertNotIn(SECRET, output, "credential contents must never be disclosed")
                    self.assertEqual(self.snapshot(), before,
                                     "the credential check must not rewrite the file")

    def test_missing_systemctl_is_an_error_not_drift(self):
        empty = self.root / "no-bin"
        empty.mkdir()
        result = self.units(env={**self.env, "PATH": str(empty)})
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertTrue((result.stdout + result.stderr).strip(), "the operator must be told why")