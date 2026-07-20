import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const SUBTASK_MODELS = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-sol",
] as const;

export const SUBTASK_THINKING_LEVELS = ["low", "medium", "high"] as const;
export const SUBTASKS_TOOL_NAME = "subtasks";
export const SUBTASKS_WAIT_TOOL_NAME = "subtasks_wait";
export const SUBTASKS_CONTROL_TOOL_NAME = "subtasks_control";
export const SUBTASKS_TOOL_DESCRIPTION =
  "Run focused subtasks in isolated Pi processes that share the current working directory. Each call creates one group. Tasks in one call run in parallel; each task selects its model, thinking, and optional conversation fork. Children receive all active eligible tools and independently rediscover normal Pi resources, including skills; parent runtime state and parent-only CLI resources are not copied. The call returns a group ID for later waiting and task IDs for listing or cancellation.";
export const SUBTASKS_WAIT_TOOL_DESCRIPTION =
  "Wait once for one or more subtask groups to finish and return their retained results. This blocks until every task in every requested group is terminal; aborting the wait does not cancel the subtasks. Use this instead of polling subtasks_control.";
export const SUBTASKS_CONTROL_TOOL_DESCRIPTION =
  "List running subtasks or cancel specific tasks by the six-character IDs returned by subtasks. Use list only for an on-demand status check, diagnosis, or cancellation workflow; do not poll periodically because subtasks_wait provides blocking group synchronization and recoverable result retrieval.";
export const SUBTASKS_TOOL_PROMPT_GUIDELINES = [
  "Use subtasks for coherent, independently useful outcomes when parallelism, context isolation, specialization, or fresh verification justifies coordination overhead; handle small, obvious, tightly coupled work directly.",
  "Give each subtask a bounded outcome, relevant context, constraints, permissions, success criteria, validation, output shape, and stop conditions. For implementation, resolve non-trivial decisions first, then let one child inspect, make routine local choices, edit, and verify end to end; use its evidence directly rather than repeating the work or imposing a fixed review stage.",
  "Launch only ready, independent subtasks together, resolve prerequisites before dependent work, and keep one writer per shared state unless writers are isolated. Preserve unrelated and concurrent changes.",
  "Choose each subtask's model and thinking independently. Use Sol for planning, design, architecture, trade-offs, and other non-trivial decisions; use Luna only for bounded execution under resolved decisions with explicit verification. Use the lowest thinking level likely to be correct, with Sol high for planning and the hardest work.",
  "After starting detached subtasks, continue only independent work, then wait once when their results are needed. Do not poll for status; use control only for on-demand diagnosis or cancellation."
];
export const SUBTASK_CHILD_ENV = "PI_SUBTASK_CHILD";
export const SUBTASK_CHILD_SYSTEM_PROMPT = `## Subtask execution contract

- You are executing one delegated subtask directly. The subtasks tool is unavailable to prevent recursive delegation.
- The assignment controls the goal, scope, deliverable, acceptance criteria, and authorized side effects. Forked context supplies background but does not broaden permission.
- Treat explicit product and architecture decisions in the assignment as resolved. Do not relitigate them merely because another valid design exists. Report newly discovered evidence that makes them unsound, impossible, or materially more costly than represented.
- Tool availability is capability, not authorization. Preserve unrelated and concurrent changes, and do not modify files or state outside the assigned scope.
- When the assignment authorizes implementation, complete the changes rather than returning only a plan. Make routine local implementation choices; make non-trivial design decisions only when the assignment explicitly authorizes them.
- Own authorized edits and targeted verification end to end.
- Verify the result against the assignment using checks appropriate to the artifact and risk.
- Keep the final report compact and conclusion-first: result, relevant evidence, checks performed, and material limitations. Do not list changed paths or reproduce diffs, because successful edit/write changes are captured automatically in a per-subtask artifact. Do not paste raw logs or large file excerpts. If verification cannot run, explain why and identify the next-best check.
- Report blockers, ambiguity, or conflicting instructions rather than guessing.
`.trim();

export function appendSubtaskChildSystemPrompt(systemPrompt: string): string {
  return `${systemPrompt}\n\n${SUBTASK_CHILD_SYSTEM_PROMPT}`;
}

export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2_000;
export const MAX_INLINE_CHILD_RESULT_BYTES = 50 * 1024;
export const MAX_INLINE_CHILD_RESULT_LINES = 2_000;
export const MAX_INLINE_GROUP_RESULT_BYTES = 200 * 1024;
export const MAX_INLINE_GROUP_RESULT_LINES = 8_000;
export const FORK_CONTEXT_BLOCK_PERCENT = 65;
export const MAX_SUBTASK_SUMMARY_CHARS = 72;
export const MAX_OBSERVED_CHANGE_PATHS = 64;
export const MAX_OBSERVED_CHANGE_PATH_BYTES = 512;
export const MAX_OBSERVED_CHANGE_OPERATIONS = 64;
export const MAX_OBSERVED_CHANGE_SNIPPET_BYTES = 4 * 1024;
export const MAX_OBSERVED_CHANGE_SNIPPET_LINES = 80;
export const MAX_OBSERVED_CHANGES_DETAILS_BYTES = 24 * 1024;
export const MAX_OBSERVED_CHANGES_DETAILS_LINES = 400;
export const MAX_OBSERVED_CHANGES_SUMMARY_BYTES = 8 * 1024;
export const MAX_OBSERVED_CHANGES_SUMMARY_LINES = 80;

