import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AUTORESEARCH_COMPACTION_INSTRUCTIONS,
  AUTORESEARCH_PROGRAM_DESIGN_SKILL_PATH,
  registerAutoresearch,
} from "../configs/pi/extensions/autoresearch.ts";
import { syncLaneToCanonical, workerLanes } from "../configs/pi/extensions/autoresearch/git.ts";
import { fleetDashboardLines, compactFleetContext } from "../configs/pi/extensions/autoresearch/presentation.ts";
import {
  FleetAlreadyActiveError,
  FleetStore,
  FenceError,
} from "../configs/pi/extensions/autoresearch/state.ts";
import {
  MAX_AUTORESEARCH_WORKERS,
  parseAutoresearchFleetCount,
  resolvePiCliPath,
} from "../configs/pi/extensions/autoresearch/supervisor.ts";
import {
  AUTORESEARCH_PARENT_TOOLS,
  AUTORESEARCH_WORKER_TOOL,
  registerWorkerAutoresearch,
  workerIdentityFromEnv,
} from "../configs/pi/extensions/autoresearch/worker.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function testSessionId(index, firstGroup = index.toString(16).padStart(8, "0")) {
  return `${firstGroup}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await tick();
  }
}

function seed(workerId, token, base, sessionId = testSessionId(Number(workerId.slice(1)))) {
  return {
    workerId,
    sessionId,
    token,
    worktree: join(base, workerId),
    branch: `autoresearch/worker-${workerId.slice(1)}`,
    sessionsRoot: join(base, "sessions"),
  };
}

function createFleetDb(count = 3) {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-db-"));
  const dbPath = join(dir, "fleet.sqlite");
  const root = join(dir, "repo");
  const parent = new FleetStore(dbPath);
  const workers = Array.from({ length: count }, (_, index) => seed(`w${index + 1}`, `t${index + 1}`, dir));
  const generation = parent.beginFleet({ canonicalRoot: root, workers, maxEvidenceStages: 2, now: 100 });
  parent.activateFleet(root, generation, 101);
  return { dir, dbPath, root, parent, workers, generation };
}

function workerStore(fleet, index, token = fleet.workers[index].token) {
  return new FleetStore(fleet.dbPath, {
    canonicalRoot: fleet.root,
    workerId: fleet.workers[index].workerId,
    sessionId: fleet.workers[index].sessionId,
    generation: fleet.generation,
    token,
  });
}

function writePortfolio(root, workers) {
  mkdirSync(join(root, ".autoresearch"), { recursive: true });
  const active_assignments = {};
  const hypotheses = {};
  for (const worker of workers) {
    const hypothesis = `hypothesis-${worker.workerId}`;
    hypotheses[hypothesis] = { status: "active" };
    active_assignments[worker.workerId] = {
      worker_id: worker.workerId,
      campaign_id: `campaign-${worker.workerId}`,
      hypothesis_id: hypothesis,
      worker_token_sha256: createHash("sha256").update(worker.token).digest("hex"),
    };
  }
  writeFileSync(join(root, ".autoresearch", "portfolio.json"), `${JSON.stringify({
    schema_version: 2,
    revision: 1,
    active_assignments,
    paused: false,
    pause_reason: null,
    hypotheses,
    history: [],
  })}\n`);
}

test("SQLite checkpoints are structured, fenced, WAL-backed, and evidence capacity is atomic", () => {
  const fleet = createFleetDb();
  const w1 = workerStore(fleet, 0);
  const w2 = workerStore(fleet, 1);
  const w3 = workerStore(fleet, 2);
  const stale = workerStore(fleet, 0, "stale-token");
  const sameFenceDifferentSession = new FleetStore(fleet.dbPath, {
    canonicalRoot: fleet.root,
    workerId: "w1",
    sessionId: testSessionId(999),
    generation: fleet.generation,
    token: fleet.workers[0].token,
  });
  try {
    assert.equal(fleet.parent.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    const checkpointId = w1.checkpoint({
      campaign: "c1",
      hypothesis: "h1",
      stage: "benchmark",
      status: "running",
      summary: "candidate improved",
      findings: ["f1"],
      blockers: [],
      nextActions: ["verify"],
      runIds: ["run-7"],
      claimedScopes: ["parser"],
    }, 200);
    assert.ok(checkpointId > 0);

    const first = w1.reserveEvidence("external benchmark", "c1", 201);
    const second = w2.reserveEvidence("independent reproduction", "c2", 202);
    const third = w3.reserveEvidence("third evidence", "c3", 203);
    assert.equal(first.reserved, true);
    assert.equal(second.reserved, true);
    assert.deepEqual({ reserved: third.reserved, wait: third.wait, active: third.active, max: third.max }, {
      reserved: false, wait: true, active: 2, max: 2,
    });

    assert.throws(() => stale.workerHeartbeat({ status: "running" }), FenceError);
    assert.doesNotThrow(() => sameFenceDifferentSession.workerHeartbeat({ status: "running" }));
    w1.checkpoint({
      campaign: "c1",
      stage: "external benchmark",
      status: "running",
      launchReceipt: { reservation_id: first.reservationId, pid: 42 },
    }, 203);
    assert.equal(w1.releaseEvidence({ reservationId: first.reservationId, receipt: { runId: "run-7", verdict: "pass" } }, 204).released, true);
    assert.equal(w3.reserveEvidence("third evidence", "c3", 205).reserved, true);

    const snapshot = fleet.parent.snapshot(fleet.root, { workerId: "w1", recent: 10 });
    assert.equal(snapshot.checkpoints[0].campaign, "c1");
    assert.equal(snapshot.reservations.length, 0);
    const completedReservation = fleet.parent.db.prepare("SELECT * FROM evidence_reservations WHERE id=?").get(first.reservationId);
    assert.equal(completedReservation.campaign, "c1");
    assert.deepEqual(JSON.parse(completedReservation.launch_receipt), { reservation_id: first.reservationId, pid: 42 });
    assert.deepEqual(JSON.parse(completedReservation.receipt), { runId: "run-7", verdict: "pass" });
    assert.deepEqual(snapshot.checkpoints[1].findings, ["f1"]);
    assert.deepEqual(snapshot.checkpoints[1].claimed_scopes, ["parser"]);
    assert.equal(snapshot.workers[0].summary, "candidate improved");
  } finally {
    sameFenceDifferentSession.close();
    stale.close();
    w3.close();
    w2.close();
    w1.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("durable admission offers require portfolio ownership and reject conflicting scopes", () => {
  const fleet = createFleetDb(2);
  const w1 = workerStore(fleet, 0);
  const w2 = workerStore(fleet, 1);
  try {
    fleet.parent.beginAdmission(fleet.root, "w1", fleet.generation, { head: "base", dirty: false }, 110);
    assert.throws(() => w1.offerAdmission({
      campaign: "campaign-w1",
      hypothesis: "hypothesis-w1",
      stage: "scout",
      claimedScopes: ["scope:shared"],
    }, 120), /portfolio assignment is required/i);

    writePortfolio(fleet.root, fleet.workers);
    assert.throws(() => w1.offerAdmission({
      campaign: "campaign-w1",
      hypothesis: "wrong-hypothesis",
      stage: "scout",
      claimedScopes: ["scope:shared"],
    }, 121), FenceError);
    const offer = w1.offerAdmission({
      campaign: "campaign-w1",
      hypothesis: "hypothesis-w1",
      stage: "scout",
      claimedScopes: ["scope:shared", "scope:shared"],
    }, 122);
    assert.ok(offer.checkpointId > 0);
    assert.deepEqual(fleet.parent.admitOfferedCampaign(fleet.root, "w1", fleet.generation, 123), { admitted: true });

    fleet.parent.beginAdmission(fleet.root, "w2", fleet.generation, { head: "base", dirty: false }, 124);
    w2.checkpoint({ campaign: "generic", hypothesis: "generic", stage: "theory", status: "running", claimedScopes: ["scope:other"] }, 125);
    assert.equal(fleet.parent.snapshot(fleet.root, { workerId: "w2", recent: 1 }).admissions[0].state, "planning");
    w2.offerAdmission({
      campaign: "campaign-w2",
      hypothesis: "hypothesis-w2",
      stage: "scout",
      claimedScopes: ["scope:shared"],
    }, 126);
    assert.deepEqual(fleet.parent.admitOfferedCampaign(fleet.root, "w2", fleet.generation, 127), {
      admitted: false,
      reason: "claimed scope conflicts with w1",
    });
    w2.recordTurnUsage({ cost: 0.51 }, 128);
    assert.match(fleet.parent.admissionBudgetViolation(fleet.root, "w2", fleet.generation, 129), /cost.*exceeded/i);
    assert.deepEqual(fleet.parent.admitOfferedCampaign(fleet.root, "w2", fleet.generation, 129), {
      admitted: false,
      reason: "campaign admission cost budget exhausted",
    });
  } finally {
    w1.close();
    w2.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("one active evidence reservation is allowed per campaign", () => {
  const fleet = createFleetDb(2);
  const w1 = workerStore(fleet, 0);
  const w2 = workerStore(fleet, 1);
  try {
    const first = w1.reserveEvidence("screen", "campaign-shared");
    const duplicate = w2.reserveEvidence("screen", "campaign-shared");
    assert.equal(first.reserved, true);
    assert.deepEqual(
      { reserved: duplicate.reserved, wait: duplicate.wait, reservationId: duplicate.reservationId },
      { reserved: false, wait: true, reservationId: first.reservationId },
    );
    assert.throws(
      () => w1.reserveEvidence("confirm", "campaign-shared"),
      /different stage or campaign/i,
    );
  } finally {
    w2.close();
    w1.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("same-generation legacy reservations require reconciliation", () => {
  const fleet = createFleetDb(1);
  const worker = workerStore(fleet, 0);
  try {
    const reservation = worker.reserveEvidence("screen", "campaign-legacy");
    fleet.parent.db.prepare("UPDATE evidence_reservations SET campaign=NULL WHERE id=?").run(reservation.reservationId);
    const legacy = worker.reserveEvidence("screen", "campaign-legacy");
    assert.deepEqual(
      {
        reserved: legacy.reserved,
        wait: legacy.wait,
        reservationId: legacy.reservationId,
        requiresReconciliation: legacy.requiresReconciliation,
      },
      {
        reserved: false,
        wait: true,
        reservationId: reservation.reservationId,
        requiresReconciliation: true,
      },
    );
  } finally {
    worker.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("project portfolio ownership fences campaign reservations", () => {
  const fleet = createFleetDb(2);
  const w1 = workerStore(fleet, 0);
  const w2 = workerStore(fleet, 1);
  try {
    mkdirSync(join(fleet.root, ".autoresearch"), { recursive: true });
    writeFileSync(join(fleet.root, ".autoresearch", "portfolio.json"), JSON.stringify({
      schema_version: 2,
      active_assignments: {
        w1: {
          worker_id: "w1",
          campaign_id: "campaign-owned",
          hypothesis_id: "hypothesis-owned",
          worker_token_sha256: createHash("sha256").update("t1").digest("hex"),
        },
      },
    }));

    assert.equal(w1.reserveEvidence("screen", "campaign-owned").reserved, true);
    assert.throws(
      () => w2.reserveEvidence("screen", "campaign-unowned"),
      /not owned by the fenced portfolio worker/i,
    );
  } finally {
    w2.close();
    w1.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("active fleet generation prevents a duplicate database launch", () => {
  const fleet = createFleetDb(1);
  try {
    assert.throws(() => fleet.parent.beginFleet({
      canonicalRoot: fleet.root,
      workers: fleet.workers,
      maxEvidenceStages: 2,
    }), FleetAlreadyActiveError);
  } finally {
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("worker session UUIDs are validated and unique within a canonical fleet", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-session-id-"));
  const root = join(dir, "repo");
  const store = new FleetStore(join(dir, "fleet.sqlite"));
  try {
    assert.throws(
      () => store.beginFleet({ canonicalRoot: root, workers: [seed("w1", "t1", dir, "not-a-uuid")] }),
      /invalid.*session UUID/i,
    );
    assert.throws(
      () => store.beginFleet({
        canonicalRoot: root,
        workers: [seed("w1", "t1", dir, testSessionId(1)), seed("w2", "t2", dir, testSessionId(1))],
      }),
      /duplicate.*session UUID/i,
    );
    const workers = [seed("w1", "t1", dir, testSessionId(1)), seed("w2", "t2", dir, testSessionId(2))];
    store.beginFleet({ canonicalRoot: root, workers });
    assert.throws(
      () => store.db.prepare("UPDATE workers SET session_id=? WHERE canonical_root=? AND worker_id='w2'")
        .run(testSessionId(1).toUpperCase(), root),
      /unique constraint/i,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable launching and active fleets recover only after every lane is terminal", () => {
  for (const fleetStatus of ["launching", "active"]) {
    const dir = mkdtempSync(join(tmpdir(), "autoresearch-recovery-"));
    const root = join(dir, "repo");
    const parent = new FleetStore(join(dir, "fleet.sqlite"));
    const oldWorkers = ["w1", "w2", "w3", "w4"].map((id, index) => seed(id, `old-${id}`, dir));
    try {
      const first = parent.beginFleet({ canonicalRoot: root, workers: oldWorkers, now: 10 });
      if (fleetStatus === "active") parent.activateFleet(root, first, 11);
      for (const [index, status] of ["paused", "stopped", "failed", "complete"].entries()) {
        parent.parentUpdateWorker(root, `w${index + 1}`, { status }, 20 + index);
      }
      const nextWorkers = oldWorkers.map((worker, index) => ({
        ...worker,
        sessionId: testSessionId(20 + index),
        token: `new-${worker.workerId}`,
      }));
      assert.equal(parent.beginFleet({ canonicalRoot: root, workers: nextWorkers, now: 30 }), 2);
      const snapshot = parent.snapshot(root);
      assert.equal(snapshot.fleet.status, "launching");
      assert.equal(snapshot.workers[0].status, "launching");
      assert.ok(snapshot.workers.slice(1).every((worker) => worker.generation === 2 && worker.status === "queued"));
      assert.equal(snapshot.fleet.max_workers, 4);
      assert.deepEqual(snapshot.workers.map((worker) => worker.session_id), nextWorkers.map((worker) => worker.sessionId));
    } finally {
      parent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const liveStatus of ["launching", "running", "idle", "blocked", "decision"]) {
    const fleet = createFleetDb(1);
    try {
      fleet.parent.parentUpdateWorker(fleet.root, "w1", { status: liveStatus });
      assert.throws(() => fleet.parent.beginFleet({
        canonicalRoot: fleet.root,
        workers: [{ ...fleet.workers[0], token: "replacement" }],
      }), /non-terminal workers/i);
      assert.equal(fleet.parent.snapshot(fleet.root).fleet.generation, 1, "refusal is transactional");
    } finally {
      fleet.parent.close();
      rmSync(fleet.dir, { recursive: true, force: true });
    }
  }
});

test("fleet resizing refuses omitted reservations and preserves same-lane reservations for receipted reconciliation", () => {
  const fleet = createFleetDb(2);
  const oldW2 = workerStore(fleet, 1);
  try {
    const reservation = oldW2.reserveEvidence("running external evidence", "campaign-running", 200);
    fleet.parent.parentUpdateWorker(fleet.root, "w1", { status: "paused" });
    fleet.parent.parentUpdateWorker(fleet.root, "w2", { status: "failed" });
    assert.throws(() => fleet.parent.beginFleet({
      canonicalRoot: fleet.root,
      workers: [{ ...fleet.workers[0], token: "new-t1" }],
      now: 300,
    }), /omitted workers own active evidence reservations: w2/i);
    assert.equal(fleet.parent.snapshot(fleet.root).fleet.generation, 1);

    const replacements = fleet.workers.map((worker, index) => ({ ...worker, token: `new-t${index + 1}` }));
    const generation = fleet.parent.beginFleet({ canonicalRoot: fleet.root, workers: replacements, now: 301 });
    assert.equal(generation, 2);
    const replacement = new FleetStore(fleet.dbPath, {
      canonicalRoot: fleet.root,
      workerId: "w2",
      sessionId: replacements[1].sessionId,
      generation,
      token: "new-t2",
    });
    try {
      const existing = replacement.reserveEvidence("running external evidence", "campaign-running", 302);
      assert.equal(existing.requiresReconciliation, true);
      assert.equal(existing.reservationId, reservation.reservationId);
      for (const receipt of [undefined, null, "done", 1, [], {}]) {
        assert.throws(
          () => replacement.releaseEvidence({ reservationId: reservation.reservationId, receipt }),
          /non-empty structured terminal receipt/i,
        );
      }
      assert.equal(fleet.parent.hasActiveReservation(fleet.root, "w2"), true);
      assert.equal(replacement.releaseEvidence({
        reservationId: reservation.reservationId,
        receipt: { terminalStatus: "failed", observedAt: "2026-07-15T00:00:00Z" },
      }, 303).released, true);
      assert.throws(() => oldW2.releaseEvidence({
        reservationId: reservation.reservationId,
        receipt: { terminalStatus: "failed" },
      }), FenceError);
    } finally {
      replacement.close();
    }
  } finally {
    oldW2.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("paused fleets cannot be resized around an omitted active reservation", () => {
  const fleet = createFleetDb(2);
  const worker = workerStore(fleet, 1);
  try {
    worker.reserveEvidence("screen", "campaign-screen");
    fleet.parent.parentUpdateWorker(fleet.root, "w1", { status: "paused" });
    fleet.parent.parentUpdateWorker(fleet.root, "w2", { status: "paused" });
    fleet.parent.setFleetStatus(fleet.root, "paused");
    assert.throws(() => fleet.parent.beginFleet({
      canonicalRoot: fleet.root,
      workers: [{ ...fleet.workers[0], token: "replacement" }],
    }), /omitted workers own active evidence reservations: w2/i);
  } finally {
    worker.close();
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("existing fleet schemas migrate elastic admission capacity additively", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-fleet-migration-"));
  const dbPath = join(dir, "fleet.sqlite");
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE fleets (
      canonical_root TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      parent_session TEXT,
      canonical_head TEXT,
      protocol_version INTEGER NOT NULL,
      max_evidence_stages INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      stopped_at INTEGER
    );
    INSERT INTO fleets VALUES('/repo',3,'stopped',NULL,'abc',1,2,1,2,2);
  `);
  old.close();
  const migrated = new FleetStore(dbPath);
  try {
    const fleetColumns = migrated.db.prepare("PRAGMA table_info(fleets)").all().map((column) => column.name);
    assert.ok(fleetColumns.includes("max_workers"));
    assert.equal(migrated.db.prepare("SELECT max_workers FROM fleets WHERE canonical_root='/repo'").get().max_workers, 1);
    const admissionColumns = migrated.db.prepare("PRAGMA table_info(admissions)").all().map((column) => column.name);
    for (const column of ["state", "claimed_scopes", "baseline_cost", "baseline_head", "baseline_dirty", "timeout_ms", "elapsed_ms"]) {
      assert.ok(admissionColumns.includes(column), column);
    }
  } finally {
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing workers schemas migrate session identity additively", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-worker-migration-"));
  const dbPath = join(dir, "fleet.sqlite");
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE workers (
      canonical_root TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      session_dir TEXT NOT NULL,
      PRIMARY KEY (canonical_root, worker_id)
    );
    INSERT INTO workers(canonical_root, worker_id, session_dir) VALUES('/repo', 'w1', '/sessions');
  `);
  old.close();
  const migrated = new FleetStore(dbPath);
  try {
    const columns = migrated.db.prepare("PRAGMA table_info(workers)").all().map((column) => column.name);
    for (const column of ["session_id", "task", "model", "thinking", "context_window", "context_tokens", "cost", "turns", "tool_calls"]) {
      assert.ok(columns.includes(column), column);
    }
    const row = migrated.db.prepare("SELECT session_id,task,turns,tool_calls,cost FROM workers WHERE worker_id='w1'").get();
    assert.equal(row.session_id, null);
    assert.equal(row.task, null);
    assert.equal(row.turns, 0);
    assert.equal(row.tool_calls, 0);
    assert.equal(row.cost, 0);
    const indexes = migrated.db.prepare("PRAGMA index_list(workers)").all().map((index) => index.name);
    assert.ok(indexes.includes("workers_unique_session"));
  } finally {
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing evidence reservation schemas migrate campaign and launch receipt additively", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-reservation-migration-"));
  const dbPath = join(dir, "fleet.sqlite");
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE evidence_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_root TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      token TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt TEXT,
      created_at INTEGER NOT NULL,
      released_at INTEGER
    );
    INSERT INTO evidence_reservations(canonical_root,worker_id,generation,token,stage,status,created_at)
      VALUES('/repo','w1',1,'token','screen','receipt',1);
  `);
  old.close();
  const migrated = new FleetStore(dbPath);
  try {
    const columns = migrated.db.prepare("PRAGMA table_info(evidence_reservations)").all().map((column) => column.name);
    assert.ok(columns.includes("campaign"));
    assert.ok(columns.includes("launch_receipt"));
    const row = migrated.db.prepare("SELECT campaign,launch_receipt FROM evidence_reservations WHERE id=1").get();
    assert.equal(row.campaign, null);
    assert.equal(row.launch_receipt, null);
    const indexes = migrated.db.prepare("PRAGMA index_list(evidence_reservations)").all().map((index) => index.name);
    assert.ok(indexes.includes("evidence_one_active_per_campaign"));
  } finally {
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing checkpoint schemas migrate additively and expose exact continuation state", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-migration-"));
  const dbPath = join(dir, "fleet.sqlite");
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_root TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      campaign TEXT,
      hypothesis TEXT,
      stage TEXT,
      status TEXT,
      summary TEXT,
      findings TEXT NOT NULL,
      blockers TEXT NOT NULL,
      next_actions TEXT NOT NULL,
      run_ids TEXT NOT NULL,
      claimed_scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  old.close();
  const root = join(dir, "repo");
  const parent = new FleetStore(dbPath);
  const workerSeed = seed("w1", "token", dir);
  const generation = parent.beginFleet({ canonicalRoot: root, workers: [workerSeed] });
  const worker = new FleetStore(dbPath, {
    canonicalRoot: root,
    workerId: "w1",
    sessionId: workerSeed.sessionId,
    generation,
    token: "token",
  });
  try {
    worker.checkpoint({
      campaign: "campaign-1",
      candidateCommit: "a".repeat(40),
      championCommit: "b".repeat(40),
      continuationCommand: "scripts/launch-evidence --receipt run-1",
      launchReceipt: { pid: 123, statusPath: ".autoresearch/artifacts/runs/run-1/status.json" },
    });
    const checkpoint = parent.snapshot(root, { workerId: "w1" }).checkpoints[0];
    assert.equal(checkpoint.candidate_commit, "a".repeat(40));
    assert.equal(checkpoint.champion_commit, "b".repeat(40));
    assert.equal(checkpoint.continuation_command, "scripts/launch-evidence --receipt run-1");
    assert.deepEqual(checkpoint.launch_receipt, { pid: 123, statusPath: ".autoresearch/artifacts/runs/run-1/status.json" });
  } finally {
    worker.close();
    parent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launch synchronization resets complete worker bytes to the reviewed canonical commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-reviewed-bytes-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  const git = (args, cwd = root) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(root, "program.md"), "old program\n");
    writeFileSync(join(root, "controller.py"), "OLD = True\n");
    git(["add", "program.md", "controller.py"]);
    git(["commit", "-qm", "old bytes"]);
    const oldHead = git(["rev-parse", "HEAD"]);
    const lane = workerLanes(root, 1)[0];
    git(["worktree", "add", "-q", "-b", lane.branch, lane.path, oldHead]);

    writeFileSync(join(root, "program.md"), "reviewed program\n");
    writeFileSync(join(root, "controller.py"), "REVIEWED = True\n");
    git(["add", "program.md", "controller.py"]);
    git(["commit", "-qm", "reviewed bytes"]);
    const reviewedHead = git(["rev-parse", "HEAD"]);

    const result = syncLaneToCanonical({
      canonicalRoot: root,
      lane,
      generation: 1,
      canonicalHead: reviewedHead,
      now: 123,
    });
    assert.equal(result.canonicalHead, reviewedHead);
    assert.equal(git(["rev-parse", "HEAD"], lane.path), reviewedHead);
    assert.equal(git(["rev-parse", result.candidateRef], lane.path), oldHead);
    assert.equal(readFileSync(join(lane.path, "program.md"), "utf8"), "reviewed program\n");
    assert.equal(readFileSync(join(lane.path, "controller.py"), "utf8"), "REVIEWED = True\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi CLI resolution uses the installed package-root dist layout while allowing explicit test injection", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "autoresearch-pi-package-"));
  const cli = join(packageRoot, "dist", "cli.js");
  mkdirSync(join(packageRoot, "dist"));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  writeFileSync(cli, "// installed CLI fixture");
  try {
    assert.equal(resolvePiCliPath(undefined, packageRoot), cli);
    assert.equal(resolvePiCliPath(cli), cli);
    assert.throws(() => resolvePiCliPath(undefined, join(packageRoot, "missing")), /dist\/cli\.js path/i);
    assert.throws(() => resolvePiCliPath("relative/cli.js"), /absolute dist\/cli\.js path/i);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("numeric command parsing is strict and bounded at the four-worker contract", () => {
  assert.equal(MAX_AUTORESEARCH_WORKERS, 4);
  assert.equal(parseAutoresearchFleetCount("4"), 4);
  assert.equal(parseAutoresearchFleetCount(` ${MAX_AUTORESEARCH_WORKERS} `), MAX_AUTORESEARCH_WORKERS);
  for (const value of ["", "0", "5", "9", "4x", "on", "-1", "1.5"]) {
    assert.equal(parseAutoresearchFleetCount(value), undefined, value);
  }
});

function createParentHarness(options) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const widgets = [];
  const statuses = [];
  const sentMessages = [];
  const sentMessageOptions = [];
  let activeTools = ["read", "bash"];

  const addHandler = (name, handler) => {
    const values = handlers.get(name) ?? [];
    values.push(handler);
    handlers.set(name, values);
  };
  const pi = {
    on: addHandler,
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    getActiveTools: () => [...new Set(activeTools)],
    setActiveTools(names) { activeTools = [...names]; },
    getThinkingLevel: () => "high",
    appendEntry() {},
    sendUserMessage(message, options) { sentMessages.push(message); sentMessageOptions.push(options); },
    events: { on: () => () => {} },
  };
  const ctx = {
    cwd: options.cwd,
    hasUI: true,
    mode: "tui",
    model: { provider: "test-provider", id: "test-model" },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    compact() {},
    sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getBranch: () => [] },
    ui: {
      theme: { fg: (_color, value) => value },
      notify(message, type) { notifications.push({ message, type }); },
      setWidget(key, value, widgetOptions) { widgets.push({ key, value, options: widgetOptions }); },
      setStatus(key, value) { statuses.push({ key, value }); },
    },
  };
  const emit = async (name, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };

  registerAutoresearch(pi, { supervisor: options.supervisor });
  return { pi, ctx, handlers, commands, tools, notifications, widgets, statuses, sentMessages, sentMessageOptions, emit, activeTools: () => activeTools };
}

