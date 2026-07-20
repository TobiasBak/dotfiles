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

import { Deferred, Effect } from "effect";

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  RpcClientOptions,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import {
  ensureAutoresearchIgnored,
  ensureWorkerLane,
  inspectRepository,
  integrateTerminalRef,
  isGitAncestor,
  laneGitState,
  preserveTerminalRef,
  resetIntegratedLane,
  syncLaneToCanonical,
  TerminalIntegrationCleanupError,
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
import { AUTORESEARCH_PARENT_TOOLS, AUTORESEARCH_WORKER_TOOL } from "./worker.ts";
import {
  forkControllerTask,
  makeAutoresearchRuntime,
  makeSerializedController,
  scopedSleep,
  type AutoresearchManagedRuntime,
  type AutoresearchServices,
  type SerializedController,
} from "./effect-runtime.ts";

export const AUTORESEARCH_FLEET_WIDGET_ID = "autoresearch-fleet";
export const MAX_AUTORESEARCH_WORKERS = 8;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_RECYCLE_BACKOFF_MS = 1_000;
const MAX_RECYCLE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;
const DEFAULT_INITIAL_INTENT_TIMEOUT_MS = 300_000;
const INCIDENT_COALESCE_MS = 50;
const TERMINAL_WORKER_STATUSES = new Set(["paused", "parked", "blocked", "failed", "complete", "stopped"]);
const AUTORESEARCH_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const AUTORESEARCH_ENTRYPOINT = resolve(AUTORESEARCH_SOURCE_DIR, "..", "autoresearch.ts");
const AUTORESEARCH_TEST_DIR = resolve(AUTORESEARCH_SOURCE_DIR, "../../../..", "scripts");
const AUTORESEARCH_OPERATIONAL_GUIDANCE = `## Autoresearch operational supervision

You are the operational supervisor while this autoresearch fleet is managed. Do not merely acknowledge operationally blocked or failed workers. Inspect the fleet with autoresearch_inspect, distinguish a scientific terminal outcome from a process failure, and use autoresearch_control to recover safe failures. If automatic recovery is exhausted, diagnose the extension and its behavioral tests, make a focused fix when authorized, verify it, then restart the worker. Never reconcile an unowned or unverified process until exact external process termination has been verified.

Operational interfaces:
- autoresearch_inspect: bounded fleet, worker, checkpoint, and event state.
- autoresearch_control: steer, pause, resume, restart, stop, sync, and explicit post-verification reconciliation.
- Extension entrypoint: ${AUTORESEARCH_ENTRYPOINT}
- Supervisor and worker source: ${join(AUTORESEARCH_SOURCE_DIR, "supervisor.ts")} and ${join(AUTORESEARCH_SOURCE_DIR, "worker.ts")}
- State and presentation: ${join(AUTORESEARCH_SOURCE_DIR, "state.ts")} and ${join(AUTORESEARCH_SOURCE_DIR, "presentation.ts")}
- Behavioral tests: ${join(AUTORESEARCH_TEST_DIR, "autoresearch-fleet.test.mjs")} and ${join(AUTORESEARCH_TEST_DIR, "autoresearch-extension.test.mjs")}
- Installed Pi documentation and extension examples: /home/tobias/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs and /home/tobias/.local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions

Process state is safety-relevant. A missing RPC handle, stop failure, or unreconciled process requires exact OS process verification before reconciliation; never launch a replacement over a possibly live process.

Scientific lifecycle: accepted is reserved for a committed result that passes every applicable program gate and delivers either a validated Pareto/model frontier advance or a validated search-capability advance that makes a previously impossible legal campaign executable, such as a tested representation primitive, direct runtime kernel, evaluator, harness, prerequisite, or safely activated successor epoch. Merely drafting docs, changing Git, closing an epoch, or auditing is inconclusive unless it delivers such a validated capability. Rejected means tested failure while project-level moves remain. Family and executable evidence-epoch bounds are nested inside an enduring project mission; closing either returns the worker to legal architecture pivots, prerequisite implementation, evaluator or harness construction, successor epoch design or activation, or another project-level move. Exhausted means no useful legal project-level move remains across model, representation, architecture, runtime, evaluation, permitted data, tooling or prerequisites, and safe successor epochs, or continuation is permanently impossible under external constraints with no legal workaround. Only genuine project-level exhaustion parks the fleet. External-blocked is a specific unavailable prerequisite, never global exhaustion.`;
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
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Canonical program.md must be a regular, nonsymlink file");

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
  onEvent(listener: (event: unknown) => void): () => void;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<{ isStreaming: boolean; sessionFile?: string }>;
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
  preserveTerminal?: typeof preserveTerminalRef;
  integrateTerminal?: typeof integrateTerminalRef;
  resetIntegratedLane?: typeof resetIntegratedLane;
  isAncestor?: typeof isGitAncestor;
  cliPath?: string;
  extensionPath?: string;
  dashboardIntervalMs?: number;
  now?: () => number;
  sessionId?: () => string;
  sessionVersion?: number;
  rpcTimeoutMs?: number;
  recycleBackoffMs?: number;
  maxRecoveryAttempts?: number;
  initialIntentTimeoutMs?: number;
  planningProvider?: string;
  planningModel?: string;
  planningThinking?: ThinkingLevel;
  run?: CommandRunner;
}

interface WorkerLaunchSeed {
  workerId: string;
  sessionId: string;
  worktree: string;
  branch: string;
  sessionsRoot: string;
}

export interface FleetCommandHandler {
  start(count: number, ctx: ExtensionContext): Promise<boolean>;
  status(ctx: ExtensionContext): Promise<boolean>;
  stop(ctx: ExtensionContext): Promise<boolean>;
  shutdown(ctx: ExtensionContext): Promise<void>;
  isActive(): boolean;
}

export function parseAutoresearchFleetCount(args: string): number | undefined {
  const trimmed = args.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const count = Number(trimmed);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_AUTORESEARCH_WORKERS) return undefined;
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
  try { before = lstatSync(path); } catch { return undefined; }
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
  if (!Number.isInteger(sessionVersion) || sessionVersion < 1) throw new Error("Autoresearch requires Pi's current persistent session version");
  const resolvedCwd = realpathSync(cwd);
  const resolvedSessionDir = realpathSync(sessionDir);
  if (resolvedSessionDir !== resolve(sessionDir)) throw new Error("Autoresearch worker session directory must not contain symlink indirection");
  for (const file of readdirSync(resolvedSessionDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const header = sessionHeader(join(resolvedSessionDir, file));
    if (header?.id !== sessionId) continue;
    if (header.cwd !== resolvedCwd) throw new Error(`Autoresearch session ${sessionId} belongs to a different worker checkout`);
    return;
  }

  const path = join(resolvedSessionDir, `${sessionId}.jsonl`);
  const temporaryPath = join(resolvedSessionDir, `.${sessionId}.${randomUUID()}.tmp`);
  const header = { type: "session", version: sessionVersion, id: sessionId, timestamp: new Date().toISOString(), cwd: resolvedCwd };
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
  const value = typed.content.filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text).join("\n").replace(/\s+/g, " ").trim();
  return value ? value.slice(0, 500) : undefined;
}

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FleetOperationCancelledError extends Error {}

type InitialIntentOutcome = "published" | "failed" | "timeout";

interface InitialIntentExpected {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
}