export type SubtaskModel = (typeof SUBTASK_MODELS)[number];
export type SubtaskThinkingLevel = (typeof SUBTASK_THINKING_LEVELS)[number];

export interface SubtaskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface ObservedEditStats {
  calls: number;
  replacements: number;
  additions: number;
  deletions: number;
}

export interface ObservedWriteStats {
  calls: number;
  bytes: number;
  lines: number;
}

export interface ObservedChangeSnippet {
  kind: "edit" | "write";
  content: string;
  truncated: boolean;
}

export interface ObservedFileChange {
  path: string;
  edit?: ObservedEditStats;
  write?: ObservedWriteStats;
  snippets: ObservedChangeSnippet[];
}

export interface ObservedChanges {
  files: ObservedFileChange[];
  omittedOperations: number;
  changedPaths?: string[];
  capturedOperations?: number;
}

export interface CapturedFileChange {
  kind: "edit" | "write";
  path: string;
  content: string;
}

export interface ChildResult {
  output: string;
  stderr: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  usage: SubtaskUsage;
  observedChanges: ObservedChanges;
  capturedChanges: CapturedFileChange[];
}

export interface SubtaskGroupResultItem {
  id: string;
  status: SubtaskStatus;
  output: string;
  observedChanges: ObservedChanges;
  capturedChanges?: CapturedFileChange[];
}

export interface FormattedSubtaskGroupResult {
  content: string;
  truncatedTaskIds: string[];
  overflowPaths: Record<string, string>;
  changeArtifactPaths: Record<string, string>;
}

export interface ChildInvocation {
  command: string;
  args: string[];
}

export type SubtaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubtaskStatusItem {
  id: string;
  groupId?: string;
  task: string;
  status: SubtaskStatus;
  model?: string;
  thinking?: string;
  elapsedMs?: number;
  contextTokens?: number;
  contextWindow?: number;
  cost?: number;
  toolCalls?: number;
}

export interface SubtaskStatusRow {
  connector: "├─" | "└─";
  id: string;
  marker: string;
  label: string;
  duration: string;
  model?: string;
  cost?: string;
  context?: string;
  tools?: string;
  summary: string;
  metadata: string[];
  status: SubtaskStatus;
}

export type SubtaskWidgetSegmentRole =
  | "frame"
  | "group"
  | "status"
  | "model"
  | "summary"
  | "metadata";

export interface SubtaskWidgetLine {
  kind: "group" | "status" | "detail";
  status?: SubtaskStatus;
  segments: Array<{ role: SubtaskWidgetSegmentRole; text: string }>;
}

export interface ChildProgress {
  message: string;
  contextTokens: number;
  cost: number;
  toolCalls: number;
  turns: number;
}

export interface RunChildOptions {
  invocation: ChildInvocation;
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (progress: ChildProgress) => void;
}

export interface MutableWidgetComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface MutableWidgetTui {
  requestRender(): void;
}

