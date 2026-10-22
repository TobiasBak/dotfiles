# Host work scheduler

`heavy-lease` admits heavy Linux work to a host-wide four-slot weighted pool,
ordered by priority and constrained by live memory headroom.
Light work never leases: formatting, launcher self-builds, status, individual
cases and static checks run directly. Repo entry points own admission.

```sh
heavy-lease run --wait --class gate -- command
heavy-lease run --wait --weight 2 -- command
heavy-lease run --try --class efficiency --weight 1 -- command
# The VM owner derives startup memory from its actual guest configuration.
win-vm run --class gate --ephemeral -- vm-command
heavy-lease run --wait --exclusive device --memory 0 -- no-growth-command
heavy-lease run --wait --weight 2 --memory 9126805504 -- command
heavy-lease status --json
```

`run` waits by default. `--try` returns 2 without waiting when admission is
unavailable, including a concurrent allocation transaction. Other CLI errors
return 1. The command's exit status or signal is preserved.

`--exclusive NAME` takes a separate named lock and defaults to zero pool slots,
even for commands in the weight table. Add `--weight K` to request both.
Weights must fit the pool; zero is accepted only with `--exclusive`.
`--memory BYTES` estimates the phase's **additional** physical allocation.
It defaults to `weight × PER_SLOT_PEAK`, including zero for a named-only lock.
Explicit zero is appropriate for no-growth operations, not VM startup.
Memory is an admission check, not a descriptor-owned byte quota or hard limit.
The actual allocating owner must supply its growth estimate; named exclusivity
alone does not describe an allocation.

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
`PER_SLOT_PEAK` constant retains the original 17-GiB sizing estimate divided
by four slots (4.25 GiB per slot), not a current slice budget. Two weight-two jobs fill the slots, but live headroom
may admit fewer. These are admission estimates, not cgroup memory limits or
CPU quotas. Request history is diagnostic only; it does not learn peak estimates.
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
applies within a class except for bounded slot backfill. Running work is never
preempted. When the eligible pool head needs more slots than are free, the first
named-resource-eligible waiter that fits may backfill, in class/FIFO order.
Each head permits at most four total slot-weights of backfill over its entire
wait. Admissions charge its durable `backfill_used` counter under the admission
mutex; releases never replenish that credit. Once spent, free slots remain
reserved until the head admits or exits. Thus fitting work uses otherwise idle
capacity without an unbounded stream delaying the wide head. This bounds bypass
work, not runtime: a backfilled command may still run arbitrarily long.
A head blocked by transient memory pressure with enough free slots is never skipped.
A waiter blocked on an unavailable named resource does not block unrelated
resources. Named-only VM work remains independent of the slot pool. Combined
requests acquire all resources together; queued work holds no partial allocation.

Each slot and named resource has its own kernel-held `flock`. One short
admission transaction serializes live queue order, the memory check, and the
nonblocking resource scan. Kernel descriptors own resources; queue order and
live memory decide admission. Dead waiter metadata is ignored, including after
SIGKILL. There is no queue daemon.

Headroom is the minimum of host `MemAvailable − 4 GiB` from `/proc/meminfo`
and each finite caller-cgroup ancestor's
`memory.max − (memory.current − inactive_file)`. The fixed OS/desktop margin
is deducted from host availability only, not again from each ancestor.
Used memory and headroom are clamped to zero. Inactive file cache is reclaimable;
the tightest ancestor still applies. `memory.high` is not an admission limit.
Swap never adds admission capacity. Every request needs both free resources
and headroom for its estimate, even with an empty pool or zero slots.
A finite caller-cgroup ancestor limit below the estimate fails immediately with
exit 1 before waiter registration, naming the cgroup, limit and expected peak.
Current usage does not cause this rejection.

Host availability includes resident development outside T3, including Windows
in `system.slice`. Do not reserve its full RAM again or subtract live holders'
full peaks: their current usage already reduced availability. The remaining
physical capacity serves all development. No fixed CPU cores are reserved,
and the four-slot concurrency and default weights are unchanged.

This is checked stage admission, not a guarantee against simultaneous growth
of already-admitted jobs or allocations that bypass the tool. No per-job memory
cgroup, daemon, CPU quota or identical-command deduplication is added.
`win-vm` owns admission for its `up` and ephemeral-run startup paths; stock
Omarchy launch and direct Docker commands are separate paths.

Waiters wake on resource release and queue events. Lock helpers inherit no lease
descriptors and die with their parent. Memory-only blocking also uses a bounded
timerfd reread because memory recovery has no reliable release event. SIGTERM and SIGINT exit promptly and remove the waiter, even when the
caller inherited blocked or ignored signals. There are no sleep-based polling
loops.

Locks live under `~/.local/state/heavy-lease`. Never unlink active resource lock
files. `status --json` is a point-in-time, non-atomic snapshot with `pool_size`,
occupied `slots`, held `exclusive` resources, live `waiters` and retained
`requests`. Each waiter
reports its class, expected peak in bytes, and admission reason, including
`memory` when headroom blocks admission. Each resource includes its name and
holder metadata. Linux orphan-pin diagnostics identify surviving inherited
descriptors when the metadata PID is dead, subject to `/proc` visibility and
PID reuse limits described by `status --help`.

