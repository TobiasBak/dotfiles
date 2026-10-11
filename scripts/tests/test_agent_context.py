"""Real filesystem checks for the Nix-free agent context installer."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "installer", Path(__file__).resolve().parents[1] / "install-agent-context.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class AgentContextTests(unittest.TestCase):
    def test_install_preserves_local_state_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, vault, workspace, home = [root / p for p in ("dotfiles", "vault", "workspace", "different-user")]
            files = {
                repo / "configs/agents/AGENTS.md": "global rules\n",
                repo / "configs/pi/settings.json": json.dumps({
                    "defaultProjectTrust": "always", "defaultTools": ["+codemode"],
                    "extensions": ["~/code/pi-workspace-view/src/snapshot.ts"]}),
                workspace / "src/snapshot.ts": "export default function () {}\n",
                vault / "skills/example/SKILL.md": "skill\n",
                home / ".agents/skills/omarchy/SKILL.md": "keep me\n",
                home / ".claude/skills/example/notes.txt": "back me up\n",
                home / ".pi/agent/APPEND_SYSTEM.md": "old instructions\n",
            }
            for path, text in files.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            settings = home / ".pi/agent/settings.json"
            settings.write_text(json.dumps({"theme": "omarchy-system", "defaultModel": "gpt-6.1-sol",
                "deviceId": "local", "extensions": ["/old/pi-workspace-view/src/snapshot.ts", "/other.ts"]}))
            with contextlib.redirect_stdout(io.StringIO()):
                installer.install(repo, vault, workspace, home, settings.parent)
            actual = json.loads(settings.read_text())
            self.assertEqual(actual["extensions"], ["/other.ts", str(workspace / "src/snapshot.ts")])
            self.assertEqual(actual["defaultModel"], "gpt-6.1-sol")
            self.assertEqual(actual["theme"], "omarchy-system")
            self.assertEqual(actual["deviceId"], "local")
            self.assertEqual(actual["defaultTools"], ["+codemode"])
            self.assertEqual((home / ".agents/skills/omarchy/SKILL.md").read_text(), "keep me\n")
            self.assertEqual((home / ".codex/AGENTS.md").resolve(), repo / "configs/agents/AGENTS.md")
            self.assertTrue(list((home / ".claude/skills").glob("example.backup-*/notes.txt")))
            before = sorted(str(p) for p in home.rglob("*"))
            with contextlib.redirect_stdout(io.StringIO()):
                installer.install(repo, vault, workspace, home, settings.parent)
            self.assertEqual(before, sorted(str(p) for p in home.rglob("*")))
            self.assertFalse(settings.is_symlink())


if __name__ == "__main__":
    unittest.main()
