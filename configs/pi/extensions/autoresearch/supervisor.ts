import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  RpcClientOptions,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import {
  ensureAutoresearchIgnored,
  ensureWorkerLane,
  inspectRepository,
  laneGitState,
  syncLaneToCanonical,
  workerLanes,
  type CommandRunner,
  type RepositoryInfo,
  type WorkerLane,
} from "./git.ts";
import {
  boundedInspect,
  compactFleetContext,
  fleetDashboardWidgetLines,
  type FleetDashboardOptions,
  type FleetWidgetLine,
} from "./presentation.ts";
import {
  AUTORESEARCH_PROTOCOL_VERSION,
  FleetAlreadyActiveError,
  FleetStore,
  type FleetSnapshot,
  type WorkerSeed,
  type WorkerStatus,
} from "./state.ts";
import { AUTORESEARCH_PARENT_TOOLS } from "./worker.ts";

export const AUTORESEARCH_FLEET_WIDGET_ID = "autoresearch-fleet";
export const MAX_AUTORESEARCH_WORKERS = 4;
const DEFAULT_ADMISSION_TIMEOUT_MS = 60_000;
const DEFAULT_ADMISSION_MAX_COST_USD = 0.5;
const DEFAULT_ADMISSION_MAX_TURNS = 8;
const DEFAULT_ADMISSION_MAX_TOOL_CALLS = 16;
const TERMINAL_WORKER_STATUSES = new Set(["paused", "blocked", "decision", "failed", "complete", "stopped"]);
const PROGRAM_DESIGN_SETUP_PROMPT = [
  "/skill:autoresearch-program-design Autoresearch setup is required because the canonical program.md is missing.",
  "Inspect this project and its existing commands, tests, constraints, and evidence surfaces first.",
  "Collaborate with me to clarify goals and project-specific decisions before writing a reviewable program.md; do not blindly generate one.",
].join(" ");

type ProgramFileResult = { kind: "missing" } | { kind: "valid"; content: string };

function readCanonicalProgram(canonicalRoot: string): ProgramFileResult {
  const path = join(canonicalRoot, "program.md");
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "missing" };
    throw new Error(`Cannot inspect canonical program.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("Canonical program.md must be a regular, nonsymlink file");
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Canonical program.md changed during validation");
    }
    const content = readFileSync(fd, "utf8");
    if (!content.trim()) throw new Error("Canonical program.md must not be empty");
    return { kind: "valid", content };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Canonical program.md")) throw error;
    throw new Error(`Cannot safely read canonical program.md: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface RpcWorkerClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: any) => void): () => void;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<{ isStreaming: boolean; sessionFile?: string }>;
  compact?(instructions?: string): Promise<unknown>;
  setModel?(provider: string, modelId: string): Promise<unknown>;
  setThinkingLevel?(level: ThinkingLevel): Promise<void>;
}

export interface SupervisorOptions {
  createRpcClient?: (options: RpcClientOptions) => RpcWorkerClient;
  createStore?: (path: string) => FleetStore;
  inspectRepo?: (cwd: string) => RepositoryInfo;
  ensureIgnored?: (canonicalRoot: string) => void;
  ensureLane?: (canonicalRoot: string, commonDir: string, lane: WorkerLane) => WorkerLane;
  laneState?: (path: string) => { head: string; dirty: boolean };
  syncLane?: typeof syncLaneToCanonical;
  cliPath?: string;
  extensionPath?: string;
  dashboardIntervalMs?: number;
  now?: () => number;
  token?: () => string;
  sessionId?: () => string;
  sessionVersion?: number;
  admissionTimeoutMs?: number;
  admissionMaxCostUsd?: number;
  admissionMaxTurns?: number;
  admissionMaxToolCalls?: number;
  planningProvider?: string;
  planningModel?: string;
  planningThinking?: ThinkingLevel;
  run?: CommandRunner;
}

interface WorkerLaunchSeed {
  workerId: string;
  sessionId: string;
  token: string;
  worktree: string;
  branch: string;
  sessionsRoot: string;
}

export interface FleetCommandHandler {
  start(count: number, ctx: ExtensionContext): void;
  status(ctx: ExtensionContext): boolean;
  stop(ctx: ExtensionContext): Promise<boolean>;
  shutdown(ctx: ExtensionContext): Promise<void>;
}

export function parseAutoresearchFleetCount(args: string): number | undefined {
  const trimmed = args.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const count = Number(trimmed);
  if (!Number.isInteger(count) || count < 1 || count > MAX_AUTORESEARCH_WORKERS) return undefined;
  return count;
}

export function resolvePiCliPath(candidate?: string, packageDir?: string): string {
  const cliPath = candidate ?? (packageDir ? join(packageDir, "dist", "cli.js") : "");
  if (!isAbsolute(cliPath) || !existsSync(cliPath)) {
    throw new Error(`Autoresearch requires Pi's absolute dist/cli.js path; not found: ${cliPath}`);
  }
  return realpathSync(cliPath);
}

function sessionHeader(path: string): Record<string, unknown> | undefined {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!before.isFile() || before.isSymbolicLink()) return undefined;

  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
    const buffer = Buffer.alloc(65_536);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, size).indexOf(0x0a);
    if (newline < 0) return undefined;
    const parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    return isRecord(parsed) && parsed.type === "session" ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureWorkerSession(cwd: string, sessionDir: string, sessionId: string, sessionVersion: number): void {
  if (!Number.isInteger(sessionVersion) || sessionVersion < 1) {
    throw new Error("Autoresearch requires Pi's current persistent session version");
  }
  const resolvedCwd = realpathSync(cwd);
  const resolvedSessionDir = realpathSync(sessionDir);
  if (resolvedSessionDir !== resolve(sessionDir)) {
    throw new Error("Autoresearch worker session directory must not contain symlink indirection");
  }
  for (const file of readdirSync(resolvedSessionDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const header = sessionHeader(join(resolvedSessionDir, file));
    if (header?.id !== sessionId) continue;
    if (header.cwd !== resolvedCwd) {
      throw new Error(`Autoresearch session ${sessionId} belongs to a different worker checkout`);
    }
    return;
  }

  const timestamp = new Date().toISOString();
  const path = join(resolvedSessionDir, `${sessionId}.jsonl`);
  const temporaryPath = join(resolvedSessionDir, `.${sessionId}.${randomUUID()}.tmp`);
  const header = {
    type: "session",
    version: sessionVersion,
    id: sessionId,
    timestamp,
    cwd: resolvedCwd,
  };
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(header)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporaryPath, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporaryPath); } catch {}
  }
}