Black-box fixtures can override memory input paths with `HEAVY_LEASE_MEMINFO`,
`HEAVY_LEASE_CGROUP_ROOT`, and `HEAVY_LEASE_CGROUP_FILE`. Normal invocations read
`/proc/meminfo`, `/sys/fs/cgroup`, and `/proc/self/cgroup`. Input errors fail
loudly rather than admitting against invented headroom.

A top-level `run` supervises one command child to record its real exit code.
Holder `pid` identifies the supervising request; `command_pid` identifies the
payload. The supervisor retains no lease or other non-stdio descriptors after
launch, forwards HUP/INT/QUIT/TERM/USR1/USR2/ALRM to the command, and returns its
exit status or signal. Linux parent-death SIGKILL prevents a killed supervisor
from leaving its direct command running. Nested `run` still uses `exec`, so it
preserves the command PID, high-numbered lock descriptors and holder token.
Exit or SIGKILL releases locks when the last inherited descriptor closes. A
surviving descendant or adopted service can intentionally keep a lease pinned. `handoff` and `adopt` transfer the
entire descriptor set across a manager boundary. Nested `run` passes through
only with a matching token on live held resources and sufficient parent slots
and named locks. Without an explicit `--weight`, a matching live nested run
requests exactly the parent's held weight, regardless of its command or working
directory. An explicit `--weight` passes through only within the parent's
allocation; larger slot/name requests are rejected rather than waiting on itself.
An explicit nested `--memory` rechecks live host/caller headroom for that
additional allocation, waiting with timerfd or returning 2 for `--try`.
It retains existing locks but acquires no new ones, does not compare against
the parent's old estimate, and does not rewrite that estimate. This supports
historical callers holding a zero-slot `win-vm` lock before the VM owner
requests startup memory. Unspecified nested memory retains direct passthrough.
Nested calls create no independent request journal or queue entry.
Top-level runs keep the command and working-directory weight defaults.
Token-only nested subprocesses rely on the parent retaining
the locks. Start independent work with `heavy-lease isolate -- <command>`;
this discards every inherited lease descriptor and environment field.

A user service starts outside its caller's mount namespace. When the caller
has `GAH_WORKSPACE`, isolation automatically wraps the payload in
`gah enter <workspace> -- ...`, retaining `GAH_ROOT`, environment, arguments
and the relative working directory. It resolves the explicit `GAH_BIN`, or
`gah` on the caller's PATH, before starting the service; an unavailable CLI
fails loudly instead of running against main. The re-entered command holds
gah's lifetime lease. The result observer runs inside that namespace too, so
a payload killed by a signal remains distinguishable from an ordinary exit
with code `128 + signal`, despite bubblewrap's exit-code encoding. CI and
non-Linux direct execution do not cross a manager boundary and do not add
another workspace entry.

## Request records

`requests/<request_id>.jsonl` under the state directory is an append-only,
mode-0600 lifecycle journal. Each queued record contains the random request ID,
request PID, UTC start time, Linux process-start ticks and boot ID, class, weight,
exclusive name, expected additional memory peak, cwd, and command head. The head is limited to four arguments of
256 characters each; no environment or holder token is copied to the journal.
Do not put credentials in command arguments.

The subsequent admitted and exited events add `admitted_at`, `command_pid`,
`exited_at` and `exit_code`. Times are UTC ISO 8601 wall times. Exit codes use
negative signal numbers for signal termination. `--try` rejection records exit 2
without an admission. CLI validation errors and nested passthrough do not create
independent requests. The initial queued event is published atomically; later
events append to that journal. File data and directory entries are fsynced.
A failed queued/admitted write prevents starting the command. After any journal
write fails, no later event is appended to its possibly torn tail. Completion
write failures are reported on stderr without replacing the payload's known
exit status or signal.

`status --json` folds events into one entry per request with a `state` of
`queued`, `admitted`, `exited` or `interrupted`. Request IDs also appear in live
waiter and holder metadata. Records with a dead or reused request PID and no
exit event are `interrupted`: SIGKILL, host shutdown or a failed journal write
cannot supply a trustworthy exit timestamp or code. Those fields remain null,
not an invented successful exit. An incomplete or malformed tail is ignored
and marks the retained valid prefix as interrupted; it cannot poison other
requests' admission or status.
`exited_at` measures direct command completion, not the last inherited lock's
release. Resource flocks remain authoritative for surviving descendants.

Each new request and completion prunes inactive journals to the latest 1024
requests and seven days by queue time. Live requests are never pruned, even if
older. Retention removes whole journals, never rewrites events. Retention I/O
errors are reported on stderr without blocking admission or changing a payload
result; later requests retry pruning. Status only reads
history. Old running invocations have no journal and are not backfilled. This
journal format does not alter pool size, priority, FIFO or default weights.
Old journals and live holders without the memory estimate remain readable;
they are not retroactively assigned a different allocation.

## Rollout

The installed Python script is live-linked to the stable checkout. Fresh
invocations use landed edits immediately; already-running invocations retain
the loaded policy. Pause triggers and drain old queued allocators before
claiming that every admission uses the desktop margin. Existing holders remain
visible through their resource flocks. Never unlink locks to force a drain.

Historical VM wrappers may continue taking a named-only zero-slot lease.
The VM owner reuses that valid ownership and explicitly checks startup memory;
there is no mandatory-memory flag migration for generic named locks.

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
