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
  FORK_CONTEXT_BLOCK_PERCENT,
  SUBTASK_CHILD_ENV,
  SUBTASK_MODELS,
  SUBTASKS_CONTROL_TOOL_DESCRIPTION,
  SUBTASKS_CONTROL_TOOL_NAME,
  SUBTASK_THINKING_LEVELS,
  SUBTASKS_TOOL_DESCRIPTION,
  SUBTASKS_TOOL_NAME,
  SUBTASKS_TOOL_PROMPT_GUIDELINES,
  SUBTASKS_WAIT_TOOL_DESCRIPTION,
  SUBTASKS_WAIT_TOOL_NAME,
  type ObservedChanges,
  type SubtaskModel,
  type SubtaskStatus,
  type SubtaskStatusItem,
  type SubtaskThinkingLevel,
  appendSubtaskChildSystemPrompt,
  buildChildArgs,
  executeBatchMode,
  formatSubtaskGroupResult,
  formatSubtaskStatusLines,
  formatSubtaskWidgetLines,
  getPiInvocation,
  listSelectableTools,
  prepareSubtasksArguments,
  registerMutableWidget,
  runChild,
  shouldBlockForkedSubtasks,
  truncateResult,
} from "./core.ts";
import { createOverflowResultWriter } from "./overflow.ts";
import { getSubtaskRuntimeState } from "./runtime.ts";

const MAX_SUBTASKS = 16;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_ERROR_LINES = 40;
const WIDGET_PREFIX = "subtasks:";
const SUBTASK_RESULT_MESSAGE_TYPE = "subtasks-result";

interface SubtaskRequest {
  task: string;
  model: SubtaskModel;
  thinking: SubtaskThinkingLevel;
  fork?: boolean;
}