interface InitialIntentWaiter {
  readonly resolve: (outcome: InitialIntentOutcome) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface InitialIntentBarrier {
  readonly operation: number;
  readonly generation: number;
  readonly expected: Map<string, InitialIntentExpected>;
  readonly latched: Map<string, InitialIntentOutcome>;
  readonly waiters: Map<string, InitialIntentWaiter>;
}

type SupervisorOwnership = "none" | "owner" | "observer";

interface DashboardRenderState {
  snapshot: FleetSnapshot;
  options: FleetDashboardOptions;
}

type SupervisorEvent =
  | { readonly _tag: "SessionStart"; readonly ctx: ExtensionContext; readonly reply: Deferred.Deferred<void, Error> }
  | { readonly _tag: "BeforeAgentStart"; readonly systemPrompt: string; readonly reply: Deferred.Deferred<BeforeAgentStartEventResult | void, Error> }
  | { readonly _tag: "AgentSettled" }
  | { readonly _tag: "SessionShutdown"; readonly ctx: ExtensionContext; readonly reply: Deferred.Deferred<void, Error> }
  | { readonly _tag: "Start"; readonly count: number; readonly ctx: ExtensionContext; readonly reply: Deferred.Deferred<boolean, Error> }
  | { readonly _tag: "Status"; readonly ctx: ExtensionContext; readonly reply: Deferred.Deferred<boolean, Error> }
  | { readonly _tag: "Stop"; readonly ctx: ExtensionContext; readonly reply: Deferred.Deferred<boolean, Error> }
  | { readonly _tag: "WorkerEvent"; readonly workerId: string; readonly sessionId: string; readonly client: RpcWorkerClient; readonly event: unknown }
  | { readonly _tag: "DashboardRefresh" }
  | { readonly _tag: "RunTask"; readonly task: () => Promise<unknown>; readonly onError: (error: unknown) => void }
  | { readonly _tag: "RunEffect"; readonly effect: Effect.Effect<void, never, never> }
  | { readonly _tag: "FailureStopCompleted"; readonly store: FleetStore | undefined; readonly unresolved: number }
  | { readonly _tag: "Control"; readonly action: string; readonly target: string; readonly message: string | undefined; readonly reply: Deferred.Deferred<Record<string, unknown>, Error> };

function findFleetDatabase(cwd: string): string | undefined {
  let directory = resolve(cwd);
  while (true) {
    const candidate = join(directory, ".autoresearch", "fleet.sqlite");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function renderDashboardLine(line: FleetWidgetLine, theme: ExtensionContext["ui"]["theme"], width: number): string {
  const statusColor = line.status === "complete" ? "success"
    : line.status === "failed" ? "error"
      : line.status === "blocked" ? "warning"
        : line.status === "running" ? "accent" : "muted";
  return truncateToWidth(line.segments.map((segment) => {
    switch (segment.role) {
      case "frame": return theme.fg("borderMuted", segment.text);
      case "group": return theme.fg("accent", theme.bold(segment.text));
      case "status": return theme.fg(statusColor, theme.bold(segment.text));
      case "model":
      case "metadata": return theme.fg("dim", segment.text);
      case "summary": return theme.fg("text", segment.text);
    }
  }).join(""), width);
}

export class AutoresearchSupervisor implements FleetCommandHandler {
  private readonly pi: ExtensionAPI;
  private readonly runtime: AutoresearchManagedRuntime;
  private readonly options: SupervisorOptions;
  private readonly controller: SerializedController<SupervisorEvent>;
  private readonly clients = new Map<string, RpcWorkerClient>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly lanes = new Map<string, WorkerLane>();
  private store: FleetStore | undefined;
  private repository: RepositoryInfo | undefined;
  private generation: number | undefined;
  private launching = false;
  private active = false;
  private shuttingDown = false;
  private currentCtx: ExtensionContext | undefined;
  private dashboardRunning = false;
  private dashboardRenderState: DashboardRenderState | undefined;
  private dashboardRequestRender: () => void = () => {};
  private dashboardWidgetRegistered = false;
  private ownership: SupervisorOwnership = "none";
  private readonly workerOperations = new Map<string, number>();
  private readonly recyclePending = new Set<string>();
  private readonly integrationPending = new Set<string>();
  private integrationTail: Promise<void> = Promise.resolve();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly livenessChecks = new Set<string>();
  private readonly incidentKeys = new Set<string>();
  private readonly pendingIncidents = new Map<string, string>();
  private incidentTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stopOperations = new Map<string, Promise<void>>();
  private initialIntentBarrier: InitialIntentBarrier | undefined;
  private operation = 0;
  private setupTurnPending = false;

  constructor(pi: ExtensionAPI, runtime: AutoresearchManagedRuntime, options: SupervisorOptions = {}) {
    this.pi = pi;
    this.runtime = runtime;
    this.options = options;
    this.controller = makeSerializedController(runtime, (event) => this.handleControllerEvent(event), (message) => {
      this.currentCtx?.ui.notify(`Autoresearch supervisor defect: ${message}`, "error");
    });
    this.registerTools();
    this.pi.on("session_start", (_event, ctx) => this.controller.request<void>((reply) => ({ _tag: "SessionStart", ctx, reply })));
    this.pi.on("before_agent_start", (event) => this.controller.request((reply) => ({ _tag: "BeforeAgentStart", systemPrompt: event.systemPrompt, reply })));
    this.pi.on("agent_settled", () => this.controller.dispatch({ _tag: "AgentSettled" }));
    this.pi.on("session_shutdown", async (_event, ctx) => {
      await this.controller.request<void>((reply) => ({ _tag: "SessionShutdown", ctx, reply }));
      await this.controller.interrupt();
    });
  }

  private handleControllerEvent(event: SupervisorEvent): Effect.Effect<void, never, AutoresearchServices> {
    const complete = <A>(reply: Deferred.Deferred<A, Error>, value: A) => Deferred.succeed(reply, value).pipe(Effect.asVoid);
    return Effect.gen(this, function* () {
      switch (event._tag) {
        case "SessionStart": {
          this.currentCtx = event.ctx;
          this.setToolsActive(false);
          const restored = this.restorePausedFleet(event.ctx);
          yield* complete(event.reply, undefined);
          if (restored.length > 0) {
            yield* forkControllerTask(Effect.tryPromise({
              try: async () => Promise.all(restored.map((workerId) => this.resumeRestoredWorker(workerId))),
              catch: (error) => error,
            }).pipe(Effect.catchAll((error) => Effect.sync(() => this.failSupervisor(error, event.ctx))), Effect.asVoid));
          }
          return;
        }
        case "BeforeAgentStart":
          yield* complete(event.reply, !this.store || !this.repository ? undefined : {
            message: {
              customType: "autoresearch-fleet-snapshot",
              content: compactFleetContext(this.store.snapshot(this.repository.canonicalRoot, { recent: 20 })),
              display: false,
            },
            systemPrompt: `${event.systemPrompt}\n\n${AUTORESEARCH_OPERATIONAL_GUIDANCE}`,
          });
          return;
        case "AgentSettled":
          this.setupTurnPending = false;
          return;
        case "SessionShutdown":
          this.setupTurnPending = false;
          yield* Effect.tryPromise({ try: () => this.shutdownImpl(event.ctx), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
          yield* complete(event.reply, undefined);
          return;
        case "Start": {
          const operation = this.startImpl(event.count, event.ctx);
          yield* complete(event.reply, operation !== undefined);
          if (operation !== undefined) {
            yield* forkControllerTask(Effect.yieldNow().pipe(
              Effect.zipRight(Effect.tryPromise({ try: () => this.launch(event.count, event.ctx, operation), catch: (error) => error })),
              Effect.catchAll((error) => Effect.sync(() => {
                if (!(error instanceof FleetOperationCancelledError)) this.failSupervisor(error, event.ctx);
              })),
            ));
          }
          return;
        }
        case "Status":
          yield* complete(event.reply, this.statusImpl(event.ctx));
          return;
        case "Stop":
          yield* complete(event.reply, yield* Effect.tryPromise({ try: () => this.stopImpl(event.ctx), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) }));
          return;
        case "WorkerEvent":
          this.handleWorkerEvent(event.workerId, event.sessionId, event.client, event.event);
          return;
        case "DashboardRefresh":
          this.refreshDashboard();
          return;
        case "RunTask":
          yield* forkControllerTask(Effect.tryPromise({ try: event.task, catch: (error) => error }).pipe(
            Effect.catchAll((error) => Effect.sync(() => event.onError(error))), Effect.asVoid,
          ));
          return;
        case "RunEffect":
          yield* forkControllerTask(event.effect);
          return;
        case "FailureStopCompleted":
          if (this.store !== event.store) return;
          if (event.unresolved === 0) {
            this.closeFleetResources();
            this.launching = false;
          } else {
            if (this.store && this.repository && this.generation) {
              this.store.setFleetStatus(this.repository.canonicalRoot, "off", (this.options.now ?? Date.now)(), this.generation);
            }
            this.active = false;
            this.launching = false;
            this.setToolsActive(true);
          }
          return;
        case "Control": {
          const result = yield* Effect.either(Effect.tryPromise({
            try: () => this.controlImpl(event.action, event.target, event.message),
            catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
          }));
          if (result._tag === "Left") yield* Deferred.fail(event.reply, result.left).pipe(Effect.asVoid);
          else yield* complete(event.reply, result.right);
          return;
        }
      }
    }).pipe(Effect.catchAllCause((cause) => Effect.sync(() => this.failSupervisor(new Error(String(cause)), this.currentCtx))));
  }

  private restorePausedFleet(ctx: ExtensionContext): string[] {
    let store: FleetStore | undefined;
    try {
      if (!findFleetDatabase(ctx.cwd)) return [];
      const inspect = this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run));
      const repository = inspect(ctx.cwd);
      const dbPath = join(repository.canonicalRoot, ".autoresearch", "fleet.sqlite");
      if (!existsSync(dbPath)) return [];
      store = (this.options.createStore ?? ((path) => new FleetStore(path)))(dbPath);
      const snapshot = store.snapshot(repository.canonicalRoot, { recent: 20 });
      const fleet = snapshot.fleet;
      const fleetStatus = String(fleet?.status ?? "");
      if (!fleet || !["launching", "active", "paused", "exhausted", "off"].includes(fleetStatus) || snapshot.workers.length === 0) {
        store.close();
        return [];
      }
      const generation = Number(fleet.generation);
      if (!Number.isInteger(generation) || generation < 1) throw new Error("recoverable fleet has an invalid generation");
      if (Number(fleet.protocol_version) !== AUTORESEARCH_PROTOCOL_VERSION) {
        store.close();
        return [];
      }
      const unresolved = snapshot.workers.some((worker) => worker.process_state !== "stopped");
      this.store = store;
      store = undefined;
      this.repository = repository;
      this.generation = generation;
      if (fleet.canonical_branch === null || fleet.canonical_branch === undefined) {
        if (repository.dirty || repository.head !== fleet.canonical_head) {
          throw new Error("Cannot capture canonical branch for restored fleet because canonical checkout changed");
        }
        this.store.captureCanonicalBranch(repository.canonicalRoot, generation, repository.branch, repository.head, (this.options.now ?? Date.now)());
      }
      for (const [index, worker] of snapshot.workers.entries()) {
        const workerId = String(worker.worker_id);
        this.lanes.set(workerId, { workerId, index: index + 1, path: String(worker.worktree), branch: String(worker.branch) });
      }
      if (fleetStatus === "exhausted") {
        this.ownership = "owner";
        this.active = false;
        this.setToolsActive(true);
        this.updateDashboardWidget({ snapshot, options: { now: (this.options.now ?? Date.now)(), canonicalHead: repository.head } });
        ctx.ui.notify("Restored exhausted autoresearch fleet for inspection. No workers were launched; explicitly resume parked lanes to continue.", "info");
        return [];
      }
      if (unresolved || fleetStatus === "off") {
        this.ownership = "observer";
        this.active = false;
        this.setToolsActive(true);
        ctx.ui.notify(
          ["launching", "active"].includes(fleetStatus)
            ? "Another supervisor may still be active, or the previous supervisor exited without verifying worker termination. State was left unchanged; reconcile only after external verification."
            : "Autoresearch is off because previous worker process termination is unresolved. Reconcile only after external verification.",
          "warning",
        );
        if (fleetStatus === "off") {
          for (const worker of snapshot.workers.filter((row) => row.process_state === "unreconciled")) {
            this.queueOperationalIncident(String(worker.worker_id), "restored unresolved process state requires diagnosis");
          }
        }
        return [];
      }
      this.ownership = "owner";
      this.active = true;
      this.operation += 1;
      this.store.setFleetStatus(repository.canonicalRoot, "active", (this.options.now ?? Date.now)(), generation);
      this.setToolsActive(true);
      this.startDashboard();
      ctx.ui.notify(`Restoring ${snapshot.workers.length} disposable autoresearch workers.`, "info");
      return snapshot.workers.map((worker) => String(worker.worker_id));
    } catch (error) {
      store?.close();
      this.closeFleetResources();
      this.active = false;
      this.setToolsActive(false);
      ctx.ui.notify(`Could not restore autoresearch fleet: ${error instanceof Error ? error.message : String(error)}`, "error");
      return [];
    }
  }

  private requestProgramSetup(ctx: ExtensionContext): void {
    if (this.setupTurnPending) {
      ctx.ui.notify("Autoresearch setup is already queued or running.", "info");
      return;
    }
    this.setupTurnPending = true;
    ctx.ui.notify("Autoresearch setup is required before workers can start: canonical program.md is missing.", "warning");
    try {
      if (ctx.isIdle()) this.pi.sendUserMessage(PROGRAM_DESIGN_SETUP_PROMPT);
      else this.pi.sendUserMessage(PROGRAM_DESIGN_SETUP_PROMPT, { deliverAs: "followUp" });
    } catch (error) {
      this.setupTurnPending = false;
      ctx.ui.notify(`Could not start autoresearch setup: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  start(count: number, ctx: ExtensionContext): Promise<boolean> {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_AUTORESEARCH_WORKERS) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Autoresearch fleet size must be between 1 and ${MAX_AUTORESEARCH_WORKERS}.`, "warning");
      }
      return Promise.resolve(false);
    }
    return this.controller.request<boolean>((reply) => ({ _tag: "Start", count, ctx, reply }));
  }
  status(ctx: ExtensionContext): Promise<boolean> {
    return this.controller.request<boolean>((reply) => ({ _tag: "Status", ctx, reply }));
  }
  stop(ctx: ExtensionContext): Promise<boolean> {
    return this.controller.request<boolean>((reply) => ({ _tag: "Stop", ctx, reply }));
  }
  isActive(): boolean { return this.launching || this.active || this.ownership === "observer"; }

  private startImpl(count: number, ctx: ExtensionContext): number | undefined {
    if (this.shuttingDown) {
      ctx.ui.notify("Autoresearch supervisor is shutting down and cannot launch a fleet.", "error");
      return undefined;
    }
    if (this.launching || this.active) {
      ctx.ui.notify("Autoresearch supervisor failure: a fleet is already launching or active.", "error");
      return undefined;
    }
    if (this.ownership === "observer" || this.store || this.repository) {
      ctx.ui.notify("Autoresearch already has managed process state. Inspect and reconcile it instead of launching a conflicting fleet.", "error");
      return undefined;
    }
    try {
      const inspect = this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run));
      const repository = inspect(ctx.cwd);
      const program = readCanonicalProgram(repository.canonicalRoot);
      if (program.kind === "missing") {
        this.requestProgramSetup(ctx);
        return undefined;
      }
      if (repository.dirty) throw new Error("Canonical checkout is dirty. Commit reviewed program and controller changes before launching workers.");
    } catch (error) {
      ctx.ui.notify(`Autoresearch supervisor failure: ${error instanceof Error ? error.message : String(error)}`, "error");
      return undefined;
    }
    const operation = ++this.operation;
    this.launching = true;
    this.currentCtx = ctx;
    ctx.ui.notify(`Starting autoresearch with ${count} disposable autonomous worker${count === 1 ? "" : "s"}.`, "info");
    return operation;
  }

  private statusImpl(ctx: ExtensionContext): boolean {
    if (!this.launching && !this.active && (!this.store || !this.repository)) return false;
    let detail = this.ownership === "observer" ? "observed" : this.launching ? "launching" : "active";
    if (this.store && this.repository) {
      const snapshot = this.store.snapshot(this.repository.canonicalRoot, { recent: 1 });
      detail = `${String(snapshot.fleet?.status ?? detail)}, generation ${String(snapshot.fleet?.generation ?? "?")}, ${snapshot.workers.length} workers`;
    }
    ctx.ui.notify(`Autoresearch fleet is ${detail}.`, "info");
    return true;
  }

  private async stopImpl(ctx: ExtensionContext): Promise<boolean> {
    const exhausted = this.store && this.repository
      ? String(this.store.snapshot(this.repository.canonicalRoot, { recent: 1 }).fleet?.status) === "exhausted"
      : false;
    if (!this.launching && !this.active && !exhausted) return false;
    ++this.operation;
    this.cancelInitialIntentBarrier("Autoresearch fleet stop was requested");
    for (const workerId of this.lanes.keys()) this.bumpWorkerOperation(workerId);
    this.launching = false;
    this.active = false;
    this.stopDashboard();
    this.setToolsActive(false);
    const store = this.store;
    const repository = this.repository;
    const generation = this.generation;
    const results = await Promise.allSettled([...this.lanes.keys()].map((id) => this.stopWorker(id, "stopped")));
    const unresolved = results.filter((result) => result.status === "rejected");
    if (store && repository && generation && this.store === store) {
      store.setFleetStatus(repository.canonicalRoot, unresolved.length === 0 ? "stopped" : "off", (this.options.now ?? Date.now)(), generation);
    }
    if (unresolved.length === 0) {
      this.closeFleetResources();
      ctx.ui.notify("Stopped autoresearch fleet.", "info");
    } else {
      this.setToolsActive(true);
      ctx.ui.notify(`Autoresearch is off. Process termination is unverified for ${unresolved.length} worker${unresolved.length === 1 ? "" : "s"}.`, "warning");
    }
    return true;
  }

  private forkTask(task: () => Promise<unknown>, onError = (error: unknown) => this.failSupervisor(error, this.currentCtx)): void {
    this.controller.tell({ _tag: "RunTask", task, onError });
  }

  private async rpc<T>(workerId: string, operation: string, invoke: () => Promise<T>): Promise<T> {
    const timeoutMs = Math.max(1, this.options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        invoke(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${workerId} RPC ${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private assertOperation(operation: number): void {
    if (this.shuttingDown || operation !== this.operation) throw new FleetOperationCancelledError("Autoresearch fleet operation was cancelled");
  }

  private assertFleetOperation(operation: number, store: FleetStore, repository: RepositoryInfo, generation: number): void {
    this.assertOperation(operation);
    if (this.store !== store || this.repository !== repository || this.generation !== generation) {
      throw new FleetOperationCancelledError("Autoresearch fleet generation was replaced");
    }
  }

  private bumpWorkerOperation(workerId: string): number {
    const next = (this.workerOperations.get(workerId) ?? 0) + 1;
    this.workerOperations.set(workerId, next);
    return next;
  }

  private assertWorkerOperation(workerId: string, fleetOperation: number, workerOperation: number): void {
    this.assertOperation(fleetOperation);
    if ((this.workerOperations.get(workerId) ?? 0) !== workerOperation) throw new FleetOperationCancelledError(`${workerId} operation was superseded`);
  }

  private initialIntentKey(operation: number, generation: number, workerId: string, sessionId: string): string {
    return `${operation}:${generation}:${workerId}:${sessionId}`;
  }

  private createInitialIntentBarrier(seeds: WorkerLaunchSeed[], operation: number, generation: number): void {
    this.cancelInitialIntentBarrier("A new initial autoresearch fleet operation superseded the previous barrier");
    const expected = new Map<string, InitialIntentExpected>();
    for (const seed of seeds) expected.set(seed.workerId, { workerId: seed.workerId, sessionId: seed.sessionId, generation });
    this.initialIntentBarrier = { operation, generation, expected, latched: new Map(), waiters: new Map() };
  }

  private initialIntentEntry(
    operation: number,
    generation: number,
    workerId: string,
    sessionId: string,
  ): { barrier: InitialIntentBarrier; key: string } | undefined {
    const barrier = this.initialIntentBarrier;
    const expected = barrier?.expected.get(workerId);
    if (!barrier || barrier.operation !== operation || barrier.generation !== generation
      || !expected || expected.workerId !== workerId || expected.sessionId !== sessionId || expected.generation !== generation) return undefined;
    const key = this.initialIntentKey(operation, generation, workerId, sessionId);
    return { barrier, key };
  }

  private releaseInitialIntent(
    operation: number,
    generation: number,
    workerId: string,
    sessionId: string,
    outcome: InitialIntentOutcome,
  ): boolean {
    const entry = this.initialIntentEntry(operation, generation, workerId, sessionId);
    if (!entry || entry.barrier.latched.has(entry.key)) return false;
    entry.barrier.latched.set(entry.key, outcome);
    const waiter = entry.barrier.waiters.get(entry.key);
    if (waiter) {
      clearTimeout(waiter.timer);
      entry.barrier.waiters.delete(entry.key);
      waiter.resolve(outcome);
    }
    return true;
  }

  private initialIntentTimeoutMs(): number {
    const configured = this.options.initialIntentTimeoutMs;
    return Number.isFinite(configured) ? Math.max(1, Math.floor(configured!)) : DEFAULT_INITIAL_INTENT_TIMEOUT_MS;
  }

  private timeoutInitialIntent(
    barrier: InitialIntentBarrier,
    key: string,
    seed: WorkerLaunchSeed,
    operation: number,
    store: FleetStore,
    repository: RepositoryInfo,
    generation: number,
  ): void {
    if (this.initialIntentBarrier !== barrier || operation !== this.operation || this.shuttingDown) return;
    const waiter = barrier.waiters.get(key);
    if (!waiter) return;
    barrier.waiters.delete(key);
    barrier.latched.set(key, "timeout");
    try {
      store.parentAddWorkerEvent(
        repository.canonicalRoot,
        seed.workerId,
        generation,
        "initial_intent_barrier_timeout",
        `Initial intent publication timed out for ${seed.workerId} session ${seed.sessionId}; continuing without stopping the worker.`,
        (this.options.now ?? Date.now)(),
      );
      if (this.currentCtx?.hasUI) {
        this.currentCtx.ui.notify(`Autoresearch ${seed.workerId} did not publish an initial intent before the barrier timeout; continuing with the next worker.`, "warning");
      }
    } catch (error) {
      if (!this.shuttingDown && this.initialIntentBarrier === barrier) {
        this.currentCtx?.ui.notify(`Could not record ${seed.workerId} initial intent barrier timeout: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    waiter.resolve("timeout");
  }

  private async waitForInitialIntent(
    seed: WorkerLaunchSeed,
    operation: number,
    store: FleetStore,
    repository: RepositoryInfo,
    generation: number,
  ): Promise<InitialIntentOutcome> {
    this.assertFleetOperation(operation, store, repository, generation);
    const entry = this.initialIntentEntry(operation, generation, seed.workerId, seed.sessionId);
    if (!entry) throw new FleetOperationCancelledError("Initial intent barrier was cancelled or superseded");
    if (store.currentIntent(repository.canonicalRoot, seed.workerId)) {
      this.releaseInitialIntent(operation, generation, seed.workerId, seed.sessionId, "published");
    }
    const latched = entry.barrier.latched.get(entry.key);
    if (latched) return latched;
    return new Promise<InitialIntentOutcome>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => this.timeoutInitialIntent(entry.barrier, entry.key, seed, operation, store, repository, generation), this.initialIntentTimeoutMs());
      entry.barrier.waiters.set(entry.key, { resolve: resolvePromise, reject: rejectPromise, timer });
      const alreadyLatched = entry.barrier.latched.get(entry.key);
      if (alreadyLatched) {
        clearTimeout(timer);
        entry.barrier.waiters.delete(entry.key);
        resolvePromise(alreadyLatched);
      }
    });
  }

  private cancelInitialIntentBarrier(reason: string): void {
    const barrier = this.initialIntentBarrier;
    if (!barrier) return;
    this.initialIntentBarrier = undefined;
    for (const waiter of barrier.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new FleetOperationCancelledError(reason));
    }
    barrier.waiters.clear();
    barrier.latched.clear();
    barrier.expected.clear();
  }

  private async launch(count: number, ctx: ExtensionContext, operation: number): Promise<void> {
    this.assertOperation(operation);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_AUTORESEARCH_WORKERS) {
      throw new Error(`Autoresearch fleet size must be between 1 and ${MAX_AUTORESEARCH_WORKERS}`);
    }
    const inspect = this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run));
    const repository = inspect(ctx.cwd);
    const program = readCanonicalProgram(repository.canonicalRoot);
    if (program.kind !== "valid") throw new Error("Canonical program.md disappeared before fleet provisioning");
    if (repository.dirty) throw new Error("Canonical checkout is dirty. Commit reviewed changes before launching workers.");
    this.repository = repository;
    const stateDir = join(repository.canonicalRoot, ".autoresearch");
    const sessionsDir = join(stateDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(join(stateDir, "artifacts", "runs"), { recursive: true });
    (this.options.ensureIgnored ?? ((root) => ensureAutoresearchIgnored(root, this.options.run)))(repository.canonicalRoot);

    const lanes = workerLanes(repository.canonicalRoot, count);
    const ensureLane = this.options.ensureLane ?? ((root, commonDir, lane) => ensureWorkerLane(root, commonDir, lane, this.options.run));
    for (const lane of lanes) {
      ensureLane(repository.canonicalRoot, repository.commonDir, lane);
      this.lanes.set(lane.workerId, lane);
    }

    const sessionId = this.options.sessionId ?? randomUUID;
    const dbPath = join(stateDir, "fleet.sqlite");
    this.store = (this.options.createStore ?? ((path) => new FleetStore(path)))(dbPath);
    const seeds: WorkerLaunchSeed[] = lanes.map((lane) => ({
      workerId: lane.workerId,
      sessionId: sessionId(),
      worktree: lane.path,
      branch: lane.branch,
      sessionsRoot: sessionsDir,
    }));
    try {
      const parentSession = ctx.sessionManager.getSessionFile();
      this.generation = this.store.beginFleet({
        canonicalRoot: repository.canonicalRoot,
        ...(parentSession !== undefined ? { parentSession } : {}),
        canonicalBranch: repository.branch,
        canonicalHead: repository.head,
        workers: seeds,
        now: (this.options.now ?? Date.now)(),
      });
    } catch (error) {
      if (error instanceof FleetAlreadyActiveError) {
        this.store.close();
        this.store = undefined;
        this.repository = undefined;
        this.ownership = "none";
        this.lanes.clear();
      }
      throw error;
    }

    const syncLane = this.options.syncLane ?? syncLaneToCanonical;
    for (const lane of lanes) {
      if (this.store.currentIntent(repository.canonicalRoot, lane.workerId)) continue;
      const synced = syncLane({
        canonicalRoot: repository.canonicalRoot,
        lane,
        generation: this.generation,
        canonicalHead: repository.head,
        now: (this.options.now ?? Date.now)(),
        ...(this.options.run ? { run: this.options.run } : {}),
      });
      if (synced.canonicalHead !== repository.head) throw new Error(`${lane.workerId} was not synchronized to the reviewed canonical commit`);
    }

    this.ownership = "owner";
    this.active = true;
    this.setToolsActive(true);
    const model = ctx.model;
    const provider = this.options.planningProvider ?? model?.provider ?? "openai-codex";
    const modelId = this.options.planningModel ?? model?.id ?? "gpt-5.6-sol";
    const thinking = this.options.planningThinking ?? this.pi.getThinkingLevel();
    for (const seed of seeds) {
      this.store.parentUpdateWorker(repository.canonicalRoot, seed.workerId, {
        status: "launching", processState: "stopped", task: "Selecting research direction",
        model: `${provider}/${modelId}`, thinking,
        ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      }, (this.options.now ?? Date.now)(), this.generation);
    }
    if (seeds.length === 0) throw new Error("Fleet has no worker");
    const store = this.store;
    const generation = this.generation;
    store.activateFleet(repository.canonicalRoot, generation);
    this.launching = false;
    this.startDashboard();
    this.refreshDashboard();
    this.createInitialIntentBarrier(seeds, operation, generation);
    try {
      for (const [index, seed] of seeds.entries()) {
        try {
          this.assertOperation(operation);
          await this.launchWorker(seed, provider, modelId, thinking, operation);
          if (index < seeds.length - 1) await this.waitForInitialIntent(seed, operation, store, repository, generation);
        } catch (error) {
          this.releaseInitialIntent(operation, generation, seed.workerId, seed.sessionId, "failed");
          if (error instanceof FleetOperationCancelledError) return;
          const current = store.snapshot(repository.canonicalRoot, { workerId: seed.workerId, recent: 1 }).workers[0];
          if (current?.process_state === "stopped") this.scheduleRecycle(seed.workerId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.cancelInitialIntentBarrier("Initial fleet provisioning completed or was cancelled");
    }
  }

  private async launchWorker(seed: WorkerLaunchSeed, provider?: string, model?: string, thinking?: ThinkingLevel, operation = this.operation): Promise<void> {
    this.assertOperation(operation);
    if (!this.repository || !this.store || !this.generation) throw new Error("Fleet launch state is incomplete");
    const repository = this.repository;
    const store = this.store;
    const generation = this.generation;
    const workerOperation = this.workerOperations.get(seed.workerId) ?? 0;
    const assertWorkerCurrent = (): void => {
      this.assertFleetOperation(operation, store, repository, generation);
      if ((this.workerOperations.get(seed.workerId) ?? 0) !== workerOperation) throw new FleetOperationCancelledError(`${seed.workerId} launch was superseded`);
    };
    const lane = this.lanes.get(seed.workerId);
    if (!lane) throw new Error(`Missing lane ${seed.workerId}`);
    let codingAgent: typeof import("@earendil-works/pi-coding-agent") | undefined;
    if (!this.options.cliPath || !this.options.createRpcClient) {
      codingAgent = await import("@earendil-works/pi-coding-agent");
      assertWorkerCurrent();
    }
    const cliPath = resolvePiCliPath(this.options.cliPath, codingAgent?.getPackageDir());
    const extensionPath = realpathSync(this.options.extensionPath ?? fileURLToPath(new URL("../autoresearch.ts", import.meta.url)));
    const stateDir = join(repository.canonicalRoot, ".autoresearch");
    const sessionDir = join(seed.sessionsRoot, `generation-${generation}`);
    mkdirSync(join(stateDir, "artifacts", "runs"), { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    ensureWorkerSession(lane.path, sessionDir, seed.sessionId, codingAgent?.CURRENT_SESSION_VERSION ?? this.options.sessionVersion ?? Number.NaN);
    assertWorkerCurrent();
    let createClient = this.options.createRpcClient;
    if (!createClient) {
      const RpcClient = codingAgent!.RpcClient;
      createClient = (rpcOptions: RpcClientOptions) => new RpcClient(rpcOptions);
    }
    const program = readFileSync(join(lane.path, "program.md"), "utf8").trim();
    if (!program) throw new Error(`${seed.workerId} program.md is empty`);
    assertWorkerCurrent();
    const env = {
      AUTORESEARCH_ROLE: "worker",
      AUTORESEARCH_WORKER_ID: seed.workerId,
      AUTORESEARCH_SESSION_ID: seed.sessionId,
      AUTORESEARCH_STATE_DIR: stateDir,
      AUTORESEARCH_FLEET_DB: join(stateDir, "fleet.sqlite"),
      AUTORESEARCH_ARTIFACTS_DIR: join(stateDir, "artifacts", "runs"),
      AUTORESEARCH_CANONICAL_ROOT: repository.canonicalRoot,
      AUTORESEARCH_GENERATION: String(generation),
    };
    const args = [
      "--session-id", seed.sessionId,
      "--session-dir", sessionDir,
      "--no-extensions",
      "--extension", extensionPath,
      "--name", `autoresearch ${seed.workerId} ${seed.sessionId.slice(0, 8)}`,
    ];
    if (thinking) args.push("--thinking", thinking);
    const client = createClient({ cliPath, cwd: lane.path, env, args, ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
    this.clients.set(seed.workerId, client);
    const unsubscribe = client.onEvent((event) => {
      this.controller.tell({ _tag: "WorkerEvent", workerId: seed.workerId, sessionId: seed.sessionId, client, event });
    });
    this.unsubscribers.set(seed.workerId, unsubscribe);
    try {
      store.parentUpdateWorker(repository.canonicalRoot, seed.workerId, { processState: "starting", status: "launching" }, (this.options.now ?? Date.now)(), generation);
      await this.rpc(seed.workerId, "start", () => client.start());
      assertWorkerCurrent();
      store.parentUpdateWorker(repository.canonicalRoot, seed.workerId, { processState: "owned" }, (this.options.now ?? Date.now)(), generation);
      const rpcState = await this.rpc(seed.workerId, "getState", () => client.getState());
      assertWorkerCurrent();
      store.parentUpdateWorker(repository.canonicalRoot, seed.workerId, { status: "idle", sessionFile: rpcState.sessionFile ?? null }, (this.options.now ?? Date.now)(), generation);
    } catch (error) {
      let stopped = false;
      try { await this.rpc(seed.workerId, "stop after launch failure", () => client.stop()); stopped = true; } catch {}
      if (operation === this.operation && this.store === store && this.clients.get(seed.workerId) === client) {
        store.parentUpdateWorker(repository.canonicalRoot, seed.workerId, stopped
          ? { processState: "stopped", status: "failed", summary: "Worker launch failed; replacement will retry." }
          : { processState: "unreconciled", status: "blocked", summary: "Worker launch process could not be verified." },
        (this.options.now ?? Date.now)(), generation);
      }
      unsubscribe();
      if (this.unsubscribers.get(seed.workerId) === unsubscribe) this.unsubscribers.delete(seed.workerId);
      if (this.clients.get(seed.workerId) === client) this.clients.delete(seed.workerId);
      throw error;
    }

    const existingIntent = store.currentIntent(repository.canonicalRoot, seed.workerId);
    const prompt = [
      `You are disposable autonomous researcher ${seed.workerId} in an isolated Git worktree.`,
      "You own one bounded research campaign within the enduring project mission, from direction selection to a terminal scientific conclusion. There is no dispatcher, task queue, claim, lock, admission, supervisor approval, scope ownership, evidence reservation, or per-campaign resource budget.",
      existingIntent
        ? `A working intent survived a process interruption: ${String(existingIntent.question)}. Resume that exact campaign from shared checkpoints and artifacts; this is crash recovery, not a normal handoff.`
        : "Read program.md, its lifecycle index, durable Git history across all branches, completed research, artifacts, and other workers' active intentions. Independently choose the most valuable next direction, then publish_intent before campaign mutation.",
      "An intent is informational and non-exclusive. Choose a different mechanism from active intents by default. Overlap is allowed only when independent replication or a materially different evidence path answers a specific uncertainty; justify that overlap explicitly in the intent reason.",
      "Program.md is the enduring project mission. If no immutable executable epoch is active, fail model and evidence launches closed while continuing meta-research, design, implementation, prerequisite, evaluator, and harness work.",
      "Carry the campaign through every required experiment, replication, confirmation, diagnosis, and wait. Checkpoints are only observability and crash recovery. They never end or hand off normal work.",
      "Before finish_campaign, record terminal evidence and decisions, commit durable scientific findings and necessary clean changes to Git, and leave the worktree clean. Then finish this bounded campaign and exit for the next project-level move. Accepted requires every applicable program gate and a committed validated Pareto/model frontier advance or validated search-capability advance that makes a previously impossible legal campaign executable; merely drafting docs, changing Git, closing an epoch, or auditing is inconclusive unless it delivers such a capability. Tested failure is rejected while project-level moves remain. Family or evidence-epoch closure is not project exhaustion: pursue a legal architecture pivot, prerequisite implementation, evaluator or harness construction, or safe successor epoch. Only genuine project-level exhaustion parks the fleet; external blocks remain specific and blocked.",
      "Do not exit because a queue is empty, a stage completed, follow-up is required, an evidence process is running, context is large, or no prepared task exists. Exhausted requires that no useful legal project-level move remains across model, representation, architecture, runtime, evaluation, permitted data, tooling or prerequisites, and safe successor epochs, or that continuation is permanently impossible under external constraints with no legal workaround. A local dead end, plateau, family limit, or epoch limit is not exhaustion. Valid terminal outcomes remain accepted, rejected, inconclusive, external-blocked, and genuine project-level exhausted.",
      "Research program:",
      program,
    ];
    try {
      await this.rpc(seed.workerId, "prompt", () => client.prompt(prompt.join("\n\n")));
      assertWorkerCurrent();
    } catch (error) {
      let stopError: unknown;
      try { await this.rpc(seed.workerId, "stop after prompt failure", () => client.stop()); } catch (cause) { stopError = cause; }
      if (operation === this.operation && this.store === store && this.clients.get(seed.workerId) === client) {
        store.parentUpdateWorker(repository.canonicalRoot, seed.workerId, stopError
          ? { processState: "unreconciled", status: "blocked", summary: "Worker prompt failed and process stop could not be verified.", error: String(stopError) }
          : { processState: "stopped", status: "failed", summary: "Worker prompt failed; replacement will retry." },
        (this.options.now ?? Date.now)(), generation);
        if (!stopError) {
          this.clients.delete(seed.workerId);
          unsubscribe();
          this.unsubscribers.delete(seed.workerId);
        }
      }
      throw error;
    }
  }

  private async resumeRestoredWorker(workerId: string): Promise<void> {
    if (!this.store || !this.repository) return;
    const worker = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
    if (!worker || worker.process_state !== "stopped") return;
    if (String(worker.status) === "parked") return;
    const integration = this.store.latestIntegration(this.repository.canonicalRoot, workerId);
    if (integration && !["blocked", "complete"].includes(String(integration.integration_phase))) {
      await this.enqueueTerminalIntegration(workerId);
      return;
    }
    if (integration?.integration_phase === "complete") {
      if (String(integration.outcome) === "external-blocked") return;
      await this.syncStoppedLaneBeforeLaunch(workerId, "restored completed lane");
      await this.restartWorker(workerId);
      return;
    }
    if (["complete", "blocked"].includes(String(worker.status))) {
      this.queueOperationalIncident(workerId, "historical terminal campaign has no integration phase and was left untouched");
      return;
    }
    await this.syncStoppedLaneBeforeLaunch(workerId, "restored stopped lane");
    await this.restartWorker(workerId);
  }

  private async syncStoppedLaneBeforeLaunch(workerId: string, reason: string): Promise<void> {
    const { store, root } = this.requireActive();
    await this.assertSyncSafe(workerId);
    const lane = this.lanes.get(workerId);
    if (!lane || !this.repository || !this.generation) throw new Error(`Missing worker lane: ${workerId}`);
    const synced = (this.options.syncLane ?? syncLaneToCanonical)({
      canonicalRoot: root, lane, generation: this.generation,
      now: (this.options.now ?? Date.now)(), ...(this.options.run ? { run: this.options.run } : {}),
    });
    store.parentUpdateWorker(root, workerId, { head: synced.canonicalHead, summary: `Stopped lane synchronized before launch (${reason}).` }, (this.options.now ?? Date.now)(), this.generation);
  }

  private enqueueTerminalIntegration(workerId: string): Promise<void> {
    if (this.integrationPending.has(workerId)) return this.integrationTail;
    this.integrationPending.add(workerId);
    const task = this.integrationTail.then(() => this.integrateTerminalWorker(workerId));
    this.integrationTail = task.catch(() => {}).finally(() => this.integrationPending.delete(workerId));
    return task;
  }

  private async integrateTerminalWorker(workerId: string): Promise<void> {
    if (!this.active || this.ownership !== "owner" || this.shuttingDown || !this.store || !this.repository || !this.generation) return;
    const store = this.store;
    const repository = this.repository;
    const generation = this.generation;
    const operation = this.operation;
    const root = repository.canonicalRoot;
    let intent = store.pendingIntegration(root, workerId);
    if (!intent || intent.integration_phase === "blocked") return;
    const intentId = Number(intent.id);
    const terminalHead = String(intent.terminal_head ?? "");
    const baselineHead = String(intent.baseline_head ?? "");
    const lane = this.lanes.get(workerId);
    if (!lane || !terminalHead || !baselineHead || !Number.isInteger(intentId)) {
      const message = "Terminal integration lacks a lane, baseline head, terminal head, or intent id";
      store.blockIntegration(root, workerId, generation, intentId, message, (this.options.now ?? Date.now)());
      this.queueOperationalIncident(workerId, message);
      return;
    }

    try {
      await this.stopWorker(workerId, "paused");
      this.assertFleetOperation(operation, store, repository, generation);
      if (!this.active || this.ownership !== "owner") throw new FleetOperationCancelledError("Fleet stopped before terminal integration");
      const stopped = store.snapshot(root, { workerId, recent: 1 }).workers[0];
      if (!stopped || stopped.process_state !== "stopped") throw new Error("Worker process termination was not verified before terminal integration");

      const terminalRef = (this.options.preserveTerminal ?? preserveTerminalRef)({
        canonicalRoot: root, lane, generation, intentId, baselineHead, terminalHead,
        ...(typeof intent.integration_result_head === "string" ? { integratedHead: intent.integration_result_head } : {}),
        ...(this.options.run ? { run: this.options.run } : {}),
      });
      if (intent.integration_ref && intent.integration_ref !== terminalRef) {
        throw new Error(`Persisted terminal ref changed from ${String(intent.integration_ref)} to ${terminalRef}`);
      }
      if (intent.integration_phase === "pending") {
        store.markIntegrationRef(root, workerId, generation, intentId, terminalRef, (this.options.now ?? Date.now)());
      }
      intent = store.pendingIntegration(root, workerId);
      if (!intent) throw new Error("Terminal integration state disappeared");

      let resultHead = typeof intent.integration_result_head === "string" ? intent.integration_result_head : undefined;
      if (intent.integration_phase !== "integrated") {
        const fleet = store.snapshot(root, { recent: 1 }).fleet;
        if (fleet?.integration_error) throw new Error(`Canonical integration is globally blocked: ${String(fleet.integration_error)}`);
        const canonicalBranch = String(fleet?.canonical_branch ?? "");
        if (!canonicalBranch) throw new Error("Fleet has no captured canonical branch");
        const recovering = intent.integration_phase === "integrating";
        const baseHead = recovering ? String(intent.integration_base_head ?? "") : String(fleet?.canonical_head ?? "");
        if (!baseHead) throw new Error("Fleet has no expected canonical HEAD");
        if (!recovering) store.beginIntegration(root, workerId, generation, intentId, baseHead, (this.options.now ?? Date.now)());
        const merged = (this.options.integrateTerminal ?? integrateTerminalRef)({
          canonicalRoot: root, canonicalBranch, expectedHead: baseHead, terminalRef,
          recoverMerged: recovering,
          ...(this.options.run ? { run: this.options.run } : {}),
        });
        resultHead = merged.resultHead;
        store.completeCanonicalIntegration(root, workerId, generation, intentId, baseHead, resultHead, (this.options.now ?? Date.now)());
      }
      if (!resultHead) throw new Error("Terminal integration has no result HEAD");

      (this.options.resetIntegratedLane ?? resetIntegratedLane)({
        lane, terminalHead, resultHead, ...(this.options.run ? { run: this.options.run } : {}),
      });
      const transition = store.completeLaneReset(root, workerId, generation, intentId, (this.options.now ?? Date.now)());
      this.assertFleetOperation(operation, store, repository, generation);
      if (transition.reactivatedWorkerIds.length > 0) {
        for (const reactivatedWorkerId of transition.reactivatedWorkerIds) this.reconcileQueuedLane(reactivatedWorkerId, "scientific frontier advanced");
      }
      if (transition.disposition === "fleet-exhausted") {
        this.active = false;
        this.stopDashboard();
        this.setToolsActive(true);
        return;
      }
      if (transition.disposition !== "replace") return;
      if (!this.active || this.shuttingDown || this.ownership !== "owner" || String(store.snapshot(root).fleet?.status) !== "active") return;
      const row = store.snapshot(root, { workerId, recent: 1 }).workers[0];
      if (!row || row.process_state !== "stopped") throw new Error("Completed lane is not stopped before replacement");
      const sessionId = (this.options.sessionId ?? randomUUID)();
      store.resetWorkerSession(root, workerId, generation, sessionId, (this.options.now ?? Date.now)());
      await this.launchWorker({
        workerId, sessionId, worktree: String(row.worktree), branch: String(row.branch), sessionsRoot: dirname(String(row.session_dir)),
      }, this.options.planningProvider ?? this.currentCtx?.model?.provider ?? "openai-codex",
        this.options.planningModel ?? this.currentCtx?.model?.id ?? "gpt-5.6-sol",
        this.options.planningThinking ?? this.pi.getThinkingLevel(), this.operation);
    } catch (error) {
      if (error instanceof FleetOperationCancelledError) return;
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (error instanceof TerminalIntegrationCleanupError) {
          store.blockAllIntegrations(root, generation, message, (this.options.now ?? Date.now)());
        }
        store.blockIntegration(root, workerId, generation, intentId, message, (this.options.now ?? Date.now)());
      } catch (stateError) {
        this.currentCtx?.ui.notify(`Could not persist blocked terminal integration: ${stateError instanceof Error ? stateError.message : String(stateError)}`, "error");
      }
      this.queueOperationalIncident(workerId, error instanceof TerminalIntegrationCleanupError
        ? `canonical integration cleanup failed and all integrations are blocked: ${message}`
        : `terminal integration blocked: ${message}`);
    } finally {
      this.refreshDashboard();
    }
  }

  private markRecoveryHealthy(workerId: string, reason: string): void {
    this.recoveryAttempts.delete(workerId);
    if (!this.store || !this.repository || !this.generation) return;
    this.store.parentAddWorkerEvent(
      this.repository.canonicalRoot,
      workerId,
      this.generation,
      "automatic_recovery_healthy",
      reason,
      (this.options.now ?? Date.now)(),
    );
  }

  private scheduleRecycle(workerId: string, reason: string): void {
    if (!this.active || this.ownership !== "owner" || this.shuttingDown || !this.store || !this.repository) return;
    const worker = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
    if (String(worker?.status) === "parked") return;
    if (["complete", "blocked"].includes(String(worker?.status))) {
      const integration = this.store.pendingIntegration(this.repository.canonicalRoot, workerId);
      if (integration && integration.integration_phase !== "blocked") {
        this.forkTask(() => this.enqueueTerminalIntegration(workerId), () => {});
      } else if (!integration && String(worker?.status) === "complete") {
        this.queueOperationalIncident(workerId, "terminal campaign has no pending integration and was left untouched");
      }
      return;
    }
    if (this.recyclePending.has(workerId)) return;
    this.recyclePending.add(workerId);
    const workerOperation = this.workerOperations.get(workerId) ?? 0;
    this.forkTask(async () => {
      let retryAgain = false;
      try {
        if (!this.store || !this.repository || !this.generation || !this.active || this.ownership !== "owner") return;
        const store = this.store;
        const repository = this.repository;
        const generation = this.generation;
        const operation = this.operation;
        this.assertWorkerOperation(workerId, operation, workerOperation);
        const before = store.snapshot(repository.canonicalRoot, { workerId, recent: 1 });
        const beforeWorker = before.workers[0];
        if (!beforeWorker) return;
        const operationalFailure = String(beforeWorker.status) === "failed";
        if (["complete", "blocked"].includes(String(beforeWorker.status))) this.markRecoveryHealthy(workerId, "scientific campaign reached a terminal outcome");
        const priorAttempts = operationalFailure
          ? Math.max(this.recoveryAttempts.get(workerId) ?? 0, store.recoveryAttemptCount(repository.canonicalRoot, workerId, generation))
          : 0;
        const attempt = operationalFailure ? priorAttempts + 1 : 0;
        if (operationalFailure) {
          this.recoveryAttempts.set(workerId, attempt);
          store.parentAddWorkerEvent(repository.canonicalRoot, workerId, generation, "automatic_recovery_attempt", reason, (this.options.now ?? Date.now)());
        }

        await this.stopWorker(workerId, "paused");
        this.assertWorkerOperation(workerId, operation, workerOperation);
        const stopped = store.snapshot(repository.canonicalRoot, { workerId, recent: 1 });
        const row = stopped.workers[0];
        if (!row || row.process_state !== "stopped") return;
        if (String(stopped.fleet?.status) !== "active") {
          this.active = false;
          store.parentUpdateWorker(repository.canonicalRoot, workerId, {
            status: "blocked", processState: "stopped",
            summary: "Automatic recovery stopped because the persisted fleet is not active.",
            error: `automatic recovery after ${reason} observed fleet status ${String(stopped.fleet?.status ?? "missing")}`,
          }, (this.options.now ?? Date.now)(), generation);
          this.queueOperationalIncident(workerId, "persisted fleet is not active");
          return;
        }
        const maxAttempts = Math.max(0, Math.floor(this.options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS));
        if (operationalFailure && attempt > maxAttempts) {
          store.parentUpdateWorker(repository.canonicalRoot, workerId, {
            status: "blocked", processState: "stopped",
            summary: `Automatic recovery exhausted after ${maxAttempts} replacement attempts.`,
            error: `last automatic recovery trigger: ${reason}`,
          }, (this.options.now ?? Date.now)(), generation);
          this.queueOperationalIncident(workerId, `automatic recovery exhausted after ${maxAttempts} replacement attempts`);
          return;
        }
        const baseBackoff = Math.max(0, this.options.recycleBackoffMs ?? DEFAULT_RECYCLE_BACKOFF_MS);
        const backoff = operationalFailure
          ? Math.min(MAX_RECYCLE_BACKOFF_MS, baseBackoff * 2 ** Math.max(0, attempt - 1))
          : baseBackoff;
        if (backoff > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, backoff));
        this.assertWorkerOperation(workerId, operation, workerOperation);
        if (!this.active || this.shuttingDown || this.ownership !== "owner") return;
        const currentFleet = store.snapshot(repository.canonicalRoot, { workerId, recent: 1 });
        if (String(currentFleet.fleet?.status) !== "active") {
          this.active = false;
          this.queueOperationalIncident(workerId, "persisted fleet changed before replacement launch");
          return;
        }
        const sessionId = (this.options.sessionId ?? randomUUID)();
        store.resetWorkerSession(repository.canonicalRoot, workerId, generation, sessionId, (this.options.now ?? Date.now)());
        await this.launchWorker({
          workerId, sessionId, worktree: String(row.worktree), branch: String(row.branch), sessionsRoot: dirname(String(row.session_dir)),
        }, this.options.planningProvider ?? this.currentCtx?.model?.provider ?? "openai-codex",
          this.options.planningModel ?? this.currentCtx?.model?.id ?? "gpt-5.6-sol",
          this.options.planningThinking ?? this.pi.getThinkingLevel(), operation);
      } catch (error) {
        if (!(error instanceof FleetOperationCancelledError) && this.store && this.repository && this.generation) {
          const worker = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
          if (worker?.process_state === "stopped" && this.active && this.ownership === "owner" && !this.shuttingDown) {
            const attempts = this.recoveryAttempts.get(workerId) ?? 0;
            this.store.parentUpdateWorker(this.repository.canonicalRoot, workerId, {
              status: "failed", processState: "stopped",
              summary: `Replacement launch failed after ${attempts} recovery attempt${attempts === 1 ? "" : "s"}; retrying within the circuit limit.`,
              error: `automatic replacement after ${reason}: ${error instanceof Error ? error.message : String(error)}`,
            }, (this.options.now ?? Date.now)(), this.generation);
            retryAgain = true;
          }
        }
      } finally {
        this.recyclePending.delete(workerId);
        this.refreshDashboard();
        if (retryAgain) this.scheduleRecycle(workerId, reason);
      }
    }, () => { this.recyclePending.delete(workerId); });
  }

  private reconcileQueuedLane(workerId: string, reason: string): void {
    if (!this.active || this.ownership !== "owner" || this.shuttingDown || !this.store || !this.repository || !this.generation) return;
    if (this.recyclePending.has(workerId)) return;
    this.recyclePending.add(workerId);
    const store = this.store;
    const repository = this.repository;
    const generation = this.generation;
    const operation = this.operation;
    this.forkTask(async () => {
      try {
        this.assertFleetOperation(operation, store, repository, generation);
        const row = store.snapshot(repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
        if (!row || String(row.status) !== "queued" || row.process_state !== "stopped") return;
        if (store.currentIntent(repository.canonicalRoot, workerId) || store.pendingIntegration(repository.canonicalRoot, workerId)) return;
        await this.assertSyncSafe(workerId);
        const lane = this.lanes.get(workerId);
        if (!lane) throw new Error(`Missing worker lane: ${workerId}`);
        const synced = (this.options.syncLane ?? syncLaneToCanonical)({
          canonicalRoot: repository.canonicalRoot, lane, generation,
          now: (this.options.now ?? Date.now)(), ...(this.options.run ? { run: this.options.run } : {}),
        });
        store.parentUpdateWorker(repository.canonicalRoot, workerId, { head: synced.canonicalHead, summary: `Queued lane synchronized before launch (${reason}).` }, (this.options.now ?? Date.now)(), generation);
        const current = store.snapshot(repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
        if (!current || String(current.status) !== "queued" || current.process_state !== "stopped") return;
        const sessionId = (this.options.sessionId ?? randomUUID)();
        store.resetWorkerSession(repository.canonicalRoot, workerId, generation, sessionId, (this.options.now ?? Date.now)());
        await this.launchWorker({
          workerId, sessionId, worktree: String(current.worktree), branch: String(current.branch), sessionsRoot: dirname(String(current.session_dir)),
        }, this.options.planningProvider ?? this.currentCtx?.model?.provider ?? "openai-codex",
          this.options.planningModel ?? this.currentCtx?.model?.id ?? "gpt-5.6-sol",
          this.options.planningThinking ?? this.pi.getThinkingLevel(), operation);
      } catch (error) {
        if (!(error instanceof FleetOperationCancelledError)) this.queueOperationalIncident(workerId, `queued lane reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.recyclePending.delete(workerId);
        this.refreshDashboard();
      }
    }, () => { this.recyclePending.delete(workerId); });
  }

  private handleWorkerEvent(workerId: string, sessionId: string, client: RpcWorkerClient, event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string" || !this.store || !this.repository || !this.generation || this.shuttingDown) return;
    if (this.clients.get(workerId) !== client || this.stopOperations.has(workerId)) return;
    const root = this.repository.canonicalRoot;
    try {
      const worker = this.store.snapshot(root, { workerId, recent: 1 }).workers[0];
      if (!worker || Number(worker.generation) !== this.generation || worker.session_id !== sessionId) return;
      const currentStatus = String(worker.status ?? "");
      const result = isRecord(event.result) ? event.result : undefined;
      const details = result && isRecord(result.details) ? result.details : undefined;
      const successfulInitialIntentPublication = event.type === "tool_execution_end"
        && event.toolName === AUTORESEARCH_WORKER_TOOL
        && event.isError === false
        && details?.action === "publish_intent"
        && Number.isInteger(details.intentId);
      if (successfulInitialIntentPublication) {
        this.releaseInitialIntent(this.operation, this.generation, workerId, sessionId, "published");
      }
      if (TERMINAL_WORKER_STATUSES.has(currentStatus)) {
        if (["extension_error", "error"].includes(event.type) || (event.type === "agent_settled" && currentStatus === "failed")) {
          this.releaseInitialIntent(this.operation, this.generation, workerId, sessionId, "failed");
        }
        if (["agent_settled", "extension_error"].includes(event.type) && ["complete", "blocked", "failed"].includes(currentStatus)) {
          this.scheduleRecycle(workerId, `campaign worker reached ${currentStatus}`);
        }
        if (["message_end", "agent_end", "agent_settled", "extension_error"].includes(event.type)) this.refreshDashboard();
        return;
      }
      if (event.type === "agent_start") this.store.parentUpdateWorker(root, workerId, { currentTool: null }, (this.options.now ?? Date.now)(), this.generation);
      if (event.type === "tool_execution_start") this.store.parentUpdateWorker(root, workerId, { currentTool: String(event.toolName ?? "") }, (this.options.now ?? Date.now)(), this.generation);
      if (event.type === "tool_execution_end") this.store.parentUpdateWorker(root, workerId, { currentTool: null, error: event.isError ? `${String(event.toolName ?? "tool")} failed` : null }, (this.options.now ?? Date.now)(), this.generation);
      if (event.type === "message_end") {
        const snippet = assistantSnippet(event.message);
        if (snippet) this.store.parentUpdateWorker(root, workerId, { summary: snippet }, (this.options.now ?? Date.now)(), this.generation);
      }
      if (event.type === "agent_end") {
        const assistant = finalAssistant(event.messages);
        if (assistant?.role === "assistant" && !["stop", "toolUse"].includes(assistant.stopReason)) {
          this.store.parentUpdateWorker(root, workerId, { status: "failed", error: assistant.errorMessage ?? assistant.stopReason }, (this.options.now ?? Date.now)(), this.generation);
          this.releaseInitialIntent(this.operation, this.generation, workerId, sessionId, "failed");
        }
      }
      if (event.type === "agent_settled") {
        const latest = this.store.snapshot(root, { workerId, recent: 1 }).workers[0];
        if (latest && !TERMINAL_WORKER_STATUSES.has(String(latest.status))) {
          this.store.parentUpdateWorker(root, workerId, { status: "idle", currentTool: null }, (this.options.now ?? Date.now)(), this.generation);
          this.markRecoveryHealthy(workerId, "worker reached healthy nonterminal settlement");
        }
      }
      if (event.type === "extension_error") {
        this.store.parentUpdateWorker(root, workerId, { status: "failed", error: String(event.error ?? "extension error") }, (this.options.now ?? Date.now)(), this.generation);
        this.releaseInitialIntent(this.operation, this.generation, workerId, sessionId, "failed");
      }
      if (event.type === "error") {
        this.releaseInitialIntent(this.operation, this.generation, workerId, sessionId, "failed");
      }
      if (["tool_execution_end", "message_end", "agent_end", "agent_settled", "extension_error"].includes(event.type)) {
        const latestStatus = String(this.store.snapshot(root, { workerId, recent: 1 }).workers[0]?.status ?? "");
        if (["complete", "blocked", "failed"].includes(latestStatus) && ["agent_settled", "extension_error"].includes(event.type)) {
          this.scheduleRecycle(workerId, `campaign worker reached ${latestStatus}`);
        }
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
      description: "Inspect bounded operational worker, process, intent, checkpoint, frontier, terminal outcome, and recent fleet state. Use this first when a worker is parked, blocked, exhausted, or failed.",
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
        const { store, root } = this.requireManaged();
        const workerId = params.scope === "worker" && typeof params.worker === "string" ? params.worker : undefined;
        if (params.scope === "worker" && !workerId) throw new Error("worker scope requires worker id");
        const recent = typeof params.recent === "number" ? params.recent : undefined;
        const result = boundedInspect(store.snapshot(root, {
          ...(workerId ? { workerId } : {}), ...(recent !== undefined ? { recent } : {}),
        }), params.view === "recent" ? "recent" : "summary");
        return { content: [{ type: "text", text: resultText(result) }], details: result };
      },
    });

    this.pi.registerTool({
      name: "autoresearch_control",
      label: "Autoresearch Control",
      description: "Recover or operate worker processes after inspection, including explicit resume of parked lanes. Reconcile is allowed only after exact external process termination is verified; this tool does not approve research directions or turn audits into accepted results.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["steer", "follow_up", "pause", "resume", "restart", "stop", "sync", "reconcile"] },
          target: { type: "string", description: "Worker lane id, session UUID or prefix, or all" },
          message: { type: "string" },
        },
        required: ["action"], additionalProperties: false,
      },
      execute: async (_id, params) => {
        const result = await this.controller.request<Record<string, unknown>>((reply) => ({
          _tag: "Control", action: String(params.action), target: typeof params.target === "string" ? params.target : "all",
          message: typeof params.message === "string" ? params.message : undefined, reply,
        }));
        return { content: [{ type: "text", text: resultText(result) }], details: result };
      },
    });
  }

  private requireManaged(): { store: FleetStore; root: string } {
    if (!this.store || !this.repository) throw new Error("No managed autoresearch fleet");
    return { store: this.store, root: this.repository.canonicalRoot };
  }
  private requireActive(): { store: FleetStore; root: string } {
    if (!this.active) throw new Error("No active autoresearch fleet");
    return this.requireManaged();
  }

  private targets(target: string): string[] {
    if (target === "all") return [...this.lanes.keys()].sort();
    if (this.lanes.has(target)) return [target];
    const { store, root } = this.requireManaged();
    const workers = store.snapshot(root, { recent: 1 }).workers;
    const normalized = target.toLowerCase();
    const fullMatch = workers.find((worker) => String(worker.session_id).toLowerCase() === normalized);
    if (fullMatch) return [String(fullMatch.worker_id)];
    if (!/^[0-9a-f]{8,32}$/i.test(target)) throw new Error(`Unknown worker target: ${target}`);
    const matches = workers.filter((worker) => String(worker.session_id).replaceAll("-", "").toLowerCase().startsWith(normalized));
    if (matches.length === 0) throw new Error(`Unknown worker session UUID prefix: ${target}`);
    if (matches.length > 1) throw new Error(`Ambiguous worker session UUID prefix: ${target}`);
    return [String(matches[0]!.worker_id)];
  }

  async control(action: string, target: string, message?: string): Promise<Record<string, unknown>> {
    return this.controller.request<Record<string, unknown>>((reply) => ({ _tag: "Control", action, target, message, reply }));
  }

  private async controlImpl(action: string, target: string, message?: string): Promise<Record<string, unknown>> {
    const { store, root } = this.requireManaged();
    if (!this.active && !["reconcile", "resume", "stop"].includes(action)) throw new Error("Autoresearch is off; only explicit process reconciliation, resume, or stop is available");
    if (!this.repository || !this.generation) throw new Error("Fleet control state is incomplete");
    const repository = this.repository;
    const generation = this.generation;
    const operation = this.operation;
    const validate = (): void => this.assertFleetOperation(operation, store, repository, generation);
    const targets = this.targets(target);
    if (["steer", "follow_up"].includes(action) && !message?.trim()) throw new Error(`${action} requires message`);
    if (action === "resume" && String(store.snapshot(root, { recent: 1 }).fleet?.status) === "exhausted") {
      store.setFleetStatus(root, "active", (this.options.now ?? Date.now)(), generation);
      this.active = true;
      this.ownership = "owner";
      this.setToolsActive(true);
      this.startDashboard();
    }

    if (action === "reconcile") {
      if (message?.trim() !== "process-terminated") throw new Error("reconcile requires message=process-terminated after external process verification");
      for (const workerId of targets) {
        const current = store.snapshot(root, { workerId, recent: 1 }).workers[0];
        if (current && typeof current.session_id === "string") {
          this.releaseInitialIntent(this.operation, generation, workerId, current.session_id, "failed");
        }
        this.clients.delete(workerId);
        this.unsubscribers.get(workerId)?.();
        this.unsubscribers.delete(workerId);
        store.parentUpdateWorker(root, workerId, { processState: "stopped", status: "paused", currentTool: null, error: null }, (this.options.now ?? Date.now)(), generation);
      }
      const fullyReconciled = store.snapshot(root).workers.every((worker) => worker.process_state === "stopped");
      if (!this.active && fullyReconciled) {
        store.setFleetStatus(root, "stopped", (this.options.now ?? Date.now)(), generation);
        this.setToolsActive(false);
        this.closeFleetResources();
      }
      return { action, targets, reconciled: true, fullyReconciled };
    }

    if (action === "sync") {
      const synced: Record<string, unknown>[] = [];
      for (const workerId of targets) {
        const pending = store.pendingIntegration(root, workerId);
        if (pending?.integration_phase === "blocked") {
          const retry = await this.retryBlockedIntegrationAfterCanonicalAdvance(workerId, pending);
          synced.push({ workerId, ...retry });
          continue;
        }
        await this.assertSyncSafe(workerId);
        validate();
        const lane = this.lanes.get(workerId)!;
        const result = (this.options.syncLane ?? syncLaneToCanonical)({
          canonicalRoot: root, lane, generation, now: (this.options.now ?? Date.now)(), ...(this.options.run ? { run: this.options.run } : {}),
        });
        store.parentUpdateWorker(root, workerId, { head: result.canonicalHead, summary: `Synced idle lane; prior commits preserved at ${result.candidateRef}.` }, (this.options.now ?? Date.now)(), generation);
        synced.push({ workerId, ...result });
      }
      this.refreshDashboard();
      return { action, synced };
    }

    for (const workerId of targets) {
      if (["pause", "resume", "restart", "stop"].includes(action)) this.bumpWorkerOperation(workerId);
      if (["pause", "stop"].includes(action)) {
        try { await this.stopOperations.get(workerId); } catch {}
        validate();
      }
      const client = this.clients.get(workerId);
      if (action === "steer") {
        if (!client) throw new Error(`${workerId} has no running RPC process`);
        await this.rpc(workerId, "steer", () => client.steer(message!.trim()));
      } else if (action === "follow_up") {
        if (!client) throw new Error(`${workerId} has no running RPC process`);
        await this.rpc(workerId, "followUp", () => client.followUp(message!.trim()));
      } else if (action === "pause") {
        await this.stopWorker(workerId, "paused");
      } else if (action === "resume" || action === "restart") {
        if (String(store.snapshot(root, { workerId, recent: 1 }).fleet?.status) !== "active") {
          throw new Error("Persisted autoresearch fleet is not active; reconcile or restore the fleet before restarting workers");
        }
        this.markRecoveryHealthy(workerId, "manual restart reset the automatic recovery circuit");
        await this.restartWorker(workerId);
      } else if (action === "stop") {
        await this.stopWorker(workerId, "stopped");
      }
      validate();
    }
    if (action === "stop" && store.snapshot(root).workers.every((worker) => worker.status === "stopped")) {
      store.setFleetStatus(root, "stopped", (this.options.now ?? Date.now)(), generation);
      this.active = false;
      this.stopDashboard();
      this.setToolsActive(false);
      this.closeFleetResources();
    }
    this.refreshDashboard();
    return { action, targets };
  }

  private async retryBlockedIntegrationAfterCanonicalAdvance(
    workerId: string,
    pending: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { store, root } = this.requireActive();
    if (!this.repository || !this.generation) throw new Error("Fleet integration retry state is incomplete");
    const worker = store.snapshot(root, { workerId, recent: 1 }).workers[0];
    if (!worker) throw new Error(`Missing worker state: ${workerId}`);
    if (worker.process_state !== "stopped") throw new Error(`${workerId} process ownership must be stopped before integration retry`);
    if (this.clients.get(workerId)) throw new Error(`${workerId} still has a process client; integration retry is forbidden`);
    if (store.currentIntent(root, workerId)) throw new Error(`${workerId} still has an active campaign intent`);
    const integrationError = String(pending.integration_error ?? "");
    const fleet = store.snapshot(root, { recent: 1 }).fleet;
    const expectedHead = String(fleet?.canonical_head ?? "");
    const integrationBase = String(pending.integration_base_head ?? "");
    if (!expectedHead || integrationBase !== expectedHead) throw new Error(`${workerId} blocked integration base no longer matches fleet state`);
    const terminalHead = String(pending.terminal_head ?? "");
    const lane = this.lanes.get(workerId);
    if (!lane) throw new Error(`Missing worker lane: ${workerId}`);
    const laneState = (this.options.laneState ?? ((path) => laneGitState(path, this.options.run)))(lane.path);
    if (laneState.dirty || laneState.head !== terminalHead) {
      throw new Error(`${workerId} lane must be clean at its preserved terminal head before integration retry`);
    }
    const inspect = this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run));
    const actual = inspect(root);
    if (actual.branch !== String(fleet?.canonical_branch ?? "")) throw new Error("Canonical branch changed before integration retry");
    if (actual.dirty) throw new Error("Canonical checkout is dirty before integration retry");
    if (actual.head === expectedHead) throw new Error("Canonical HEAD no longer reflects the blocked advance");
    const isAncestor = this.options.isAncestor ?? isGitAncestor;
    if (!isAncestor(root, expectedHead, actual.head, this.options.run)) {
      throw new Error(`Canonical HEAD ${actual.head} is not a fast-forward descendant of expected ${expectedHead}`);
    }
    if (terminalHead && isAncestor(root, terminalHead, actual.head, this.options.run)) {
      store.adoptBlockedCanonicalIntegration(
        root, workerId, this.generation, Number(pending.id), expectedHead, actual.head, (this.options.now ?? Date.now)(),
      );
      await this.enqueueTerminalIntegration(workerId);
      return { adoptedIntegration: true, previousCanonicalHead: expectedHead, observedCanonicalHead: actual.head };
    }
    if (!integrationError.startsWith("Canonical HEAD changed from expected ")) {
      throw new Error(`${workerId} blocked integration has not been manually integrated into canonical HEAD`);
    }
    store.retryBlockedIntegrationAfterCanonicalAdvance(
      root, workerId, this.generation, Number(pending.id), expectedHead, actual.head, (this.options.now ?? Date.now)(),
    );
    await this.enqueueTerminalIntegration(workerId);
    return { retriedIntegration: true, previousCanonicalHead: expectedHead, observedCanonicalHead: actual.head };
  }

  private async assertSyncSafe(workerId: string): Promise<void> {
    const { store, root } = this.requireActive();
    if (!this.repository || !this.generation) throw new Error("Fleet sync state is incomplete");
    const worker = store.snapshot(root, { workerId, recent: 1 }).workers[0];
    if (!worker) throw new Error(`Missing worker state: ${workerId}`);
    if (!["queued", "paused", "blocked", "failed", "complete", "stopped"].includes(String(worker.status))) {
      throw new Error(`${workerId} must be queued, paused, or terminal before sync`);
    }
    if (store.currentIntent(root, workerId)) throw new Error(`${workerId} has a working campaign intent; sync would destroy crash-recovery state`);
    if (store.pendingIntegration(root, workerId)) throw new Error(`${workerId} has pending terminal integration; sync is forbidden`);
    if (worker.process_state !== "stopped") throw new Error(`${workerId} process ownership must be stopped before sync`);
    const client = this.clients.get(workerId);
    if (client) throw new Error(`${workerId} still has a process client; sync is forbidden`);
    const lane = this.lanes.get(workerId)!;
    if ((this.options.laneState ?? ((path) => laneGitState(path, this.options.run)))(lane.path).dirty) throw new Error(`${workerId} worktree is dirty`);
  }

  private async restartWorker(workerId: string): Promise<void> {
    const { store, root } = this.requireActive();
    if (!this.repository || !this.generation) throw new Error("Fleet restart state is incomplete");
    const repository = this.repository;
    const generation = this.generation;
    const operation = this.operation;
    const row = store.snapshot(root, { workerId, recent: 1 }).workers[0];
    if (!row) throw new Error(`Missing worker state: ${workerId}`);
    if (store.pendingIntegration(root, workerId)) throw new Error(`${workerId} has pending terminal integration and cannot be restarted directly`);
    if (row.process_state === "owned" && !this.clients.has(workerId)) throw new Error(`${workerId} process state is unresolved`);
    await this.stopWorker(workerId, "paused");
    this.assertFleetOperation(operation, store, repository, generation);
    const sessionId = (this.options.sessionId ?? randomUUID)();
    store.resetWorkerSession(root, workerId, generation, sessionId, (this.options.now ?? Date.now)());
    await this.launchWorker({
      workerId, sessionId, worktree: String(row.worktree), branch: String(row.branch), sessionsRoot: dirname(String(row.session_dir)),
    }, this.options.planningProvider ?? this.currentCtx?.model?.provider ?? "openai-codex",
      this.options.planningModel ?? this.currentCtx?.model?.id ?? "gpt-5.6-sol",
      this.options.planningThinking ?? this.pi.getThinkingLevel(), operation);
  }

  private stopWorker(workerId: string, requestedStatus: WorkerStatus): Promise<void> {
    const existing = this.stopOperations.get(workerId);
    if (existing) return existing;
    const operation = this.stopWorkerExclusive(workerId, requestedStatus).finally(() => {
      if (this.stopOperations.get(workerId) === operation) this.stopOperations.delete(workerId);
    });
    this.stopOperations.set(workerId, operation);
    return operation;
  }

  private async stopWorkerExclusive(workerId: string, requestedStatus: WorkerStatus): Promise<void> {
    if (!this.store || !this.repository || !this.generation) return;
    const store = this.store;
    const repository = this.repository;
    const generation = this.generation;
    const root = repository.canonicalRoot;
    const before = store.snapshot(root, { workerId, recent: 1 }).workers[0];
    const processState = String(before?.process_state ?? "unknown");
    if (before && typeof before.session_id === "string") {
      this.releaseInitialIntent(this.operation, generation, workerId, before.session_id, "failed");
    }
    const client = this.clients.get(workerId);
    let stopError: unknown;
    if (client) {
      try { await this.rpc(workerId, "abort", () => client.abort()); } catch {}
      try { await this.rpc(workerId, "stop", () => client.stop()); } catch (error) { stopError = error; }
      if (this.store !== store || this.repository !== repository || this.generation !== generation) throw new FleetOperationCancelledError("Fleet changed while stopping worker");
      if (!stopError) {
        if (this.clients.get(workerId) === client) this.clients.delete(workerId);
        this.unsubscribers.get(workerId)?.();
        this.unsubscribers.delete(workerId);
      }
    } else if (processState !== "stopped") {
      stopError = new Error(`${workerId} has no in-memory client; process termination cannot be verified`);
    }
    if (stopError) {
      store.parentUpdateWorker(root, workerId, {
        processState: "unreconciled", status: "blocked", currentTool: null,
        summary: "Process stop could not be verified; research scheduling is disabled for this slot.",
        error: stopError instanceof Error ? stopError.message : String(stopError),
      }, (this.options.now ?? Date.now)(), generation);
      this.queueOperationalIncident(workerId, "process termination could not be verified");
      throw stopError;
    }
    const currentStatus = String(store.snapshot(root, { workerId, recent: 1 }).workers[0]?.status ?? "");
    const preserveTerminal = ["complete", "blocked"].includes(currentStatus)
      || (requestedStatus === "paused" && ["failed", "parked"].includes(currentStatus));
    store.parentUpdateWorker(root, workerId, {
      processState: "stopped", currentTool: null,
      ...(preserveTerminal ? {} : { status: requestedStatus }),
    }, (this.options.now ?? Date.now)(), generation);
  }

  private closeFleetResources(): void {
    this.cancelInitialIntentBarrier("Autoresearch fleet resources were closed");
    this.workerOperations.clear();
    this.recyclePending.clear();
    this.integrationPending.clear();
    this.integrationTail = Promise.resolve();
    this.recoveryAttempts.clear();
    this.livenessChecks.clear();
    this.stopOperations.clear();
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.clients.clear();
    if (this.incidentTimer !== undefined) clearTimeout(this.incidentTimer);
    this.incidentTimer = undefined;
    this.pendingIncidents.clear();
    this.incidentKeys.clear();
    this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.generation = undefined;
    this.ownership = "none";
    this.lanes.clear();
  }

  private startDashboard(): void {
    this.refreshDashboard();
    const interval = this.options.dashboardIntervalMs ?? 5_000;
    if (interval > 0 && !this.dashboardRunning) {
      this.dashboardRunning = true;
      this.controller.tell({
        _tag: "RunEffect",
        effect: scopedSleep(interval).pipe(
          Effect.zipRight(this.controller.offer({ _tag: "DashboardRefresh" })),
          Effect.repeat({ while: () => this.dashboardRunning }),
          Effect.ensuring(Effect.sync(() => { this.dashboardRunning = false; })),
        ),
      });
    }
  }

  private stopDashboard(): void {
    this.dashboardRunning = false;
    this.dashboardRenderState = undefined;
    this.dashboardRequestRender = () => {};
    this.dashboardWidgetRegistered = false;
    const ctx = this.currentCtx;
    if (ctx) ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, undefined);
  }

  private updateDashboardWidget(state: DashboardRenderState): void {
    const ctx = this.currentCtx;
    if (!ctx) return;
    this.dashboardRenderState = state;
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, fleetDashboardWidgetLines(state.snapshot, state.options)
        .map((line) => line.segments.map((segment) => segment.text).join("")), { placement: "aboveEditor" });
      return;
    }
    if (!this.dashboardWidgetRegistered) {
      this.dashboardWidgetRegistered = true;
      try {
        ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, (tui, theme) => {
          this.dashboardRequestRender = () => tui.requestRender();
          return {
            render: (width: number) => this.dashboardRenderState
              ? fleetDashboardWidgetLines(this.dashboardRenderState.snapshot, this.dashboardRenderState.options)
                  .map((line) => renderDashboardLine(line, theme, width))
              : [],
            invalidate() {},
          };
        }, { placement: "aboveEditor" });
      } catch (error) {
        this.dashboardWidgetRegistered = false;
        throw error;
      }
      return;
    }
    this.dashboardRequestRender();
  }

  private refreshDashboard(): void {
    if (!this.active || !this.store || !this.repository || !this.currentCtx) return;
    try {
      const snapshot = this.store.snapshot(this.repository.canonicalRoot, { recent: 20 });
      for (const worker of snapshot.workers) {
        const workerId = String(worker.worker_id);
        const status = String(worker.status);
        if (["complete", "blocked", "failed"].includes(status) && worker.process_state === "owned") {
          this.scheduleRecycle(workerId, `campaign worker reached ${status}`);
        } else if (status === "queued" && worker.process_state === "stopped") {
          this.reconcileQueuedLane(workerId, "durable queued state");
        } else if (worker.process_state === "owned" && this.clients.has(workerId) && !this.livenessChecks.has(workerId)) {
          const client = this.clients.get(workerId)!;
          this.livenessChecks.add(workerId);
          this.controller.tell({
            _tag: "RunTask",
            task: () => this.probeWorkerLiveness(workerId, client),
            onError: (error) => this.failSupervisor(error, this.currentCtx),
          });
        }
      }
      let repo = this.repository;
      try { repo = (this.options.inspectRepo ?? ((cwd: string) => inspectRepository(cwd, this.options.run)))(this.repository.canonicalRoot); } catch {}
      this.updateDashboardWidget({
        snapshot,
        options: {
          now: (this.options.now ?? Date.now)(), canonicalHead: repo.head, canonicalDirty: repo.dirty,
          canonicalChanged: typeof snapshot.fleet?.canonical_head === "string" && snapshot.fleet.canonical_head !== repo.head,
          protocolChanged: Number(snapshot.fleet?.protocol_version) !== AUTORESEARCH_PROTOCOL_VERSION,
        },
      });
    } catch (error) {
      this.failSupervisor(error, this.currentCtx);
    }
  }

  private async probeWorkerLiveness(workerId: string, client: RpcWorkerClient): Promise<void> {
    try {
      if (!this.active || this.shuttingDown || this.clients.get(workerId) !== client) return;
      await this.rpc(workerId, "liveness probe", () => client.getState());
    } catch (error) {
      if (!this.active || this.shuttingDown || this.clients.get(workerId) !== client || !this.store || !this.repository) return;
      const current = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
      if (current && typeof current.session_id === "string" && this.generation) {
        this.releaseInitialIntent(this.operation, this.generation, workerId, current.session_id, "failed");
      }
      await this.stopWorker(workerId, "failed");
      const worker = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
      if (worker?.process_state === "stopped") {
        this.scheduleRecycle(workerId, `worker process failed its liveness probe: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.livenessChecks.delete(workerId);
    }
  }

  private queueOperationalIncident(workerId: string, reason: string): void {
    if (this.shuttingDown || !this.store || !this.repository || !this.generation) return;
    const worker = this.store.snapshot(this.repository.canonicalRoot, { workerId, recent: 1 }).workers[0];
    const key = `${this.generation}:${workerId}:${String(worker?.session_id ?? "unknown")}:${reason}`;
    if (this.incidentKeys.has(key)) return;
    this.incidentKeys.add(key);
    this.pendingIncidents.set(key, `- ${workerId}: ${reason}; status=${String(worker?.status ?? "unknown")}; process=${String(worker?.process_state ?? "unknown")}; error=${String(worker?.error ?? "-")}`);
    if (this.incidentTimer !== undefined) return;
    this.incidentTimer = setTimeout(() => {
      this.incidentTimer = undefined;
      const incidents = [...this.pendingIncidents.values()];
      this.pendingIncidents.clear();
      if (incidents.length === 0) return;
      try {
        this.pi.sendUserMessage([
          "[autoresearch operational incident; action required]",
          ...incidents,
          "Inspect the affected workers and repair or safely control them. Do not merely acknowledge this incident or interpret it only as research evidence.",
        ].join("\n"), { deliverAs: "followUp" });
      } catch (error) {
        this.currentCtx?.ui.notify(`Could not queue autoresearch operational incident: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }, INCIDENT_COALESCE_MS);
  }

  private setToolsActive(enabled: boolean): void {
    const current = this.pi.getActiveTools().filter((name) => !AUTORESEARCH_PARENT_TOOLS.includes(name as typeof AUTORESEARCH_PARENT_TOOLS[number]));
    this.pi.setActiveTools(enabled ? [...new Set([...current, ...AUTORESEARCH_PARENT_TOOLS])] : current);
  }

  private failSupervisor(error: unknown, ctx = this.currentCtx): void {
    if (this.shuttingDown) return;
    const message = error instanceof Error ? error.message : String(error);
    this.cancelInitialIntentBarrier(`Autoresearch supervisor failed: ${message}`);
    if (this.ownership === "observer") {
      ctx?.ui.notify(`Autoresearch observer failure: ${message}`, "error");
      return;
    }
    this.launching = false;
    if (!(error instanceof FleetAlreadyActiveError)) {
      ++this.operation;
      this.active = false;
      this.launching = true;
      const failedStore = this.store;
      if (this.store && this.repository && this.generation) this.store.setFleetStatus(this.repository.canonicalRoot, "failed", (this.options.now ?? Date.now)(), this.generation);
      this.stopDashboard();
      this.setToolsActive(false);
      this.forkTask(async () => {
        const results = await Promise.allSettled([...this.lanes.keys()].map((id) => this.stopWorker(id, "failed")));
        this.controller.tell({ _tag: "FailureStopCompleted", store: failedStore, unresolved: results.filter((result) => result.status === "rejected").length });
      }, () => {});
    }
    ctx?.ui.notify(`Autoresearch supervisor failure: ${message}`, "error");
  }

  shutdown(ctx: ExtensionContext): Promise<void> {
    return this.controller.request<void>((reply) => ({ _tag: "SessionShutdown", ctx, reply }));
  }

  private async shutdownImpl(ctx: ExtensionContext): Promise<void> {
    if (this.shuttingDown) return;
    if (this.incidentTimer !== undefined) clearTimeout(this.incidentTimer);
    this.incidentTimer = undefined;
    this.pendingIncidents.clear();
    this.shuttingDown = true;
    if (this.ownership === "observer") {
      this.active = false;
      this.launching = false;
      this.stopDashboard();
      this.setToolsActive(false);
      this.closeFleetResources();
      this.currentCtx = undefined;
      ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, undefined);
      return;
    }
    const wasEnabled = this.launching || this.active;
    const exhausted = this.store && this.repository
      ? String(this.store.snapshot(this.repository.canonicalRoot, { recent: 1 }).fleet?.status) === "exhausted"
      : false;
    ++this.operation;
    this.cancelInitialIntentBarrier("Autoresearch supervisor shutdown was requested");
    for (const workerId of this.lanes.keys()) this.bumpWorkerOperation(workerId);
    this.launching = false;
    this.active = false;
    this.stopDashboard();
    this.setToolsActive(false);
    const results = await Promise.allSettled([...this.lanes.keys()].map((id) => this.stopWorker(id, "paused")));
    const allStopped = results.every((result) => result.status === "fulfilled");
    if (this.store && this.repository && this.generation) {
      this.store.setFleetStatus(this.repository.canonicalRoot, exhausted ? "exhausted" : wasEnabled ? "paused" : allStopped ? "stopped" : "off", (this.options.now ?? Date.now)(), this.generation);
    }
    if (allStopped) this.closeFleetResources();
    else this.store?.close();
    this.currentCtx = undefined;
    ctx.ui.setWidget(AUTORESEARCH_FLEET_WIDGET_ID, undefined);
  }
}

export function registerAutoresearchSupervisor(pi: ExtensionAPI, options?: SupervisorOptions): FleetCommandHandler;
export function registerAutoresearchSupervisor(
  pi: ExtensionAPI,
  runtime: AutoresearchManagedRuntime,
  options?: SupervisorOptions,
): FleetCommandHandler;
export function registerAutoresearchSupervisor(
  pi: ExtensionAPI,
  runtimeOrOptions: AutoresearchManagedRuntime | SupervisorOptions = {},
  providedOptions: SupervisorOptions = {},
): FleetCommandHandler {
  const sharedRuntime = typeof (runtimeOrOptions as AutoresearchManagedRuntime).runPromise === "function";
  const options = sharedRuntime ? providedOptions : runtimeOrOptions as SupervisorOptions;
  const runtime = sharedRuntime ? runtimeOrOptions as AutoresearchManagedRuntime : makeAutoresearchRuntime(pi, { now: options.now ?? Date.now });
  const supervisor = new AutoresearchSupervisor(pi, runtime, options);
  if (!sharedRuntime) pi.on("session_shutdown", () => runtime.dispose());
  return supervisor;
}
