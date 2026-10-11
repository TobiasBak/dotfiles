# Omarchy

The `pc` can run [Omarchy](https://omarchy.org) on its 2 TB disk while NixOS
stays on the 1 TB disk as the fallback and cold storage. Under Omarchy the
machine is `tb-omarchy`, user `tb`, on the tailnet as `tb-omarchy`; NixOS stays
`pc`, user `tobias`. Omarchy owns the
desktop (Hyprland, Waybar, their configs, its updates). This repository owns
the rest, from the same Home Manager modules NixOS uses.

Omarchy starts fresh and git first: repositories are cloned from their
remotes, logins are redone, and T3 starts without history. New teams pick up
from the handoffs in the repositories and the chief of staff's vault state.
Nothing is copied from NixOS except on demand from cold storage.

- `nixos/home/tobias/omarchy.nix`: standalone Home Manager configuration
  `<user>@omarchy`, defined for `tb` and `tobias` in `nixos/flake.nix` (shell,
  agent configs and links, CLI tools, T3's drop-in, memory slice and daily
  update timer, Taildrop receiver, nightly restic backup).
- `bootstrap.sh`: host setup. It installs `packages.txt` through Omarchy's
  updater, puts Nix on its own Btrfs subvolume, activates `$USER@omarchy`,
  sets zsh, Tailscale, lingering, the Tailnet-only firewall rule for 3773,
  the mise tools, clones `vault-public`, installs T3 Code Nightly from the AUR
  and T3's service. `--tpm2` also switches to the systemd initramfs that TPM2
  unlock needs. Safe to rerun. Exits 2 while human steps remain.
- `t3-nightly.sh`: moves T3's CLI and service to the newest nightly. The
  `t3code-update` timer runs it daily.
- `orderready.rsync-filter`: what the Orderready cold-storage park copies.

Proven in a VM: the Omarchy installer flow and its quirks below, package
install through `omarchy-update`, Nix on its own subvolume, and the flake
fetch. Everything from Home Manager activation on is untested and marked so in
the scripts.

## Disks

Identify disks by model and serial, never by `nvme` index:

| Disk | Model | Serial ends | Role |
| --- | --- | --- | --- |
| 2 TB | KINGSTON SFYRD2000G | `9170A9` | Wiped; Omarchy |
| 1 TB | KINGSTON SNV3S1000G | | NixOS fallback; never touch |

## 1. Before the window (agents, on NixOS)

1. Orderready pushes its committed branches and pauses its workers. Dirty
   worktrees stay as they are; the park copies them.
2. Park Orderready's non-git data (`evidence/`, `briefs/`, `artifacts/`,
   `explore/`, worktrees with their `target/or/artifacts/`) in the NixOS home
   as cold storage. This needs no root. The filter leaves the rebuildable
   `cache/`, `oip-parity/` and `oip-r1/` behind, and skips the mode 000
   `runtime/state/denied` test fixtures:

   ```sh
   filter=~/code/dotfiles/omarchy/orderready.rsync-filter
   park=/home/tobias/orderready-park
   rsync -aHAX --info=progress2 --filter="merge $filter" \
     /mnt/data-2tb/orderready/ "$park/"
   ```

3. Verify the park before anything is wiped. The dry run must print nothing,
   and each worktree must show the same status and HEAD on both sides.
   `--no-optional-locks` keeps git from rewriting the index the two copies
   share:

   ```sh
   rsync -naHAXc --delete -i --filter="merge $filter" \
     /mnt/data-2tb/orderready/ "$park/"
   for wt in /mnt/data-2tb/orderready/wt/*/; do
     wt=${wt%/}; parked=$park/wt/${wt##*/}
     diff <(git -C "$wt" --no-optional-locks status --short; git -C "$wt" rev-parse HEAD) \
          <(git -C "$parked" --no-optional-locks status --short; git -C "$parked" rev-parse HEAD) &&
       echo "ok $wt"
   done
   ```

4. Copy anything else still wanted off the 2 TB disk. All of it is lost.
   NixOS's `/mnt/data-2tb` mount is `nofail`, so NixOS boots without the disk;
   the next NixOS rebuild drops the mount.

## 2. Install

1. Boot the Ventoy stick from the firmware boot menu (F-key at power-on) and
   pick `omarchy-4.0.4.iso`.