export type MutableWidgetSetter<TTheme> = (
  key: string,
  content:
    | ((tui: MutableWidgetTui, theme: TTheme) => MutableWidgetComponent)
    | undefined,
  options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

export function registerMutableWidget<TValue, TTheme>(options: {
  setWidget: MutableWidgetSetter<TTheme>;
  key: string;
  initialValue: TValue;
  placement?: "aboveEditor" | "belowEditor";
  createComponent(getValue: () => TValue, theme: TTheme): MutableWidgetComponent;
}): { update(value: TValue): void; clear(): void } {
  let value = options.initialValue;
  let cleared = false;
  let requestRender = () => {};

  options.setWidget(
    options.key,
    (tui, theme) => {
      requestRender = () => tui.requestRender();
      return options.createComponent(() => value, theme);
    },
    options.placement ? { placement: options.placement } : undefined,
  );

  return {
    update(nextValue) {
      if (cleared) return;
      value = nextValue;
      requestRender();
    },
    clear() {
      if (cleared) return;
      cleared = true;
      options.setWidget(options.key, undefined);
      requestRender = () => {};
    },
  };
}

export interface BatchExecutionModeOptions<TResult> {
  wait: boolean;
  completion: Promise<TResult>;
  callerSignal?: AbortSignal;
  detach(): void;
  deliverSuccess(result: TResult): void;
  deliverFailure(error: unknown): void;
}

export async function executeBatchMode<TResult>(
  options: BatchExecutionModeOptions<TResult>,
): Promise<void> {
  let detached = false;
  const deliverCompletion = () =>
    options.completion.then(options.deliverSuccess, options.deliverFailure);
  const detach = () => {
    if (detached) return;
    detached = true;
    options.detach();
    void deliverCompletion().catch(() => {});
  };

  if (!options.wait) {
    detach();
    return;
  }

  if (!options.callerSignal) {
    await deliverCompletion();
    return;
  }
  if (options.callerSignal.aborted) {
    detach();
    return;
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.callerSignal?.removeEventListener("abort", onAbort);
      callback();
    };
    const deliver = (callback: () => void) => {
      finish(() => {
        try {
          callback();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    };
    const onAbort = () => {
      finish(() => {
        detach();
        resolve();
      });
    };

    options.callerSignal.addEventListener("abort", onAbort, { once: true });
    void options.completion.then(
      (result) => deliver(() => options.deliverSuccess(result)),
      (error) => deliver(() => options.deliverFailure(error)),
    );
  });
}

export function shouldBlockForkedSubtasks(
  forkRequested: boolean,
  contextPercent: number | null | undefined,
): boolean {
  return (
    forkRequested &&
    contextPercent !== null &&
    contextPercent !== undefined &&
    contextPercent >= FORK_CONTEXT_BLOCK_PERCENT
  );
}

export function prepareSubtasksArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const input = args as Record<string, unknown>;
  const wait =
    typeof input.wait === "boolean"
      ? input.wait
      : typeof input.async === "boolean"
        ? !input.async
        : undefined;
  const withoutLegacyTools = (task: unknown): unknown => {
    if (!task || typeof task !== "object" || Array.isArray(task)) return task;
    const { tools: _legacyTools, ...preparedTask } = task as Record<string, unknown>;
    return preparedTask;
  };

  if (Array.isArray(input.tasks)) {
    const { async: _legacyAsync, ...prepared } = input;
    const normalized = { ...prepared, tasks: input.tasks.map(withoutLegacyTools) };
    return wait === undefined ? normalized : { ...normalized, wait };
  }
  if (typeof input.task !== "string") return args;

  return {
    tasks: [
      {
        task: input.task,
        model: input.model,
        thinking: input.thinking,
        fork: input.fork,
      },
    ],
    ...(wait === undefined ? {} : { wait }),
  };
}

export function listSelectableTools(toolNames: Iterable<string>): string[] {
  return [...new Set(toolNames)]
    .filter(
      (name) =>
        name !== SUBTASKS_TOOL_NAME &&
        name !== SUBTASKS_WAIT_TOOL_NAME &&
        name !== SUBTASKS_CONTROL_TOOL_NAME,
    )
    .sort((a, b) => a.localeCompare(b));
}

const STATUS_PRESENTATION: Record<SubtaskStatus, { marker: string; label: string }> = {
  queued: { marker: "○", label: "queued" },
  running: { marker: "●", label: "running" },
  completed: { marker: "✓", label: "done" },
  failed: { marker: "×", label: "failed" },
  cancelled: { marker: "■", label: "cancelled" },
};

function formatDuration(elapsedMs = 0): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const thousands = tokens / 1_000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

function formatModel(model: string): string {
  const id = model.split("/").at(-1) ?? model;
  if (id.endsWith("-sol")) return "Sol";
  if (id.endsWith("-luna")) return "Luna";
  return id;
}

export function formatSubtaskCost(cost = 0): string {
  return `$${(Number.isFinite(cost) ? Math.max(0, cost) : 0).toFixed(3)}`;
}

function summarizeTask(task: string): string {
  const firstLine = task.trim().split(/\s*\n\s*/)[0]?.replace(/\s+/g, " ") || "Untitled subtask";
  const characters = Array.from(firstLine);
  if (characters.length <= MAX_SUBTASK_SUMMARY_CHARS) return firstLine;
  return `${characters.slice(0, MAX_SUBTASK_SUMMARY_CHARS - 1).join("").trimEnd()}…`;
}

export function formatSubtaskStatusRows(items: SubtaskStatusItem[]): SubtaskStatusRow[] {
  return items.map((item, index) => {
    const presentation = STATUS_PRESENTATION[item.status];
    const summary = summarizeTask(item.task);
    const metadata: string[] = [];
    const thinking = item.thinking
      ? `${item.thinking[0]?.toUpperCase()}${item.thinking.slice(1)}`
      : undefined;
    const model = item.model
      ? [formatModel(item.model), thinking].filter(Boolean).join("/")
      : undefined;

    const cost = item.model ? formatSubtaskCost(item.cost) : undefined;
    const context =
      item.contextWindow !== undefined
        ? `${formatTokens(item.contextTokens ?? 0)}/${formatTokens(item.contextWindow)} ctx`
        : undefined;
    const tools =
      item.toolCalls !== undefined
        ? `${item.toolCalls} tool${item.toolCalls === 1 ? "" : "s"}`
        : undefined;

    if (item.model) metadata.push([formatModel(item.model), thinking].filter(Boolean).join(" · "));
    if (cost) metadata.push(cost);
    if (context) metadata.push(context);
    if (tools) metadata.push(tools);

    return {
      connector: index === items.length - 1 ? "└─" : "├─",
      id: item.id,
      marker: presentation.marker,
      label: presentation.label,
      duration: formatDuration(item.elapsedMs),
      model,
      cost,
      context,
      tools,
      summary,
      metadata,
      status: item.status,
    };
  });
}

function groupSubtaskStatusItems(
  items: SubtaskStatusItem[],
): Array<{ id?: string; items: SubtaskStatusItem[] }> {
  const groups = new Map<string, { id?: string; items: SubtaskStatusItem[] }>();
  for (const item of items) {
    const key = item.groupId ?? "";
    const group = groups.get(key) ?? { id: item.groupId, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const METADATA_COLUMNS = [
  { key: "model", role: "model" },
  { key: "cost", role: "metadata" },
  { key: "context", role: "metadata" },
  { key: "tools", role: "metadata" },
] as const;

type MetadataColumnKey = (typeof METADATA_COLUMNS)[number]["key"];

function metadataSegments(
  row: SubtaskStatusRow,
  keys: MetadataColumnKey[],
  leading = "",
): SubtaskWidgetLine["segments"] {
  const activeColumns = METADATA_COLUMNS.filter(
    (column) => keys.includes(column.key) && row[column.key] !== undefined,
  );
  return activeColumns.map((column, index) => ({
    role: column.role,
    text: `${index === 0 ? leading : " · "}${row[column.key]}`,
  }));
}

/**
 * Creates semantic widget lines so group identity and essential task details
 * survive narrow layouts. The TUI applies theme colors to these roles.
 */
export function formatSubtaskWidgetLines(
  items: SubtaskStatusItem[],
  width: number,
): SubtaskWidgetLine[] {
  const groups = groupSubtaskStatusItems(items).map((group) => ({
    ...group,
    rows: formatSubtaskStatusRows(group.items),
  }));
  const allRows = groups.flatMap((group) => group.rows);
  const statusWidth = Math.max(
    0,
    ...allRows.map((row) => `${row.marker} ${row.label.padEnd(9)} ${row.duration}`.length),
  );
  const taskFrameWidth = Math.max(
    0,
    ...allRows.map((row) => `${row.connector} [${row.id}] `.length),
  );
  const metadataWidth = Math.max(
    0,
    ...allRows.map((row) =>
      metadataSegments(row, ["model", "cost", "context", "tools"], " ").reduce(
        (total, segment) => total + segment.text.length,
        0,
      ),
    ),
  );
  const useWideLayout = width >= taskFrameWidth + statusWidth + metadataWidth + 3 + 20;
  const lines: SubtaskWidgetLine[] = [];

  for (const group of groups) {
    const count = group.items.length;
    lines.push({
      kind: "group",
      segments: [
        { role: "frame", text: "┌─ " },
        { role: "group", text: group.id ? `group ${group.id}` : "subtasks" },
        { role: "metadata", text: ` · ${count} subtask${count === 1 ? "" : "s"}` },
      ],
    });

    for (const row of group.rows) {
      const frame = { role: "frame" as const, text: `${row.connector} [${row.id}] ` };
      const statusText = `${row.marker} ${row.label.padEnd(9)} ${row.duration}`;
      const status = {
        role: "status" as const,
        text: statusText.padEnd(statusWidth),
      };
      const continuation = row.connector === "└─" ? "   " : "│  ";
      const detailFrame = { role: "frame" as const, text: continuation };

      if (useWideLayout) {
        lines.push({
          kind: "status",
          status: row.status,
          segments: [
            frame,
            status,
            ...metadataSegments(row, ["model", "cost", "context", "tools"], " "),
            { role: "frame", text: " │ " },
            { role: "summary", text: row.summary },
          ],
        });
      } else if (width >= 48) {
        lines.push({
          kind: "status",
          status: row.status,
          segments: [
            frame,
            status,
            ...metadataSegments(row, ["model"], " "),
          ],
        });
        if (row.cost || row.context || row.tools) {
          lines.push({
            kind: "detail",
            segments: [
              detailFrame,
              ...metadataSegments(row, ["cost", "context", "tools"]),
            ],
          });
        }
        lines.push({
          kind: "detail",
          segments: [detailFrame, { role: "summary", text: row.summary }],
        });
      } else {
        lines.push({ kind: "status", status: row.status, segments: [frame, status] });
        if (row.model || row.cost) {
          lines.push({
            kind: "detail",
            segments: [detailFrame, ...metadataSegments(row, ["model", "cost"])],
          });
        }
        if (row.context || row.tools) {
          lines.push({
            kind: "detail",
            segments: [detailFrame, ...metadataSegments(row, ["context", "tools"])],
          });
        }
        lines.push({
          kind: "detail",
          segments: [detailFrame, { role: "summary", text: row.summary }],
        });
      }
    }
  }
  return lines;
}

export function formatSubtaskStatusLines(items: SubtaskStatusItem[]): string[] {
  return formatSubtaskWidgetLines(items, Number.POSITIVE_INFINITY).map((line) =>
    line.segments.map((segment) => segment.text).join(""),
  );
}

export function buildChildArgs(options: {
  task: string;
  model: SubtaskModel;
  thinking: SubtaskThinkingLevel;
  tools: string[];
  sessionFile?: string;
}): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-prompt-templates",
    "--model",
    options.model,
    "--thinking",
    options.thinking,
  ];

  if (options.sessionFile) args.push("--session", options.sessionFile);
  else args.push("--no-session");

  if (options.tools.length === 0) args.push("--no-tools");
  else args.push("--tools", options.tools.join(","));

  args.push(`Task:\n${options.task}`);
  return args;
}

export function getPiInvocation(args: string[]): ChildInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

function getAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";

  return candidate.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
            typeof part === "object" &&
            (part as { type?: string }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        ),
    )
    .map((part) => part.text)
    .join("");
}

