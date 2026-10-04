"""Public CLI checks with no real systemd scopes or priority changes."""

import json
import os
from pathlib import Path
import pty
import subprocess
import sys
import tempfile
import textwrap
import unittest
import uuid


SOURCE = Path(__file__).resolve().parents[1] / "pc-workload.sh.in"


class PcWorkloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.script = self.root / "pc-workload"
        self.script.write_text(
            SOURCE.read_text()
            .replace("@bash@", "/usr/bin/env bash")
            .replace("@systemd_run@", str(self.bin / "systemd-run"))
            .replace("@nice@", str(self.bin / "nice"))
        )
        self.cwd = self.root / "working directory $literal"
        self.cwd.mkdir()
        self.scope_log = self.root / "scope.json"
        self.nice_log = self.root / "nice.json"
        self.env = dict(os.environ)
        self.env.update(
            PATH=f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            PWD=str(self.cwd),
            SCOPE_LOG=str(self.scope_log),
            NICE_LOG=str(self.nice_log),
            WORKLOAD_VALUE="spaces and $HOME ${UNDEFINED} 'quotes'",
        )
        self.executable(
            "systemd-run",
            """
            import json, os, sys
            from pathlib import Path
            args = sys.argv[1:]
            Path(os.environ['SCOPE_LOG']).write_text(json.dumps({
                'argv': args, 'cwd': os.getcwd(), 'env': dict(os.environ),
                'isatty': [os.isatty(fd) for fd in (0, 1, 2)],
            }))
            if 'SCOPE_FAILURE' in os.environ:
                print('scope creation failed', file=sys.stderr)
                sys.exit(int(os.environ['SCOPE_FAILURE']))
            command = args[args.index('--') + 1:]
            os.execvp(command[0], command)
            """,
        )
        self.executable(
            "nice",
            """
            import json, os, sys
            from pathlib import Path
            args = sys.argv[1:]
            Path(os.environ['NICE_LOG']).write_text(json.dumps(args))
            assert args[:2] == ['--adjustment=10', '--'], args
            os.execvp(args[2], args[2:])
            """,
        )
        self.executable(
            "workload",
            """
            import json, os, sys
            print(json.dumps({
                'argv': sys.argv[1:], 'cwd': os.getcwd(),
                'env': dict(os.environ), 'stdin': sys.stdin.read(),
                'isatty': [os.isatty(fd) for fd in (0, 1, 2)],
            }))
            print('workload stderr $literal', file=sys.stderr)
            sys.exit(int(os.environ.get('WORKLOAD_EXIT', '0')))
            """,
        )

    def executable(self, name, body):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
        path.chmod(0o755)
        return path

    def run_cli(self, *args, stdin=""):
        return subprocess.run(
            ["bash", str(self.script), *args],
            cwd=self.cwd,
            env=self.env,
            input=stdin,
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )

    def test_literal_forwarding_and_inherited_context(self):
        args = ["two words", "$HOME", "${WORKLOAD_VALUE}", "", "a\nb", "'quoted'", "--help", "; exit 99"]
        result = self.run_cli("--", "workload", *args, stdin="input $literal\nsecond line\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "workload stderr $literal\n")
        observed = json.loads(result.stdout)
        self.assertEqual(observed["argv"], args)
        self.assertEqual(observed["cwd"], str(self.cwd))
        self.assertEqual(observed["stdin"], "input $literal\nsecond line\n")
        self.assertEqual(observed["isatty"], [False, False, False])
        for key, value in self.env.items():
            if key not in {"SHLVL", "_"}:
                self.assertEqual(observed["env"].get(key), value, key)
        scope = json.loads(self.scope_log.read_text())
        self.assertEqual(scope["cwd"], str(self.cwd))
        self.assertEqual(scope["env"]["PATH"], self.env["PATH"])
        options = scope["argv"][:scope["argv"].index("--")]
        unit = [option for option in options if option.startswith("--unit=")]
        self.assertEqual(len(unit), 1)
        self.assertEqual(
            set(options) - set(unit),
            {"--user", "--scope", "--slice=background.slice", "--collect", "--expand-environment=no"},
        )
        unit_name = unit[0].removeprefix("--unit=")
        self.assertTrue(unit_name.startswith("pc-workload-"))
        self.assertTrue(unit_name.endswith(".scope"))
        parsed = uuid.UUID(unit_name.removeprefix("pc-workload-").removesuffix(".scope"))
        self.assertEqual(parsed.version, 4)
        self.assertEqual(
            json.loads(self.nice_log.read_text()),
            ["--adjustment=10", "--", "workload", *args],
        )
        again = self.run_cli("--", "workload")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertNotIn(unit[0], json.loads(self.scope_log.read_text())["argv"])

    def test_terminal_descriptors_are_inherited(self):
        self.executable(
            "terminal-check",
            """
            import json, os
            print(json.dumps([os.isatty(fd) for fd in (0, 1, 2)]))
            """,
        )
        master, slave = pty.openpty()
        try:
            result = subprocess.run(
                ["bash", str(self.script), "--", "terminal-check"],
                cwd=self.cwd,
                env=self.env,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                check=False,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(os.read(master, 4096)), [True, True, True])
        finally:
            os.close(slave)
            os.close(master)

    def test_workload_exit_status(self):
        self.env["WORKLOAD_EXIT"] = "37"
        result = self.run_cli("--", "workload")
        self.assertEqual(result.returncode, 37)
        self.assertEqual(result.stderr, "workload stderr $literal\n")
        self.assertEqual(json.loads(result.stdout)["argv"], [])

    def test_scope_failure_never_runs_workload_inline(self):
        self.env["SCOPE_FAILURE"] = "53"
        result = self.run_cli("--", "workload")
        self.assertEqual(result.returncode, 53)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "scope creation failed\n")
        self.assertFalse(self.nice_log.exists())

    def test_separator_and_command_are_required(self):
        for args in [(), ("workload",), ("--",), ("--unknown",), ("--help", "workload")]:
            with self.subTest(args=args):
                result = self.run_cli(*args)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertIn("Usage: pc-workload -- COMMAND [ARG...]", result.stderr)
                self.assertFalse(self.scope_log.exists())

    def test_help_does_not_start_scope(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertIn("Usage: pc-workload -- COMMAND [ARG...]", result.stdout)
        self.assertFalse(self.scope_log.exists())


if __name__ == "__main__":
    unittest.main()
