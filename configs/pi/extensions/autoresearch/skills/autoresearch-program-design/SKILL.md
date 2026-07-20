---
name: autoresearch-program-design
description: Design or review a project-specific autoresearch program, program.md, benchmark, test/evidence protocol, or autoresearch setup. Use when a project lacks program.md, when creating or revising program.md, when defining scientific claims and terminal outcomes, when designing executable benchmarks or evidence gates, or when reviewing budgets, autonomous worker operation, checkpoints, Git/worktree boundaries, artifacts, and stop conditions.
---

# Autoresearch Program Design

Build a reviewable research contract with the human. Do not blindly generate `program.md`, infer preferences that materially affect cost or risk, or launch autoresearch workers as part of setup.

Use progressive disclosure:

- Start with this workflow and inspect the project.
- Open [the program template](assets/program-template.md) when drafting the actual file.
- Read [benchmark design](references/benchmark-design.md) when the program needs a new benchmark, statistical evidence, noisy measurements, holdouts, or anti-gaming controls.
- Copy [the benchmark contract template](assets/benchmark-contract-template.md) when a reusable executable benchmark interface is useful.

## Outcome

Produce a `program.md` that a human can review and commit. It must distinguish settled facts, proposed defaults, and unresolved project-specific decisions. A program is ready only when its commands are executable, claims are falsifiable, evidence gates are explicit, resources are bounded, worker integration is safe, and terminal outcomes are unambiguous.

Do not launch `/autoresearch N` until the human has reviewed the program and the canonical checkout satisfies the extension's clean-checkout requirement.

## Collaborative workflow

### 1. Inspect before asking or drafting

Read the repository's instructions and orientation files. Inspect only enough implementation and history to understand the real work surface:

- language, build system, package manager, runtime, supported platforms, and dependency policy
- existing tests, benchmarks, linters, profilers, CI workflows, release checks, and generated-file rules
- current architecture and likely intervention boundaries
- baseline commands and their actual runtime, determinism, output, and failure behavior
- available datasets, fixtures, logs, production traces, simulators, or external evaluators
- Git status, repository root, submodules, large artifacts, ignored paths, and worktree compatibility
- compute, network, credentials, services, devices, rate limits, paid APIs, and safety constraints
- prior experiments, known failures, accepted tradeoffs, and where reusable knowledge belongs

Run cheap read-only discovery first. Do not run expensive benchmarks, modify the project, create worktrees, launch workers, or provision external resources merely to design the program. If a small command is needed to verify an assumption, explain it and keep the result as design evidence.

Summarize what was observed, what remains unknown, and which unknowns change the design. Ask focused questions instead of making the human restate facts already present in the project.

### 2. Clarify the goal and authority

Collaboratively establish:

- the user-visible or scientific goal, and why it matters
- in-scope components and explicitly excluded changes
- who may approve cost, external access, dependency changes, migrations, or integration
- quality attributes that must not regress
- whether the campaign seeks optimization, explanation, diagnosis, discovery, validation, or a combination
- acceptable risk and reversibility
- the decision the final evidence must support

Separate a desired direction, such as "faster," from a claim that can be tested. Record unresolved choices as `DECISION REQUIRED`, with options and consequences. Do not conceal ambiguity behind a plausible default.

### 3. Define claims and terminal outcomes

For every central claim, specify:

1. **Intervention**: what class of change is allowed.
2. **Population and conditions**: workloads, versions, environments, and inputs to which the claim applies.
3. **Comparator**: the immutable champion or baseline identity.
4. **Measure**: observable metric, unit, aggregation, and direction.
5. **Validity constraints**: correctness, compatibility, safety, and resource gates.
6. **Decision rule**: minimum meaningful effect and uncertainty or deterministic threshold.
7. **Evidence stage**: which command and cases can support the claim.
8. **Scope limit**: what the result does not establish.

Name terminal outcomes in advance. Typical outcomes are:

- **accepted**: candidate passes all validity gates and the predeclared promotion rule
- **rejected**: valid evidence does not beat the champion or violates a gate
- **inconclusive**: evidence is valid but insufficient to decide within budget
- **external-blocked**: required input, access, environment, or human decision is unavailable after every useful legal action was tried
- **exhausted**: campaign budget or hypothesis space is consumed without acceptance

Unsafe, invalid, crashed, missing, or malformed evidence is not itself a sixth fleet outcome. Define whether it makes the campaign `rejected`, `inconclusive`, or `exhausted`, or whether a genuinely unavailable external prerequisite makes it `external-blocked`.

