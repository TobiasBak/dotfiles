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
`omarchy pkg aur add <pkg>`.

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

## Secret protection

`cli/git/hooks` owns the workstation-wide Gitleaks pre-commit and pre-push
hooks. `cli/git/overrides` sets `core.hooksPath` through the managed global
Git config, so ordinary existing checkouts, fresh clones and worktrees need
no repository installer. This Git config is Omarchy-only; never copy it to
serv01 or the Windows VM. Root `mise.toml` owns the exact Gitleaks version pin.
Before activation, install that pin with `mise install gitleaks@8.30.1`.
Mise is used only for installation, never by the hook. The guard reads the pin
from the trusted dotfiles checkout and uses
`<mise-data-dir>/installs/gitleaks/<exact-pin>/gitleaks`, never a version alias.
The data directory is the caller's nonempty `MISE_DATA_DIR`, otherwise
`$XDG_DATA_HOME/mise` when nonempty, otherwise `$HOME/.local/share/mise`.
An explicit `MISE_DATA_DIR` supports caller-provisioned installations.
The version directory must be a real directory, not a symlink, and the binary
must be a regular executable file, not a symlink. The guard runs its `version`
command with a clean PATH/HOME environment and requires the exact pin,
accepting only an optional trailing newline. Missing or invalid installations
block the operation and report the pinned install command without scanner
output. The hook never installs the scanner.
The chief of staff activates the guard at a quiet moment by merging and
immediately fast-forwarding `~/code/dotfiles`. That pull changes the included
Git override and activates the hooks for every checkout at once; `dot apply`
is not a separate activation gate. To roll back, revert the guard commit and
pull the revert into the stable checkout. Do not point the live config at a
development worktree.

The commit hook scans the staged diff against HEAD, not the full tree or
existing history. For a first commit, it scans the staged snapshot as a root
commit. Unstaged changes cannot mask staged secrets. An inherited fixture in
HEAD does not block an unrelated staged change.
The push hook scans updated refs as old..new and new branches or tags from
their tip. Both exclude commits reachable from cached destination
remote-tracking refs and, when configured, the literal remote `upstream`.
A stale `refs/remotes/upstream/` namespace does not count after that remote
is removed. A new local secret-bearing commit remains blocked unless it is
already reachable from the excluded remote-tracking refs.

For fork syncs, configure the fork's actual public parent as the remote named
`upstream` and run `git fetch upstream` before syncing. Never name a private
remote or a remote holding repository-owned work `upstream` to suppress a scan.
The hook uses only cached fetched refs. It never fetches, uses the network or
calls the GitHub API, and it does not exclude arbitrary local refs.
Finishing a conflicted merge with `git commit` scans everything introduced
relative to HEAD, so upstream content can block a local fork merge. Use the
push-time upstream exclusion for fork syncs or merge on GitHub.

Scanning runs in an isolated bare repository with the source object database
available through alternates. Repository `.gitleaks.toml`, `.gitleaksignore`,
scanner environment overrides and inline `gitleaks:allow` comments cannot
suppress this guard. Missing Gitleaks, shallow history and incomplete scans
block the operation. Stop and report findings using only path, commit SHA and
rule ID; never print matched lines or credential values.

After scanning succeeds, the guarded hooks chain existing executable hooks
from the repository's normal Git hooks directory, preserving arguments and
push input. Other standard Git hooks pass directly through to that directory
without scanning, preserving hooks such as `commit-msg` and Git LFS hooks.
A repository-local `core.hooksPath` bypasses the global guard. Current private
examples are `orderready`, `rust-mutants` and `stepkit-geometry`. Before a
repository with an override goes public, its own hooks must call the guard.
Check the effective setting with
`git config --show-origin --get core.hooksPath`.

`cli/git/hooks/scanner.toml` owns scanner rules. False positives require
chief-of-staff review. Replace synthetic current fixtures with obviously
nonsecret values; keep only exact historical commit/file/rule/line
fingerprints and their reasons in the adjacent `historical.gitleaksignore`.
Real historical credentials require Tobias's explicit risk decision for
those exact fingerprints. Risk acceptance is not proof of expiry or
revocation. Never baseline findings or add path or rule exclusions to unblock
a commit.
Private credentials stay outside Git, including `~/.keys/`,
`~/.config/restic/t3-password` and `~/.config/samba/nas.credentials`; tracked
configuration may reference those paths, never their contents.

