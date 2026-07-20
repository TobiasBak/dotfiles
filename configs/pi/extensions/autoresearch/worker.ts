import { Deferred, Effect } from "effect";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  forkControllerTask,
  makeAutoresearchRuntime,
  makeSerializedController,
  scopedSleep,
  type AutoresearchManagedRuntime,
  type AutoresearchServices,
  type SerializedController,
} from "./effect-runtime.ts";
import { laneGitState } from "./git.ts";
import { compactWorkerContext, modelVisibleSnapshot } from "./presentation.ts";
import {
  assertWorkerSessionId,
  FleetStore,
  type CampaignOutcome,
  type CheckpointInput,
  type WorkerIdentity,
  type WorkerStatus,
} from "./state.ts";

export const AUTORESEARCH_WORKER_TOOL = "autoresearch_worker_state";
export const AUTORESEARCH_PARENT_TOOLS = ["autoresearch_inspect", "autoresearch_control"] as const;

const TERMINAL_STATUSES = new Set<WorkerStatus>(["paused", "blocked", "failed", "complete", "stopped"]);
const CONTINUATION = [
  "[autoresearch worker continuation]",
  "Continue your complete campaign. Reread program.md and shared state.",
  "Do not stop at a stage boundary, after launching evidence, while waiting, because context is large, or because no prepared task exists.",
  "If you have no active intent, independently choose and publish one. If you have one, carry it to a terminal scientific result.",
].join("\n");

export interface WorkerRegistrationOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly createStore?: (path: string, identity: WorkerIdentity) => FleetStore;
  readonly continuationDelayMs?: number;
  readonly laneState?: (path: string) => { head: string; dirty: boolean };
}

interface WorkerDomainState {
  readonly currentCtx: ExtensionContext | undefined;
  readonly shuttingDown: boolean;
  readonly finalStopReason: string | undefined;
  readonly continuationGeneration: number;
}

interface ToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: Record<string, unknown>;
}

type WorkerEvent =
  | { readonly _tag: "SessionStart"; readonly ctx: ExtensionContext; readonly reply: Deferred.Deferred<void, Error> }
  | { readonly _tag: "BeforeAgentStart"; readonly ctx: ExtensionContext; readonly reply: Deferred.Deferred<BeforeAgentStartEventResult | undefined, Error> }
  | { readonly _tag: "AgentStart" }
  | { readonly _tag: "ToolStart"; readonly toolName: string }
  | { readonly _tag: "ToolEnd"; readonly toolName: string; readonly isError: boolean }
  | { readonly _tag: "MessageEnd"; readonly message: AgentMessage }
  | { readonly _tag: "AgentEnd"; readonly messages: AgentMessage[] }
  | { readonly _tag: "AgentSettled"; readonly ctx: ExtensionContext }
  | { readonly _tag: "Continue"; readonly generation: number; readonly ctx: ExtensionContext }
  | { readonly _tag: "Tool"; readonly params: Record<string, unknown>; readonly reply: Deferred.Deferred<ToolResult, Error> }
  | { readonly _tag: "Shutdown"; readonly reply: Deferred.Deferred<void, Error> };

export function workerIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): { identity: WorkerIdentity; dbPath: string; stateDir: string } {
  const canonicalRoot = env.AUTORESEARCH_CANONICAL_ROOT;
  const workerId = env.AUTORESEARCH_WORKER_ID;
  const sessionId = env.AUTORESEARCH_SESSION_ID;
  const stateDir = env.AUTORESEARCH_STATE_DIR;
  const dbPath = env.AUTORESEARCH_FLEET_DB;
  const generation = Number(env.AUTORESEARCH_GENERATION);
  if (!canonicalRoot || !workerId || !sessionId || !stateDir || !dbPath || !Number.isInteger(generation) || generation < 1) {
    throw new Error("Incomplete autoresearch worker identity environment");
  }
  assertWorkerSessionId(sessionId);
  return { identity: { canonicalRoot, workerId, sessionId, generation }, dbPath, stateDir };
}

function assistantSnippet(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  const text = message.content.filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text).join("\n").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 500) : undefined;
}