class FakeRpcClient {
  constructor(options, records) {
    this.options = options;
    this.records = records;
    this.events = [];
    this.stopped = false;
    this.aborted = false;
    records.clients.push(this);
  }
  onEvent(listener) { this.records.order.push(`listen:${this.options.env.AUTORESEARCH_WORKER_ID}`); this.events.push(listener); return () => { this.events = []; }; }
  async start() {
    const sessionDir = this.options.args[this.options.args.indexOf("--session-dir") + 1];
    const sessionId = this.options.args[this.options.args.indexOf("--session-id") + 1];
    const header = readdirSync(sessionDir).map((file) => {
      try {
        const firstLine = readFileSync(join(sessionDir, file), "utf8").split("\n", 1)[0];
        return JSON.parse(firstLine);
      } catch {
        return undefined;
      }
    }).find((value) => value?.id === sessionId);
    this.records.sessionPreparedAtStart.push({ sessionId, header });
    this.records.order.push(`start:${this.options.env.AUTORESEARCH_WORKER_ID}`);
  }
  async getState() {
    const sessionDir = this.options.args[this.options.args.indexOf("--session-dir") + 1];
    const sessionId = this.options.args[this.options.args.indexOf("--session-id") + 1];
    return { isStreaming: false, sessionFile: join(sessionDir, `fixture_${sessionId}.jsonl`) };
  }
  async prompt(message) {
    this.records.order.push(`prompt:${this.options.env.AUTORESEARCH_WORKER_ID}`);
    if (message.startsWith("Campaign admission is accepted.")) {
      this.records.executionPrompts.push(message);
      const env = this.options.env;
      const store = new FleetStore(env.AUTORESEARCH_FLEET_DB, {
        canonicalRoot: env.AUTORESEARCH_CANONICAL_ROOT,
        workerId: env.AUTORESEARCH_WORKER_ID,
        sessionId: env.AUTORESEARCH_SESSION_ID,
        generation: Number(env.AUTORESEARCH_GENERATION),
        token: env.AUTORESEARCH_WORKER_TOKEN,
      });
      store.workerHeartbeat({ status: "running" });
      store.close();
    } else this.records.prompts.push(message);
    if (this.records.autoAdmission && message.includes("bounded admission planner")) this.admit();
  }
  admit(settle = true) {
    const env = this.options.env;
    const portfolioPath = join(env.AUTORESEARCH_CANONICAL_ROOT, ".autoresearch", "portfolio.json");
    let portfolio = {
      schema_version: 2,
      revision: 0,
      active_assignments: {},
      paused: false,
      pause_reason: null,
      hypotheses: {},
      history: [],
    };
    if (existsSync(portfolioPath)) portfolio = JSON.parse(readFileSync(portfolioPath, "utf8"));
    const hypothesis = `hypothesis-${env.AUTORESEARCH_WORKER_ID}`;
    const campaign = `campaign-${env.AUTORESEARCH_WORKER_ID}`;
    portfolio.revision += 1;
    portfolio.hypotheses[hypothesis] = { status: "active" };
    portfolio.active_assignments[env.AUTORESEARCH_WORKER_ID] = {
      worker_id: env.AUTORESEARCH_WORKER_ID,
      campaign_id: campaign,
      hypothesis_id: hypothesis,
      worker_token_sha256: createHash("sha256").update(env.AUTORESEARCH_WORKER_TOKEN).digest("hex"),
    };
    writeFileSync(portfolioPath, `${JSON.stringify(portfolio)}\n`);
    const store = new FleetStore(env.AUTORESEARCH_FLEET_DB, {
      canonicalRoot: env.AUTORESEARCH_CANONICAL_ROOT,
      workerId: env.AUTORESEARCH_WORKER_ID,
      sessionId: env.AUTORESEARCH_SESSION_ID,
      generation: Number(env.AUTORESEARCH_GENERATION),
      token: env.AUTORESEARCH_WORKER_TOKEN,
    });
    store.offerAdmission({
      campaign,
      hypothesis,
      stage: "admission",
      summary: `Admitted ${env.AUTORESEARCH_WORKER_ID}`,
      claimedScopes: [`campaign:${env.AUTORESEARCH_WORKER_ID}`],
    }, 5_000);
    store.close();
    for (const listener of this.events) listener({ type: "tool_execution_end", toolName: "autoresearch_worker_state", isError: false });
    for (const listener of this.events) listener({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Admission offer published." }] },
    });
    if (settle) for (const listener of this.events) listener({ type: "agent_settled" });
  }
  async steer(message) { this.records.steers.push(message); }
  async followUp(message) { this.records.followUps.push(message); }
  async abort() { this.aborted = true; }
  async stop() { this.stopped = true; }
}

function createSupervisorFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-supervisor-"));
  const root = join(dir, "skills-autoresearch");
  mkdirSync(root);
  if (options.program === "empty") {
    writeFileSync(join(root, "program.md"), " \n\t");
  } else if (options.program === "symlink") {
    writeFileSync(join(root, "program-target.md"), "# Unsafe indirection\n");
    symlinkSync("program-target.md", join(root, "program.md"));
  } else if (options.program === "directory") {
    mkdirSync(join(root, "program.md"));
  } else if (options.program !== "missing") {
    writeFileSync(join(root, "program.md"), "# Safe test program\nNo external research.");
  }
  writeFileSync(join(root, "controller.py"), "REVIEWED_CONTROLLER = True\n");
  const records = {
    clients: [],
    order: [],
    prompts: [],
    executionPrompts: [],
    steers: [],
    followUps: [],
    syncs: [],
    launchSyncs: [],
    ensuredLanes: [],
    storePaths: [],
    sessionPreparedAtStart: [],
    autoAdmission: options.autoAdmission ?? true,
  };
  const extensionPath = resolve("configs/pi/extensions/autoresearch.ts");
  const supervisor = {
    createRpcClient: (options) => new FakeRpcClient(options, records),
    inspectRepo: () => ({
      canonicalRoot: root,
      commonDir: join(root, ".git"),
      head: "1234567890abcdef",
      dirty: options.dirty ?? false,
      maxEvidenceStages: 2,
    }),
    ensureIgnored: () => {},
    ensureLane: (_canonical, _common, lane) => {
      records.ensuredLanes.push(lane.workerId);
      mkdirSync(lane.path, { recursive: true });
      writeFileSync(join(lane.path, "program.md"), "# Safe worker test program");
      writeFileSync(join(lane.path, "controller.py"), "STALE_CONTROLLER = True\n");
      return lane;
    },
    laneState: () => options.laneState?.() ?? ({ head: options.laneHead ?? "1234567890abcdef", dirty: options.laneDirty ?? false }),
    syncLane: (input) => {
      if (input.canonicalHead) {
        records.launchSyncs.push(input.lane.workerId);
        for (const file of ["program.md", "controller.py"]) {
          writeFileSync(join(input.lane.path, file), readFileSync(join(root, file), "utf8"));
        }
      } else {
        records.syncs.push(input.lane.workerId);
      }
      return {
        candidateRef: `refs/autoresearch/candidates/${input.lane.workerId}/saved`,
        canonicalHead: input.canonicalHead ?? "canonical-head",
      };
    },
    createStore: (path) => {
      records.storePaths.push(path);
      return new FleetStore(path);
    },
    cliPath: process.execPath,
    extensionPath,
    dashboardIntervalMs: 0,
    sessionVersion: 3,
    admissionTimeoutMs: options.admissionTimeoutMs ?? 0,
    admissionMaxCostUsd: options.admissionMaxCostUsd,
    admissionMaxTurns: options.admissionMaxTurns,
    admissionMaxToolCalls: options.admissionMaxToolCalls,
    planningProvider: options.useParentPlanningModel ? undefined : "test-provider",
    planningModel: options.useParentPlanningModel ? undefined : "test-model",
    planningThinking: options.useParentPlanningModel ? undefined : "high",
    token: (() => { let id = 0; return () => `token-${++id}`; })(),
    sessionId: (() => {
      let id = 0;
      const ids = options.sessionIds;
      return () => {
        const next = ids?.[id] ?? testSessionId(100 + id);
        id += 1;
        return next;
      };
    })(),
    now: () => 5_000,
  };
  const harness = createParentHarness({ cwd: root, supervisor });
  return { dir, root, records, harness, supervisor };
}

