# Report to the chief of staff

Pi 1.1.0 extension, installed at `~/.pi/agent/extensions/report-to-cos.ts`
from `agents/pi/report-to-cos.ts`. It loads on the next Pi start or explicit
reload. Do not restart existing sessions. It does not cover Claude agents.

Only a standalone `CoS-thread: <threadId>` line in the first user message
activates it. Without that marker it exposes no tool, changes no prompt or
loadout, and neither blocks tools nor requests a settle continuation.

`report_to_cos` takes:

- `kind`: `go_request`, `merge_ready`, `done`, `blocked`, or `tobias_decision`.
- `text`: nonempty report text.
- `pr_url`, `head_sha`: required for `merge_ready`. The URL must be HTTP(S)
  without credentials; the SHA must contain exactly 40 hexadecimal digits.

These are quiet, outcome-only kinds, not routine progress updates. Messages
start with `[kind]` and include any supplied PR URL and SHA. Direct T3 sends
to the CoS target are blocked; only sends nested under the reporting tool are
authorized. Reporting uses Pi's normal tool pipeline and T3's canonical tool
name. It tries `steer`, then `auto` only for the exact `thread_not_sendable`
error code, retaining a request ID scoped to the lead session and target.
Merge reports deduplicate by kind and head SHA; other reports by kind and text.

A successful report means T3 returned an acceptance receipt, including a
message ID and delivery mode. It does not mean the CoS has read or acted on it.
Failures do not satisfy the report guard.

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
