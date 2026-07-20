# AGENTS.md

Guidance for agents working in this dotfiles repo.

## Config symlink rule

When changing anything under `configs/`, ensure the machine uses the repo version via symlink/junction. Do not assume edits are active until link is verified.

Check relevant links before or after config edits:

- NixOS WSL and native NixOS Pi config:
  - `~/.pi/agent/settings.json` -> `configs/pi/settings.json`
  - `~/.pi/agent/models.json` -> `configs/pi/models.json`
  - `~/.pi/agent/APPEND_SYSTEM.md` -> `configs/codex/AGENTS.md`
  - `~/.pi/agent/extensions` -> `configs/pi/extensions`
  - `~/.pi/agent/prompts` -> `configs/pi/prompts`
  - `~/.pi/agent/keybindings.json` -> `configs/pi/keybindings.json`
  - `~/.hypa-pi/config.json` -> `configs/pi/hypa.json`
- NixOS WSL and native NixOS Codex CLI config:
  - `~/.codex/AGENTS.md` -> `configs/codex/AGENTS.md`
  - `~/.codex/config.toml` -> `configs/codex/config.toml`
  - `~/.codex/prompts` -> `configs/codex/prompts`
- NixOS WSL and native NixOS Hunk config:
  - `~/.config/hunk/config.toml` -> `configs/hunk/config.toml`
- NixOS WSL and native NixOS npm config:
  - `~/.npmrc` -> `configs/npm/npmrc`
- Windows host configs are managed by `windows/configuration.winget`.
- Native NixOS Linux configs are linked by Home Manager from `nixos/home/tobias/`.

If a target is a real file/dir instead of a link, report it and recommend rerunning the installer or replacing it with the correct symlink/junction. On Windows, directory symlinks may require admin/dev mode; junctions are acceptable for directories.

## Agent skills repo

Pi and Codex CLI personal skills are managed by separate sibling repo `../skills` relative to this dotfiles repo.

The skills repo installer discovers every directory containing `SKILL.md` under `../skills/skills/*` and `../skills/external/*/*`.

Expected links:

- NixOS WSL and native NixOS `~/.pi/agent/skills/<skill>` -> the corresponding discovered skill directory in `../skills`.
- NixOS WSL and native NixOS `~/.agents/skills/<skill>` -> the corresponding discovered skill directory in `../skills`, excluding `openai-docs` because Codex bundles it.

- Install/fix all WSL agent skills: `./rebuild-wsl.sh`
- Install/fix all native NixOS agent skills: `./rebuild-nixos.sh --bootstrap`

When adding a new personal skill, create it under `../skills/skills/<skill>` with a `SKILL.md`, then run the installer/verifier.

## NixOS servers

Before changing or remotely rebuilding NixOS servers, read `nixos/README.md`, especially remote server operation notes. Prefer normal OpenSSH over Tailscale (`tailscale up --ssh=false`) unless user explicitly wants Tailscale SSH browser checks. Avoid interactive `nixos-rebuild switch` over SSH for networking/firewall/SSH/Tailscale changes; use `dry-build` then `boot + reboot` or detached `systemd-run`.

## Installers

- Windows setup: `powershell -ExecutionPolicy Bypass -File .\rebuild-windows.ps1` from PowerShell. The script elevates when needed.
- Windows winget configuration only: `winget configure -f .\windows\configuration.winget --accept-configuration-agreements --disable-interactivity` from elevated PowerShell.
- NixOS WSL rebuild and agent repair: `./rebuild-wsl.sh`.
- NixOS WSL rebuild only: `./rebuild-wsl.sh --nixos-only`.
- Native NixOS rebuild: `./rebuild-nixos.sh`.
- Native NixOS rebuild plus agent refresh: `./rebuild-nixos.sh --bootstrap`.

Avoid running installers without user approval because they install packages and mutate user config.
