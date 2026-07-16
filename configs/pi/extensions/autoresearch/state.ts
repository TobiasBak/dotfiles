import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const AUTORESEARCH_PROTOCOL_VERSION = 2;
export const DEFAULT_MAX_EVIDENCE_STAGES = 2;

export type WorkerStatus =
  | "queued"
  | "launching"
  | "running"
  | "idle"
  | "paused"
  | "blocked"
  | "decision"
  | "failed"
  | "complete"
  | "stopped";

export interface WorkerIdentity {
  canonicalRoot: string;
  workerId: string;
  sessionId: string;
  generation: number;
  token: string;
}

export interface WorkerSeed {
  workerId: string;
  sessionId: string;
  token: string;
  worktree: string;
  branch: string;
  sessionsRoot: string;
}

export interface AdmissionOfferInput {
  campaign: string;
  hypothesis: string;
  stage: string;
  claimedScopes: string[];
  summary?: string;
}

export interface CheckpointInput {
  campaign?: string;
  hypothesis?: string;
  stage?: string;
  status?: WorkerStatus;
  summary?: string;
  findings?: string[];
  blockers?: string[];
  nextActions?: string[];
  runIds?: string[];
  claimedScopes?: string[];
  candidateCommit?: string;
  championCommit?: string;
  continuationCommand?: string;
  launchReceipt?: Record<string, unknown>;
}

export interface FleetSnapshot {
  fleet: Record<string, unknown> | null;
  workers: Array<Record<string, unknown>>;
  reservations: Array<Record<string, unknown>>;
  admissions: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  evidence: { active: number; max: number };
}

export class FleetAlreadyActiveError extends Error {}
export class FenceError extends Error {}

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
    for (const key of ["findings", "blockers", "next_actions", "run_ids", "claimed_scopes", "launch_receipt", "receipt"]) {
      if (key in result && result[key] !== null) result[key] = parseJson(result[key]);
    }
    return result;
  });
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function requireTerminalReceipt(value: unknown): Record<string, unknown> {
  if (isNonEmptyRecord(value)) {
    try {
      const durable = JSON.parse(JSON.stringify(value)) as unknown;
      if (isNonEmptyRecord(durable)) return durable;
    } catch {}
  }
  throw new Error("release_evidence requires a non-empty structured terminal receipt");
}

function requirePortfolioAssignment(identity: WorkerIdentity, campaign: string, hypothesis?: string, required = false): void {
  const portfolioPath = join(identity.canonicalRoot, ".autoresearch", "portfolio.json");
  let descriptor: number;
  try {
    descriptor = openSync(portfolioPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FenceError("portfolio assignment is required for campaign admission");
    throw new Error("portfolio assignment is unavailable or unsafe", { cause: error });
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16 * 1024 * 1024) {
      throw new Error("portfolio assignment must be a bounded single-link regular file");
    }
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch (error) {
      throw new Error("portfolio assignment is malformed", { cause: error });
    }
    if (!isNonEmptyRecord(state) || state.schema_version !== 2 || !isNonEmptyRecord(state.active_assignments)
      || (required && (!Number.isInteger(state.revision) || !isNonEmptyRecord(state.hypotheses)))) {
      throw new Error("portfolio assignment schema is incompatible with fleet admission");
    }
    const assignment = state.active_assignments[identity.workerId];
    const assignedHypothesis = required && isNonEmptyRecord(state.hypotheses)
      && isNonEmptyRecord(assignment) && typeof assignment.hypothesis_id === "string"
      ? state.hypotheses[assignment.hypothesis_id]
      : undefined;
    const tokenDigest = createHash("sha256").update(identity.token).digest("hex");
    if (!isNonEmptyRecord(assignment)
      || assignment.worker_id !== identity.workerId
      || assignment.campaign_id !== campaign
      || (hypothesis !== undefined && assignment.hypothesis_id !== hypothesis)
      || assignment.worker_token_sha256 !== tokenDigest
      || (required && (!isNonEmptyRecord(assignedHypothesis) || assignedHypothesis.status !== "active"))) {
      throw new FenceError("evidence campaign is not owned by the fenced portfolio worker");
    }
  } finally {
    closeSync(descriptor);
  }
}

export class FleetStore {
  readonly db: DatabaseSync;
  readonly identity?: WorkerIdentity;

