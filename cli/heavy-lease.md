# Heavy-lease: named locks and isolation

Host admission was removed by Tobias's 2026-10-23 decision. CPU and memory
belong to the kernel. T3's agent slice supplies its memory backstop, gah owns
session scopes, and CFS shares CPU. Repositories run commands directly.
There is no replacement pool, memory-headroom wait, priority queue or journal.

`heavy-lease` remains transitional until phase 3 moves named locks to their
owners and isolation to gah/systemd-run, then deletes this tool.

## Named locks

```sh
heavy-lease run --wait --exclusive win-vm -- command
heavy-lease run --try --exclusive device -- command
heavy-lease status --json
```

`run` without `--exclusive` execs the command immediately. It preserves the
command's PID, exit status and signal. `--wait` and `--try` do not admit work.
`--weight`, `--class` and `--memory` are accepted and ignored so callers can
remove their old admission wrappers independently in phase 2. Unrestricted
runs export a fixed, resource-free `HEAVY_LEASE_TOKEN` marker because
Orderready still uses its presence to bypass a local capacity pool and
authorize private workers. No descriptor or lock represents that marker.
Named-lock acquisition replaces it with a real ownership token. Phase 2
removes this compatibility dependency with the caller plumbing.

`--exclusive NAME` holds a named kernel `flock` for the command's lifetime.
Names contain 1..80 letters, digits, underscores or hyphens. `--wait` blocks
until the lock is free and is the default; `--try` returns 2 if it is held.
Different names do not exclude each other. Nested calls for a name already
held by their parent pass through without reacquiring it. Named ownership is
exported through `HEAVY_LEASE_TOKEN`, `HEAVY_LEASE_FD` and `HEAVY_LEASE_FDS`.
Token-only borrowers rely on their parent retaining the lock. Inherited
lock descriptors also keep ownership alive until they close.

Locks live under `~/.local/state/heavy-lease/exclusive-NAME.lock`, with holder
metadata beside them. Never unlink an active resource lock file: that would
allow a second owner to lock a different inode. Waiter metadata is live only
while its per-process registration lock is held. Stale metadata is not a
held lock or a live waiter.

`status --json` reports `exclusive` entries with `name` and `holder`, plus
`waiters`. A holder contains `pid`, `command`, `started_at`, `token` and
`resources`; waiters also identify `exclusive`. The top-level `holder` is the
first held named lock's metadata, or null, retained for stepkit-studio's
runtime deadline diagnostic. There are no slot or request-history fields.
Text status lists held names and waiting commands.

## Transitional handoff and adopt

`handoff -- command` and `adopt --socket VALUE -- command` exec their command
directly. There is no broker, socket connection or descriptor transfer.
`handoff` sets `HEAVY_LEASE_SOCKET` to an empty compatibility value because
older bounded runners expand it before calling `adopt`; `adopt` ignores it.
The current bounded-runner callers do not need named-lock transfer across a
manager boundary. Named-lock owners must retain their own descriptors.

## Independent lifetimes

```sh
heavy-lease isolate -- command
```

`isolate` is unchanged. It escapes the caller's gah session scope into an
independent user service under `app.slice`, preserving foreground I/O, the
working directory, environment, arguments, exit status and signal. It drops
all `HEAVY_LEASE_*` context and inherited lease descriptors. Acquire any
needed named lock inside the isolated command, not before isolation.
The service inherits only stdin, stdout and stderr. In CI, or off Linux,
it execs directly after dropping lease context, retaining unrelated inherited
descriptors.

When `GAH_WORKSPACE` is present, isolation resolves `GAH_BIN` or `gah` and
re-enters that workspace before starting the payload. It fails if the
workspace reference is empty or gah is unavailable, rather than running main's
tree. A private request carries the environment across the service-manager
boundary; the worker deletes it before starting the command. The service
name is printed on stderr. An interrupted caller can leave a private
`hl-isolate-*` runtime directory for inspection and cleanup.
