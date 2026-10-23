# Windows VM harness

`win-vm` owns disposable guest lifecycle and interactive scheduled jobs. The
workstation's live command follows `~/.dotfiles/agents/windows-vm/win-vm`.
It reads existing VM credentials by path; they never belong in evidence.

## Named device ownership

```sh
win-vm up
win-vm run --ephemeral -- ./lane.sh
```

`up` and `run --ephemeral` take the `heavy-lease` named `win-vm` lock
before the guest lease, so concurrent owners wait instead of rejecting each
other. Call them directly; do not add an outer wrapper. Missing
`heavy-lease` fails before startup. `--class` is accepted and ignored for
old callers.

Host admission was removed by the 2026-10-23 decision. There is no memory
estimate, headroom check, slot request or admission wait. The kernel owns
CPU and memory. Named device ownership and guest lifecycle exclusions stay.
Ephemeral runs still refuse a running persistent VM.

When persistent bind mounts need restoration, `up` first calls the supported
`omarchy-windows-vm prepare` operation. It may authorize privileged mount/config
preparation, but must never start or recreate Windows. Only this fixed
host-global operation runs through `heavy-lease isolate` in the user-manager
context, with `/` as cwd and `GAH_WORKSPACE`, `GAH_ROOT`, `GAH_BIN` and
`GAH_LAUNCH_CONTEXT` absent. It invokes absolute
`/usr/bin/omarchy-windows-vm prepare`, so trusted root-owned helper validation
uses host ownership rather than unmapped owners in a workspace namespace.
The parent retains its VM named lock. Source, payload and actual Docker
allocation remain in the original caller context. After preparation returns,
the owner validates mounts and starts Docker under the final lifecycle lock.
Missing, failed or incomplete prepare support prevents startup; there is no
fallback to privileged `up`. Install the Omarchy prepare-capable provider
before enabling this restoration path. Already-running readiness and
already-prepared direct startup do not invoke prepare.

The guardian inherits available named-lock descriptors through teardown;
token-only borrowers continue relying on their parent to retain ownership.
No T3/VM restart, stock Omarchy desktop launcher, manual Docker start, or
container restart policy is changed.

## Transport

SSH and SFTP ignore ambient user and system SSH configuration (`-F none`).
They retain the dedicated identity, `IdentitiesOnly`, batch mode, the five-second
connection timeout, host-key alias, dedicated known-hosts file and
`StrictHostKeyChecking=accept-new`. The transport does not depend on the caller's
namespace ownership view or personal SSH settings.

## Guest jobs

A waiting interactive job joins a Windows job object before launching any
child. The wrapper keeps its non-inheritable job handle open until process
exit. Closing that handle kills every remaining member of the job, including
when Task Scheduler stops the wrapper. The process wrapper disposes its
redirected-output process handle before publishing `exit.txt`.

`gui` without `--wait` is intentionally detached. Its launched application
must survive the short dispatch task. Every waiting job and UI automation
command stays contained.

Cleanup stops the scheduled task, then observes both task termination and
exclusive access to its output files within 15 seconds. Only then does it
remove the job directory and unregister the task. A failure preserves the
task and directory and reports the cleanup error without replacing an
existing operation failure. It never kills a process by an unvalidated PID.

## Failure evidence

A nonzero scheduled-job result, GUI child failure/timeout, host timeout or
transport failure exports the entire job directory to
`~/.local/state/win-vm/evidence/<job-id>/job/` before guest cleanup. Received
stdout/stderr are also saved beside `manifest.json`. The private evidence path
is printed before cleanup, and the manifest records completion, exit status,
export completeness, errors and any retained guest path. The recursive export
attempt is bounded to 30 seconds. Partial files survive an interrupted export.
GUI result classification happens before the job's cleanup, not afterwards.

Only a known-completed job with a complete export may delete its guest outputs.
Unknown completion or any export failure uses `cleanup-job.ps1 -KeepDirectory`:
stop the owned task, wait for handles and unregister it, but retain the job
files. A live snapshot is not a complete history: output written while the
failed task stops remains in that retained guest directory.

For an ephemeral run, a retention marker protects the clone before any guest
job work. If protection cannot be written, the job is not submitted. Protection
is released only after successful completion or known-completed full export.
Teardown removes the owned container but moves the clone to the private,
durable `~/.local/state/win-vm/evidence/guests/<lease-token>/` instead of deleting
it. The host manifest and diagnostics name this location. A later run gets a
new clone and cannot erase the retained evidence. Known-completed nonzero jobs
with successful exports and normal successful jobs retain ordinary teardown.

Evidence may contain private job data and scripts. Keep it out of Git and public
reports. It has no automatic expiry; inspect it, then explicitly remove it when
it is no longer needed. Export, manifest and retention failures are reported;
they never silently replace the original known job exit status.

## Guest health

Readiness requires an explicitly Active console or RDP session for the configured
user. Unknown or inactive session states never count as RDP; session zero is not
an interactive session. `query session` can exit 1 with a valid table, so its
exit status is not a readiness verdict. The complete table must have the known
header and valid rows; empty or malformed output fails loudly. A valid table
without the configured user is not ready. Local SSH configuration, identity-permission and
host-key failures surface immediately with stderr instead of consuming the boot
deadline. Transient network unavailability remains subject to the existing
readiness timeout. The default for `up` and `run --ephemeral` is 60 seconds.
The readiness window bounds blocking local observations, SSH probes and console
handoff together. Nested handoff uses the remaining window, never a fresh
allowance, and job preflight handoff is capped at 60 seconds even when its
product execution budget is longer. Expiry is an infrastructure error with the
last transport or session observation. Clone construction and teardown are
outside this readiness window; product and job-execution budgets are unchanged.

Only read-only scheduled-job observations recover from SSH transport failure.
An SSH exit of 255 or a timed-out control connection starts a health window
of at most 30 seconds, bounded by the original job deadline. Successful
reconnection observes the same task. It never resubmits the job or extends
its execution budget. A guest script failure is not a transport failure and
fails immediately. An unavailable guest still fails closed after the health
window; ephemeral teardown remains mandatory.

## Checks

Run `python3 -m unittest discover -s tests -p 'test_win_vm*.py'` and `./verify`.
`tests/win_vm_guest_contract.ps1` exercises the real scheduled-job cancellation
and detached dispatch contracts on an isolated disposable guest. Upload the
current `run-job.ps1`, `cleanup-job.ps1` and that script into one fresh guest
directory, then run the contract through `win-vm exec`. It needs no screenshots,
product packages, network services or application credentials.