GitHub secret scanning and push protection provide an independent layer on
public repositories. Check both under repository security settings, including
when creating a new public repository. This is accidental-leak protection,
not a guarantee against a same-user agent deliberately bypassing hooks or
GitHub protection. GitHub only blocks supported secret patterns, permits
writer bypasses and can skip large or timed-out scans. Neither layer detects
every undocumented password or confidential document. Post-push alerts do
not undo publication. A potentially live finding needs Tobias to decide
credential rotation and history repair before work resumes.

## T3

`agents/AGENTS.md` owns the shared leadership and delegation policy, linked
into Claude, Codex and Pi. The existing Claude routing hook fills explicit
T3 task targets; it does not replace the policy or add role enforcement.
Policy edits reach the stable links once they land on `main`;
already-loaded instructions need a new session to adopt them. Do not restart running jobs for this.

T3's official service owns its unit and runtime. The repo owns its drop-in,
parent memory slice, update service and Pi provider enablement. The parent has
explicit unlimited high/max/swap settings so it does not conflict with T3's
runtime agent-child safety backstops. Host admission was removed by the
2026-10-23 decision. CPU and memory belong to the kernel; repositories run
commands directly. [heavy-lease](../cli/heavy-lease.md) temporarily retains
only named locks and lifetime isolation. The server
listens on loopback port 3773 and Tailscale Serve exposes it over Tailnet HTTPS.
Dotfiles does not install or configure the desktop app.

```sh
systemctl --user status t3code.service
curl -sI http://127.0.0.1:3773
tailscale serve status
loginctl show-user "$USER" -p Linger
```

Apply never restarts T3. A changed drop-in needs Tobias's explicit restart
approval before the running server and its children inherit it.
`./dot check` verifies the process environment and reports the pending restart.

T3 updates only on request. `t3code-update.service` updates the CLI through
mise and the service through T3's official updater. A new runtime interrupts
hosted turns and replaces the service build that carries gah's local launch
patch, so follow "Updating T3" in the sibling vault's
`software/t3-code-operations.md`.
With approval, start a detached update using:

```sh
systemctl --user start --no-block t3code-update.service
journalctl --user -u t3code-update.service
```

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

## NAS mount

