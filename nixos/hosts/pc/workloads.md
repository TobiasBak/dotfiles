# PC background workloads

`workloads.nix` owns the PC-only policy and installs `pc-workload`.

```sh
pc-workload -- cargo test --jobs 4
pc-workload -- qemu-system-x86_64 -enable-kvm -smp 4 -m 8G ...
```

The launcher preserves the caller's working directory, argument boundaries,
environment and standard streams. It returns the command's exit status and
prints scope creation errors. Each invocation creates a uniquely named
`pc-workload-*.scope` in the user manager's `background.slice`, a sibling of
`app.slice`, not a descendant of `t3code.service`. It does not escape the user
manager's limits or provide a security sandbox.

## Foreground contract

The command must remain in the foreground until all its children finish.
QEMU must not use `-daemonize`. VM supervisors must wait for QEMU rather than
spawn it and exit. The launcher's return only tracks its foreground command;
it is not a detached job API or a descendant-completion signal. The scope
tracks surviving descendants, but callers must not interpret an early return
as VM completion or tear down files the VM still uses.

The launcher does not choose worker counts, serialize native runs or reserve
CPUs. Use four native workers and one four-vCPU VM for the approved overlap
budget. Nix's `cores = 4` supplies `NIX_BUILD_CORES`; builders can ignore it,
and trusted users can override Nix settings. These are cooperative worker
settings, not CPU quotas. On the observed 16-logical-CPU, 30-GiB host, one
four-worker Nix build, one four-vCPU/8-GiB VM and one four-worker native run
leave four logical threads unassigned by those settings, not reserved.
There are no new memory caps. T3 retains its existing 24-GiB memory and 4-GiB
swap limits and is not lowered in CPU or I/O priority.

## Effective I/O policy

Both the system and user `background.slice` get `IOWeight = 10`, below the
systemd default of 100. The Nix daemon runs in the system background slice,
a top-level sibling of `user.slice` and `system.slice`. Lowering only its
weight inside `system.slice` would leave that slice's root-level share
unchanged. User workloads run in the user manager's background slice,
competing with `app.slice` and `session.slice` rather than with T3's children.
This is a background preference, not a throughput promise or a tuned
optimum. BFQ may reduce peak throughput compared with
`none`; this policy favors desktop responsiveness under contention.

The installed Linux 6.18 kernel has `CONFIG_IOSCHED_BFQ=m` and
`CONFIG_BFQ_GROUP_IOSCHED=y`. The PC module loads BFQ and selects it for NVMe
disks through udev. systemd 260.2's
[`set_bfq_weight`](https://github.com/systemd/systemd/blob/v260.2/src/core/cgroup.c)
writes `io.bfq.weight` as well as `io.weight`, translating systemd's weight
range to BFQ's range. Compare the applied BFQ values, not an assumed 10:100
bandwidth ratio. The user manager delegates `io` alongside its existing
`cpu`, `memory` and `pids` controllers so the background slice can apply it.
No hard I/O rate caps, latency targets or disk-model guesses are introduced.

## Activation blockers and checks

Source changes alone do not activate this policy. The observed live system
still has Nix `max-jobs = auto` resolving to 16 and `cores = 0`, NVMe scheduler
`none`, and `user@1000.service` delegation without `io`. A new scope can prove
placement and stream handling now, but cannot prove the future I/O policy.

Activation requires a separately approved NixOS rebuild. The existing user
manager is configured `restartIfChanged = false`; a daemon reload alone does
not prove new delegation took effect. Prefer an approved reboot to pick up
the kernel module, scheduler, daemon priority and user-manager delegation
together. Restarting the user manager would terminate T3 and its agent
sessions. Do not use the normal PC rebuild entrypoint during hosted work:
it also runs T3's updater. Existing workloads are not migrated by this change.

After activation, check all of these before calling I/O isolation effective:

- Nix's effective `max-jobs` is 1 and `cores` is 4, without per-user overrides.
- `nix-daemon.service` reports `Nice=10`, `CPUSchedulingPolicy=batch` and
  `Slice=background.slice`. Newly spawned builders inherit the daemon's
  scheduling policy. The system background slice reports `IOWeight=10`.
- Every NVMe `queue/scheduler` shows `[bfq]`.
- `user@1000.service` reports `io` in `DelegateControllers`, and its cgroup's
  `cgroup.subtree_control` enables `io`.
- `background.slice` reports `CPUWeight=30`, `IOWeight=10`; its cgroup and
  the system background slice's cgroup have applied `io.bfq.weight` values
  below their normal-weight siblings. Inspect kernel files, not only unit properties.
- A tiny `pc-workload` probe's `/proc/self/cgroup` contains
  `/background.slice/pc-workload-` and not `t3code.service`; cwd, literal
  arguments, environment, standard streams and failure status survive.

Focused launcher checks: `python3 -B -m unittest discover -s scripts/tests -v`.
No contention benchmark or performance improvement is claimed by these checks.
