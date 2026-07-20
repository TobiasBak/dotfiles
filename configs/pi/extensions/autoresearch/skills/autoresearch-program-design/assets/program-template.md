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
- `external-blocked`: [missing access/input/decision after every useful legal action]
- `exhausted`: [campaign budget or hypothesis space consumed]

Crash/timeout/malformed-result semantics: [PROJECT-SPECIFIC, fail closed; map invalid evidence to rejected, inconclusive, exhausted, or external-blocked rather than inventing another fleet outcome]

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

- Entry gate: [candidate, champion, plan, environment, scientific budget, and validity prerequisites checked]
- Immutable predeclared plan: `[PATH + DIGEST]`
- Sealed case-set policy: [PROJECT-SPECIFIC]
- Evidence entrypoint: `[EXACT COMMAND]`
- Validity checks: [schema, identities, digests, environment, completeness]
- Acceptance rule: [PROJECT-SPECIFIC]
- Integration authority: [human/project-specific role]

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
| Evidence attempts | [value] | 1 attempt | n/a |
| Scarce scientific operations | [value] | [value] | [project-enforced value if required] |

- Extension worker load: chosen only by `/autoresearch N`; do not declare another worker cap here
- Maximum hypotheses/candidates/evidence attempts: [scientifically justified values]
- Retry/backoff policy: [PROJECT-SPECIFIC]
- Cancellation/cleanup command: `[COMMAND]`
- Permitted execution window: [PROJECT-SPECIFIC]

## 7. Autonomous researchers and checkpoints

Each worker independently chooses a useful campaign within this program, records a non-exclusive intent, completes the full campaign through a scientific terminal outcome, writes a terminal checkpoint, and exits. While `/autoresearch N` remains active, the extension replaces exited workers. There is no dispatcher, exclusive assignment, lock, lease, approval/admission step, fencing token, or capacity-reservation protocol. Overlap is allowed; use observed intents and findings to reduce waste without treating them as authority.

Checkpoints are only for observability and crash recovery. Record one after material findings, before long or external work, and at terminal transitions. A continuation command or launch receipt describes recoverable process state and grants no ownership or permission.

Required checkpoint fields:

```json
{
  "campaign": "[ID]",
  "hypothesis": "[ID]",
  "intent": "[non-exclusive description]",
  "stage": "[ID]",
  "status": "[running|blocked|decision|failed|complete]",
  "summary": "[bounded actionable summary]",
  "findings": ["[finding with provenance]"],
  "blockers": ["[blocker]"],
  "nextActions": ["[next action or empty at terminal outcome]"],
  "runIds": ["[artifact/run ID]"],
  "candidateCommit": "[full commit]",
  "championCommit": "[full commit]",
  "continuationCommand": "[exact command if recovering an interrupted process]",
  "launchReceipt": { "[project-specific process metadata]": "[value]" }
}
```

Shared memory: [bounded observations and promoted findings]

Private worker memory: [scratch/logs not shared unless promoted]

## 8. Project-enforced scientific and process limits

`/autoresearch N` is the only extension operational load limit. Project-level limits remain valid when they protect scientific validity, cost, scarce resources, or process safety. Define how project commands enforce [evidence-attempt cap, device/API concurrency, cost/rate limit, timeout, cleanup, or other applicable rule]. These controls evaluate the operation itself, not worker identity, ownership, generation, or admission.

Enforcement and recovery command/code path: `[PROJECT-SPECIFIC]`

## 9. Git, worktree, synchronization, and integration

- Canonical root: `[ABSOLUTE OR DISCOVERY RULE]`
- Worker branch/worktree convention: `autoresearch/worker-N` / [path rule]
- Allowed changed paths: [PROJECT-SPECIFIC]
- Forbidden/generated/secret paths: [PROJECT-SPECIFIC]
- Commit-before-evidence rule: [PROJECT-SPECIFIC]
- Dirty-tree policy: [fail closed]
- Candidate identity rule: [commit/tree/artifact digest]
- Synchronization authority and prerequisites: [extension/project-specific authority, reconciled process, preserved candidate, clean lane]
- Conflict handling and human resolver: [PROJECT-SPECIFIC]
- Post-integration verification: `[EXACT COMMANDS]`

The extension never updates an active lane. After a terminal campaign, the supervisor preserves the exact terminal commit, serially merges its branch into the clean canonical branch without rewriting worker commits, resets only that completed lane, and then launches its replacement. Other lanes converge after their campaigns finish. A conflict or canonical safety mismatch blocks the affected lane with its terminal ref preserved. This mechanical integration is not scientific evidence or acceptance.

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
- process launch and terminal receipts
- checksums for immutable inputs/outputs

Naming, retention, redaction, and size limits: [PROJECT-SPECIFIC]

Development/calibration and sealed evidence use separate namespaces. Never overwrite an evidence artifact. Secrets and sensitive raw data are not committed.

## 11. Knowledge promotion and synchronization

Promote only reusable findings, useful failures, corrections, procedures, and decision rationale. Record baseline, intervention, effect, conditions, and tradeoffs for optimization claims.

- Project knowledge destination: [docs/note/path]
- Operational-only destination: [checkpoint/artifact]
- Promotion owner and gate: [PROJECT-SPECIFIC]
- Cross-worker observation point: [checkpoint/human review]
- Contradiction/conflict handling: [PROJECT-SPECIFIC]

Do not promote raw transcripts, secrets, routine activity, or unverified speculation as fact.

## 12. Stop conditions

Stop the affected worker when:

- [scope exhausted or duplicate]
- [required decision or access missing]
- [budget threshold reached]
- [benchmark validity cannot be restored]
- [candidate identity or external process cannot be reconciled]
- [unsafe condition]

Stop the campaign when:

- an accepted candidate passes integration verification
- all predeclared hypothesis classes are rejected or exhausted
- campaign wall time/cost/evidence budget is reached
- evidence epoch integrity is compromised
- the human pauses or ends the campaign

At stop, cancel or reconcile external jobs, write terminal receipts, checkpoint the scientific terminal status, preserve immutable artifacts, leave worktrees in the declared clean/committed state, and exit. The extension may then start a replacement researcher.

## 13. Launch review

- [ ] Human reviewed claims, commands, costs, risks, and integration authority.
- [ ] No launch-blocking `DECISION REQUIRED` remains.
- [ ] Commands and timeouts were verified or clearly block launch.
- [ ] Benchmark self-tests/calibration passed where applicable.
- [ ] Canonical `program.md` is a regular, nonsymlink, non-empty file.
- [ ] Canonical checkout is clean and reviewed changes are committed.
- [ ] `/autoresearch N` is the only extension worker-load setting; any scientific/resource concurrency limit is project-enforced and justified.
- [ ] Workers complete one full campaign, checkpoint a terminal outcome, and exit for replacement.
- [ ] Checkpoints and intents are informational and cannot be mistaken for ownership or authorization.
- [ ] Artifact, receipt, reconciliation, and stop procedures are executable.
