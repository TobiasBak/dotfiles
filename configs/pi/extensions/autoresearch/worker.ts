import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AUTORESEARCH_COMPACTION_INSTRUCTIONS } from "./constants.ts";
import { compactWorkerContext } from "./presentation.ts";
import { assertWorkerSessionId, FleetStore, type WorkerIdentity, type WorkerStatus } from "./state.ts";

export const AUTORESEARCH_WORKER_TOOL = "autoresearch_worker_state";
export const AUTORESEARCH_PARENT_TOOLS = ["autoresearch_inspect", "autoresearch_control"] as const;

const TERMINAL_STATUSES = new Set<WorkerStatus>(["paused", "blocked", "decision", "failed", "complete", "stopped"]);
const CONTINUATION = "[autoresearch worker continuation]\nContinue the campaign in program.md. Check shared state, avoid duplicate scopes, checkpoint material progress, and reserve evidence capacity before evidence-stage work.";

export interface WorkerRegistrationOptions {
  env?: NodeJS.ProcessEnv;
  createStore?: (path: string, identity: WorkerIdentity) => FleetStore;
  continuationDelayMs?: number;
  compactionTimeoutMs?: number;
}

export function workerIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): { identity: WorkerIdentity; dbPath: string; stateDir: string } {
  const canonicalRoot = env.AUTORESEARCH_CANONICAL_ROOT;
  const workerId = env.AUTORESEARCH_WORKER_ID;
  const sessionId = env.AUTORESEARCH_SESSION_ID;
  const token = env.AUTORESEARCH_WORKER_TOKEN;
  const stateDir = env.AUTORESEARCH_STATE_DIR;
  const dbPath = env.AUTORESEARCH_FLEET_DB;
  const generation = Number(env.AUTORESEARCH_GENERATION);
  if (!canonicalRoot || !workerId || !sessionId || !token || !stateDir || !dbPath || !Number.isInteger(generation) || generation < 1) {
    throw new Error("Incomplete autoresearch worker identity environment");
  }
  assertWorkerSessionId(sessionId);
  return { identity: { canonicalRoot, workerId, sessionId, generation, token }, dbPath, stateDir };
}

function assistantSnippet(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.slice(0, 500);
}

function lastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages[index];
  }
  return undefined;
}

