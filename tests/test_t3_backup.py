import fnmatch
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing


BACKUP = Path(__file__).resolve().parents[1] / "agents/t3/backup.sh"
FAKE_RESTIC = '''#!PYTHON -I
import json
import os
from pathlib import Path
import shutil
import sys

home = Path(os.environ["HOME"])
artifacts = home / "captured"
artifacts.mkdir(exist_ok=True)
argv = sys.argv[1:]
with (artifacts / "calls.jsonl").open("a") as stream:
    stream.write(json.dumps({
        "argv": argv,
        "repository": os.environ["RESTIC_REPOSITORY"],
        "password_file": os.environ["RESTIC_PASSWORD_FILE"],
    }) + "\\n")
if argv[0] == "backup" and argv[argv.index("--tag") + 1] == "t3":
    shutil.copytree(home / ".local/state/t3-backup", artifacts / "staged", symlinks=True)
'''


class T3BackupTests(unittest.TestCase):
    def test_nightly_backup_preserves_portable_data_and_runs_maintenance(self):
        scratch = Path.home() / ".cache/agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="t3-backup-", dir=scratch) as folder:
            home = Path(folder)
            userdata = home / ".t3/userdata"
            agent = home / ".pi/agent"
            orderready = home / ".local/share/orderready"
            settings = b'{"model":"synthetic-pi-settings"}\n'
            instructions = b"# synthetic APPEND_SYSTEM instructions\n"
            files = {
                ".t3/userdata/logs/t3.log": b"synthetic log\n",
                ".t3/userdata/model-manifest.json": b"{}\n",
                ".t3/userdata/usage-cache-1.json": b"{}\n",
                "pi-sources/settings.json": settings,
                "pi-sources/APPEND_SYSTEM.md": instructions,
                ".pi/agent/sessions/session-0001/transcript.md": b"synthetic session\n",
                ".pi/agent/bin/synthetic-tool": b"synthetic tool\n",
                ".local/share/orderready/fixtures/fixture-001/photo.bin": b"synthetic fixture\n",
                ".local/share/orderready/corpus/docs/note.md": b"synthetic corpus\n",
                ".config/restic/t3-password": b"synthetic password\n",
            }
            for name, content in files.items():
                path = home / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            for name in ("settings.json", "APPEND_SYSTEM.md"):
                (agent / name).symlink_to(home / "pi-sources" / name)

            bin_dir = home / "bin"
            bin_dir.mkdir()
            fake = bin_dir / "restic"
            fake.write_text(FAKE_RESTIC.replace("#!PYTHON", f"#!{sys.executable}"))
            fake.chmod(0o755)
            env = {"HOME": str(home), "PATH": f"{bin_dir}:/usr/bin:/bin", "LC_ALL": "C"}
            live = userdata / "statev2.sqlite"
            with closing(sqlite3.connect(live)) as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("CREATE TABLE synthetic_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
                connection.execute("INSERT INTO synthetic_notes VALUES (1, 'synthetic-t3-row-42')")
                connection.commit()
                result = subprocess.run(
                    ["bash", str(BACKUP)], env=env, cwd=home,
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            with closing(sqlite3.connect(f"file:{live}?mode=ro", uri=True)) as original:
                self.assertEqual(original.execute("SELECT * FROM synthetic_notes").fetchall(),
                                 [(1, "synthetic-t3-row-42")])

            artifacts = home / "captured"
            calls = [json.loads(line) for line in (artifacts / "calls.jsonl").read_text().splitlines()]
            self.assertEqual([call["argv"][0] for call in calls],
                             ["backup", "backup", "forget", "check"])
            self.assertEqual({call["repository"] for call in calls},
                             {"sftp:tobias@tobias-serv01:/srv/nas/files/.backups/t3-pc"})
            self.assertEqual({call["password_file"] for call in calls},
                             {str(home / ".config/restic/t3-password")})
            t3, orderready_call, forget, check = [call["argv"] for call in calls]
            for argv, tag, sources in (
                (t3, "t3", [home / ".local/state/t3-backup", userdata, agent]),
                (orderready_call, "orderready", [orderready / "fixtures", orderready / "corpus"]),
            ):
                self.assertEqual(argv[argv.index("--host") + 1], "pc")
                self.assertEqual(argv[argv.index("--tag") + 1], tag)
                paths = [value for i, value in enumerate(argv[1:], 1)
                         if not value.startswith("--") and argv[i - 1] not in {"--host", "--tag", "--exclude"}]
                self.assertEqual(paths, [str(path) for path in sources])

            excludes = [t3[i + 1] for i, value in enumerate(t3) if value == "--exclude"]
            for path in (live, Path(str(live) + "-wal"), Path(str(live) + "-shm"),
                         userdata / "logs", userdata / "usage-cache-1.json",
                         userdata / "model-manifest.json", agent / "bin"):
                self.assertTrue(any(fnmatch.fnmatch(str(path), pattern) for pattern in excludes),
                                f"not excluded: {path}")
            for path in (home / ".local/state/t3-backup/statev2.sqlite",
                         agent / "sessions/session-0001/transcript.md"):
                self.assertFalse(any(fnmatch.fnmatch(str(path), pattern) for pattern in excludes),
                                 f"backup data excluded: {path}")

            for name in ("pi-settings.json", "pi-APPEND_SYSTEM.md", "statev2.sqlite"):
                staged = artifacts / "staged" / name
                self.assertFalse(staged.is_symlink(), f"staged {name} is a symlink, not a portable copy")
                self.assertTrue(staged.is_file(), f"staged {name} is not a regular file")
            self.assertEqual((artifacts / "staged/pi-settings.json").read_bytes(), settings)
            self.assertEqual((artifacts / "staged/pi-APPEND_SYSTEM.md").read_bytes(), instructions)
            with closing(sqlite3.connect(f"file:{artifacts / 'staged/statev2.sqlite'}?mode=ro", uri=True)) as captured:
                self.assertEqual(captured.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
                self.assertEqual(captured.execute("SELECT * FROM synthetic_notes").fetchall(),
                                 [(1, "synthetic-t3-row-42")])

            self.assertIn("--prune", forget)
            self.assertEqual(forget[forget.index("--keep-daily") + 1], "7")
            self.assertEqual(forget[forget.index("--keep-weekly") + 1], "4")
            self.assertEqual(check, ["check", "--with-cache"])


if __name__ == "__main__":
    unittest.main()
