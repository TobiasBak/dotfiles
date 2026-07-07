# Dotfiles

This repository contains configuration files (dotfiles) for Windows, NixOS, NixOS WSL, and Arch Linux environments.

## Structure

- `configs/`: Shared program configs used by both OS installers where applicable.
  - Linux installers symlink XDG configs from here into `~/.config` plus zsh files into `$HOME` / Oh My Zsh.
  - Windows installers symlink supported shared configs (PowerShell aliases, VS Code, Discord, Pi config/extensions/prompts, and Codex CLI config/prompts) into their Windows locations and install Pi skills from sibling skills repo `../skills` relative to this dotfiles repo.
- `arch-linux/`: Arch Linux installer and Linux-only assets (for example wallpapers).
- `nixos/`: Flake-based NixOS host configs, including NixOS WSL and server profiles.
- `windows/`: Windows setup scripts.
- `.env`: Environment-specific variables (not tracked by Git if sensitive).

## Usage

### Windows

1. **From WSL, launch the Windows setup:**
   ```bash
   bash windows/setup-from-wsl.sh
   ```

   This starts the Windows setup elevated, applies the winget configuration, installs WezTerm, installs NixOS WSL via NixOS-WSL, sets `NixOS` as the default WSL distro, and bootstraps config links through `~/.dotfiles`.

2. **Or from Windows PowerShell:**
   Run the main setup script as **Administrator**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1
   ```

### NixOS WSL

Windows setup creates a stable `%USERPROFILE%\.dotfiles` link for Windows config targets. It also installs the latest NixOS-WSL `.wsl` release, applies the repo flake host `nixos#wsl`, creates the `tobias` WSL user, and links Linux configs through:

```text
~/.dotfiles -> <actual dotfiles checkout>
```

That stable path means config symlinks do not need to know whether the real checkout lives in `~/code/dotfiles`, somewhere under `/mnt/c`, or another machine-specific path.

Manual repair or reapply:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\scripts\install-nixos-wsl.ps1
```

Inside NixOS WSL, rebuild the system profile with:

```bash
sudo nixos-rebuild switch --flake ~/.dotfiles/nixos#wsl
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
- Move user-level dotfiles to Home Manager later, once the system-level NixOS WSL path is stable.
- Add project-level `flake.nix` dev shells where reproducible tooling matters.
- Use standalone Nix on non-NixOS Linux machines when replacing the OS is not worth it.