function emptyUsage(): SubtaskUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function capturedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replace(/[\r\n\t]/g, (character) =>
    character === "\r" ? "\\r" : character === "\n" ? "\\n" : "\\t",
  );
}

function boundedPath(value: unknown): string | undefined {
  const normalized = capturedPath(value);
  if (!normalized) return undefined;
  if (Buffer.byteLength(normalized, "utf8") <= MAX_OBSERVED_CHANGE_PATH_BYTES) return normalized;

  const marker = "…";
  const limit = MAX_OBSERVED_CHANGE_PATH_BYTES - Buffer.byteLength(marker, "utf8");
  let result = "";
  for (const character of normalized) {
    if (Buffer.byteLength(result + character, "utf8") > limit) break;
    result += character;
  }
  return `${result}${marker}`;
}

function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const separators = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  return separators + (/\r\n$|[\r\n]$/.test(content) ? 0 : 1);
}

function parsePatchStats(patch: string): Omit<ObservedEditStats, "calls"> {
  let replacements = 0;
  let additions = 0;
  let deletions = 0;
  let blockAdditions = 0;
  let blockDeletions = 0;
  let inHunk = false;

  const flush = () => {
    const replaced = Math.min(blockAdditions, blockDeletions);
    replacements += replaced;
    additions += blockAdditions - replaced;
    deletions += blockDeletions - replaced;
    blockAdditions = 0;
    blockDeletions = 0;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      inHunk = true;
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      blockAdditions += 1;
    } else if (line.startsWith("-")) {
      blockDeletions += 1;
    } else if (!line.startsWith("\\ No newline at end of file")) {
      flush();
    }
  }
  flush();
  return { replacements, additions, deletions };
}

