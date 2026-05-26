# NixOS

This directory contains flake-based NixOS host configs.

## Hosts

- `laptop-server`: lightweight laptop server with XFCE, xrdp, SSH, Tailscale, firewall, garbage collection, and laptop sleep disabled.

## Install flow

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

Install or rebuild with:

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

Use Windows Remote Desktop over Tailscale by connecting to `laptop-server` or the laptop's Tailscale IP. The config enables xrdp but does not open the normal LAN firewall port for RDP.

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

Safer patterns:

```bash
sudo nixos-rebuild dry-build -I nixos-config=/etc/nixos/configuration.nix
```

Then either apply on next boot:

```bash
sudo nixos-rebuild boot -I nixos-config=/etc/nixos/configuration.nix
sudo reboot
```

or run the switch detached under systemd so it keeps running after SSH drops:

```bash
sudo systemd-run --unit=nixos-switch --collect --same-dir \
  nixos-rebuild switch -I nixos-config=/etc/nixos/configuration.nix
```

For risky changes, keep local console/keyboard access available.

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

- Tailscale is enabled, but the machine is not automatically joined to a tailnet. Run `tailscale up` after boot or add an auth-key based flow later.
- `hardware-configuration.nix` is intentionally machine-specific. Do not reuse it across laptops without regenerating it.
- Automatic system upgrades are not enabled by default because the final flake path depends on where you keep this repo on the installed machine.
- Public internet exposure should be added deliberately with Tailscale Funnel, a reverse proxy, or router port forwarding only after the private setup is working.
