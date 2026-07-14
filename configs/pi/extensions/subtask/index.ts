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
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
  SUBTASK_CHILD_ENV,
  SUBTASK_MODELS,
  SUBTASKS_CONTROL_TOOL_DESCRIPTION,
  SUBTASKS_CONTROL_TOOL_NAME,
  SUBTASK_THINKING_LEVELS,
  SUBTASKS_TOOL_DESCRIPTION,
  SUBTASKS_TOOL_NAME,
  SUBTASKS_TOOL_PROMPT_GUIDELINES,
  type ObservedChanges,
  type SubtaskModel,
  type SubtaskStatus,
  type SubtaskStatusItem,
  type SubtaskThinkingLevel,
  buildChildArgs,
  combineChildOutputWithObservedChanges,
  executeBatchMode,
  formatSubtaskStatusLines,
  formatSubtaskStatusRows,
  getPiInvocation,
  listSelectableTools,
  prepareSubtasksArguments,
  runChild,
  truncateResult,
} from "./core.ts";
import { getSubtaskRuntimeState } from "./runtime.ts";

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
  id: string;
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
  observedChanges?: ObservedChanges;
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
        observedChanges: task.observedChanges
          ? {
              files: task.observedChanges.files.map((file) => ({
                ...file,
                edit: file.edit ? { ...file.edit } : undefined,
                write: file.write ? { ...file.write } : undefined,
                snippets: file.snippets.map((snippet) => ({ ...snippet })),
              })),
              omittedOperations: task.observedChanges.omittedOperations,
            }
          : undefined,
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