A timeout, crash, missing result, malformed result, benchmark drift, or leaked holdout is not silently converted into a poor score. Define whether it invalidates a replicate, rejects a candidate, or stops the campaign.

### 4. Choose campaign stages

Use the cheapest stage capable of rejecting a bad hypothesis, then escalate only survivors. A common sequence is:

1. **Orientation and calibration**: verify commands, benchmark self-tests, baseline variance, and artifact paths.
2. **Development loop**: rapid deterministic tests and visible development cases.
3. **Screening**: broader cases or short replicated measurements.
4. **Evidence**: predeclared paired or randomized evaluation, sealed holdouts, or scarce external runs.
5. **Integration verification**: apply the selected candidate to the canonical integration boundary and rerun required gates.
6. **Knowledge promotion and closure**: preserve reusable findings, receipts, and terminal rationale.

Not every project needs every stage. Ordinary deterministic tests are sufficient when the claim is exact, the oracle is reliable, the environment is controlled, and pass/fail directly represents the desired behavior. Do not invent a weighted benchmark when a deterministic test suite is the stronger contract.

For each stage define entry gate, command, inputs, maximum attempts, resource class, outputs, validity checks, promotion rule, and exit status.

### 5. Set budgets and concurrency

Budget the campaign, not just one command:

- wall-clock deadline and per-command timeout
- maximum hypotheses, candidates, runs, retries, and evidence attempts
- CPU, memory, accelerator, disk, and process limits
- external requests, tokens, dollars, devices, rate limits, and permitted hours
- maximum concurrent scarce scientific operations when the project itself enforces that limit
- retry policy, backoff, cancellation, and cleanup

`/autoresearch N` is the only extension operational load limit: `N` sets the number of simultaneously running researchers. Do not add an arbitrary worker cap to `program.md`, especially not a default cap of four. Project-level scientific budgets and validity rules remain legitimate, including limits on hypotheses, evidence attempts, external cost, devices, or concurrent measurements. Enforce those limits in project commands or infrastructure when correctness or safety depends on them. Account for correlated noise, shared caches, thermal effects, service quotas, database contention, and integration bandwidth. More workers do not create more independent evidence.

### 6. Design shared and private memory

Workers need bounded shared observations, not each other's transcripts. Shared state does not dispatch tasks or grant exclusive ownership.

Shared memory should contain only durable findings and current observations, such as:

- campaign and hypothesis identifiers
- non-exclusive intent, current stage, and status
- concise findings, blockers, and next actions
- champion and candidate commit identities
- run and artifact identifiers
- continuation command and launch receipt for crash recovery

Private memory may contain scratch analysis, verbose logs, failed local drafts, and worker transcript context. Promote a private observation only when another worker or future campaign can act on it. Include provenance and confidence when trust depends on environment or data.

Define a checkpoint schema in `program.md`. At minimum include campaign, hypothesis, stage, status, summary, findings, blockers, next actions, run IDs, non-exclusive intent, candidate commit, champion commit, continuation command, and launch receipt when applicable. Checkpoints exist only for observability and crash recovery. They are not claims, locks, leases, task assignments, admission records, or authorization to proceed. Checkpoint after material findings, before long or external work, and at every terminal transition.

### 7. Define Git, worktree, and integration boundaries

State explicitly:

- canonical repository root and reviewed starting commit
- files and subsystems workers may change
- generated, ignored, secret, or external artifacts that must not be committed
- one branch and isolated reusable worktree per worker
- whether commits are required before checkpoints or evidence
- how candidate identity is recorded and how dirty trees are treated
- who may sync, cherry-pick, merge, rebase, resolve conflicts, or modify the canonical checkout
- how stale lanes and saved candidate refs are reconciled
- integration ordering and post-integration verification

The extension never changes an active lane. After a worker records a terminal campaign and exits, the supervisor stops its process, preserves the exact terminal commit under a create-only ref, serially merges that terminal branch into the clean canonical branch without rewriting worker commits, resets only the completed lane to the resulting canonical head, and then launches its replacement. Other active lanes converge only after their own campaigns finish. A conflict, dirty or externally changed canonical checkout, ref mismatch, or failed cleanup blocks the affected lane with its terminal ref preserved; the extension does not guess at conflict resolution or modify another active lane. This terminal integration is not scientific evidence or acceptance, so the program must still define post-integration verification and who resolves a blocked merge.

### 8. Define disposable autonomous researcher operation

