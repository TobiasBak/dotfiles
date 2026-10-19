import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "agents/windows-vm/win-vm"
HEADER = " SESSIONNAME USERNAME ID STATE TYPE DEVICE\n"


class WinVmReadinessTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="win-vm-readiness-", dir=scratch)
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        tools = self.home / "bin"
        tools.mkdir()
        driver = tools / "driver"
        driver.write_text("""#!/usr/bin/python3
import json, os
from pathlib import Path
import sys
home = Path(os.environ['HOME'])
name = Path(sys.argv[0]).name
with (home / 'calls.jsonl').open('a') as file:
    file.write(json.dumps([name, *sys.argv[1:]]) + '\\n')
if name == 'docker':
    print('running|2026-10-11T20:00:00Z|172.18.0.2|/persistent/storage')
    sys.exit(0)
if name == 'scp':
    sys.exit(0)
reply = json.loads((home / 'reply.json').read_text())
sys.stdout.write(reply['out'])
sys.stderr.write(reply['err'])
sys.exit(reply['code'])
""")
        driver.chmod(0o755)
        for name in ("docker", "ssh", "scp"):
            (tools / name).symlink_to(driver)
        keys = self.home / ".keys"
        keys.mkdir()
        (keys / "windows-vm.env").write_text("WINDOWS_VM_USERNAME=tb\n")
        self.env = {**os.environ, "HOME": str(self.home), "PATH": str(tools)}
        self.env.pop("WIN_VM_LEASE", None)
        self.reply()

    def reply(self, code=0, out=HEADER + " console tb 1 Active\n", err=""):
        (self.home / "reply.json").write_text(json.dumps({"code": code, "out": out, "err": err}))
        (self.home / "calls.jsonl").unlink(missing_ok=True)

    def cli(self, *arguments):
        return subprocess.run([sys.executable, str(CLI), *arguments], env=self.env,
                              capture_output=True, text=True, timeout=5)

    def calls(self, tool):
        return [call[1:] for call in map(json.loads, (self.home / "calls.jsonl").read_text().splitlines())
                if call[0] == tool]

    def test_ssh_and_sftp_are_hermetic_and_keep_transport_guards(self):
        source = self.home / "input.txt"
        source.write_text("synthetic input")
        for arguments, tool in [(("exec", "exit 0"), "ssh"),
                                (("put", str(source), r"C:\Temp\input.txt"), "scp"),
                                (("get", r"C:\Temp\input.txt", str(self.home / "output.txt")), "scp")]:
            with self.subTest(arguments=arguments):
                self.reply(out="")
                result = self.cli(*arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = self.calls(tool)
                self.assertEqual(len(calls), 1)
                argv = calls[0]
                self.assertEqual(argv[:4], ["-F", "none", "-i", str(self.home / ".keys/windows-vm-agent")])
                options = [argv[i + 1] for i, value in enumerate(argv[:-1]) if value == "-o"]
                self.assertEqual(options, ["IdentitiesOnly=yes", "BatchMode=yes", "ConnectTimeout=5",
                                          "HostKeyAlias=omarchy-windows-vm",
                                          f"UserKnownHostsFile={self.home / '.keys/windows-vm-known_hosts'}",
                                          "StrictHostKeyChecking=accept-new"])

    def test_local_client_errors_end_readiness_on_the_first_observation(self):
        for error in ["Bad owner or permissions on /etc/ssh/ssh_config.d/synthetic.conf",
                      'Load key "synthetic-agent": bad permissions',
                      "ssh: connect to host 172.18.0.2 port 22: Permission denied"]:
            with self.subTest(error=error):
                self.reply(code=255, out="", err=error + "\n")
                result = self.cli("up", "--timeout", "900")
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(error, result.stderr)
                self.assertNotIn("timed out waiting", result.stderr)
                self.assertEqual(len(self.calls("ssh")), 1)

    def test_unready_transport_is_not_a_local_configuration_failure(self):
        self.reply(code=255, out="", err="ssh: connect to host 172.18.0.2 port 22: Connection refused\n")
        result = self.cli("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        info = json.loads(result.stdout)
        self.assertFalse(info["ssh"])
        self.assertIsNone(info["session"])

    def test_session_query_failure_is_not_reported_as_no_session(self):
        self.reply(code=1, out="", err="synthetic query failure\n")
        result = self.cli("status")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("guest session query invalid (1):", result.stderr)
        self.assertIn("synthetic query failure", result.stderr)

    def test_native_exit_one_with_a_valid_active_table_is_ready(self):
        self.reply(code=1)
        result = self.cli("up", "--timeout", "900")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["session"]["state"], "console")
        self.assertEqual(len(self.calls("ssh")), 1)

    def test_empty_and_garbled_tables_fail_loudly(self):
        for code in (0, 1):
            for output in ("", "garbled native output", HEADER, HEADER + "not a session row\n"):
                with self.subTest(code=code, output=output):
                    self.reply(code=code, out=output)
                    result = self.cli("status")
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn("guest session query invalid", result.stderr)

    def test_valid_table_without_the_user_never_authorizes_gui(self):
        self.reply(code=1, out=HEADER + " services 0 Disc\n rdp-tcp 65536 Listen\n")
        result = self.cli("gui", "synthetic.exe")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("tb not logged on", result.stderr)
        self.assertEqual(len(self.calls("ssh")), 1)
        self.assertEqual(self.calls("scp"), [])

    def test_only_explicit_active_console_or_rdp_rows_are_active(self):
        for row, state in [(" console tb 1 Active", "console"),
                           (" rdp-tcp#0 tb 2 Active", "rdp"),
                           (" rdp-tcp#0 tb 2 Disc", "disconnected"),
                           (" rdp-tcp#0 tb 2 Listen", "inactive"),
                           (" services tb 1 Active", "inactive"),
                           (" services tb 0 Active", "none")]:
            with self.subTest(row=row):
                self.reply(out=HEADER + row + "\n")
                result = self.cli("status")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["session"]["state"], state)
        self.reply(out=HEADER + " rdp-tcp#0 tb 2 Listen\n")
        result = self.cli("gui", "synthetic.exe")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("guest session is not Active: inactive", result.stderr)
        self.assertEqual(len(self.calls("ssh")), 1)
        self.assertEqual(self.calls("scp"), [])