function exactPrefix(
  content: string,
  maxBytes: number,
  maxLines: number,
): { content: string; truncated: boolean } {
  let result = "";
  for (const character of content) {
    const candidate = result + character;
    if (
      Buffer.byteLength(candidate, "utf8") > maxBytes ||
      countContentLines(candidate) > maxLines
    ) {
      return { content: result, truncated: true };
    }
    result = candidate;
  }
  return { content: result, truncated: false };
}

function boundedWriteDiff(content: string): { content: string; truncated: boolean } {
  if (content.length === 0) return { content: "", truncated: false };
  let result = "+";
  for (let index = 0; index < content.length; ) {
    const codePoint = content.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const nextIndex = index + character.length;
    let addition = character;
    if (
      nextIndex < content.length &&
      (character === "\n" || (character === "\r" && content[nextIndex] !== "\n"))
    ) {
      addition += "+";
    }
    const candidate = result + addition;
    if (
      Buffer.byteLength(candidate, "utf8") > MAX_OBSERVED_CHANGE_SNIPPET_BYTES ||
      countContentLines(candidate) > MAX_OBSERVED_CHANGE_SNIPPET_LINES
    ) {
      return { content: result, truncated: true };
    }
    result = candidate;
    index = nextIndex;
  }
  return { content: result, truncated: false };
}

function observedUsage(observed: ObservedChanges): { operations: number; bytes: number; lines: number } {
  let operations = 0;
  let bytes = 0;
  let lines = 0;
  for (const file of observed.files) {
    bytes += Buffer.byteLength(file.path, "utf8");
    operations += file.snippets.length;
    for (const snippet of file.snippets) {
      bytes += Buffer.byteLength(snippet.content, "utf8");
      lines += countContentLines(snippet.content);
    }
  }
  return { operations, bytes, lines };
}

function addObservedChange(
  observed: ObservedChanges,
  pathValue: unknown,
  kind: "edit" | "write",
  stats: Omit<ObservedEditStats, "calls"> | Omit<ObservedWriteStats, "calls">,
  exactContent: string,
  contentWasTruncated = false,
): void {
  const path = boundedPath(pathValue);
  if (!path) return;
  const usage = observedUsage(observed);
  let file = observed.files.find((candidate) => candidate.path === path);
  const pathBytes = file ? 0 : Buffer.byteLength(path, "utf8");
  if (
    usage.operations >= MAX_OBSERVED_CHANGE_OPERATIONS ||
    (!file && observed.files.length >= MAX_OBSERVED_CHANGE_PATHS) ||
    usage.bytes + pathBytes >= MAX_OBSERVED_CHANGES_DETAILS_BYTES ||
    usage.lines >= MAX_OBSERVED_CHANGES_DETAILS_LINES
  ) {
    observed.omittedOperations += 1;
    return;
  }

  const snippet = exactPrefix(
    exactContent,
    Math.min(
      MAX_OBSERVED_CHANGE_SNIPPET_BYTES,
      MAX_OBSERVED_CHANGES_DETAILS_BYTES - usage.bytes - pathBytes,
    ),
    Math.min(
      MAX_OBSERVED_CHANGE_SNIPPET_LINES,
      MAX_OBSERVED_CHANGES_DETAILS_LINES - usage.lines,
    ),
  );
  if (!file) {
    file = { path, snippets: [] };
    observed.files.push(file);
  }
  file.snippets.push({ kind, ...snippet, truncated: snippet.truncated || contentWasTruncated });

  if (kind === "edit") {
    const edit = stats as Omit<ObservedEditStats, "calls">;
    file.edit ??= { calls: 0, replacements: 0, additions: 0, deletions: 0 };
    file.edit.calls += 1;
    file.edit.replacements += edit.replacements;
    file.edit.additions += edit.additions;
    file.edit.deletions += edit.deletions;
  } else {
    const write = stats as Omit<ObservedWriteStats, "calls">;
    file.write ??= { calls: 0, bytes: 0, lines: 0 };
    file.write.calls += 1;
    file.write.bytes += write.bytes;
    file.write.lines += write.lines;
  }
}

