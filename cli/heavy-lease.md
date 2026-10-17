# Heavy verification pool

`heavy-lease` admits heavy Linux verification to a host-wide weighted pool.
Light work never leases: formatting, launcher self-builds, status, individual
cases and static checks run directly. Repo entry points own admission.

```sh
heavy-lease run --wait -- tools/or test --full
heavy-lease run --wait --weight 2 -- sleep 30
heavy-lease run --try --weight 1 -- sleep 30
heavy-lease run --wait --exclusive win-vm -- vm-command
heavy-lease run --wait --exclusive win-vm --weight 2 -- vm-command
heavy-lease status --json
```

`run` waits by default. `--try` returns 2 without waiting when admission is
unavailable, including a concurrent allocation transaction. Other CLI errors
return 1. The command's exit status or signal is preserved.

`--exclusive NAME` takes a separate named lock and defaults to zero pool slots,
even for commands in the weight table. Add `--weight K` to request both.
Weights must fit the pool; zero is accepted only with `--exclusive`.

## Measured sizing

The pool has four slots. Orderready full/strict commands and heavy commands
whose path or working directory matches `orderready` or `stepkit-geometry`
default to weight two. `sg gate`, `sg corpus` and `sg parity` also match by
command name. Unrecognized commands default to one; use `--weight` for a
larger unmeasured job. Explicit weights override the table.

Measurements, date, commit SHAs and local evidence source live beside
`POOL_SIZE` and `DEFAULT_WEIGHTS` in [heavy-lease.py](heavy-lease.py).
The initial policy treats each slot as a four-GiB/four-core accounting unit.
Two known heavy jobs fit, but a third waits. This gives each an eight-GiB
envelope against the observed 7.40-GiB Orderready peak, reserves roughly
14.5 GiB of the 30.51-GiB host for desktop, agents and other work, and admits
at most two of these jobs on 16 cores. These are admission estimates, not
cgroup memory limits or CPU quotas.

Evidence was collected on 2026-10-17 through the installed mutex, using kernel
wait accounting and cgroup counters because `/usr/bin/time` was absent.
The uncached Orderready run averaged 3.56 CPU cores, with four build jobs.
It performed 100 cases, 38 lint jobs and static checks, but exited 2 after one
GUI operation exceeded its 27-second budget. It is not a passing full-suite
bound. A separate cached run passed but does not size verification work.
The geometry gate passed six static checks but selected no corpus or parity.
Existing same-date nightly logs supply 45 passing corpus cases and 285 passing
parity models; the parity worker hit its configured four-GiB memory envelope.
The conservative weight two covers that incomplete/capped evidence rather
than assuming a static-only gate represents every geometry lane.

Cgroup peaks include file cache and kernel charges. Largest-process RSS is
not aggregate RSS, and cumulative CPU divided by elapsed is not peak CPU.
Geometry runs workers in sibling cgroups, so its outer measurement omits
those workers; their separate receipts are recorded. Orderready's independent
watcher was outside its measured cgroup and stopped after measurement.
No simultaneous heavy-job experiment or speedup claim is made. Re-measure
before raising concurrency or reducing these weights.

## Admission and lifetime

Each slot and named resource has its own kernel-held `flock`. An allocation-only
lock serializes the short, nonblocking slot scan in ascending slot order, not
the admitted commands. A failed scan releases every partial claim. A combined
request takes its named lock before scanning the pool. Waiters sleep on kernel
locks through short-lived per-slot helpers and wake when any blocked slot is
released. Helpers inherit no lease descriptors and die with their parent.
There is no daemon, fixed sleep or polling interval. Admission is not FIFO.

Locks live under `~/.local/state/heavy-lease`. Never unlink active resource lock files.
Sidecar JSON files are display metadata, not admission authority. Metadata can
be stale or briefly unavailable during acquisition; it never blocks new work.
`status --json` is a point-in-time, non-atomic snapshot with `pool_size`, occupied
`slots`, held `exclusive` resources and live `waiters`. Waiters have per-process
flocks and display metadata with requested weight and exclusive resource; the
list is not FIFO and may briefly include an allocation in progress. Dead waiter
metadata is ignored, including after SIGKILL. No queue daemon is needed.
Each resource includes its name and holder metadata. Linux orphan-pin diagnostics
identify surviving inherited descriptors when the metadata PID is dead, subject
to `/proc` visibility and PID reuse limits described by `status --help`.

`exec` preserves high-numbered lock descriptors and the holder token. Exit or
SIGKILL releases locks when the last inherited descriptor closes. A surviving
child can intentionally keep a lease pinned. `handoff` and `adopt` transfer the
entire descriptor set across a manager boundary. Nested `run` passes through
only with a matching token on live held resources and sufficient parent slots
and named locks. It rejects requests beyond the parent's allocation rather than
waiting on itself. Token-only nested subprocesses rely on the parent retaining
the locks. Start independent work with `heavy-lease isolate -- <command>`;
this discards every inherited lease descriptor and environment field.

## Rollout from the single lock

The pool does not acquire the old `lock` file. An old mutex holder and new pool
jobs could otherwise run concurrently outside the measured pool.

Pause all old-version launchers and watcher triggers, drain existing holders
and queued old-version invocations, and confirm the old installed
`heavy-lease status --json` reports free. Keep triggers paused while updating
the stable checkout and installing through the normal approved dotfiles apply.
Restart long-lived launchers without inherited lease context, then resume
triggers. Do not use a one-time old-lock acquisition as the drain check: queued
old callers could acquire it after installation. Do not delete lock files to
force the drain. This branch does not install or modify the live checkout.