function finalAssistant(messages: unknown): AgentMessage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as AgentMessage;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function assistantSnippet(message: unknown): string | undefined {
  const typed = message as AgentMessage;
  if (!typed || typed.role !== "assistant") return undefined;
  const value = typed.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return value ? value.slice(0, 500) : undefined;
}

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasActivePortfolioAssignment(canonicalRoot: string, workerId: string): boolean {
  const path = join(canonicalRoot, ".autoresearch", "portfolio.json");
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Cannot safely sync: canonical .autoresearch/portfolio.json is not a regular file");
  }
  let portfolio: unknown;
  try {
    portfolio = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot safely sync: malformed canonical .autoresearch/portfolio.json (${error instanceof Error ? error.message : String(error)})`);
  }
  const v1Keys = ["schema_version", "revision", "active_hypothesis_id", "paused", "pause_reason", "hypotheses", "history"];
  if (isRecord(portfolio) && portfolio.schema_version === 1) {
    if (Object.keys(portfolio).sort().join("\0") !== [...v1Keys].sort().join("\0")
      || typeof portfolio.revision !== "number" || !Number.isInteger(portfolio.revision) || portfolio.revision < 0
      || (portfolio.active_hypothesis_id !== null
        && (typeof portfolio.active_hypothesis_id !== "string" || !portfolio.active_hypothesis_id.trim()))
      || typeof portfolio.paused !== "boolean"
      || (portfolio.pause_reason !== null && (typeof portfolio.pause_reason !== "string" || !portfolio.pause_reason.trim()))
      || !isRecord(portfolio.hypotheses) || !Array.isArray(portfolio.history)) {
      throw new Error("Cannot safely sync: malformed canonical portfolio schema v1");
    }
    return portfolio.active_hypothesis_id !== null;
  }
  const portfolioKeys = ["schema_version", "revision", "active_assignments", "paused", "pause_reason", "hypotheses", "history"];
  if (!isRecord(portfolio) || portfolio.schema_version !== 2
    || Object.keys(portfolio).sort().join("\0") !== [...portfolioKeys].sort().join("\0")
    || typeof portfolio.revision !== "number" || !Number.isInteger(portfolio.revision) || portfolio.revision < 0
    || !isRecord(portfolio.active_assignments) || typeof portfolio.paused !== "boolean"
    || (portfolio.pause_reason !== null && (typeof portfolio.pause_reason !== "string" || !portfolio.pause_reason.trim()))
    || !isRecord(portfolio.hypotheses) || !Array.isArray(portfolio.history)
    || (portfolio.paused && Object.keys(portfolio.active_assignments).length > 0)) {
    throw new Error("Cannot safely sync: malformed or unsupported canonical portfolio schema");
  }
  for (const [id, value] of Object.entries(portfolio.active_assignments)) {
    const assignmentKeys = ["worker_id", "campaign_id", "hypothesis_id", "worker_token_sha256"];
    const hypothesis = isRecord(value) && typeof value.hypothesis_id === "string"
      ? portfolio.hypotheses[value.hypothesis_id]
      : undefined;
    if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...assignmentKeys].sort().join("\0")
      || value.worker_id !== id || typeof value.campaign_id !== "string" || !value.campaign_id.trim()
      || typeof value.hypothesis_id !== "string" || !value.hypothesis_id.trim()
      || !(id === "single-worker"
        ? value.worker_token_sha256 === null
        : typeof value.worker_token_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.worker_token_sha256))
      || !isRecord(hypothesis) || hypothesis.status !== "active") {
      throw new Error("Cannot safely sync: malformed canonical portfolio assignment");
    }
  }
  return Object.hasOwn(portfolio.active_assignments, workerId);
}

function activePortfolioWorkerIds(canonicalRoot: string): string[] {
  const path = join(canonicalRoot, ".autoresearch", "portfolio.json");
  if (!existsSync(path)) return [];
  // This call validates the complete portfolio before the bounded key read below.
  hasActivePortfolioAssignment(canonicalRoot, "__validation_only__");
  const portfolio = JSON.parse(readFileSync(path, "utf8")) as { active_assignments?: Record<string, unknown> };
  const workerIds = Object.keys(portfolio.active_assignments ?? {});
  for (const workerId of workerIds) {
    if (!/^w[1-4]$/.test(workerId)) throw new Error(`Unsupported active portfolio worker lane: ${workerId}`);
  }
  return workerIds.sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function assertNoActivePortfolioAssignment(canonicalRoot: string, workerId: string): void {
  if (hasActivePortfolioAssignment(canonicalRoot, workerId)) {
    throw new Error(`${workerId} has an active portfolio assignment and cannot be synced`);
  }
}

class FleetOperationCancelledError extends Error {}

interface DashboardRenderState {
  snapshot: FleetSnapshot;
  options: FleetDashboardOptions;
}

function renderDashboardLine(line: FleetWidgetLine, theme: any, width: number): string {
  const statusColor = line.status === "complete"
    ? "success"
    : line.status === "failed"
      ? "error"
      : line.status === "blocked" || line.status === "decision"
        ? "warning"
        : line.status === "running"
          ? "accent"
          : "muted";
  const rendered = line.segments.map((segment) => {
    switch (segment.role) {
      case "frame":
        return theme.fg("borderMuted", segment.text);
      case "group":
        return theme.fg("accent", theme.bold(segment.text));
      case "status":
        return theme.fg(statusColor, theme.bold(segment.text));
      case "model":
      case "metadata":
        return theme.fg("dim", segment.text);
      case "summary":
        return theme.fg("text", segment.text);
    }
  }).join("");
  return truncateToWidth(rendered, width);
}

export class AutoresearchSupervisor implements FleetCommandHandler {
  private readonly pi: ExtensionAPI;
  private readonly options: SupervisorOptions;
  private readonly clients = new Map<string, RpcWorkerClient>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly lanes = new Map<string, WorkerLane>();
  private store?: FleetStore;
  private repository?: RepositoryInfo;
  private generation?: number;
  private launching = false;
  private active = false;
  private shuttingDown = false;
  private currentCtx?: ExtensionContext;
  private dashboardTimer?: ReturnType<typeof setInterval>;
  private dashboardRenderState?: DashboardRenderState;
  private dashboardRequestRender: () => void = () => {};
  private dashboardWidgetRegistered = false;
  private notifiedStates = new Map<string, string>();
  private readonly workerSeeds = new Map<string, WorkerLaunchSeed>();
  private readonly admissionStartedAt = new Map<string, number>();
  private readonly admissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly executionPending = new Set<string>();
  private admissionLaunchInFlight = false;
  private fleetReadyForAdmission = false;
  private operation = 0;
  private setupTurnPending = false;

  constructor(pi: ExtensionAPI, options: SupervisorOptions = {}) {
    this.pi = pi;
    this.options = options;
    this.registerTools();
    this.pi.on("session_start", (_event, ctx) => {
      this.currentCtx = ctx;
      this.setToolsActive(false);
      this.restorePausedFleet(ctx);
    });
    this.pi.on("before_agent_start", () => {
      if (!this.active || !this.store || !this.repository) return;
      return {
        message: {
          customType: "autoresearch-fleet-snapshot",
          content: compactFleetContext(this.store.snapshot(this.repository.canonicalRoot, { recent: 4 })),
          display: false,
        },
      };
    });
    this.pi.on("agent_settled", () => {
      this.setupTurnPending = false;
    });
    this.pi.on("session_shutdown", async (_event, ctx) => {
      this.setupTurnPending = false;
      await this.shutdown(ctx);
    });
  }

  private restorePausedFleet(ctx: ExtensionContext): void {
    let store: FleetStore | undefined;
    try {
      const inspect = this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run));
      const repository = inspect(ctx.cwd);
      const dbPath = join(repository.canonicalRoot, ".autoresearch", "fleet.sqlite");
      if (!existsSync(dbPath)) return;
      store = (this.options.createStore ?? ((path) => new FleetStore(path)))(dbPath);
      const snapshot = store.snapshot(repository.canonicalRoot, { recent: 5 });
      if (snapshot.fleet?.status !== "paused" || snapshot.workers.length === 0) {
        store.close();
        return;
      }
      const generation = Number(snapshot.fleet.generation);
      if (!Number.isInteger(generation) || generation < 1) {
        throw new Error("paused fleet has an invalid generation");
      }
      if (Number(snapshot.fleet.protocol_version) !== AUTORESEARCH_PROTOCOL_VERSION) {
        throw new Error("paused fleet protocol does not match the loaded supervisor");
      }

      for (const worker of snapshot.workers) {
        if (worker.status !== "paused") continue;
        const workerSnapshot = store.snapshot(repository.canonicalRoot, { workerId: String(worker.worker_id), recent: 5 });
        if (workerSnapshot.admissions[0]?.state === "admitted") continue;
        const latest = workerSnapshot.checkpoints.find((checkpoint) => Number(checkpoint.generation) === generation);
        const checkpointStatus = String(latest?.status ?? "");
        if (["blocked", "decision", "failed", "complete", "stopped"].includes(checkpointStatus)) {
          store.parentUpdateWorker(repository.canonicalRoot, String(worker.worker_id), { status: checkpointStatus as WorkerStatus });
          worker.status = checkpointStatus;
        }
      }

      this.store = store;
      store = undefined;
      this.repository = repository;
      this.generation = generation;
      for (const [index, worker] of snapshot.workers.entries()) {
        const workerId = String(worker.worker_id);
        const path = String(worker.worktree);
        const branch = String(worker.branch);
        if (!workerId || !path || !branch) throw new Error("paused fleet contains an invalid worker lane");
        this.lanes.set(workerId, { workerId, index: index + 1, path, branch });
        this.notifiedStates.set(workerId, String(worker.status));
      }
      this.active = true;
      this.setToolsActive(true);
      this.startDashboard();
    } catch (error) {
      store?.close();
      this.closeFleetResources();
      this.active = false;
      this.setToolsActive(false);
      if (ctx.hasUI) {
        ctx.ui.notify(`Could not restore paused autoresearch fleet: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  }

  private requestProgramSetup(ctx: ExtensionContext): void {
    if (this.setupTurnPending) {
      if (ctx.hasUI) ctx.ui.notify("Autoresearch setup is already queued or running.", "info");
      return;
    }
    this.setupTurnPending = true;
    if (ctx.hasUI) {
      ctx.ui.notify("Autoresearch setup is required before workers can start: canonical program.md is missing.", "warning");
    }
    try {
      if (ctx.isIdle()) this.pi.sendUserMessage(PROGRAM_DESIGN_SETUP_PROMPT);
      else this.pi.sendUserMessage(PROGRAM_DESIGN_SETUP_PROMPT, { deliverAs: "followUp" });
    } catch (error) {
      this.setupTurnPending = false;
      if (ctx.hasUI) {
        ctx.ui.notify(`Could not start autoresearch setup: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  }

  start(count: number, ctx: ExtensionContext): void {
    if (this.shuttingDown) {
      ctx.ui.notify("Autoresearch supervisor is shutting down and cannot launch a fleet.", "error");
      return;
    }
    if (this.launching || this.active) {
      ctx.ui.notify("Autoresearch supervisor failure: a fleet is already launching or active.", "error");
      return;
    }

    let repository: RepositoryInfo;
    try {
      const inspect = this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run));
      repository = inspect(ctx.cwd);
      const program = readCanonicalProgram(repository.canonicalRoot);
      if (program.kind === "missing") {
        this.requestProgramSetup(ctx);
        return;
      }
      if (repository.dirty) {
        throw new Error("Canonical checkout is dirty. Commit the reviewed program and controller changes before launching /autoresearch workers.");
      }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Autoresearch supervisor failure: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }

    const operation = ++this.operation;
    this.launching = true;
    this.currentCtx = ctx;
    ctx.ui.notify(`Starting autoresearch with a maximum of ${count} workers.`, "info");
    setTimeout(() => {
      if (this.shuttingDown || operation !== this.operation) return;
      void this.launch(count, ctx, operation).catch((error) => {
        if (!(error instanceof FleetOperationCancelledError)) this.failSupervisor(error, ctx);
      });
    }, 0);
  }

  status(ctx: ExtensionContext): boolean {
    if (!this.launching && !this.active) return false;
    let detail = this.launching ? "launching" : "active";
    if (this.store && this.repository) {
      const snapshot = this.store.snapshot(this.repository.canonicalRoot, { recent: 1 });
      detail = `${String(snapshot.fleet?.status ?? detail)}, generation ${String(snapshot.fleet?.generation ?? "?")}, ${snapshot.workers.length} workers`;
    }
    if (ctx.hasUI) ctx.ui.notify(`Autoresearch fleet is ${detail}.`, "info");
    return true;
  }

  async stop(ctx: ExtensionContext): Promise<boolean> {
    if (!this.launching && !this.active) return false;
    ++this.operation;
    this.launching = false;
    this.active = false;
    this.stopDashboard();
    this.setToolsActive(false);
    await Promise.allSettled([...this.lanes.keys()].map((id) => this.stopWorker(id, "stopped")));
    if (this.store && this.repository) this.store.setFleetStatus(this.repository.canonicalRoot, "stopped");
    this.closeFleetResources();
    if (ctx.hasUI) ctx.ui.notify("Stopped autoresearch fleet.", "info");
    return true;
  }

  private assertOperation(operation: number): void {
    if (this.shuttingDown || operation !== this.operation) {
      throw new FleetOperationCancelledError("Autoresearch fleet operation was cancelled");
    }
  }

  private async launch(count: number, ctx: ExtensionContext, operation: number): Promise<void> {
    this.assertOperation(operation);
    const inspect = this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run));
    const repository = inspect(ctx.cwd);
    const program = readCanonicalProgram(repository.canonicalRoot);
    if (program.kind !== "valid") throw new Error("Canonical program.md disappeared before fleet provisioning");
    if (repository.dirty) {
      throw new Error("Canonical checkout is dirty. Commit the reviewed program and controller changes before launching /autoresearch workers.");
    }
    this.repository = repository;
    const stateDir = join(repository.canonicalRoot, ".autoresearch");
    const sessionsDir = join(stateDir, "sessions");
    const artifactsDir = join(stateDir, "artifacts", "runs");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });
    (this.options.ensureIgnored ?? ((root) => ensureAutoresearchIgnored(root, this.options.run)))(repository.canonicalRoot);

    const registeredLanes = workerLanes(repository.canonicalRoot, MAX_AUTORESEARCH_WORKERS);
    const lanesById = new Map(registeredLanes.map((lane) => [lane.workerId, lane]));
    const activeOwners = activePortfolioWorkerIds(repository.canonicalRoot);
    if (activeOwners.length > count) {
      throw new FleetAlreadyActiveError(
        `Requested capacity ${count} is below ${activeOwners.length} active portfolio owners: ${activeOwners.join(", ")}`,
      );
    }
    const selectedIds = [...activeOwners];
    for (const lane of registeredLanes) {
      if (selectedIds.length >= count) break;
      if (!selectedIds.includes(lane.workerId)) selectedIds.push(lane.workerId);
    }
    const lanes = selectedIds.map((workerId) => lanesById.get(workerId)!);
    const ensureLane = this.options.ensureLane ?? ((root, commonDir, lane) => ensureWorkerLane(root, commonDir, lane, this.options.run));
    for (const lane of lanes) {
      ensureLane(repository.canonicalRoot, repository.commonDir, lane);
      this.lanes.set(lane.workerId, lane);
    }

    const token = this.options.token ?? randomUUID;
    const sessionId = this.options.sessionId ?? randomUUID;
    const dbPath = join(stateDir, "fleet.sqlite");
    this.store = (this.options.createStore ?? ((path) => new FleetStore(path)))(dbPath);
    let seeds: WorkerSeed[];
    try {
      const previousWorkers = new Map(
        this.store.snapshot(repository.canonicalRoot, { recent: 1 }).workers
          .map((worker) => [String(worker.worker_id), worker]),
      );
      const requestedWorkers = new Set(lanes.map((lane) => lane.workerId));
      for (const [workerId] of previousWorkers) {
        if (!requestedWorkers.has(workerId) && hasActivePortfolioAssignment(repository.canonicalRoot, workerId)) {
          throw new FleetAlreadyActiveError(`Cannot resize below active portfolio owner ${workerId}`);
        }
      }
      seeds = lanes.map((lane) => {
        const previous = previousWorkers.get(lane.workerId);
        const resumesPortfolio = hasActivePortfolioAssignment(repository.canonicalRoot, lane.workerId);
        return {
          workerId: lane.workerId,
          sessionId: sessionId(),
          token: resumesPortfolio && typeof previous?.token === "string" ? previous.token : token(),
          worktree: lane.path,
          branch: lane.branch,
          sessionsRoot: sessionsDir,
        };
      });
      this.generation = this.store.beginFleet({
        canonicalRoot: repository.canonicalRoot,
        parentSession: ctx.sessionManager.getSessionFile(),
        canonicalHead: repository.head,
        maxEvidenceStages: repository.maxEvidenceStages,
        admission: {
          timeoutMs: this.options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
          maxCost: this.options.admissionMaxCostUsd ?? DEFAULT_ADMISSION_MAX_COST_USD,
          maxTurns: this.options.admissionMaxTurns ?? DEFAULT_ADMISSION_MAX_TURNS,
          maxToolCalls: this.options.admissionMaxToolCalls ?? DEFAULT_ADMISSION_MAX_TOOL_CALLS,
        },
        workers: seeds,
        now: (this.options.now ?? Date.now)(),
      });
    } catch (error) {
      if (error instanceof FleetAlreadyActiveError) {
        const existing = this.store.snapshot(repository.canonicalRoot);
        const status = String(existing.fleet?.status ?? "active");
        const generation = String(existing.fleet?.generation ?? "?");
        this.launching = false;
        this.active = false;
        this.setToolsActive(false);
        this.store.close();
        this.store = undefined;
        this.repository = undefined;
        this.generation = undefined;
        this.lanes.clear();
        throw new FleetAlreadyActiveError(
          `Durable fleet reservation is ${status} at generation ${generation}, but this supervisor owns no RPC workers. ${error.message} Refusing to attach or relaunch unreconciled work.`,
        );
      }
      throw error;
    }

    this.assertOperation(operation);
    const syncLane = this.options.syncLane ?? syncLaneToCanonical;
    for (const lane of lanes) {
      const resumesCampaign = hasActivePortfolioAssignment(repository.canonicalRoot, lane.workerId)
        || this.store.hasActiveReservation(repository.canonicalRoot, lane.workerId);
      if (resumesCampaign) continue;
      const synced = syncLane({
        canonicalRoot: repository.canonicalRoot,
        lane,
        generation: this.generation,
        canonicalHead: repository.head,
        now: (this.options.now ?? Date.now)(),
        run: this.options.run,
      });
      if (synced.canonicalHead !== repository.head) {
        throw new Error(`${lane.workerId} was not synchronized to the reviewed canonical commit`);
      }
    }

    this.assertOperation(operation);
    this.active = true;
    this.setToolsActive(true);
    const model = ctx.model;
    const thinking = this.pi.getThinkingLevel();
    const planningProvider = this.options.planningProvider ?? model?.provider ?? "openai-codex";
    const planningModel = this.options.planningModel ?? model?.id ?? "gpt-5.6-sol";
    const planningThinking = this.options.planningThinking ?? this.pi.getThinkingLevel();
    for (const [index, seed] of seeds.entries()) {
      this.workerSeeds.set(seed.workerId, seed);
      this.store.parentUpdateWorker(repository.canonicalRoot, seed.workerId, {
        status: index === 0 ? "launching" : "queued",
        task: index === 0 ? "Claiming a bounded campaign" : "Waiting for sequential admission",
        model: `${planningProvider}/${planningModel}`,
        thinking: planningThinking,
        contextWindow: model?.contextWindow,
      });
    }
    this.startDashboard();
    await this.launchWorker(seeds[0], planningProvider, planningModel, planningThinking, operation);
    this.assertOperation(operation);
    this.store.activateFleet(repository.canonicalRoot, this.generation);
    this.fleetReadyForAdmission = true;
    this.launching = false;
    this.refreshDashboard();
    void this.launchNextQueuedWorker();
  }

  private async launchWorker(seed: WorkerLaunchSeed, provider?: string, model?: string, thinking?: ThinkingLevel, operation = this.operation): Promise<void> {
    this.assertOperation(operation);
    if (!this.repository || !this.store || !this.generation) throw new Error("Fleet launch state is incomplete");
    const lane = this.lanes.get(seed.workerId);
    if (!lane) throw new Error(`Missing lane ${seed.workerId}`);
    let codingAgent: typeof import("@earendil-works/pi-coding-agent") | undefined;
    if (!this.options.cliPath || !this.options.createRpcClient) {
      codingAgent = await import("@earendil-works/pi-coding-agent");
    }
    this.assertOperation(operation);
    const cliPath = resolvePiCliPath(this.options.cliPath, codingAgent?.getPackageDir());
    const extensionPath = realpathSync(this.options.extensionPath ?? fileURLToPath(new URL("../autoresearch.ts", import.meta.url)));
    const stateDir = join(this.repository.canonicalRoot, ".autoresearch");
    const artifactsDir = join(stateDir, "artifacts", "runs");
    const sessionDir = join(seed.sessionsRoot, `generation-${this.generation}`);
    mkdirSync(artifactsDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const sessionVersion = codingAgent?.CURRENT_SESSION_VERSION ?? this.options.sessionVersion;
    ensureWorkerSession(lane.path, sessionDir, seed.sessionId, sessionVersion ?? Number.NaN);
    this.assertOperation(operation);
    let createClient = this.options.createRpcClient;
    if (!createClient) {
      const RpcClient = codingAgent!.RpcClient;
      createClient = (rpcOptions: RpcClientOptions) => new RpcClient(rpcOptions);
    }
    const env = {
      AUTORESEARCH_ROLE: "worker",
      AUTORESEARCH_WORKER_ID: seed.workerId,
      AUTORESEARCH_SESSION_ID: seed.sessionId,
      AUTORESEARCH_STATE_DIR: stateDir,
      AUTORESEARCH_FLEET_DB: join(stateDir, "fleet.sqlite"),
      AUTORESEARCH_ARTIFACTS_DIR: artifactsDir,
      AUTORESEARCH_WORKER_TOKEN: seed.token,
      AUTORESEARCH_CANONICAL_ROOT: this.repository.canonicalRoot,
      AUTORESEARCH_GENERATION: String(this.generation),
    };
    const shortSessionId = seed.sessionId.slice(0, 8);
    const args = [
      "--session-id", seed.sessionId,
      "--session-dir", sessionDir,
      "--no-extensions",
      "--extension", extensionPath,
      "--name", `autoresearch ${seed.workerId} ${shortSessionId}`,
    ];
    if (thinking) args.push("--thinking", thinking);
    const client = createClient({ cliPath, cwd: lane.path, env, provider, model, args });
    this.clients.set(seed.workerId, client);
    const unsubscribe = client.onEvent((event) => this.handleWorkerEvent(seed.workerId, seed.token, event));
    this.unsubscribers.set(seed.workerId, unsubscribe);
    await client.start();
    try {
      this.assertOperation(operation);
    } catch (error) {
      this.unsubscribers.get(seed.workerId)?.();
      this.unsubscribers.delete(seed.workerId);
      this.clients.delete(seed.workerId);
      await client.stop();
      throw error;
    }
    const state = await client.getState();
    const admission = this.store.snapshot(this.repository.canonicalRoot, { workerId: seed.workerId, recent: 1 }).admissions[0];
    const alreadyAdmitted = admission?.state === "admitted";
    this.store.parentUpdateWorker(this.repository.canonicalRoot, seed.workerId, { status: "idle", sessionFile: state.sessionFile ?? null });
    if (!alreadyAdmitted) this.startAdmission(seed.workerId);
    const program = readFileSync(join(lane.path, "program.md"), "utf8").trim();
    if (!program) throw new Error(`${seed.workerId} program.md is empty`);
    const admissionSeconds = Math.max(0, Math.round((this.options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS) / 1_000));
    const admissionCost = this.options.admissionMaxCostUsd ?? DEFAULT_ADMISSION_MAX_COST_USD;
    const admissionTurns = this.options.admissionMaxTurns ?? DEFAULT_ADMISSION_MAX_TURNS;
    const admissionTools = this.options.admissionMaxToolCalls ?? DEFAULT_ADMISSION_MAX_TOOL_CALLS;
    this.assertOperation(operation);
    const prompt = alreadyAdmitted
      ? [
          `Resume the admitted autoresearch campaign for ${seed.workerId}.`,
          "Reread durable worker and portfolio state, then continue the accepted campaign. Reserve evidence capacity before scarce or paid evidence-stage work.",
          "Research program:",
          program,
        ]
      : [
          `You are bounded admission planner ${seed.workerId} in an isolated reusable Git worktree.`,
          "Before candidate, benchmark, or evidence mutation, restore or atomically claim exactly one executable portfolio recommendation.",
          "Publish exactly one offer_admission action with its exact campaign ID, hypothesis ID, next stage, and non-empty claimedScopes. Claimed scopes must name concrete exclusive mutable resources, not broad track names, campaign themes, model targets, or descriptive labels. The offer must match your fenced portfolio assignment and conflict with no accepted scope.",
          `Admission is limited to ${admissionSeconds} seconds, ${admissionTurns} model turns, ${admissionTools} tool calls, and $${admissionCost.toFixed(2)} of worker-session model cost. Prefer narrow readiness checks over broad repository or history exploration. If no legal campaign can be offered within that envelope, checkpoint a direct blocker and stop.`,
          "End the turn immediately after offer_admission and wait. Do not mutate candidate, benchmark, or evidence state until the supervisor accepts the durable offer and starts the execution phase.",
          "If shared state contains an evidence reservation from an earlier generation, reconcile that exact work and release it with a terminal receipt before offering execution; never relaunch it silently.",
          "Do not wait for parent transcript context and do not invoke parent supervisor controls.",
          "Research program:",
          program,
        ];
    await client.prompt(prompt.join("\n\n"));
    this.assertOperation(operation);
  }

  private startAdmission(workerId: string): void {
    this.finishAdmission(workerId);
    const now = (this.options.now ?? Date.now)();
    if (!this.store || !this.repository || !this.generation) throw new Error("Fleet admission state is incomplete");
    const lane = this.lanes.get(workerId);
    if (!lane) throw new Error(`Missing lane ${workerId}`);
    const laneState = (this.options.laneState ?? ((path) => laneGitState(path, this.options.run)))(lane.path);
    this.store.beginAdmission(this.repository.canonicalRoot, workerId, this.generation, laneState, now);
    const admission = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 }).admissions[0];
    const startedAt = Number(admission?.started_at ?? now);
    const timeout = Number(admission?.timeout_ms ?? this.options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS);
    this.admissionStartedAt.set(workerId, startedAt);
    if (timeout <= 0) return;
    const remaining = Math.max(0, timeout - Math.max(0, now - startedAt));
    const timer = setTimeout(() => {
      this.evaluateAdmission(workerId, false);
      if (this.admissionStartedAt.has(workerId)) {
        void this.failAdmission(workerId, `campaign admission exceeded ${Math.round(timeout / 1_000)} seconds`);
      }
    }, remaining);
    this.admissionTimers.set(workerId, timer);
  }

  private finishAdmission(workerId: string): void {
    const timer = this.admissionTimers.get(workerId);
    if (timer) clearTimeout(timer);
    this.admissionTimers.delete(workerId);
    this.admissionStartedAt.delete(workerId);
  }

  private evaluateAdmission(workerId: string, acceptOffer = true): void {
    if (!this.admissionStartedAt.has(workerId) || !this.store || !this.repository || !this.generation) return;
    const root = this.repository.canonicalRoot;
    const snapshot = this.store.snapshot(root, { workerId, recent: 1 });
    const admission = snapshot.admissions[0];
    const worker = snapshot.workers[0];
    const status = String(worker?.status ?? "");
    if (admission?.state === "offered") {
      if (!acceptOffer) return;
      const offeredBudgetReason = this.store.admissionBudgetViolation(root, workerId, this.generation, (this.options.now ?? Date.now)());
      if (offeredBudgetReason) {
        void this.failAdmission(workerId, offeredBudgetReason);
        return;
      }
      const lane = this.lanes.get(workerId);
      if (!lane) {
        void this.failAdmission(workerId, "admission lane is unavailable");
        return;
      }
      const laneState = (this.options.laneState ?? ((path) => laneGitState(path, this.options.run)))(lane.path);
      if (this.store.admissionLaneChanged(root, workerId, this.generation, laneState)) {
        void this.failAdmission(workerId, "planner mutated candidate state after bounded admission began");
        return;
      }
      try {
        const result = this.store.admitOfferedCampaign(root, workerId, this.generation, (this.options.now ?? Date.now)());
        if (!result.admitted) {
          void this.failAdmission(workerId, result.reason ?? "campaign admission offer was rejected");
          return;
        }
        this.finishAdmission(workerId);
        this.executionPending.add(workerId);
        void this.launchNextQueuedWorker();
        return;
      } catch (error) {
        void this.failAdmission(workerId, error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (admission?.state === "admitted") {
      this.finishAdmission(workerId);
      return;
    }
    if (admission?.state === "blocked") {
      this.finishAdmission(workerId);
      void this.launchNextQueuedWorker();
      return;
    }
    const budgetReason = this.store.admissionBudgetViolation(root, workerId, this.generation, (this.options.now ?? Date.now)());
    if (budgetReason) {
      void this.failAdmission(workerId, budgetReason);
      return;
    }
    if (TERMINAL_WORKER_STATUSES.has(status)) {
      const reason = String(worker?.summary ?? worker?.error ?? `planner ended with ${status} before publishing a valid admission offer`);
      this.finishAdmission(workerId);
      this.store.blockAdmission(root, workerId, this.generation, reason, (this.options.now ?? Date.now)());
      void this.launchNextQueuedWorker();
    }
  }

  private async transitionAdmittedWorker(workerId: string): Promise<void> {
    if (!this.executionPending.delete(workerId) || !this.store || !this.repository || this.shuttingDown) return;
    const client = this.clients.get(workerId);
    if (!client) return;
    const model = this.currentCtx?.model;
    const thinking = this.pi.getThinkingLevel();
    try {
      if (client.compact) {
        try {
          await client.compact("Preserve only the exact accepted campaign ID, hypothesis ID, stage, claimed scopes, portfolio fence, and immediate next action. The planning phase is complete; reread program.md and durable state before execution.");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("Nothing to compact") && !message.includes("Already compacted")) throw error;
        }
      }
      if (model && client.setModel) await client.setModel(model.provider, model.id);
      if (client.setThinkingLevel) await client.setThinkingLevel(thinking);
      this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, {
        status: "launching",
        model: model ? `${model.provider}/${model.id}` : undefined,
        thinking,
        contextWindow: model?.contextWindow,
      });
      const executionPrompt = "Campaign admission is accepted. Begin a fresh execution phase from the durable admission checkpoint. Reread program.md and shared state, remain within the accepted scopes, and reserve evidence before scarce or paid work.";
      const state = await client.getState();
      if (state.isStreaming) await client.followUp(executionPrompt);
      else await client.prompt(executionPrompt);
    } catch (error) {
      this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, {
        status: "failed",
        error: `could not enter execution phase: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    this.refreshDashboard();
  }

  private async failAdmission(workerId: string, reason: string): Promise<void> {
    if (!this.admissionStartedAt.has(workerId) || !this.store || !this.repository || this.shuttingDown) return;
    this.finishAdmission(workerId);
    this.store.blockAdmission(this.repository.canonicalRoot, workerId, this.generation, reason, (this.options.now ?? Date.now)());
    this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, {
      status: "blocked",
      summary: `Stopped bounded campaign admission: ${reason}.`,
      error: reason,
      currentTool: null,
    });
    try { await this.clients.get(workerId)?.abort(); } catch {}
    this.refreshDashboard();
    await this.launchNextQueuedWorker();
  }

  private async launchNextQueuedWorker(): Promise<void> {
    if (!this.active || !this.fleetReadyForAdmission || this.admissionLaunchInFlight || this.admissionStartedAt.size > 0
      || !this.store || !this.repository || !this.generation || this.shuttingDown) return;
    const row = this.store.claimNextQueuedAdmission(
      this.repository.canonicalRoot,
      this.generation,
      (this.options.now ?? Date.now)(),
    );
    if (!row) return;
    const workerId = String(row.worker_id);
    const seed = this.workerSeeds.get(workerId) ?? {
      workerId,
      sessionId: String(row.session_id),
      token: String(row.token),
      worktree: String(row.worktree),
      branch: String(row.branch),
      sessionsRoot: dirname(String(row.session_dir)),
    };
    this.workerSeeds.set(workerId, seed);
    this.admissionLaunchInFlight = true;
    this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, {
      task: "Claiming a bounded campaign",
      error: null,
    });
    try {
      await this.launchWorker(
        seed,
        this.options.planningProvider ?? this.currentCtx?.model?.provider ?? "openai-codex",
        this.options.planningModel ?? this.currentCtx?.model?.id ?? "gpt-5.6-sol",
        this.options.planningThinking ?? this.pi.getThinkingLevel(),
        this.operation,
      );
    } catch (error) {
      if (!(error instanceof FleetOperationCancelledError) && this.store && this.repository) {
        this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        this.refreshDashboard();
      }
    } finally {
      this.admissionLaunchInFlight = false;
      void this.launchNextQueuedWorker();
    }
  }

  private handleWorkerEvent(workerId: string, token: string, event: any): void {
    if (!this.store || !this.repository || !this.generation || this.shuttingDown) return;
    const root = this.repository.canonicalRoot;
    try {
      const worker = this.store.snapshot(root, { workerId, recent: 1 }).workers[0];
      if (!worker || Number(worker.generation) !== this.generation || worker.token !== token) return;
      const currentStatus = String(worker.status ?? "");
      if (TERMINAL_WORKER_STATUSES.has(currentStatus)) {
        this.evaluateAdmission(workerId, ["message_end", "agent_end", "agent_settled"].includes(event.type));
        if (event.type === "agent_settled") void this.transitionAdmittedWorker(workerId);
        if (["message_end", "agent_end", "agent_settled", "extension_error"].includes(event.type)) this.refreshDashboard();
        return;
      }
      if (event.type === "agent_start") this.store.parentUpdateWorker(root, workerId, { currentTool: null });
      if (event.type === "tool_execution_start") {
        this.store.parentUpdateWorker(root, workerId, { currentTool: event.toolName });
      }
      if (event.type === "tool_execution_end") {
        this.store.parentUpdateWorker(root, workerId, { currentTool: null, error: event.isError ? `${event.toolName} failed` : null });
      }
      if (event.type === "message_end") {
        const snippet = assistantSnippet(event.message);
        if (snippet) this.store.parentUpdateWorker(root, workerId, { summary: snippet });
      }
      if (event.type === "agent_end") {
        const assistant = finalAssistant(event.messages);
        if (assistant?.role === "assistant" && !["stop", "toolUse"].includes(assistant.stopReason)) {
          this.store.parentUpdateWorker(root, workerId, { status: "failed", error: assistant.errorMessage ?? assistant.stopReason });
        }
      }
      if (event.type === "agent_settled") {
        const worker = this.store.snapshot(root, { workerId, recent: 1 }).workers[0];
        if (worker && !["paused", "blocked", "decision", "failed", "complete", "stopped"].includes(String(worker.status))) {
          this.store.parentUpdateWorker(root, workerId, { status: "idle", currentTool: null });
        }
      }
      if (event.type === "extension_error") {
        this.store.parentUpdateWorker(root, workerId, { status: "failed", error: event.error ?? "extension error" });
      }
      if (["tool_execution_end", "message_end", "agent_end", "agent_settled", "extension_error"].includes(event.type)) {
        this.evaluateAdmission(workerId, event.type !== "tool_execution_end");
        if (event.type === "agent_settled") void this.transitionAdmittedWorker(workerId);
        this.refreshDashboard();
      }
    } catch (error) {
      this.failSupervisor(error, this.currentCtx);
    }
  }

  private registerTools(): void {
    this.pi.registerTool({
      name: "autoresearch_inspect",
      label: "Autoresearch Inspect",
      description: "Inspect bounded shared operational state for the active autoresearch fleet without injecting worker transcripts.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "worker"] },
          worker: { type: "string", description: "Worker lane id such as w1" },
          view: { type: "string", enum: ["summary", "recent"] },
          recent: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const { store, root } = this.requireActive();
        const workerId = params.scope === "worker" ? params.worker : undefined;
        if (params.scope === "worker" && !workerId) throw new Error("worker scope requires worker id");
        const snapshot = store.snapshot(root, { workerId, recent: params.recent });
        const result = boundedInspect(snapshot, params.view ?? "summary");
        return { content: [{ type: "text", text: resultText(result) }], details: result };
      },
    });

    this.pi.registerTool({
      name: "autoresearch_control",
      label: "Autoresearch Control",
      description: "Steer, pause, resume, restart, stop, or safely sync workers in the active autoresearch fleet.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["steer", "follow_up", "pause", "resume", "restart", "stop", "sync"] },
          target: { type: "string", description: "Worker lane id, full session UUID, UUID prefix of at least 8 hex characters, or all" },
          message: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const result = await this.control(params.action, params.target ?? "all", params.message);
        return { content: [{ type: "text", text: resultText(result) }], details: result };
      },
    });
  }

  private requireActive(): { store: FleetStore; root: string } {
    if (!this.active || !this.store || !this.repository) throw new Error("No active autoresearch fleet");
    return { store: this.store, root: this.repository.canonicalRoot };
  }

  private targets(target: string): string[] {
    if (target === "all") return [...this.lanes.keys()].sort();
    if (this.lanes.has(target)) return [target];
    const { store, root } = this.requireActive();
    const workers = store.snapshot(root, { recent: 1 }).workers;
    const normalized = target.toLowerCase();
    const fullMatch = workers.find((worker) => String(worker.session_id).toLowerCase() === normalized);
    if (fullMatch) return [String(fullMatch.worker_id)];
    if (!/^[0-9a-f]{8,32}$/i.test(target)) throw new Error(`Unknown worker target: ${target}`);
    const matches = workers.filter((worker) =>
      String(worker.session_id).replaceAll("-", "").toLowerCase().startsWith(normalized),
    );
    if (matches.length === 0) throw new Error(`Unknown worker session UUID prefix: ${target}`);
    if (matches.length > 1) throw new Error(`Ambiguous worker session UUID prefix: ${target}`);
    return [String(matches[0].worker_id)];
  }

  async control(action: string, target: string, message?: string): Promise<Record<string, unknown>> {
    const { store, root } = this.requireActive();
    const targets = this.targets(target);
    if (["steer", "follow_up"].includes(action) && !message?.trim()) throw new Error(`${action} requires message`);

    if (action === "sync") {
      for (const workerId of targets) await this.assertSyncSafe(workerId);
      const synced: Record<string, unknown>[] = [];
      for (const workerId of targets) {
        const lane = this.lanes.get(workerId)!;
        const result = (this.options.syncLane ?? syncLaneToCanonical)({
          canonicalRoot: root,
          lane,
          generation: this.generation!,
          now: (this.options.now ?? Date.now)(),
          run: this.options.run,
        });
        store.parentUpdateWorker(root, workerId, {
          head: result.canonicalHead,
          summary: `Synced idle lane; candidate preserved at ${result.candidateRef}. This is not a tested candidate.`,
        });
        synced.push({ workerId, ...result });
      }
      this.refreshDashboard();
      return { action, synced };
    }

    for (const workerId of targets) {
      const client = this.clients.get(workerId);
      if (action === "steer") await client?.steer(message!.trim());
      if (action === "follow_up") await client?.followUp(message!.trim());
      if (action === "pause") {
        store.parentUpdateWorker(root, workerId, { status: "paused", summary: "Paused by supervisor" });
        await client?.abort();
      }
      if (action === "resume") {
        if (!client) throw new Error(`${workerId} has no running RPC process; use restart`);
        store.parentUpdateWorker(root, workerId, { status: "idle", error: null });
        const state = await client.getState();
        if (state.isStreaming) await client.followUp(message?.trim() || "Resume the autoresearch campaign from shared state.");
        else await client.prompt(message?.trim() || "Resume the autoresearch campaign from shared state.");
        store.setFleetStatus(root, "active");
      }
      if (action === "restart") {
        await this.restartWorker(workerId);
        store.setFleetStatus(root, "active");
      }
      if (action === "stop") await this.stopWorker(workerId, "stopped");
    }

    if (action === "stop") {
      const snapshot = store.snapshot(root);
      if (snapshot.workers.every((worker) => worker.status === "stopped")) {
        store.setFleetStatus(root, "stopped");
        this.active = false;
        this.stopDashboard();
        this.setToolsActive(false);
        this.closeFleetResources();
      }
      this.currentCtx?.ui.notify(`Stopped autoresearch ${target}.`, "info");
    }
    this.refreshDashboard();
    return { action, targets };
  }

  private async assertSyncSafe(workerId: string): Promise<void> {
    const { store, root } = this.requireActive();
    const worker = store.snapshot(root, { workerId, recent: 1 }).workers[0];
    if (!worker) throw new Error(`Missing worker state: ${workerId}`);
    const status = String(worker.status);
    if (!["paused", "blocked", "decision", "failed", "complete", "stopped"].includes(status)) {
      throw new Error(`${workerId} must be paused or terminal before sync`);
    }
    const client = this.clients.get(workerId);
    if (!client && status !== "stopped") throw new Error(`${workerId} process ownership is not reconciled`);
    if (client && (await client.getState()).isStreaming) throw new Error(`${workerId} process is not reconciled`);
    assertNoActivePortfolioAssignment(root, workerId);
    if (store.hasActiveReservation(root, workerId)) throw new Error(`${workerId} has an active evidence reservation`);
    const lane = this.lanes.get(workerId)!;
    const state = (this.options.laneState ?? ((path) => laneGitState(path, this.options.run)))(lane.path);
    if (state.dirty) throw new Error(`${workerId} worktree is dirty`);
  }

  private async restartWorker(workerId: string): Promise<void> {
    const { store, root } = this.requireActive();
    const before = store.snapshot(root, { workerId, recent: 1 });
    const admissionState = String(before.admissions[0]?.state ?? "");
    if (admissionState === "queued") {
      const all = store.snapshot(root, { recent: 1 });
      const firstQueued = all.admissions.find((admission) => admission.state === "queued");
      const open = all.admissions.some((admission) => ["planning", "offered"].includes(String(admission.state)));
      if (open || String(firstQueued?.worker_id ?? "") !== workerId) {
        throw new Error(`${workerId} is queued and cannot bypass sequential campaign admission`);
      }
    }
    await this.stopWorker(workerId, "paused");
    const snapshot = store.snapshot(root, { workerId, recent: 1 });
    let row = snapshot.workers[0];
    if (!row) throw new Error(`Missing worker state: ${workerId}`);
    if (snapshot.admissions[0]?.state === "queued") {
      const claimed = store.claimNextQueuedAdmission(root, Number(snapshot.fleet?.generation), (this.options.now ?? Date.now)());
      if (!claimed || claimed.worker_id !== workerId) throw new Error(`${workerId} lost the sequential admission claim`);
      row = claimed;
    }
    const seed = {
      workerId,
      sessionId: String(row.session_id),
      token: String(row.token),
      worktree: String(row.worktree),
      branch: String(row.branch),
      sessionsRoot: dirname(String(row.session_dir)),
    };
    this.workerSeeds.set(workerId, seed);
    const admitted = snapshot.admissions[0]?.state === "admitted";
    if (admitted) store.parentUpdateWorker(root, workerId, { status: "launching", error: null });
    await this.launchWorker(
      seed,
      admitted ? this.currentCtx?.model?.provider : this.options.planningProvider ?? this.currentCtx?.model?.provider ?? "openai-codex",
      admitted ? this.currentCtx?.model?.id : this.options.planningModel ?? this.currentCtx?.model?.id ?? "gpt-5.6-sol",
      admitted ? this.pi.getThinkingLevel() : this.options.planningThinking ?? this.pi.getThinkingLevel(),
      this.operation,
    );
    this.fleetReadyForAdmission = true;
    void this.launchNextQueuedWorker();
  }

  private async stopWorker(workerId: string, status: WorkerStatus): Promise<void> {
    this.finishAdmission(workerId);
    const client = this.clients.get(workerId);
    this.unsubscribers.get(workerId)?.();
    this.unsubscribers.delete(workerId);
    let stopError: unknown;
    if (client) {
      try { await client.abort(); } catch {}
      try { await client.stop(); } catch (error) { stopError = error; }
      this.clients.delete(workerId);
    }
    if (this.store && this.repository && this.generation) {
      const snapshot = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 });
      const currentStatus = String(snapshot.workers[0]?.status ?? "");
      const openAdmission = ["planning", "offered"].includes(String(snapshot.admissions[0]?.state ?? ""));
      if (status === "paused" && openAdmission) {
        this.store.pauseAdmission(this.repository.canonicalRoot, workerId, this.generation, (this.options.now ?? Date.now)());
        this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, { status: "queued", currentTool: null });
      } else if (status === "stopped" && openAdmission) {
        this.store.blockAdmission(this.repository.canonicalRoot, workerId, this.generation, "stopped by supervisor", (this.options.now ?? Date.now)());
        this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, { status: "stopped", currentTool: null });
      } else if (status === "paused" && snapshot.admissions[0]?.state === "admitted"
        && !["blocked", "failed", "complete", "stopped"].includes(currentStatus)) {
        this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, { status: "paused", currentTool: null });
      } else if (status === "stopped" || (currentStatus !== "queued" && !TERMINAL_WORKER_STATUSES.has(currentStatus))) {
        this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, { status });
      }
    }
    if (status === "stopped" && this.active && !this.shuttingDown) void this.launchNextQueuedWorker();
    if (stopError) throw stopError;
  }

  private closeFleetResources(): void {
    for (const timer of this.admissionTimers.values()) clearTimeout(timer);
    this.admissionTimers.clear();
    this.admissionStartedAt.clear();
    this.executionPending.clear();
    this.workerSeeds.clear();
    this.admissionLaunchInFlight = false;
    this.fleetReadyForAdmission = false;
    this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.generation = undefined;
    this.lanes.clear();
    this.notifiedStates.clear();
  }

  private startDashboard(): void {
    this.refreshDashboard();
    const interval = this.options.dashboardIntervalMs ?? 5_000;
    if (interval > 0 && !this.dashboardTimer) {
      this.dashboardTimer = setInterval(() => this.refreshDashboard(), interval);
    }
  }

  private stopDashboard(): void {
    if (this.dashboardTimer) clearInterval(this.dashboardTimer);
    this.dashboardTimer = undefined;
    this.dashboardRenderState = undefined;
    this.dashboardRequestRender = () => {};
    this.dashboardWidgetRegistered = false;
    this.currentCtx?.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, undefined);
  }

  private updateDashboardWidget(state: DashboardRenderState): void {
    const ctx = this.currentCtx;
    if (!ctx) return;
    this.dashboardRenderState = state;
    if (ctx.mode !== "tui") {
      const content = fleetDashboardWidgetLines(state.snapshot, state.options)
        .map((line) => line.segments.map((segment) => segment.text).join(""));
      ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, content, { placement: "belowEditor" });
      return;
    }
    if (!this.dashboardWidgetRegistered) {
      this.dashboardWidgetRegistered = true;
      ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, (tui, theme) => {
        this.dashboardRequestRender = () => tui.requestRender();
        return {
          render: (width: number) => {
            const current = this.dashboardRenderState;
            if (!current) return [];
            return fleetDashboardWidgetLines(current.snapshot, current.options)
              .map((line) => renderDashboardLine(line, theme, width));
          },
          invalidate() {},
        };
      }, { placement: "belowEditor" });
      return;
    }
    this.dashboardRequestRender();
  }

  private refreshDashboard(): void {
    if (!this.active || !this.store || !this.repository || !this.currentCtx) return;
    try {
      const snapshot = this.store.snapshot(this.repository.canonicalRoot, { recent: 5 });
      let repo = this.repository;
      try {
        repo = (this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run)))(this.repository.canonicalRoot);
      } catch {}
      this.updateDashboardWidget({
        snapshot,
        options: {
          now: (this.options.now ?? Date.now)(),
          canonicalHead: repo.head,
          canonicalDirty: repo.dirty,
          canonicalChanged: typeof snapshot.fleet?.canonical_head === "string" && snapshot.fleet.canonical_head !== repo.head,
          protocolChanged: Number(snapshot.fleet?.protocol_version) !== AUTORESEARCH_PROTOCOL_VERSION,
        },
      });
      this.notifyImportantTransitions(snapshot);
    } catch (error) {
      this.failSupervisor(error, this.currentCtx);
    }
  }

  private notifyImportantTransitions(snapshot: FleetSnapshot): void {
    const ctx = this.currentCtx;
    if (!ctx) return;
    const transitions: Array<{ id: string; status: string; line: string }> = [];
    for (const worker of snapshot.workers) {
      const id = String(worker.worker_id);
      const status = String(worker.status);
      const previous = this.notifiedStates.get(id);
      const admission = snapshot.admissions.find((item) => item.worker_id === id);
      const latestCheckpoint = snapshot.checkpoints.find((item) => item.worker_id === id);
      const internalAdmissionDecision = status === "decision"
        && ["offered", "admitted"].includes(String(admission?.state ?? ""))
        && Number(latestCheckpoint?.id) === Number(admission?.checkpoint_id);
      if (internalAdmissionDecision) continue;
      if (previous === status || !["blocked", "failed", "decision"].includes(status)) {
        this.notifiedStates.set(id, status);
        continue;
      }
      transitions.push({
        id,
        status,
        line: `- ${id} ${status}: ${String(worker.summary ?? worker.error ?? "inspect fleet state")}`,
      });
    }
    if (transitions.length === 0) return;

    const message = [
      "[autoresearch fleet transition; operational state, not Git truth]",
      "Worker attention is required:",
      ...transitions.map((transition) => transition.line),
      "Inspect the shared fleet state and coordinate the required response.",
    ].join("\n");
    try {
      this.pi.sendUserMessage(message, { deliverAs: "followUp" });
      for (const transition of transitions) this.notifiedStates.set(transition.id, transition.status);
    } catch (error) {
      ctx.ui.notify(`Could not queue autoresearch transition: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private setToolsActive(enabled: boolean): void {
    const current = this.pi.getActiveTools().filter((name) => !AUTORESEARCH_PARENT_TOOLS.includes(name as typeof AUTORESEARCH_PARENT_TOOLS[number]));
    this.pi.setActiveTools(enabled ? [...new Set([...current, ...AUTORESEARCH_PARENT_TOOLS])] : current);
  }

  private failSupervisor(error: unknown, ctx = this.currentCtx): void {
    if (this.shuttingDown) return;
    const message = error instanceof Error ? error.message : String(error);
    this.launching = false;
    if (!(error instanceof FleetAlreadyActiveError)) {
      ++this.operation;
      this.active = false;
      this.launching = true;
      const failedStore = this.store;
      if (this.store && this.repository) this.store.setFleetStatus(this.repository.canonicalRoot, "failed");
      this.stopDashboard();
      this.setToolsActive(false);
      void Promise.allSettled([...this.lanes.keys()].map((id) => this.stopWorker(id, "failed"))).then(() => {
        if (this.store === failedStore) this.closeFleetResources();
        this.launching = false;
      });
    }
    ctx?.ui.notify(`Autoresearch supervisor failure: ${message}`, "error");
  }

  async shutdown(ctx: ExtensionContext): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    ++this.operation;
    this.launching = false;
    this.active = false;
    this.stopDashboard();
    this.setToolsActive(false);
    await Promise.allSettled([...this.lanes.keys()].map((id) => this.stopWorker(id, "paused")));
    if (this.store && this.repository) this.store.setFleetStatus(this.repository.canonicalRoot, "paused");
    this.closeFleetResources();
    this.currentCtx = undefined;
    ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, undefined);
  }
}

export function registerAutoresearchSupervisor(pi: ExtensionAPI, options: SupervisorOptions = {}): FleetCommandHandler {
  return new AutoresearchSupervisor(pi, options);
}
