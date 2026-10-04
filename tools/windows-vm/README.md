# Windows VM lab

Dotfiles owns the host VM tool. `oip-windows-vm` keeps its existing command and
`${XDG_DATA_HOME:-$HOME/.local/share}/oip-windows-vm` data home, including SSH keys,
ports, clone disks, and the sealed Windows Server 2025 Desktop Experience base.
OIP owns application builds and import qualification. No product source lives here.

## Use before activation

From this checkout's root:

```sh
nix develop ./nixos#windows-vm --command tools/windows-vm/oip-windows-vm --help
nix develop ./nixos#windows-vm --command tools/windows-vm/oip-windows-vm paths
```

The shell supplies the same dependencies and `pc-workload` as the package. The
launcher does not enter a Nix shell itself or fall back to the source archive.
After PC activation, use `oip-windows-vm` on PATH. Both routes have one source owner
and the same persisted home. Help, paths, and host status do not create directories
or query the guest.

## Shared lifecycle

Only **one test clone** may exist across agents, tasks, and worktrees. This is
Tobias's storage policy, not a tunable concurrency limit. The sealed backing image
is separate and must remain. Do not change the VM home or invoke QEMU directly to
bypass this budget. `OIP_WINDOWS_VM_HOME` is for explicitly isolated scratch tests.

Use `paths` to find the existing clone and coordinate with its users. Reuse it.
Replacement requires evidence export, a completed normal shutdown, then explicit
`destroy`. The tool never resets or deletes someone else's clone automatically.

Mutating lifecycle commands share the persisted `clone.lock`, preserving the
orphan create/destroy lock identity while covering the whole lifecycle. Use only
this maintained source or PATH route; old OIP start/stop entrypoints are retired.
Clone creation cleans failed partial state. Start also checks the singleton budget on older homes.
QEMU stays in the foreground under a transient user service and `pc-workload`,
whose sibling scope lives in `background.slice` at nice +10. Service and scope
lifetime, not an early wrapper exit, bound the VM lifecycle. This requires a working
user systemd manager and PR #1's host workload policy; failures are not bypassed.

`--help` lists the supported commands. Generic operations cover media download,
base installation/provisioning/sealing, clone creation/start/stop/destroy, SPICE,
SSH, host status, and guest verification. SSH accepts a remote command so import
qualification can control its own payloads without a dependency on archived
Supervisor or Runner code. Guest/user inspection is explicit, not part of host
status. Stop waits for bounded shutdown completion and reports failure rather than
allowing destruction while the VM still runs.

The original IDE boot controller, QCOW2 backing format, cache policy, loopback SSH
and SPICE forwarding, e1000 identity, provisioning, and sealed-base paths remain.
No base regeneration, guest migration, or network change is required.

## Focused verification

```sh
nix develop ./nixos#windows-vm --command python3 -m unittest discover \
  -s tools/windows-vm/tests -v
nix build --no-link ./nixos#oip-windows-vm
```

Lifecycle tests use temporary homes, tiny QCOW2 backing fixtures, and process,
SSH, and systemd doubles. They never boot Windows or touch the shared VM. Real
user-service scheduling, guest shutdown, console operation, and host activation
still require coordinated verification after activation. Never use the running
qualification VM as a smoke test.

## Migration inventory

Source: the immutable `2026-09-19-import-focus` collection's `source/tools/windows-vm`
at OIP commit `a3a27c5b77e092f5d5d54c0a0ffd79c11bb51487` plus its recorded
`provenance/pre-move.patch` (SHA-256
`6969e61a24e70283b487d7251c5f498e396b1c208727aba0475ef15d2b54000b`). All 20 VM
source files match the collection manifest; that patch contains no VM-tool diff.
The archive and uncommitted main OIP source stay untouched.

Kept:

- `oip-windows-vm`, narrowed to host and generic guest operations.
- `bootstrap/Autounattend.xml.in`, `bootstrap/bootstrap.cmd`,
  `bootstrap/provision.ps1`, and `verify.ps1`, copied unchanged.
- The orphan OIP change's `MAX_TEST_VMS=1` policy receipt, shared create/destroy
  locking, failed-create cleanup, named existing-clone diagnostics, and
  `tests/test_vm_lifecycle.py`, reconciled into the broader lifecycle lock and tests.

Dropped:

- All `supervisor-*` commands and functions, `runner-deployment-rehearsal`, and the
  archived installer attachment command and payload path.
- `install-supervisor.ps1`, `verify-supervisor.ps1`,
  `build-supervisor-installer.ps1`, `test-supervisor-credentials.ps1`,
  `test-supervisor-headless-update.ps1`, `test-supervisor-process-tree.py`,
  `test-supervisor-lifecycle.py`, `test-supervisor-lifecycle-host.py`,
  `test-supervisor-lifecycle-worker.py`, `test-supervisor-bundle-parity.py`, and
  `OrderIntegrationSupervisorLifecycleTest.xml`.
- `rehearsal-import-gui.ps1`: the old Runner deployment rehearsal, including its
  Supervisor-state snapshot and Runner-specific staging and scheduled task.
  Current import qualification uses generic SSH and remains in OIP.
- The archived README and standalone `flake.nix`/`flake.lock`. This README and the
  dotfiles Nix package/dev shell replace them without a second dependency pin.
- Commit `6495397`'s 79 added launcher lines: `REPO_ROOT` (1), source-update help
  (1), `update_supervisor_source` (73), and dispatch (4). Its source payload builder and
  `monitor-control-plane update-local-supervisor` depend entirely on the archived
  Supervisor/Control Plane. They are not a generic import update path.

PC installs the packaged command through `nixos/hosts/pc/configuration.nix`.
The package and source shell reuse the unchanged `pc-workload` derivation,
extracted from the parent PR's module. Activation is a separate, explicit user
operation. Do not use the normal rebuild helper here: it also updates T3 Code.

After separate approval, build the reviewed integrated checkout and stage its exact
store path for the next boot. These commands are instructions, not migration checks:

```sh
repo=/home/tobias/.t3/worktrees/dotfiles/feat-maintained-windows-vm-lab
system=$(nix build --no-write-lock-file --max-jobs 1 --cores 4 \
  --no-link --print-out-paths \
  "$repo/nixos#nixosConfigurations.pc.config.system.build.toplevel") &&
sudo /run/current-system/sw/bin/nixos-rebuild boot --store-path "$system"
```

A planned reboot is recommended to activate the merged CPU-only workload policy
and start future supervised VMs from a clean generation. This migration adds no
BFQ, I/O weights, scheduler changes, or user-manager I/O delegation override.
Coordinate completion and evidence export with **all VM users first**, including
qualification #271 and #273, and obtain separate reboot approval. Do not stop the
active VM or reboot from this migration. After reboot, check the applied policy in
`nixos/hosts/pc/workloads.md`, command ownership with `command -v oip-windows-vm`,
and the unchanged home with `oip-windows-vm paths`. Guest/service operation remains
unverified until that coordinated activation check.
