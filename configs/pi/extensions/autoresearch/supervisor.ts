import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  RpcClientOptions,
} from "@earendil-works/pi-coding-agent";

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
import { boundedInspect, compactFleetContext, fleetDashboardLines } from "./presentation.ts";
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

function assertNoActivePortfolioAssignment(canonicalRoot: string, workerId: string): void {
  if (hasActivePortfolioAssignment(canonicalRoot, workerId)) {
    throw new Error(`${workerId} has an active portfolio assignment and cannot be synced`);
  }
}

class FleetOperationCancelledError extends Error {}

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
  private notifiedStates = new Map<string, string>();
  private operation = 0;
  private setupTurnPending = false;

  constructor(pi: ExtensionAPI, options: SupervisorOptions = {}) {
    this.pi = pi;
    this.options = options;
    this.registerTools();
    this.pi.on("session_start", (_event, ctx) => {
      this.currentCtx = ctx;
      this.setToolsActive(false);
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
    ctx.ui.notify(`Launching ${count} isolated autoresearch workers.`, "info");
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
    await Promise.allSettled([...this.clients.keys()].map((id) => this.stopWorker(id, "stopped")));
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

    const lanes = workerLanes(repository.canonicalRoot, count);
    const ensureLane = this.options.ensureLane ?? ((root, commonDir, lane) => ensureWorkerLane(root, commonDir, lane, this.options.run));
    for (const lane of lanes) {
      ensureLane(repository.canonicalRoot, repository.commonDir, lane);
      this.lanes.set(lane.workerId, lane);
    }

    const token = this.options.token ?? randomUUID;
    const sessionId = this.options.sessionId ?? randomUUID;
    const seeds: WorkerSeed[] = lanes.map((lane) => ({
      workerId: lane.workerId,
      sessionId: sessionId(),
      token: token(),
      worktree: lane.path,
      branch: lane.branch,
      sessionsRoot: sessionsDir,
    }));
    const dbPath = join(stateDir, "fleet.sqlite");
    this.store = (this.options.createStore ?? ((path) => new FleetStore(path)))(dbPath);
    try {
      this.generation = this.store.beginFleet({
        canonicalRoot: repository.canonicalRoot,
        parentSession: ctx.sessionManager.getSessionFile(),
        canonicalHead: repository.head,
        maxEvidenceStages: repository.maxEvidenceStages,
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
    this.startDashboard();
    const model = ctx.model;
    const thinking = this.pi.getThinkingLevel();
    await Promise.all(seeds.map((seed) => this.launchWorker(seed, model?.provider, model?.id, thinking, operation)));
    this.assertOperation(operation);
    this.store.activateFleet(repository.canonicalRoot, this.generation);
    this.launching = false;
    this.refreshDashboard();
  }

  private async launchWorker(seed: WorkerLaunchSeed, provider?: string, model?: string, thinking?: string, operation = this.operation): Promise<void> {
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
    const unsubscribe = client.onEvent((event) => this.handleWorkerEvent(seed.workerId, event));
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
    this.store.parentUpdateWorker(this.repository.canonicalRoot, seed.workerId, { status: "idle", sessionFile: state.sessionFile ?? null });
    const program = readFileSync(join(lane.path, "program.md"), "utf8").trim();
    if (!program) throw new Error(`${seed.workerId} program.md is empty`);
    this.assertOperation(operation);
    await client.prompt([
      `You are persistent autoresearch worker ${seed.workerId} in an isolated reusable Git worktree.`,
      "Run the campaign autonomously. Coordinate through autoresearch_worker_state, claim a distinct scope, checkpoint material findings, and reserve evidence capacity before scarce or paid evidence-stage work.",
      "Do not wait for parent transcript context and do not invoke parent supervisor controls.",
      "If shared state reports a reservation from an earlier generation, reconcile and release that exact work with a structured terminal receipt; never relaunch it silently.",
      "Research program:",
      program,
    ].join("\n\n"));
    this.assertOperation(operation);
  }

  private handleWorkerEvent(workerId: string, event: any): void {
    if (!this.store || !this.repository || this.shuttingDown) return;
    const root = this.repository.canonicalRoot;
    try {
      if (event.type === "agent_start") this.store.parentUpdateWorker(root, workerId, { status: "running", currentTool: null });
      if (event.type === "tool_execution_start") {
        this.store.parentUpdateWorker(root, workerId, { status: "running", currentTool: event.toolName });
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
        const currentStatus = this.store.snapshot(root, { workerId, recent: 1 }).workers[0]?.status;
        if (assistant?.role === "assistant" && !["stop", "toolUse"].includes(assistant.stopReason) && currentStatus !== "paused" && currentStatus !== "stopped") {
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
      this.refreshDashboard();
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
      }
      if (action === "restart") await this.restartWorker(workerId);
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
    await this.stopWorker(workerId, "paused");
    const snapshot = store.snapshot(root, { workerId, recent: 1 });
    const row = snapshot.workers[0];
    if (!row) throw new Error(`Missing worker state: ${workerId}`);
    const token = (this.options.token ?? randomUUID)();
    store.parentUpdateWorker(root, workerId, { status: "launching", token, error: null });
    await this.launchWorker({
      workerId,
      sessionId: String(row.session_id),
      token,
      worktree: String(row.worktree),
      branch: String(row.branch),
      sessionsRoot: dirname(String(row.session_dir)),
    }, this.currentCtx?.model?.provider, this.currentCtx?.model?.id, this.pi.getThinkingLevel(), this.operation);
  }

  private async stopWorker(workerId: string, status: WorkerStatus): Promise<void> {
    const client = this.clients.get(workerId);
    this.unsubscribers.get(workerId)?.();
    this.unsubscribers.delete(workerId);
    let stopError: unknown;
    if (client) {
      try { await client.abort(); } catch {}
      try { await client.stop(); } catch (error) { stopError = error; }
      this.clients.delete(workerId);
    }
    if (this.store && this.repository) this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, { status });
    if (stopError) throw stopError;
  }

  private closeFleetResources(): void {
    this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.generation = undefined;
    this.lanes.clear();
    this.notifiedStates.clear();
  }

  private startDashboard(): void {
    this.refreshDashboard();
    const interval = this.options.dashboardIntervalMs ?? 1_000;
    if (interval > 0 && !this.dashboardTimer) {
      this.dashboardTimer = setInterval(() => this.refreshDashboard(), interval);
    }
  }

  private stopDashboard(): void {
    if (this.dashboardTimer) clearInterval(this.dashboardTimer);
    this.dashboardTimer = undefined;
    this.currentCtx?.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, undefined);
  }

  private refreshDashboard(): void {
    if (!this.active || !this.store || !this.repository || !this.currentCtx) return;
    try {
      const snapshot = this.store.snapshot(this.repository.canonicalRoot, { recent: 5 });
      let repo = this.repository;
      try {
        repo = (this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run)))(this.repository.canonicalRoot);
      } catch {}
      this.currentCtx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, fleetDashboardLines(snapshot, {
        now: (this.options.now ?? Date.now)(),
        canonicalHead: repo.head,
        canonicalDirty: repo.dirty,
        canonicalChanged: typeof snapshot.fleet?.canonical_head === "string" && snapshot.fleet.canonical_head !== repo.head,
        protocolChanged: Number(snapshot.fleet?.protocol_version) !== AUTORESEARCH_PROTOCOL_VERSION,
      }), { placement: "belowEditor" });
      this.notifyImportantTransitions(snapshot);
    } catch (error) {
      this.failSupervisor(error, this.currentCtx);
    }
  }

  private notifyImportantTransitions(snapshot: FleetSnapshot): void {
    const ctx = this.currentCtx;
    if (!ctx) return;
    for (const worker of snapshot.workers) {
      const id = String(worker.worker_id);
      const status = String(worker.status);
      const previous = this.notifiedStates.get(id);
      this.notifiedStates.set(id, status);
      if (previous === status || !["blocked", "failed", "decision"].includes(status)) continue;
      ctx.ui.notify(`${id} ${status}: ${String(worker.summary ?? worker.error ?? "inspect fleet state")}`, status === "failed" ? "error" : "warning");
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
      void Promise.allSettled([...this.clients.keys()].map((id) => this.stopWorker(id, "failed"))).then(() => {
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
    await Promise.allSettled([...this.clients.keys()].map((id) => this.stopWorker(id, "paused")));
    if (this.store && this.repository) this.store.setFleetStatus(this.repository.canonicalRoot, "paused");
    this.closeFleetResources();
    this.currentCtx = undefined;
    ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, undefined);
  }
}

export function registerAutoresearchSupervisor(pi: ExtensionAPI, options: SupervisorOptions = {}): FleetCommandHandler {
  return new AutoresearchSupervisor(pi, options);
}
