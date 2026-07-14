import * as fs from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  ActiveBatchRegistry,
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
  SUBTASK_CHILD_ENV,
  SUBTASK_MODELS,
  SUBTASK_THINKING_LEVELS,
  SUBTASKS_TOOL_DESCRIPTION,
  SUBTASKS_TOOL_NAME,
  SUBTASKS_TOOL_PROMPT_GUIDELINES,
  type SubtaskModel,
  type SubtaskStatus,
  type SubtaskThinkingLevel,
  buildChildArgs,
  executeBatchMode,
  formatSubtaskStatusRows,
  getPiInvocation,
  listSelectableTools,
  prepareSubtasksArguments,
  runChild,
  truncateResult,
} from "./core.ts";

const MAX_SUBTASKS = 16;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_ERROR_LINES = 40;
const WIDGET_PREFIX = "subtasks:";
const BACKGROUND_MESSAGE_TYPE = "subtasks-background-result";

interface SubtaskRequest {
  task: string;
  model: SubtaskModel;
  thinking: SubtaskThinkingLevel;
  tools: string[];
  fork?: boolean;
}

interface SubtaskDetails {
  task: string;
  model: SubtaskModel;
  thinking: SubtaskThinkingLevel;
  tools: string[];
  forked: boolean;
  status: SubtaskStatus;
  elapsedMs: number;
  contextTokens: number;
  contextWindow: number;
  cost: number;
  toolCalls: number;
  progress?: string;
  exitCode?: number;
  stopReason?: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  outputTruncated?: boolean;
}

interface SubtaskState extends SubtaskDetails {
  startedAt?: number;
}

interface SubtaskBatchDetails {
  tasks: SubtaskDetails[];
}

interface SubtaskOutcome {
  output?: string;
  error?: string;
}

interface SubtaskToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubtaskBatchDetails;
}

interface SubtaskBatchCompletion {
  result: SubtaskToolResult;
  allFailed: boolean;
}

export interface SubtasksExtensionDependencies {
  runChild?: typeof runChild;
}

function createForkSnapshot(ctx: ExtensionContext): string {
  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    throw new Error("fork=true requires a persisted parent session");
  }

  const currentLeaf = ctx.sessionManager.getLeafEntry();
  if (
    !currentLeaf ||
    currentLeaf.type !== "message" ||
    currentLeaf.message.role !== "assistant" ||
    !currentLeaf.parentId
  ) {
    throw new Error("Could not identify a safe parent turn for the forked subtasks");
  }

  const snapshotManager = SessionManager.open(parentSessionFile);
  let snapshotFile: string | undefined;
  try {
    snapshotFile = snapshotManager.createBranchedSession(currentLeaf.parentId);
    if (!snapshotFile) throw new Error("Could not create a temporary fork snapshot");

    // Pi defers writing a branch that has no assistant message. A first-turn
    // fork still needs the current user message, so materialize the snapshot.
    const snapshotHeader = snapshotManager.getHeader();
    if (!snapshotHeader) throw new Error("Temporary fork snapshot has no session header");
    const records = [snapshotHeader, ...snapshotManager.getEntries()];
    fs.writeFileSync(snapshotFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return snapshotFile;
  } catch (error) {
    if (snapshotFile) {
      try {
        fs.unlinkSync(snapshotFile);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AggregateError([error, cleanupError], "Could not create or clean up fork snapshot");
        }
      }
    }
    throw error;
  }
}