function setSubtaskWidget(ctx: ExtensionContext, widgetId: string, tasks: SubtaskStatusItem[]): void {
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
          let line = theme.fg("borderMuted", `${row.connector} [${row.id}] `);
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

    const runtime = getSubtaskRuntimeState();
    let registered = false;
    let shuttingDown = false;
    let inheritedWidgetTimer: NodeJS.Timeout | undefined;
    const activeWidgetIds = new Set<string>();
    const inheritedWidgetId = `${WIDGET_PREFIX}inherited`;

    const stopInheritedWidget = (ctx: ExtensionContext) => {
      if (inheritedWidgetTimer) clearInterval(inheritedWidgetTimer);
      inheritedWidgetTimer = undefined;
      activeWidgetIds.delete(inheritedWidgetId);
      clearSubtaskWidget(ctx, inheritedWidgetId);
    };

    const startInheritedWidget = (ctx: ExtensionContext) => {
      const inheritedIds = new Set(runtime.listTasks().map((task) => task.id));
      if (inheritedIds.size === 0) return;

      const refresh = () => {
        if (shuttingDown) return;
        const inheritedTasks = runtime.listTasks(inheritedIds);
        if (inheritedTasks.length === 0) {
          stopInheritedWidget(ctx);
          return;
        }
        activeWidgetIds.add(inheritedWidgetId);
        setSubtaskWidget(ctx, inheritedWidgetId, inheritedTasks);
      };

      refresh();
      inheritedWidgetTimer = setInterval(refresh, 1_000);
      inheritedWidgetTimer.unref();
    };

    const bindRuntimeDelivery = () => {
      runtime.bindDelivery(({ content, details }) => {
        pi.sendMessage(
          {
            customType: BACKGROUND_MESSAGE_TYPE,
            content,
            display: true,
            details,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      });
    };

    pi.on("session_shutdown", async (event, ctx) => {
      shuttingDown = true;
      if (inheritedWidgetTimer) clearInterval(inheritedWidgetTimer);
      inheritedWidgetTimer = undefined;
      for (const widgetId of activeWidgetIds) clearSubtaskWidget(ctx, widgetId);
      activeWidgetIds.clear();

      if (event.reason === "reload") {
        runtime.suspendForReload();
        return;
      }
      await runtime.stopAndCancel();
    });

    pi.on("session_start", (event, ctx) => {
      shuttingDown = false;
      const finishSessionStart = () => {
        if (event.reason === "reload") startInheritedWidget(ctx);
        bindRuntimeDelivery();
      };
      if (registered) {
        finishSessionStart();
        return;
      }

      const selectableTools = getSelectableToolNames(pi);
      if (selectableTools.length === 0) {
        finishSessionStart();
        return;
      }

      const SubtaskItemParams = Type.Object({
        task: Type.String({
          description: "Child assignment.",
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
              "Replays the full parent conversation and may add substantial uncached input cost. Omit unless the child cannot complete from the assignment and filesystem alone. Prefer a self-contained task. Default: false.",
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
              "Wait when results are needed next. Use false only while unrelated work can continue; results then arrive through the steer queue. Caller abort detaches without cancelling. Default: true.",
            default: true,
          }),
        ),
      });

      const SubtaskControlParams = Type.Union([
        Type.Object({ action: Type.Literal("list") }),
        Type.Object({
          action: Type.Literal("cancel"),
          ids: Type.Array(
            Type.String({
              description: "Six-character subtask ID returned by subtasks.",
              pattern: "^[0-9a-f]{6}$",
            }),
            { minItems: 1, uniqueItems: true },
          ),
        }),
      ]);

      pi.registerTool({
        name: SUBTASKS_CONTROL_TOOL_NAME,
        label: "Subtask Control",
        description: SUBTASKS_CONTROL_TOOL_DESCRIPTION,
        parameters: SubtaskControlParams,

        async execute(_toolCallId, params) {
          if (params.action === "list") {
            const running = runtime.listTasks();
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    running.length === 0
                      ? "No subtasks are running."
                      : `Running subtasks:\n${formatSubtaskStatusLines(running).join("\n")}`,
                },
              ],
              details: { tasks: running },
            };
          }

          const cancellation = await runtime.cancelTasks(params.ids);
          const messages = [
            cancellation.cancelled.length > 0
              ? `Cancelled: ${cancellation.cancelled.join(", ")}`
              : "No matching running subtasks were cancelled.",
          ];
          if (cancellation.notRunning.length > 0) {
            messages.push(`Not running: ${cancellation.notRunning.join(", ")}`);
          }
          return {
            content: [{ type: "text" as const, text: messages.join("\n") }],
            details: { ...cancellation, tasks: runtime.listTasks() },
          };
        },
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
            id: runtime.allocateTaskId(),
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
            observedChanges: { files: [], omittedOperations: 0 },
          }));
          let detachedFromToolResult = false;
          const controller = new AbortController();
          const taskControllers = tasks.map(() => new AbortController());
          controller.signal.addEventListener(
            "abort",
            () => {
              for (const taskController of taskControllers) taskController.abort();
            },
            { once: true },
          );

          const activeToolNames = pi.getActiveTools();
          if (!activeToolNames.includes(SUBTASKS_CONTROL_TOOL_NAME)) {
            pi.setActiveTools([...activeToolNames, SUBTASKS_CONTROL_TOOL_NAME]);
          }

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

              const taskCompletions = requests.map((request, index) => {
                const details = tasks[index]!;
                const taskController = taskControllers[index]!;
                const completion = (async (): Promise<SubtaskOutcome> => {
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
                      signal: taskController.signal,
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
                    details.observedChanges = result.observedChanges;

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
                    details.status =
                      taskController.signal.aborted || controller.signal.aborted ? "cancelled" : "failed";
                    publish();
                    return { error: boundedError.content };
                  }
                })();

                runtime.trackTask(details.id, taskController, completion, () => {
                  refreshElapsed();
                  return { ...details };
                });
                return completion;
              });
              const outcomes = await Promise.all(taskCompletions);

              if (controller.signal.aborted) throw new Error("Subtasks were cancelled");

              const allFailed = tasks.every((task) => task.status !== "completed");

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
                  const response = outcome.output ?? `Error: ${outcome.error ?? "unknown failure"}`;
                  const bounded = combineChildOutputWithObservedChanges(
                    response,
                    tasks[index]!.observedChanges!,
                    { maxBytes: perTaskBytes, maxLines: perTaskLines },
                  );
                  tasks[index]!.outputTruncated = bounded.truncated;
                  return `## Subtask ${tasks[index]!.id} [${status}]\n${bounded.content}`;
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
          runtime.trackBatch(controller, completion);

          const deliverBackgroundResult = (
            content: string,
            details: Record<string, unknown>,
          ): void => {
            runtime.deliver({ content, details });
          };

          const acknowledgement = {
            content: [
              {
                type: "text" as const,
                text: `Started ${tasks.length} independent subtask${tasks.length === 1 ? "" : "s"}: ${tasks.map((task) => task.id).join(", ")}. Completion will be delivered through the steer queue.`,
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

      if (runtime.listTasks().length > 0) {
        const activeToolNames = pi.getActiveTools();
        if (!activeToolNames.includes(SUBTASKS_CONTROL_TOOL_NAME)) {
          pi.setActiveTools([...activeToolNames, SUBTASKS_CONTROL_TOOL_NAME]);
        }
      } else {
        pi.setActiveTools(
          pi.getActiveTools().filter((toolName) => toolName !== SUBTASKS_CONTROL_TOOL_NAME),
        );
      }
      registered = true;
      finishSessionStart();
    });
  };
}

export default createSubtasksExtension();
