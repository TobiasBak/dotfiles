# NixOS

This directory contains flake-based NixOS host configs.

## Hosts

- `laptop-server`: headless lab server with SSH, Tailscale, Docker/Compose, Samba, firewall, garbage collection, and laptop sleep disabled.
- `tobias-serv01`: main runner/server with SSH, Tailscale, Docker/Compose, Samba, firewall, garbage collection, and sleep/hibernation disabled.

## Source of truth

`laptop-server` must run the config from this repo. Do not make lasting edits
directly in `/etc/nixos/configuration.nix` on the laptop. Change files under
`nixos/` here, pull the public repo on the laptop, then rebuild from the flake:

```bash
cd /path/to/dotfiles/nixos
nix build --no-link .#nixosConfigurations.laptop-server.config.system.build.toplevel
sudo nixos-rebuild switch --flake .#laptop-server
```

If emergency changes are made on the laptop, immediately copy them back into
this repo and rebuild from the flake. `/etc/nixos` is not the source of truth.

The generated hardware config is the only machine-specific file expected in the
repo:

```bash
cp /etc/nixos/hardware-configuration.nix /path/to/dotfiles/nixos/hosts/laptop-server/hardware-configuration.nix
```

For `tobias-serv01`, copy the generated hardware config to:

```bash
cp /etc/nixos/hardware-configuration.nix /path/to/dotfiles/nixos/hosts/tobias-serv01/hardware-configuration.nix
```

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

The host is intended to be managed headlessly over SSH:

```bash
ssh tobias@laptop-server
```

Docker and Docker Compose are enabled for ad hoc lab services. The `tobias`
user is in the `docker` group, which is root-equivalent access to the host. Log
out and back in after the rebuild if `docker ps` still requires elevated
permissions.

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

This homelab config allows normal password login for the `tobias` user as a
recovery path, while keeping direct root SSH disabled. SSH keys are still the
preferred day-to-day path and should be kept declared in the host config.

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
nix build --no-link .#nixosConfigurations.laptop-server.config.system.build.toplevel
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
ssh tobias@laptop-server "mkdir -p ~/code && test -d ~/code/dotfiles/.git || git clone https://github.com/TobiasBak/dotfiles.git ~/code/dotfiles"
ssh tobias@laptop-server "cd ~/code/dotfiles && git pull --ff-only"
ssh tobias@laptop-server "cd ~/code/dotfiles/nixos && nix build --no-link .#nixosConfigurations.laptop-server.config.system.build.toplevel"
ssh tobias@laptop-server "sudo /run/current-system/sw/bin/nixos-rebuild switch --flake /home/tobias/code/dotfiles/nixos"
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
