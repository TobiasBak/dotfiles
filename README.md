# Dotfiles

This repository contains configuration files for Windows, native NixOS developer machines, NixOS WSL, and NixOS servers.

## Structure

- `configs/`: Shared program configs used by both OS installers where applicable.
  - Home Manager links NixOS WSL user configs from here into the home directory.
  - Native NixOS Home Manager modules explicitly link desktop and developer configs from here.
  - Windows installers symlink host configs like WezTerm and VS Code into their Windows locations.
- `assets/`: Shared non-configuration assets such as wallpapers.
- `nixos/`: Flake-based NixOS host configs for WSL, native developer machines, and servers.
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

### Native NixOS

The native developer hosts are:

- `pc`: NVIDIA desktop workstation.
- `laptop`: integrated-graphics laptop.

Both use Niri, Quickshell, Home Manager, Docker, and the shared developer
profile. See `nixos/README.md` for the Arch replacement and installation flow.
After installation, rebuild the current native host with:

```bash
./rebuild-nixos.sh
```

On the first rebuild from a generic NixOS installation, select the target
explicitly. The script copies the generated hardware configuration when the
repo still contains its placeholder, moves a graphical installer's VFAT EFI
mount from `/boot` to `/boot/efi` when needed, enables the Nix features needed
for the first flake build, applies the declared hostname, and bootstraps
developer tools when requested:

```bash
./rebuild-nixos.sh pc --bootstrap
```

Use `./rebuild-nixos.sh --bootstrap` on later rebuilds when Pi, Codex, and
agent skill links also need to be refreshed.

### NixOS servers

See `nixos/README.md` for server build, installation, and remote-operation notes.

## Nix Direction

- Use NixOS WSL as the default Windows developer shell.
- Use native NixOS for the laptop and stationary developer environments.
- Keep shared system behavior in `nixos/modules/` and machine-specific behavior in `nixos/hosts/<host>/`.
- Keep user configuration in `nixos/home/` and shared source files in `configs/`.
- Add project-level `flake.nix` dev shells where reproducible tooling matters.
