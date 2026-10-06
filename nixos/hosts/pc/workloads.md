# PC background workloads

`workloads.nix` owns the PC-only CPU policy and installs `pc-workload`.

```sh
pc-workload -- cargo test --jobs 4
```

The launcher preserves the caller's working directory, argument boundaries,
environment and standard streams. It returns the command's exit status and
prints scope creation errors. Each invocation creates a uniquely named
`pc-workload-*.scope` in the user manager's `background.slice`, a sibling of
`app.slice`, not a descendant of `t3code.service`. It does not escape the user
manager's limits or provide a security sandbox.

The [Windows VM lab](../../../tools/windows-vm/README.md) owns its singleton
budget and supervised lifetime. Use `oip-windows-vm start <existing-name>` for
that lab, not a direct QEMU invocation that bypasses its lifecycle lock.

## Foreground contract

The command must remain in the foreground until all its children finish.
QEMU must not use `-daemonize`. VM supervisors must wait for QEMU rather than
spawn it and exit. The launcher's return only tracks its foreground command;
it is not a detached job API or a descendant-completion signal. The scope
tracks surviving descendants, but callers must not interpret an early return
as VM completion or tear down files the VM still uses.

Cancellation and detached lifetime belong to the caller. Do not assume that
killing the launcher or losing its terminal stops every descendant. A future
VM supervisor must track the scope or processes, explicitly stop them on
cancellation, wait for their termination before cleanup, and own any detached
job's lifetime. This generic wrapper provides no VM lifecycle management.

The launcher does not choose worker counts, serialize native runs or reserve
CPUs. Use four native workers and one eight-vCPU/8-GiB VM. Tobias authorized
raising the qualification VM's CPU share on 6 October 2026. On the observed
16-logical-CPU, 30-GiB host, the VM may overlap either one four-worker Nix build
or one four-worker native run, not both. These settings leave four logical
threads unassigned, not reserved. VM timing comparisons run without either
heavy Linux workload. The memory budget remains 8 GiB; the CPU change does not
authorize more memory or a second VM. The [VM receipt](../../../tools/windows-vm/README.md#qualification-sizing)
owns the measured sizing basis.

Nix's `cores = 4` supplies `NIX_BUILD_CORES`; builders can ignore it, and trusted
users can override Nix settings. These are cooperative worker settings, not CPU
quotas.
There are no new memory caps. T3 retains its existing 24-GiB memory and 4-GiB
swap limits and its existing scheduling priority.

## CPU policy and deferred I/O work

Nix allows one build at a time with four requested workers. The daemon uses
batch CPU scheduling and nice 10 in the system `background.slice`, a top-level
sibling of `user.slice` and `system.slice`. Both system and user background
slices use CPU weight 30, systemd's background default, below normal weight
100. Lowering only the daemon inside `system.slice` would leave that slice's
root-level share unchanged. User workloads compete with `app.slice` and
`session.slice` rather than remaining among T3's children. The launcher adds
10 to the command's niceness. These preferences are not measured optima or
performance guarantees.

This policy makes no I/O changes: no BFQ module or NVMe scheduler rule, no
background I/O weight, no user-manager I/O delegation override, and no I/O
rate limits or iocost replacement. It makes no I/O fairness or performance
claim. An independent I/O proposal must wait until the CPU policy and native
cache fixes are activated, then include a benchmark-checklist receipt that
identifies the limiter and uses interleaved runs. No benchmark is requested
or supplied here.

## Activation blockers and checks

Source changes and Nix evaluation do not activate this policy. The previously
observed live system still used Nix `max-jobs = auto` resolving to 16 and
`cores = 0`; current processes must be inspected rather than assumed updated.

Activation requires a separately approved NixOS rebuild. Normal NixOS
activation restarts the changed Nix daemon, but its `KillMode=process` leaves
old builders alive with their old scheduling settings and cgroup placement.
A daemon restart does not migrate those builders. The existing user manager
has `restartIfChanged = false` and is not restarted by this change. Verify
that its new background slice policy is loaded and applied; do not infer
that from a successful system activation. Restarting the user manager would
terminate T3 and its agent sessions. Do not use the normal PC rebuild
entrypoint during hosted work: it also runs T3's updater. Existing workloads
are not migrated. This change has not been activated or benchmarked.

After approved activation, check these before calling the CPU policy effective:

- Nix's effective `max-jobs` is 1 and `cores` is 4, without per-user overrides.
- `nix-daemon.service` reports `Nice=10`, `CPUSchedulingPolicy=batch` and
  `Slice=background.slice`. Inspect the running daemon and newly spawned
  builders' scheduling settings and `/proc/<pid>/cgroup`, not only unit
  properties. Identify surviving old builders separately.
- Both the system and user `background.slice` report `CPUWeight=30`; inspect
  their cgroups' `cpu.weight` to verify the applied value, including the
  unchanged running user manager's slice.
- A tiny `pc-workload` probe's `/proc/self/cgroup` contains
  `/background.slice/pc-workload-` and not `t3code.service`; cwd, literal
  arguments, environment, standard streams and failure status survive.

Focused launcher checks: `python3 -B -m unittest discover -s scripts/tests -v`.
No contention benchmark or performance improvement is claimed by these checks.
