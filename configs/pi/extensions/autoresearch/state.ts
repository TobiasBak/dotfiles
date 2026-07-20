import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const AUTORESEARCH_PROTOCOL_VERSION = 4;

export type WorkerStatus =
  | "queued"
  | "launching"
  | "running"
  | "idle"
  | "parked"
  | "paused"
  | "blocked"
  | "failed"
  | "complete"
  | "stopped";

export type IntentStatus = "active" | "complete" | "blocked" | "failed";
export type CampaignOutcome = "accepted" | "rejected" | "inconclusive" | "exhausted" | "external-blocked";
export type LaneDisposition = "replace" | "park" | "fleet-exhausted";

export interface LaneResetResult {
  disposition: LaneDisposition;
  reactivatedWorkerIds: string[];
  frontierAdvanced: boolean;
}

export interface WorkerIdentity {
  canonicalRoot: string;
  workerId: string;
  sessionId: string;
  generation: number;
}

export interface WorkerSeed {
  workerId: string;
  sessionId: string;
  worktree: string;
  branch: string;
  sessionsRoot: string;
}

export interface ResearchIntentInput {
  question: string;
  experiment: string;
  reason: string;
  baselineHead?: string;
}

export interface CheckpointInput {
  stage?: string;
  summary?: string;
  findings?: string[];
  blockers?: string[];
  nextActions?: string[];
  runIds?: string[];
  candidateCommit?: string;
  championCommit?: string;
  continuationCommand?: string;
  launchReceipt?: Record<string, unknown>;
}

export interface FinishCampaignInput {
  outcome: CampaignOutcome;
  summary: string;
  findings?: string[];
  runIds?: string[];
  terminalHead: string;
}

