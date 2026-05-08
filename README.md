# Dotfiles

This repository contains configuration files (dotfiles) for both Windows and Arch Linux environments.

## Structure

- `configs/`: Shared program configs used by both OS installers where applicable.
  - Linux installers symlink XDG configs from here into `~/.config` plus zsh files into `$HOME` / Oh My Zsh.
  - Windows installers symlink supported shared configs (PowerShell aliases, VS Code, Discord, pi extensions) into their Windows locations and install Pi skills from `https://github.com/TobiasBak/skills.git`.
- `arch-linux/`: Arch Linux installer and Linux-only assets (for example wallpapers).
- `windows/`: Windows setup scripts.
- `.env`: Environment-specific variables (not tracked by Git if sensitive).

## Usage

### Windows

1. **Run the Setup Script:**
   Run the main setup script as **Administrator**. This will install applications and configure aliases:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1
   ```

### Arch Linux

Run `./arch-linux/install.sh` to install the desktop packages and symlink shared configs from `configs/`.

The Arch installer also enables the `multilib` pacman repository so optional packages like Steam are available to install later.

The Arch installer does not install or configure optional AI CLI tools such as Claude Code, Gemini CLI, or OpenCode.