function lastAssistant(messages: AgentMessage[]): Extract<AgentMessage, { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function toolText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function succeed<A>(reply: Deferred.Deferred<A, Error>, value: A): Effect.Effect<void> {
  return Deferred.succeed(reply, value).pipe(Effect.asVoid);
}

function fail<A>(reply: Deferred.Deferred<A, Error>, error: unknown): Effect.Effect<void> {
  return Deferred.fail(reply, error instanceof Error ? error : new Error(String(error))).pipe(Effect.asVoid);
}

export function registerWorkerAutoresearch(
  pi: ExtensionAPI,
  options: WorkerRegistrationOptions = {},
  providedRuntime?: AutoresearchManagedRuntime,
): SerializedController<WorkerEvent> {
  const parsed = workerIdentityFromEnv(options.env);
  const store = (options.createStore ?? ((path, identity) => new FleetStore(path, identity)))(parsed.dbPath, parsed.identity);
  const continuationDelayMs = options.continuationDelayMs ?? 0;
  const runtime = providedRuntime ?? makeAutoresearchRuntime(pi, { now: Date.now, continuationDelayMs });
  let state: WorkerDomainState = {
    currentCtx: undefined,
    shuttingDown: false,
    finalStopReason: undefined,
    continuationGeneration: 0,
  };
  let controller: SerializedController<WorkerEvent>;
  const ownWorker = () => store.snapshot(parsed.identity.canonicalRoot, { workerId: parsed.identity.workerId, recent: 1 }).workers[0];
  const stopCurrentTurn = (): void => queueMicrotask(() => state.currentCtx?.abort());
  const canContinue = () => {
    const status = ownWorker()?.status as WorkerStatus | undefined;
    return status !== undefined && !TERMINAL_STATUSES.has(status);
  };
  const failForReplacement = (summary: string, error = summary): void => {
    if (state.shuttingDown) return;
    state = { ...state, continuationGeneration: state.continuationGeneration + 1 };
    store.workerHeartbeat({ status: "failed", currentTool: null, error, summary });
    store.addEvent("worker_failed", error);
  };

  const handleTool = (params: Record<string, unknown>): ToolResult => {
    const action = stringValue(params.action);
    if (action === "snapshot") {
      const snapshot = modelVisibleSnapshot(store.snapshot(parsed.identity.canonicalRoot, { recent: 20 }));
      return { content: [{ type: "text", text: toolText(snapshot) }], details: snapshot as unknown as Record<string, unknown> };
    }
    if (action === "publish_intent") {
      const question = stringValue(params.question)?.trim();
      const experiment = stringValue(params.experiment)?.trim();
      const reason = stringValue(params.reason)?.trim();
      if (!question || !experiment || !reason) throw new Error("publish_intent requires question, experiment, and reason");
      const git = (options.laneState ?? laneGitState)(state.currentCtx?.cwd ?? process.cwd());
      if (git.dirty) throw new Error("publish_intent requires a clean worker worktree");
      const result = store.publishIntent({ question, experiment, reason, baselineHead: git.head });
      return {
        content: [{ type: "text", text: `Research intent ${result.intentId} published as informational, non-exclusive shared state. Continue the full campaign.` }],
        details: result,
      };
    }
    if (action === "checkpoint") {
      const stage = stringValue(params.stage);
      const summary = stringValue(params.summary);
      const findings = stringArray(params.findings);
      const blockers = stringArray(params.blockers);
      const nextActions = stringArray(params.nextActions);
      const runIds = stringArray(params.runIds);
      const candidateCommit = stringValue(params.candidateCommit);
      const championCommit = stringValue(params.championCommit);
      const continuationCommand = stringValue(params.continuationCommand);
      const launchReceipt = recordValue(params.launchReceipt);
      const input: CheckpointInput = {
        ...(stage !== undefined ? { stage } : {}), ...(summary !== undefined ? { summary } : {}),
        ...(findings !== undefined ? { findings } : {}), ...(blockers !== undefined ? { blockers } : {}),
        ...(nextActions !== undefined ? { nextActions } : {}), ...(runIds !== undefined ? { runIds } : {}),
        ...(candidateCommit !== undefined ? { candidateCommit } : {}), ...(championCommit !== undefined ? { championCommit } : {}),
        ...(continuationCommand !== undefined ? { continuationCommand } : {}), ...(launchReceipt !== undefined ? { launchReceipt } : {}),
      };
      const checkpointId = store.checkpoint(input);
      return {
        content: [{ type: "text", text: `Checkpoint ${checkpointId} recorded for observability and crash recovery. Continue this campaign.` }],
        details: { checkpointId },
      };
    }
    if (action === "finish_campaign") {
      const outcome = stringValue(params.outcome) as CampaignOutcome | undefined;
      const summary = stringValue(params.summary)?.trim();
      const findings = stringArray(params.findings);
      const runIds = stringArray(params.runIds);
      if (!outcome || !["accepted", "rejected", "inconclusive", "exhausted", "external-blocked"].includes(outcome) || !summary) {
        throw new Error("finish_campaign requires a terminal outcome and non-empty summary");
      }
      const git = (options.laneState ?? laneGitState)(state.currentCtx?.cwd ?? process.cwd());
      if (git.dirty) throw new Error("finish_campaign requires all durable findings and changes committed to a clean worktree");
      const intent = store.currentIntent(parsed.identity.canonicalRoot, parsed.identity.workerId);
      if (typeof intent?.baseline_head === "string" && intent.baseline_head === git.head) {
        throw new Error("finish_campaign requires a Git commit recording the campaign's durable result");
      }
      const result = store.finishCampaign({
        outcome, summary, terminalHead: git.head,
        ...(findings ? { findings } : {}), ...(runIds ? { runIds } : {}),
      });
      stopCurrentTurn();
      return {
        content: [{ type: "text", text: `Campaign intent ${result.intentId} finished with outcome ${outcome}. This disposable worker will exit.` }],
        details: { ...result, outcome },
      };
    }
    throw new Error("Unknown autoresearch worker action");
  };

  const handle = (event: WorkerEvent): Effect.Effect<void, never, AutoresearchServices> => Effect.gen(function* () {
    try {
      switch (event._tag) {
        case "SessionStart": {
          state = { ...state, currentCtx: event.ctx };
          const active = pi.getActiveTools().filter((name) => !AUTORESEARCH_PARENT_TOOLS.includes(name as typeof AUTORESEARCH_PARENT_TOOLS[number]));
          pi.setActiveTools([...new Set([...active, AUTORESEARCH_WORKER_TOOL])]);
          store.workerHeartbeat({ status: "idle", currentTool: null, error: null });
          store.addEvent("worker_started", `${parsed.identity.workerId} disposable session ready`);
          yield* succeed(event.reply, undefined);
          return;
        }
        case "BeforeAgentStart":
          state = { ...state, currentCtx: event.ctx };
          if (!canContinue()) {
            event.ctx.abort();
            yield* succeed(event.reply, undefined);
          } else {
            store.workerHeartbeat({ status: "running", currentTool: null });
            yield* succeed(event.reply, {
              message: {
                customType: "autoresearch-worker-snapshot",
                content: compactWorkerContext(store.snapshot(parsed.identity.canonicalRoot, { recent: 20 }), parsed.identity.workerId),
                display: false,
              },
            });
          }
          return;
        case "AgentStart":
          if (canContinue()) {
            state = { ...state, finalStopReason: undefined };
            store.workerHeartbeat({ status: "running" });
          }
          return;
        case "ToolStart":
          if (canContinue()) {
            store.recordToolCall();
            store.workerHeartbeat({ status: "running", currentTool: event.toolName });
            store.addEvent("tool_start", event.toolName);
          }
          return;
        case "ToolEnd":
          if (canContinue()) {
            store.workerHeartbeat({ currentTool: null, error: event.isError ? `${event.toolName} failed` : null });
            if (event.isError) store.addEvent("tool_failed", event.toolName);
          }
          return;
        case "MessageEnd":
          if (!canContinue()) return;
          if (event.message.role === "assistant") store.recordTurnUsage({
            ...(event.message.usage?.totalTokens !== undefined ? { contextTokens: event.message.usage.totalTokens } : {}),
            ...(event.message.usage?.cost?.total !== undefined ? { cost: event.message.usage.cost.total } : {}),
          });
          {
            const snippet = assistantSnippet(event.message);
            if (snippet) {
              store.workerHeartbeat({ summary: snippet });
              store.addEvent("assistant_final", snippet);
            }
          }
          return;
        case "AgentEnd":
          state = { ...state, finalStopReason: lastAssistant(event.messages)?.stopReason };
          return;
        case "AgentSettled":
          if (!canContinue()) return;
          if (state.finalStopReason !== "stop") {
            const reason = state.finalStopReason === "toolUse" ? "terminal toolUse without a final response" : state.finalStopReason ?? "no terminal assistant response";
            failForReplacement(`Worker session ended before campaign completion: ${reason}`, reason);
            return;
          }
          store.workerHeartbeat({ status: "idle", currentTool: null, error: null });
          state = { ...state, continuationGeneration: state.continuationGeneration + 1 };
          {
            const generation = state.continuationGeneration;
            yield* forkControllerTask(scopedSleep(continuationDelayMs).pipe(
              Effect.zipRight(controller.offer({ _tag: "Continue", generation, ctx: event.ctx })),
            ));
          }
          return;
        case "Continue":
          if (event.generation !== state.continuationGeneration || state.shuttingDown || !event.ctx.isIdle() || event.ctx.hasPendingMessages() || !canContinue()) return;
          try {
            pi.sendUserMessage(CONTINUATION);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            failForReplacement(`Continuation failed: ${message}`, message);
          }
          return;
        case "Tool":
          yield* succeed(event.reply, handleTool(event.params));
          return;
        case "Shutdown": {
          state = { ...state, shuttingDown: true, continuationGeneration: state.continuationGeneration + 1 };
          const status = ownWorker()?.status as WorkerStatus | undefined;
          try {
            if (status && !TERMINAL_STATUSES.has(status)) store.workerHeartbeat({ status: "paused", currentTool: null });
            store.addEvent("worker_shutdown", `${parsed.identity.workerId} disposable session stopped`);
          } catch {
            // The supervisor may already have closed the fleet generation while terminating this process.
          }
          store.close();
          yield* succeed(event.reply, undefined);
          return;
        }
      }
    } catch (cause) {
      if (event._tag === "Tool") yield* fail(event.reply, cause);
      else if (event._tag === "SessionStart") yield* fail(event.reply, cause);
      else if (event._tag === "BeforeAgentStart") yield* fail(event.reply, cause);
      else if (event._tag === "Shutdown") yield* fail(event.reply, cause);
      else failForReplacement("Worker controller failed before campaign completion", cause instanceof Error ? cause.message : String(cause));
    }
  });

  controller = makeSerializedController(runtime, handle, (message) => {
    if (!state.shuttingDown) failForReplacement("Worker controller defect", message);
  });

  pi.registerTool({
    name: AUTORESEARCH_WORKER_TOOL,
    label: "Autoresearch Worker State",
    description: "Read shared intentions, publish this worker's non-exclusive research intent, checkpoint progress, and finish one complete campaign.",
    promptSnippet: "Announce, execute, and finish one autonomous research campaign",
    promptGuidelines: [
      "Read shared state and durable Git research before selecting work. Publish exactly one informational intent before campaign mutation.",
      "Intents are not claims or permissions. Avoid obvious duplication when useful, but overlap and independent replication are allowed.",
      "A checkpoint is only for observability and crash recovery. It never hands the campaign to another worker and never ends normal work.",
      "Carry the campaign through all required experiments, replication, diagnosis, confirmation, and waiting. Then commit durable findings and call finish_campaign once.",
      "Do not finish because a queue is empty, a stage ended, follow-up is required, evidence is running, or context is large.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["snapshot", "publish_intent", "checkpoint", "finish_campaign"] },
        question: { type: "string", minLength: 1 }, experiment: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 },
        stage: { type: "string" }, summary: { type: "string" },
        outcome: { type: "string", enum: ["accepted", "rejected", "inconclusive", "exhausted", "external-blocked"] },
        findings: { type: "array", items: { type: "string" } }, blockers: { type: "array", items: { type: "string" } },
        nextActions: { type: "array", items: { type: "string" } }, runIds: { type: "array", items: { type: "string" } },
        candidateCommit: { type: "string", minLength: 1 }, championCommit: { type: "string", minLength: 1 },
        continuationCommand: { type: "string", minLength: 1 }, launchReceipt: { type: "object", minProperties: 1, additionalProperties: true },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      return controller.request<ToolResult>((reply) => ({ _tag: "Tool", params: params as unknown as Record<string, unknown>, reply }));
    },
  });

  pi.on("session_start", (_event, ctx) => controller.request<void>((reply) => ({ _tag: "SessionStart", ctx, reply })));
  pi.on("before_agent_start", (_event, ctx) => controller.request<BeforeAgentStartEventResult | undefined>((reply) => ({ _tag: "BeforeAgentStart", ctx, reply })));
  pi.on("agent_start", () => controller.dispatch({ _tag: "AgentStart" }));
  pi.on("tool_execution_start", (event) => controller.dispatch({ _tag: "ToolStart", toolName: event.toolName }));
  pi.on("tool_execution_end", (event) => controller.dispatch({ _tag: "ToolEnd", toolName: event.toolName, isError: event.isError }));
  pi.on("message_end", (event) => controller.dispatch({ _tag: "MessageEnd", message: event.message }));
  pi.on("agent_end", (event) => controller.dispatch({ _tag: "AgentEnd", messages: event.messages }));
  pi.on("agent_settled", (_event, ctx) => controller.dispatch({ _tag: "AgentSettled", ctx }));
  pi.on("session_shutdown", async () => {
    await controller.request<void>((reply) => ({ _tag: "Shutdown", reply }));
    await controller.interrupt();
    if (!providedRuntime) await runtime.dispose();
  });
  return controller;
}