export interface FleetSnapshot {
  fleet: Record<string, unknown> | null;
  workers: Array<Record<string, unknown>>;
  intents: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

export class FleetAlreadyActiveError extends Error {}
export class StaleWorkerError extends Error {}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertWorkerSessionId(value: string): void {
  if (!UUID_V4_PATTERN.test(value)) throw new Error(`Invalid autoresearch worker session UUID: ${value}`);
}

function json(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rowsToObjects(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const result = { ...(row as Record<string, unknown>) };
    for (const key of ["findings", "blockers", "next_actions", "run_ids", "launch_receipt"]) {
      if (key in result && result[key] !== null) result[key] = parseJson(result[key]);
    }
    return result;
  });
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must be a non-empty string`);
  return normalized;
}

export class FleetStore {
  readonly db: DatabaseSync;
  readonly identity: WorkerIdentity | undefined;

  constructor(path: string, identity?: WorkerIdentity) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.identity = identity;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.assertLegacyProcessesStopped();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleets_v3 (
        canonical_root TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        parent_session TEXT,
        canonical_branch TEXT,
        canonical_head TEXT,
        integration_error TEXT,
        frontier_version INTEGER NOT NULL DEFAULT 0,
        protocol_version INTEGER NOT NULL,
        max_workers INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        stopped_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workers_v3 (
        canonical_root TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        worktree TEXT NOT NULL,
        branch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_dir TEXT NOT NULL,
        session_file TEXT,
        status TEXT NOT NULL,
        process_state TEXT NOT NULL DEFAULT 'stopped',
        stage TEXT,
        current_tool TEXT,
        current_tool_started_at INTEGER,
        summary TEXT,
        error TEXT,
        task TEXT,
        model TEXT,
        thinking TEXT,
        context_window INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        head TEXT,
        dirty INTEGER NOT NULL DEFAULT 0,
        protocol_version INTEGER NOT NULL,
        PRIMARY KEY (canonical_root, worker_id),
        FOREIGN KEY (canonical_root) REFERENCES fleets_v3(canonical_root) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS workers_v3_unique_session
        ON workers_v3(canonical_root, lower(session_id));
      CREATE TABLE IF NOT EXISTS intents_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_root TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        experiment TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        started_frontier_version INTEGER NOT NULL DEFAULT 0,
        baseline_head TEXT,
        terminal_head TEXT,
        integration_phase TEXT,
        integration_ref TEXT,
        integration_base_head TEXT,
        integration_result_head TEXT,
        integration_error TEXT,
        integration_updated_at INTEGER,
        summary TEXT,
        findings TEXT NOT NULL DEFAULT '[]',
        run_ids TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      DROP INDEX IF EXISTS intents_v3_one_working_per_worker;
      CREATE UNIQUE INDEX IF NOT EXISTS intents_v3_one_active_per_worker
        ON intents_v3(canonical_root, worker_id) WHERE status='active';
      CREATE INDEX IF NOT EXISTS intents_v3_active
        ON intents_v3(canonical_root, status, worker_id, id DESC);
      CREATE TABLE IF NOT EXISTS checkpoints_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_root TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        intent_id INTEGER,
        stage TEXT,
        summary TEXT,
        findings TEXT NOT NULL,
        blockers TEXT NOT NULL,
        next_actions TEXT NOT NULL,
        run_ids TEXT NOT NULL,
        candidate_commit TEXT,
        champion_commit TEXT,
        continuation_command TEXT,
        launch_receipt TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoints_v3_recent
        ON checkpoints_v3(canonical_root, worker_id, id DESC);
      CREATE TABLE IF NOT EXISTS events_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_root TEXT NOT NULL,
        worker_id TEXT,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_v3_recent ON events_v3(canonical_root, id DESC);
    `);
    this.db.exec("UPDATE intents_v3 SET status='active' WHERE status='working'");
    this.ensureAdditiveColumns();
    this.removeObsoleteCoordinationSchema();
    this.db.exec("PRAGMA user_version=4");
  }

  private assertLegacyProcessesStopped(): void {
    const legacyWorkers = this.db.prepare("SELECT type FROM sqlite_master WHERE name='workers'").get() as { type?: string } | undefined;
    if (!legacyWorkers) return;
    if (legacyWorkers.type !== "table") throw new Error("Legacy worker coordination schema is malformed");
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(workers)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("status")) throw new Error("Legacy worker coordination schema is malformed");
    const live = this.db.prepare("SELECT COUNT(*) AS count FROM workers WHERE status IS NULL OR status <> 'stopped'").get() as { count: number };
    if (Number(live.count) > 0) {
      throw new Error("Cannot migrate protocol v2 while legacy worker processes may still be running; stop and externally reconcile them first");
    }
  }

  private removeObsoleteCoordinationSchema(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tables = new Set(
        (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (tables.has("checkpoints")) {
        this.db.exec(`
          INSERT INTO checkpoints_v3(
            canonical_root,worker_id,generation,session_id,intent_id,stage,summary,findings,blockers,next_actions,
            run_ids,candidate_commit,champion_commit,continuation_command,launch_receipt,created_at
          )
          SELECT canonical_root,worker_id,generation,'legacy-v2',NULL,stage,summary,findings,blockers,next_actions,
            run_ids,candidate_commit,champion_commit,continuation_command,launch_receipt,created_at
          FROM checkpoints
        `);
      }
      if (tables.has("events")) {
        this.db.exec(`
          INSERT INTO events_v3(canonical_root,worker_id,generation,kind,summary,created_at)
          SELECT canonical_root,worker_id,generation,kind,summary,created_at FROM events
        `);
      }
      this.db.exec(`
        DROP TABLE IF EXISTS admission_attempts;
        DROP TABLE IF EXISTS admissions;
        DROP TABLE IF EXISTS evidence_reservations;
        DROP TABLE IF EXISTS checkpoints;
        DROP TABLE IF EXISTS events;
        DROP TABLE IF EXISTS workers;
        DROP TABLE IF EXISTS fleets;
        PRAGMA user_version=4;
        COMMIT;
      `);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureAdditiveColumns(): void {
    const ensure = (table: string, columns: Array<[string, string]>): void => {
      const existing = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      for (const [name, type] of columns) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    };
    ensure("fleets_v3", [["canonical_branch", "TEXT"], ["integration_error", "TEXT"], ["frontier_version", "INTEGER NOT NULL DEFAULT 0"]]);
    ensure("workers_v3", [["current_tool_started_at", "INTEGER"]]);
    ensure("intents_v3", [
      ["baseline_head", "TEXT"], ["terminal_head", "TEXT"], ["integration_phase", "TEXT"],
      ["integration_ref", "TEXT"], ["integration_base_head", "TEXT"], ["integration_result_head", "TEXT"],
      ["integration_error", "TEXT"], ["integration_updated_at", "INTEGER"], ["started_frontier_version", "INTEGER NOT NULL DEFAULT 0"],
    ]);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireIdentity(): WorkerIdentity {
    if (!this.identity) throw new StaleWorkerError("Worker identity is required");
    return this.identity;
  }

  private assertCurrent(): WorkerIdentity {
    const identity = this.requireIdentity();
    const row = this.db.prepare(`
      SELECT w.generation,w.session_id,w.protocol_version AS worker_protocol_version,
        f.status AS fleet_status,f.generation AS fleet_generation,f.protocol_version AS fleet_protocol_version
      FROM workers_v3 w JOIN fleets_v3 f ON f.canonical_root=w.canonical_root
      WHERE w.canonical_root=? AND w.worker_id=?
    `).get(identity.canonicalRoot, identity.workerId) as {
      generation?: number; session_id?: string; worker_protocol_version?: number; fleet_status?: string; fleet_generation?: number; fleet_protocol_version?: number;
    } | undefined;
    if (!row || row.generation !== identity.generation || row.fleet_generation !== identity.generation
      || row.session_id !== identity.sessionId || row.worker_protocol_version !== AUTORESEARCH_PROTOCOL_VERSION
      || row.fleet_protocol_version !== AUTORESEARCH_PROTOCOL_VERSION || !["launching", "active"].includes(row.fleet_status ?? "")) {
      throw new StaleWorkerError(`Stale autoresearch worker session for ${identity.workerId}`);
    }
    return identity;
  }

  beginFleet(input: {
    canonicalRoot: string;
    parentSession?: string;
    canonicalBranch?: string;
    canonicalHead?: string;
    workers: WorkerSeed[];
    now?: number;
  }): number {
    if (input.workers.length < 1) throw new Error("Autoresearch requires at least one worker");
    const now = input.now ?? Date.now();
    const sessionIds = new Set<string>();
    for (const worker of input.workers) {
      assertWorkerSessionId(worker.sessionId);
      const normalized = worker.sessionId.toLowerCase();
      if (sessionIds.has(normalized)) throw new Error(`Duplicate autoresearch worker session UUID: ${worker.sessionId}`);
      sessionIds.add(normalized);
    }
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT generation,status FROM fleets_v3 WHERE canonical_root=?")
        .get(input.canonicalRoot) as { generation?: number; status?: string } | undefined;
      if (previous && ["launching", "active", "paused", "off", "failed"].includes(previous.status ?? "")) {
        const unresolved = this.db.prepare(`
          SELECT worker_id,process_state FROM workers_v3
          WHERE canonical_root=? AND generation=? AND process_state!='stopped' ORDER BY worker_id
        `).all(input.canonicalRoot, previous.generation!) as Array<{ worker_id: string; process_state: string }>;
        if (unresolved.length > 0) {
          throw new FleetAlreadyActiveError(
            `Previous autoresearch processes are not stopped: ${unresolved.map((item) => `${item.worker_id}=${item.process_state}`).join(", ")}`,
          );
        }
        if (["launching", "active"].includes(previous.status ?? "")) {
          throw new FleetAlreadyActiveError(`An autoresearch fleet is already ${previous.status}`);
        }
      }

      const generation = (previous?.generation ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO fleets_v3(canonical_root,generation,status,parent_session,canonical_branch,canonical_head,integration_error,frontier_version,protocol_version,max_workers,started_at,updated_at,stopped_at)
        VALUES(?,?,?,?,?,?,NULL,0,?,?,?,?,NULL)
        ON CONFLICT(canonical_root) DO UPDATE SET
          generation=excluded.generation,status=excluded.status,parent_session=excluded.parent_session,
          canonical_branch=excluded.canonical_branch,canonical_head=excluded.canonical_head,integration_error=NULL,
          frontier_version=excluded.frontier_version,protocol_version=excluded.protocol_version,max_workers=excluded.max_workers,
          started_at=excluded.started_at,updated_at=excluded.updated_at,stopped_at=NULL
      `).run(input.canonicalRoot, generation, "launching", input.parentSession ?? null, input.canonicalBranch ?? null,
        input.canonicalHead ?? null, AUTORESEARCH_PROTOCOL_VERSION, input.workers.length, now, now);

      const requested = new Set(input.workers.map((worker) => worker.workerId));
      this.db.prepare("DELETE FROM workers_v3 WHERE canonical_root=? AND worker_id NOT IN (SELECT value FROM json_each(?))")
        .run(input.canonicalRoot, json([...requested]));
      const upsert = this.db.prepare(`
        INSERT INTO workers_v3(canonical_root,worker_id,generation,worktree,branch,session_id,session_dir,status,process_state,started_at,last_seen,protocol_version)
        VALUES(?,?,?,?,?,?,?,?,'stopped',?,?,?)
        ON CONFLICT(canonical_root,worker_id) DO UPDATE SET
          generation=excluded.generation,worktree=excluded.worktree,branch=excluded.branch,
          session_id=excluded.session_id,session_dir=excluded.session_dir,session_file=NULL,status=excluded.status,process_state='stopped',
          stage=NULL,current_tool=NULL,current_tool_started_at=NULL,summary=NULL,error=NULL,task=NULL,model=NULL,thinking=NULL,
          context_window=0,context_tokens=0,cost=0,turns=0,tool_calls=0,
          started_at=excluded.started_at,last_seen=excluded.last_seen,head=NULL,dirty=0,protocol_version=excluded.protocol_version
      `);
      for (const worker of input.workers) {
        upsert.run(input.canonicalRoot, worker.workerId, generation, worker.worktree, worker.branch,
          worker.sessionId, `${worker.sessionsRoot}/generation-${generation}`, "queued", now, now, AUTORESEARCH_PROTOCOL_VERSION);
      }
      this.addEventUnsafe(input.canonicalRoot, null, generation, "fleet_launch", `${input.workers.length} autonomous worker slots started`, now);
      return generation;
    });
  }

  activateFleet(canonicalRoot: string, generation: number, now = Date.now()): void {
    const result = this.db.prepare("UPDATE fleets_v3 SET status='active',updated_at=? WHERE canonical_root=? AND generation=?")
      .run(now, canonicalRoot, generation);
    if (Number(result.changes) !== 1) throw new StaleWorkerError("Fleet generation changed during launch");
  }

  captureCanonicalBranch(canonicalRoot: string, generation: number, branch: string, expectedHead: string, now = Date.now()): void {
    const result = this.db.prepare(`
      UPDATE fleets_v3 SET canonical_branch=?,updated_at=?
      WHERE canonical_root=? AND generation=? AND canonical_head=? AND canonical_branch IS NULL
    `).run(requiredText(branch, "canonical branch"), now, canonicalRoot, generation, expectedHead);
    if (Number(result.changes) !== 1) throw new StaleWorkerError("Could not safely capture canonical branch for restored fleet");
  }

  setFleetStatus(canonicalRoot: string, status: string, now = Date.now(), expectedGeneration?: number): void {
    const generationClause = expectedGeneration === undefined ? "" : " AND generation=?";
    const values: SQLInputValue[] = [status, now, ["off", "stopped"].includes(status) ? now : null, canonicalRoot];
    if (expectedGeneration !== undefined) values.push(expectedGeneration);
    const result = this.db.prepare(`UPDATE fleets_v3 SET status=?,updated_at=?,stopped_at=? WHERE canonical_root=?${generationClause}`).run(...values);
    if (expectedGeneration !== undefined && Number(result.changes) !== 1) throw new StaleWorkerError("Fleet generation changed");
  }

  resetWorkerSession(
    canonicalRoot: string,
    workerId: string,
    generation: number,
    sessionId: string,
    now = Date.now(),
  ): void {
    assertWorkerSessionId(sessionId);
    const result = this.db.prepare(`
      UPDATE workers_v3 SET session_id=?,status='launching',process_state='stopped',session_file=NULL,
        stage=NULL,current_tool=NULL,current_tool_started_at=NULL,summary=NULL,error=NULL,task=NULL,
        context_tokens=0,cost=0,turns=0,tool_calls=0,started_at=?,last_seen=?
      WHERE canonical_root=? AND worker_id=? AND generation=? AND process_state='stopped'
    `).run(sessionId, now, now, canonicalRoot, workerId, generation);
    if (Number(result.changes) !== 1) throw new StaleWorkerError(`Could not install fresh worker session for ${workerId}`);
    this.addEventUnsafe(canonicalRoot, workerId, generation, "worker_replaced", sessionId, now);
  }

  publishIntent(input: ResearchIntentInput, now = Date.now()): { intentId: number } {
    const question = requiredText(input.question, "intent question");
    const experiment = requiredText(input.experiment, "intent experiment");
    const reason = requiredText(input.reason, "intent reason");
    return this.transaction(() => {
      const identity = this.assertCurrent();
      const existing = this.db.prepare(`
        SELECT id FROM intents_v3 WHERE canonical_root=? AND worker_id=? AND status='active'
      `).get(identity.canonicalRoot, identity.workerId) as { id?: number } | undefined;
      if (existing?.id !== undefined) throw new Error("worker already has an active research intent; resume it or finish it before publishing another");
      const fleet = this.db.prepare("SELECT frontier_version FROM fleets_v3 WHERE canonical_root=? AND generation=?")
        .get(identity.canonicalRoot, identity.generation) as { frontier_version?: number } | undefined;
      if (!fleet) throw new StaleWorkerError(`Stale autoresearch fleet for ${identity.workerId}`);
      const result = this.db.prepare(`
        INSERT INTO intents_v3(canonical_root,worker_id,generation,session_id,question,experiment,reason,status,outcome,started_frontier_version,baseline_head,started_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'active',NULL,?,?,?,?)
      `).run(identity.canonicalRoot, identity.workerId, identity.generation, identity.sessionId,
        question, experiment, reason, Number(fleet.frontier_version ?? 0), input.baselineHead ?? null, now, now);
      const intentId = Number(result.lastInsertRowid);
      this.db.prepare(`
        UPDATE workers_v3 SET status='running',task=?,summary=?,last_seen=?
        WHERE canonical_root=? AND worker_id=? AND generation=? AND session_id=?
      `).run(question, experiment, now, identity.canonicalRoot, identity.workerId, identity.generation, identity.sessionId);
      this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, "intent_published", question.slice(0, 500), now);
      return { intentId };
    });
  }

  checkpoint(input: CheckpointInput, now = Date.now()): number {
    return this.transaction(() => {
      const identity = this.assertCurrent();
      const intent = this.currentIntentUnsafe(identity.canonicalRoot, identity.workerId);
      if (!intent) throw new Error("publish a research intent before checkpointing campaign work");
      const result = this.db.prepare(`
        INSERT INTO checkpoints_v3(canonical_root,worker_id,generation,session_id,intent_id,stage,summary,findings,blockers,next_actions,run_ids,candidate_commit,champion_commit,continuation_command,launch_receipt,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(identity.canonicalRoot, identity.workerId, identity.generation, identity.sessionId, Number(intent.id),
        input.stage ?? null, input.summary ?? null, json(input.findings), json(input.blockers), json(input.nextActions),
        json(input.runIds), input.candidateCommit ?? null, input.championCommit ?? null,
        input.continuationCommand ?? null, input.launchReceipt === undefined ? null : json(input.launchReceipt), now);
      this.db.prepare("UPDATE intents_v3 SET updated_at=? WHERE id=?").run(now, Number(intent.id));
      this.workerHeartbeat({
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        error: input.blockers?.length ? input.blockers.join("; ").slice(0, 500) : null,
        currentTool: null,
      }, now);
      this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, "checkpoint",
        (input.summary ?? input.stage ?? "campaign progress").slice(0, 500), now);
      return Number(result.lastInsertRowid);
    });
  }

  finishCampaign(input: FinishCampaignInput, now = Date.now()): { intentId: number; status: IntentStatus } {
    const summary = requiredText(input.summary, "campaign summary");
    return this.transaction(() => {
      const identity = this.assertCurrent();
      const intent = this.currentIntentUnsafe(identity.canonicalRoot, identity.workerId);
      if (!intent) throw new Error("no active research intent to finish");
      const status: IntentStatus = input.outcome === "external-blocked" ? "blocked" : "complete";
      const terminalHead = requiredText(input.terminalHead, "campaign terminal head");
      const integrationPhase = input.outcome === "external-blocked" ? "complete" : "pending";
      const result = this.db.prepare(`
        UPDATE intents_v3 SET status=?,outcome=?,summary=?,findings=?,run_ids=?,terminal_head=?,integration_phase=?,
          integration_ref=NULL,integration_base_head=NULL,integration_result_head=NULL,integration_error=NULL,integration_updated_at=?,updated_at=?,completed_at=?
        WHERE id=? AND status='active'
      `).run(status, input.outcome, summary, json(input.findings), json(input.runIds), terminalHead, integrationPhase, now, now, now, Number(intent.id));
      if (Number(result.changes) !== 1) throw new StaleWorkerError("research intent changed before completion");
      const workerStatus: WorkerStatus = status === "complete" ? "complete" : status;
      this.workerHeartbeat({ status: workerStatus, currentTool: null, summary, error: status === "complete" ? null : summary }, now);
      this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, "intent_finished",
        `${input.outcome}: ${summary}`.slice(0, 500), now);
      return { intentId: Number(intent.id), status };
    });
  }

  currentIntent(canonicalRoot: string, workerId: string): Record<string, unknown> | undefined {
    const row = this.currentIntentUnsafe(canonicalRoot, workerId);
    return row ? rowsToObjects([row])[0] : undefined;
  }

  private currentIntentUnsafe(canonicalRoot: string, workerId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`
      SELECT * FROM intents_v3 WHERE canonical_root=? AND worker_id=? AND status='active' ORDER BY id DESC LIMIT 1
    `).get(canonicalRoot, workerId) as Record<string, unknown> | undefined;
  }

  latestIntegration(canonicalRoot: string, workerId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare(`
      SELECT * FROM intents_v3
      WHERE canonical_root=? AND worker_id=? AND integration_phase IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(canonicalRoot, workerId) as Record<string, unknown> | undefined;
    return row ? rowsToObjects([row])[0] : undefined;
  }

  pendingIntegration(canonicalRoot: string, workerId: string): Record<string, unknown> | undefined {
    const row = this.latestIntegration(canonicalRoot, workerId);
    return row && row.integration_phase !== "complete" ? row : undefined;
  }

  markIntegrationRef(canonicalRoot: string, workerId: string, _generation: number, intentId: number, ref: string, now = Date.now()): void {
    const result = this.db.prepare(`
      UPDATE intents_v3 SET integration_phase='ref_created',integration_ref=?,integration_error=NULL,integration_updated_at=?
      WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase IN ('pending','ref_created')
    `).run(requiredText(ref, "terminal ref"), now, intentId, canonicalRoot, workerId);
    if (Number(result.changes) !== 1) throw new StaleWorkerError(`Integration state changed for ${workerId}`);
  }

  beginIntegration(canonicalRoot: string, workerId: string, generation: number, intentId: number, baseHead: string, now = Date.now()): void {
    this.transaction(() => {
      const fleet = this.db.prepare("SELECT canonical_head,integration_error FROM fleets_v3 WHERE canonical_root=? AND generation=?")
        .get(canonicalRoot, generation) as { canonical_head?: string; integration_error?: string } | undefined;
      if (!fleet || fleet.integration_error) throw new StaleWorkerError("Canonical integration is globally blocked");
      if (fleet.canonical_head !== baseHead) throw new StaleWorkerError("Persisted canonical HEAD changed before integration");
      const result = this.db.prepare(`
        UPDATE intents_v3 SET integration_phase='integrating',integration_base_head=?,integration_error=NULL,integration_updated_at=?
        WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase IN ('ref_created','integrating')
      `).run(baseHead, now, intentId, canonicalRoot, workerId);
      if (Number(result.changes) !== 1) throw new StaleWorkerError(`Integration state changed for ${workerId}`);
    });
  }

  completeCanonicalIntegration(canonicalRoot: string, workerId: string, generation: number, intentId: number, baseHead: string, resultHead: string, now = Date.now()): { frontierAdvanced: boolean } {
    return this.transaction(() => {
      const source = this.db.prepare("SELECT outcome FROM intents_v3 WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase='integrating'")
        .get(intentId, canonicalRoot, workerId) as { outcome?: CampaignOutcome } | undefined;
      if (!source) throw new StaleWorkerError(`Integration state changed for ${workerId}`);
      const frontierAdvanced = source.outcome === "accepted" && resultHead !== baseHead;
      if (source.outcome === "accepted" && !frontierAdvanced) {
        throw new Error("Accepted integration did not produce a changed canonical result");
      }
      const fleet = this.db.prepare("UPDATE fleets_v3 SET canonical_head=?,frontier_version=frontier_version+?,updated_at=? WHERE canonical_root=? AND generation=? AND canonical_head=? AND integration_error IS NULL")
        .run(resultHead, frontierAdvanced ? 1 : 0, now, canonicalRoot, generation, baseHead);
      if (Number(fleet.changes) !== 1) throw new StaleWorkerError("Persisted canonical HEAD changed while completing integration");
      const intent = this.db.prepare(`
        UPDATE intents_v3 SET integration_phase='integrated',integration_result_head=?,integration_error=NULL,integration_updated_at=?
        WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase='integrating' AND integration_base_head=?
      `).run(resultHead, now, intentId, canonicalRoot, workerId, baseHead);
      if (Number(intent.changes) !== 1) throw new StaleWorkerError(`Integration state changed for ${workerId}`);
      if (frontierAdvanced) this.addEventUnsafe(canonicalRoot, workerId, generation, "frontier_advanced", `${baseHead} -> ${resultHead}`, now);
      this.addEventUnsafe(canonicalRoot, workerId, generation, "terminal_integrated", resultHead, now);
      return { frontierAdvanced };
    });
  }

  completeLaneReset(canonicalRoot: string, workerId: string, generation: number, intentId: number, now = Date.now()): LaneResetResult {
    return this.transaction(() => {
      const intent = this.db.prepare("SELECT outcome,started_frontier_version,integration_base_head,integration_result_head FROM intents_v3 WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase='integrated'")
        .get(intentId, canonicalRoot, workerId) as { outcome?: CampaignOutcome; started_frontier_version?: number; integration_base_head?: string; integration_result_head?: string } | undefined;
      if (!intent) throw new StaleWorkerError(`Integration reset state changed for ${workerId}`);
      const fleet = this.db.prepare("SELECT frontier_version,status FROM fleets_v3 WHERE canonical_root=? AND generation=?")
        .get(canonicalRoot, generation) as { frontier_version?: number; status?: string } | undefined;
      if (!fleet) throw new StaleWorkerError("Fleet generation changed during lane reset");
      const frontierAdvanced = intent.outcome === "accepted" && intent.integration_base_head !== intent.integration_result_head;
      this.db.prepare("UPDATE intents_v3 SET integration_phase='complete',integration_error=NULL,integration_updated_at=? WHERE id=?")
        .run(now, intentId);

      let disposition: LaneDisposition = "replace";
      const reactivatedWorkerIds: string[] = [];
      if (intent.outcome === "exhausted") {
        disposition = Number(intent.started_frontier_version ?? 0) === Number(fleet.frontier_version ?? 0) ? "park" : "replace";
        if (disposition === "park") {
          this.db.prepare("UPDATE workers_v3 SET status='parked',process_state='stopped',current_tool=NULL,current_tool_started_at=NULL,last_seen=? WHERE canonical_root=? AND worker_id=? AND generation=? AND process_state='stopped'")
            .run(now, canonicalRoot, workerId, generation);
          this.addEventUnsafe(canonicalRoot, workerId, generation, "worker_parked", "Project-level research exhausted at its started frontier", now);
        }
      }
      if (intent.outcome === "accepted" && frontierAdvanced) {
        const parked = this.db.prepare("SELECT worker_id FROM workers_v3 WHERE canonical_root=? AND generation=? AND status='parked' AND process_state='stopped' ORDER BY worker_id").all(canonicalRoot, generation) as Array<{ worker_id: string }>;
        for (const row of parked) {
          reactivatedWorkerIds.push(row.worker_id);
          this.db.prepare("UPDATE workers_v3 SET status='queued',summary='Reactivated after a scientific frontier advance.',error=NULL,last_seen=? WHERE canonical_root=? AND worker_id=? AND generation=? AND status='parked' AND process_state='stopped'")
            .run(now, canonicalRoot, row.worker_id, generation);
          this.addEventUnsafe(canonicalRoot, row.worker_id, generation, "worker_reactivated", "Scientific frontier advanced", now);
        }
        this.db.prepare("UPDATE fleets_v3 SET status='active',stopped_at=NULL,updated_at=? WHERE canonical_root=? AND generation=? AND status='exhausted'")
          .run(now, canonicalRoot, generation);
      }
      const incomplete = this.db.prepare("SELECT COUNT(*) AS count FROM intents_v3 WHERE canonical_root=? AND generation=? AND (status='active' OR (integration_phase IS NOT NULL AND integration_phase<>'complete'))").get(canonicalRoot, generation) as { count: number };
      const lanes = this.db.prepare("SELECT status,process_state FROM workers_v3 WHERE canonical_root=? AND generation=?").all(canonicalRoot, generation) as Array<{ status?: string; process_state?: string }>;
      const allParked = lanes.length > 0 && lanes.every((row) => row.status === "parked" && row.process_state === "stopped");
      if (intent.outcome === "exhausted" && disposition === "park" && Number(incomplete.count) === 0 && allParked) {
        disposition = "fleet-exhausted";
        this.db.prepare("UPDATE fleets_v3 SET status='exhausted',stopped_at=?,updated_at=? WHERE canonical_root=? AND generation=? AND status<>'off'")
          .run(now, now, canonicalRoot, generation);
        this.addEventUnsafe(canonicalRoot, null, generation, "fleet_exhausted", `All ${lanes.length} lanes declared project-level exhaustion at frontier ${Number(fleet.frontier_version ?? 0)}`, now);
      }
      this.addEventUnsafe(canonicalRoot, workerId, generation, "lane_reset", disposition, now);
      return { disposition, reactivatedWorkerIds, frontierAdvanced };
    });
  }

  blockIntegration(canonicalRoot: string, workerId: string, generation: number, intentId: number, error: string, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE intents_v3 SET integration_phase='blocked',integration_error=?,integration_updated_at=?
        WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase<>'complete'
      `).run(error.slice(0, 2000), now, intentId, canonicalRoot, workerId);
      this.db.prepare(`
        UPDATE workers_v3 SET status='blocked',current_tool=NULL,current_tool_started_at=NULL,
          summary='Terminal integration is blocked; lane and terminal ref were preserved.',error=?,last_seen=?
        WHERE canonical_root=? AND worker_id=? AND generation=?
      `).run(error.slice(0, 500), now, canonicalRoot, workerId, generation);
      this.addEventUnsafe(canonicalRoot, workerId, generation, "terminal_integration_blocked", error.slice(0, 500), now);
    });
  }

  retryBlockedIntegrationAfterCanonicalAdvance(
    canonicalRoot: string,
    workerId: string,
    generation: number,
    intentId: number,
    expectedHead: string,
    actualHead: string,
    now = Date.now(),
  ): void {
    this.transaction(() => {
      const fleet = this.db.prepare(`
        UPDATE fleets_v3 SET canonical_head=?,updated_at=?
        WHERE canonical_root=? AND generation=? AND canonical_head=? AND integration_error IS NULL AND status='active'
      `).run(actualHead, now, canonicalRoot, generation, expectedHead);
      if (Number(fleet.changes) !== 1) throw new StaleWorkerError("Canonical state changed before blocked integration retry");
      const intent = this.db.prepare(`
        UPDATE intents_v3 SET integration_phase='ref_created',integration_base_head=NULL,integration_result_head=NULL,
          integration_error=NULL,integration_updated_at=?
        WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase='blocked' AND integration_ref IS NOT NULL
      `).run(now, intentId, canonicalRoot, workerId);
      if (Number(intent.changes) !== 1) throw new StaleWorkerError(`Blocked integration state changed for ${workerId}`);
      const worker = this.db.prepare(`
        UPDATE workers_v3 SET status='paused',summary='Retrying terminal integration after verified canonical advance.',
          error=NULL,last_seen=?
        WHERE canonical_root=? AND worker_id=? AND generation=? AND process_state='stopped'
      `).run(now, canonicalRoot, workerId, generation);
      if (Number(worker.changes) !== 1) throw new StaleWorkerError(`${workerId} is not stopped for blocked integration retry`);
      this.addEventUnsafe(canonicalRoot, workerId, generation, "terminal_integration_retry", `${expectedHead} -> ${actualHead}`, now);
    });
  }

  retryBlockedIntegrationAtCanonicalHead(
    canonicalRoot: string,
    workerId: string,
    generation: number,
    intentId: number,
    canonicalHead: string,
    now = Date.now(),
  ): void {
    this.transaction(() => {
      const fleet = this.db.prepare(`
        SELECT canonical_head FROM fleets_v3
        WHERE canonical_root=? AND generation=? AND canonical_head=? AND integration_error IS NULL AND status='active'
      `).get(canonicalRoot, generation, canonicalHead);
      if (!fleet) throw new StaleWorkerError("Canonical state changed before blocked integration retry");
      const intent = this.db.prepare(`
        UPDATE intents_v3 SET integration_phase='ref_created',integration_base_head=NULL,integration_result_head=NULL,
          integration_error=NULL,integration_updated_at=?
        WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase='blocked' AND integration_ref IS NOT NULL
      `).run(now, intentId, canonicalRoot, workerId);
      if (Number(intent.changes) !== 1) throw new StaleWorkerError(`Blocked integration state changed for ${workerId}`);
      const worker = this.db.prepare(`
        UPDATE workers_v3 SET status='paused',summary='Retrying terminal integration at the current canonical head.',
          error=NULL,last_seen=?
        WHERE canonical_root=? AND worker_id=? AND generation=? AND process_state='stopped'
      `).run(now, canonicalRoot, workerId, generation);
      if (Number(worker.changes) !== 1) throw new StaleWorkerError(`${workerId} is not stopped for blocked integration retry`);
      this.addEventUnsafe(canonicalRoot, workerId, generation, "terminal_integration_retry", canonicalHead, now);
    });
  }

  adoptBlockedCanonicalIntegration(
    canonicalRoot: string,
    workerId: string,
    generation: number,
    intentId: number,
    expectedHead: string,
    resultHead: string,
    now = Date.now(),
  ): void {
    this.transaction(() => {
      const source = this.db.prepare(`
        SELECT outcome FROM intents_v3
        WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase='blocked' AND integration_ref IS NOT NULL
      `).get(intentId, canonicalRoot, workerId) as { outcome?: CampaignOutcome } | undefined;
      if (!source) throw new StaleWorkerError(`Blocked integration state changed for ${workerId}`);
      const frontierAdvanced = source.outcome === "accepted" && resultHead !== expectedHead;
      if (source.outcome === "accepted" && !frontierAdvanced) {
        throw new Error("Accepted manual integration did not produce a changed canonical result");
      }
      const fleet = this.db.prepare(`
        UPDATE fleets_v3 SET canonical_head=?,frontier_version=frontier_version+?,updated_at=?
        WHERE canonical_root=? AND generation=? AND canonical_head=? AND integration_error IS NULL AND status='active'
      `).run(resultHead, frontierAdvanced ? 1 : 0, now, canonicalRoot, generation, expectedHead);
      if (Number(fleet.changes) !== 1) throw new StaleWorkerError("Canonical state changed before adopting blocked integration");
      const intent = this.db.prepare(`
        UPDATE intents_v3 SET integration_phase='integrated',integration_base_head=?,integration_result_head=?,
          integration_error=NULL,integration_updated_at=?
        WHERE id=? AND canonical_root=? AND worker_id=? AND integration_phase='blocked'
      `).run(expectedHead, resultHead, now, intentId, canonicalRoot, workerId);
      if (Number(intent.changes) !== 1) throw new StaleWorkerError(`Blocked integration state changed for ${workerId}`);
      const worker = this.db.prepare(`
        UPDATE workers_v3 SET status='paused',summary='Adopted verified manual terminal integration.',
          error=NULL,last_seen=?
        WHERE canonical_root=? AND worker_id=? AND generation=? AND process_state='stopped'
      `).run(now, canonicalRoot, workerId, generation);
      if (Number(worker.changes) !== 1) throw new StaleWorkerError(`${workerId} is not stopped for blocked integration adoption`);
      if (frontierAdvanced) this.addEventUnsafe(canonicalRoot, workerId, generation, "frontier_advanced", `${expectedHead} -> ${resultHead}`, now);
      this.addEventUnsafe(canonicalRoot, workerId, generation, "terminal_integration_adopted", resultHead, now);
    });
  }

  blockAllIntegrations(canonicalRoot: string, generation: number, error: string, now = Date.now()): void {
    const result = this.db.prepare("UPDATE fleets_v3 SET integration_error=?,updated_at=? WHERE canonical_root=? AND generation=?")
      .run(error.slice(0, 2000), now, canonicalRoot, generation);
    if (Number(result.changes) !== 1) throw new StaleWorkerError("Fleet changed while blocking canonical integration");
  }

  workerHeartbeat(patch: {
    status?: WorkerStatus;
    stage?: string | null;
    currentTool?: string | null;
    task?: string;
    summary?: string;
    error?: string | null;
  }, now = Date.now()): void {
    const identity = this.assertCurrent();
    const fields: string[] = ["last_seen=?"];
    const values: SQLInputValue[] = [now];
    const mappings: Array<[keyof typeof patch, string]> = [
      ["status", "status"], ["stage", "stage"], ["currentTool", "current_tool"],
      ["task", "task"], ["summary", "summary"], ["error", "error"],
    ];
    if (patch.currentTool !== undefined) {
      fields.push("current_tool_started_at=?");
      values.push(patch.currentTool === null ? null : now);
    }
    for (const [key, column] of mappings) {
      if (patch[key] !== undefined) {
        fields.push(`${column}=?`);
        values.push(patch[key] as SQLInputValue);
      }
    }
    values.push(identity.canonicalRoot, identity.workerId, identity.generation, identity.sessionId);
    const result = this.db.prepare(`
      UPDATE workers_v3 SET ${fields.join(",")}
      WHERE canonical_root=? AND worker_id=? AND generation=? AND session_id=?
    `).run(...values);
    if (Number(result.changes) !== 1) throw new StaleWorkerError(`Stale autoresearch worker session for ${identity.workerId}`);
  }

  recordToolCall(now = Date.now()): void {
    const identity = this.assertCurrent();
    this.db.prepare(`
      UPDATE workers_v3 SET tool_calls=tool_calls+1,last_seen=?
      WHERE canonical_root=? AND worker_id=? AND generation=? AND session_id=?
    `).run(now, identity.canonicalRoot, identity.workerId, identity.generation, identity.sessionId);
  }

  recordTurnUsage(input: { contextTokens?: number; cost?: number }, now = Date.now()): void {
    const identity = this.assertCurrent();
    this.db.prepare(`
      UPDATE workers_v3 SET turns=turns+1,context_tokens=?,cost=cost+?,last_seen=?
      WHERE canonical_root=? AND worker_id=? AND generation=? AND session_id=?
    `).run(Math.max(0, Math.floor(input.contextTokens ?? 0)), Math.max(0, input.cost ?? 0), now,
      identity.canonicalRoot, identity.workerId, identity.generation, identity.sessionId);
  }

  parentUpdateWorker(canonicalRoot: string, workerId: string, patch: {
    status?: WorkerStatus;
    processState?: "starting" | "owned" | "stopped" | "unreconciled";
    sessionFile?: string | null;
    stage?: string | null;
    currentTool?: string | null;
    summary?: string;
    error?: string | null;
    task?: string;
    model?: string;
    thinking?: string;
    contextWindow?: number;
    head?: string | null;
    dirty?: boolean;
  }, now = Date.now(), expectedGeneration?: number): void {
    const fields: string[] = ["last_seen=?"];
    const values: SQLInputValue[] = [now];
    const mappings: Array<[keyof typeof patch, string, (value: never) => SQLInputValue]> = [
      ["status", "status", (value) => value], ["processState", "process_state", (value) => value],
      ["sessionFile", "session_file", (value) => value], ["stage", "stage", (value) => value],
      ["currentTool", "current_tool", (value) => value], ["summary", "summary", (value) => value],
      ["error", "error", (value) => value], ["task", "task", (value) => value],
      ["model", "model", (value) => value], ["thinking", "thinking", (value) => value],
      ["contextWindow", "context_window", (value) => Number(value)], ["head", "head", (value) => value],
      ["dirty", "dirty", (value) => value ? 1 : 0],
    ];
    if (patch.currentTool !== undefined) {
      fields.push("current_tool_started_at=?");
      values.push(patch.currentTool === null ? null : now);
    }
    for (const [key, column, convert] of mappings) {
      if (patch[key] !== undefined) {
        fields.push(`${column}=?`);
        values.push(convert(patch[key] as never));
      }
    }
    const generationClause = expectedGeneration === undefined ? "" : " AND generation=?";
    values.push(canonicalRoot, workerId);
    if (expectedGeneration !== undefined) values.push(expectedGeneration);
    const result = this.db.prepare(`UPDATE workers_v3 SET ${fields.join(",")} WHERE canonical_root=? AND worker_id=?${generationClause}`).run(...values);
    if (Number(result.changes) !== 1) throw new StaleWorkerError(`Worker state changed for ${workerId}`);
  }

  addEvent(kind: string, summary: string, now = Date.now()): void {
    const identity = this.assertCurrent();
    this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, kind, summary.slice(0, 500), now);
  }

  parentAddWorkerEvent(canonicalRoot: string, workerId: string, generation: number, kind: string, summary: string, now = Date.now()): void {
    const worker = this.db.prepare("SELECT generation FROM workers_v3 WHERE canonical_root=? AND worker_id=?").get(canonicalRoot, workerId) as Record<string, unknown> | undefined;
    if (!worker || Number(worker.generation) !== generation) throw new StaleWorkerError(`Worker generation changed for ${workerId}`);
    this.addEventUnsafe(canonicalRoot, workerId, generation, requiredText(kind, "event kind"), summary.slice(0, 500), now);
  }

  recoveryAttemptCount(canonicalRoot: string, workerId: string, generation: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM events_v3
      WHERE canonical_root=? AND worker_id=? AND generation=? AND kind='automatic_recovery_attempt'
        AND id > COALESCE((
          SELECT MAX(id) FROM events_v3
          WHERE canonical_root=? AND worker_id=? AND generation=? AND kind='automatic_recovery_healthy'
        ), 0)
    `).get(canonicalRoot, workerId, generation, canonicalRoot, workerId, generation) as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  private addEventUnsafe(canonicalRoot: string, workerId: string | null, generation: number, kind: string, summary: string, now: number): void {
    this.db.prepare("INSERT INTO events_v3(canonical_root,worker_id,generation,kind,summary,created_at) VALUES(?,?,?,?,?,?)")
      .run(canonicalRoot, workerId, generation, kind, summary, now);
  }

  snapshot(canonicalRoot: string, options: { workerId?: string; recent?: number } = {}): FleetSnapshot {
    const recent = Math.max(1, Math.min(100, Math.floor(options.recent ?? 12)));
    const fleet = this.db.prepare("SELECT * FROM fleets_v3 WHERE canonical_root=?").get(canonicalRoot) as Record<string, unknown> | undefined;
    const completedCampaigns = this.db.prepare(
      "SELECT COUNT(*) AS count FROM intents_v3 WHERE canonical_root=? AND status<>'active'",
    ).get(canonicalRoot) as { count: number };
    const generation = Number(fleet?.generation ?? -1);
    const workers = options.workerId
      ? this.db.prepare("SELECT * FROM workers_v3 WHERE canonical_root=? AND worker_id=? AND generation=?").all(canonicalRoot, options.workerId, generation)
      : this.db.prepare("SELECT * FROM workers_v3 WHERE canonical_root=? AND generation=? ORDER BY worker_id").all(canonicalRoot, generation);
    const intents = options.workerId
      ? this.db.prepare("SELECT * FROM intents_v3 WHERE canonical_root=? AND worker_id=? ORDER BY status='active' DESC,id DESC LIMIT ?").all(canonicalRoot, options.workerId, recent)
      : this.db.prepare("SELECT * FROM intents_v3 WHERE canonical_root=? ORDER BY status='active' DESC,id DESC LIMIT ?").all(canonicalRoot, recent);
    const checkpoints = options.workerId
      ? this.db.prepare("SELECT * FROM checkpoints_v3 WHERE canonical_root=? AND worker_id=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, options.workerId, recent)
      : this.db.prepare("SELECT * FROM checkpoints_v3 WHERE canonical_root=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, recent);
    const events = options.workerId
      ? this.db.prepare("SELECT * FROM events_v3 WHERE canonical_root=? AND worker_id=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, options.workerId, recent)
      : this.db.prepare("SELECT * FROM events_v3 WHERE canonical_root=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, recent);
    return {
      fleet: fleet ? { ...fleet, completed_campaigns: Number(completedCampaigns.count) } : null,
      workers: rowsToObjects(workers),
      intents: rowsToObjects(intents),
      checkpoints: rowsToObjects(checkpoints),
      events: rowsToObjects(events),
    };
  }
}
