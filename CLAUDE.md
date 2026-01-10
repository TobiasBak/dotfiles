# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Personal dotfiles repository for dual-boot Windows and Arch Linux environments. Configuration files are organized by platform and symlinked to their target locations.

## Structure

- `arch-linux/` - Arch Linux configurations (zsh, niri, alacritty, etc.)
- `arch-linux/.config/` - XDG config directories (niri, alacritty, mako, quickshell, Code)
- `arch-linux/install.sh` - Main installation script for Arch Linux
- `windows/` - Windows configurations and PowerShell setup scripts
- `.claude/` - Claude Code settings, skills, agents, and hooks (symlinked to ~/.claude)

## Installation Commands

### Arch Linux
```bash
# Run the installation script (installs packages, symlinks configs, sets up zsh)
./arch-linux/install.sh
```

### Windows
```powershell
# Run as Administrator
powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1
```

## Key Configuration Details

### Arch Linux Environment
- **Window Manager**: niri (scrollable-tiling Wayland compositor)
- **Shell**: zsh with Oh My Zsh (robbyrussell theme)
- **Terminal**: alacritty
- **Launcher**: fuzzel
- **Notifications**: mako
- **Status Bar**: quickshell
- **Keyboard Layout**: Danish (`dk`) with Left Alt as AltGr for 60% keyboards

### Claude Code Integration
The `.claude/` directory contains:
- `settings.json` - Hook configurations for damage-control security (Bash, Edit, Write tools)
- `skills/` - Custom skills (agent-creator, brainstorm, implement, damage-control, etc.)
- `agents/` - Custom agent definitions (code-simplifier)
- `hooks/damage-control/` - Python scripts that validate tool usage before execution

The install script symlinks `.claude/` contents to `~/.claude/` for Claude Code to use.

## Development Conventions

- Platform-specific files belong in their respective folders (`arch-linux/` or `windows/`)
- PowerShell scripts (`.ps1`) for Windows automation
- Shell scripts (`.sh`) for Linux automation
- Sensitive data goes in `.env` (not tracked by git)
