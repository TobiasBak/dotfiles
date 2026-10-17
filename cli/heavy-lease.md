# Host work scheduler

`heavy-lease` admits heavy Linux work to a host-wide four-slot weighted pool,
ordered by priority and constrained by live memory headroom.
Light work never leases: formatting, launcher self-builds, status, individual
cases and static checks run directly. Repo entry points own admission.

```sh
heavy-lease run --wait --class gate -- tools/or test --full
heavy-lease run --wait --weight 2 -- command
heavy-lease run --try --class efficiency --weight 1 -- command
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
The original sizing treated each slot as a four-GiB/four-core accounting unit.
The current memory estimate is `weight × PER_SLOT_PEAK`, where the single
`PER_SLOT_PEAK` constant divides the 17-GiB slice memory budget by four slots
(4.25 GiB per slot). Two weight-two jobs fill the slots, but live headroom
may admit fewer. These are admission estimates, not cgroup memory limits or
CPU quotas. There is no completion history or learned peak estimate.
The slot count stays at four until Orderready's load-immune budget work proves
CPU contention cannot fail cases. See dotfiles issue #40.

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

`--class gate|interactive|efficiency` orders waiting work in that priority order.
The default is `interactive`, including callers that pass no new flags. FIFO
applies within a class. Running work is never preempted. Among pool contenders,
a memory-blocked head is never skipped for smaller or lower-priority work.
A waiter blocked on an unavailable named resource does not block unrelated
resources. Named-only VM work remains independent of the slot pool. Combined
requests acquire all resources together; queued work holds no partial allocation.

Each slot and named resource has its own kernel-held `flock`. One short
admission transaction serializes live queue order, the memory check, and the
nonblocking resource scan. Kernel descriptors own resources; queue order and
live memory decide admission. Dead waiter metadata is ignored, including after
SIGKILL. There is no queue daemon.

Headroom is the minimum of host `MemAvailable` from `/proc/meminfo` and each
finite caller-cgroup ancestor's `memory.max − (memory.current − inactive_file)`.
Used memory and headroom are clamped to zero. This excludes reclaimable inactive
file cache from cgroup usage and respects the tightest ancestor, not just the
caller's direct limit. With no finite cgroup limit, only host availability
constrains memory admission. `memory.high` is not an admission limit. A request
must have free resources. While any pool slot is held, it also needs headroom
at least its expected peak. An empty pool admits the eligible head waiter
regardless of headroom, so a lone pool job always runs.
No memory limit, CPU quota, history, or identical-command deduplication is added.

Waiters wake on resource release and queue events. Lock helpers inherit no lease
descriptors and die with their parent. Memory-only blocking also uses a bounded
timerfd reread because memory recovery has no reliable release event. There are
no sleep-based polling loops.

Locks live under `~/.local/state/heavy-lease`. Never unlink active resource lock
files. `status --json` is a point-in-time, non-atomic snapshot with `pool_size`,
occupied `slots`, held `exclusive` resources and live `waiters`. Each waiter
reports its class, expected peak in bytes, and admission reason, including
`memory` when headroom blocks admission. Each resource includes its name and
holder metadata. Linux orphan-pin diagnostics identify surviving inherited
descriptors when the metadata PID is dead, subject to `/proc` visibility and
PID reuse limits described by `status --help`.

Black-box fixtures can override memory input paths with `HEAVY_LEASE_MEMINFO`,
`HEAVY_LEASE_CGROUP_ROOT`, and `HEAVY_LEASE_CGROUP_FILE`. Normal invocations read
`/proc/meminfo`, `/sys/fs/cgroup`, and `/proc/self/cgroup`. Input errors fail
loudly rather than admitting against invented headroom.

`exec` preserves high-numbered lock descriptors and the holder token. Exit or
SIGKILL releases locks when the last inherited descriptor closes. A surviving
child can intentionally keep a lease pinned. `handoff` and `adopt` transfer the
entire descriptor set across a manager boundary. Nested `run` passes through
only with a matching token on live held resources and sufficient parent slots
and named locks. It rejects requests beyond the parent's allocation rather than
waiting on itself. Token-only nested subprocesses rely on the parent retaining
the locks. Start independent work with `heavy-lease isolate -- <command>`;
this discards every inherited lease descriptor and environment field.

## Rollout

When upgrading an existing pool, pause launchers and watcher triggers and drain
queued old-version invocations before landing the scheduler. They already loaded
the old non-FIFO allocator and cannot obey the new queue policy. Existing holders
remain visible through their resource flocks. Resume triggers with fresh callers
after the reviewed change lands; never unlink locks to force a drain.

### From the single lock

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
