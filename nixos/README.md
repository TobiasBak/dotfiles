# NixOS

This directory contains flake-based NixOS host configs.

## Hosts

- `wsl`: NixOS-WSL developer environment used as the default Windows WSL distro.
- `pc`: native Niri/Quickshell developer workstation with NVIDIA graphics and Docker.
- `laptop`: native Niri/Quickshell developer laptop with integrated graphics, laptop power management, and Docker.
- `tobias-serv01`: NixOS file server with Docker, Samba, SSH, and Tailscale.

## Source of truth

Every bare-metal NixOS host must run the configuration from this repo. Do not
make lasting edits directly in `/etc/nixos/configuration.nix`. Change files
under `nixos/`, copy or pull the repo on the target, build the host toplevel,
and use the host-specific flow below. Remote servers use the detached
activation documented under [Remote server operation](#remote-server-operation).
If an emergency edit is made on a host, copy it back into this repo
immediately. `/etc/nixos` is not the source of truth.

Each installed bare-metal host keeps its generated hardware configuration in
its own host directory. For example:

```bash
cp /etc/nixos/hardware-configuration.nix \
  /path/to/dotfiles/nixos/hosts/tobias-serv01/hardware-configuration.nix
```

Never reuse a generated hardware configuration between machines. The standard
generated-file header may say to edit `/etc/nixos/configuration.nix`; in this
repo that means: do not hand-edit the generated hardware file for ordinary
machine configuration. Put those changes in the host's `configuration.nix`.
If detected disks or hardware change, regenerate the file and copy it into the
host directory instead. Do not make `/etc/nixos/configuration.nix` the lasting
copy.

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

The developer hosts import Home Manager as part of their NixOS systems. Shared
home state lives in `home/tobias/common.nix`, while the WSL and native desktop
modules add only their platform-specific state. The bootstrap remains
responsible for cloning repositories, repairing mutable links, and updating
tools that are not packaged by Nix.

Manual Windows-side repair:

```powershell
powershell -ExecutionPolicy Bypass -File .\rebuild-windows.ps1
```

Manual in-distro rebuild:

```bash
~/.dotfiles/rebuild-wsl.sh
```

For a NixOS or Home Manager-only change, skip the mutable bootstrap work:

```bash
~/.dotfiles/rebuild-wsl.sh --nixos-only
```

`--nixos-only` still applies the embedded Home Manager configuration. It skips
only user config link repair, mutable Codex/Pi installs, and skill link
refresh.

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

The `pc` host contains the generated hardware configuration for its existing
machine. The `laptop` host intentionally retains a clearly marked bootstrap
`hardware-configuration.nix` because its flake output is needed by the
first-install flow. That placeholder omits the root filesystem, so a full
`laptop` toplevel build and a flake-wide check cannot succeed until it is
replaced on the target. This is the expected safe limitation. Do not add a
guessed or fake filesystem just to make evaluation pass.

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

Choose exactly one host:

```bash
host=pc
# host=laptop
```

Generate the target hardware configuration and replace the chosen host's
machine-specific file:

```bash
nixos-generate-config --root /mnt
cp /mnt/etc/nixos/hardware-configuration.nix \
  "/mnt/home/tobias/code/dotfiles/nixos/hosts/$host/hardware-configuration.nix"
```

Review the generated filesystems before proceeding. They must contain the
correct root and EFI devices and must not declare Windows filesystems for
formatting.

For `laptop`, refuse to continue if the bootstrap placeholder is still
present. Then build before installing:

```bash
cd /mnt/home/tobias/code/dotfiles/nixos
if grep -q "Bootstrap placeholder" "hosts/$host/hardware-configuration.nix"; then
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

Add host-specific output blocks to `hosts/<host>/niri.kdl` only after checking
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

### Servers / bare metal

The server has a fixed role and expected checkout path:

| Host | Expected flake directory | Services | NAS storage |
| --- | --- | --- | --- |
| `tobias-serv01` | `/home/tobias/code/dotfiles/nixos` | Docker, Samba, SSH, Tailscale | Dedicated ext4 disk mounted at `/srv/nas`; share data in `/srv/nas/files` |

The path is part of the host's exact passwordless activation rule. If the
checkout moves, update the host's configuration and this documentation
together.

From the NixOS installer, adapt the devices and mount points to the target's
actual partitioning:

```bash
sudo -i
nmtui
mount /dev/disk/by-label/nixos /mnt
mkdir -p /mnt/boot
mount /dev/disk/by-label/boot /mnt/boot
nixos-generate-config --root /mnt
```

Use `nmtui` to join Wi-Fi before partitioning or installing. The server uses
NetworkManager. After boot, it remains available as `sudo nmtui`.

Copy the repository to the expected path, choose exactly one host, and copy the
target's newly generated hardware configuration over that host's committed
machine-specific file. The committed server hardware files describe the
existing physical machines; they are not generic placeholders.

```bash
host=tobias-serv01
repo=/mnt/home/tobias/code/dotfiles/nixos

cp /mnt/etc/nixos/hardware-configuration.nix \
  "$repo/hosts/$host/hardware-configuration.nix"
nix build --no-link \
  "$repo#nixosConfigurations.$host.config.system.build.toplevel"
nixos-install --flake "$repo#$host"
```

The authorized keys already declared in the server configuration are real
public keys, not placeholders. Before installation, confirm that at least one
corresponding private key is available to the operator. Add the intended
operator's public key if necessary, and remove obsolete keys only after new
access has been verified.

After booting, join Tailscale without enabling Tailscale SSH, then verify normal
OpenSSH key authentication from another Tailscale device:

```bash
sudo tailscale up --ssh=false
ssh tobias@tobias-serv01
```

## Remote server operation

### Prefer normal OpenSSH over Tailscale

Tailscale MagicDNS can be used with normal OpenSSH:

```bash
ssh tobias@tobias-serv01
```

Keep `services.openssh.enable = true` and declare
`users.users.<user>.openssh.authorizedKeys.keys` in NixOS configuration. Keep
Tailscale SSH disabled with `sudo tailscale up --ssh=false`. Tailscale SSH may
require browser reauthentication based on tailnet ACLs; normal OpenSSH over the
Tailscale IP uses the declared SSH keys.

### Detached remote activation

Never run a plain interactive `nixos-rebuild switch` over SSH. An activation
may restart NetworkManager, the firewall, tailscaled, or sshd. If the session
drops, an interactive command can be interrupted.

The server configuration declares its user-owned dotfiles checkout as a safe
Git directory for root. When bootstrapping from an older generation that lacks
that declaration, run this once before the detached activation:

```bash
sudo git config --global --add safe.directory /home/tobias/code/dotfiles
```

Build first as the normal user, using the path and host that match the target:

```bash
cd /home/tobias/code/dotfiles/nixos
nix build --no-link \
  .#nixosConfigurations.tobias-serv01.config.system.build.toplevel
```

After the build succeeds, use the matching exact detached activation:

```bash
sudo /run/current-system/sw/bin/systemd-run \
  --setenv=PATH=/run/current-system/sw/bin \
  --unit=nixos-switch-tobias-serv01 --collect --service-type=exec \
  /run/current-system/sw/bin/nixos-rebuild switch \
  --flake /home/tobias/code/dotfiles/nixos#tobias-serv01
```

The transient service continues if SSH disconnects. Check `systemctl status`
while it is running and use the journal after completion. Because `--collect`
unloads the finished unit, it may no longer appear in `systemctl status`.

```bash
systemctl status nixos-switch-tobias-serv01.service
journalctl -u nixos-switch-tobias-serv01.service
```

The server grants `tobias` passwordless sudo only for its exact
`systemd-run` invocation. Normal sudo still requires a password. Do not add
arguments or change the path or unit name. For risky networking, SSH,
Tailscale, firewall, remote desktop, or NAS changes, keep local console access
available.

### Remote update from Windows

`tobias-serv01` uses the full dotfiles checkout. Update that checkout through
its normal Git workflow, then build and activate it:

```powershell
ssh tobias@tobias-serv01 "cd /home/tobias/code/dotfiles/nixos && nix build --no-link .#nixosConfigurations.tobias-serv01.config.system.build.toplevel"
ssh tobias@tobias-serv01 "sudo /run/current-system/sw/bin/systemd-run --setenv=PATH=/run/current-system/sw/bin --unit=nixos-switch-tobias-serv01 --collect --service-type=exec /run/current-system/sw/bin/nixos-rebuild switch --flake /home/tobias/code/dotfiles/nixos#tobias-serv01"
```

Run the activation command only after its matching build succeeds.

### NAS access: LAN and Tailscale paths

The Samba configuration allows the Tailscale range, the home LAN, and
localhost at the application layer. `services.samba.openFirewall` provides the
SMB firewall ports, so separate `tailscale0` port 445 rules are unnecessary.
Prefer a LAN address while at home so access does not depend on Tailscale DNS
or relay health.

| Host | LAN SMB path | Tailscale MagicDNS path | Server directory |
| --- | --- | --- | --- |
| `tobias-serv01` | `\\192.168.86.209\nas` | `\\tobias-serv01\nas` | `/srv/nas/files` |

If `192.168.86.209` is reassigned, use the current LAN address and update this
documentation. The allow list in the host configuration is:

```nix
"hosts allow" = "100.64.0.0/10 192.168.86.0/24 127.0.0.1";
"hosts deny" = "0.0.0.0/0";
```

## Notes

- Tailscale is enabled, but hosts are not automatically joined to a tailnet.
  Run `tailscale up --ssh=false` after boot or add an auth-key flow later.
- Every `hardware-configuration.nix` is machine-specific. Regenerate it for a
  different machine rather than reusing or inventing filesystem entries.
- Automatic system upgrades are not enabled because each installed server must
  use its documented flake path.
- Add public internet exposure only deliberately, after private access works.