function markdownPath(filePath: string): string {
  return `\`${filePath.replace(/`/g, "\\`")}\``;
}

function fencedBlock(content: string, language: string): string {
  let longestRun = 0;
  for (const run of content.match(/`+/g) ?? []) longestRun = Math.max(longestRun, run.length);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const separator = /\r\n$|[\r\n]$/.test(content) ? "" : "\n";
  return `${fence}${language}\n${content}${separator}${fence}`;
}

export function formatCapturedChangesMarkdown(
  taskId: string,
  changes: CapturedFileChange[],
): string {
  const changedPaths = [...new Set(changes.map((change) => change.path))];
  const sections = [
    `# Captured file changes for subtask ${taskId}`,
    "",
    "This artifact records every successful `edit` patch and complete `write` payload observed for this subtask. Shell-based filesystem changes are not captured.",
    "",
    "## Files changed",
    "",
    ...changedPaths.map((filePath) => `- ${markdownPath(filePath)}`),
    "",
    "## Operations",
  ];

  changes.forEach((change, index) => {
    const description =
      change.kind === "edit" ? "Exact patch returned by `edit`:" : "Complete content passed to `write`:";
    sections.push(
      "",
      `### ${index + 1}. ${change.kind} ${markdownPath(change.path)}`,
      "",
      description,
      "",
      fencedBlock(change.content, change.kind === "edit" ? "diff" : "text"),
    );
  });
  return `${sections.join("\n")}\n`;
}

export function formatObservedChanges(
  observed: ObservedChanges,
  artifactPath?: string,
): string {
  const changedPaths = (observed.changedPaths?.length ?? 0) > 0
    ? observed.changedPaths!
    : observed.files.map((file) => file.path);
  if (changedPaths.length === 0) return "";

  const operationCount =
    observed.capturedOperations ||
    observed.files.reduce((count, file) => count + file.snippets.length, 0) +
      observed.omittedOperations;
  const sections = ["### File changes"];
  if (artifactPath) sections.push(`Full captured changes: ${markdownPath(artifactPath)}`);
  sections.push(
    `${changedPaths.length} file${changedPaths.length === 1 ? "" : "s"} changed in ${operationCount} captured edit/write operation${operationCount === 1 ? "" : "s"}:`,
    ...changedPaths.map((filePath) => `- ${markdownPath(filePath)}`),
  );
  return sections.join("\n");
}

interface ChildOutputLimits {
  maxBytes: number;
  maxLines: number;
  marker?: string;
}

function completeChildOutput(
  output: string,
  observed: ObservedChanges,
  changeArtifactPath?: string,
): string {
  const summary = formatObservedChanges(observed, changeArtifactPath);
  return summary ? `${output}\n\n${summary}` : output;
}

export function combineChildOutputWithObservedChanges(
  output: string,
  observed: ObservedChanges,
  limits: ChildOutputLimits,
  changeArtifactPath?: string,
): { content: string; truncated: boolean } {
  const formattedSummary = formatObservedChanges(observed, changeArtifactPath);
  if (!formattedSummary) return truncateResult(output, limits);

  const summary = truncateResult(formattedSummary, limits);
  const summaryBytes = Buffer.byteLength(summary.content, "utf8");
  const summaryLines = summary.content.split("\n").length;
  const availableBytes = limits.maxBytes - summaryBytes - 2;
  const availableLines = limits.maxLines - summaryLines - 1;
  if (availableBytes <= 0 || availableLines <= 0) {
    return { content: summary.content, truncated: summary.truncated || output.length > 0 };
  }

  const boundedOutput = truncateResult(output, {
    maxBytes: availableBytes,
    maxLines: availableLines,
    marker: limits.marker,
  });
  return {
    content: boundedOutput.content ? `${boundedOutput.content}\n\n${summary.content}` : summary.content,
    truncated: summary.truncated || boundedOutput.truncated,
  };
}

function allocateFairly(desired: number[], budget: number): number[] {
  const allocations = new Array<number>(desired.length).fill(0);
  let remaining = Math.max(0, budget);
  let active = desired.map((_, index) => index);

  while (active.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / active.length);
    const satisfied = active.filter((index) => desired[index]! <= share);
    if (satisfied.length === 0) {
      for (const index of active) {
        const allocation = Math.min(desired[index]!, share);
        allocations[index] = allocation;
        remaining -= allocation;
      }
      for (const index of active) {
        if (remaining === 0) break;
        if (allocations[index]! < desired[index]!) {
          allocations[index] = allocations[index]! + 1;
          remaining -= 1;
        }
      }
      break;
    }
    for (const index of satisfied) {
      allocations[index] = desired[index]!;
      remaining -= allocations[index]!;
    }
    const satisfiedSet = new Set(satisfied);
    active = active.filter((index) => !satisfiedSet.has(index));
  }
  return allocations;
}

