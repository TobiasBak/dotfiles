#!/usr/bin/env python3
"""Install personal agent context on any Unix workstation, without Nix or sudo."""
import argparse
import json
import os
from pathlib import Path
import tempfile
from datetime import datetime, timezone


def backup(path):
    if path.exists() or path.is_symlink():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        target = path.with_name(f"{path.name}.backup-{stamp}")
        path.rename(target)
        print(f"Backed up {path} -> {target}")


def link(source, target):
    if target.is_symlink() and target.resolve() == source.resolve():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    backup(target)
    target.symlink_to(source)
    print(f"Linked {target} -> {source}")


def install(repo, vault, workspace, home, agent_dir):
    instructions = repo / "configs/agents/AGENTS.md"
    extension = workspace / "src/snapshot.ts"
    skills = sorted((vault / "skills").glob("*/SKILL.md"))
    for required in [instructions, repo / "configs/pi/settings.json", extension]:
        if not required.is_file():
            raise ValueError(f"Missing {required}; clone the required repository first")
    if not skills:
        raise ValueError(f"No global skills found in {vault / 'skills'}")

    # Validate settings before touching any installed configuration. Keep local
    # model, theme, device ID and other preferences; repository policy wins.
    settings_path = agent_dir / "settings.json"
    current = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    managed = json.loads((repo / "configs/pi/settings.json").read_text())
    if not isinstance(current, dict) or not isinstance(managed, dict):
        raise ValueError("Pi settings must be JSON objects")
    managed.pop("lastChangelogVersion", None)
    # Resolve the portable repo default to the actual sibling checkout, even
    # when the repositories are not under ~/code.
    managed["extensions"] = [str(extension)]
    merged = current | managed
    existing_extensions = current.get("extensions", [])
    if not isinstance(existing_extensions, list):
        raise ValueError("Pi extensions must be an array")
    # Replace old machine-specific paths to this extension, preserving others.
    existing_extensions = [p for p in existing_extensions
                           if not (isinstance(p, str) and p.endswith("/pi-workspace-view/src/snapshot.ts"))]
    merged["extensions"] = list(dict.fromkeys(existing_extensions + managed["extensions"]))

    link(instructions, agent_dir / "APPEND_SYSTEM.md")
    link(instructions, home / ".codex/AGENTS.md")
    link(instructions, home / ".claude/CLAUDE.md")
    for skill in skills:
        source = skill.parent
        link(source, home / ".agents/skills" / source.name)
        # Do not replace Claude's existing directory: it may contain Omarchy
        # skills or other personal resources. Shared-directory symlinks work too.
        link(source, home / ".claude/skills" / source.name)

    if current != merged or settings_path.is_symlink():
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=settings_path.parent, delete=False) as staged:
            json.dump(merged, staged, indent=2)
            staged.write("\n")
            staged_path = Path(staged.name)
        try:
            backup(settings_path)
            os.replace(staged_path, settings_path)
        finally:
            staged_path.unlink(missing_ok=True)
        print(f"Merged Pi settings into {settings_path}")
    print(f"Installed global instructions, {len(skills)} vault skills and Pi workspace view.")
    print("Run /reload in Pi (or restart it); start new Claude/Codex sessions.")


def main():
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, default=repo.parent / "vault-public")
    parser.add_argument("--workspace", type=Path, default=repo.parent / "pi-workspace-view")
    args = parser.parse_args()
    home = Path.home()
    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", str(home / ".pi/agent"))).expanduser().resolve()
    try:
        install(repo, args.vault.expanduser().resolve(), args.workspace.expanduser().resolve(), home, agent_dir)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()