test("worker role requires and exposes a valid session UUID independently of its fence token", () => {
  const env = {
    AUTORESEARCH_CANONICAL_ROOT: "/repo",
    AUTORESEARCH_WORKER_ID: "w1",
    AUTORESEARCH_SESSION_ID: testSessionId(1),
    AUTORESEARCH_WORKER_TOKEN: "fence-token",
    AUTORESEARCH_STATE_DIR: "/state",
    AUTORESEARCH_FLEET_DB: "/state/fleet.sqlite",
    AUTORESEARCH_GENERATION: "3",
  };
  const parsed = workerIdentityFromEnv(env);
  assert.equal(parsed.identity.sessionId, testSessionId(1));
  assert.equal(parsed.identity.token, "fence-token");
  assert.throws(() => workerIdentityFromEnv({ ...env, AUTORESEARCH_SESSION_ID: "bad" }), /invalid.*session UUID/i);
  assert.throws(() => workerIdentityFromEnv({ ...env, AUTORESEARCH_SESSION_ID: undefined }), /incomplete.*identity environment/i);
});

test("bundled program-design skill is registered only for parent sessions", async () => {
  const fixture = createSupervisorFixture();
  try {
    const resourceResults = await fixture.harness.emit("resources_discover", { cwd: fixture.root, reason: "startup" });
    const skillPaths = resourceResults.flatMap((result) => result?.skillPaths ?? []);
    assert.deepEqual(skillPaths, [AUTORESEARCH_PROGRAM_DESIGN_SKILL_PATH]);
    assert.ok(isAbsolute(skillPaths[0]));
    assert.ok(existsSync(skillPaths[0]));

    const skill = readFileSync(skillPaths[0], "utf8");
    assert.match(skill, /^---\nname: autoresearch-program-design\ndescription: .+\n---\n/);
    assert.match(skill, /\(assets\/program-template\.md\)/);
    assert.match(skill, /\(references\/benchmark-design\.md\)/);
    assert.match(skill, /\(assets\/benchmark-contract-template\.md\)/);

    const workerHandlers = new Map();
    const workerPi = {
      on(name, handler) {
        const values = workerHandlers.get(name) ?? [];
        values.push(handler);
        workerHandlers.set(name, values);
      },
      registerTool() {},
      getActiveTools: () => ["read"],
      setActiveTools() {},
      sendUserMessage() {},
    };
    const previousRole = process.env.AUTORESEARCH_ROLE;
    process.env.AUTORESEARCH_ROLE = "worker";
    try {
      registerAutoresearch(workerPi, {
        worker: {
          env: {
            AUTORESEARCH_CANONICAL_ROOT: fixture.root,
            AUTORESEARCH_WORKER_ID: "w1",
            AUTORESEARCH_SESSION_ID: testSessionId(1),
            AUTORESEARCH_WORKER_TOKEN: "token",
            AUTORESEARCH_STATE_DIR: fixture.dir,
            AUTORESEARCH_FLEET_DB: join(fixture.dir, "unused.sqlite"),
            AUTORESEARCH_GENERATION: "1",
          },
          createStore: () => ({}),
        },
      });
    } finally {
      if (previousRole === undefined) delete process.env.AUTORESEARCH_ROLE;
      else process.env.AUTORESEARCH_ROLE = previousRole;
    }
    assert.equal(workerHandlers.has("resources_discover"), false);
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("missing program queues one collaborative skill setup turn without provisioning fleet state", async () => {
  const fixture = createSupervisorFixture({ program: "missing" });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    const command = fixture.harness.commands.get("autoresearch");
    await command.handler("3", fixture.harness.ctx);
    await command.handler("3", fixture.harness.ctx);
    await tick();

    assert.equal(fixture.harness.sentMessages.length, 1);
    assert.match(fixture.harness.sentMessages[0], /^\/skill:autoresearch-program-design \S/);
    assert.equal(fixture.records.clients.length, 0);
    assert.equal(fixture.records.ensuredLanes.length, 0);
    assert.equal(fixture.records.launchSyncs.length, 0);
    assert.equal(fixture.records.storePaths.length, 0);
    assert.equal(existsSync(join(fixture.root, ".autoresearch")), false);
    assert.ok(!fixture.harness.notifications.some((item) => /^Launching /i.test(item.message)));
    assert.match(fixture.harness.notifications[0].message, /setup is required/i);
    assert.match(fixture.harness.notifications.at(-1).message, /already queued or running/i);
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_inspect"));
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"));
    assert.ok(fixture.harness.activeTools().includes("read"));
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("empty, nonregular, and symlink program files fail safely before provisioning", async () => {
  for (const program of ["empty", "directory", "symlink"]) {
    const fixture = createSupervisorFixture({ program });
    try {
      await fixture.harness.emit("session_start", { reason: "startup" });
      await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
      await tick();

      assert.equal(fixture.harness.sentMessages.length, 0, program);
      assert.equal(fixture.records.clients.length, 0, program);
      assert.equal(fixture.records.ensuredLanes.length, 0, program);
      assert.equal(fixture.records.storePaths.length, 0, program);
      assert.equal(existsSync(join(fixture.root, ".autoresearch")), false, program);
      assert.ok(!fixture.harness.notifications.some((item) => /^Launching /i.test(item.message)), program);
      assert.match(fixture.harness.notifications.at(-1).message, /program\.md must (?:not be empty|be a regular, nonsymlink file)/i, program);
      assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"), program);
    } finally {
      await fixture.harness.emit("session_shutdown", { reason: "quit" });
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
});

test("/autoresearch N fails before launch when the canonical checkout is dirty", async () => {
  const fixture = createSupervisorFixture({ dirty: true });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.harness.notifications.some((item) => /commit the reviewed program and controller changes before launching/i.test(item.message)));
    assert.equal(fixture.records.clients.length, 0);
    assert.equal(fixture.records.launchSyncs.length, 0);
    assert.equal(existsSync(join(fixture.root, ".autoresearch")), false);
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"));
    assert.ok(fixture.harness.activeTools().includes("read"));
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("fleet capacity resumes noncontiguous active portfolio owners before allocating fresh lanes", async () => {
  const fixture = createSupervisorFixture({ laneHead: "retained-campaign-head" });
  const stateDir = join(fixture.root, ".autoresearch");
  mkdirSync(stateDir, { recursive: true });
  const previous = new FleetStore(join(stateDir, "fleet.sqlite"));
  const previousWorker = {
    workerId: "w4",
    sessionId: testSessionId(44),
    token: "retained-w4-token",
    worktree: join(fixture.dir, "old-w4"),
    branch: "autoresearch/worker-4",
    sessionsRoot: join(stateDir, "sessions"),
  };
  const generation = previous.beginFleet({ canonicalRoot: fixture.root, workers: [previousWorker], now: 100 });
  previous.parentUpdateWorker(fixture.root, "w4", { status: "stopped" }, 101);
  previous.setFleetStatus(fixture.root, "stopped", 102);
  previous.close();
  writePortfolio(fixture.root, [previousWorker]);
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const client = fixture.records.clients[0];
    assert.equal(client.options.env.AUTORESEARCH_WORKER_ID, "w4");
    assert.equal(client.options.env.AUTORESEARCH_WORKER_TOKEN, "retained-w4-token");
    assert.equal(Number(client.options.env.AUTORESEARCH_GENERATION), generation + 1);
    const store = new FleetStore(join(stateDir, "fleet.sqlite"));
    const snapshot = store.snapshot(fixture.root);
    assert.equal(snapshot.fleet.max_workers, 1);
    assert.deepEqual(snapshot.workers.map((worker) => worker.worker_id), ["w4"]);
    assert.equal(snapshot.admissions[0].state, "admitted");
    assert.equal(snapshot.workers[0].status, "running");
    store.close();
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("/autoresearch 4 starts isolated persistent RPC workers asynchronously without taking over the parent", async () => {
  const fixture = createSupervisorFixture({ useParentPlanningModel: true });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"));

    const commandPromise = fixture.harness.commands.get("autoresearch").handler("4", fixture.harness.ctx);
    await commandPromise;
    await waitFor(() => fixture.records.prompts.length === 4);
    await waitFor(() => fixture.records.executionPrompts.length === 4);

    assert.equal(fixture.records.clients.length, 4);
    assert.deepEqual(fixture.records.launchSyncs, ["w1", "w2", "w3", "w4"]);
    assert.ok(fixture.records.prompts.every((prompt) => prompt.includes("# Safe test program")));
    assert.ok(fixture.records.prompts.every((prompt) => !prompt.includes("# Safe worker test program")));
    assert.ok(fixture.records.clients.every((client) =>
      readFileSync(join(client.options.cwd, "controller.py"), "utf8") === "REVIEWED_CONTROLLER = True\n"));
    assert.equal(fixture.harness.sentMessages.length, 0, "parent continuation loop was not entered");
    assert.ok(fixture.harness.activeTools().includes("autoresearch_inspect"));
    assert.ok(fixture.harness.activeTools().includes("autoresearch_control"));
    assert.ok(fixture.harness.activeTools().includes("read"));

    const worktrees = new Set();
    for (const client of fixture.records.clients) {
      const id = client.options.env.AUTORESEARCH_WORKER_ID;
      worktrees.add(client.options.cwd);
      assert.equal(client.options.cliPath, process.execPath);
      assert.equal(client.options.provider, "test-provider");
      assert.equal(client.options.model, "test-model");
      assert.equal(client.options.env.AUTORESEARCH_ROLE, "worker");
      assert.equal(client.options.env.AUTORESEARCH_CANONICAL_ROOT, fixture.root);
      assert.match(client.options.env.AUTORESEARCH_SESSION_ID, UUID_V4);
      assert.equal(client.options.env.AUTORESEARCH_FLEET_DB, join(fixture.root, ".autoresearch", "fleet.sqlite"));
      assert.equal(client.options.env.AUTORESEARCH_ARTIFACTS_DIR, join(fixture.root, ".autoresearch", "artifacts", "runs"));
      assert.ok(client.options.env.AUTORESEARCH_WORKER_TOKEN);
      assert.ok(client.options.args.includes("--no-extensions"));
      assert.ok(client.options.args.includes("--extension"));
      assert.ok(!client.options.args.includes("--session"));
      assert.ok(client.options.args.includes("--session-id"));
      assert.ok(client.options.args.includes("--session-dir"));
      assert.equal(client.options.args[client.options.args.indexOf("--session-id") + 1], client.options.env.AUTORESEARCH_SESSION_ID);
      assert.equal(
        client.options.args[client.options.args.indexOf("--session-dir") + 1],
        join(fixture.root, ".autoresearch", "sessions", "generation-1"),
      );
      const name = client.options.args[client.options.args.indexOf("--name") + 1];
      assert.match(name, new RegExp(`${id} ${client.options.env.AUTORESEARCH_SESSION_ID.slice(0, 8)}$`));
      assert.ok(client.options.args.includes("--thinking"));
      assert.ok(fixture.records.order.indexOf(`listen:${id}`) < fixture.records.order.indexOf(`prompt:${id}`));
    }
    assert.equal(worktrees.size, 4);
    assert.match([...worktrees][0], /skills-autoresearch-worker-/);
    const sessionIds = fixture.records.clients.map((client) => client.options.env.AUTORESEARCH_SESSION_ID);
    assert.equal(new Set(sessionIds).size, 4);
    assert.ok(sessionIds.every((id) => UUID_V4.test(id)));
    assert.deepEqual(
      fixture.records.sessionPreparedAtStart.map(({ sessionId, header }) => ({
        sessionId,
        type: header?.type,
        version: header?.version,
        id: header?.id,
        cwd: header?.cwd,
      })),
      fixture.records.clients.map((client) => ({
        sessionId: client.options.env.AUTORESEARCH_SESSION_ID,
        type: "session",
        version: 3,
        id: client.options.env.AUTORESEARCH_SESSION_ID,
        cwd: client.options.cwd,
      })),
      "each valid persistent session header exists before its RPC process starts",
    );
    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const persisted = store.snapshot(fixture.root);
    assert.deepEqual(persisted.workers.map((worker) => worker.session_id), sessionIds);
    assert.ok(persisted.workers.every((worker) => worker.session_dir === join(fixture.root, ".autoresearch", "sessions", "generation-1")));
    assert.ok(persisted.workers.every((worker) => worker.model === "test-provider/test-model"));
    assert.ok(persisted.workers.every((worker) => worker.thinking === "high"));
    assert.ok(fixture.records.executionPrompts.every((prompt) => prompt.includes("Begin a fresh execution phase")));
    assert.deepEqual(persisted.workers.map((worker) => worker.task), ["hypothesis-w1", "hypothesis-w2", "hypothesis-w3", "hypothesis-w4"]);
    store.close();
    assert.ok(existsSync(join(fixture.root, ".autoresearch", "artifacts", "runs")));

    fixture.harness.commands.get("autoresearch").handler("4", fixture.harness.ctx);
    await tick();
    assert.equal(fixture.records.clients.length, 4, "duplicate command did not launch more clients");
    assert.match(fixture.harness.notifications.at(-1).message, /already launching or active/i);

    const widget = fixture.harness.widgets.find((item) => typeof item.value === "function");
    assert.equal(widget.options.placement, "belowEditor");
    const component = widget.value(
      { requestRender() {} },
      { fg: (_color, value) => value, bold: (value) => value },
    );
    const widgetLines = component.render(220);
    assert.equal(widgetLines.length, 5);
    assert.match(widgetLines[0], /^┌─ autoresearch · active · 4 workers · evidence 0\/2/);
    assert.match(widgetLines[1], new RegExp(`^├─ \\[w1:${sessionIds[0].slice(0, 8)}\\] ● running\\s+`));
    assert.match(widgetLines[1], /0 turns │ hypothesis-w1 · Admitted w1 │ test-model · High · \$0\.000 · 0 tools/);
    assert.match(component.render(100)[1], /0 turns │ hypothesis-w1/);
    assert.match(widgetLines.at(-1), /^└─ \[w4:/);

    const inspect = fixture.harness.tools.get("autoresearch_inspect");
    const inspection = await inspect.execute("inspect", { scope: "all", view: "summary" });
    assert.equal(inspection.details.workers[0].session_id, sessionIds[0]);

    const contextResults = await fixture.harness.emit("before_agent_start", { prompt: "parent request" });
    const context = contextResults.find((value) => value?.message?.customType === "autoresearch-fleet-snapshot");
    assert.match(context.message.content, /Evidence capacity: 0\/2/);
    assert.doesNotMatch(context.message.content, /Safe worker test program/);

    await fixture.harness.commands.get("autoresearch").handler("", fixture.harness.ctx);
    assert.match(fixture.harness.notifications.at(-1).message, /stopped autoresearch fleet/i);
    assert.ok(fixture.records.clients.every((client) => client.stopped));
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"));
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("fleet workers enter campaign admission sequentially", async () => {
  const fixture = createSupervisorFixture({ autoAdmission: false, admissionTimeoutMs: 60_000 });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("4", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);

    assert.equal(fixture.records.clients.length, 1);
    assert.match(fixture.records.prompts[0], /bounded admission planner/);
    assert.match(fixture.records.prompts[0], /60 seconds, 8 model turns, 16 tool calls, and \$0\.50/);
    let store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    let workers = store.snapshot(fixture.root).workers;
    assert.equal(workers[0].status, "idle");
    assert.ok(workers.slice(1).every((worker) => worker.status === "queued"));
    store.close();

    fixture.records.clients[0].admit();
    await waitFor(() => fixture.records.prompts.length === 2);
    assert.equal(fixture.records.clients.length, 2);
    store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    workers = store.snapshot(fixture.root).workers;
    assert.equal(workers[0].status, "running");
    assert.equal(store.snapshot(fixture.root, { workerId: "w1", recent: 1 }).admissions[0].state, "admitted");
    assert.equal(workers[1].status, "idle");
    assert.ok(workers.slice(2).every((worker) => worker.status === "queued"));
    store.close();
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("stopping an active planner reconciles its admission and starts the next queued lane", async () => {
  const fixture = createSupervisorFixture({ autoAdmission: false, admissionTimeoutMs: 60_000 });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);

    const control = fixture.harness.tools.get("autoresearch_control");
    await control.execute("stop-planner", { action: "stop", target: "w1" });
    await waitFor(() => fixture.records.prompts.length === 2);

    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const snapshot = store.snapshot(fixture.root);
    assert.equal(snapshot.workers.find((worker) => worker.worker_id === "w1").status, "stopped");
    assert.equal(snapshot.admissions.find((admission) => admission.worker_id === "w1").state, "blocked");
    assert.equal(snapshot.workers.find((worker) => worker.worker_id === "w2").status, "idle");
    assert.equal(snapshot.admissions.find((admission) => admission.worker_id === "w2").state, "planning");
    store.close();
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("accepted admission decisions stay internal while later scientific decisions reach the parent", async () => {
  const fixture = createSupervisorFixture({ autoAdmission: false });
  let worker;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const client = fixture.records.clients[0];
    client.admit(false);
    await waitFor(() => {
      const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
      const state = store.snapshot(fixture.root, { workerId: "w1", recent: 2 }).admissions[0]?.state;
      store.close();
      return state === "admitted";
    });
    assert.equal(fixture.harness.sentMessages.length, 0, "admission handshake is not parent attention work");

    worker = new FleetStore(client.options.env.AUTORESEARCH_FLEET_DB, {
      canonicalRoot: fixture.root,
      workerId: "w1",
      sessionId: client.options.env.AUTORESEARCH_SESSION_ID,
      generation: Number(client.options.env.AUTORESEARCH_GENERATION),
      token: client.options.env.AUTORESEARCH_WORKER_TOKEN,
    });
    worker.checkpoint({
      campaign: "campaign-w1",
      hypothesis: "hypothesis-w1",
      stage: "scout",
      status: "decision",
      summary: "Scientific review required",
      claimedScopes: ["campaign:w1"],
    }, 5_100);
    for (const listener of client.events) listener({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Scientific review required" }] },
    });
    await waitFor(() => fixture.harness.sentMessages.length === 1);
    assert.match(fixture.harness.sentMessages[0], /w1 decision: Scientific review required/);
  } finally {
    worker?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("planner mutation rejects an otherwise valid offer before starting the next lane", async () => {
  let laneState = { head: "1234567890abcdef", dirty: false };
  const fixture = createSupervisorFixture({ autoAdmission: false, laneState: () => laneState });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    laneState = { ...laneState, dirty: true };
    fixture.records.clients[0].admit();
    await waitFor(() => fixture.records.prompts.length === 2);
    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const snapshot = store.snapshot(fixture.root, { recent: 1 });
    assert.equal(snapshot.workers[0].status, "blocked");
    assert.match(String(snapshot.workers[0].error), /mutated candidate state/i);
    assert.equal(snapshot.admissions[1].state, "planning");
    store.close();
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("admission budget exhaustion blocks one planner before starting the next", async () => {
  const fixture = createSupervisorFixture({ autoAdmission: false, admissionMaxCostUsd: 0.1 });
  let worker;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const client = fixture.records.clients[0];
    worker = new FleetStore(client.options.env.AUTORESEARCH_FLEET_DB, {
      canonicalRoot: fixture.root,
      workerId: "w1",
      sessionId: client.options.env.AUTORESEARCH_SESSION_ID,
      generation: Number(client.options.env.AUTORESEARCH_GENERATION),
      token: client.options.env.AUTORESEARCH_WORKER_TOKEN,
    });
    worker.recordTurnUsage({ cost: 0.11, contextTokens: 100 }, 5_001);
    for (const listener of client.events) listener({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "still planning" }] },
    });
    await waitFor(() => fixture.records.prompts.length === 2);
    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const snapshot = store.snapshot(fixture.root, { recent: 1 });
    assert.equal(snapshot.workers[0].status, "blocked");
    assert.equal(snapshot.admissions[0].state, "blocked");
    assert.equal(snapshot.admissions[1].state, "planning");
    store.close();
  } finally {
    worker?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("worker failures are queued to the parent as follow-ups instead of UI errors", async () => {
  const fixture = createSupervisorFixture({ autoAdmission: false });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);

    const client = fixture.records.clients[0];
    for (const listener of client.events) listener({ type: "extension_error", error: "integrity boundary reached" });
    await waitFor(() => fixture.harness.sentMessages.length === 1);

    assert.match(fixture.harness.sentMessages[0], /^\[autoresearch fleet transition; operational state, not Git truth\]/);
    assert.match(fixture.harness.sentMessages[0], /w1 failed: integrity boundary reached/);
    assert.deepEqual(fixture.harness.sentMessageOptions[0], { deliverAs: "followUp" });
    assert.ok(!fixture.harness.notifications.some(({ message, type }) => type === "error" && /w1 failed/i.test(message)));

    for (const listener of client.events) listener({ type: "extension_error", error: "integrity boundary reached" });
    await tick();
    assert.equal(fixture.harness.sentMessages.length, 1, "a terminal state is queued only once");
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("parent shutdown aborts and stops every RPC worker, pauses durable state, and removes control UI", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 2);
    await fixture.harness.emit("session_shutdown", { reason: "quit" });

    assert.ok(fixture.records.clients.every((client) => client.aborted && client.stopped));
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_inspect"));
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"));
    assert.ok(fixture.harness.activeTools().includes("read"));
    assert.equal(fixture.harness.widgets.at(-1).value, undefined);

    const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    const snapshot = store.snapshot(fixture.root);
    assert.equal(snapshot.fleet.status, "paused");
    assert.ok(snapshot.workers.every((worker) => worker.status === "paused"));
    store.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("session reload restores a paused fleet dashboard before the first user message", async () => {
  const fixture = createSupervisorFixture();
  let restored;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 2);
    await waitFor(() => {
      const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
      const admitted = store.snapshot(fixture.root, { recent: 1 }).admissions.every((item) => item.state === "admitted");
      store.close();
      return admitted;
    });
    await waitFor(() => {
      const store = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
      const status = store.snapshot(fixture.root, { workerId: "w1", recent: 1 }).workers[0]?.status;
      store.close();
      return status === "running";
    });
    for (const listener of fixture.records.clients[0].events) {
      listener({ type: "extension_error", error: "terminal worker failure" });
    }
    await waitFor(() => fixture.harness.sentMessages.length === 1);
    await fixture.harness.emit("session_shutdown", { reason: "reload" });

    restored = createParentHarness({ cwd: fixture.root, supervisor: fixture.supervisor });
    await restored.emit("session_start", { reason: "reload" });

    assert.equal(restored.sentMessages.length, 0);
    assert.ok(restored.activeTools().includes("autoresearch_inspect"));
    assert.ok(restored.activeTools().includes("autoresearch_control"));
    const widget = restored.widgets.find((item) => typeof item.value === "function");
    const component = widget.value(
      { requestRender() {} },
      { fg: (_color, value) => value, bold: (value) => value },
    );
    const lines = component.render(220);
    assert.match(lines[0], /^┌─ autoresearch · paused · 2 workers/);
    assert.match(lines[1], /× failed/, "reload preserves terminal worker state");
    assert.match(lines[2], /■ paused/);

    await restored.commands.get("autoresearch").handler("status", restored.ctx);
    assert.match(restored.notifications.at(-1).message, /fleet is paused, generation 1, 2 workers/i);
  } finally {
    if (restored) await restored.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("parent control resolves lane ids, full session UUIDs, and unambiguous UUID prefixes", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 2);
    const control = fixture.harness.tools.get("autoresearch_control");
    const [first, second] = fixture.records.clients;

    const laneResult = await control.execute("lane", { action: "steer", target: "w1", message: "lane" });
    assert.deepEqual(laneResult.details.targets, ["w1"]);
    const fullResult = await control.execute("full", {
      action: "steer",
      target: second.options.env.AUTORESEARCH_SESSION_ID,
      message: "full",
    });
    assert.deepEqual(fullResult.details.targets, ["w2"]);
    const prefix = first.options.env.AUTORESEARCH_SESSION_ID.replaceAll("-", "").slice(0, 8);
    const prefixResult = await control.execute("prefix", { action: "steer", target: prefix, message: "prefix" });
    assert.deepEqual(prefixResult.details.targets, ["w1"]);
    assert.deepEqual(fixture.records.steers, ["lane", "full", "prefix"]);
    await assert.rejects(
      () => control.execute("unknown", { action: "steer", target: "ffffffff", message: "unknown" }),
      /unknown worker session UUID prefix/i,
    );
    await assert.rejects(
      () => control.execute("short", { action: "steer", target: "0000001", message: "short" }),
      /unknown worker target/i,
    );
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("parent control rejects ambiguous session UUID prefixes", async () => {
  const fixture = createSupervisorFixture({
    sessionIds: [testSessionId(1, "deadbeef"), testSessionId(2, "deadbeef")],
  });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 2);
    const control = fixture.harness.tools.get("autoresearch_control");
    await assert.rejects(
      () => control.execute("ambiguous", { action: "steer", target: "deadbeef", message: "ambiguous" }),
      /ambiguous worker session UUID prefix/i,
    );
    assert.deepEqual(fixture.records.steers, []);
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("parent RPC progress events do not overwrite a worker terminal checkpoint", async () => {
  const fixture = createSupervisorFixture();
  let workerStore;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const client = fixture.records.clients[0];
    workerStore = new FleetStore(client.options.env.AUTORESEARCH_FLEET_DB, {
      canonicalRoot: fixture.root,
      workerId: "w1",
      sessionId: client.options.env.AUTORESEARCH_SESSION_ID,
      generation: Number(client.options.env.AUTORESEARCH_GENERATION),
      token: client.options.env.AUTORESEARCH_WORKER_TOKEN,
    });
    workerStore.checkpoint({
      campaign: "campaign",
      hypothesis: "hypothesis",
      stage: "decision",
      status: "decision",
      summary: "Awaiting operator decision",
    });
    for (const listener of client.events) listener({ type: "tool_execution_start", toolName: "autoresearch_worker_state" });
    const inspection = await fixture.harness.tools.get("autoresearch_inspect").execute("inspect", {
      scope: "worker",
      worker: "w1",
      view: "summary",
    });
    assert.equal(inspection.details.workers[0].status, "decision");
  } finally {
    workerStore?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("parent RPC errors do not overwrite a terminal worker checkpoint", async () => {
  const fixture = createSupervisorFixture();
  let workerStore;
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const client = fixture.records.clients[0];
    workerStore = new FleetStore(client.options.env.AUTORESEARCH_FLEET_DB, {
      canonicalRoot: fixture.root,
      workerId: "w1",
      sessionId: client.options.env.AUTORESEARCH_SESSION_ID,
      generation: Number(client.options.env.AUTORESEARCH_GENERATION),
      token: client.options.env.AUTORESEARCH_WORKER_TOKEN,
    });
    workerStore.checkpoint({
      campaign: "campaign",
      stage: "decision",
      status: "decision",
      summary: "Terminal decision",
      blockers: ["preserved blocker"],
    });
    for (const listener of client.events) {
      listener({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "late agent error" }],
      });
      listener({ type: "extension_error", error: "late extension error" });
    }
    const worker = workerStore.snapshot(fixture.root, { workerId: "w1" }).workers[0];
    assert.equal(worker.status, "decision");
    assert.equal(worker.summary, "Terminal decision");
    assert.equal(worker.error, "preserved blocker");
    assert.equal(worker.current_tool, null);
  } finally {
    workerStore?.close();
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("sync fails closed with active evidence and preserves a candidate ref after explicit reconciliation", async () => {
  const fixture = createSupervisorFixture({ autoAdmission: false });
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const control = fixture.harness.tools.get("autoresearch_control");
    await control.execute("pause", { action: "pause", target: "w1" });

    const client = fixture.records.clients[0];
    const workerStore = new FleetStore(client.options.env.AUTORESEARCH_FLEET_DB, {
      canonicalRoot: fixture.root,
      workerId: "w1",
      generation: Number(client.options.env.AUTORESEARCH_GENERATION),
      token: client.options.env.AUTORESEARCH_WORKER_TOKEN,
    });
    const reservation = workerStore.reserveEvidence("durable evidence", "campaign-durable");
    await assert.rejects(() => control.execute("sync", { action: "sync", target: "w1" }), /active evidence reservation/i);
    assert.deepEqual(fixture.records.syncs, []);

    workerStore.releaseEvidence({ reservationId: reservation.reservationId, receipt: { verdict: "reconciled" } });
    const result = await control.execute("sync", { action: "sync", target: "w1" });
    assert.match(result.content[0].text, /candidateRef/);
    assert.deepEqual(fixture.records.syncs, ["w1"]);
    workerStore.close();
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("sync rejects the caller's active schema-v2 portfolio assignment and fails closed on malformed state", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 1);
    const control = fixture.harness.tools.get("autoresearch_control");
    await control.execute("pause", { action: "pause", target: "w1" });
    const portfolioPath = join(fixture.root, ".autoresearch", "portfolio.json");
    writeFileSync(portfolioPath, JSON.stringify({
      schema_version: 2,
      revision: 2,
      active_assignments: {
        w1: { worker_id: "w1", campaign_id: "campaign-1", hypothesis_id: "hypothesis-1", worker_token_sha256: "a".repeat(64) },
      },
      paused: false,
      pause_reason: null,
      hypotheses: { "hypothesis-1": { id: "hypothesis-1", status: "active" } },
      history: [],
    }));
    await assert.rejects(
      () => control.execute("sync", { action: "sync", target: "w1" }),
      /active portfolio assignment/i,
    );
    assert.deepEqual(fixture.records.syncs, []);

    writeFileSync(portfolioPath, "{not-json");
    await assert.rejects(
      () => control.execute("sync", { action: "sync", target: "w1" }),
      /malformed canonical.*portfolio\.json/i,
    );
    assert.deepEqual(fixture.records.syncs, []);

    writeFileSync(portfolioPath, JSON.stringify({
      schema_version: 1,
      revision: 1,
      active_hypothesis_id: "legacy-active",
      paused: false,
      pause_reason: null,
      hypotheses: { "legacy-active": { id: "legacy-active", status: "active" } },
      history: [],
    }));
    await assert.rejects(
      () => control.execute("sync", { action: "sync", target: "w1" }),
      /active portfolio assignment/i,
    );

    writeFileSync(portfolioPath, JSON.stringify({
      schema_version: 2,
      revision: 3,
      active_assignments: {},
      paused: false,
      pause_reason: null,
      hypotheses: { "hypothesis-1": { id: "hypothesis-1", status: "closed" } },
      history: [],
    }));
    await control.execute("sync", { action: "sync", target: "w1" });
    assert.deepEqual(fixture.records.syncs, ["w1"]);
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("worker role exposes only worker coordination, checkpoints through the tool, and injects shared context", async () => {
  const fleet = createFleetDb(1);
  const handlers = new Map();
  const tools = new Map();
  let active = ["read", ...AUTORESEARCH_PARENT_TOOLS];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
    getActiveTools: () => active,
    setActiveTools(names) { active = [...names]; },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    sendUserMessage() {},
  };
  const env = {
    AUTORESEARCH_CANONICAL_ROOT: fleet.root,
    AUTORESEARCH_WORKER_ID: "w1",
    AUTORESEARCH_SESSION_ID: fleet.workers[0].sessionId,
    AUTORESEARCH_WORKER_TOKEN: "t1",
    AUTORESEARCH_STATE_DIR: fleet.dir,
    AUTORESEARCH_FLEET_DB: fleet.dbPath,
    AUTORESEARCH_GENERATION: String(fleet.generation),
  };
  const ctx = {
    cwd: fleet.root,
    isIdle: () => false,
    hasPendingMessages: () => false,
    abort() {},
  };
  try {
    registerWorkerAutoresearch(pi, { env, continuationDelayMs: 0 });
    assert.deepEqual([...tools.keys()], [AUTORESEARCH_WORKER_TOOL]);
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    assert.ok(active.includes(AUTORESEARCH_WORKER_TOOL));
    assert.ok(!active.includes("autoresearch_inspect"));
    assert.ok(!active.includes("autoresearch_control"));
    assert.ok(active.includes("read"));

    const workerTool = tools.get(AUTORESEARCH_WORKER_TOOL);
    assert.deepEqual(workerTool.parameters.properties.receipt, {
      type: "object", minProperties: 1, additionalProperties: true,
    });
    const checkpoint = await workerTool.execute("call", {
      action: "checkpoint",
      campaign: "campaign",
      stage: "analysis",
      status: "running",
      summary: "worker summary",
      findings: ["finding"],
      blockers: [],
      nextActions: ["next"],
      runIds: ["r1"],
      claimedScopes: ["scope-a"],
      candidateCommit: "candidate-sha",
      championCommit: "champion-sha",
      continuationCommand: "scripts/launch-evidence run-1",
      launchReceipt: { pid: 42 },
    });
    assert.match(checkpoint.content[0].text, /Checkpoint \d+ recorded/);
    const structured = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).checkpoints[0];
    assert.equal(structured.candidate_commit, "candidate-sha");
    assert.equal(structured.champion_commit, "champion-sha");
    assert.equal(structured.continuation_command, "scripts/launch-evidence run-1");
    assert.deepEqual(structured.launch_receipt, { pid: 42 });
    assert.equal(fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0].task, "campaign");

    for (const handler of handlers.get("tool_execution_start") ?? []) {
      await handler({ toolName: "bash" }, ctx);
    }
    for (const handler of handlers.get("tool_execution_end") ?? []) {
      await handler({ toolName: "bash", isError: false }, ctx);
    }
    for (const handler of handlers.get("message_end") ?? []) {
      await handler({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Measured candidate behavior" }],
          usage: { totalTokens: 12_345, cost: { total: 0.012 } },
        },
      }, ctx);
    }
    const metrics = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(metrics.turns, 1);
    assert.equal(metrics.tool_calls, 1);
    assert.equal(metrics.context_tokens, 12_345);
    assert.equal(metrics.cost, 0.012);

    await assert.rejects(
      () => workerTool.execute("call", { action: "reserve_evidence", stage: "screen" }),
      /requires campaign/i,
    );
    const reserved = await workerTool.execute("call", {
      action: "reserve_evidence", stage: "screen", campaign: "campaign",
    });
    const reservationId = reserved.details.reservationId;
    await workerTool.execute("call", {
      action: "checkpoint",
      campaign: "campaign",
      stage: "screen",
      status: "running",
      launchReceipt: { reservation_id: reservationId, pid: 43 },
    });
    const activeReservation = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).reservations[0];
    assert.equal(activeReservation.campaign, "campaign");
    assert.deepEqual(activeReservation.launch_receipt, { reservation_id: reservationId, pid: 43 });
    await assert.rejects(
      () => workerTool.execute("call", { action: "release_evidence", reservationId }),
      /non-empty structured terminal receipt/i,
    );
    await workerTool.execute("call", {
      action: "release_evidence",
      reservationId,
      receipt: { terminalStatus: "complete" },
    });

    const contexts = [];
    for (const handler of handlers.get("before_agent_start") ?? []) contexts.push(await handler({}, ctx));
    assert.match(contexts[0].message.content, /shared snapshot for w1/);
    assert.match(contexts[0].message.content, new RegExp(fleet.workers[0].sessionId));
    assert.match(contexts[0].message.content, /scope-a/);

    await workerTool.execute("call", {
      action: "checkpoint",
      campaign: "campaign",
      stage: "decision",
      status: "decision",
      summary: "Terminal worker decision",
      blockers: ["preserved worker blocker"],
    });
    for (const handler of handlers.get("tool_execution_start") ?? []) {
      await handler({ toolName: "bash" }, ctx);
    }
    for (const handler of handlers.get("tool_execution_end") ?? []) {
      await handler({ toolName: "bash", isError: false }, ctx);
    }
    for (const handler of handlers.get("message_end") ?? []) {
      await handler({ message: { role: "assistant", content: [{ type: "text", text: "Late summary" }] } }, ctx);
    }
    const terminalWorker = fleet.parent.snapshot(fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(terminalWorker.status, "decision");
    assert.equal(terminalWorker.summary, "Terminal worker decision");
    assert.equal(terminalWorker.error, "preserved worker blocker");
    assert.equal(terminalWorker.current_tool, null);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
    fleet.parent.close();
    rmSync(fleet.dir, { recursive: true, force: true });
  }
});

test("fleet status, restart, and off use supervisor semantics with stable generation-local sessions", async () => {
  const fixture = createSupervisorFixture();
  try {
    await fixture.harness.emit("session_start", { reason: "startup" });
    await fixture.harness.commands.get("autoresearch").handler("2", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 2);

    await fixture.harness.commands.get("autoresearch").handler("status", fixture.harness.ctx);
    assert.match(fixture.harness.notifications.at(-1).message, /fleet is active, generation 1, 2 workers/i);

    const firstClient = fixture.records.clients[0];
    const firstSession = firstClient.options.env.AUTORESEARCH_SESSION_ID;
    const firstSessionDir = firstClient.options.args[firstClient.options.args.indexOf("--session-dir") + 1];
    const oldTranscript = join(firstSessionDir, "existing-transcript.jsonl");
    writeFileSync(oldTranscript, `${firstSession}\n`);
    const control = fixture.harness.tools.get("autoresearch_control");
    await control.execute("restart", { action: "restart", target: "w1" });
    await waitFor(() => fixture.records.clients.length === 3);
    const restarted = fixture.records.clients.at(-1);
    assert.equal(restarted.options.env.AUTORESEARCH_SESSION_ID, firstSession);
    assert.equal(restarted.options.args[restarted.options.args.indexOf("--session-id") + 1], firstSession);
    assert.equal(restarted.options.args[restarted.options.args.indexOf("--session-dir") + 1], firstSessionDir);
    assert.ok(firstClient.stopped);
    const matchingHeaders = readdirSync(firstSessionDir).filter((file) => {
      try {
        const header = JSON.parse(readFileSync(join(firstSessionDir, file), "utf8").split("\n", 1)[0]);
        return header.type === "session" && header.id === firstSession;
      } catch {
        return false;
      }
    });
    assert.equal(matchingHeaders.length, 1, "restart reuses the prepared session instead of creating a duplicate");

    await fixture.harness.commands.get("autoresearch").handler("off", fixture.harness.ctx);
    assert.match(fixture.harness.notifications.at(-1).message, /stopped autoresearch fleet/i);
    assert.ok(fixture.records.clients.every((client) => client.stopped));
    assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"));
    assert.ok(fixture.harness.activeTools().includes("read"));

    const stoppedStore = new FleetStore(join(fixture.root, ".autoresearch", "fleet.sqlite"));
    assert.equal(stoppedStore.snapshot(fixture.root).fleet.status, "stopped");
    stoppedStore.close();

    const portfolioPath = join(fixture.root, ".autoresearch", "portfolio.json");
    const portfolio = JSON.parse(readFileSync(portfolioPath, "utf8"));
    portfolio.active_assignments = {};
    for (const hypothesis of Object.values(portfolio.hypotheses)) hypothesis.status = "complete";
    writeFileSync(portfolioPath, `${JSON.stringify(portfolio)}\n`);

    await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
    await waitFor(() => fixture.records.prompts.length === 4);
    const nextGeneration = fixture.records.clients.at(-1);
    const nextSession = nextGeneration.options.env.AUTORESEARCH_SESSION_ID;
    assert.match(nextGeneration.options.args[nextGeneration.options.args.indexOf("--session-dir") + 1], /generation-2$/);
    assert.notEqual(nextSession, firstSession);
    assert.equal(readFileSync(oldTranscript, "utf8"), `${firstSession}\n`);
  } finally {
    await fixture.harness.emit("session_shutdown", { reason: "quit" });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("stale launching and active DB reservations are refused without fake attachment or tool activation", async () => {
  for (const durableStatus of ["launching", "active"]) {
    const fixture = createSupervisorFixture();
    const dbPath = join(fixture.root, ".autoresearch", "fleet.sqlite");
    const stale = new FleetStore(dbPath);
    const staleWorker = seed("w1", "stale-token", fixture.root);
    const generation = stale.beginFleet({ canonicalRoot: fixture.root, workers: [staleWorker], now: 10 });
    if (durableStatus === "active") stale.activateFleet(fixture.root, generation, 11);
    stale.close();
    try {
      await fixture.harness.emit("session_start", { reason: "startup" });
      await fixture.harness.commands.get("autoresearch").handler("1", fixture.harness.ctx);
      await waitFor(() => fixture.harness.notifications.some((item) => /owns no RPC workers/i.test(item.message)));

      assert.equal(fixture.records.clients.length, 0, durableStatus);
      assert.ok(!fixture.harness.activeTools().includes("autoresearch_inspect"), durableStatus);
      assert.ok(!fixture.harness.activeTools().includes("autoresearch_control"), durableStatus);
      assert.ok(fixture.harness.activeTools().includes("read"), durableStatus);
      assert.match(fixture.harness.notifications.at(-1).message, /refusing to attach or relaunch/i);

      const verify = new FleetStore(dbPath);
      const snapshot = verify.snapshot(fixture.root);
      assert.equal(snapshot.fleet.status, durableStatus);
      assert.equal(snapshot.fleet.generation, 1);
      verify.close();
    } finally {
      await fixture.harness.emit("session_shutdown", { reason: "quit" });
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
});

function createWorkerTurnFixture(options = {}) {
  const fleet = createFleetDb(1);
  const handlers = new Map();
  const compactions = [];
  const sent = [];
  const pi = {
    registerTool() {},
    getActiveTools: () => ["read"],
    setActiveTools() {},
    on(name, handler) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    sendUserMessage(message) { sent.push(message); },
  };
  const env = {
    AUTORESEARCH_CANONICAL_ROOT: fleet.root,
    AUTORESEARCH_WORKER_ID: "w1",
    AUTORESEARCH_SESSION_ID: fleet.workers[0].sessionId,
    AUTORESEARCH_WORKER_TOKEN: "t1",
    AUTORESEARCH_STATE_DIR: fleet.dir,
    AUTORESEARCH_FLEET_DB: fleet.dbPath,
    AUTORESEARCH_GENERATION: String(fleet.generation),
  };
  writeFileSync(join(fleet.dir, "program.md"), "# Worker continuation program");
  const ctx = {
    cwd: fleet.dir,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    compact(compaction) { compactions.push(compaction); },
  };
  registerWorkerAutoresearch(pi, {
    env,
    continuationDelayMs: 0,
    compactionTimeoutMs: options.compactionTimeoutMs ?? 1_000,
  });
  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { fleet, handlers, compactions, sent, ctx, emit };
}

function stoppedAssistant(stopReason) {
  return { role: "assistant", content: [{ type: "text", text: "turn result" }], stopReason, timestamp: 1 };
}

test("worker continuation waits for boundary compaction, accepts benign responses, and fails closed on real errors", async () => {
  const fixture = createWorkerTurnFixture();
  try {
    await fixture.emit("session_start", { reason: "startup" });
    await fixture.emit("agent_start");
    await fixture.emit("agent_end", { messages: [stoppedAssistant("stop")] });
    await fixture.emit("agent_settled");
    await waitFor(() => fixture.compactions.length === 1);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.compactions[0].customInstructions, AUTORESEARCH_COMPACTION_INSTRUCTIONS);

    fixture.compactions[0].onComplete();
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0], /Worker continuation program/);

    for (const [index, benign] of [
      "Nothing to compact (session too small)",
      "Already compacted",
    ].entries()) {
      await fixture.emit("agent_start");
      await fixture.emit("agent_end", { messages: [stoppedAssistant("stop")] });
      await fixture.emit("agent_settled");
      await waitFor(() => fixture.compactions.length === index + 2);
      fixture.compactions[index + 1].onError(new Error(benign));
      assert.equal(fixture.sent.length, index + 2);
    }

    await fixture.emit("agent_start");
    await fixture.emit("agent_end", { messages: [stoppedAssistant("stop")] });
    await fixture.emit("agent_settled");
    await waitFor(() => fixture.compactions.length === 4);
    fixture.compactions[3].onError(new Error("provider compaction failed"));
    assert.equal(fixture.sent.length, 3);
    const worker = fixture.fleet.parent.snapshot(fixture.fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(worker.status, "failed");
    assert.match(worker.error, /provider compaction failed/);
  } finally {
    await fixture.emit("session_shutdown", { reason: "quit" });
    fixture.fleet.parent.close();
    rmSync(fixture.fleet.dir, { recursive: true, force: true });
  }
});

test("worker terminal toolUse and compaction timeout never trigger automatic reinvocation", async () => {
  const toolUseFixture = createWorkerTurnFixture();
  try {
    await toolUseFixture.emit("session_start", { reason: "startup" });
    await toolUseFixture.emit("agent_start");
    await toolUseFixture.emit("agent_end", { messages: [stoppedAssistant("toolUse")] });
    await toolUseFixture.emit("agent_settled");
    await tick();
    assert.equal(toolUseFixture.compactions.length, 0);
    assert.equal(toolUseFixture.sent.length, 0);
    const worker = toolUseFixture.fleet.parent.snapshot(toolUseFixture.fleet.root, { workerId: "w1" }).workers[0];
    assert.equal(worker.status, "failed");
    assert.match(worker.error, /terminal toolUse/i);
  } finally {
    await toolUseFixture.emit("session_shutdown", { reason: "quit" });
    toolUseFixture.fleet.parent.close();
    rmSync(toolUseFixture.fleet.dir, { recursive: true, force: true });
  }

  const timeoutFixture = createWorkerTurnFixture({ compactionTimeoutMs: 10 });
  try {
    await timeoutFixture.emit("session_start", { reason: "startup" });
    await timeoutFixture.emit("agent_start");
    await timeoutFixture.emit("agent_end", { messages: [stoppedAssistant("stop")] });
    await timeoutFixture.emit("agent_settled");
    await waitFor(() => timeoutFixture.compactions.length === 1);
    await waitFor(() => timeoutFixture.fleet.parent.snapshot(timeoutFixture.fleet.root, { workerId: "w1" }).workers[0].status === "failed");
    assert.equal(timeoutFixture.sent.length, 0);
    const worker = timeoutFixture.fleet.parent.snapshot(timeoutFixture.fleet.root, { workerId: "w1" }).workers[0];
    assert.match(worker.error, /did not complete in time/i);
  } finally {
    await timeoutFixture.emit("session_shutdown", { reason: "quit" });
    timeoutFixture.fleet.parent.close();
    rmSync(timeoutFixture.fleet.dir, { recursive: true, force: true });
  }
});

test("dashboard mirrors subtask rows with duration, turns, task, and autoresearch metadata", () => {
  const workers = Array.from({ length: 4 }, (_, index) => ({
    worker_id: `w${index + 1}`,
    session_id: testSessionId(index + 1),
    status: index === 2 ? "blocked" : index === 3 ? "failed" : "running",
    stage: index === 0 ? "screen" : "scout",
    current_tool: index === 0 ? "bash" : null,
    task: `hypothesis-${index + 1}`,
    summary: `brief result ${index + 1}`,
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    started_at: 1_000,
    last_seen: index === 3 ? 61_000 : 120_000,
    turns: index + 1,
    tool_calls: index + 3,
    context_tokens: 12_300,
    context_window: 272_000,
    cost: 0.012,
  }));
  const snapshot = {
    fleet: { status: "active", generation: 2 },
    workers,
    reservations: [{ worker_id: "w1" }],
    checkpoints: [],
    events: [],
    evidence: { active: 1, max: 2 },
  };
  const lines = fleetDashboardLines(snapshot, { now: 126_000, canonicalHead: "abcdef123456", canonicalDirty: true });
  assert.equal(lines.length, 5, "one group header plus exactly four worker rows");
  assert.match(lines[0], /^┌─ autoresearch · active · 4 workers · evidence 1\/2 · canonical abcdef12 dirty/);
  assert.match(lines[1], /^├─ \[w1:00000001\] ● running\s+02:05/);
  assert.match(lines[1], /1 turn │ hypothesis-1 · brief result 1 │ Luna · Medium · \$0\.012 · 3 tools · 12\.3k\/272k ctx · screen\/bash · evidence$/);
  assert.match(lines[3], /! blocked/);
  assert.match(lines[4], /^└─ \[w4:.*× failed\s+01:00/, "terminal duration freezes at the final heartbeat");
  assert.doesNotMatch(lines[1], /00:06/, "active duration must not use the recent heartbeat");

  const context = compactFleetContext(snapshot);
  assert.match(context, /brief result 1/);
  assert.match(context, /task=hypothesis-1/);
  assert.match(context, /evidence=reserved/);
  assert.ok(context.length < 2_000);
});