2. In the live session, open a terminal and find the 2 TB disk:

   ```sh
   lsblk -o NAME,MODEL,SERIAL,SIZE
   ```

   Note the name with model `KINGSTON SFYRD2000G` and serial ending `9170A9`.
3. Run the installer. Choose **Full disk install** on that disk only. Keep the
   encryption default (on). This install used hostname `tb-omarchy` and user
   `tb`; the bootstrap follows whatever user runs it.
4. If the install fails while mounting the ESP, run `sudo modprobe vfat` and
   start the installer again.

## 3. First boot on Omarchy

1. Unlock with the LUKS passphrase. Omarchy logs in to Hyprland by itself.
   Network: plug in Ethernet, or pick Wi-Fi from the top bar's network icon.
   Check with `ping -c1 github.com`.
2. Start Pi and log in, so it can repair anything below. Omarchy's `pi`
   wrapper installs it through mise on first run:

   ```sh
   pi
   ```

   In Pi, run `/login`.
3. Get the dotfiles. The repository is public, so cloning needs no auth:

   ```sh
   git clone https://github.com/TobiasBak/dotfiles.git ~/code/dotfiles
   ```

4. Quit the T3 Code desktop app if it runs: its own server holds port 3773
   and the state the service takes over. Then run the bootstrap from a
   terminal. It asks for the sudo password and prints the remaining human
   steps:

   ```sh
   ~/code/dotfiles/omarchy/bootstrap.sh
   ```

5. Tailscale: the machine joins as `tb-omarchy`, its hostname, and keeps that
   name. If `tailscale status` shows it logged out, run `sudo tailscale up`.
   T3's HTTPS name follows the node name.
6. Check T3 locally, over Tailscale and its update timer:

   ```sh
   systemctl --user status t3code.service
   curl -sI http://127.0.0.1:3773 | head -1
   tailscale serve status
   systemctl --user list-timers t3code-update.timer
   ```

   From another tailnet device, open `https://tb-omarchy.<tailnet>.ts.net`.
7. Connect the desktop app to the service. The bootstrap turned off the app's
   own server (`localEnvironmentEnabled: false` in
   `~/.t3/userdata/desktop-settings.json`). Mint a pairing link, start
   **T3 Code Nightly** and add the environment with it:

   ```sh
   t3 pair
   ```
8. Sign in to GitHub, then clone the private repositories the dotfiles link
   to. Pi loads `~/code/pi-workspace-view/src/snapshot.ts` as an extension;
   the link dangles until the clone exists:

   ```sh
   gh auth login
   gh repo clone TobiasBak/pi-workspace-view ~/code/pi-workspace-view
   ```

9. The vault: `bootstrap.sh` already cloned `TobiasBak/vault-public` to
   `~/code/vault-public` and linked its skills. Codex's trusted projects and
   hooks expect it at `~/vault` too:

   ```sh
   ln -sfn ~/code/vault-public ~/vault
   ```

10. Start the chief of staff: in T3, add the vault (`~/code/vault-public`) as a
   project, open a thread on it and run `/chief-of-staff`. It relaunches the
   teams from `state.md` and the repositories' handoffs. Claude and Codex ask
   for their logins on first use.
11. TPM2 unlock. First switch to the systemd initramfs and reboot once while
    the passphrase still works. The bootstrap finds the root's LUKS mapping,
    writes and checks `/etc/crypttab.initramfs`, and only then changes the
    hooks:

    ```sh
    ~/code/dotfiles/omarchy/bootstrap.sh --tpm2
    sudo reboot
    ```

    After it boots with the passphrase, enroll the TPM. It asks for the
    passphrase. The bootstrap prints the exact partition:

    ```sh
    sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=7 /dev/<omarchy luks partition>
    ```

    Reboot without touching the keyboard. The disk should unlock itself, and
    T3 should answer over Tailscale before anyone logs in. PCR 7 survives
    kernel updates. After firmware or Secure Boot changes, unlock with the
    passphrase and re-enroll with `--wipe-slot=tpm2` added.
12. Rerun `bootstrap.sh` until it prints `Bootstrap complete.`

If any step fails, start `pi` in `~/code/dotfiles` and paste:

