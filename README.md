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
- `scripts/`: Shared bootstrap and benchmark scripts.
- `docs/`: Historical research notes and supporting documentation.

## Usage

### Windows

Run the root rebuild script from Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\rebuild-windows.ps1
```

This elevates when needed, applies the winget configuration, installs Windows
host tools, creates the Windows config links, and installs or updates NixOS WSL
when its recorded repository revision is stale. The WSL bootstrap also refreshes
mutable agent CLIs, Pi tools, and skill links when it runs. Commit and push the revision
before running this command because WSL checks out that commit from the configured
Git remote.

### NixOS WSL

Windows setup creates `%USERPROFILE%\.dotfiles` as a link to the Windows
checkout used to run the configuration. It installs the latest NixOS-WSL `.wsl`
release, applies `nixos#wsl`, creates the `tobias` user, and clones the same Git
revision inside WSL at `~/code/dotfiles`. Linux config links use:

```text
~/.dotfiles -> ~/code/dotfiles
```

The Windows and Linux links are separate. The automated installer uses the
fixed Linux checkout above rather than running from the Windows checkout under
`/mnt/c`.

Inside NixOS WSL, refresh the system profile and Home Manager user config with:

```bash
./rebuild-wsl.sh
```

Pi extensions live in the sibling `~/code/pi-tools` repository. Hypa's Pi
extension is loaded from the sibling `~/code/hypa/packages/pi-hypa` fork through
`configs/pi/settings.json`, not from npm. The developer-tool bootstrap clones or
updates both repositories alongside dotfiles and installs only the Hypa Pi
package's runtime dependencies.

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
repo still contains its placeholder, enables the Nix features needed for the
first flake build, applies the declared hostname, and bootstraps developer tools
when requested:

```bash
./rebuild-nixos.sh pc --bootstrap
```

Use `./rebuild-nixos.sh --bootstrap` on later rebuilds when Pi, Codex, and
agent skill links also need to be refreshed.

The native GRUB configuration expects the EFI system partition at
`/boot/efi`. If a graphical installer mounted a VFAT EFI partition at `/boot`,
move it and update the generated hardware configuration manually before
rebuilding. The script fails closed rather than unmounting or rewriting a live
EFI setup.

### NixOS servers

See `nixos/README.md` for server build, installation, and remote-operation notes.

## Nix Direction

- Use NixOS WSL as the default Windows developer shell.
- Use native NixOS for the laptop and stationary developer environments.
- Keep shared system behavior in `nixos/modules/` and machine-specific behavior in `nixos/hosts/<host>/`.
- Keep user configuration in `nixos/home/` and shared source files in `configs/`.
- Add project-level `flake.nix` dev shells where reproducible tooling matters.
