# Autoresearch program: [PROJECT-SPECIFIC TITLE]

> Review status: **DECISION REQUIRED / draft / human-reviewed**
>
> This file is an executable research contract. Replace every bracketed instruction. Do not launch while any launch-blocking `DECISION REQUIRED` remains.

## 1. Decision and scope

- **Decision this campaign supports:** [PROJECT-SPECIFIC]
- **Goal:** [PROJECT-SPECIFIC user-visible or scientific outcome]
- **In scope:** [components and allowed intervention classes]
- **Out of scope:** [explicit exclusions]
- **Human approval required for:** [cost, network, dependencies, migrations, integration, other]
- **Reviewed canonical commit:** `[FULL COMMIT]`
- **Supported environment:** [OS, architecture, runtime, service/data versions]

## 2. Claims and terminal outcomes

### Claim C1: [PROJECT-SPECIFIC falsifiable statement]

- Intervention: [allowed change]
- Population/conditions: [workloads, inputs, environment]
- Champion: [immutable identity rule]
- Measure and unit: [observable]
- Mandatory validity gates: [correctness, safety, compatibility]
- Minimum meaningful effect: [threshold]
- Decision rule: [deterministic or uncertainty-aware]
- Evidence stage and command: [stage ID and exact command]
- Scope limit: [what this does not prove]

[Repeat for each material claim.]

Terminal outcomes:

- `accepted`: [all gates and promotion rule]
- `rejected`: [valid evidence fails rule or gate]
- `inconclusive`: [valid but insufficient evidence]
- `blocked`: [missing access/input/decision]
- `exhausted`: [campaign budget consumed]
- `invalid`: [integrity failure; no claim may be made]

Crash/timeout/malformed-result semantics: [PROJECT-SPECIFIC, fail closed]

## 3. Executable command contract

Run commands from `[REPOSITORY ROOT OR OTHER DIRECTORY]` with `[ENVIRONMENT SETUP]`.

| Purpose | Exact command | Timeout | Expected machine-observable result |
|---|---|---:|---|
| Environment check | `[COMMAND]` | `[DURATION]` | `[EXIT/JSON/ARTIFACT]` |
| Build | `[COMMAND]` | `[DURATION]` | `[EXIT/ARTIFACT]` |
| Deterministic tests | `[COMMAND]` | `[DURATION]` | `[EXIT/REPORT]` |
| Development benchmark | `[COMMAND]` | `[DURATION]` | `[RESULT JSON]` |
| Screening evidence | `[COMMAND]` | `[DURATION]` | `[RESULT JSON]` |
| Sealed/final evidence | `[PROJECT EVIDENCE ENTRYPOINT ...]` | `[DURATION]` | `[RESULT + RECEIPT]` |
| Integration verification | `[COMMAND]` | `[DURATION]` | `[EXIT/REPORT]` |

Commands marked `[UNVERIFIED PROPOSAL]`: [none, or list and owner for verification]

## 4. Campaign stages and evidence gates

### S0: Calibration

- Entry gate: [environment is eligible]
- Actions: [benchmark self-tests, baseline run, variance/sensitivity calibration]
- Max attempts: [N]
- Artifacts: [paths]
- Exit gate: [specific valid result]
- Failure outcome: [blocked/invalid]

### S1: Development

- Entry gate: [S0 passed]
- Visible cases: [case-set ID/version]
- Command: `[EXACT COMMAND]`
- Required deterministic tests: `[EXACT COMMAND]`
- Promotion to screening: [rule]
- Max candidates/runs: [N]

### S2: Screening

- Entry gate: [candidate identity fixed and development gates pass]
- Plan/case-set version: [ID and digest]
- Command: `[EXACT COMMAND]`
- Replication/order: [deterministic, paired, randomized]
- Promotion to evidence: [rule]
- Max survivors: [N]

### S3: Evidence

