# Benchmark and evidence protocol design

Use this reference when a project needs a custom benchmark, noisy performance measurement, model/evaluator scoring, holdouts, scarce external evidence, or a reusable benchmark interface. If a deterministic test with a trustworthy oracle directly answers the claim, use that test instead.

## 1. Begin with the decision and construct

A benchmark is an instrument for a decision, not a source of numbers. Write the intended claim before choosing metrics:

- intervention and comparator
- target population, workloads, and environment
- desired property and unacceptable regressions
- minimum effect that would change the decision
- evidence strength required for promotion
- conditions outside the claim

**Construct validity** asks whether the instrument measures the property named in the claim. Document why cases, metric, aggregation, and environment represent real use. List threats such as proxy metrics, unrepresentative case mix, warm-cache bias, simulator mismatch, evaluator preference, survivorship bias, or a correctness/performance trade. Validate against an external criterion when practical.

Keep mandatory correctness, safety, compatibility, and data-integrity gates separate from the optimization score. A fast wrong result is invalid, not merely low quality. Avoid a weighted score that allows speed to compensate for correctness unless that trade is the explicit reviewed construct.

## 2. Decide whether a benchmark is needed

Ordinary deterministic tests are sufficient when:

- expected output or invariant is exact and stable
- the oracle is reliable
- one controlled execution is representative
- the decision is pass/fail rather than comparative optimization
- environment noise cannot materially change the outcome
- cases adequately represent the claimed scope

Examples include parser conformance, migration idempotence, protocol compatibility, type checking, security invariants, exact algorithms, and regression fixtures.

Use replicated benchmark evidence when outcomes vary due to scheduling, hardware, network, randomized algorithms, external evaluators, sampling, or naturally variable workloads. Use property/metamorphic tests when exact outputs are unavailable but stable relations are known. Use a sealed holdout only when adaptive development on visible cases creates meaningful overfitting risk.

## 3. Reusable executable benchmark contract

Provide one stable entrypoint. Avoid undocumented sequences of shell commands. The entrypoint should accept or resolve:

- benchmark contract/schema version and evidence epoch
- operation: self-test, calibrate, development, screening, or evidence
- immutable champion identity
- immutable candidate identity
- predeclared plan path and digest
- case-set ID/version and digest
- seed or seed schedule
- replication count and ordering policy
- resource budget and timeout
- isolated work/output directory
- final machine-readable result path

A command might look like:

```bash
./tools/evidence \
  --mode evidence \
  --epoch "$EPOCH" \
  --champion "$CHAMPION_COMMIT" \
  --candidate "$CANDIDATE_COMMIT" \
  --plan "$PLAN" \
  --plan-sha256 "$PLAN_SHA256" \
  --case-set "$CASE_SET" \
  --seed "$SEED" \
  --output "$RUN_DIR/result.json"
```

The process exit code and result file have distinct roles. Use nonzero exit for harness/infrastructure/contract failure. Represent a valid scientific loss as a valid result with decision `reject`, not as a process crash. Write the final result atomically only after validation. Partial logs may exist, but a partial final result must not be accepted.

Use [the benchmark contract template](../assets/benchmark-contract-template.md) to define the project interface.

## 4. Champion and candidate identity

Names such as `main`, `HEAD`, `baseline`, directory paths, or mutable tags are insufficient. Record identities that cannot drift during a run:

- full commit ID and tree ID
- patch/diff digest if dirty candidates are deliberately allowed
- built artifact/image digest
- dependency lockfile and toolchain identity
- benchmark/evaluator commit or digest
- configuration and dataset digests

Prefer committed, clean candidates for evidence. Build champion and candidate into separate immutable output directories. The result must echo identities from the actual loaded artifacts, not only requested CLI values. Reject identity mismatches.

The champion changes only through a declared promotion event. Preserve the old champion result and rationale. If candidates are compared against different champions, record that grouping and do not rank them as one homogeneous experiment without a bridge.

## 5. Development and sealed holdout cases

### Development cases

Visible development cases support debugging, profiling, hypothesis selection, and fast regression checks. They may be run repeatedly. Record their version so results remain attributable, but do not describe repeated development performance as independent confirmation.

### Sealed holdouts

A sealed holdout tests generalization after adaptive development. Define:

- custodian and access mechanism
- case-set ID, digest, and population rationale
- maximum peeks/evidence attempts
- whether only aggregate results are returned
- artifact redaction and retention
- contamination/leak response
- refresh policy

Candidate code and workers should not read holdout inputs, labels, evaluator internals, or per-case diagnostics beyond the declared interface. If holdout information influences candidate design or selection, mark it contaminated and create a new epoch/case set. Repeatedly selecting on the same holdout turns it into development data.

