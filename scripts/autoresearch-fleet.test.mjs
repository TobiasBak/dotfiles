import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { registerAutoresearch } from "../configs/pi/extensions/autoresearch.ts";
import { workerLanes } from "../configs/pi/extensions/autoresearch/git.ts";
import { compactWorkerContext, fleetDashboardLines } from "../configs/pi/extensions/autoresearch/presentation.ts";
import {
  AUTORESEARCH_PROTOCOL_VERSION,
  FleetStore,
  StaleWorkerError,
} from "../configs/pi/extensions/autoresearch/state.ts";
import {
  parseAutoresearchFleetCount,
  resolvePiCliPath,
} from "../configs/pi/extensions/autoresearch/supervisor.ts";
import {
  AUTORESEARCH_WORKER_TOOL,
  registerWorkerAutoresearch,
  workerIdentityFromEnv,
} from "../configs/pi/extensions/autoresearch/worker.ts";

function testSessionId(index) {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const tick = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await tick();
  }
}

function seed(workerId, base, sessionId = testSessionId(Number(workerId.slice(1)))) {
  return {
    workerId,
    sessionId,
    worktree: join(base, workerId),
    branch: `autoresearch/worker-${workerId.slice(1)}`,
    sessionsRoot: join(base, "sessions"),
  };
}

function createFleet(count = 2) {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-v3-"));
  const root = join(dir, "repo");
  const dbPath = join(dir, "fleet.sqlite");
  const parent = new FleetStore(dbPath);
  const workers = Array.from({ length: count }, (_, index) => seed(`w${index + 1}`, dir));
  const generation = parent.beginFleet({ canonicalRoot: root, workers, now: 100 });
  parent.activateFleet(root, generation, 101);
  for (const worker of workers) parent.parentUpdateWorker(root, worker.workerId, { status: "idle" }, 102, generation);
  return { dir, root, dbPath, parent, workers, generation };
}

function workerStore(fleet, index, sessionId = fleet.workers[index].sessionId) {
  return new FleetStore(fleet.dbPath, {
    canonicalRoot: fleet.root,
    workerId: fleet.workers[index].workerId,
    sessionId,
    generation: fleet.generation,
  });
}

