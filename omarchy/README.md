# Omarchy

This workstation uses native Omarchy packages, mise and systemd user units.
Omarchy owns its desktop defaults; this repo stores only personal overrides.
It never installs Nix, changes the login shell or touches disks.

## Setup and apply

Requires an installed Omarchy desktop with Python 3.14+, Git and mise.
Clone `dotfiles` and `vault-public` as siblings. Keep any existing
`pi-workspace-view` checkout for context-construction experiments, but do not
install its retired v3 snapshot extension or the prototype. The agents module
removes only the retired snapshot entry from mutable Pi settings.

```sh
cd ~/code/dotfiles
./verify
./dot apply --dry-run
./dot apply
./dot check --json
```

Review the dry-run before approving apply. Real applies must run from the
checkout behind `~/.dotfiles`. Worktrees preview proposed content but do not
retarget the stable link. If the stable link is absent, apply creates it.

The module manifests map links, managed settings, Omarchy append/merge
overrides, enabled user units and checked assertions. Settings merges preserve
unmanaged keys; managed arrays replace the corresponding live arrays.
Conflicting link targets are backed up with a UTC timestamp. Unknown edits
to Omarchy-seeded config are reported as `capture`, never silently reset.

Apply installs missing repository packages through `omarchy pkg add` in a
terminal, or background `pkexec /usr/share/omarchy/bin/omarchy-pkg-add` from
an agent. Polkit needs Tobias's approval. AUR packages require a terminal:
`omarchy pkg aur add <pkg>`. The T3 desktop package has a dedicated
`agents/t3/install-desktop.sh` because Omarchy's repository carries a
same-named older package. Close the desktop client before running it.

Global tools use mise with pnpm. Omarchy's Node pin and the nightly updater's
`npm:t3` pin are intentionally excluded from the manifest's version ownership.
The pnpm store is `~/.local/share/pnpm/store`. Agent scratch files use
`~/.cache/agent-tmp`; the tmpfiles rule ages unused files after three days.
Long-lived build state belongs elsewhere.

The first migration backs up only the audited old monitor/appearance/Git
customizations and duplicate Stremio autostarts. Unknown content stops that
migration. Desktop settings auto-reload; after applying Hyprland changes run
`hyprctl reload` and `hyprctl configerrors`. Exercise the existing shell and
normal application launch paths, not just a fresh parser.

## T3

`agents/AGENTS.md` owns the shared leadership and delegation policy, linked
into Claude, Codex and Pi. The existing Claude routing hook fills explicit
T3 task targets; it does not replace the policy or add role enforcement.
Policy edits reach the stable links once they land on `main`;
already-loaded instructions need a new session to adopt them. Do not restart running jobs for this.

T3's official service owns its unit and runtime. The repo owns its drop-in,
55%/70% memory slice, update timer, Pi provider enablement and desktop-client
settings. The server listens on loopback port 3773 and Tailscale Serve exposes
it over Tailnet HTTPS. Pair the nightly desktop client with `t3 pair`;
pairing links are credentials and never belong in Git.

```sh
systemctl --user status t3code.service
curl -sI http://127.0.0.1:3773
tailscale serve status
systemctl --user list-timers t3code-update.timer
loginctl show-user "$USER" -p Linger
```

Apply never restarts T3. A changed drop-in needs Tobias's explicit restart
approval before the running server and its children inherit it.
`./dot check` verifies the process environment and reports the pending restart.

At 05:00, `t3code-update.timer` updates the CLI through mise and the service
through T3's official updater. A new runtime interrupts hosted turns.
With approval, start a detached update using:

```sh
systemctl --user start --no-block t3code-update.service
journalctl --user -u t3code-update.service
```

The timer does not update the desktop package. That remains a terminal action.

## Stremio and Taildrop

One `stremio.service` runs the local streaming server with the FFmpeg 9
compatibility shim. It replaces two old autostarts. On the first approved
handoff, reverify the old server's UID, executable, arguments, port and process
start identity, gracefully stop that exact PID, then enable the new unit.
Never kill by process name or escalate to force-kill. If the new server fails
health or port-ownership checks, stop only the new unit and restore the audited
old launch/autostarts. The migration helper never kills processes.

Taildrop receives files into `~/Downloads`. Tailscale must be joined and the
desktop user must be its operator. User lingering keeps services running
outside an interactive login.

## Manual restore

No native NAS mount is installed yet. `t3-backup.timer` runs
`agents/t3/backup.sh` nightly: restic snapshots of T3 and Pi state (tag `t3`)
and Orderready's fixture store and corpus (tag `orderready`) into
`/srv/nas/files/.backups/t3-pc` on serv01. Restore credentials before relying on it.

- Create `~/.ssh/id_ed25519` with `ssh-keygen -t ed25519`, then
  `ssh-copy-id tobias@tobias-serv01` and check
  `ssh -o BatchMode=yes tobias@tobias-serv01 true`. Add the public key to
  `tobias`'s `openssh.authorizedKeys.keys` in
  `../nixos/hosts/tobias-serv01/configuration.nix` so the next activation keeps it.
- Copy `.config/restic/t3-password` from the cold disk's `/home/tobias` to
  `~/.config/restic/t3-password` with mode 600.
- Build and activate the retained serv01 configuration on serv01 itself using
  `../nixos/README.md`. Its import graph and lockfile stayed byte-identical;
  this workstation cannot run its Nix build.

Cold storage is the 1 TB KINGSTON SNV3S1000G with the old NixOS home at
`/home/tobias`; active Omarchy is on the 2 TB KINGSTON SFYRD2000G, serial
ending `9170A9`. Identify disks by model and serial, never NVMe index.
Mount its ext4 root (label `root`) read-only without a prompt:
`udisksctl mount -b /dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B7383F38C89-part2 -o ro`,
then `udisksctl unmount` the same device when done.
Never print or commit recovered passwords, private keys or pairing credentials.