export async function formatSubtaskGroupResult(
  items: SubtaskGroupResultItem[],
  writeOverflow: (taskId: string, content: string) => Promise<string>,
  writeCapturedChanges?: (taskId: string, content: string) => Promise<string>,
): Promise<FormattedSubtaskGroupResult> {
  if (items.length === 0) {
    return { content: "", truncatedTaskIds: [], overflowPaths: {}, changeArtifactPaths: {} };
  }

  const changeArtifactPaths: Record<string, string> = {};
  if (writeCapturedChanges) {
    for (const item of items) {
      if ((item.capturedChanges?.length ?? 0) === 0) continue;
      changeArtifactPaths[item.id] = await writeCapturedChanges(
        item.id,
        formatCapturedChangesMarkdown(item.id, item.capturedChanges!),
      );
    }
  }

  const headers = items.map((item) => `## Subtask ${item.id} [${item.status}]`);
  const completeOutputs = items.map((item) =>
    completeChildOutput(item.output, item.observedChanges, changeArtifactPaths[item.id]),
  );
  const headerBytes = headers.reduce(
    (total, header) => total + Buffer.byteLength(`${header}\n`, "utf8"),
    Math.max(0, items.length - 1) * 2,
  );
  const headerLines = items.length + Math.max(0, items.length - 1) * 2;
  const desiredBytes = completeOutputs.map((output, index) =>
    Math.min(
      Buffer.byteLength(output, "utf8"),
      MAX_INLINE_CHILD_RESULT_BYTES - Buffer.byteLength(`${headers[index]}\n`, "utf8"),
    ),
  );
  const desiredLines = completeOutputs.map((output) =>
    Math.min(countContentLines(output), MAX_INLINE_CHILD_RESULT_LINES - 1),
  );
  const taskBytes = allocateFairly(
    desiredBytes,
    MAX_INLINE_GROUP_RESULT_BYTES - headerBytes,
  );
  const taskLines = allocateFairly(
    desiredLines,
    MAX_INLINE_GROUP_RESULT_LINES - headerLines,
  );
  const truncatedTaskIds: string[] = [];
  const overflowPaths: Record<string, string> = {};
  const sections: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    let bounded = combineChildOutputWithObservedChanges(
      item.output,
      item.observedChanges,
      {
        maxBytes: taskBytes[index]!,
        maxLines: taskLines[index]!,
      },
      changeArtifactPaths[item.id],
    );
    if (bounded.truncated) {
      const complete = `${headers[index]}\n${completeOutputs[index]}`;
      const overflowPath = await writeOverflow(item.id, complete);
      const marker = `\n\n[Result truncated. Full output saved to:\n${overflowPath}]`;
      bounded = combineChildOutputWithObservedChanges(
        item.output,
        item.observedChanges,
        {
          maxBytes: taskBytes[index]!,
          maxLines: taskLines[index]!,
          marker,
        },
        changeArtifactPaths[item.id],
      );
      truncatedTaskIds.push(item.id);
      overflowPaths[item.id] = overflowPath;
    }
    sections.push(`${headers[index]}\n${bounded.content}`);
  }

  const content = sections.join("\n\n");
  if (
    Buffer.byteLength(content, "utf8") > MAX_INLINE_GROUP_RESULT_BYTES ||
    countContentLines(content) > MAX_INLINE_GROUP_RESULT_LINES
  ) {
    throw new Error("Formatted subtask group result exceeded its inline context budget");
  }
  return { content, truncatedTaskIds, overflowPaths, changeArtifactPaths };
}