  constructor(path: string, identity?: WorkerIdentity) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.identity = identity;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleets (
        canonical_root TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        parent_session TEXT,
        canonical_head TEXT,
        protocol_version INTEGER NOT NULL,
        max_evidence_stages INTEGER NOT NULL,
        max_workers INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        stopped_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workers (
        canonical_root TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        token TEXT NOT NULL,
        worktree TEXT NOT NULL,
        branch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_dir TEXT NOT NULL,
        session_file TEXT,
        status TEXT NOT NULL,
        stage TEXT,
        current_tool TEXT,
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
        FOREIGN KEY (canonical_root) REFERENCES fleets(canonical_root) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS admissions (
        canonical_root TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        token TEXT NOT NULL,
        state TEXT NOT NULL,
        campaign TEXT,
        hypothesis TEXT,
        stage TEXT,
        claimed_scopes TEXT NOT NULL DEFAULT '[]',
        checkpoint_id INTEGER,
        reason TEXT,
        started_at INTEGER,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        resolved_at INTEGER,
        baseline_cost REAL NOT NULL DEFAULT 0,
        baseline_turns INTEGER NOT NULL DEFAULT 0,
        baseline_tool_calls INTEGER NOT NULL DEFAULT 0,
        baseline_head TEXT,
        baseline_dirty INTEGER NOT NULL DEFAULT 0,
        max_cost REAL NOT NULL DEFAULT 0.5,
        max_turns INTEGER NOT NULL DEFAULT 8,
        max_tool_calls INTEGER NOT NULL DEFAULT 16,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (canonical_root, worker_id),
        FOREIGN KEY (canonical_root, worker_id) REFERENCES workers(canonical_root, worker_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS admissions_generation_state
        ON admissions(canonical_root, generation, state, worker_id);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_root TEXT NOT NULL,
        worker_id TEXT,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_recent ON events(canonical_root, id DESC);
      CREATE TABLE IF NOT EXISTS checkpoints (
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
      CREATE INDEX IF NOT EXISTS checkpoints_recent ON checkpoints(canonical_root, worker_id, id DESC);
      CREATE TABLE IF NOT EXISTS evidence_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_root TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        token TEXT NOT NULL,
        stage TEXT NOT NULL,
        campaign TEXT,
        status TEXT NOT NULL,
        launch_receipt TEXT,
        receipt TEXT,
        created_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS evidence_one_active_per_worker
        ON evidence_reservations(canonical_root, worker_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS evidence_active
        ON evidence_reservations(canonical_root, status, id);
    `);
    this.ensureFleetAdmissionColumns();
    this.ensureAdmissionColumns();
    this.ensureWorkerSessionColumn();
    this.ensureWorkerDashboardColumns();
    this.ensureCheckpointColumns();
    this.ensureEvidenceReservationColumns();
  }

  private ensureFleetAdmissionColumns(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(fleets)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("max_workers")) this.db.exec("ALTER TABLE fleets ADD COLUMN max_workers INTEGER NOT NULL DEFAULT 1");
  }

  private ensureAdmissionColumns(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(admissions)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("elapsed_ms")) this.db.exec("ALTER TABLE admissions ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0");
    if (!existing.has("baseline_head")) this.db.exec("ALTER TABLE admissions ADD COLUMN baseline_head TEXT");
    if (!existing.has("baseline_dirty")) this.db.exec("ALTER TABLE admissions ADD COLUMN baseline_dirty INTEGER NOT NULL DEFAULT 0");
  }

  private ensureWorkerSessionColumn(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(workers)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("session_id")) this.db.exec("ALTER TABLE workers ADD COLUMN session_id TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS workers_unique_session
        ON workers(canonical_root, lower(session_id)) WHERE session_id IS NOT NULL;
    `);
  }

  private ensureWorkerDashboardColumns(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(workers)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const columns = [
      ["task", "TEXT"],
      ["model", "TEXT"],
      ["thinking", "TEXT"],
      ["context_window", "INTEGER NOT NULL DEFAULT 0"],
      ["context_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["cost", "REAL NOT NULL DEFAULT 0"],
      ["turns", "INTEGER NOT NULL DEFAULT 0"],
      ["tool_calls", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, type] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE workers ADD COLUMN ${name} ${type}`);
    }
  }

  private ensureCheckpointColumns(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(checkpoints)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const columns = [
      ["candidate_commit", "TEXT"],
      ["champion_commit", "TEXT"],
      ["continuation_command", "TEXT"],
      ["launch_receipt", "TEXT"],
    ] as const;
    for (const [name, type] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE checkpoints ADD COLUMN ${name} ${type}`);
    }
  }

  private ensureEvidenceReservationColumns(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(evidence_reservations)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("campaign")) this.db.exec("ALTER TABLE evidence_reservations ADD COLUMN campaign TEXT");
    if (!existing.has("launch_receipt")) this.db.exec("ALTER TABLE evidence_reservations ADD COLUMN launch_receipt TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS evidence_one_active_per_campaign
        ON evidence_reservations(canonical_root, campaign)
        WHERE status = 'active' AND campaign IS NOT NULL;
    `);
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
    if (!this.identity) throw new FenceError("Worker identity is required");
    return this.identity;
  }

  private assertFence(): WorkerIdentity {
    const identity = this.requireIdentity();
    const row = this.db.prepare(`
      SELECT w.generation,w.token,f.status AS fleet_status,f.generation AS fleet_generation
      FROM workers w JOIN fleets f ON f.canonical_root=w.canonical_root
      WHERE w.canonical_root=? AND w.worker_id=?
    `).get(identity.canonicalRoot, identity.workerId) as {
      generation?: number; token?: string; fleet_status?: string; fleet_generation?: number;
    } | undefined;
    if (!row || row.generation !== identity.generation || row.fleet_generation !== identity.generation
      || row.token !== identity.token || !["launching", "active"].includes(row.fleet_status ?? "")) {
      throw new FenceError(`Stale autoresearch worker fence for ${identity.workerId}`);
    }
    return identity;
  }

  beginFleet(input: {
    canonicalRoot: string;
    parentSession?: string;
    canonicalHead?: string;
    maxEvidenceStages?: number;
    admission?: { timeoutMs: number; maxCost: number; maxTurns: number; maxToolCalls: number };
    workers: WorkerSeed[];
    now?: number;
  }): number {
    const now = input.now ?? Date.now();
    const maxEvidence = Math.max(1, Math.floor(input.maxEvidenceStages ?? DEFAULT_MAX_EVIDENCE_STAGES));
    const sessionIds = new Set<string>();
    for (const worker of input.workers) {
      assertWorkerSessionId(worker.sessionId);
      const normalized = worker.sessionId.toLowerCase();
      if (sessionIds.has(normalized)) throw new Error(`Duplicate autoresearch worker session UUID: ${worker.sessionId}`);
      sessionIds.add(normalized);
    }
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT generation, status FROM fleets WHERE canonical_root=?")
        .get(input.canonicalRoot) as { generation?: number; status?: string } | undefined;
      if (previous) {
        const requested = new Set(input.workers.map((worker) => worker.workerId));
        const activeReservations = this.db.prepare(
          "SELECT worker_id FROM evidence_reservations WHERE canonical_root=? AND status='active' ORDER BY worker_id",
        ).all(input.canonicalRoot) as Array<{ worker_id: string }>;
        const omitted = activeReservations.filter((reservation) => !requested.has(reservation.worker_id));
        if (omitted.length > 0) {
          throw new FleetAlreadyActiveError(
            `Cannot recover autoresearch fleet while omitted workers own active evidence reservations: ${omitted.map((item) => item.worker_id).join(", ")}`,
          );
        }
        if (["launching", "active"].includes(previous.status ?? "")) {
          const workers = this.db.prepare(
            "SELECT worker_id,status FROM workers WHERE canonical_root=? AND generation=? ORDER BY worker_id",
          ).all(input.canonicalRoot, previous.generation) as Array<{ worker_id: string; status: string }>;
          const terminal = new Set(["paused", "stopped", "failed", "complete"]);
          const live = workers.filter((worker) => !terminal.has(worker.status));
          if (workers.length === 0 || live.length > 0) {
            const detail = live.length > 0
              ? `; non-terminal workers: ${live.map((worker) => `${worker.worker_id}=${worker.status}`).join(", ")}`
              : "; no durable worker reconciliation exists";
            throw new FleetAlreadyActiveError(`An autoresearch fleet is already ${previous.status}${detail}`);
          }
        }
      }
      const generation = (previous?.generation ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO fleets(canonical_root,generation,status,parent_session,canonical_head,protocol_version,max_evidence_stages,max_workers,started_at,updated_at,stopped_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(canonical_root) DO UPDATE SET
          generation=excluded.generation,status=excluded.status,parent_session=excluded.parent_session,
          canonical_head=excluded.canonical_head,protocol_version=excluded.protocol_version,
          max_evidence_stages=excluded.max_evidence_stages,max_workers=excluded.max_workers,
          started_at=excluded.started_at,updated_at=excluded.updated_at,stopped_at=NULL
      `).run(input.canonicalRoot, generation, "launching", input.parentSession ?? null, input.canonicalHead ?? null,
        AUTORESEARCH_PROTOCOL_VERSION, maxEvidence, input.workers.length, now, now);
      const upsert = this.db.prepare(`
        INSERT INTO workers(canonical_root,worker_id,generation,token,worktree,branch,session_id,session_dir,status,started_at,last_seen,protocol_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(canonical_root,worker_id) DO UPDATE SET
          generation=excluded.generation,token=excluded.token,worktree=excluded.worktree,branch=excluded.branch,
          session_id=excluded.session_id,session_dir=excluded.session_dir,session_file=NULL,status=excluded.status,
          stage=NULL,current_tool=NULL,summary=NULL,error=NULL,task=NULL,model=NULL,thinking=NULL,
          context_window=0,context_tokens=0,cost=0,turns=0,tool_calls=0,
          started_at=excluded.started_at,last_seen=excluded.last_seen,
          head=NULL,dirty=0,protocol_version=excluded.protocol_version
      `);
      const admission = input.admission ?? { timeoutMs: 60_000, maxCost: 0.5, maxTurns: 8, maxToolCalls: 16 };
      const upsertAdmission = this.db.prepare(`
        INSERT INTO admissions(canonical_root,worker_id,generation,token,state,claimed_scopes,baseline_cost,baseline_turns,baseline_tool_calls,max_cost,max_turns,max_tool_calls,timeout_ms,updated_at)
        VALUES(?,?,?,?,?,'[]',0,0,0,?,?,?,?,?)
        ON CONFLICT(canonical_root,worker_id) DO UPDATE SET
          generation=excluded.generation,token=excluded.token,state=excluded.state,campaign=NULL,hypothesis=NULL,
          stage=NULL,claimed_scopes='[]',checkpoint_id=NULL,reason=NULL,started_at=NULL,elapsed_ms=0,resolved_at=NULL,
          baseline_cost=0,baseline_turns=0,baseline_tool_calls=0,baseline_head=NULL,baseline_dirty=0,
          max_cost=excluded.max_cost,
          max_turns=excluded.max_turns,max_tool_calls=excluded.max_tool_calls,timeout_ms=excluded.timeout_ms,
          updated_at=excluded.updated_at
      `);
      for (const [index, worker] of input.workers.entries()) {
        upsert.run(input.canonicalRoot, worker.workerId, generation, worker.token, worker.worktree,
          worker.branch, worker.sessionId, join(worker.sessionsRoot, `generation-${generation}`),
          index === 0 ? "launching" : "queued", now, now, AUTORESEARCH_PROTOCOL_VERSION);
        upsertAdmission.run(input.canonicalRoot, worker.workerId, generation, worker.token, "queued",
          admission.maxCost, admission.maxTurns, admission.maxToolCalls, admission.timeoutMs, now);
      }
      this.addEventUnsafe(input.canonicalRoot, null, generation, "fleet_launch", `${input.workers.length} worker slots reserved; w1 admission launching`, now);
      return generation;
    });
  }

  activateFleet(canonicalRoot: string, generation: number, now = Date.now()): void {
    const result = this.db.prepare("UPDATE fleets SET status='active',updated_at=? WHERE canonical_root=? AND generation=?")
      .run(now, canonicalRoot, generation);
    if (Number(result.changes) !== 1) throw new FenceError("Fleet generation changed during launch");
  }

  setFleetStatus(canonicalRoot: string, status: string, now = Date.now()): void {
    this.db.prepare("UPDATE fleets SET status=?,updated_at=?,stopped_at=? WHERE canonical_root=?")
      .run(status, now, ["off", "stopped"].includes(status) ? now : null, canonicalRoot);
  }

  claimNextQueuedAdmission(canonicalRoot: string, generation: number, now = Date.now()): Record<string, unknown> | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT w.* FROM admissions a JOIN workers w
          ON w.canonical_root=a.canonical_root AND w.worker_id=a.worker_id AND w.generation=a.generation
        WHERE a.canonical_root=? AND a.generation=? AND a.state='queued' AND w.status='queued'
        ORDER BY a.worker_id LIMIT 1
      `).get(canonicalRoot, generation) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const result = this.db.prepare(`
        UPDATE workers SET status='launching',last_seen=?
        WHERE canonical_root=? AND worker_id=? AND generation=? AND token=? AND status='queued'
      `).run(now, canonicalRoot, String(row.worker_id), generation, String(row.token));
      if (Number(result.changes) !== 1) return undefined;
      row.status = "launching";
      this.addEventUnsafe(canonicalRoot, String(row.worker_id), generation, "admission_claimed", "queued planner claimed", now);
      return row;
    });
  }

  beginAdmission(canonicalRoot: string, workerId: string, generation: number, laneState: { head: string; dirty: boolean }, now = Date.now()): void {
    this.transaction(() => {
      const worker = this.db.prepare(`
        SELECT token,cost,turns,tool_calls FROM workers
        WHERE canonical_root=? AND worker_id=? AND generation=?
      `).get(canonicalRoot, workerId, generation) as Record<string, unknown> | undefined;
      if (!worker) throw new FenceError(`Missing current worker fence for ${workerId}`);
      const admission = this.db.prepare(`
        SELECT state,token,elapsed_ms,baseline_cost,baseline_turns,baseline_tool_calls,baseline_head,baseline_dirty FROM admissions
        WHERE canonical_root=? AND worker_id=? AND generation=?
      `).get(canonicalRoot, workerId, generation) as Record<string, unknown> | undefined;
      if (!admission || admission.token !== worker.token) throw new FenceError(`Admission fence is unavailable for ${workerId}`);
      if (admission.state === "admitted" || admission.state === "planning") return;
      if (!["queued", "blocked"].includes(String(admission.state))) throw new FenceError(`Admission fence is unavailable for ${workerId}`);
      const retry = admission.state === "blocked";
      const elapsed = retry ? 0 : Math.max(0, Number(admission.elapsed_ms ?? 0));
      const result = this.db.prepare(`
        UPDATE admissions SET state='planning',campaign=NULL,hypothesis=NULL,stage=NULL,claimed_scopes='[]',
          checkpoint_id=NULL,reason=NULL,started_at=?,elapsed_ms=?,resolved_at=NULL,baseline_cost=?,baseline_turns=?,
          baseline_tool_calls=?,baseline_head=?,baseline_dirty=?,updated_at=?
        WHERE canonical_root=? AND worker_id=? AND generation=? AND token=? AND state=?
      `).run(now - elapsed, elapsed,
        retry ? Number(worker.cost ?? 0) : Number(admission.baseline_cost ?? 0),
        retry ? Number(worker.turns ?? 0) : Number(admission.baseline_turns ?? 0),
        retry ? Number(worker.tool_calls ?? 0) : Number(admission.baseline_tool_calls ?? 0),
        retry || typeof admission.baseline_head !== "string" ? laneState.head : admission.baseline_head,
        retry || typeof admission.baseline_head !== "string" ? (laneState.dirty ? 1 : 0) : Number(admission.baseline_dirty ?? 0),
        now, canonicalRoot, workerId, generation, String(worker.token), String(admission.state));
      if (Number(result.changes) !== 1) throw new FenceError(`Admission fence is unavailable for ${workerId}`);
      this.addEventUnsafe(canonicalRoot, workerId, generation, "admission_planning", "bounded campaign admission started", now);
    });
  }

  offerAdmission(input: AdmissionOfferInput, now = Date.now()): { offered: true; checkpointId: number } {
    const campaign = input.campaign.trim();
    const hypothesis = input.hypothesis.trim();
    const stage = input.stage.trim();
    const scopes = [...new Set(input.claimedScopes.map((scope) => scope.trim()))];
    if (!campaign || !hypothesis || !stage || scopes.length === 0 || scopes.some((scope) => !scope)) {
      throw new Error("admission offer requires exact campaign, hypothesis, stage, and non-empty claimed scopes");
    }
    return this.transaction(() => {
      const identity = this.assertFence();
      requirePortfolioAssignment(identity, campaign, hypothesis, true);
      const admission = this.db.prepare(`
        SELECT * FROM admissions WHERE canonical_root=? AND worker_id=? AND generation=? AND token=?
      `).get(identity.canonicalRoot, identity.workerId, identity.generation, identity.token) as Record<string, unknown> | undefined;
      if (!admission || admission.state !== "planning") throw new FenceError("campaign admission is not in the planning state");
      const worker = this.db.prepare(`
        SELECT cost,turns,tool_calls FROM workers
        WHERE canonical_root=? AND worker_id=? AND generation=? AND token=?
      `).get(identity.canonicalRoot, identity.workerId, identity.generation, identity.token) as Record<string, unknown>;
      const elapsed = now - Number(admission.started_at ?? now);
      const cost = Number(worker.cost ?? 0) - Number(admission.baseline_cost ?? 0);
      const turns = Number(worker.turns ?? 0) - Number(admission.baseline_turns ?? 0);
      const toolCalls = Number(worker.tool_calls ?? 0) - Number(admission.baseline_tool_calls ?? 0);
      if (Number(admission.timeout_ms) > 0 && elapsed > Number(admission.timeout_ms)) throw new Error("campaign admission time budget exhausted");
      if (Number(admission.max_cost) >= 0 && cost > Number(admission.max_cost)) throw new Error("campaign admission cost budget exhausted");
      if (Number(admission.max_turns) >= 0 && turns > Number(admission.max_turns)) throw new Error("campaign admission turn budget exhausted");
      if (Number(admission.max_tool_calls) >= 0 && toolCalls > Number(admission.max_tool_calls)) throw new Error("campaign admission tool budget exhausted");
      const summary = input.summary?.trim() || `Admission offer for ${campaign}`;
      const checkpoint = this.db.prepare(`
        INSERT INTO checkpoints(canonical_root,worker_id,generation,campaign,hypothesis,stage,status,summary,findings,blockers,next_actions,run_ids,claimed_scopes,candidate_commit,champion_commit,continuation_command,launch_receipt,created_at)
        VALUES(?,?,?,?,?,?,?,?,'[]','[]','[]','[]',?,NULL,NULL,NULL,NULL,?)
      `).run(identity.canonicalRoot, identity.workerId, identity.generation, campaign, hypothesis, stage,
        "decision", summary, json(scopes), now);
      const checkpointId = Number(checkpoint.lastInsertRowid);
      const updated = this.db.prepare(`
        UPDATE admissions SET state='offered',campaign=?,hypothesis=?,stage=?,claimed_scopes=?,checkpoint_id=?,
          reason=NULL,updated_at=? WHERE canonical_root=? AND worker_id=? AND generation=? AND token=? AND state='planning'
      `).run(campaign, hypothesis, stage, json(scopes), checkpointId, now,
        identity.canonicalRoot, identity.workerId, identity.generation, identity.token);
      if (Number(updated.changes) !== 1) throw new FenceError("campaign admission changed while publishing the offer");
      this.workerHeartbeat({ status: "decision", stage, currentTool: null, task: hypothesis, summary, error: null }, now);
      this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, "admission_offered", campaign.slice(0, 500), now);
      return { offered: true, checkpointId };
    });
  }

  admitOfferedCampaign(canonicalRoot: string, workerId: string, generation: number, now = Date.now()): { admitted: boolean; reason?: string } {
    return this.transaction(() => {
      const offer = this.db.prepare(`
        SELECT a.*,w.session_id,w.cost,w.turns,w.tool_calls FROM admissions a JOIN workers w
          ON w.canonical_root=a.canonical_root AND w.worker_id=a.worker_id
        WHERE a.canonical_root=? AND a.worker_id=? AND a.generation=?
      `).get(canonicalRoot, workerId, generation) as Record<string, unknown> | undefined;
      if (!offer || offer.state !== "offered") return { admitted: offer?.state === "admitted" };
      const identity: WorkerIdentity = {
        canonicalRoot,
        workerId,
        generation,
        token: String(offer.token),
        sessionId: String(offer.session_id),
      };
      requirePortfolioAssignment(identity, String(offer.campaign), String(offer.hypothesis), true);
      const elapsed = now - Number(offer.started_at ?? now);
      const cost = Number(offer.cost ?? 0) - Number(offer.baseline_cost ?? 0);
      const turns = Number(offer.turns ?? 0) - Number(offer.baseline_turns ?? 0);
      const tools = Number(offer.tool_calls ?? 0) - Number(offer.baseline_tool_calls ?? 0);
      if (Number(offer.timeout_ms) > 0 && elapsed >= Number(offer.timeout_ms)) return { admitted: false, reason: "campaign admission time budget exhausted" };
      if (Number(offer.max_cost) >= 0 && cost > Number(offer.max_cost)) return { admitted: false, reason: "campaign admission cost budget exhausted" };
      if (Number(offer.max_turns) >= 0 && turns > Number(offer.max_turns)) return { admitted: false, reason: "campaign admission turn budget exhausted" };
      if (Number(offer.max_tool_calls) >= 0 && tools > Number(offer.max_tool_calls)) return { admitted: false, reason: "campaign admission tool budget exhausted" };
      const scopes = parseJson(offer.claimed_scopes);
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || !scope.trim())) {
        return { admitted: false, reason: "admission offer has invalid claimed scopes" };
      }
      const occupied = this.db.prepare(`
        SELECT worker_id,claimed_scopes FROM admissions
        WHERE canonical_root=? AND generation=? AND state='admitted' AND worker_id<>?
      `).all(canonicalRoot, generation, workerId) as Array<{ worker_id: string; claimed_scopes: string }>;
      const claimed = new Set(scopes.map((scope) => String(scope).trim()));
      for (const row of occupied) {
        const other = parseJson(row.claimed_scopes);
        if (Array.isArray(other) && other.some((scope) => typeof scope === "string" && claimed.has(scope.trim()))) {
          return { admitted: false, reason: `claimed scope conflicts with ${row.worker_id}` };
        }
      }
      const result = this.db.prepare(`
        UPDATE admissions SET state='admitted',resolved_at=?,updated_at=?
        WHERE canonical_root=? AND worker_id=? AND generation=? AND token=? AND state='offered'
      `).run(now, now, canonicalRoot, workerId, generation, String(offer.token));
      if (Number(result.changes) !== 1) return { admitted: false, reason: "admission offer changed before acceptance" };
      this.addEventUnsafe(canonicalRoot, workerId, generation, "admission_accepted", String(offer.campaign).slice(0, 500), now);
      return { admitted: true };
    });
  }

  admissionLaneChanged(canonicalRoot: string, workerId: string, generation: number, laneState: { head: string; dirty: boolean }): boolean {
    const row = this.db.prepare(`
      SELECT baseline_head,baseline_dirty FROM admissions
      WHERE canonical_root=? AND worker_id=? AND generation=?
    `).get(canonicalRoot, workerId, generation) as { baseline_head?: string | null; baseline_dirty?: number } | undefined;
    return !row || typeof row.baseline_head !== "string"
      || row.baseline_head !== laneState.head || Boolean(row.baseline_dirty) !== laneState.dirty;
  }

  admissionBudgetViolation(canonicalRoot: string, workerId: string, generation: number, now = Date.now()): string | undefined {
    const row = this.db.prepare(`
      SELECT a.*,w.cost,w.turns,w.tool_calls FROM admissions a JOIN workers w
        ON w.canonical_root=a.canonical_root AND w.worker_id=a.worker_id
      WHERE a.canonical_root=? AND a.worker_id=? AND a.generation=?
    `).get(canonicalRoot, workerId, generation) as Record<string, unknown> | undefined;
    if (!row || !["planning", "offered"].includes(String(row.state))) return undefined;
    const elapsed = now - Number(row.started_at ?? now);
    const cost = Number(row.cost ?? 0) - Number(row.baseline_cost ?? 0);
    const turns = Number(row.turns ?? 0) - Number(row.baseline_turns ?? 0);
    const tools = Number(row.tool_calls ?? 0) - Number(row.baseline_tool_calls ?? 0);
    if (Number(row.timeout_ms) > 0 && elapsed >= Number(row.timeout_ms)) return `campaign admission exceeded ${Math.round(Number(row.timeout_ms) / 1_000)} seconds`;
    if (Number(row.max_cost) >= 0 && cost > Number(row.max_cost)) return `campaign admission cost $${cost.toFixed(3)} exceeded $${Number(row.max_cost).toFixed(2)}`;
    if (Number(row.max_turns) >= 0 && turns > Number(row.max_turns)) return `campaign admission used ${turns} model turns, limit ${row.max_turns}`;
    if (Number(row.max_tool_calls) >= 0 && tools > Number(row.max_tool_calls)) return `campaign admission used ${tools} tool calls, limit ${row.max_tool_calls}`;
    return undefined;
  }

  blockAdmission(canonicalRoot: string, workerId: string, generation: number, reason: string, now = Date.now()): void {
    this.db.prepare(`
      UPDATE admissions SET state='blocked',reason=?,resolved_at=?,updated_at=?
      WHERE canonical_root=? AND worker_id=? AND generation=? AND state IN ('planning','offered')
    `).run(reason.slice(0, 500), now, now, canonicalRoot, workerId, generation);
  }

  pauseAdmission(canonicalRoot: string, workerId: string, generation: number, now = Date.now()): void {
    this.db.prepare(`
      UPDATE admissions SET state='queued',campaign=NULL,hypothesis=NULL,stage=NULL,claimed_scopes='[]',
        checkpoint_id=NULL,elapsed_ms=MAX(0,?-started_at),started_at=NULL,resolved_at=NULL,reason=NULL,updated_at=?
      WHERE canonical_root=? AND worker_id=? AND generation=? AND state IN ('planning','offered')
    `).run(now, now, canonicalRoot, workerId, generation);
  }

  parentUpdateWorker(canonicalRoot: string, workerId: string, patch: {
    status?: WorkerStatus;
    sessionFile?: string | null;
    summary?: string;
    error?: string | null;
    stage?: string | null;
    currentTool?: string | null;
    task?: string;
    model?: string;
    thinking?: string;
    contextWindow?: number;
    head?: string;
    dirty?: boolean;
  }, now = Date.now()): void {
    const assignments = ["last_seen=?"];
    const values: unknown[] = [now];
    const fields: Array<[keyof typeof patch, string, (value: unknown) => unknown]> = [
      ["status", "status", (value) => value], ["sessionFile", "session_file", (value) => value],
      ["summary", "summary", (value) => value], ["error", "error", (value) => value],
      ["stage", "stage", (value) => value], ["currentTool", "current_tool", (value) => value],
      ["task", "task", (value) => value], ["model", "model", (value) => value],
      ["thinking", "thinking", (value) => value], ["contextWindow", "context_window", (value) => value],
      ["head", "head", (value) => value], ["dirty", "dirty", (value) => value ? 1 : 0],
    ];
    for (const [key, column, transform] of fields) {
      if (patch[key] !== undefined) {
        assignments.push(`${column}=?`);
        values.push(transform(patch[key]));
      }
    }
    values.push(canonicalRoot, workerId);
    this.db.prepare(`UPDATE workers SET ${assignments.join(",")} WHERE canonical_root=? AND worker_id=?`).run(...values);
  }

  workerHeartbeat(patch: { status?: WorkerStatus; stage?: string | null; currentTool?: string | null; task?: string; summary?: string; error?: string | null }, now = Date.now()): void {
    const identity = this.assertFence();
    const assignments = ["last_seen=?"];
    const values: unknown[] = [now];
    const mapping: Array<[keyof typeof patch, string]> = [
      ["status", "status"], ["stage", "stage"], ["currentTool", "current_tool"],
      ["task", "task"], ["summary", "summary"], ["error", "error"],
    ];
    for (const [key, column] of mapping) {
      if (patch[key] !== undefined) {
        assignments.push(`${column}=?`);
        values.push(patch[key]);
      }
    }
    values.push(identity.canonicalRoot, identity.workerId, identity.generation, identity.token);
    const result = this.db.prepare(`UPDATE workers SET ${assignments.join(",")} WHERE canonical_root=? AND worker_id=? AND generation=? AND token=?`).run(...values);
    if (Number(result.changes) !== 1) throw new FenceError(`Stale autoresearch worker fence for ${identity.workerId}`);
  }

  recordToolCall(now = Date.now()): void {
    const identity = this.assertFence();
    const result = this.db.prepare(`
      UPDATE workers SET tool_calls=tool_calls+1,last_seen=?
      WHERE canonical_root=? AND worker_id=? AND generation=? AND token=?
    `).run(now, identity.canonicalRoot, identity.workerId, identity.generation, identity.token);
    if (Number(result.changes) !== 1) throw new FenceError(`Stale autoresearch worker fence for ${identity.workerId}`);
  }

  recordTurnUsage(input: { contextTokens?: number; cost?: number }, now = Date.now()): void {
    const identity = this.assertFence();
    const contextTokens = Number.isFinite(input.contextTokens) ? Math.max(0, Math.floor(input.contextTokens!)) : 0;
    const cost = Number.isFinite(input.cost) ? Math.max(0, input.cost!) : 0;
    const result = this.db.prepare(`
      UPDATE workers SET turns=turns+1,context_tokens=?,cost=cost+?,last_seen=?
      WHERE canonical_root=? AND worker_id=? AND generation=? AND token=?
    `).run(contextTokens, cost, now, identity.canonicalRoot, identity.workerId, identity.generation, identity.token);
    if (Number(result.changes) !== 1) throw new FenceError(`Stale autoresearch worker fence for ${identity.workerId}`);
  }

  checkpoint(input: CheckpointInput, now = Date.now()): number {
    return this.transaction(() => {
      const identity = this.assertFence();
      if (input.launchReceipt !== undefined) {
        const rawReservationId = input.launchReceipt.reservation_id ?? input.launchReceipt.reservationId;
        if (rawReservationId !== undefined && !Number.isInteger(rawReservationId)) {
          throw new Error("launch receipt reservation identity must be a positive integer");
        }
        const reservationId = rawReservationId === undefined ? undefined : Number(rawReservationId);
        const campaign = input.campaign?.trim();
        const stage = input.stage?.trim();
        if (reservationId !== undefined && (reservationId <= 0 || !campaign || !stage)) {
          throw new Error("a reservation launch receipt requires positive reservation identity, campaign, and stage");
        }
        if (reservationId !== undefined) {
          const encoded = json(input.launchReceipt);
          const reservation = this.db.prepare(`
            SELECT launch_receipt FROM evidence_reservations
            WHERE id=? AND canonical_root=? AND worker_id=? AND generation=? AND token=?
              AND campaign=? AND stage=? AND status='active'
          `).get(reservationId, identity.canonicalRoot, identity.workerId, identity.generation,
            identity.token, campaign, stage) as { launch_receipt?: string | null } | undefined;
          if (!reservation) throw new FenceError("Launch receipt does not match an active campaign reservation");
          if (reservation.launch_receipt !== null && reservation.launch_receipt !== undefined
            && reservation.launch_receipt !== encoded) {
            throw new Error("active evidence reservation already has a different launch receipt");
          }
          if (reservation.launch_receipt === null || reservation.launch_receipt === undefined) {
            this.db.prepare("UPDATE evidence_reservations SET launch_receipt=? WHERE id=?").run(encoded, reservationId);
          }
        }
      }
      const result = this.db.prepare(`
        INSERT INTO checkpoints(canonical_root,worker_id,generation,campaign,hypothesis,stage,status,summary,findings,blockers,next_actions,run_ids,claimed_scopes,candidate_commit,champion_commit,continuation_command,launch_receipt,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(identity.canonicalRoot, identity.workerId, identity.generation, input.campaign ?? null,
        input.hypothesis ?? null, input.stage ?? null, input.status ?? null, input.summary ?? null,
        json(input.findings), json(input.blockers), json(input.nextActions), json(input.runIds),
        json(input.claimedScopes), input.candidateCommit ?? null, input.championCommit ?? null,
        input.continuationCommand ?? null, input.launchReceipt === undefined ? null : json(input.launchReceipt), now);
      this.workerHeartbeat({
        status: input.status,
        stage: input.stage,
        currentTool: null,
        task: input.hypothesis ?? input.campaign,
        summary: input.summary,
        error: input.blockers?.length ? input.blockers.join("; ").slice(0, 500) : null,
      }, now);
      this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation,
        input.status === "blocked" || input.status === "failed" || input.status === "decision" ? input.status : "checkpoint",
        (input.summary ?? input.stage ?? "checkpoint").slice(0, 500), now);
      return Number(result.lastInsertRowid);
    });
  }

  reserveEvidence(stage: string, campaign: string, now = Date.now()): { reserved: boolean; wait: boolean; reservationId?: number; active: number; max: number; requiresReconciliation?: boolean } {
    const normalizedStage = stage.trim();
    const normalizedCampaign = campaign.trim();
    if (!normalizedStage) throw new Error("evidence reservation stage must be a non-empty string");
    if (!normalizedCampaign) throw new Error("evidence reservation campaign must be a non-empty string");
    return this.transaction(() => {
      const identity = this.assertFence();
      requirePortfolioAssignment(identity, normalizedCampaign);
      const fleet = this.db.prepare("SELECT max_evidence_stages FROM fleets WHERE canonical_root=? AND generation=?")
        .get(identity.canonicalRoot, identity.generation) as { max_evidence_stages?: number } | undefined;
      if (!fleet) throw new FenceError("Fleet generation is no longer active");
      const existing = this.db.prepare("SELECT id,generation,token,stage,campaign FROM evidence_reservations WHERE canonical_root=? AND worker_id=? AND status='active'")
        .get(identity.canonicalRoot, identity.workerId) as { id?: number; generation?: number; token?: string; stage?: string; campaign?: string | null } | undefined;
      const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM evidence_reservations WHERE canonical_root=? AND status='active'")
        .get(identity.canonicalRoot) as { count: number };
      const active = Number(countRow.count);
      const max = Number(fleet.max_evidence_stages ?? DEFAULT_MAX_EVIDENCE_STAGES);
      if (existing?.id !== undefined) {
        if (existing.generation === identity.generation && existing.token === identity.token) {
          if (existing.campaign === null || existing.campaign === undefined) {
            return { reserved: false, wait: true, reservationId: existing.id, active, max, requiresReconciliation: true };
          }
          if (existing.stage !== normalizedStage || existing.campaign !== normalizedCampaign) {
            throw new Error("active evidence reservation belongs to a different stage or campaign");
          }
          return { reserved: true, wait: false, reservationId: existing.id, active, max };
        }
        return { reserved: false, wait: true, reservationId: existing.id, active, max, requiresReconciliation: true };
      }
      const campaignReservation = this.db.prepare("SELECT id FROM evidence_reservations WHERE canonical_root=? AND campaign=? AND status='active'")
        .get(identity.canonicalRoot, normalizedCampaign) as { id?: number } | undefined;
      if (campaignReservation?.id !== undefined) {
        return { reserved: false, wait: true, reservationId: campaignReservation.id, active, max };
      }
      if (active >= max) return { reserved: false, wait: true, active, max };
      const result = this.db.prepare(`
        INSERT INTO evidence_reservations(canonical_root,worker_id,generation,token,stage,campaign,status,created_at)
        VALUES(?,?,?,?,?,?,'active',?)
      `).run(identity.canonicalRoot, identity.workerId, identity.generation, identity.token,
        normalizedStage, normalizedCampaign, now);
      this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, "evidence_reserved",
        `${normalizedStage}:${normalizedCampaign}`.slice(0, 500), now);
      return { reserved: true, wait: false, reservationId: Number(result.lastInsertRowid), active: active + 1, max };
    });
  }

  releaseEvidence(input: { reservationId?: number; receipt?: unknown; summary?: string }, now = Date.now()): { released: boolean; reservationId?: number } {
    const receipt = requireTerminalReceipt(input.receipt);
    return this.transaction(() => {
      const identity = this.assertFence();
      const reservation = input.reservationId === undefined
        ? this.db.prepare("SELECT id FROM evidence_reservations WHERE canonical_root=? AND worker_id=? AND status='active' ORDER BY id DESC LIMIT 1")
            .get(identity.canonicalRoot, identity.workerId) as { id?: number } | undefined
        : { id: input.reservationId };
      if (reservation?.id === undefined) return { released: false };
      const status = "receipt";
      const result = this.db.prepare(`
        UPDATE evidence_reservations SET status=?,receipt=?,released_at=?
        WHERE id=? AND canonical_root=? AND worker_id=? AND status='active'
      `).run(status, json(receipt), now, reservation.id, identity.canonicalRoot, identity.workerId);
      if (Number(result.changes) !== 1) return { released: false, reservationId: reservation.id };
      this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, "evidence_released",
        (input.summary ?? status).slice(0, 500), now);
      return { released: true, reservationId: reservation.id };
    });
  }

  hasActiveReservation(canonicalRoot: string, workerId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM evidence_reservations WHERE canonical_root=? AND worker_id=? AND status='active' LIMIT 1")
      .get(canonicalRoot, workerId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  addEvent(kind: string, summary: string, now = Date.now()): void {
    const identity = this.assertFence();
    this.addEventUnsafe(identity.canonicalRoot, identity.workerId, identity.generation, kind, summary.slice(0, 500), now);
  }

  private addEventUnsafe(canonicalRoot: string, workerId: string | null, generation: number, kind: string, summary: string, now: number): void {
    this.db.prepare("INSERT INTO events(canonical_root,worker_id,generation,kind,summary,created_at) VALUES(?,?,?,?,?,?)")
      .run(canonicalRoot, workerId, generation, kind, summary, now);
  }

  snapshot(canonicalRoot: string, options: { workerId?: string; recent?: number } = {}): FleetSnapshot {
    const recent = Math.max(1, Math.min(100, Math.floor(options.recent ?? 12)));
    const fleet = this.db.prepare("SELECT * FROM fleets WHERE canonical_root=?").get(canonicalRoot) as Record<string, unknown> | undefined;
    const generation = Number(fleet?.generation ?? -1);
    const workers = options.workerId
      ? this.db.prepare("SELECT * FROM workers WHERE canonical_root=? AND worker_id=? AND generation=?").all(canonicalRoot, options.workerId, generation)
      : this.db.prepare("SELECT * FROM workers WHERE canonical_root=? AND generation=? ORDER BY worker_id").all(canonicalRoot, generation);
    const reservations = options.workerId
      ? this.db.prepare("SELECT * FROM evidence_reservations WHERE canonical_root=? AND worker_id=? AND status='active' ORDER BY id").all(canonicalRoot, options.workerId)
      : this.db.prepare("SELECT * FROM evidence_reservations WHERE canonical_root=? AND status='active' ORDER BY id").all(canonicalRoot);
    const admissions = options.workerId
      ? this.db.prepare("SELECT * FROM admissions WHERE canonical_root=? AND worker_id=? AND generation=?").all(canonicalRoot, options.workerId, generation)
      : this.db.prepare("SELECT * FROM admissions WHERE canonical_root=? AND generation=? ORDER BY worker_id").all(canonicalRoot, generation);
    const checkpoints = options.workerId
      ? this.db.prepare("SELECT * FROM checkpoints WHERE canonical_root=? AND worker_id=? AND generation=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, options.workerId, generation, recent)
      : this.db.prepare("SELECT * FROM checkpoints WHERE canonical_root=? AND generation=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, generation, recent);
    const events = options.workerId
      ? this.db.prepare("SELECT * FROM events WHERE canonical_root=? AND worker_id=? AND generation=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, options.workerId, generation, recent)
      : this.db.prepare("SELECT * FROM events WHERE canonical_root=? AND generation=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, generation, recent);
    return {
      fleet: fleet ? { ...fleet } : null,
      workers: rowsToObjects(workers),
      reservations: rowsToObjects(reservations),
      admissions: rowsToObjects(admissions),
      checkpoints: rowsToObjects(checkpoints),
      events: rowsToObjects(events),
      evidence: { active: reservations.length, max: Number(fleet?.max_evidence_stages ?? DEFAULT_MAX_EVIDENCE_STAGES) },
    };
  }
}
