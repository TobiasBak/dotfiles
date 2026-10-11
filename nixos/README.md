# NixOS: tobias-serv01

This flake configures one host, `tobias-serv01`: a NixOS file server with
Docker, Samba, SSH, Tailscale, Hermes and Kanban. Hermes is documented in
`hosts/tobias-serv01/README.md`. No workstation runs NixOS; Omarchy is set up
by `../dot`, never by this flake, and the Omarchy workstation never runs Nix.

`flake.nix` still declares the inputs `hunk`, `nixos-wsl`, `home-manager` and
`voxtype`, which no output uses. They stay until `nix flake lock` prunes them
on serv01, because `flake.lock` is generated and only changes through Nix.

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

## Install

The server has a fixed role and expected checkout path:

| Host | Expected flake directory | Services | NAS storage |
| --- | --- | --- | --- |
| `tobias-serv01` | `/home/tobias/code/dotfiles/nixos` | Docker, Samba, SSH, Tailscale | Dedicated ext4 disk mounted at `/srv/nas`; share data in `/srv/nas/files` |

The detached activation below uses this path. If the checkout moves, update
this documentation and the activation command together.

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

## Remote operation

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

The server grants `tobias` unrestricted passwordless sudo for remote agent
administration. SSH access as `tobias` therefore provides full root access.
Keep remote rebuilds detached using the command above. For risky networking,
SSH, Tailscale, firewall, remote desktop, or NAS changes, keep local console
access available.

### Remote update

`tobias-serv01` uses the full dotfiles checkout. Update that checkout through
its normal Git workflow, then build and activate it:

```bash
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
| `tobias-serv01` | `\\192.168.1.53\nas` | `\\tobias-serv01\nas` | `/srv/nas/files` |

If `192.168.1.53` is reassigned, use the current LAN address and update this
documentation. The allow list in the host configuration is:

```nix
"hosts allow" = "100.64.0.0/10 192.168.1.0/24 127.0.0.1";
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