function toolText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function registerWorkerAutoresearch(pi: ExtensionAPI, options: WorkerRegistrationOptions = {}): void {
  const parsed = workerIdentityFromEnv(options.env);
  const store = (options.createStore ?? ((path, identity) => new FleetStore(path, identity)))(parsed.dbPath, parsed.identity);
  const continuationDelayMs = options.continuationDelayMs ?? 0;
  const compactionTimeoutMs = options.compactionTimeoutMs ?? 180_000;
  let currentCtx: ExtensionContext | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let compactionWatchdog: ReturnType<typeof setTimeout> | undefined;
  let compactionInFlight = false;
  let compactionToken = 0;
  let shuttingDown = false;
  let finalStopReason: string | undefined;

  const clearScheduled = () => {
    if (scheduled) clearTimeout(scheduled);
    scheduled = undefined;
  };

  const clearCompaction = () => {
    compactionToken += 1;
    compactionInFlight = false;
    if (compactionWatchdog) clearTimeout(compactionWatchdog);
    compactionWatchdog = undefined;
  };

  const ownWorker = () => store.snapshot(parsed.identity.canonicalRoot, { workerId: parsed.identity.workerId, recent: 1 }).workers[0];
  const canContinue = () => {
    const status = ownWorker()?.status as WorkerStatus | undefined;
    return status !== undefined && !TERMINAL_STATUSES.has(status);
  };

  const failClosed = (summary: string, error = summary) => {
    if (shuttingDown) return;
    clearScheduled();
    clearCompaction();
    store.workerHeartbeat({ status: "failed", currentTool: null, error, summary });
    store.addEvent("failed", error);
  };

  const isBenignCompactionError = (error: Error) =>
    error.message === "Nothing to compact (session too small)" || error.message === "Already compacted";

  const submitContinuation = (ctx: ExtensionContext) => {
    if (shuttingDown || !ctx.isIdle() || ctx.hasPendingMessages() || !canContinue()) return;
    try {
      const program = readFileSync(join(ctx.cwd, "program.md"), "utf8").trim();
      if (!program) throw new Error("program.md is empty");
      pi.sendUserMessage(`${CONTINUATION}\n\n${program}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failClosed(`Continuation failed: ${message}`, message);
    }
  };

  const compactThenContinue = (ctx: ExtensionContext) => {
    if (compactionInFlight || shuttingDown || !canContinue()) return;
    const token = ++compactionToken;
    let completed = false;
    compactionInFlight = true;
    const finish = (error?: Error) => {
      if (completed || token !== compactionToken) return;
      completed = true;
      compactionInFlight = false;
      if (compactionWatchdog) clearTimeout(compactionWatchdog);
      compactionWatchdog = undefined;
      if (shuttingDown || !canContinue()) return;
      if (error && !isBenignCompactionError(error)) {
        failClosed(`Compaction failed: ${error.message}`, error.message);
        return;
      }
      submitContinuation(ctx);
    };
    compactionWatchdog = setTimeout(
      () => finish(new Error("compaction did not complete in time")),
      compactionTimeoutMs,
    );
    try {
      ctx.compact({
        customInstructions: AUTORESEARCH_COMPACTION_INSTRUCTIONS,
        onComplete: () => finish(),
        onError: (error) => finish(error),
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const scheduleContinuation = (ctx: ExtensionContext) => {
    if (scheduled || compactionInFlight || shuttingDown || !canContinue()) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if (shuttingDown || !ctx.isIdle() || ctx.hasPendingMessages() || !canContinue()) return;
      compactThenContinue(ctx);
    }, continuationDelayMs);
  };

  const statuses = ["launching", "running", "idle", "paused", "blocked", "decision", "failed", "complete", "stopped"] as const;
  pi.registerTool({
    name: AUTORESEARCH_WORKER_TOOL,
    label: "Autoresearch Worker State",
    description: "Read shared fleet state, checkpoint structured campaign progress, and atomically reserve or release scarce evidence-stage capacity.",
    promptSnippet: "Coordinate autoresearch worker state and evidence capacity",
    promptGuidelines: [
      "Use autoresearch_worker_state to checkpoint material progress and claimed scopes.",
      "Use autoresearch_worker_state reserve_evidence before paid, detached, or scarce evidence-stage work, and release it with a receipt when finished.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["snapshot", "checkpoint", "reserve_evidence", "release_evidence"] },
        campaign: { type: "string" },
        hypothesis: { type: "string" },
        stage: { type: "string" },
        status: { type: "string", enum: [...statuses] },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "string" } },
        blockers: { type: "array", items: { type: "string" } },
        nextActions: { type: "array", items: { type: "string" } },
        runIds: { type: "array", items: { type: "string" } },
        claimedScopes: { type: "array", items: { type: "string" } },
        candidateCommit: { type: "string", minLength: 1 },
        championCommit: { type: "string", minLength: 1 },
        continuationCommand: { type: "string", minLength: 1 },
        launchReceipt: { type: "object", minProperties: 1, additionalProperties: true },
        reservationId: { type: "integer", minimum: 1 },
        receipt: { type: "object", minProperties: 1, additionalProperties: true },
        recent: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      if (params.action === "snapshot") {
        return { content: [{ type: "text", text: toolText(store.snapshot(parsed.identity.canonicalRoot, { recent: params.recent })) }], details: {} };
      }
      if (params.action === "checkpoint") {
        const checkpointId = store.checkpoint({
          campaign: params.campaign,
          hypothesis: params.hypothesis,
          stage: params.stage,
          status: params.status,
          summary: params.summary,
          findings: params.findings,
          blockers: params.blockers,
          nextActions: params.nextActions,
          runIds: params.runIds,
          claimedScopes: params.claimedScopes,
          candidateCommit: params.candidateCommit,
          championCommit: params.championCommit,
          continuationCommand: params.continuationCommand,
          launchReceipt: params.launchReceipt,
        });
        return { content: [{ type: "text", text: `Checkpoint ${checkpointId} recorded.` }], details: { checkpointId } };
      }
      if (params.action === "reserve_evidence") {
        if (!params.stage?.trim()) throw new Error("reserve_evidence requires stage");
        const reservation = store.reserveEvidence(params.stage.trim());
        return {
          content: [{ type: "text", text: reservation.requiresReconciliation
            ? `Evidence reservation ${reservation.reservationId} survived an earlier worker generation. Reconcile it and release with a durable receipt; do not relaunch it silently.`
            : reservation.wait
              ? `Evidence capacity full (${reservation.active}/${reservation.max}); wait and do not start evidence work.`
              : `Evidence reservation ${reservation.reservationId} active (${reservation.active}/${reservation.max}).` }],
          details: reservation,
        };
      }
      const released = store.releaseEvidence({ reservationId: params.reservationId, receipt: params.receipt, summary: params.summary });
      return { content: [{ type: "text", text: released.released ? `Evidence reservation ${released.reservationId} released.` : "No matching active evidence reservation." }], details: released };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    const active = pi.getActiveTools().filter((name) => !AUTORESEARCH_PARENT_TOOLS.includes(name as typeof AUTORESEARCH_PARENT_TOOLS[number]));
    pi.setActiveTools([...new Set([...active, AUTORESEARCH_WORKER_TOOL])]);
    store.workerHeartbeat({ status: "idle", currentTool: null, error: null });
    store.addEvent("worker_started", `${parsed.identity.workerId} RPC session ready`);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    currentCtx = ctx;
    if (!canContinue()) {
      ctx.abort();
      return;
    }
    store.workerHeartbeat({ status: "running", currentTool: null });
    return {
      message: {
        customType: "autoresearch-worker-snapshot",
        content: compactWorkerContext(store.snapshot(parsed.identity.canonicalRoot, { recent: 6 }), parsed.identity.workerId),
        display: false,
      },
    };
  });

  pi.on("agent_start", () => {
    finalStopReason = undefined;
    store.workerHeartbeat({ status: "running" });
  });
  pi.on("tool_execution_start", (event) => {
    store.workerHeartbeat({ status: "running", currentTool: event.toolName });
    store.addEvent("tool_start", event.toolName);
  });
  pi.on("tool_execution_end", (event) => {
    store.workerHeartbeat({ currentTool: null, error: event.isError ? `${event.toolName} failed` : null });
    if (event.isError) store.addEvent("tool_failed", event.toolName);
  });
  pi.on("message_end", (event) => {
    const snippet = assistantSnippet(event.message);
    if (snippet) {
      store.workerHeartbeat({ summary: snippet });
      store.addEvent("assistant_final", snippet);
    }
  });
  pi.on("agent_end", (event) => {
    const assistant = lastAssistant(event.messages);
    finalStopReason = assistant?.role === "assistant" ? assistant.stopReason : undefined;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!canContinue()) return;
    if (finalStopReason !== "stop") {
      const reason = finalStopReason === "toolUse"
        ? "terminal toolUse without a final stop response"
        : finalStopReason ?? "no terminal assistant response";
      failClosed(`Worker turn failed closed: ${reason}`, reason);
      return;
    }
    store.workerHeartbeat({ status: "idle", currentTool: null, error: null });
    scheduleContinuation(ctx);
  });
  pi.on("session_shutdown", () => {
    shuttingDown = true;
    clearScheduled();
    clearCompaction();
    try {
      const status = ownWorker()?.status as WorkerStatus | undefined;
      if (status && !TERMINAL_STATUSES.has(status)) store.workerHeartbeat({ status: "paused", currentTool: null });
      store.addEvent("worker_shutdown", `${parsed.identity.workerId} RPC session stopped`);
    } finally {
      store.close();
      currentCtx = undefined;
    }
  });
}
