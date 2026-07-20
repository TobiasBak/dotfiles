# NixOS

This directory contains flake-based NixOS host configs.

## Hosts

- `wsl`: NixOS-WSL developer environment used as the default Windows WSL distro.
- `pc`: native Niri/Quickshell developer workstation with NVIDIA graphics and Docker.
- `laptop`: native Niri/Quickshell developer laptop with integrated graphics, laptop power management, and Docker.
- `laptop-server`: lightweight laptop server with XFCE, xrdp, SSH, Tailscale, firewall, garbage collection, and laptop sleep disabled.
- `tobias-serv01`: NixOS file server with Docker, Samba, SSH, and Tailscale.

## Source of truth

Every bare-metal NixOS host must run the configuration from this repo. Do not
make lasting edits directly in `/etc/nixos/configuration.nix`. Change files
under `nixos/`, copy or pull the repo on the target, then rebuild from the
flake. For example:

```bash
cd /path/to/dotfiles/nixos
nix build .#nixosConfigurations.laptop-server.config.system.build.toplevel
sudo nixos-rebuild switch --flake .#laptop-server
```

If emergency changes are made on the laptop, immediately copy them back into
this repo and rebuild from the flake. `/etc/nixos` is not the source of truth.

Each bare-metal host keeps its generated hardware config in its own host
directory. For example:

```bash
cp /etc/nixos/hardware-configuration.nix \
  /path/to/dotfiles/nixos/hosts/laptop-server/hardware-configuration.nix
```

Never reuse a generated hardware configuration between machines.

## Install flow

### NixOS WSL

Windows setup installs NixOS WSL from the latest NixOS-WSL `.wsl` release,
sets the distro name/default to `NixOS`, and applies the WSL rebuild:

```bash
~/.dotfiles/rebuild-wsl.sh
```

The setup then bootstraps the `tobias` home with:

```text
~/.dotfiles -> <actual dotfiles checkout>
```

Keep Linux config links pointed through `~/.dotfiles` where possible. That
lets each machine place the real Git checkout wherever it wants without
rewriting every symlink.

The developer hosts import Home Manager for user-level configuration. Shared
home state lives in `home/tobias/common.nix`, while the WSL and native desktop
modules add only their platform-specific state. The bootstrap remains
responsible for cloning repositories and updating tools that are not packaged
by Nix.

Manual Windows-side repair:

```powershell
powershell -ExecutionPolicy Bypass -File .\rebuild-windows.ps1
```

Manual in-distro rebuild:

```bash
~/.dotfiles/rebuild-wsl.sh
```

After changing flake inputs, update and commit the lock file from a machine
with Nix installed:

```bash
cd ~/.dotfiles/nixos
nix flake lock
```

### Native developer workstations

The native developer hosts share the same base developer and Home Manager
configuration as WSL, then add native Niri desktop support. WSL integration,
Windows command wrappers, and `wslview` remain isolated to the WSL host.

Both native host directories initially contain a clearly marked bootstrap
`hardware-configuration.nix`. It records the host structure in the flake but
intentionally omits the root filesystem, so a full host build fails safely.
Replace it with the configuration generated on the target machine before
building or installing.

#### Replace Arch while preserving Windows

Boot the NixOS installer in UEFI mode and connect to the network:

```bash
sudo -i
nmtui
lsblk -o NAME,SIZE,FSTYPE,FSVER,LABEL,UUID,MOUNTPOINTS
```

Identify the old Arch root partition and the existing EFI system partition.
Back up anything still needed from Arch and keep the Windows recovery key
available. Assign the exact devices, inspect their filesystems and UUIDs, and
require an explicit confirmation before formatting:

```bash
arch_root=/dev/<old-arch-root>
windows_efi=/dev/<existing-efi-system-partition>

lsblk -o NAME,SIZE,FSTYPE,FSVER,LABEL,UUID,MOUNTPOINTS "$arch_root" "$windows_efi"
blkid "$arch_root" "$windows_efi"
test "$(blkid -s TYPE -o value "$windows_efi")" = "vfat"

printf 'Old Arch root to erase: %s\nWindows EFI to preserve: %s\n' "$arch_root" "$windows_efi"
read -r -p 'Type ERASE-ARCH to continue: ' confirmation
test "$confirmation" = "ERASE-ARCH"

mkfs.ext4 -L nixos "$arch_root"
mount /dev/disk/by-label/nixos /mnt
mkdir -p /mnt/boot/efi
mount "$windows_efi" /mnt/boot/efi
```

Format only the confirmed old Arch root partition. Never run `mkfs` on the EFI
partition or any Windows partition.

If the old Arch installation used a dedicated swap partition, it can be kept
and will be captured by `nixos-generate-config`. Alternatively, remove it only
as part of a deliberate repartitioning plan.

Place this repository in the future user's home. Cloning is shown here, but a
copy from removable storage is also valid:

```bash
mkdir -p /mnt/home/tobias/code
git clone https://github.com/TobiasBak/dotfiles.git /mnt/home/tobias/code/dotfiles
ln -s /home/tobias/code/dotfiles /mnt/home/tobias/.dotfiles
```

Choose exactly one host and its configuration directory:

```bash
host=pc
host_dir=tobias-stationary

# For the laptop instead:
# host=laptop
# host_dir=tobias-laptop
```

Generate the target hardware configuration and replace the bootstrap file:

```bash
nixos-generate-config --root /mnt
cp /mnt/etc/nixos/hardware-configuration.nix \
  "/mnt/home/tobias/code/dotfiles/nixos/hosts/$host_dir/hardware-configuration.nix"
```

Review the generated filesystems before proceeding. They must contain the
correct root and EFI devices and must not declare Windows filesystems for
formatting.

Refuse to continue if the bootstrap placeholder is still present, then build
before installing:

```bash
cd /mnt/home/tobias/code/dotfiles/nixos
if grep -q "Bootstrap placeholder" "hosts/$host_dir/hardware-configuration.nix"; then
  echo "Hardware configuration was not replaced" >&2
  exit 1
fi
nix build --no-link ".#nixosConfigurations.$host.config.system.build.toplevel"
nixos-install --flake ".#$host"
nixos-enter --root /mnt -c 'passwd tobias'
nixos-enter --root /mnt -c 'chown -R tobias:users /home/tobias'
```

The native profile uses GRUB with OS probing because Windows EFI partitions
are often too small to hold NixOS kernels and generations. GRUB adds its own
EFI files without formatting the Windows EFI partition and keeps the kernels
on the NixOS root filesystem.

After rebooting, verify Windows Boot Manager is available from GRUB or the
firmware boot menu. Then apply the normal native rebuild and install the
mutable Pi/Codex tools and skill links:

```bash
~/.dotfiles/rebuild-nixos.sh --bootstrap
```

Add host-specific output blocks to `hosts/<host-directory>/niri.kdl` only after checking
the identifiers reported by:

```bash
niri msg outputs
```

The workstation uses the stable proprietary NVIDIA package with modesetting.
After the first boot, verify the exact GPU and active driver with:

```bash
lspci -nnk | grep -A3 -E 'VGA|3D|Display'
nvidia-smi
```

### Server / Bare Metal

From the NixOS installer:

```bash
sudo -i
nmtui
mount /dev/disk/by-label/nixos /mnt
mkdir -p /mnt/boot
mount /dev/disk/by-label/boot /mnt/boot
nixos-generate-config --root /mnt
```

Use `nmtui` to join Wi-Fi before partitioning or installing. The `laptop-server` config enables NetworkManager, so after the installed system boots you can also run:

```bash
sudo nmtui
```

Copy this repo onto the installed system, then replace the placeholder hardware file:

```bash
cp /mnt/etc/nixos/hardware-configuration.nix /mnt/path/to/dotfiles/nixos/hosts/laptop-server/hardware-configuration.nix
```

Before the first rebuild, edit `hosts/laptop-server/configuration.nix` and replace the placeholder SSH key.

Install with:

```bash
nixos-install --flake /mnt/path/to/dotfiles/nixos#laptop-server
```

After booting, join Tailscale without Tailscale SSH if you want normal OpenSSH key auth:

```bash
sudo tailscale up --ssh=false
```

Verify SSH from another Tailscale device:

```bash
ssh tobias@laptop-server
```

Use Windows Remote Desktop over Tailscale by connecting to `laptop-server` or the laptop's Tailscale IP. The config enables xrdp.

## Remote server operation

### Prefer normal OpenSSH over Tailscale

Tailscale MagicDNS can still be used with normal OpenSSH:

```bash
ssh tobias@laptop-server
```

Keep `services.openssh.enable = true` and declare `users.users.<user>.openssh.authorizedKeys.keys` in NixOS config. Disable Tailscale SSH with:

```bash
sudo tailscale up --ssh=false
```

Reason: Tailscale SSH may require browser re-auth/checks based on tailnet ACLs. Normal OpenSSH over the Tailscale IP uses SSH keys and avoids frequent Tailscale login prompts.

### Remote rebuild safety

Avoid plain interactive `nixos-rebuild switch` over SSH when changing any of these:

- NetworkManager/networking
- firewall rules
- SSH/OpenSSH
- Tailscale
- hostname
- remote desktop/NAS services needed for access

A switch may restart NetworkManager, firewall, tailscaled, or sshd. If the SSH session dies, the activation can be interrupted or leave you without remote access until local reboot.

Safer flake patterns:

```bash
cd /path/to/dotfiles/nixos
nix build .#nixosConfigurations.laptop-server.config.system.build.toplevel
```

Then either apply on next boot:

```bash
sudo nixos-rebuild boot --flake .#laptop-server
sudo reboot
```

or run the switch detached under systemd so it keeps running after SSH drops:

```bash
sudo systemd-run --unit=nixos-switch --collect --same-dir \
  nixos-rebuild switch --flake .#laptop-server
```

For risky changes, keep local console/keyboard access available.

### Remote update from Windows

From this repo on Windows:

```powershell
scp -r .\nixos\* tobias@laptop-server:~/dotfiles-nixos/
ssh tobias@laptop-server "cd ~/dotfiles-nixos && nix build .#nixosConfigurations.laptop-server.config.system.build.toplevel"
ssh tobias@laptop-server "sudo /run/current-system/sw/bin/nixos-rebuild switch --flake /home/tobias/dotfiles-nixos"
```

Use the last command only after the build succeeds. The config grants `tobias`
passwordless sudo for that exact rebuild command, while normal sudo still
requires a password.

### NAS access: split LAN and remote paths

For home use, prefer LAN SMB path:

```text
\\192.168.86.209\nas
```

For remote use, prefer Tailscale MagicDNS:

```text
\\laptop-server\nas
```

Samba `hosts allow` should include both Tailscale and home LAN ranges, for example:

```nix
"hosts allow" = "100.64.0.0/10 192.168.86.0/24 127.0.0.1";
"hosts deny" = "0.0.0.0/0";
```

Reason: local NAS should not depend on Tailscale DERP/control-plane/DNS health while at home.

## Notes

- Tailscale is enabled, but the machine is not automatically joined to a tailnet. Run `tailscale up --ssh=false` after boot or add an auth-key based flow later.
- `hardware-configuration.nix` is intentionally machine-specific. Do not reuse it across laptops without regenerating it.
- Automatic system upgrades are not enabled by default because the final flake path depends on where you keep this repo on the installed machine.
- Public internet exposure should be added deliberately with Tailscale Funnel, a reverse proxy, or router port forwarding only after the private setup is working.