The desktop module declares a native CIFS automount at `/mnt/nas` for
`//192.168.1.53/nas`. It uses the LAN path only and fails away from home.
Tailscale fallback is [follow-up #17](https://github.com/TobiasBak/dotfiles/issues/17).
No serv01 change is required.
The declarations target the Omarchy account `tb` and its home `/home/tb`.

Only `mnt-nas.automount` starts at boot. It does not contact serv01 or wait
for the network until an application accesses `/mnt/nas`. Do not add it as
a login dependency or put a desktop startup task inside the mount.
`mnt-nas.mount` has a 10-second mount-helper timeout. Its network startup
dependencies can add waiting on first access; this is not a 10-second limit
on every filesystem operation. `soft` returns errors on server failure
instead of retrying forever. `echo_interval=5` reduces idle connection
failure detection to roughly 15 seconds, not an end-to-end I/O guarantee.
Applications accessing the share can wait and receive I/O errors during
an outage; login and unrelated desktop startup do not depend on it.
The automount tries again on later access and expires an idle mount after
60 seconds when no open files keep it busy.

The mount is writable by `tb`, with local file/directory modes 0600/0700,
and uses SMB 3.1.1, `nosuid`, `nodev` and `noexec`. A failed write can be
incomplete. Do not treat a network filesystem as an always-available local
disk or rely on it for startup-critical state.

`./dot check desktop --json` checks the installed and loaded unit definitions,
root ownership/modes, overrides, pending daemon reload, automount enablement
and activity, and credential metadata. It never opens the mount, reads the
credential contents, or probes serv01. An outage is not declaration drift.
An active CIFS mount can still use old options after a definition change;
close users of the share and arrange a manual unmount before adopting new
mount options. Do not force an unmount with pending writes.

### Approved setup only

`./dot apply` does not install or enable the system mount units. Restore the
credentials below first, review existing `/etc/systemd/system/mnt-nas.*`
files and drop-ins, and confirm `/mnt/nas` has no local data or other mount.
Do not overwrite unknown customizations or mount over local files.
From the stable checkout, with Tobias's approval, these terminal commands
install missing managed packages, copy the two declarations as root-owned
0644 files, reload systemd, and enable/start only the local automount:

```sh
cd ~/code/dotfiles
./dot apply --dry-run packages
./dot apply packages
sudo install -o root -g root -m 0644 desktop/nas/mnt-nas.mount desktop/nas/mnt-nas.automount /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mnt-nas.automount
./dot check desktop --json
```

The package apply installs any missing repo-managed packages, including
`cifs-utils`, through Omarchy. It is not limited to that one package.
Agents without an interactive terminal use `pkexec` instead of `sudo` for
the three privileged commands, only after approval. Nothing here changes
serv01 or restarts T3. Enabling the automount creates the local mountpoint
but does not establish an SMB connection until first access.

Reboot persistence, successful read/write access, failure while serv01 is
offline, and recovery remain live acceptance checks for Tobias after setup.
Check login and the existing desktop during an outage, not just a fresh
parser. Do not run `ls /mnt/nas` as a read-only drift probe: it triggers SMB.
To retire the mount, close applications using it, stop `mnt-nas.mount`
without forcing it, then disable/stop `mnt-nas.automount` and remove only
the two managed unit files before reloading systemd. Keep the credential
file private; remove it separately if no longer needed.

## Manual restore

Restore `~/.config/samba/nas.credentials` by hand from secure storage, owned
by `tb`, mode 0600. It is a nonempty regular file, not a symlink, containing
`username=` and `password=` entries for an existing serv01 Samba account.
Never put the password in a shell command, issue, worker prompt or Git.
Create the parent directory with mode 0700, copy the recovered file with
`install -m 0600`, and edit it privately if needed. If no usable Samba
password exists, park account recovery for Tobias; changing serv01 needs
separate approval. As `tb`, after choosing the actual secure recovery path:

```sh
install -d -m 0700 ~/.config/samba
install -m 0600 /path/to/recovered/nas.credentials ~/.config/samba/nas.credentials
```

`t3-backup.timer` runs
`agents/t3/backup.sh` nightly: restic snapshots of T3 and Pi state (tag `t3`)
and Orderready's fixture store and corpus (tag `orderready`) into
`/srv/nas/files/.backups/t3-pc` on serv01. Restore credentials before relying on it.

The repository also keeps the four NixOS-era `t3` snapshots of `/home/tobias`
(29652b4c to b3952015, 2026-10-08 to 2026-10-11) on purpose, as history.
`forget` groups by host and paths, so these form their own group that the
nightly `--keep-daily 7 --keep-weekly 4` never expires. Never forget or prune
them.

- Create `~/.ssh/id_ed25519` with `ssh-keygen -t ed25519`, then
  `ssh-copy-id tobias@tobias-serv01` and check
  `ssh -o BatchMode=yes tobias@tobias-serv01 true`. Add the public key to
  `tobias`'s `openssh.authorizedKeys.keys` in
  `../nixos/hosts/tobias-serv01/configuration.nix` so the next activation keeps it.
- Copy `.config/restic/t3-password` from the cold disk's `/home/tobias` to
  `~/.config/restic/t3-password` with mode 600.
- Build and activate the retained serv01 configuration on serv01 itself using
  `../nixos/README.md`; this workstation cannot run its Nix build.

### Restore drill

Run this in Bash after restoring the credentials above. It restores both
snapshot tags into private scratch, never over live data. Do not run restored
applications or print restored files, session text or customer filenames.

```bash
set -euo pipefail
export RESTIC_REPOSITORY='sftp:tobias@tobias-serv01:/srv/nas/files/.backups/t3-pc'
export RESTIC_PASSWORD_FILE="$HOME/.config/restic/t3-password"
install -d -m 700 "$HOME/.cache/agent-tmp"
drill=$(mktemp -d "$HOME/.cache/agent-tmp/t3-restore.XXXXXXXX")
cleanup() {
  [[ -d $drill && ! -L $drill ]] || return 0
  find "$drill" -type d -exec chmod u+rwx -- {} +
  rm -rf -- "$drill"
}
trap cleanup EXIT
export RESTIC_CACHE_DIR="$drill/cache"
for tag in t3 orderready; do
  restic snapshots --host pc --tag "$tag" --json > "$drill/$tag.json"
  python - "$drill/$tag.json" > "$drill/$tag.id" <<'PY'
import json, sys
snapshots = json.load(open(sys.argv[1]))
if not snapshots:
    raise SystemExit("missing snapshot tag")
print(max(snapshots, key=lambda snapshot: snapshot["time"])["id"])
PY
done
t3=$(<"$drill/t3.id")
orderready=$(<"$drill/orderready.id")
restic stats "$t3" "$orderready" --mode restore-size --json > "$drill/size.json"
python - "$drill" <<'PY'
import json, os, sys
root = sys.argv[1]
size = json.load(open(root + "/size.json"))["total_size"]
fs = os.statvfs(root)
if fs.f_bavail * fs.f_frsize - size < fs.f_blocks * fs.f_frsize * 0.20:
    raise SystemExit("restore would leave less than 20% free")
PY
restic ls "$t3" --json > "$drill/t3-inventory.jsonl"
restic ls "$orderready" --json > "$drill/orderready-inventory.jsonl"
restic restore "$t3" --target "$drill/restored" --verify > "$drill/t3.log" 2>&1
restic restore "$orderready" --target "$drill/restored" --verify > "$drill/orderready.log" 2>&1
```

Keep the shell open for inspection; the exit trap deletes its private files.
Restic retains the original absolute paths below `restored`, so use each
snapshot's inventory to locate its home, not the current `$HOME`.

- Compare every inventory node's type and size with the restored tree.
  `restic ls --json` omits symlink targets. For each symlink's parent path,
  read `restic cat tree "$snapshot:$parent"` and compare the named node's
  `linktarget` with `readlink`. Tree blob IDs instead use `restic cat blob`.
  Keep that metadata private too. `--verify` checks restored file contents,
  not application usability by itself.
- Open `.local/state/t3-backup/statev2.sqlite` read-only. Require
  `PRAGMA integrity_check` to return `ok`, then check the application schema,
  thread/message counts and referenced T3 userdata artifacts. The live
  `state*.sqlite*` files, logs and regenerable caches are deliberately excluded.
- Parse Pi settings and session JSONL, splitting records on newline, not
  Unicode line separators inside JSON strings. The staged `pi-settings.json` and
  `pi-APPEND_SYSTEM.md` are regular, dereferenced copies. Original Pi settings
  symlinks may point outside the restore target. Use the staged copies during
  an approved recovery rather than relying on those symlinks.
- Check Orderready fixture SHA-256 hashes against their content-addressed
  filenames. Parse corpus PDFs and check STEP/DXF format envelopes. These
  checks do not execute CAD import workflows. Report counts and integrity only.
- Record aggregate results and limits, then run `cleanup`, unset
  `RESTIC_CACHE_DIR`, and confirm the target no longer exists. Restored
  directories may be read-only; cleanup changes only scratch directory modes,
  without following symlinks, before deletion. Do not retain
  restored data, metadata, logs or caches. A real recovery that replaces the
  T3 database requires separate approval to stop T3; a drill never does.

The 2026-10-12 drill restored both latest tags with `--verify` and matched
all 3,311 T3/Pi nodes and 550 Orderready nodes, including three symlinks.
SQLite passed integrity and foreign-key checks across 48 tables. All 880
Pi sessions and 66,174 JSONL records parsed. All 70 fixture SHA-256 hashes
matched; 177 corpus PDFs parsed, and 175 STEP plus 116 DXF envelopes passed.
Three other corpus files received restic content verification only. This
proved byte recovery and structural readability, not live application or
CAD import workflows. The mode-700 target, caches, metadata and scripts were
deleted and their absence independently checked.

### Backup memory

The backup unit uses `MemoryHigh=1G` to reclaim streaming file cache before
`MemoryMax=3G` can kill the job; `MemorySwapMax=0` keeps it off swap. Measure
the whole service cgroup, including the SQLite copy, both restic backups,
retention, repository check and cleanup, not just restic's RSS.

On 2026-10-12, one real run with these limits in a transient user service
processed 3,027 T3/Pi files (8.696 GiB) and 541 Orderready files (321.415 MiB).
The repository check passed. Its cgroup peak was 1,074,917,376 bytes, 33.4%
of the 3 GiB ceiling, with zero swap and successful exit. Wall time was
43.191 s versus the earlier 80.900 s run at the 1 GiB hard ceiling. The peak
was near the soft limit, but reclaim did not stretch observed wall time.
These are single runs with changing data/cache state, not a speedup benchmark.
The transient run did not modify the live unit or restart T3. After merging,
apply from the stable checkout only with approval, then daemon-reload so the
next backup inherits the limits.

Cold storage is the 1 TB KINGSTON SNV3S1000G with the old NixOS home at
`/home/tobias`; active Omarchy is on the 2 TB KINGSTON SFYRD2000G, serial
ending `9170A9`. Identify disks by model and serial, never NVMe index.
Mount its ext4 root (label `root`) read-only without a prompt:
`udisksctl mount -b /dev/disk/by-id/nvme-KINGSTON_SNV3S1000G_50026B7383F38C89-part2 -o ro`,
then `udisksctl unmount` the same device when done.
Never print or commit recovered passwords, private keys or pairing credentials.
