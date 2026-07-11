# AGENTS.md

Guidance for agents working in this dotfiles repo.

## Config symlink rule

When changing anything under `configs/`, ensure the machine uses the repo version via symlink/junction. Do not assume edits are active until link is verified.

Check relevant links before or after config edits:

- NixOS WSL Pi config:
  - `~/.pi/agent/settings.json` -> `configs/pi/settings.json`
  - `~/.pi/agent/models.json` -> `configs/pi/models.json`
  - `~/.pi/agent/APPEND_SYSTEM.md` -> `configs/pi/APPEND_SYSTEM.md`
  - `~/.pi/agent/extensions` -> `configs/pi/extensions`
  - `~/.pi/agent/prompts` -> `configs/pi/prompts`
- NixOS WSL Codex CLI config:
  - `~/.codex/AGENTS.md` -> `configs/codex/AGENTS.md`
  - `~/.codex/config.toml` -> `configs/codex/config.toml`
  - `~/.codex/prompts` -> `configs/codex/prompts`
- NixOS WSL npm config:
  - `~/.npmrc` -> `configs/npm/npmrc`
- Windows host configs are managed by `windows/configuration.winget`.
- Linux configs installed by `arch-linux/install.sh` into `$HOME`, Oh My Zsh, and `$HOME/.config`.

If a target is a real file/dir instead of a link, report it and recommend rerunning the installer or replacing it with the correct symlink/junction. On Windows, directory symlinks may require admin/dev mode; junctions are acceptable for directories.

## Agent skills repo

Pi and Codex CLI personal skills are managed by separate sibling repo `../skills` relative to this dotfiles repo.

Expected links:

- NixOS WSL `~/.pi/agent/skills/<skill>` -> `../skills/skills/<skill>` for personal skills listed in `../skills/skills.json`.
- NixOS WSL `~/.pi/agent/skills/<skill>` -> `../skills/external/mattpocock-skills/<skill>` for external skills listed in `../skills/skills.json`.
- NixOS WSL `~/.agents/skills/<skill>` -> `../skills/skills/<skill>` for Codex personal skills listed in `../skills/skills.json`.
- NixOS WSL `~/.agents/skills/<skill>` -> `../skills/external/mattpocock-skills/<skill>` for Codex external skills listed in `../skills/skills.json`.

- Install/fix all WSL agent skills: `./rebuild-wsl.sh`

When adding a new personal skill, add its name to `../skills/skills.json`, then run the installer/verifier.

## Agent sync and verification

- Verify Windows host config links: `winget configure -f .\windows\configuration.winget --accept-configuration-agreements --disable-interactivity`
- Sync/fix WSL Pi/Codex config + skills: `./rebuild-wsl.sh`
- Apply only NixOS WSL config/packages: `./rebuild-wsl.sh --nixos-only`

## NixOS servers

Before changing or remotely rebuilding NixOS servers, read `nixos/README.md`, especially remote server operation notes. Prefer normal OpenSSH over Tailscale (`tailscale up --ssh=false`) unless user explicitly wants Tailscale SSH browser checks. Avoid interactive `nixos-rebuild switch` over SSH for networking/firewall/SSH/Tailscale changes; use `dry-build` then `boot + reboot` or detached `systemd-run`.

## Installers

- Windows setup: `powershell -ExecutionPolicy Bypass -File .\rebuild-windows.ps1` from PowerShell. The script elevates when needed.
- Windows winget configuration only: `winget configure -f .\windows\configuration.winget --accept-configuration-agreements --disable-interactivity` from elevated PowerShell.
- NixOS WSL rebuild and agent repair: `./rebuild-wsl.sh`.
- NixOS WSL rebuild only: `./rebuild-wsl.sh --nixos-only`.
- Linux setup: `./arch-linux/install.sh`.

Avoid running installers without user approval because they install packages and mutate user config.
