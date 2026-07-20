# Autoresearch project program: [PROJECT-SPECIFIC TITLE]

> Validation status: **DECISION REQUIRED / draft / validated**
>
> This file is the enduring project-level research and transition contract. Replace every bracketed instruction. Bounded executable epoch contracts are selected separately. Do not start the fleet while any project-level launch-blocking `DECISION REQUIRED` remains, and do not launch candidate evidence while no validated epoch is active.

## 1. Decision and scope

- **Decision this campaign supports:** [PROJECT-SPECIFIC]
- **Goal:** [PROJECT-SPECIFIC user-visible or scientific outcome]
- **In scope:** [components and allowed intervention classes]
- **Out of scope:** [explicit exclusions]
- **Human approval policy:** [project-selectable consequential actions: cost, secrets, destructive actions, external access, migrations, integration, other]
- **Canonical starting commit:** `[FULL COMMIT]`
- **Supported environment:** [OS, architecture, runtime, service/data versions]

## 2. Enduring program and executable epoch lifecycle

- **Enduring project mission:** [meta-program goal that remains active through research, design, implementation, evaluator/harness, prerequisite, and evidence work]
- **Lifecycle index/mechanism:** [immutable project path or mechanism that selects the active executable epoch]
- **Active epoch contract:** [exact contract ID, commit/digest, or `none`]
- **Epoch/family boundaries:** [bounded mechanism families, evidence epochs, budgets, and their return-to-mission actions]
- **No active epoch behavior:** model and evidence launches **fail closed**; meta-research, design, implementation, prerequisite, evaluator, and harness work remains allowed

Every executable epoch contract is separate from this enduring `program.md` and is selected by the lifecycle mechanism above. Its immutable identities must include comparator/champion, checkpoint, tokenizer/preprocessing, case set, evaluator, environment, budget, artifact namespace, and gates.

Safe autonomous successor activation requires all of the following:

- comparator, checkpoint, tokenizer, case-set, evaluator, environment, budget, artifact, and gate identities are concrete and immutable
- prerequisite and harness tests pass
- no placeholders remain
- inactive model/evidence launch behavior fails closed
- the lifecycle update is committed atomically
- prior evidence is untouched
- [human approval is obtained only where this project's approval policy requires it]

Closing a family or epoch returns to the mission. It does not park a lane or stop the fleet. The next move may be a legal architecture pivot, prerequisite implementation, evaluator/harness construction, successor epoch design or activation, or another project-level move.

## 3. Claims and terminal outcomes

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

- `accepted`: [every applicable program gate passes and the commit delivers a validated Pareto/model frontier advance or validated search-capability advance that makes a previously impossible legal campaign executable, such as a tested representation primitive, direct runtime kernel, evaluator, harness, prerequisite, or safely activated successor epoch]
- `rejected`: [tested failure while useful legal project-level moves remain]
- `inconclusive`: [valid evidence or audit/design work is insufficient and does not deliver a validated capability; merely drafting docs, changing Git, or closing an epoch is not accepted]
- `external-blocked`: [specific unavailable prerequisite, input, access, environment, or human decision after every useful legal workaround; never global exhaustion]
- `exhausted`: [no useful legal project-level move remains across model, representation, architecture, runtime, evaluation, permitted data, tooling/prerequisites, and safe successor epochs, or continuation is permanently impossible under external constraints with no legal workaround; only this outcome may park the fleet]

Family, campaign-budget, and evidence-epoch exhaustion are bounded closures, not `exhausted`: [required project-level pivot, prerequisite, evaluator/harness, or successor-epoch action].

Crash/timeout/malformed-result semantics: [PROJECT-SPECIFIC, fail closed; map invalid evidence to rejected or inconclusive, or a specific unavailable prerequisite to external-blocked rather than inventing another fleet outcome]

## 4. Executable command contract

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

## 5. Campaign stages and evidence gates

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

- Entry gate: [active immutable epoch, candidate, champion, plan, environment, scientific budget, and validity prerequisites checked]
- If no epoch is active: model and evidence launch fails closed; continue meta-research or prerequisite work
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

## 6. Benchmark/test protocol

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

## 7. Resource limits and concurrency

| Resource | Campaign cap | Per-command cap | Concurrent cap |
|---|---:|---:|---:|
| Wall time | [value] | [value] | [value] |
| CPU/processes | [value] | [value] | [value] |
| Memory/disk | [value] | [value] | [value] |
| Accelerators/devices | [value] | [value] | [value] |
| External requests/tokens/cost | [value] | [value] | [value] |
| Evidence attempts | [value] | 1 attempt | n/a |
| Scarce scientific operations | [value] | [value] | [project-enforced value if required] |

- Extension worker load: chosen only by `/autoresearch N` within its 1-8 bound; do not declare another worker cap here
- Maximum hypotheses/candidates/evidence attempts: [scientifically justified values]
- Retry/backoff policy: [PROJECT-SPECIFIC]
- Cancellation/cleanup command: `[COMMAND]`
- Permitted execution window: [PROJECT-SPECIFIC]

## 8. Autonomous researchers and checkpoints

Each worker independently chooses a useful bounded campaign or project-level move within the enduring mission, records a non-exclusive intent, completes it through a scientific terminal outcome, writes a terminal checkpoint, and exits. While `/autoresearch N` remains active, the extension replaces exited workers. Family and epoch limits return the next worker to the mission; they do not park a lane. There is no dispatcher, exclusive assignment, lock, lease, approval/admission step, fencing token, or capacity-reservation protocol. Overlap is allowed; use observed intents and findings to reduce waste without treating them as authority.

Checkpoints are only for observability and crash recovery. Record one after material findings, before long or external work, and at terminal transitions. A continuation command or launch receipt describes recoverable process state and grants no ownership or permission. Model and evidence commands must fail closed when no active epoch is selected, while meta-research continues.

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

## 9. Project-enforced scientific and process limits

`/autoresearch N` is the extension operational load limit and accepts 1 through 8 workers. Project-level limits remain valid when they protect scientific validity, cost, scarce resources, or process safety. Define how project commands enforce [evidence-attempt cap, device/API concurrency, cost/rate limit, timeout, cleanup, or other applicable rule]. These controls evaluate the operation itself, not worker identity, ownership, generation, or admission.

Enforcement and recovery command/code path: `[PROJECT-SPECIFIC]`

## 10. Git, worktree, synchronization, and integration

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

## 11. Artifacts, plans, and receipts

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

## 12. Knowledge promotion and synchronization

Promote only reusable findings, useful failures, corrections, procedures, and decision rationale. Record baseline, intervention, effect, conditions, and tradeoffs for optimization claims.

- Project knowledge destination: [docs/note/path]
- Operational-only destination: [checkpoint/artifact]
- Promotion owner and gate: [PROJECT-SPECIFIC]
- Cross-worker observation point: [checkpoint/human review]
- Contradiction/conflict handling: [PROJECT-SPECIFIC]

Do not promote raw transcripts, secrets, routine activity, or unverified speculation as fact.

## 13. Stop conditions

Stop the bounded campaign or executable epoch segment when:

- [its declared campaign, family, or epoch bound is reached]
- [a required decision or access is unavailable, with a specific workaround or external-blocked record]
- [a campaign budget threshold is reached]
- [benchmark validity cannot be restored within this epoch]
- [candidate identity or external process cannot be reconciled]
- [unsafe condition]

A bounded family, campaign, or epoch stop returns to the enduring project mission. It must trigger or select the next legal move, such as an architecture pivot, prerequisite implementation, evaluator/harness construction, successor epoch design or activation, or another mission-level campaign. It must never by itself park a lane or stop the fleet.

Stop or park the fleet only when:

- no useful legal project-level move remains across model, representation, architecture, runtime, evaluation, data permitted by the mission, tooling/prerequisites, and safe successor epochs
- continuation is permanently impossible under external constraints and no legal workaround exists
- the user stops or parks the project

At any stop, cancel or reconcile external jobs, write terminal receipts, checkpoint the scientific terminal status, preserve immutable artifacts, leave worktrees in the declared clean/committed state, and exit. The extension may then start a replacement researcher unless genuine project-level exhaustion or user stop applies.

## 14. Launch review

- [ ] The program's declared approval policy is satisfied; human approval was obtained for every reserved consequential boundary.
- [ ] No launch-blocking `DECISION REQUIRED` remains.
- [ ] Commands and timeouts were verified or clearly block launch.
- [ ] Benchmark self-tests/calibration passed where applicable.
- [ ] Canonical `program.md` is a regular, nonsymlink, non-empty file.
- [ ] Canonical checkout is clean and validated program changes are committed.
- [ ] `/autoresearch N` stays within the extension's 1-8 worker bound; any scientific/resource concurrency limit is project-enforced and justified.
- [ ] `program.md` remains the enduring meta-program and immutable executable epoch contracts are selected separately.
- [ ] No active epoch fails closed for model/evidence launches while meta-research continues.
- [ ] Workers complete one bounded campaign, checkpoint a terminal outcome, and exit for the next project-level move.
- [ ] Family or epoch exhaustion cannot park a lane by itself.
- [ ] Checkpoints and intents are informational and cannot be mistaken for ownership or authorization.
- [ ] Artifact, receipt, reconciliation, and stop procedures are executable.