function copyDetails(tasks: SubtaskState[]): SubtaskBatchDetails {
  return {
    tasks: tasks.map((task) => {
      const details: Partial<SubtaskState> = {
        ...task,
        tools: [...task.tools],
        usage: task.usage ? { ...task.usage } : undefined,
      };
      delete details.startedAt;
      return details as SubtaskDetails;
    }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSelectableToolNames(pi: ExtensionAPI): string[] {
  const activeTools = new Set(pi.getActiveTools());
  return listSelectableTools(
    pi
      .getAllTools()
      .filter((tool) => {
        if (!activeTools.has(tool.name)) return false;
        if (tool.sourceInfo.source === "sdk") return false;
        return tool.sourceInfo.source === "builtin" || tool.sourceInfo.scope !== "temporary";
      })
      .map((tool) => tool.name),
  );
}

function setSubtaskWidget(ctx: ExtensionContext, widgetId: string, tasks: SubtaskState[]): void {
  if (ctx.mode !== "tui") return;

  const rows = formatSubtaskStatusRows(tasks);
  ctx.ui.setWidget(
    widgetId,
    (_tui, theme) => ({
      render(width: number): string[] {
        return rows.map((row) => {
          const color =
            row.status === "completed"
              ? "success"
              : row.status === "failed" || row.status === "cancelled"
                ? "error"
                : row.status === "running"
                  ? "accent"
                  : "muted";
          const status = `${row.marker} ${row.label.padEnd(9)} ${row.duration}`;
          let line = theme.fg("borderMuted", `${row.connector} `);
          line += theme.fg(color, theme.bold(status));
          if (row.metadata.length > 0) {
            line += theme.fg("dim", `  ${row.metadata.join("  ·  ")}`);
          }
          line += theme.fg("borderMuted", "  │  ");
          line += theme.fg("text", row.summary);
          return truncateToWidth(line, width);
        });
      },
      invalidate() {},
    }),
    { placement: "belowEditor" },
  );
}

function clearSubtaskWidget(ctx: ExtensionContext, widgetId: string): void {
  if (ctx.mode === "tui") ctx.ui.setWidget(widgetId, undefined);
}

function validateSubtask(
  request: SubtaskRequest,
  ctx: ExtensionContext,
  currentTools: ReadonlySet<string>,
): number {
  const separator = request.model.indexOf("/");
  const provider = request.model.slice(0, separator);
  const modelId = request.model.slice(separator + 1);
  const resolvedModel = ctx.modelRegistry.find(provider, modelId);
  if (!resolvedModel || !ctx.modelRegistry.hasConfiguredAuth(resolvedModel)) {
    throw new Error(`Subtask model is unavailable or unauthenticated: ${request.model}`);
  }
  if (!getSupportedThinkingLevels(resolvedModel).includes(request.thinking)) {
    throw new Error(`${request.model} does not support thinking level ${request.thinking}`);
  }

  const unavailableTools = request.tools.filter((tool) => !currentTools.has(tool));
  if (unavailableTools.length > 0) {
    throw new Error(`Unavailable subtask tools: ${unavailableTools.join(", ")}`);
  }

  return resolvedModel.contextWindow;
}

export function createSubtasksExtension(
  dependencies: SubtasksExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
  const runChildProcess = dependencies.runChild ?? runChild;

  return function subtasksExtension(pi: ExtensionAPI): void {
    if (process.env[SUBTASK_CHILD_ENV] === "1") return;

    let registered = false;
    let shuttingDown = false;
    const activeWidgetIds = new Set<string>();
    const activeBatches = new ActiveBatchRegistry();

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      for (const widgetId of activeWidgetIds) clearSubtaskWidget(ctx, widgetId);
      activeWidgetIds.clear();
      await activeBatches.cancelAndWait();
    });

    pi.on("session_start", () => {
      shuttingDown = false;
      if (registered) return;

      const selectableTools = getSelectableToolNames(pi);
      if (selectableTools.length === 0) return;

      const SubtaskItemParams = Type.Object({
        task: Type.String({
          description: "Assignment passed to the child Pi process.",
          minLength: 1,
        }),
        model: StringEnum(SUBTASK_MODELS, {
          description: "Model used by the child Pi process.",
        }),
        thinking: StringEnum(SUBTASK_THINKING_LEVELS, {
          description: "Thinking level used by the child Pi process.",
        }),
        tools: Type.Array(StringEnum(selectableTools, { description: "Tool available to this child" }), {
          description: "Exact tool allowlist passed to the child; an empty array disables tools.",
          uniqueItems: true,
        }),
        fork: Type.Optional(
          Type.Boolean({
            description:
              "Initialize the child from the parent conversation before this tool-call turn. Use true when prior user clarifications, negotiated scope, approval boundaries, or conversational design decisions materially affect correctness; use false for self-contained work. Default: false.",
            default: false,
          }),
        ),
      });

      const SubtaskParams = Type.Object({
        tasks: Type.Array(SubtaskItemParams, {
          description: "Subtasks started in parallel in separate child Pi processes.",
          minItems: 1,
          maxItems: MAX_SUBTASKS,
        }),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "Whether the caller waits for completion. Use true when results are required for the next correct decision; use false only when useful unrelated progress can continue without them. false returns immediately and completion is delivered through Pi's steer queue. Aborting a waiting caller detaches it without cancelling the batch. Default: true.",
            default: true,
          }),
        ),
      });

      pi.registerTool({
        name: SUBTASKS_TOOL_NAME,
        label: "Subtasks",
        description: SUBTASKS_TOOL_DESCRIPTION,
        promptSnippet: "Run focused subtasks in independent Pi processes, optionally without waiting",
        promptGuidelines: SUBTASKS_TOOL_PROMPT_GUIDELINES,
        executionMode: "parallel",
        parameters: SubtaskParams,
        prepareArguments: prepareSubtasksArguments,

        async execute(toolCallId, params, signal, onUpdate, executionCtx) {
          const requests = params.tasks as SubtaskRequest[];
          const tasks: SubtaskState[] = requests.map((request) => ({
            task: request.task,
            model: request.model,
            thinking: request.thinking,
            tools: [...request.tools],
            forked: request.fork ?? false,
            status: "queued",
            elapsedMs: 0,
            contextTokens: 0,
            contextWindow: 0,
            cost: 0,
            toolCalls: 0,
          }));
          let detachedFromToolResult = false;
          const controller = new AbortController();

          const runBatch = async (): Promise<SubtaskBatchCompletion> => {
            const widgetId = `${WIDGET_PREFIX}${toolCallId}`;
            const snapshotFiles = new Map<number, string>();
            let durationTimer: NodeJS.Timeout | undefined;

            const refreshElapsed = () => {
              const now = Date.now();
              for (const task of tasks) {
                if (task.status === "running" && task.startedAt !== undefined) {
                  task.elapsedMs = now - task.startedAt;
                }
              }
            };

            const refreshWidget = () => {
              if (shuttingDown) return;
              refreshElapsed();
              setSubtaskWidget(executionCtx, widgetId, tasks);
            };

            const publish = () => {
              if (shuttingDown) return;
              refreshWidget();
              const completed = tasks.filter((task) => task.status === "completed").length;
              const failed = tasks.filter(
                (task) => task.status === "failed" || task.status === "cancelled",
              ).length;
              const running = tasks.filter((task) => task.status === "running").length;
              if (!detachedFromToolResult) {
                onUpdate?.({
                  content: [
                    {
                      type: "text",
                      text: `${completed}/${tasks.length} completed, ${running} running, ${failed} failed`,
                    },
                  ],
                  details: copyDetails(tasks),
                });
              }
            };

            try {
              const currentTools = new Set(getSelectableToolNames(pi));
              for (let index = 0; index < requests.length; index += 1) {
                tasks[index]!.contextWindow = validateSubtask(requests[index]!, executionCtx, currentTools);
              }

              activeWidgetIds.add(widgetId);
              publish();
              durationTimer = setInterval(refreshWidget, 1_000);
              durationTimer.unref();

              for (let index = 0; index < requests.length; index += 1) {
                if (requests[index]?.fork) snapshotFiles.set(index, createForkSnapshot(executionCtx));
              }

              const outcomes = await Promise.all(
                requests.map(async (request, index): Promise<SubtaskOutcome> => {
                  const details = tasks[index]!;
                  details.status = "running";
                  details.startedAt = Date.now();
                  publish();

                  try {
                    const args = buildChildArgs({
                      task: request.task,
                      model: request.model,
                      thinking: request.thinking,
                      tools: request.tools,
                      sessionFile: snapshotFiles.get(index),
                    });
                    const result = await runChildProcess({
                      invocation: getPiInvocation(args),
                      cwd: executionCtx.cwd,
                      signal: controller.signal,
                      onProgress(progress) {
                        details.progress = progress.message;
                        details.contextTokens = progress.contextTokens;
                        details.cost = progress.cost;
                        details.toolCalls = progress.toolCalls;
                        publish();
                      },
                    });

                    details.exitCode = result.exitCode;
                    details.stopReason = result.stopReason;
                    details.usage = result.usage;
                    details.contextTokens = result.usage.contextTokens;
                    details.cost = result.usage.cost;

                    const failed =
                      result.exitCode !== 0 ||
                      result.stopReason === "error" ||
                      result.stopReason === "aborted";
                    if (failed) {
                      const reason =
                        result.errorMessage || result.stderr.trim() || result.output || "unknown child failure";
                      throw new Error(reason);
                    }

                    details.progress = undefined;
                    refreshElapsed();
                    details.status = "completed";
                    publish();
                    return { output: result.output || "(subtask completed without text output)" };
                  } catch (error) {
                    const boundedError = truncateResult(errorMessage(error), {
                      maxBytes: MAX_ERROR_BYTES,
                      maxLines: MAX_ERROR_LINES,
                    });
                    details.progress = undefined;
                    details.error = boundedError.content;
                    refreshElapsed();
                    details.status = controller.signal.aborted ? "cancelled" : "failed";
                    publish();
                    return { error: boundedError.content };
                  }
                }),
              );

              if (controller.signal.aborted) throw new Error("Subtasks were cancelled");

              const failedCount = tasks.filter((task) => task.status === "failed").length;
              const allFailed = failedCount === tasks.length;

              const perTaskBytes = Math.max(
                512,
                Math.floor((MAX_RESULT_BYTES - requests.length * 128) / requests.length),
              );
              const perTaskLines = Math.max(
                5,
                Math.floor((MAX_RESULT_LINES - requests.length * 3) / requests.length),
              );
              const combined = outcomes
                .map((outcome, index) => {
                  const status = tasks[index]!.status;
                  const body = outcome.output ?? `Error: ${outcome.error ?? "unknown failure"}`;
                  const bounded = truncateResult(body, {
                    maxBytes: perTaskBytes,
                    maxLines: perTaskLines,
                  });
                  tasks[index]!.outputTruncated = bounded.truncated;
                  return `## Subtask ${index + 1} [${status}]\n${bounded.content}`;
                })
                .join("\n\n");
              const finalResult = truncateResult(combined);

              return {
                result: {
                  content: [{ type: "text", text: finalResult.content }],
                  details: copyDetails(tasks),
                },
                allFailed,
              };
            } finally {
              if (durationTimer) clearInterval(durationTimer);

              const cleanupErrors: unknown[] = [];
              for (const snapshotFile of snapshotFiles.values()) {
                try {
                  await fs.promises.unlink(snapshotFile);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(error);
                }
              }

              activeWidgetIds.delete(widgetId);
              if (!shuttingDown) {
                try {
                  clearSubtaskWidget(executionCtx, widgetId);
                } catch (error) {
                  cleanupErrors.push(error);
                }
              }

              if (cleanupErrors.length > 0) {
                throw new AggregateError(cleanupErrors, "Could not clean up subtask resources");
              }
            }
          };

          const completion = runBatch();
          activeBatches.track(controller, completion);

          const deliverBackgroundResult = (
            content: string,
            details: Record<string, unknown>,
          ): void => {
            if (shuttingDown) return;
            try {
              pi.sendMessage(
                {
                  customType: BACKGROUND_MESSAGE_TYPE,
                  content,
                  display: true,
                  details,
                },
                { deliverAs: "steer", triggerTurn: true },
              );
            } catch {
              // The runtime can become stale only during session replacement or reload.
            }
          };

          const acknowledgement = {
            content: [
              {
                type: "text" as const,
                text: `Started independent subtasks batch ${toolCallId} with ${tasks.length} task${tasks.length === 1 ? "" : "s"}. Completion will be delivered through the steer queue.`,
              },
            ],
            details: {
              ...copyDetails(tasks),
              background: true,
              batchId: toolCallId,
              status: "running",
            },
          };

          const settledOrAcknowledgement = await executeBatchMode({
            wait: params.wait !== false,
            completion,
            acknowledgement,
            callerSignal: signal,
            detach() {
              detachedFromToolResult = true;
            },
            onBackgroundSuccess({ result, allFailed }) {
              const status = allFailed ? "failed" : "completed";
              deliverBackgroundResult(
                `## Background subtasks ${toolCallId} [${status}]\n\n${result.content[0]?.text ?? ""}`,
                {
                  ...result.details,
                  background: true,
                  batchId: toolCallId,
                  status,
                },
              );
            },
            onBackgroundFailure(error) {
              const boundedError = truncateResult(errorMessage(error), {
                maxBytes: MAX_ERROR_BYTES,
                maxLines: MAX_ERROR_LINES,
              });
              deliverBackgroundResult(
                `## Background subtasks ${toolCallId} [failed]\n\n${boundedError.content}`,
                {
                  ...copyDetails(tasks),
                  background: true,
                  batchId: toolCallId,
                  status: "failed",
                  error: boundedError.content,
                },
              );
            },
          });

          if (settledOrAcknowledgement === acknowledgement) return acknowledgement;
          const settled = settledOrAcknowledgement as SubtaskBatchCompletion;
          if (settled.allFailed) {
            throw new Error(`All subtasks failed:\n${settled.result.content[0]?.text ?? ""}`);
          }
          return settled.result;
        },
      });

      registered = true;
    });
  };
}

export default createSubtasksExtension();