Keep development, calibration, screening, and holdout artifacts in separate namespaces.

## 6. Deterministic isolation

A benchmark should control or fingerprint all relevant state:

- source and dependency identities
- build output directories
- working directory and writable filesystem
- environment variables, locale, timezone, and clock behavior
- CPU affinity/governor, accelerator, memory, process count, and thermal state where relevant
- random seeds and random library versions
- caches, warmup, compilation, and data prefetch
- services, databases, queues, ports, and credentials
- network access and external endpoint versions
- input snapshots and fixture copies
- cleanup after success, crash, timeout, and cancellation

Champion and candidate must not contaminate each other's state. Use separate processes or containers when in-process reset is not demonstrably complete. Random seeds do not make uncontrolled external services deterministic. Record an environment fingerprint and reject runs outside the plan's eligibility rule.

Decide whether cold-start, warm steady-state, or both represent the construct. Do not accidentally time build/setup in one arm but not the other.

## 7. Pairing, randomization, and replication

For noisy comparative measurements, prefer paired observations on the same case and nearby time window. Randomize or counterbalance champion/candidate order to reduce drift and warmup bias. Examples:

- random AB/BA order per case/replicate
- blocked randomization by machine, case family, or time window
- interleaving when resource interference is controlled

Predeclare:

- randomization unit and seed schedule
- independent replication unit
- warmup runs excluded from analysis
- sample size or sequential stopping rule
- outlier/exclusion rules based on observable faults, not desired score
- estimator, interval, and multiplicity handling

Repeating a deterministic value in one unchanged process does not create independent evidence. Conversely, do not add arbitrary replication where exact deterministic tests already settle the claim.

For skewed latency, report robust summaries and tail behavior appropriate to the user impact. For throughput, specify saturation and load generation. For model/evaluator outcomes, account for evaluator variance and order effects. Preserve raw per-case/per-replicate observations.

## 8. Machine-readable results, scoring, and validity

Version the result schema. A final result should include:

```json
{
  "schema_version": 1,
  "contract_version": "project-bench-v1",
  "evidence_epoch": "epoch-001",
  "run_id": "...",
  "mode": "evidence",
  "status": "valid",
  "decision": "accept|reject|inconclusive|invalid",
  "champion": { "commit": "...", "tree": "...", "artifact_sha256": "..." },
  "candidate": { "commit": "...", "tree": "...", "artifact_sha256": "..." },
  "plan": { "path": "...", "sha256": "..." },
  "case_set": { "id": "...", "version": "...", "sha256": "...", "sealed": true },
  "environment": { "fingerprint_sha256": "...", "eligible": true },
  "observations": [],
  "score": { "primary": 0, "unit": "...", "direction": "higher|lower", "components": {} },
  "uncertainty": { "method": "...", "interval": [] },
  "validity": { "passed": true, "gates": [], "violations": [] },
  "resources": { "wall_ms": 0, "cpu_ms": 0, "peak_memory_bytes": 0, "external_cost": 0 },
  "artifacts": [],
  "started_at": "...",
  "finished_at": "..."
}
```

Use integers or explicitly defined decimal/string representations where floating-point serialization could affect reproducibility. State missing-value behavior. The scorer must reject duplicate/missing cases, nonfinite numbers, identity mismatch, digest mismatch, ineligible environments, and incomplete replications.

A primary score is meaningful only when mandatory validity gates pass. Report score components so regressions cannot hide behind aggregation. Predeclare tie handling, minimum practical effect, confidence/credible interval or deterministic threshold, and whether `inconclusive` is possible.

## 9. Budgets, timeouts, and crash semantics

Enforce limits in the harness or outer process, not only in prose:

- per-case and whole-run wall time
- CPU/process/memory/disk/device quotas
- maximum external calls/tokens/cost
- maximum retries and evidence attempts
- output/log size

Define each failure class:

| Event | Process/result meaning |
|---|---|
| Candidate returns a valid but poor answer | Valid observation or gate failure, according to claim |
| Candidate process crash | Usually candidate invalid/reject for that case; predeclare threshold |
| Harness/evaluator crash | Infrastructure-invalid run, no comparison |
| Whole-run timeout | Predeclared candidate reject or invalid run, depending on attributed cause |
| External service unavailable | Infrastructure-invalid/blocked unless service reliability is the construct |
| Missing/malformed result | Invalid run, never accepted |
| User cancellation | Cancelled receipt; no scientific conclusion unless plan says partial evidence is valid |
| Resource cap exceeded | Candidate failure or invalid run according to which component exceeded it |

Do not retry only losing cases. Retries must follow a symmetric predeclared rule and remain visible. A retry does not erase the original artifact.