> Read `omarchy/README.md` and `omarchy/bootstrap.sh` in this repository. We
> are at step <N> of "First boot on Omarchy" and it failed with: <error>.
> Diagnose it on this machine and finish the remaining steps through "T3 up
> and reachable over Tailscale". The script marks untested parts; fix it
> rather than working around it, keep it safe to rerun, and commit the fixes
> on a branch. Never touch the KINGSTON SNV3S1000G disk except to mount its
> root with `-o ro,noload`. Ask me before anything that needs a password, the
> LUKS passphrase or a reboot.

## Cold storage

The NixOS disk keeps everything Omarchy did not clone: the old home,
credentials, T3's history and the Orderready park in
`/home/tobias/orderready-park`. Mount its root read-only and without journal
replay, which a plain `ro` mount of ext4 still does, then copy what is
missing:

```sh
lsblk -o NAME,MODEL,SIZE,FSTYPE,LABEL      # ext4 labelled root on the SNV3S1000G
sudo mkdir -p /mnt/nixos
sudo mount -o ro,noload /dev/<SNV3S1000G root partition> /mnt/nixos
cp -a /mnt/nixos/home/tobias/<path> ~/<path>
sudo umount /mnt/nixos
```

The restic password for the nightly T3 backup is at
`/mnt/nixos/home/tobias/.config/restic/t3-password`.

## Restoring NixOS as the boot default

The installer puts its Limine entry first in the firmware boot order. NixOS's
entry (`NixOS-boot-efi`) and disk stay untouched. To boot NixOS once, pick it
in the firmware boot menu (usually F8, F11 or F12 at power-on). To make it the
default from Omarchy:

```sh
sudo efibootmgr                             # note the NixOS-boot-efi and Limine numbers
sudo efibootmgr -o <nixos>,<limine>         # NixOS by default
sudo efibootmgr -o <limine>,<nixos>         # Omarchy by default, at cut-over
```

Every NixOS rebuild reinstalls GRUB and moves `NixOS-boot-efi` back to the
front. Recheck the order after rebuilding NixOS.

NixOS keeps its own tailnet node, `pc`, next to Omarchy's `tb-omarchy`. If
that node was removed or its key expired, run `sudo tailscale up
--force-reauth` on NixOS to rejoin.

## Gotchas

- The installer asks for the disk, then defaults to **Full disk install**
  (Free space install is one row down). Pick the disk by serial, and check
  the summary before the final confirm.
- If mounting the ESP fails during install, run `modprobe vfat` and retry.
- The installer prepends its Limine entry to the boot order (see above).
- Direct `pacman -Syu` is blocked; use `omarchy update`.
- With TPM unlock, Omarchy's autologin opens Tobias's desktop with nobody
  present. T3 does not need autologin, because lingering starts it at boot.
  To turn it off, remove `/etc/sddm.conf.d/autologin.conf`.
- Snapper snapshots of `/` skip `/nix`, which is its own subvolume. After
  booting a snapshot, rerun the bootstrap.
- Omarchy's Taildrop receiver is masked; the Home Manager
  `taildrop-receiver` handles incoming files.
- T3's server follows the nightly by itself: `t3code-update.timer` runs
  `t3-nightly.sh` at 05:00. It resolves `pnpm view t3 dist-tags.nightly`,
  installs that exact version as the mise tool `npm:t3`, checks
  `t3 --version`, then runs `t3 update <version> --yes`, which restarts
  `t3code.service` only when its version changed. A restart interrupts agent
  turns running in it. Run it now with
  `systemctl --user start --no-block t3code-update.service`; `--no-block`
  keeps an agent inside T3 from waiting on its own restart. Logs:
  `journalctl --user -u t3code-update.service`.
- The desktop app is the AUR's `t3code-nightly-bin`. The Omarchy repository
  has a package of the same name, so `omarchy update` never updates the AUR
  build (yay treats it as a repository package) and swaps in the repository's
  build once that is newer. To jump to the AUR's newest, quit the app and rerun
  the bootstrap, or run `yay -S aur/t3code-nightly-bin`.
- mise owns Node, pnpm and the agent CLIs (`~/.config/mise/config.toml`, which
  Omarchy writes too) and installs npm packages with pnpm
  (`npm.package_manager = "pnpm"`). `omarchy update` upgrades them. Change the
  config with `mise use -g` and `mise settings set`, not by hand.
- Not ported from NixOS: Steam, gamescope, the Windows VM, Stremio, the NAS
  mount and the pc's other system packages.
