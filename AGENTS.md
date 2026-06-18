# AGENTS.md

Guidance for agents working in this dotfiles repo.

## Config symlink rule

When changing anything under `configs/`, ensure the machine uses the repo version via symlink/junction. Do not assume edits are active until link is verified.

Check relevant links before or after config edits:

- Windows Pi config:
  - `~/.pi/agent/settings.json` -> `configs/pi/settings.json`
  - `~/.pi/agent/APPEND_SYSTEM.md` -> `configs/pi/APPEND_SYSTEM.md`
  - `~/.pi/agent/extensions` -> `configs/pi/extensions`
  - `~/.pi/agent/prompts` -> `configs/pi/prompts`
- Windows Codex CLI config:
  - `~/.codex/config.toml` -> `configs/codex/config.toml`
  - `~/.codex/prompts` -> `configs/codex/prompts`
- Windows app configs installed by `windows/scripts/post-setup.ps1`.
- Linux configs installed by `arch-linux/install.sh` into `$HOME`, Oh My Zsh, and `$HOME/.config`.

If a target is a real file/dir instead of a link, report it and recommend rerunning the installer or replacing it with the correct symlink/junction. On Windows, directory symlinks may require admin/dev mode; junctions are acceptable for directories.

## Agent skills repo

Pi and Codex CLI personal skills are managed by separate sibling repo `../skills` relative to this dotfiles repo (for example `C:\Users\tobias\code\skills` when dotfiles is `C:\Users\tobias\code\dotfiles`).

Expected links:

- `~/.pi/agent/skills/<skill>` -> `../skills/skills/<skill>` for each personal skill folder with `SKILL.md`.
- `~/.pi/agent/skills/<skill>` -> `../skills/external/<vendor>/<skill>` for each vendored skill folder with `SKILL.md`.
- `~/.agents/skills/<skill>` -> `../skills/skills/<skill>` for each Codex personal skill folder with `SKILL.md`.
- `~/.agents/skills/<skill>` -> `../skills/external/<vendor>/<skill>` for each Codex external skill folder with `SKILL.md`.

Use PowerShell on Windows. Git Bash `ln -s` can create links that native Windows/Pi does not see correctly.

- Install/fix all agent skills: `powershell -ExecutionPolicy Bypass -File .\windows\scripts\sync-agent.ps1`
- Verify all agent links: `powershell -ExecutionPolicy Bypass -File .\windows\scripts\verify-links.ps1`
- Install/fix one target manually: set `PI_SKILLS_DIR` to the target skill directory, then run `powershell -ExecutionPolicy Bypass -File ..\skills\scripts\install-links.ps1 -Fix`.

When adding a new personal skill, create `..\skills\skills\<name>\SKILL.md`, then run installer/verifier.

## Agent sync and verification

- Verify Pi/Codex config + skills: `powershell -ExecutionPolicy Bypass -File .\windows\scripts\verify-links.ps1`
- Sync/fix Pi/Codex skills and verify all agent links: `powershell -ExecutionPolicy Bypass -File .\windows\scripts\sync-agent.ps1`

## NixOS servers

Before changing or remotely rebuilding NixOS servers, read `nixos/README.md`, especially remote server operation notes. Prefer normal OpenSSH over Tailscale (`tailscale up --ssh=false`) unless user explicitly wants Tailscale SSH browser checks. Avoid interactive `nixos-rebuild switch` over SSH for networking/firewall/SSH/Tailscale changes; use `dry-build` then `boot + reboot` or detached `systemd-run`.

## Installers

- Windows setup: `powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1` from elevated PowerShell.
- Windows winget configuration only: `powershell -ExecutionPolicy Bypass -File .\windows\scripts\install-apps.ps1` from elevated PowerShell.
- Windows Codex/Pi CLI repair only: `powershell -ExecutionPolicy Bypass -File .\windows\scripts\install-agent-clis.ps1`.
- Linux setup: `./arch-linux/install.sh`.

Avoid running installers without user approval because they install packages and mutate user config.
