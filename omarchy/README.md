# Omarchy

The `pc` can run [Omarchy](https://omarchy.org) on its 2 TB disk while NixOS
stays on the 1 TB disk as the fallback. Omarchy owns the desktop (Hyprland,
Waybar, their configs, its updates). This repository owns the rest, from the
same Home Manager modules NixOS uses.

- `nixos/home/tobias/omarchy.nix`: standalone Home Manager configuration
  `tobias@omarchy` (shell, agent configs and links, CLI tools, T3's drop-in and
  memory slice, Taildrop receiver, nightly restic backup).
- `bootstrap.sh`: host setup. It installs `packages.txt` through Omarchy's
  updater, puts Nix on its own Btrfs subvolume, activates Home Manager, sets
  zsh, Tailscale, lingering, the Tailnet-only firewall rule for 3773, and
  installs T3's service. `--tpm2` also switches to the systemd initramfs that
  TPM2 unlock needs. Safe to rerun. Exits 2 while human steps remain.
- `migrate-home.sh`: copies agent state, `~/code` and credentials from the
  read-only NixOS root at the same paths, and restores the parked Orderready. `--tailscale` also takes
  over NixOS's Tailscale identity.
- `orderready.rsync-filter`: what Orderready parking and migration copy.

Proven in a VM: the Omarchy installer flow and its quirks below, package
install through `omarchy-update`, Nix on its own subvolume, and the flake
fetch. Everything from Home Manager activation on is untested and marked so in
the scripts.

Games, projects and Orderready live on Omarchy's Btrfs root.

## Disks

Identify disks by model and serial, never by `nvme` index:

| Disk | Model | Serial ends | Role |
| --- | --- | --- | --- |
| 2 TB | KINGSTON SFYRD2000G | `9170A9` | Wiped; Omarchy |
| 1 TB | KINGSTON SNV3S1000G | | NixOS fallback; never touch |

## 1. Before the window (agents, on NixOS)

1. Orderready pushes its branches, commits dirty work to WIP branches and
   pauses.
2. Park Orderready in the NixOS home. This needs no root:

   ```sh
   filter=~/code/dotfiles/omarchy/orderready.rsync-filter
   park=/home/tobias/orderready-park
   rsync -aHAX --info=progress2 --filter="merge $filter" \
     /mnt/data-2tb/orderready/ "$park/"
   ```

   About 68 GiB (852k files) on 2026-10-11, against 353 GiB free on the NixOS
   root. `migrate-home.sh` restores it to `/mnt/data-2tb/orderready` on
   Omarchy, the path T3's database records.
3. Verify the park before anything is wiped. The `wt/platform-*` worktrees
   are unpushed and this copy is their only backup. The dry run must print
   nothing, and each worktree must show the same status and HEAD on both
   sides. `--no-optional-locks` keeps git from rewriting the index the two
   copies share:

   ```sh
   rsync -naHAXc --delete -i --filter="merge $filter" \
     /mnt/data-2tb/orderready/ "$park/"
   for wt in /mnt/data-2tb/orderready/wt/platform-*; do
     parked=$park/wt/${wt##*/}
     diff <(git -C "$wt" --no-optional-locks status --short; git -C "$wt" rev-parse HEAD) \
          <(git -C "$parked" --no-optional-locks status --short; git -C "$parked" rev-parse HEAD) &&
       echo "ok $wt"
   done
   ```

   The worktrees' git metadata lives in `~/code/orderready{,-platform}/.git`
   and Orderready's cache in `~/.cache/orderready`, both already on the NixOS
   root.
4. Copy anything else still wanted off the 2 TB disk. All of it is lost.
   NixOS's `/mnt/data-2tb` mount is `nofail`, so NixOS boots without the disk;
   the next NixOS rebuild drops the mount.

## 2. Install

1. Boot the Omarchy ISO from the firmware boot menu.
2. In the live session, open a terminal and find the 2 TB disk:

   ```sh
   lsblk -o NAME,MODEL,SERIAL,SIZE
   ```

   Note the name with model `KINGSTON SFYRD2000G` and serial ending `9170A9`.
3. Run the installer. Choose **Full disk install** on that disk only. Keep the
   encryption default (on). Hostname `pc`, user `tobias`.
4. If the install fails while mounting the ESP, run `sudo modprobe vfat` and
   start the installer again.

## 3. First boot on Omarchy

1. Unlock with the LUKS passphrase. Omarchy logs in to Hyprland by itself.
2. Network: plug in Ethernet, or pick Wi-Fi from the top bar's network icon.
   Check with `ping -c1 github.com`.
3. Install Pi and log in, so it can repair anything below:

   ```sh
   npm install -g @earendil-works/pi-coding-agent && mise reshim
   pi
   ```

   In Pi, run `/login`. If `npm` is missing, use
   `npx -y @earendil-works/pi-coding-agent`.
4. Get the dotfiles. The repository is public, so cloning needs no auth:

   ```sh
   git clone https://github.com/TobiasBak/dotfiles.git ~/code/dotfiles
   ```

5. Run the bootstrap. It asks for the sudo password:

   ```sh
   ~/code/dotfiles/omarchy/bootstrap.sh
   ```

   It prints the remaining human steps. Push access comes later with
   `gh auth login`.
6. Mount the NixOS root read-only and migrate. The NixOS root is the ext4
   partition labelled `root` on the SNV3S1000G disk
   (`lsblk -o NAME,MODEL,SIZE,FSTYPE,LABEL`). `--tailscale` makes this
   install the tailnet's `pc`:

   ```sh
   sudo mkdir -p /mnt/nixos
   sudo mount -o ro /dev/<SNV3S1000G root partition> /mnt/nixos
   ~/code/dotfiles/omarchy/migrate-home.sh --source /mnt/nixos --tailscale
   ```

   For a fresh tailnet node instead, skip `--tailscale` and run
   `sudo tailscale up`.
7. Check T3 locally and over Tailscale:

   ```sh
   systemctl --user status t3code.service
   curl -sI http://127.0.0.1:3773 | head -1
   tailscale status | head -3
   tailscale serve status
   ```

   From another tailnet device, open `https://pc.<tailnet>.ts.net`.
8. TPM2 unlock. First switch to the systemd initramfs and reboot once while
   the passphrase still works:

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
9. Rerun `bootstrap.sh` until it prints `Bootstrap complete.`, then sign in to
   claude and codex on first use.

If any step fails, start `pi` in `~/code/dotfiles` and paste:

> Read `omarchy/README.md`, `omarchy/bootstrap.sh` and `omarchy/migrate-home.sh`
> in this repository. We are at step <N> of "First boot on Omarchy" and it
> failed with: <error>. Diagnose it on this machine and finish the remaining
> steps through "T3 up and reachable over Tailscale". The scripts mark
> untested parts; fix the scripts rather than working around them, keep them
> safe to rerun, and commit the fixes on a branch. Never touch the KINGSTON
> SNV3S1000G disk except to mount its root read-only. Ask me before anything
> that needs a password, the LUKS passphrase or a reboot.

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

If Omarchy took over the Tailscale identity and NixOS later fails to connect,
stop `tailscaled` on NixOS, delete `/var/lib/tailscale/tailscaled.state` and
run `sudo tailscale up --hostname pc-nixos`. Never run `tailscale logout`; it
would remove the shared node.

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
- Update T3 with this system's `npx`:
  `systemd-run --user --collect --unit=t3code-update --service-type=exec --working-directory=/home/tobias -- /home/tobias/.nix-profile/bin/npx --yes t3@nightly update --channel nightly --yes`
- Not ported from NixOS: Steam, gamescope, the Windows VM, Stremio, the NAS
  mount and the pc's other system packages.
