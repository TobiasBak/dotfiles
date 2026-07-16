import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const AUTORESEARCH_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_EVIDENCE_STAGES = 2;

export type WorkerStatus =
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
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        head TEXT,
        dirty INTEGER NOT NULL DEFAULT 0,
        protocol_version INTEGER NOT NULL,
        PRIMARY KEY (canonical_root, worker_id),
        FOREIGN KEY (canonical_root) REFERENCES fleets(canonical_root) ON DELETE CASCADE
      );
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
    this.ensureWorkerSessionColumn();
    this.ensureCheckpointColumns();
    this.ensureEvidenceReservationColumns();
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
    const row = this.db
      .prepare("SELECT generation, token FROM workers WHERE canonical_root=? AND worker_id=?")
      .get(identity.canonicalRoot, identity.workerId) as { generation?: number; token?: string } | undefined;
    if (!row || row.generation !== identity.generation || row.token !== identity.token) {
      throw new FenceError(`Stale autoresearch worker fence for ${identity.workerId}`);
    }
    return identity;
  }

  beginFleet(input: {
    canonicalRoot: string;
    parentSession?: string;
    canonicalHead?: string;
    maxEvidenceStages?: number;
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
        INSERT INTO fleets(canonical_root,generation,status,parent_session,canonical_head,protocol_version,max_evidence_stages,started_at,updated_at,stopped_at)
        VALUES(?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(canonical_root) DO UPDATE SET
          generation=excluded.generation,status=excluded.status,parent_session=excluded.parent_session,
          canonical_head=excluded.canonical_head,protocol_version=excluded.protocol_version,
          max_evidence_stages=excluded.max_evidence_stages,started_at=excluded.started_at,
          updated_at=excluded.updated_at,stopped_at=NULL
      `).run(input.canonicalRoot, generation, "launching", input.parentSession ?? null, input.canonicalHead ?? null,
        AUTORESEARCH_PROTOCOL_VERSION, maxEvidence, now, now);
      const upsert = this.db.prepare(`
        INSERT INTO workers(canonical_root,worker_id,generation,token,worktree,branch,session_id,session_dir,status,started_at,last_seen,protocol_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(canonical_root,worker_id) DO UPDATE SET
          generation=excluded.generation,token=excluded.token,worktree=excluded.worktree,branch=excluded.branch,
          session_id=excluded.session_id,session_dir=excluded.session_dir,session_file=NULL,status=excluded.status,
          stage=NULL,current_tool=NULL,summary=NULL,error=NULL,started_at=excluded.started_at,last_seen=excluded.last_seen,
          head=NULL,dirty=0,protocol_version=excluded.protocol_version
      `);
      for (const worker of input.workers) {
        upsert.run(input.canonicalRoot, worker.workerId, generation, worker.token, worker.worktree,
          worker.branch, worker.sessionId, join(worker.sessionsRoot, `generation-${generation}`),
          "launching", now, now, AUTORESEARCH_PROTOCOL_VERSION);
      }
      this.addEventUnsafe(input.canonicalRoot, null, generation, "fleet_launch", `${input.workers.length} workers launching`, now);
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

  parentUpdateWorker(canonicalRoot: string, workerId: string, patch: {
    status?: WorkerStatus;
    sessionFile?: string | null;
    summary?: string;
    error?: string | null;
    stage?: string | null;
    currentTool?: string | null;
    head?: string;
    dirty?: boolean;
    generation?: number;
    token?: string;
  }, now = Date.now()): void {
    const assignments = ["last_seen=?"];
    const values: unknown[] = [now];
    const fields: Array<[keyof typeof patch, string, (value: unknown) => unknown]> = [
      ["status", "status", (value) => value], ["sessionFile", "session_file", (value) => value],
      ["summary", "summary", (value) => value], ["error", "error", (value) => value],
      ["stage", "stage", (value) => value], ["currentTool", "current_tool", (value) => value],
      ["head", "head", (value) => value], ["dirty", "dirty", (value) => value ? 1 : 0],
      ["generation", "generation", (value) => value], ["token", "token", (value) => value],
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

  workerHeartbeat(patch: { status?: WorkerStatus; stage?: string | null; currentTool?: string | null; summary?: string; error?: string | null }, now = Date.now()): void {
    const identity = this.assertFence();
    const assignments = ["last_seen=?"];
    const values: unknown[] = [now];
    const mapping: Array<[keyof typeof patch, string]> = [
      ["status", "status"], ["stage", "stage"], ["currentTool", "current_tool"],
      ["summary", "summary"], ["error", "error"],
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
    const checkpoints = options.workerId
      ? this.db.prepare("SELECT * FROM checkpoints WHERE canonical_root=? AND worker_id=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, options.workerId, recent)
      : this.db.prepare("SELECT * FROM checkpoints WHERE canonical_root=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, recent);
    const events = options.workerId
      ? this.db.prepare("SELECT * FROM events WHERE canonical_root=? AND worker_id=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, options.workerId, recent)
      : this.db.prepare("SELECT * FROM events WHERE canonical_root=? ORDER BY id DESC LIMIT ?").all(canonicalRoot, recent);
    return {
      fleet: fleet ? { ...fleet } : null,
      workers: rowsToObjects(workers),
      reservations: rowsToObjects(reservations),
      checkpoints: rowsToObjects(checkpoints),
      events: rowsToObjects(events),
      evidence: { active: reservations.length, max: Number(fleet?.max_evidence_stages ?? DEFAULT_MAX_EVIDENCE_STAGES) },
    };
  }
}