- Entry gate: [candidate, champion, plan, environment, and reservation validated]
- Immutable predeclared plan: `[PATH + DIGEST]`
- Sealed case-set policy: [PROJECT-SPECIFIC]
- Evidence entrypoint: `[EXACT COMMAND INCLUDING RESERVATION ARGUMENT]`
- Validity checks: [schema, identities, digests, environment, completeness]
- Acceptance rule: [PROJECT-SPECIFIC]
- Integration authority: [human/parent]

### S4: Integration and closure

- Entry gate: [accepted candidate and approval]
- Integration method/owner: [cherry-pick, merge, patch, other]
- Post-integration commands: `[EXACT COMMANDS]`
- Closure artifacts and knowledge destinations: [paths]

## 5. Benchmark/test protocol

- Contract/schema version: [ID]
- Benchmark implementation identity: [commit/digest]
- Champion identity: [commit + tree/artifact digest]
- Candidate identity: [commit + tree/artifact digest]
- Development cases: [ID, visible location]
- Sealed holdout cases: [ID, custody/access policy]
- Deterministic isolation: [build dirs, caches, services, ports, env, cleanup]
- Pairing/randomization/replications: [predeclared]
- Score: [components, aggregation, direction]
- Mandatory validity gates: [not folded into score]
- Anti-gaming boundary: [candidate-controlled vs evaluator-controlled]
- Self-tests/calibration: [commands and required outcomes]
- Epoch-change rule: [changes that invalidate comparability]
- Timeout/crash/partial-result semantics: [explicit]

Machine-readable result schema/path: `[PATH OR LINK TO CONTRACT]`

## 6. Resource limits and concurrency

| Resource | Campaign cap | Per-command cap | Concurrent cap |
|---|---:|---:|---:|
| Wall time | [value] | [value] | [value] |
| CPU/processes | [value] | [value] | [value] |
| Memory/disk | [value] | [value] | [value] |
| Accelerators/devices | [value] | [value] | [value] |
| External requests/tokens/cost | [value] | [value] | [value] |
| Evidence reservations | [value] | 1 per invocation | [value] |

- Maximum fleet workers: `[1-4]`
- Maximum hypotheses/candidates/evidence attempts: [values]
- Retry/backoff policy: [PROJECT-SPECIFIC]
- Cancellation/cleanup command: `[COMMAND]`
- Permitted execution window: [PROJECT-SPECIFIC]

## 7. Worker coordination and checkpoints

Before work, use `autoresearch_worker_state` `snapshot`. Claim a distinct scope in a checkpoint. Checkpoint after material findings, before long/external work, before pause, and at terminal transitions.

Required checkpoint fields:

```json
{
  "campaign": "[ID]",
  "hypothesis": "[ID]",
  "stage": "[ID]",
  "status": "[running|paused|blocked|decision|failed|complete]",
  "summary": "[bounded actionable summary]",
  "findings": ["[finding with provenance]"],
  "blockers": ["[blocker]"],
  "nextActions": ["[next action]"],
  "runIds": ["[artifact/run ID]"],
  "claimedScopes": ["[exclusive scope]"],
  "candidateCommit": "[full commit]",
  "championCommit": "[full commit]",
  "continuationCommand": "[exact command]",
  "launchReceipt": { "[project-specific]": "[value]" }
}
```

Shared memory: [bounded operational state and promoted findings]

Private worker memory: [scratch/logs not shared unless promoted]

## 8. Evidence reservation integration

Generic reservations coordinate capacity. Hard enforcement requires the project evidence entrypoint itself to validate each reservation.

Required sequence:

1. Worker calls `reserve_evidence` for `[AUTHORIZED STAGE]`.
2. Worker invokes `[PROJECT EVIDENCE ENTRYPOINT]` with reservation ID plus worker/fleet generation identity.
3. Entrypoint checks the active fleet database/state immediately before scarce-resource acquisition and rejects missing, stale, released, wrong-worker, wrong-generation, or wrong-stage reservations.
4. Entrypoint records an immutable launch receipt: [fields such as reservation, run, PID/job, environment, plan digest, start time].
5. Worker calls `release_evidence` with a terminal receipt on success, failure, cancellation, or timeout.
6. On worker/process loss, [PROJECT-SPECIFIC RECONCILIATION PROCEDURE] verifies the external job before release or relaunch.

