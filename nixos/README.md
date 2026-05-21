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

After booting:

```bash
sudo tailscale up --ssh
```

Verify SSH from another Tailscale device:

```bash
ssh tobias@laptop-server
```

Use Windows Remote Desktop over Tailscale by connecting to `laptop-server` or the laptop's Tailscale IP. The config enables xrdp but does not open the normal LAN firewall port for RDP.

## Notes

- Tailscale is enabled, but the machine is not automatically joined to a tailnet. Run `tailscale up` after boot or add an auth-key based flow later.
- `hardware-configuration.nix` is intentionally machine-specific. Do not reuse it across laptops without regenerating it.
- Automatic system upgrades are not enabled by default because the final flake path depends on where you keep this repo on the installed machine.
- Public internet exposure should be added deliberately with Tailscale Funnel, a reverse proxy, or router port forwarding only after the private setup is working.
