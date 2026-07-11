# Dotfiles

This repository contains configuration files (dotfiles) for Windows, NixOS, NixOS WSL, and Arch Linux environments.

## Structure

- `configs/`: Shared program configs used by both OS installers where applicable.
  - Home Manager links NixOS WSL user configs from here into the home directory.
  - The Arch Linux installer symlinks XDG configs into `~/.config` plus zsh files into `$HOME` / Oh My Zsh.
  - Windows installers symlink host configs like WezTerm and VS Code into their Windows locations.
- `arch-linux/`: Arch Linux installer and Linux-only assets (for example wallpapers).
- `nixos/`: Flake-based NixOS host configs, including NixOS WSL and server profiles.
- `windows/`: Windows setup scripts.
- `.env`: Environment-specific variables (not tracked by Git if sensitive).

## Usage

### Windows

Run the root rebuild script from Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\rebuild-windows.ps1
```

This elevates when needed, applies the winget configuration, installs WezTerm,
installs or repairs NixOS WSL, refreshes Windows host config links, and verifies
links. Dev shells, agent CLIs, and agent skills are refreshed inside NixOS WSL.

### NixOS WSL

Windows setup creates a stable `%USERPROFILE%\.dotfiles` link for Windows config targets. It also installs the latest NixOS-WSL `.wsl` release, applies the repo flake host `nixos#wsl`, creates the `tobias` WSL user, and links Linux configs through:

```text
~/.dotfiles -> <actual dotfiles checkout>
```

That stable path means config symlinks do not need to know whether the real checkout lives in `~/code/dotfiles`, somewhere under `/mnt/c`, or another machine-specific path.

Inside NixOS WSL, refresh the system profile and Home Manager user config with:

```bash
./rebuild-wsl.sh
```

### Arch Linux

Run `./arch-linux/install.sh` to install the desktop packages, create `~/.dotfiles`, symlink shared configs from `configs/`, and install Pi skills from the sibling skills repo into `~/.pi/agent/skills`.

The Arch installer also enables the `multilib` pacman repository so optional packages like Steam are available to install later.

The Arch installer does not install or configure optional AI CLI tools such as Claude Code, Gemini CLI, or OpenCode.

### NixOS

See `nixos/README.md` for the flake-based laptop server config and install notes.

## Nix Direction

- Use NixOS WSL as the default Windows developer shell.
- Keep machine/system packages in `nixos/hosts/<host>/configuration.nix` instead of shell bootstrap scripts.
- Keep user-level NixOS WSL configuration in Home Manager and system-level configuration in the host module.
- Add project-level `flake.nix` dev shells where reproducible tooling matters.
- Use standalone Nix on non-NixOS Linux machines when replacing the OS is not worth it.
