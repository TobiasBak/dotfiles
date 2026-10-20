# Report to the chief of staff

Pi 1.1.0 extension, installed at `~/.pi/agent/extensions/report-to-cos.ts`
from `agents/pi/report-to-cos.ts`. It loads on the next Pi start or explicit
reload. Do not restart existing sessions. It does not cover Claude agents.

Only a standalone `CoS-thread: <threadId>` line in the first user message
activates it. Without that marker it exposes no tool, changes no prompt or
loadout, and neither blocks tools nor requests a settle continuation.
Once activated, the latest standalone `CoS-thread:` line in any user message,
including later prompts and steers, retargets reporting and direct-send blocking.
Deduplication is scoped per target, so the same report can reach a replacement CoS.

`report_to_cos` takes:

- `kind`: `go_request`, `merge_ready`, `done`, `blocked`, `finding`, or
  `tobias_decision`.
- `text`: nonempty report text.
- `outcome`: `green` or `red`, required for every `done` report. Use `red`
  for a failed/RED outcome even if the assignment itself is complete.
- `failure`: required for `blocked`, `finding`, and red outcomes. Nonempty
  `step` identifies the failing phase; `cause` gives an evidence-backed
  explanation or the literal `unknown`; `evidence` names paths/commands
  actually inspected and the observations supporting the cause. Unknown cause
  also requires nonempty `next_probe` and `diagnosis_owner` naming who keeps
  diagnosing. Missing fields produce field-specific errors before sending.
  Any supplied failure object is validated, regardless of kind.
- `pr_url`, `head_sha`: required for `merge_ready`. The URL must be HTTP(S)
  without credentials; the SHA must contain exactly 40 hexadecimal digits.
- Use `go_request` for design, scope and protected-surface approvals.
  It requires no SHA or review. Heavy work needs no CoS grant; repository
  entry points use kernel `heavy-lease` admission.

These are quiet, outcome-only kinds, not routine progress updates. `finding`
is the only non-terminal report: send it as soon as evidence changes a
previously reported failure's known cause. It does not replace a final report.
The tool checks structure, not whether an explanation is true or a finding
actually changes an earlier cause; the agent must establish that from evidence.
Messages start with `[kind]` and include outcome, failure fields verbatim,
and any supplied PR URL and SHA. Direct T3 sends
to the CoS target are blocked; only sends nested under the reporting tool are
authorized. Reporting uses Pi's normal tool pipeline and T3's canonical tool
name. It tries `steer`, then `auto` only for the exact `thread_not_sendable`
error code, retaining a request ID scoped to the lead session and target.
Merge reports still deduplicate by kind and head SHA; other reports use the
complete rendered message, so changed evidence or cause reaches the CoS even
when the summary text is unchanged. `merge_ready` retains its PR contract.

A successful report means T3 returned an acceptance receipt, including a
message ID and delivery mode. It does not mean the CoS has read or acted on it.
Failed sends, rejected reports and findings do not satisfy the final-report guard.

Before settling, an activated session gets at most one hidden reminder and
continuation per external prompt unless it reported successfully or has a live
delegated child. User steering resets the guard; internal continuations do not.
Child liveness is observational: delegation and status results retain
unresolved task IDs; observed terminal status, accepted cancellation, or T3's
terminal completion notice removes them. Pending child runs and nested child
work remain live. There is no settle refresh, network client, polling, SQL, or
extra tool. Until T3 delivers completion or status, liveness can be stale. Reload can
reconstruct direct tool results, but not nested child results absent from the
transcript. Any internal hook fault disables enforcement for that session;
uncertain child status also allows settling. Neither blocks tools nor forces a
continuation. The reporting tool can return an honest failure.
