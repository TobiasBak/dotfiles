# Benchmark contract: [PROJECT-SPECIFIC NAME]

> Contract version: `[ID]`
>
> Evidence epoch: `[ID]`
>
> Status: **DECISION REQUIRED / draft / validated**

## Decision and construct

- Claim supported: [falsifiable claim]
- Target population/conditions: [cases and environment]
- Primary construct: [quality/performance/reliability/etc.]
- Why this instrument represents it: [construct-validity rationale]
- Known threats/proxies: [limitations]
- Minimum meaningful effect: [value and unit]
- Conditions not established: [scope limits]
- Why ordinary deterministic tests are insufficient, or tests used instead: [rationale]

## Entrypoint

```text
[EXACT COMMAND AND REQUIRED FLAGS]
```

Required inputs:

| Input | Format | Validation |
|---|---|---|
|---|---|---|
| mode | `self-test|calibrate|development|screening|evidence` | [rule] |
| champion | [commit/tree/artifact digest] | immutable, exists, echoed from loaded artifact |
| candidate | [commit/tree/artifact digest] | immutable, exists, echoed from loaded artifact |
| plan | [path + sha256] | read-only and digest matches |
| case set | [ID/version + sha256] | authorized for mode |
| seed schedule | [format] | [rule] |
| replication/order | [format] | [rule] |
| budget/timeout | [format] | within predeclared cap |
| output | unique run directory/result path | absent before run, atomic final write |

Exit codes:

- `0`: a complete schema-valid result was written; scientific decision is in the result
- `[CODE]`: invalid command/identity/plan
- `[CODE]`: benchmark infrastructure failure
- `[CODE]`: timeout/resource enforcement failure
- `[CODE]`: scientific budget or project resource limit exceeded

Candidate rejection is [a valid result / an exit code, with rationale].

## Identities and versions

- Champion identity fields: [PROJECT-SPECIFIC]
- Candidate identity fields: [PROJECT-SPECIFIC]
- Evaluator identity: [commit/digest]
- Toolchain/dependency identity: [lockfile/image/digest]
- Dataset/case identity: [version/digest]
- Environment eligibility/fingerprint: [schema]
- Epoch change triggers: [list]
- Cross-epoch bridge policy: [none or predeclared study]

## Cases and holdout policy

Development cases:

- ID/version/digest: [values]
- Visibility and location: [values]
- Intended coverage: [values]

Sealed evidence cases, if any:

- ID/version/digest: [values]
- Custodian/access path: [values]
- Maximum evidence attempts: [N]
- Information returned: [aggregate/per-case/redacted]
- Contamination response: [new case set/epoch]
- Retention/redaction: [rules]

## Isolation

- Champion build/run location: [path/container]
- Candidate build/run location: [path/container]
- Writable output boundary: [path]
- Cache/warmup policy: [cold/warm/both]
- Service/database reset: [procedure]
- CPU/device/process controls: [procedure]
- Environment/locale/timezone: [procedure]
- Seed/randomness: [procedure]
- Network/filesystem restrictions: [procedure]
- Cleanup on success/crash/timeout/cancel: [procedure]

## Experimental plan

- Comparison unit: [case/request/workload]
- Pairing/blocking: [rule]
- Champion/candidate order: [randomized/counterbalanced rule]
- Seed schedule: [immutable plan field]
- Warmups: [N and exclusion]
- Independent replications: [N]
- Sample-size/sequential stopping rule: [predeclared]
- Fault-based exclusions: [predeclared observable rules]
- Estimator/interval: [method]
- Multiplicity/tie handling: [rule]

## Validity and scoring

Mandatory gates, evaluated before score:

1. [correctness invariant]
2. [safety/compatibility invariant]
3. [identity/digest/environment integrity]
4. [case/replicate completeness]
5. [resource/contract integrity]

Primary score:

- formula: [exact formula]
- unit/direction: [higher/lower]
- components: [list]
- missing/nonfinite handling: [reject]
- recomputation procedure: [command/code]

Decision rule:

```text
accept iff [all validity gates] and [minimum effect + uncertainty/deterministic rule]
reject iff [predeclared rule]
inconclusive iff [predeclared rule]
invalid iff [integrity rule]
```

## Machine-readable result

Final result path: `[RUN-DIR]/result.json`

Required schema fields:

```json
{
  "schema_version": 1,
  "contract_version": "[ID]",
  "evidence_epoch": "[ID]",
  "run_id": "[ID]",
  "mode": "[MODE]",
  "status": "valid|invalid|cancelled",
  "decision": "accept|reject|inconclusive|invalid",
  "champion": {},
  "candidate": {},
  "plan": { "sha256": "[DIGEST]" },
  "case_set": { "id": "[ID]", "version": "[VERSION]", "sha256": "[DIGEST]", "sealed": false },
  "environment": { "fingerprint_sha256": "[DIGEST]", "eligible": true },
  "observations": [],
  "score": { "primary": 0, "unit": "[UNIT]", "direction": "higher|lower", "components": {} },
  "uncertainty": {},
  "validity": { "passed": false, "gates": [], "violations": [] },
  "resources": {},
  "artifacts": [],
  "started_at": "[RFC3339]",
  "finished_at": "[RFC3339]"
}
```

Atomic-write and schema validation procedure: [PROJECT-SPECIFIC]

## Budgets and failures

- Per-case timeout: [value]
- Whole-run timeout: [value]
- CPU/process/memory/disk/device caps: [values]
- External calls/tokens/cost cap: [values]
- Retry cap and symmetric retry rule: [values]
- Output/log cap: [values]

| Event | Required status/decision/receipt |
|---|---|
| Candidate valid but worse | [valid/reject] |
| Candidate crash | [PROJECT-SPECIFIC] |
| Evaluator crash | invalid, no comparison |
| Timeout | [candidate reject or invalid, cause attribution defined] |
| External outage | [blocked/invalid unless part of construct] |
| Missing/malformed result | invalid |
| Cancellation | cancelled, terminal receipt |
| Resource cap | [PROJECT-SPECIFIC] |

## Anti-gaming boundary

Candidate-controlled paths/capabilities: [list]

Evaluator-controlled paths/capabilities: [list]

Controls: [read-only inputs, no undeclared network, provenance checks, summary recomputation, holdout boundary, case generation, invariants]

## Immutable plan, artifacts, and receipts

Predeclared plan path/digest: [values]

Run artifact namespace: [path]

Launch receipt fields: [run ID, champion, candidate, plan/cases/evaluator digests, environment, job/PID, timestamp]

Terminal receipt fields: [terminal status, exit/signal/timeout, result/artifact digests, external-job state, finish timestamp]

Overwrite policy: never overwrite evidence artifacts. Amendments create [new plan/version/epoch rule].

## Scientific budget and resource enforcement

Evidence entrypoint enforcement source/path: [PROJECT-SPECIFIC]

Immediately before work and while it runs, enforce applicable project-level limits such as evidence-attempt count, external cost/rate, device concurrency, process count, and timeout. These are scientific or resource controls, not worker admission, ownership, or authorization. Reject mismatched plan/champion/candidate identity independently of those limits.

Detached-job labeling, cleanup, and crash reconciliation: [PROJECT-SPECIFIC]

## Self-tests and calibration

| Test | Command | Expected result |
|---|---|---|
| Champion equals candidate | `[COMMAND]` | no material difference |
| Known good | `[COMMAND]` | valid/pass |
| Known bad | `[COMMAND]` | valid/reject or gate failure |
| Corrupt/missing result | `[COMMAND]` | invalid/rejected by parser |
| Identity/digest mismatch | `[COMMAND]` | fail closed |
| Timeout/crash/cancel | `[COMMAND]` | correct cleanup and receipt |
| Duplicate/missing cases | `[COMMAND]` | invalid |
| Fixed-state rerun | `[COMMAND]` | deterministic within declared tolerance |
| Seed/order replay | `[COMMAND]` | same schedule |
| Scientific/resource limit enforcement | `[COMMAND]` | applicable limits fail closed |
| Score recomputation | `[COMMAND]` | exact match |
| Holdout boundary | `[COMMAND]` | no unauthorized access |

Calibration acceptance: [variance, sensitivity, runtime, resource thresholds]

## Review approval

- [ ] Construct and case population represent the claim.
- [ ] Deterministic tests are used wherever they are stronger.
- [ ] Identities and plans cannot drift.
- [ ] Holdout and anti-gaming boundaries are enforceable.
- [ ] Isolation, pairing/randomization, replication, and stopping are predeclared.
- [ ] Results are machine-readable and independently validatable.
- [ ] Budgets and all failure semantics are enforced.
- [ ] Self-tests and calibration pass.
- [ ] Evidence epoch/version policy prevents invalid comparison.
- [ ] Scientific budgets and project resource limits are enforced independently of worker identity.
- [ ] Human reviewer: [NAME/DATE/DECISION]