Each worker is an autonomous researcher, not a task consumer. It observes the program, repository, and shared checkpoints; chooses a useful campaign within the reviewed scope; records a non-exclusive intent; and executes one full campaign from orientation through a scientific terminal outcome. It then writes a terminal checkpoint, leaves recoverable artifacts and Git state, and exits. The extension replaces exited workers while `/autoresearch N` remains active.

There is no task dispatcher, claim protocol, lock, lease, approval or admission step, fencing token, evidence-capacity reservation, or compaction-driven handoff. Intents are informational and may overlap. A worker should use observed intents and findings to avoid waste, but must tolerate duplicate work and independently verify evidence it relies on.

Checkpoints support observability and crash recovery only. On restart, a worker may continue a recoverable campaign or begin another useful campaign based on the durable state. A continuation command or launch receipt describes process state but does not confer ownership. Project commands remain responsible for scientific budgets, benchmark validity, cost controls, scarce-resource safety, process cleanup, and immutable evidence artifacts.

### 9. Review, then write

Before creating `program.md`, present a compact design review:

- observed project facts
- proposed claim and terminal outcomes
- proposed stages and commands
- benchmark/evidence design
- budgets and concurrency
- memory, Git, artifact, and integration boundaries
- unresolved `DECISION REQUIRED` items

Ask the human to resolve material decisions. Draft from [the program template](assets/program-template.md), replacing or deleting every instructional placeholder. Mark unverified commands as proposals and do not describe them as executable until checked. Keep the resulting program operational and concise enough for each autonomous researcher to reread at campaign start or after crash recovery.

After drafting, review it against this checklist:

- every claim has a comparator, measure, validity gate, decision rule, and scope
- every stage has an executable entrypoint and machine-observable outcome
- champion and candidate identities cannot be confused
- budgets, timeouts, crashes, invalid evidence, and stop conditions are explicit
- evidence artifacts and plans are immutable and attributable
- shared checkpoints are bounded, informational, and sufficient for observability and crash recovery
- `/autoresearch N` is the only extension worker-load setting, while project commands enforce legitimate scientific and resource limits
- each worker completes one campaign, records a terminal outcome, and exits for replacement
- Git/worktree synchronization cannot be mistaken for integration or evidence
- knowledge promotion and terminal receipts have destinations
- all project-specific decisions are resolved or visibly block launch

## Benchmark and test design

Prefer the simplest executable contract with adequate construct validity. Read [benchmark design](references/benchmark-design.md) before defining a custom evaluator or noisy evidence stage, and use [the benchmark contract template](assets/benchmark-contract-template.md) when the interface should be reusable.

A benchmark contract must define one command that receives explicit champion, candidate, plan, case-set, seed, budget, and output locations. Champion and candidate are immutable identities, normally commit plus tree or artifact digest, never ambiguous labels such as "current." Development cases are visible and support iteration. Sealed holdout cases are access-controlled, versioned, and used only under the declared evidence policy. A holdout that has influenced candidate selection is no longer sealed.

Establish construct validity: explain why each measure and case population represents the real claim, identify likely confounders, and keep correctness/safety gates separate from optimization score. Deterministically isolate build outputs, working directories, caches, environment variables, service state, ports, datasets, and cleanup. Where measurements are noisy, use paired or randomized order, enough independent replications, predeclared exclusions, and uncertainty-aware decision rules. Where outcomes are deterministic, exact ordinary tests are usually better than statistical machinery.

Require machine-readable results with schema and version, champion/candidate identities, plan and case-set digests, environment fingerprint, per-case/per-replicate observations, validity status, score components, uncertainty, resource use, timestamps, and artifact paths. A top-level score is usable only when all mandatory validity gates pass. Define timeout, signal, crash, partial output, and malformed output semantics explicitly and fail closed.

Prevent gaming by separating evaluator code and sealed data from candidate-controlled paths, checking output provenance, limiting undeclared network or filesystem access, preserving per-case results, and forbidding candidate-specific benchmark changes during an evidence epoch. Freeze immutable predeclared plans and artifacts before evidence. Self-test the harness with known-good, known-bad, identity, corruption, timeout, and determinism checks; calibrate variance and sensitivity before trusting rankings.

Any benchmark, dataset, environment, dependency, scoring rule, or validity-rule change creates a new version or evidence epoch. Results from different epochs are not pooled or compared without an explicit bridge study. Put calibration and development runs in a different artifact namespace from sealed evidence.
