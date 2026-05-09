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
- Windows app configs installed by `windows/scripts/post-setup.ps1`.
- Linux configs installed by `arch-linux/install.sh` into `$HOME`, Oh My Zsh, and `$HOME/.config`.

If a target is a real file/dir instead of a link, report it and recommend rerunning the installer or replacing it with the correct symlink/junction. On Windows, directory symlinks may require admin/dev mode; junctions are acceptable for directories.

## Installers

- Windows setup: `powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1` from elevated PowerShell.
- Linux setup: `./arch-linux/install.sh`.

Avoid running installers without user approval because they install packages and mutate user config.