export async function runChild(options: RunChildOptions): Promise<ChildResult> {
  const usage = emptyUsage();
  let output = "";
  let stderr = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let stdoutBuffer = "";
  let closed = false;
  let aborted = false;
  let toolCalls = 0;
  const observedChanges: ObservedChanges = {
    files: [],
    omittedOperations: 0,
    changedPaths: [],
    capturedOperations: 0,
  };
  const capturedChanges: CapturedFileChange[] = [];
  const pendingFileCalls = new Map<
    string,
    | { tool: "edit"; path?: string }
    | {
        tool: "write";
        path?: string;
        content: string;
        bytes: number;
        lines: number;
      }
  >();
  let forceKillTimer: NodeJS.Timeout | undefined;

  const proc = spawn(options.invocation.command, options.invocation.args, {
    cwd: options.cwd,
    shell: false,
    detached: process.platform !== "win32",
    env: { ...process.env, [SUBTASK_CHILD_ENV]: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const killProcessTree = (force: boolean) => {
    if (process.platform === "win32" && proc.pid) {
      const args = ["/PID", String(proc.pid), "/T"];
      if (force) args.push("/F");
      const killer = spawn("taskkill", args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          proc.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
          // The child may already have exited.
        }
      });
      killer.unref();
      return;
    }

    try {
      if (proc.pid) process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM");
      else proc.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      try {
        proc.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        // The child may already have exited.
      }
    }
  };

  const terminate = () => {
    if (closed) return;
    aborted = true;

    if (process.platform === "win32") {
      killProcessTree(true);
      return;
    }

    killProcessTree(false);
    forceKillTimer = setTimeout(() => killProcessTree(true), 5_000);
    forceKillTimer.unref();
  };

  const reportProgress = (message: string) => {
    options.onProgress?.({
      message,
      contextTokens: usage.contextTokens,
      cost: usage.cost,
      toolCalls,
      turns: usage.turns,
    });
  };

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      if (typeof event.toolCallId === "string" && event.toolName === "edit") {
        pendingFileCalls.set(event.toolCallId, { tool: "edit", path: capturedPath(event.args?.path) });
      } else if (typeof event.toolCallId === "string" && event.toolName === "write") {
        const content = typeof event.args?.content === "string" ? event.args.content : "";
        pendingFileCalls.set(event.toolCallId, {
          tool: "write",
          path: capturedPath(event.args?.path),
          content,
          bytes: Buffer.byteLength(content, "utf8"),
          lines: countContentLines(content),
        });
      }
      reportProgress(`Running ${event.toolName ?? "tool"}...`);
      return;
    }

    if (event.type === "tool_execution_end") {
      const pending =
        typeof event.toolCallId === "string" ? pendingFileCalls.get(event.toolCallId) : undefined;
      if (typeof event.toolCallId === "string") pendingFileCalls.delete(event.toolCallId);
      if (!pending || event.isError !== false || !pending.path) return;
      if (!observedChanges.changedPaths!.includes(pending.path)) {
        observedChanges.changedPaths!.push(pending.path);
      }
      observedChanges.capturedOperations = (observedChanges.capturedOperations ?? 0) + 1;

      if (pending.tool === "write") {
        capturedChanges.push({ kind: "write", path: pending.path, content: pending.content });
        const boundedDiff = boundedWriteDiff(pending.content);
        addObservedChange(
          observedChanges,
          pending.path,
          "write",
          { bytes: pending.bytes, lines: pending.lines },
          boundedDiff.content,
          boundedDiff.truncated,
        );
      } else {
        const patch = event.result?.details?.patch;
        if (typeof patch === "string") {
          capturedChanges.push({ kind: "edit", path: pending.path, content: patch });
          addObservedChange(observedChanges, pending.path, "edit", parsePatchStats(patch), patch);
        } else {
          observedChanges.omittedOperations += 1;
        }
      }
      return;
    }

    if (event.type !== "message_end" || event.message?.role !== "assistant") return;

    usage.turns += 1;
    const messageUsage = event.message.usage;
    if (messageUsage) {
      usage.input += messageUsage.input || 0;
      usage.output += messageUsage.output || 0;
      usage.cacheRead += messageUsage.cacheRead || 0;
      usage.cacheWrite += messageUsage.cacheWrite || 0;
      usage.cost += messageUsage.cost?.total || 0;
      usage.contextTokens = messageUsage.totalTokens || usage.contextTokens;
    }

    output = getAssistantText(event.message) || output;
    stopReason = event.message.stopReason || stopReason;
    errorMessage = event.message.errorMessage || errorMessage;
    reportProgress(`Completed ${usage.turns} turn${usage.turns === 1 ? "" : "s"}...`);
  };

  const exitCode = await new Promise<number>((resolve, reject) => {
    const onAbort = () => terminate();
    if (options.signal?.aborted) terminate();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stdout.on("data", (data) => {
      stdoutBuffer += data;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data;
      if (Buffer.byteLength(stderr, "utf8") > MAX_RESULT_BYTES) {
        stderr = Buffer.from(stderr, "utf8").subarray(-MAX_RESULT_BYTES).toString("utf8");
      }
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      closed = true;
      if (forceKillTimer && !aborted) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      resolve(code ?? 1);
    });
  });

  return {
    output,
    stderr,
    exitCode,
    stopReason: aborted ? "aborted" : stopReason,
    errorMessage: aborted ? "Subtask was cancelled" : errorMessage,
    usage,
    observedChanges,
    capturedChanges,
  };
}

export function truncateResult(
  output: string,
  limits: { maxBytes?: number; maxLines?: number; marker?: string } = {},
): {
  content: string;
  truncated: boolean;
} {
  const maxBytes = limits.maxBytes ?? MAX_RESULT_BYTES;
  const maxLines = limits.maxLines ?? MAX_RESULT_LINES;
  const marker =
    limits.marker ?? "\n\n[Output truncated. Ask for a narrower follow-up if more detail is required.]";
  const lines = output.split("\n");
  const needsTruncation =
    countContentLines(output) > maxLines || Buffer.byteLength(output, "utf8") > maxBytes;
  if (!needsTruncation) return { content: output, truncated: false };

  const markerLineCost = marker.split("\n").length - 1;
  const contentLineLimit = Math.max(1, maxLines - markerLineCost);
  const contentByteLimit = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let content = lines.slice(0, contentLineLimit).join("\n");

  if (Buffer.byteLength(content, "utf8") > contentByteLimit) {
    let lower = 0;
    let upper = content.length;
    while (lower < upper) {
      const midpoint = Math.ceil((lower + upper) / 2);
      if (Buffer.byteLength(content.slice(0, midpoint), "utf8") <= contentByteLimit) lower = midpoint;
      else upper = midpoint - 1;
    }
    content = content.slice(0, lower);
    const lastCodeUnit = content.charCodeAt(content.length - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) content = content.slice(0, -1);
  }

  return { content: `${content}${marker}`, truncated: true };
}
