# Dotfiles

This repository contains configuration files (dotfiles) for both Windows and Arch Linux environments.

## Structure

- `arch-linux/`: Configuration files for Arch Linux (zsh, ghostty, quickshell, niri, etc.)
- `windows/`: Configuration files and setup scripts for Windows.
- `.env`: Environment-specific variables (not tracked by Git if sensitive).

## Usage

### Windows

1. **Run the Setup Script:**
   Run the main setup script as **Administrator**. This will install applications and configure aliases:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1
   ```

### Arch Linux

Run `./arch-linux/install.sh` to install the desktop packages and symlink the Arch Linux dotfiles.

The Arch installer also enables the `multilib` pacman repository so optional packages like Steam are available to install later.

The Arch installer does not install or configure optional AI CLI tools such as Claude Code, Gemini CLI, or OpenCode.