Validation command or code path: `[PROJECT-SPECIFIC]`

## 9. Git, worktree, synchronization, and integration

- Canonical root: `[ABSOLUTE OR DISCOVERY RULE]`
- Worker branch/worktree convention: `autoresearch/worker-N` / [path rule]
- Allowed changed paths: [PROJECT-SPECIFIC]
- Forbidden/generated/secret paths: [PROJECT-SPECIFIC]
- Commit-before-evidence rule: [PROJECT-SPECIFIC]
- Dirty-tree policy: [fail closed]
- Candidate identity rule: [commit/tree/artifact digest]
- Synchronization authority and prerequisites: [parent only, no active assignment/reservation, reconciled process, clean lane]
- Conflict handling: [PROJECT-SPECIFIC]
- Integration authority and method: [PROJECT-SPECIFIC]

Synchronization preserves a candidate and updates a lane. It is not evidence, acceptance, or integration.

## 10. Artifacts, plans, and receipts

Artifact root: `.autoresearch/artifacts/runs/[EPOCH]/[RUN-ID]/` [or project-specific equivalent]

Every evidence run preserves:

- immutable predeclared plan and digest
- champion/candidate identities
- evaluator, schema, case-set, and epoch versions
- environment fingerprint and command
- stdout/stderr or bounded references
- per-case/per-replicate machine-readable observations
- aggregate score plus separate validity status
- resource use and timestamps
- launch and terminal receipts
- checksums for immutable inputs/outputs

Naming, retention, redaction, and size limits: [PROJECT-SPECIFIC]

Development/calibration and sealed evidence use separate namespaces. Never overwrite an evidence artifact. Secrets and sensitive raw data are not committed.

## 11. Knowledge promotion and synchronization

Promote only reusable findings, useful failures, corrections, procedures, and decision rationale. Record baseline, intervention, effect, conditions, and tradeoffs for optimization claims.

- Project knowledge destination: [docs/note/path]
- Operational-only destination: [checkpoint/artifact]
- Promotion owner and gate: [PROJECT-SPECIFIC]
- Cross-worker synchronization point: [checkpoint/parent review]
- Contradiction/conflict handling: [PROJECT-SPECIFIC]

Do not promote raw transcripts, secrets, routine activity, or unverified speculation as fact.

## 12. Stop conditions

Stop the affected worker when:

- [scope exhausted or duplicate]
- [required decision or access missing]
- [budget threshold reached]
- [benchmark validity cannot be restored]
- [reservation or identity cannot be reconciled]
- [unsafe condition]

Stop the campaign when:

- an accepted candidate passes integration verification
- all predeclared hypothesis classes are rejected or exhausted
- campaign wall time/cost/evidence budget is reached
- evidence epoch integrity is compromised
- the human pauses or ends the campaign

At stop, cancel or reconcile external jobs, release reservations with terminal receipts, checkpoint terminal status, preserve immutable artifacts, leave worktrees in the declared clean/committed state, and report the next human decision.

## 13. Launch review

- [ ] Human reviewed claims, commands, costs, risks, and integration authority.
- [ ] No launch-blocking `DECISION REQUIRED` remains.
- [ ] Commands and timeouts were verified or clearly block launch.
- [ ] Benchmark self-tests/calibration passed where applicable.
- [ ] Canonical `program.md` is a regular, nonsymlink, non-empty file.
- [ ] Canonical checkout is clean and reviewed changes are committed.
- [ ] Evidence entrypoint enforces reservations if hard concurrency is claimed.
- [ ] Artifact, receipt, reconciliation, and stop procedures are executable.
