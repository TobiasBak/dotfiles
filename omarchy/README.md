# Omarchy

Omarchy and NixOS are separate setups. This directory owns native Omarchy
setup: mise, pacman/AUR and plain systemd user units. It never installs Nix,
activates Home Manager, changes the login shell or touches a disk. `nixos/`
owns NixOS and WSL; its modules are not used here. Both may reuse files under
`configs/` and the agent-only installer under `scripts/`.

Omarchy owns the desktop, terminal and its updates. User monitor and other
Hyprland settings remain in `~/.config/hypr/`, not managed by this repo.

## Setup

Requires an installed Omarchy desktop with mise, Git, Python, Tailscale,
`yay`, and the build tools needed by `makepkg`. The bootstrap uses the current
user and home directory, not a fixed username or hostname.

1. Clone `dotfiles`, `vault-public` and `pi-workspace-view` as sibling
   repositories. The workspace extension is private; log into GitHub first.
2. Finish or stop hosted agents and quit the T3 desktop app. The script refuses
   to migrate while it is open.
3. In a visible terminal, run:

   ```sh
   ~/code/dotfiles/omarchy/bootstrap.sh
   ```

   Enter your sudo password when asked. The script:
   - Installs global instructions, vault skills and Pi settings without Nix.
   - Sets mise's package manager to pnpm and selects pnpm 11 for T3 installs.
   - Saves a private copy of T3's existing state under
     `~/.local/state/t3-migration/`.
   - Disables the desktop app's own backend.
   - Builds the current AUR `t3code-nightly-bin` before replacing stable.
   - Installs T3's official background service on the nightly channel.
   - Installs this directory's resource slice and nightly-update timer.
   - Enables user lingering and publishes the loopback server through
     Tailscale Serve. If Tailscale is logged out, it exits 2 with instructions.
4. Open **T3 Code Nightly**, run `t3 pair` in a terminal, and add the resulting
   environment in the app. Pairing links expire and are credentials; do not
   commit them.
5. Open a thread on the vault and invoke `/chief-of-staff` yourself.

The background service owns port 3773 and `~/.t3/userdata`. The app is only a
client. The server binds to `127.0.0.1`, never the LAN. Tailscale Serve exposes
it over Tailnet HTTPS. No LAN firewall rule is needed for a loopback listener.

## Verify and update

```sh
systemctl --user status t3code.service
curl -sI http://127.0.0.1:3773 | head -1
tailscale serve status
systemctl --user list-timers t3code-update.timer
loginctl show-user "$USER" -p Linger
t3 --version
pacman -Q t3code-nightly-bin
```

`systemd/` contains the native units. `t3-nightly.sh` resolves the current
nightly version, installs its CLI through mise with pnpm, and asks T3 to
update its service runtime. At 05:00 the timer runs it automatically. A version
change restarts the server and interrupts hosted agent turns. An agent inside
T3 must start the updater without waiting on its own restart:

```sh
systemctl --user start --no-block t3code-update.service
journalctl --user -u t3code-update.service
```

The service runtime and the desktop package update separately. Quit the app
and rerun the bootstrap to update the AUR desktop package. Omarchy also has a
repository package with the same name; an Omarchy update may replace the AUR
build once its version is newer. `mise use -g` and `mise settings set` own mise
configuration; do not hand-edit Omarchy's global mise config.

## Backups and cold storage

The migration snapshot is local rollback storage, not a remote backup. Native
remote backup automation has not been installed. Do not claim nightly backups
are working until a real backup and restore have passed. Credentials must not
be committed or printed.

On Tobias's current desktop, Omarchy is on the 2 TB KINGSTON SFYRD2000G with
serial ending `9170A9`. NixOS remains on the 1 TB KINGSTON SNV3S1000G as cold
storage. Identify disks by model and serial, never by `nvme` index. Nothing in
this bootstrap mounts, formats or modifies that disk.

If recovery is requested, mount NixOS's ext4 root **read-only without journal
replay** using `mount -o ro,noload`. Its old home is `/home/tobias`; the backup
password is `.config/restic/t3-password` there. SSH access to the backup server
also needs an accepted key. Restoring either is a separate privileged step.

TPM enrollment, initramfs changes, boot order changes and autologin are not
part of this setup. `mkinitcpio-tpm2.conf` and `orderready.rsync-filter` are
manual migration assets, not instructions to change this machine unattended.
