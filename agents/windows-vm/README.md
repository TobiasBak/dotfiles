# Windows VM harness

`win-vm` owns disposable guest lifecycle and interactive scheduled jobs. The
workstation's live command follows `~/.dotfiles/agents/windows-vm/win-vm`.
It reads existing VM credentials by path; they never belong in evidence.

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

## Guest health

Readiness requires an explicitly Active console or RDP session for the configured
user. Unknown or inactive session states never count as RDP; session zero is not
an interactive session. Native session-query failures are errors, not evidence
that the user is logged out. Local SSH configuration, identity-permission and
host-key failures surface immediately with stderr instead of consuming the boot
deadline. Transient network unavailability remains subject to the existing
readiness timeout.

Only read-only scheduled-job observations recover from SSH transport failure.
An SSH exit of 255 or a timed-out control connection starts a health window
of at most 30 seconds, bounded by the original job deadline. Successful
reconnection observes the same task. It never resubmits the job or extends
its execution budget. A guest script failure is not a transport failure and
fails immediately. An unavailable guest still fails closed after the health
window; ephemeral teardown remains mandatory.

## Checks

Run `python3 -m unittest discover -s tests -p test_win_vm.py` and `./verify`.
`tests/win_vm_guest_contract.ps1` exercises the real scheduled-job cancellation
and detached dispatch contracts on an isolated disposable guest. Upload the
current `run-job.ps1`, `cleanup-job.ps1` and that script into one fresh guest
directory, then run the contract through `win-vm exec`. It needs no screenshots,
product packages, network services or application credentials.