## 10. Anti-gaming controls

Assume optimization pressure will exploit the contract, accidentally or deliberately. Protect the construct:

- keep evaluator and sealed data outside candidate-controlled paths
- pin benchmark and scoring identities for the epoch
- use read-only inputs and isolated writable outputs
- restrict undeclared network, clocks, process inspection, and filesystem access where relevant
- verify output provenance and recompute critical summaries from raw observations
- prevent hardcoded case IDs or leaked labels
- test semantic correctness, not only expected formatting
- preserve per-case data so aggregate manipulation is detectable
- forbid candidate-specific evaluator changes during evidence
- review suspicious discontinuities and implausible resource use

Do not rely solely on hidden cases. Strong contracts combine isolation, provenance, independent recomputation, broad case generation, invariants, and holdouts.

## 11. Immutable plans and artifacts

Before evidence, write a predeclared plan containing identities, cases, exclusions, ordering, seeds, replications, budgets, score, validity gates, and decision rule. Hash it and include the digest in the process launch receipt and final result. Never edit it in place. Amendments create a new plan/version and explain why prior evidence is not being selectively reused.

Create a unique run directory before launch. Use append-only/immutable storage as practical. Preserve:

- plan and digest
- exact command and environment fingerprint
- source/build/evaluator/data identities
- launch receipt
- stdout/stderr and structured observations
- final validated result
- terminal receipt for success/failure/cancel/timeout
- checksums

Artifacts must be attributable without containing secrets. Define redaction and retention before sealed or external work.

## 12. Self-tests and calibration

The harness itself needs evidence. Include tests for:

- identity candidate equals champion, expecting no material difference
- known-good candidate
- known-bad or intentionally slowed/broken candidate
- corrupted/missing result and digest mismatch rejection
- timeout, crash, signal, cleanup, and partial-write handling
- duplicate/missing case detection
- deterministic rerun under fixed state
- randomization reproducibility from seed
- scientific budget and project resource-limit enforcement
- score recomputation from observations
- holdout access boundary

Calibration estimates baseline runtime, noise, sensitivity, ceiling/floor effects, and resource needs. Confirm that the minimum meaningful effect is detectable within budget. If not, redesign cases/metric or accept that the likely terminal outcome is inconclusive.

Self-tests must not consume sealed evidence unless explicitly designed as a custodial check that reveals no case information.

## 13. Evidence versions and epochs

Start a new evidence epoch when any result-affecting element changes:

- benchmark/evaluator implementation
- score, aggregation, validity gate, or decision rule
- case population, dataset, labels, holdout access, or preprocessing
- champion definition
- toolchain/dependency with material effect
- environment class or external service behavior
- budget/timeout that changes censoring
- anti-gaming boundary

A schema-only backward-compatible serialization change may keep the epoch if demonstrated not to affect observations or decisions. Record the justification.

Never pool or directly rank results from incompatible epochs. If comparison is needed, run a bridge study with selected champion/candidates under both protocols, predeclare how the bridge will be interpreted, and preserve both identities.

## 14. Scientific budgets and scarce-resource safety

`/autoresearch N` is the extension's only operational load limit. The benchmark must not depend on worker claims, locks, approval/admission, fencing identities, or evidence-capacity reservations.

Project-level controls remain necessary when they define scientific validity or protect scarce resources. The evidence entrypoint should fail closed when a predeclared evidence-attempt budget, external cost/rate limit, device/process concurrency limit, timeout, or immutable plan identity is violated. Enforce these controls against the operation and underlying resource, not against a worker identity or purported ownership.

Label detached jobs with run, plan, candidate, and champion identities. A crashed launcher may leave an external job active; recovery must inspect the durable launch receipt and external system before relaunching or declaring a terminal result. Preserve a structured terminal receipt for every terminal status.

## 15. Review checklist

- Does the instrument measure the claim rather than a convenient proxy?
- Are champion and candidate immutable and verified from actual artifacts?
- Are development and sealed cases distinct, versioned, and governed?
- Is isolation strong enough to prevent state leakage and confounding?
- Are pairing, order, replication, exclusions, and stopping predeclared?
- Can an independent parser validate and recompute the result?
- Are score and validity separate, with anti-gaming controls?
- Are plans, observations, artifacts, and receipts immutable and attributable?
- Do self-tests detect known good, known bad, corruption, timeout, and identity faults?
- Do version/epoch changes prevent invalid cross-protocol comparison?
- Are budgets and crash semantics enforced rather than aspirational?
- Are scientific/resource limits enforced by the project without worker ownership or admission machinery?
- Would ordinary deterministic tests answer the question more directly?