test("shared research intents are informational, non-exclusive, and terminal findings are recorded", () => {
  const fleet = createFleet(2);
  const w1 = workerStore(fleet, 0);
  const w2 = workerStore(fleet, 1);
  try {
    const first = w1.publishIntent({
      question: "Does Sol-high restore valid refactoring runs?",
      experiment: "Three baseline runs on case 001",
      reason: "Previous lower-effort calibrations were invalid",
    }, 110);
    const second = w2.publishIntent({
      question: "Does Sol-high restore valid refactoring runs?",
      experiment: "Independent three-run replication on case 001",
      reason: "Overlap provides useful replication",
    }, 111);
    assert.ok(first.intentId > 0);
    assert.ok(second.intentId > first.intentId, "overlapping intent is accepted without a lock or admission decision");

    const checkpointId = w1.checkpoint({
      stage: "baseline",
      summary: "Two of three runs complete",
      findings: ["first two rows valid"],
      nextActions: ["wait for terminal third row"],
      continuationCommand: "scripts/wait-evidence run-1",
      launchReceipt: { pid: 42, runId: "run-1" },
    }, 120);
    assert.ok(checkpointId > 0);
    const finished = w1.finishCampaign({
      outcome: "accepted",
      summary: "Sol-high restored three valid rows",
      findings: ["3/3 rows valid"],
      runIds: ["run-1"],
      terminalHead: "terminal-head",
    }, 130);
    assert.deepEqual(finished, { intentId: first.intentId, status: "complete" });

    const snapshot = fleet.parent.snapshot(fleet.root, { recent: 20 });
    assert.equal(snapshot.intents.filter((intent) => intent.status === "active").length, 1);
    assert.equal(snapshot.fleet.completed_campaigns, 1);
    assert.equal(snapshot.intents.find((intent) => intent.id === first.intentId).outcome, "accepted");
    assert.equal(snapshot.intents.find((intent) => intent.id === first.intentId).terminal_head, "terminal-head");
    assert.equal(snapshot.intents.find((intent) => intent.id === first.intentId).integration_phase, "pending");
    assert.equal(snapshot.checkpoints[0].summary, "Two of three runs complete");
    assert.equal(snapshot.workers.find((worker) => worker.worker_id === "w1").status, "complete");
    assert.equal("admissions" in snapshot, false);
    assert.equal("reservations" in snapshot, false);
    assert.equal("evidence" in snapshot, false);
  } finally {
    w2.close();
    w1.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("terminal integration can finish an intent recovered from an earlier fleet generation", () => {
  const fleet = createFleet(1);
  const original = workerStore(fleet, 0);
  let recovered;
  try {
    const { intentId } = original.publishIntent({
      question: "Can a recovered campaign finish safely?",
      experiment: "Resume the interrupted campaign in a replacement fleet",
      reason: "Exercise cross-generation terminal integration",
      baselineHead: "baseline-head",
    }, 110);

    fleet.parent.setFleetStatus(fleet.root, "stopped", 120, fleet.generation);
    const replacement = seed("w1", fleet.dir, testSessionId(101));
    const generation = fleet.parent.beginFleet({
      canonicalRoot: fleet.root,
      canonicalBranch: "main",
      canonicalHead: "canonical-head",
      workers: [replacement],
      now: 130,
    });
    fleet.parent.activateFleet(fleet.root, generation, 131);
    fleet.parent.parentUpdateWorker(fleet.root, "w1", { status: "idle" }, 132, generation);
    recovered = new FleetStore(fleet.dbPath, {
      canonicalRoot: fleet.root,
      workerId: "w1",
      sessionId: replacement.sessionId,
      generation,
    });

    recovered.finishCampaign({ outcome: "accepted", summary: "Recovered result", terminalHead: "terminal-head" }, 140);
    fleet.parent.markIntegrationRef(fleet.root, "w1", generation, intentId, "refs/autoresearch/terminals/g2/i1", 141);
    fleet.parent.beginIntegration(fleet.root, "w1", generation, intentId, "canonical-head", 142);
    fleet.parent.completeCanonicalIntegration(fleet.root, "w1", generation, intentId, "canonical-head", "integrated-head", 143);
    fleet.parent.completeLaneReset(fleet.root, "w1", generation, intentId, 144);

    const snapshot = fleet.parent.snapshot(fleet.root, { workerId: "w1" });
    assert.equal(snapshot.intents.find((intent) => intent.id === intentId).generation, fleet.generation);
    assert.equal(snapshot.intents.find((intent) => intent.id === intentId).integration_phase, "complete");
    assert.equal(snapshot.fleet.canonical_head, "integrated-head");
  } finally {
    recovered?.close();
    original.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("worker tool activity timestamps start once and clear on end, settlement, and reset", () => {
  const fleet = createFleet(1);
  const worker = workerStore(fleet, 0);
  try {
    worker.workerHeartbeat({ currentTool: "bash" }, 10_000);
    let row = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(row.current_tool, "bash");
    assert.equal(row.current_tool_started_at, 10_000);

    worker.workerHeartbeat({ currentTool: null }, 12_000);
    row = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(row.current_tool, null);
    assert.equal(row.current_tool_started_at, null);

    fleet.parent.parentUpdateWorker(fleet.root, "w1", { currentTool: "read" }, 13_000, fleet.generation);
    fleet.parent.parentUpdateWorker(fleet.root, "w1", { status: "idle", currentTool: null }, 14_000, fleet.generation);
    row = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(row.current_tool_started_at, null);

    fleet.parent.parentUpdateWorker(fleet.root, "w1", { processState: "stopped", currentTool: "bash" }, 15_000, fleet.generation);
    fleet.parent.resetWorkerSession(fleet.root, "w1", fleet.generation, testSessionId(77), 16_000);
    row = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(row.current_tool, null);
    assert.equal(row.current_tool_started_at, null);
  } finally {
    worker.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("fresh replacement sessions resume interrupted intents and reject stale session writes without tokens", () => {
  const fleet = createFleet(1);
  const old = workerStore(fleet, 0);
  try {
    old.publishIntent({ question: "Investigate invalid rows", experiment: "Diagnose all failures", reason: "Campaign is active" }, 110);
    fleet.parent.parentUpdateWorker(fleet.root, "w1", { processState: "stopped", status: "failed" }, 120, fleet.generation);
    const replacementSession = testSessionId(99);
    fleet.parent.resetWorkerSession(fleet.root, "w1", fleet.generation, replacementSession, 121);
    const replacement = workerStore(fleet, 0, replacementSession);
    try {
      assert.equal(fleet.parent.currentIntent(fleet.root, "w1").question, "Investigate invalid rows");
      replacement.checkpoint({ stage: "diagnosis", summary: "Resumed from durable state" }, 122);
      assert.throws(() => old.workerHeartbeat({ status: "running" }, 123), StaleWorkerError);
      assert.doesNotThrow(() => replacement.workerHeartbeat({ status: "running" }, 124));
    } finally {
      replacement.close();
    }
  } finally {
    old.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("automatic recovery attempt history survives store reopen and resets only on durable health", () => {
  const fleet = createFleet(1);
  try {
    fleet.parent.parentAddWorkerEvent(fleet.root, "w1", fleet.generation, "automatic_recovery_attempt", "first failure", 110);
    fleet.parent.parentAddWorkerEvent(fleet.root, "w1", fleet.generation, "automatic_recovery_attempt", "second failure", 111);
    assert.equal(fleet.parent.recoveryAttemptCount(fleet.root, "w1", fleet.generation), 2);
    fleet.parent.close();

    const reopened = new FleetStore(fleet.dbPath);
    assert.equal(reopened.recoveryAttemptCount(fleet.root, "w1", fleet.generation), 2);
    reopened.parentAddWorkerEvent(fleet.root, "w1", fleet.generation, "automatic_recovery_healthy", "healthy settlement", 112);
    assert.equal(reopened.recoveryAttemptCount(fleet.root, "w1", fleet.generation), 0);
    reopened.close();
  } finally {
    try { fleet.parent.close(); } catch {}
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("v3 coordination schema contains intents but no admission, evidence, claim, or token structures", () => {
  const fleet = createFleet(1);
  try {
    assert.equal(AUTORESEARCH_PROTOCOL_VERSION, 3);
    const tables = fleet.parent.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_v3'").all().map((row) => row.name);
    assert.deepEqual(tables.sort(), ["checkpoints_v3", "events_v3", "fleets_v3", "intents_v3", "workers_v3"]);
    const workerColumns = fleet.parent.db.prepare("PRAGMA table_info(workers_v3)").all().map((column) => column.name);
    assert.ok(!workerColumns.includes("token"));
    assert.ok(workerColumns.includes("current_tool_started_at"));
    const fleetColumns = fleet.parent.db.prepare("PRAGMA table_info(fleets_v3)").all().map((column) => column.name);
    assert.ok(!fleetColumns.includes("max_evidence_stages"));
    const intentColumns = fleet.parent.db.prepare("PRAGMA table_info(intents_v3)").all().map((column) => column.name);
    for (const column of ["worker_id", "question", "experiment", "reason", "started_at", "status", "integration_phase", "integration_ref", "integration_base_head", "integration_result_head", "integration_error"]) assert.ok(intentColumns.includes(column));
  } finally {
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("opening an existing v3 database adds integration and activity columns without changing a paused active intent", () => {
  const fleet = createFleet(1);
  const worker = workerStore(fleet, 0);
  worker.publishIntent({ question: "Paused campaign", experiment: "Resume later", reason: "Migration safety", baselineHead: "base" }, 110);
  fleet.parent.setFleetStatus(fleet.root, "paused", 120, fleet.generation);
  worker.close();
  fleet.parent.close();

  const old = new DatabaseSync(fleet.dbPath);
  for (const column of ["canonical_branch", "integration_error"]) old.exec(`ALTER TABLE fleets_v3 DROP COLUMN ${column}`);
  old.exec("ALTER TABLE workers_v3 DROP COLUMN current_tool_started_at");
  for (const column of ["integration_phase", "integration_ref", "integration_base_head", "integration_result_head", "integration_error", "integration_updated_at"]) {
    old.exec(`ALTER TABLE intents_v3 DROP COLUMN ${column}`);
  }
  old.close();

  const migrated = new FleetStore(fleet.dbPath);
  try {
    const snapshot = migrated.snapshot(fleet.root);
    assert.equal(snapshot.fleet.status, "paused");
    assert.equal(snapshot.fleet.generation, fleet.generation);
    assert.equal(snapshot.intents[0].status, "active");
    assert.equal(snapshot.intents[0].question, "Paused campaign");
    assert.equal(snapshot.intents[0].integration_phase, null);
    assert.ok("current_tool_started_at" in snapshot.workers[0]);
  } finally {
    migrated.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("opening protocol v3 removes obsolete admission and reservation schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-v3-migration-"));
  const dbPath = join(dir, "fleet.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE fleets(id INTEGER);
    CREATE TABLE workers(id INTEGER, status TEXT NOT NULL);
    INSERT INTO workers VALUES(1, 'stopped');
    CREATE TABLE checkpoints(
      canonical_root TEXT, worker_id TEXT, generation INTEGER, stage TEXT, summary TEXT, findings TEXT,
      blockers TEXT, next_actions TEXT, run_ids TEXT, candidate_commit TEXT, champion_commit TEXT,
      continuation_command TEXT, launch_receipt TEXT, created_at INTEGER
    );
    INSERT INTO checkpoints VALUES('/repo','w1',2,'diagnosis','legacy finding','[]','[]','[]','[]',NULL,NULL,NULL,NULL,42);
    CREATE TABLE events(canonical_root TEXT, worker_id TEXT, generation INTEGER, kind TEXT, summary TEXT, created_at INTEGER);
    INSERT INTO events VALUES('/repo','w1',2,'checkpoint','legacy event',43);
    CREATE TABLE admissions(id INTEGER);
    CREATE TABLE admission_attempts(id INTEGER);
    CREATE TABLE evidence_reservations(id INTEGER);
  `);
  legacy.close();
  const store = new FleetStore(dbPath);
  try {
    const obsolete = store.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('fleets','workers','checkpoints','events','admissions','admission_attempts','evidence_reservations')
    `).all();
    assert.deepEqual(obsolete, []);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(store.db.prepare("SELECT summary FROM checkpoints_v3 WHERE session_id='legacy-v2'").get().summary, "legacy finding");
    assert.equal(store.db.prepare("SELECT summary FROM events_v3 WHERE kind='checkpoint'").get().summary, "legacy event");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protocol v3 refuses to discard potentially live v2 process state", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-v2-live-"));
  const dbPath = join(dir, "fleet.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("CREATE TABLE workers(id INTEGER, status TEXT); INSERT INTO workers VALUES(1, 'running'); INSERT INTO workers VALUES(2, NULL)");
  legacy.close();
  try {
    assert.throws(() => new FleetStore(dbPath), /legacy worker processes may still be running/i);
    const reopened = new DatabaseSync(dbPath);
    assert.equal(reopened.prepare("SELECT status FROM workers").get().status, "running");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker count is the only load setting and has no arbitrary ceiling", () => {
  for (const count of [1, 4, 20, 10_000]) assert.equal(parseAutoresearchFleetCount(` ${count} `), count);
  for (const value of ["", "0", "-1", "1.5", "4x", "on", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(parseAutoresearchFleetCount(value), undefined, value);
  }
  assert.equal(workerLanes("/repo", 20).length, 20);
});

test("Pi CLI resolution requires an absolute installed path", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "autoresearch-pi-package-"));
  const cli = join(packageRoot, "dist", "cli.js");
  mkdirSync(join(packageRoot, "dist"));
  writeFileSync(cli, "// fixture");
  try {
    assert.equal(resolvePiCliPath(undefined, packageRoot), cli);
    assert.equal(resolvePiCliPath(cli), cli);
    assert.throws(() => resolvePiCliPath("relative/cli.js"), /absolute dist\/cli\.js path/i);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

function createWorkerHarness() {
  const handlers = new Map();
  const tools = new Map();
  const sent = [];
  let activeTools = ["read", "bash"];
  const pi = {
    on(name, handler) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    registerTool(tool) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    getActiveTools: () => [...activeTools],
    setActiveTools(names) { activeTools = [...names]; },
    sendUserMessage(message) { sent.push(message); },
  };
  let compactCalls = 0;
  const ctx = {
    cwd: "/worker",
    hasUI: false,
    mode: "rpc",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    compact() { compactCalls += 1; },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  };
  const emit = async (name, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return { pi, ctx, tools, sent, emit, compactCalls: () => compactCalls };
}

test("worker announces intent, continues the same campaign across settlements, checkpoints, and exits only after finish", async () => {
  const fleet = createFleet(1);
  const harness = createWorkerHarness();
  const env = {
    AUTORESEARCH_CANONICAL_ROOT: fleet.root,
    AUTORESEARCH_WORKER_ID: "w1",
    AUTORESEARCH_SESSION_ID: fleet.workers[0].sessionId,
    AUTORESEARCH_STATE_DIR: fleet.dir,
    AUTORESEARCH_FLEET_DB: fleet.dbPath,
    AUTORESEARCH_GENERATION: String(fleet.generation),
  };
  try {
    assert.deepEqual(workerIdentityFromEnv(env).identity, {
      canonicalRoot: fleet.root, workerId: "w1", sessionId: fleet.workers[0].sessionId, generation: fleet.generation,
    });
    assert.equal("AUTORESEARCH_WORKER_TOKEN" in env, false);
    let gitReads = 0;
    registerWorkerAutoresearch(harness.pi, {
      env,
      continuationDelayMs: 0,
      laneState: () => ({ head: ++gitReads === 1 ? "baseline-head" : "result-commit", dirty: false }),
    });
    await harness.emit("session_start");
    const tool = harness.tools.get(AUTORESEARCH_WORKER_TOOL);
    const initial = await tool.execute("snapshot", { action: "snapshot" });
    assert.doesNotMatch(initial.content[0].text, /"admissions"|"reservations"|"claimed_scopes"|"token"/i);

    await tool.execute("intent", {
      action: "publish_intent",
      question: "Does a higher effort restore validity?",
      experiment: "Run three baselines",
      reason: "Prior rows were invalid",
    });
    await tool.execute("checkpoint", {
      action: "checkpoint", stage: "baseline", summary: "Evidence process launched",
      nextActions: ["wait for terminal status"], launchReceipt: { pid: 42 },
    });

    await harness.emit("agent_start");
    await harness.emit("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "Waiting for all evidence, not handing off." }], stopReason: "stop", usage: { totalTokens: 100, cost: { total: 0.01 } } },
    });
    await harness.emit("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: "continue" }], stopReason: "stop" }],
    });
    await harness.emit("agent_settled");
    await waitFor(() => harness.sent.length === 1);
    assert.match(harness.sent[0], /Continue your complete campaign/);
    assert.equal(harness.compactCalls(), 0, "worker continuation does not invoke legacy ctx.compact");

    const completion = await tool.execute("finish", {
      action: "finish_campaign", outcome: "inconclusive", summary: "All required runs completed but confidence was insufficient",
      findings: ["3 terminal rows"], runIds: ["run-1"],
    });
    assert.equal(completion.details.outcome, "inconclusive");
    assert.equal(fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0].status, "complete");
  } finally {
    await harness.emit("session_shutdown");
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("terminal finish requires a clean result commit and preserves external-blocked exactly", async () => {
  const fleet = createFleet(1);
  const harness = createWorkerHarness();
  const env = {
    AUTORESEARCH_CANONICAL_ROOT: fleet.root,
    AUTORESEARCH_WORKER_ID: "w1",
    AUTORESEARCH_SESSION_ID: fleet.workers[0].sessionId,
    AUTORESEARCH_STATE_DIR: fleet.dir,
    AUTORESEARCH_FLEET_DB: fleet.dbPath,
    AUTORESEARCH_GENERATION: String(fleet.generation),
  };
  let git = { head: "baseline-head", dirty: false };
  try {
    registerWorkerAutoresearch(harness.pi, { env, laneState: () => git });
    await harness.emit("session_start");
    const tool = harness.tools.get(AUTORESEARCH_WORKER_TOOL);
    await tool.execute("intent", {
      action: "publish_intent", question: "Blocked campaign", experiment: "Attempt external evaluation", reason: "Highest-value uncertainty",
    });
    git = { head: "uncommitted-head", dirty: true };
    await assert.rejects(
      tool.execute("dirty", { action: "finish_campaign", outcome: "external-blocked", summary: "Credential unavailable" }),
      /clean worktree/i,
    );
    git = { head: "baseline-head", dirty: false };
    await assert.rejects(
      tool.execute("unchanged", { action: "finish_campaign", outcome: "external-blocked", summary: "Credential unavailable" }),
      /Git commit recording/i,
    );
    git = { head: "result-commit", dirty: false };
    await tool.execute("finished", {
      action: "finish_campaign", outcome: "external-blocked", summary: "Required external credential is unavailable after all legal local work",
    });
    const intent = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).intents[0];
    assert.equal(intent.outcome, "external-blocked");
    assert.equal(intent.status, "blocked");
    assert.equal(intent.terminal_head, "result-commit");
  } finally {
    await harness.emit("session_shutdown");
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("worker shared context exposes active intentions without implying exclusivity", () => {
  const fleet = createFleet(2);
  const w1 = workerStore(fleet, 0);
  const w2 = workerStore(fleet, 1);
  try {
    w1.publishIntent({ question: "Question A", experiment: "Experiment A", reason: "Reason A" });
    w2.publishIntent({ question: "Question B", experiment: "Experiment B", reason: "Reason B" });
    const context = compactWorkerContext(fleet.parent.snapshot(fleet.root, { recent: 20 }), "w1");
    assert.match(context, /informational, non-exclusive/);
    assert.match(context, /w1: Question A/);
    assert.match(context, /w2: Question B/);
    assert.match(context, /overlap is allowed/);
  } finally {
    w2.close();
    w1.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

function createParentHarness(options) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const widgets = [];
  const sentMessages = [];
  let activeTools = ["read", "bash"];
  const pi = {
    on(name, handler) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    getActiveTools: () => [...new Set(activeTools)],
    setActiveTools(names) { activeTools = [...names]; },
    getThinkingLevel: () => "high",
    appendEntry() {},
    sendUserMessage(message) { sentMessages.push(message); },
    events: { on: () => () => {} },
  };
  const ctx = {
    cwd: options.cwd,
    hasUI: true,
    mode: "rpc",
    model: { provider: "test-provider", id: "test-model", contextWindow: 272_000 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    compact() {},
    sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getBranch: () => [] },
    ui: {
      theme: { fg: (_color, value) => value, bold: (value) => value },
      notify(message, type) { notifications.push({ message, type }); },
      setWidget(key, value, widgetOptions) { widgets.push({ key, value, options: widgetOptions }); },
      setStatus() {},
    },
  };
  const emit = async (name, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  registerAutoresearch(pi, { supervisor: options.supervisor });
  return { pi, ctx, commands, tools, notifications, widgets, sentMessages, emit, activeTools: () => activeTools };
}

test("opening Pi outside Git silently skips autoresearch fleet restoration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "autoresearch-non-git-"));
  const harness = createParentHarness({ cwd, supervisor: {} });
  try {
    await harness.emit("session_start", { reason: "startup" });
    assert.deepEqual(harness.notifications, []);
  } finally {
    await harness.emit("session_shutdown", { reason: "quit" });
    rmSync(cwd, { recursive: true, force: true });
  }
});

class FakeRpcClient {
  constructor(options, records) {
    this.options = options;
    this.records = records;
    this.events = [];
    this.stopped = false;
    this.stopCalls = 0;
    this.aborted = false;
    records.clients.push(this);
  }
  onEvent(listener) { this.events.push(listener); return () => { this.events = []; }; }
  async start() {
    const sessionDir = this.options.args[this.options.args.indexOf("--session-dir") + 1];
    const sessionId = this.options.args[this.options.args.indexOf("--session-id") + 1];
    const header = readdirSync(sessionDir).map((file) => {
      try { return JSON.parse(readFileSync(join(sessionDir, file), "utf8").split("\n", 1)[0]); } catch { return undefined; }
    }).find((value) => value?.id === sessionId);
    this.records.sessionHeaders.push(header);
  }
  async getState() {
    if (this.failLiveness) throw new Error("synthetic hard process exit");
    return { isStreaming: false, sessionFile: `/sessions/${this.options.env.AUTORESEARCH_SESSION_ID}.jsonl` };
  }
  async prompt(message) { this.records.prompts.push({ workerId: this.options.env.AUTORESEARCH_WORKER_ID, message }); }
  async steer(message) { this.records.steers.push(message); }
  async followUp(message) { this.records.followUps.push(message); }
  async abort() { this.aborted = true; }
  async stop() {
    this.stopCalls += 1;
    if (this.records.stopDelayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, this.records.stopDelayMs));
    if (this.records.stopFails) throw new Error("process termination failed");
    this.stopped = true;
  }
  emit(event) { for (const listener of this.events) listener(event); }
}

function createSupervisorFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-supervisor-v3-"));
  const root = join(dir, "research");
  mkdirSync(root);
  writeFileSync(join(root, "program.md"), "# Research program\nComplete one full campaign.");
  const records = {
    clients: [], prompts: [], steers: [], followUps: [], sessionHeaders: [], ensured: [], syncs: [],
    createAttempts: 0, failCreatesRemaining: options.failCreatesRemaining ?? 0, stopFails: false,
    stopDelayMs: options.stopDelayMs ?? 0,
  };
  let nextSession = 100;
  const supervisor = {
    createRpcClient: (rpcOptions) => {
      records.createAttempts += 1;
      if (records.failCreatesRemaining > 0) {
        records.failCreatesRemaining -= 1;
        throw new Error("synthetic launch failure");
      }
      return new FakeRpcClient(rpcOptions, records);
    },
    inspectRepo: () => ({ canonicalRoot: root, commonDir: join(root, ".git"), branch: "main", head: "1234567890abcdef", dirty: false }),
    ensureIgnored: () => {},
    ensureLane: (_canonical, _common, lane) => {
      records.ensured.push(lane.workerId);
      mkdirSync(lane.path, { recursive: true });
      writeFileSync(join(lane.path, "program.md"), "# Research program\nComplete one full campaign.");
      return lane;
    },
    laneState: () => ({ head: "1234567890abcdef", dirty: false }),
    syncLane: ({ lane, canonicalHead }) => {
      records.syncs.push(lane.workerId);
      return { candidateRef: `refs/test/${lane.workerId}`, canonicalHead: canonicalHead ?? "1234567890abcdef" };
    },
    preserveTerminal: options.preserveTerminal ?? (({ generation, intentId }) => `refs/autoresearch/terminals/g${generation}/i${intentId}`),
    integrateTerminal: options.integrateTerminal ?? (({ expectedHead }) => ({ resultHead: expectedHead, alreadyIntegrated: true })),
    resetIntegratedLane: options.resetIntegratedLane ?? (() => {}),
    createStore: (path) => new FleetStore(path),
    cliPath: process.execPath,
    extensionPath: resolve("configs/pi/extensions/autoresearch.ts"),
    dashboardIntervalMs: options.dashboardIntervalMs ?? 0,
    sessionVersion: 3,
    recycleBackoffMs: 0,
    sessionId: () => testSessionId(nextSession++),
    now: () => Date.now(),
  };
  const harness = createParentHarness({ cwd: root, supervisor });
  return { dir, root, records, harness, supervisor };
}

function identityFor(client) {
  const env = client.options.env;
  return {
    canonicalRoot: env.AUTORESEARCH_CANONICAL_ROOT,
    workerId: env.AUTORESEARCH_WORKER_ID,
    sessionId: env.AUTORESEARCH_SESSION_ID,
    generation: Number(env.AUTORESEARCH_GENERATION),
  };
}

test("supervisor eagerly launches the user-selected worker count with no admission, claim, token, or evidence budget", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("6", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 6);
    assert.equal(fixture.records.clients.length, 6);
    assert.deepEqual(fixture.records.ensured, ["w1", "w2", "w3", "w4", "w5", "w6"]);
    assert.deepEqual(fixture.records.syncs, ["w1", "w2", "w3", "w4", "w5", "w6"]);
    for (const client of fixture.records.clients) {
      assert.equal("AUTORESEARCH_WORKER_TOKEN" in client.options.env, false);
    }
    assert.match(fixture.records.prompts[0].message, /There is no dispatcher, task queue, claim, lock, admission/);
    assert.match(fixture.records.prompts[0].message, /informational and non-exclusive/i);
    assert.match(fixture.records.prompts[0].message, /complete research campaign/i);

    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const snapshot = store.snapshot(fixture.root);
    assert.equal(snapshot.fleet.max_workers, 6);
    assert.equal(snapshot.workers.length, 6);
    store.close();
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("active fleet adds operational supervision documentation to the main system prompt", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    const inactive = await fixture.harness.emit("before_agent_start", { systemPrompt: "BASE" });
    assert.equal(inactive[0], undefined);

    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const active = await fixture.harness.emit("before_agent_start", { systemPrompt: "BASE" });
    assert.match(active[0].systemPrompt, /^BASE/);
    assert.match(active[0].systemPrompt, /Autoresearch operational supervision/);
    assert.match(active[0].systemPrompt, /autoresearch_inspect/);
    assert.match(active[0].systemPrompt, /autoresearch_control/);
    assert.match(active[0].systemPrompt, /configs\/pi\/extensions\/autoresearch\/supervisor\.ts/);
    assert.match(active[0].systemPrompt, /scripts\/autoresearch-fleet\.test\.mjs/);
    assert.match(active[0].systemPrompt, /pi-coding-agent\/docs/);
    assert.match(active[0].message.content, /process=/);
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("terminal campaign completion immediately replaces the disposable worker with a fresh autonomous session", async () => {
  const fixture = createSupervisorFixture();
  let worker;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const first = fixture.records.clients[0];
    worker = new FleetStore(first.options.env.AUTORESEARCH_FLEET_DB, identityFor(first));
    worker.publishIntent({ question: "Question one", experiment: "Full experiment", reason: "Highest value", baselineHead: "baseline-head" });
    worker.finishCampaign({ outcome: "rejected", summary: "Candidate failed confirmation", findings: ["replicated reversal"], terminalHead: "terminal-head" });
    first.emit({ type: "agent_settled" });
    await waitFor(() => fixture.records.clients.length === 2);
    const replacement = fixture.records.clients[1];
    assert.notEqual(replacement.options.env.AUTORESEARCH_SESSION_ID, first.options.env.AUTORESEARCH_SESSION_ID);
    await waitFor(() => fixture.records.prompts.length === 2);
    assert.match(fixture.records.prompts[1].message, /independently choose the most valuable next direction/i);
    assert.equal(first.stopped, true);
  } finally {
    worker?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("terminal integration failure blocks the lane, queues an incident, and launches no replacement", async () => {
  const fixture = createSupervisorFixture({
    integrateTerminal: () => { throw new Error("synthetic merge conflict"); },
  });
  let worker;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const first = fixture.records.clients[0];
    worker = new FleetStore(first.options.env.AUTORESEARCH_FLEET_DB, identityFor(first));
    worker.publishIntent({ question: "Conflicting campaign", experiment: "Commit conflict", reason: "Exercise blocked integration", baselineHead: "baseline-head" });
    worker.finishCampaign({ outcome: "accepted", summary: "Terminal result", terminalHead: "terminal-head" });
    first.emit({ type: "agent_settled" });

    const observer = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    await waitFor(() => observer.snapshot(fixture.root).intents[0].integration_phase === "blocked");
    const snapshot = observer.snapshot(fixture.root);
    observer.close();
    assert.equal(fixture.records.clients.length, 1);
    assert.equal(first.stopped, true);
    assert.equal(snapshot.workers[0].status, "blocked");
    assert.match(String(snapshot.intents[0].integration_error), /merge conflict/i);
    await waitFor(() => fixture.harness.sentMessages.length === 1);
    assert.match(fixture.harness.sentMessages[0], /terminal integration blocked/i);
  } finally {
    worker?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("crashed workers are replaced fresh and resume their existing full campaign intent", async () => {
  const fixture = createSupervisorFixture();
  let worker;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const first = fixture.records.clients[0];
    worker = new FleetStore(first.options.env.AUTORESEARCH_FLEET_DB, identityFor(first));
    worker.publishIntent({ question: "Long campaign", experiment: "All required stages", reason: "Important uncertainty" });
    first.emit({ type: "extension_error", error: "provider connection lost" });
    await waitFor(() => fixture.records.clients.length === 2);
    await waitFor(() => fixture.records.prompts.length === 2);
    assert.match(fixture.records.prompts[1].message, /working intent survived a process interruption/i);
    assert.match(fixture.records.prompts[1].message, /Long campaign/);
  } finally {
    worker?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a hard worker-process exit is detected and replaced without a worker event", async () => {
  const fixture = createSupervisorFixture({ dashboardIntervalMs: 10 });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const first = fixture.records.clients[0];
    first.failLiveness = true;
    await waitFor(() => fixture.records.clients.length >= 2, 4_000);
    await waitFor(() => fixture.records.prompts.length >= 2, 4_000);
    assert.equal(first.stopped, true);
    assert.notEqual(
      fixture.records.clients[1].options.env.AUTORESEARCH_SESSION_ID,
      first.options.env.AUTORESEARCH_SESSION_ID,
    );
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("concurrent liveness and terminal recycle paths stop a worker process exactly once", async () => {
  const fixture = createSupervisorFixture({ dashboardIntervalMs: 10, stopDelayMs: 40 });
  let worker;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const first = fixture.records.clients[0];
    worker = new FleetStore(first.options.env.AUTORESEARCH_FLEET_DB, identityFor(first));
    worker.publishIntent({ question: "Race campaign", experiment: "Complete while process fails", reason: "Exercise stop serialization", baselineHead: "baseline-head" });
    first.failLiveness = true;
    await waitFor(() => first.stopCalls === 1);
    worker.finishCampaign({ outcome: "rejected", summary: "Terminal evidence was recorded", terminalHead: "terminal-head" });
    first.emit({ type: "agent_settled" });
    await waitFor(() => fixture.records.clients.length >= 2, 4_000);
    assert.equal(first.stopCalls, 1);
    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    assert.notEqual(store.snapshot(fixture.root).workers[0].process_state, "unreconciled");
    store.close();
  } finally {
    worker?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a second parent is a read-only observer whose shutdown leaves the owned fleet unchanged", async () => {
  const fixture = createSupervisorFixture();
  let replacementParent;
  let worker;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const first = fixture.records.clients[0];

    replacementParent = createParentHarness({ cwd: fixture.root, supervisor: fixture.supervisor });
    await replacementParent.emit("session_start", { reason: "startup" });
    const beforeStore = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const before = beforeStore.snapshot(fixture.root);
    beforeStore.close();
    assert.equal(before.fleet.status, "active");
    assert.equal(before.workers[0].process_state, "owned");
    assert.ok(replacementParent.activeTools().includes("autoresearch_control"));
    assert.match(replacementParent.notifications.at(-1).message, /state was left unchanged.*external verification/i);
    await replacementParent.commands.get("autoresearch").handler("status", replacementParent.ctx);
    assert.match(replacementParent.notifications.at(-1).message, /active, generation/i);

    await replacementParent.emit("session_shutdown", { reason: "quit" });
    replacementParent = undefined;

    const afterStore = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const after = afterStore.snapshot(fixture.root);
    afterStore.close();
    assert.equal(after.fleet.status, "active");
    assert.equal(after.workers[0].status, before.workers[0].status);
    assert.equal(after.workers[0].process_state, "owned");
    assert.equal(after.workers[0].session_id, before.workers[0].session_id);
    assert.equal(first.stopCalls, 0);

    worker = new FleetStore(first.options.env.AUTORESEARCH_FLEET_DB, identityFor(first));
    assert.doesNotThrow(() => worker.workerHeartbeat({ status: "running" }));
  } finally {
    worker?.close();
    if (replacementParent) await replacementParent.emit("session_shutdown", { reason: "quit" });
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("rapid accepted-then-failed replacements open a bounded circuit and raise one actionable incident", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);

    for (let index = 0; index < 4; index += 1) {
      const client = fixture.records.clients.at(-1);
      client.emit({ type: "extension_error", error: "synthetic immediate worker failure" });
      if (index < 3) await waitFor(() => fixture.records.clients.length === index + 2, 4_000);
    }

    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    await waitFor(() => store.snapshot(fixture.root).workers[0].status === "blocked", 4_000);
    const snapshot = store.snapshot(fixture.root);
    store.close();
    assert.equal(fixture.records.clients.length, 4, "initial process plus three bounded replacements");
    assert.equal(snapshot.workers[0].process_state, "stopped");
    assert.match(String(snapshot.workers[0].summary), /automatic recovery exhausted/i);
    await waitFor(() => fixture.harness.sentMessages.length === 1);
    assert.match(fixture.harness.sentMessages[0], /operational incident; action required/i);
    assert.match(fixture.harness.sentMessages[0], /do not merely acknowledge/i);
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an owner never launches a replacement after persisted fleet state becomes off", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const first = fixture.records.clients[0];
    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const generation = store.snapshot(fixture.root).fleet.generation;
    store.setFleetStatus(fixture.root, "off", Date.now(), generation);
    const control = fixture.harness.tools.get("autoresearch_control");
    await assert.rejects(
      () => control.execute("restart", { action: "restart", target: "w1" }),
      /persisted autoresearch fleet is not active/i,
    );
    assert.equal(fixture.records.clients.length, 1);

    first.emit({ type: "extension_error", error: "synthetic failure after external fleet shutdown" });
    await waitFor(() => store.snapshot(fixture.root).workers[0].status === "blocked", 4_000);
    const snapshot = store.snapshot(fixture.root);
    store.close();
    assert.equal(fixture.records.clients.length, 1);
    assert.equal(first.stopCalls, 1);
    assert.equal(snapshot.workers[0].process_state, "stopped");
    assert.match(String(snapshot.workers[0].summary), /persisted fleet is not active/i);
    await waitFor(() => fixture.harness.sentMessages.length === 1);
    assert.match(fixture.harness.sentMessages[0], /operational incident; action required/i);
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("RPC stop timeout remains a process-safety watchdog, not a research budget", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    fixture.records.stopFails = true;
    await fixture.harness.commands.get("autoresearch").handler("off", fixture.harness.ctx);
    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const snapshot = store.snapshot(fixture.root);
    assert.equal(snapshot.fleet.status, "off");
    assert.equal(snapshot.workers[0].process_state, "unreconciled");
    assert.match(String(snapshot.workers[0].error), /process termination failed/i);
    store.close();
  } finally {
    fixture.records.stopFails = false;
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("dashboard describes workers and intentions without evidence capacity or admissions", () => {
  const snapshot = {
    fleet: { status: "active", generation: 3, completed_campaigns: 7 },
    workers: [{
      worker_id: "w1", session_id: testSessionId(1), status: "running", started_at: 1_000, last_seen: 2_000,
      current_tool: "bash", current_tool_started_at: 61_000,
      turns: 2, tool_calls: 3, cost: 0.12, model: "openai-codex/gpt-5.6-sol", thinking: "high", context_tokens: 1_000, context_window: 272_000,
    }],
    intents: [{ worker_id: "w1", status: "active", question: "Test transfer", experiment: "Three held-out runs" }],
    checkpoints: [],
    events: [],
  };
  const lines = fleetDashboardLines(snapshot, { now: 121_000, canonicalHead: "abcdef123456" });
  assert.match(lines[0], /1 worker · 7 campaigns completed · canonical abcdef12/);
  assert.doesNotMatch(lines.join("\n"), /evidence \d|admission/i);
  assert.match(lines[1], /age 02:00/);
  assert.match(lines[1], /bash 01:00/);
  assert.match(lines[1], /Test transfer/);
});