interface SubtaskDetails {
  id: string;
  groupId: string;
  task: string;
  model: SubtaskModel;
  thinking: SubtaskThinkingLevel;
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
  overflowPath?: string;
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

function registerSubtaskWidget(
  ctx: ExtensionContext,
  widgetId: string,
  tasks: SubtaskStatusItem[],
): { update(tasks: SubtaskStatusItem[]): void; clear(): void } {
  if (ctx.mode !== "tui") return { update() {}, clear() {} };

  return registerMutableWidget({
    setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
    key: widgetId,
    initialValue: tasks,
    placement: "belowEditor",
    createComponent: (getTasks, theme) => ({
      render(width: number): string[] {
        return formatSubtaskWidgetLines(getTasks(), width).map((widgetLine) => {
          const statusColor =
            widgetLine.status === "completed"
              ? "success"
              : widgetLine.status === "failed" || widgetLine.status === "cancelled"
                ? "error"
                : widgetLine.status === "running"
                  ? "accent"
                  : "muted";
          const line = widgetLine.segments
            .map((segment) => {
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
            })
            .join("");
          return truncateToWidth(line, width);
        });
      },
      invalidate() {},
    }),
  });
}

function clearSubtaskWidget(ctx: ExtensionContext, widgetId: string): void {
  if (ctx.mode === "tui") ctx.ui.setWidget(widgetId, undefined);
}

function validateSubtask(
  request: SubtaskRequest,
  ctx: ExtensionContext,
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

  return resolvedModel.contextWindow;
}

export function createSubtasksExtension(
  dependencies: SubtasksExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
  const runChildProcess = dependencies.runChild ?? runChild;

  return function subtasksExtension(pi: ExtensionAPI): void {
    if (process.env[SUBTASK_CHILD_ENV] === "1") {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: appendSubtaskChildSystemPrompt(event.systemPrompt),
      }));
      return;
    }

    const runtime = getSubtaskRuntimeState();
    let registered = false;
    let shuttingDown = false;
    let inheritedWidgetTimer: NodeJS.Timeout | undefined;
    let inheritedWidget: ReturnType<typeof registerSubtaskWidget> | undefined;
    const activeWidgetIds = new Set<string>();
    const inheritedWidgetId = `${WIDGET_PREFIX}inherited`;

    const stopInheritedWidget = () => {
      if (inheritedWidgetTimer) clearInterval(inheritedWidgetTimer);
      inheritedWidgetTimer = undefined;
      activeWidgetIds.delete(inheritedWidgetId);
      inheritedWidget?.clear();
      inheritedWidget = undefined;
    };

    const startInheritedWidget = (ctx: ExtensionContext) => {
      const inheritedIds = new Set(runtime.listTasks().map((task) => task.id));
      if (inheritedIds.size === 0) return;

      const refresh = () => {
        if (shuttingDown) return;
        const inheritedTasks = runtime.listTasks(inheritedIds);
        if (inheritedTasks.length === 0) {
          stopInheritedWidget();
          return;
        }
        if (inheritedWidget) {
          inheritedWidget.update(inheritedTasks);
        } else {
          activeWidgetIds.add(inheritedWidgetId);
          inheritedWidget = registerSubtaskWidget(ctx, inheritedWidgetId, inheritedTasks);
        }
      };

      refresh();
      inheritedWidgetTimer = setInterval(refresh, 1_000);
      inheritedWidgetTimer.unref();
    };

    const bindRuntimeDelivery = () => {
      runtime.bindDelivery(({ content, details }) => {
        pi.sendMessage(
          {
            customType: SUBTASK_RESULT_MESSAGE_TYPE,
            content,
            display: true,
            details,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      });
    };

    const coordinationTools = [SUBTASKS_CONTROL_TOOL_NAME, SUBTASKS_WAIT_TOOL_NAME];
    const updateCoordinationTools = (forceEnable = false) => {
      const activeToolNames = pi.getActiveTools();
      const shouldEnable =
        forceEnable || runtime.listGroups().length > 0 || runtime.listTasks().length > 0;
      if (shouldEnable) {
        const missingTools = coordinationTools.filter(
          (toolName) => !activeToolNames.includes(toolName),
        );
        if (missingTools.length > 0) pi.setActiveTools([...activeToolNames, ...missingTools]);
        return;
      }

      pi.setActiveTools(activeToolNames.filter((toolName) => !coordinationTools.includes(toolName)));
    };

    pi.on("session_shutdown", async (event, ctx) => {
      shuttingDown = true;
      if (inheritedWidgetTimer) clearInterval(inheritedWidgetTimer);
      inheritedWidgetTimer = undefined;
      for (const widgetId of activeWidgetIds) clearSubtaskWidget(ctx, widgetId);
      activeWidgetIds.clear();
      inheritedWidget = undefined;

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
        fork: Type.Optional(
          Type.Boolean({
            description:
              "Replays the parent conversation through the current user message, excluding the current assistant turn, and may add substantial uncached input cost. Forked requests are blocked when parent context usage is 65% or higher. Omit unless the child cannot complete from the assignment and filesystem alone. Prefer a self-contained task. Default: false.",
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
              "Wait for every task to finish before this tool call returns. Results will be delivered automatically when subtasks finish. Use false only while unrelated work can continue; caller abort detaches without cancelling. Default: true.",
            default: true,
          }),
        ),
      });

      const SubtaskWaitParams = Type.Object({
        groupIds: Type.Array(
          Type.String({
            description: "Subtask group ID returned by subtasks.",
            pattern: "^g-[0-9a-f]{6}$",
          }),
          {
            description: "Groups to wait for. The call returns after every group is terminal.",
            minItems: 1,
            maxItems: MAX_SUBTASKS,
            uniqueItems: true,
          },
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
        name: SUBTASKS_WAIT_TOOL_NAME,
        label: "Wait for Subtasks",
        description: SUBTASKS_WAIT_TOOL_DESCRIPTION,
        promptSnippet: "Block once until every task in the requested subtask groups is terminal",
        parameters: SubtaskWaitParams,

        async execute(_toolCallId, params, signal) {
          const result = await runtime.waitForGroups(params.groupIds, signal);
          const groupStatuses = result.groups
            .map((group) => `${group.id} [${group.status}]`)
            .join(", ");
          if (result.aborted) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Stopped waiting for subtask groups: ${groupStatuses}. The subtasks continue running, and results will be delivered automatically when they finish.`,
                },
              ],
              details: result,
            };
          }

          runtime.forgetGroups(params.groupIds);
          updateCoordinationTools();
          return {
            content: [
              {
                type: "text" as const,
                text: `Subtask groups reached terminal state: ${groupStatuses}. Results were delivered automatically.`,
              },
            ],
            details: result,
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
          const contextUsage = executionCtx.getContextUsage();
          const forkRequested = requests.some((request) => request.fork === true);
          if (shouldBlockForkedSubtasks(forkRequested, contextUsage?.percent)) {
            const percentage = contextUsage!.percent!.toFixed(1);
            const tokenDetails =
              contextUsage!.tokens === null
                ? ""
                : ` (${contextUsage!.tokens.toLocaleString("en-US")}/${contextUsage!.contextWindow.toLocaleString("en-US")} tokens)`;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `The subtask request was not started because it includes \`fork: true\` and parent context usage is ${percentage}%${tokenDetails}, meeting the ${FORK_CONTEXT_BLOCK_PERCENT}% safety limit. Retry with self-contained assignments and omit \`fork\`. If full conversation context is essential, reduce the parent context first.`,
                },
              ],
              details: {
                tasks: [],
                blocked: true,
                reason: "fork-context-limit",
                thresholdPercent: FORK_CONTEXT_BLOCK_PERCENT,
                contextUsage,
              },
            };
          }

          const groupId = runtime.allocateGroupId();
          const tasks: SubtaskState[] = requests.map((request) => ({
            id: runtime.allocateTaskId(),
            groupId,
            task: request.task,
            model: request.model,
            thinking: request.thinking,
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

          updateCoordinationTools(true);

          const runBatch = async (): Promise<SubtaskBatchCompletion> => {
            const widgetId = `${WIDGET_PREFIX}${toolCallId}`;
            const snapshotFiles = new Map<number, string>();
            let durationTimer: NodeJS.Timeout | undefined;
            let widget: ReturnType<typeof registerSubtaskWidget> | undefined;
            const writeOverflowResult = createOverflowResultWriter(
              executionCtx.sessionManager.getSessionId(),
              groupId,
              (temporaryPath) => runtime.retainTemporaryPath(temporaryPath),
            );

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
              widget?.update(tasks);
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
              const childTools = getSelectableToolNames(pi);
              for (let index = 0; index < requests.length; index += 1) {
                tasks[index]!.contextWindow = validateSubtask(requests[index]!, executionCtx);
              }

              activeWidgetIds.add(widgetId);
              widget = registerSubtaskWidget(executionCtx, widgetId, tasks);
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
                      tools: childTools,
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

              const formattedResult = await formatSubtaskGroupResult(
                outcomes.map((outcome, index) => ({
                  id: tasks[index]!.id,
                  status: tasks[index]!.status,
                  output: outcome.output ?? `Error: ${outcome.error ?? "unknown failure"}`,
                  observedChanges: tasks[index]!.observedChanges!,
                })),
                writeOverflowResult,
              );
              const truncatedTaskIds = new Set(formattedResult.truncatedTaskIds);
              for (const task of tasks) {
                task.outputTruncated = truncatedTaskIds.has(task.id);
                task.overflowPath = formattedResult.overflowPaths[task.id];
              }

              return {
                result: {
                  content: [{ type: "text", text: formattedResult.content }],
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
                  widget?.clear();
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
          runtime.trackGroup(
            groupId,
            tasks.map((task) => task.id),
            controller,
            completion,
          );

          const deliverSteerResult = (
            content: string,
            details: Record<string, unknown>,
          ): void => {
            runtime.deliver({ content, details });
          };
          let deliveryStatus: "running" | "completed" | "failed" = "running";

          await executeBatchMode({
            wait: params.wait !== false,
            completion,
            callerSignal: signal,
            detach() {
              detachedFromToolResult = true;
            },
            deliverSuccess({ result, allFailed }) {
              deliveryStatus = allFailed ? "failed" : "completed";
              deliverSteerResult(
                `## Subtask group ${groupId} [${deliveryStatus}]\n\n${result.content[0]?.text ?? ""}`,
                {
                  ...result.details,
                  delivery: "steer",
                  groupId,
                  batchId: toolCallId,
                  status: deliveryStatus,
                },
              );
            },
            deliverFailure(error) {
              deliveryStatus = "failed";
              const boundedError = truncateResult(errorMessage(error), {
                maxBytes: MAX_ERROR_BYTES,
                maxLines: MAX_ERROR_LINES,
              });
              deliverSteerResult(
                `## Subtask group ${groupId} [failed]\n\n${boundedError.content}`,
                {
                  ...copyDetails(tasks),
                  delivery: "steer",
                  groupId,
                  batchId: toolCallId,
                  status: "failed",
                  error: boundedError.content,
                },
              );
            },
          });

          if (!detachedFromToolResult) runtime.forgetGroups([groupId]);
          updateCoordinationTools();

          const taskLabel = `subtask${tasks.length === 1 ? "" : "s"}`;
          const taskIds = tasks.map((task) => task.id).join(", ");
          const completionTiming =
            tasks.length === 1 ? "the subtask finishes" : "all subtasks finish";
          const message =
            deliveryStatus === "running"
              ? `Started subtask group ${groupId} with ${tasks.length} independent ${taskLabel}: ${taskIds}. Use subtasks_wait for group ${groupId} when independent work is exhausted. Results will be delivered automatically when ${completionTiming}.`
              : `Finished subtask group ${groupId} with ${tasks.length} independent ${taskLabel}: ${taskIds}. Results were delivered automatically.`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: {
              ...copyDetails(tasks),
              delivery: "steer",
              groupId,
              batchId: toolCallId,
              status: deliveryStatus,
            },
          };
        },
      });

      updateCoordinationTools();
      registered = true;
      finishSessionStart();
    });
  };
}

export default createSubtasksExtension();
