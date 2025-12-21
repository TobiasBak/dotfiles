# Dotfiles

This repository contains configuration files (dotfiles) for both Windows and Arch Linux environments.

## Structure

- `arch-linux/`: Configuration files for Arch Linux (zsh, alacritty, waybar, niri, etc.)
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

Refer to the configuration files in `arch-linux/` and symlink them to your home directory or `.config` folder.
