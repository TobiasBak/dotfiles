# Dotfiles

This repository contains configuration files (dotfiles) for both Windows and Arch Linux environments.

## Structure

- `configs/`: Shared program configs used by both OS installers where applicable.
  - Linux installers symlink XDG configs from here into `~/.config` plus zsh files into `$HOME` / Oh My Zsh.
  - Windows installers symlink supported shared configs (PowerShell aliases, VS Code, Discord, Pi config/extensions/prompts, and Codex CLI config/prompts) into their Windows locations and install Pi skills from sibling skills repo `../skills` relative to this dotfiles repo.
- `arch-linux/`: Arch Linux installer and Linux-only assets (for example wallpapers).
- `nixos/`: Flake-based NixOS host configs, including a laptop server profile.
- `windows/`: Windows setup scripts.
- `.env`: Environment-specific variables (not tracked by Git if sensitive).

## Usage

### Windows

1. **From WSL, launch the Windows setup:**
   ```bash
   bash windows/setup-from-wsl.sh
   ```

   This starts the Windows setup elevated, applies the winget configuration, installs WezTerm, installs Arch WSL, sets `archlinux` as the default WSL distro, and ensures Arch has a canonical checkout at `~/code/dotfiles`.

2. **Or from Windows PowerShell:**
   Run the main setup script as **Administrator**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1
   ```

### Arch Linux

Run `./arch-linux/install.sh` to install the desktop packages, symlink shared configs from `configs/`, and install Pi skills from `~/code/skills` into `~/.pi/agent/skills`.

The Arch installer also enables the `multilib` pacman repository so optional packages like Steam are available to install later.

The Arch installer does not install or configure optional AI CLI tools such as Claude Code, Gemini CLI, or OpenCode.

### NixOS

See `nixos/README.md` for the flake-based laptop server config and install notes.
