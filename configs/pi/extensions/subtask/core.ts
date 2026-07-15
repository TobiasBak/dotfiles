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
  "Run focused subtasks in isolated Pi processes that share the current working directory. Each call creates one group. Tasks in one call run in parallel; each task selects its model, thinking, and optional conversation fork. Children receive all active eligible tools. The call returns a group ID for later waiting and task IDs for listing or cancellation.";
export const SUBTASKS_WAIT_TOOL_DESCRIPTION =
  "Wait once for one or more subtask groups to finish. This blocks until every task in every requested group is terminal; aborting the wait does not cancel the subtasks. Use this instead of polling subtasks_control.";
export const SUBTASKS_CONTROL_TOOL_DESCRIPTION =
  "List running subtasks or cancel specific tasks by the six-character IDs returned by subtasks. Use list only for an on-demand status check, diagnosis, or cancellation workflow; do not poll periodically because subtasks_wait provides blocking group synchronization and results are delivered automatically when subtasks finish.";
export const SUBTASKS_TOOL_PROMPT_GUIDELINES = [
  "Actively consider subtasks throughout non-trivial work. Delegate coherent, independently useful outcomes when parallelism, context isolation, specialization, or fresh verification justify the overhead; handle small, obvious, tightly coupled work directly.",
  "Use subtasks to delegate complete outcomes rather than separate investigation, planning, and implementation stages. When implementation can be bounded safely, assign one child to inspect as needed, make local design decisions, edit, and verify. Use planning-only subtasks only when an unresolved decision prevents a bounded implementation assignment.",
  "Launch only ready, independent subtasks together and resolve prerequisites before dependent work. Delegate decisions local to an assigned outcome with that subtask; keep only decisions spanning multiple subtasks in the parent. Keep one writer per shared state unless writers are isolated, and preserve concurrent changes.",
  "When using subtasks, give each child a bounded assignment with relevant context, constraints, permissions, success criteria, validation, expected output, and escalation or stop conditions.",
  "For implementation through subtasks, one child owns the necessary local design, edits, and targeted verification end to end. Use the child's changes and evidence directly instead of repeating delegated investigation or implementation. Run only checks that remain necessary for the overall task. A fresh review subtask is optional, not a fixed stage.",
  "For subtasks, choose the model and thinking level independently. Treat Luna as the cost-effective workhorse for clear, bounded work with explicit success criteria, including implementation, audits, reviews, debugging, and research. Luna is more sensitive to weak delegation, so do not leave it to infer scope, priorities, or the quality bar from poor guidance; first tighten the assignment, or use Sol when the ambiguity is inherent to the work.",
  "For subtasks, prefer Sol when the task is materially ambiguous, open-ended, or high-stakes, or when quality depends on taste: choosing among multiple valid interfaces, seams, abstractions, names, code structures, or user-facing designs where simplicity, coherence, and polish cannot be fully specified in advance. Do not treat all design or judgment-heavy work as requiring Sol.",
  "For subtasks, use the lowest thinking level likely to produce a correct result: low for simple mechanical work, medium as the normal starting point, and high for difficult multi-step investigation, tradeoffs, or verification. Reserve Sol with high thinking for the hardest taste-sensitive or cross-cutting work, or escalation after Luna is insufficient.",
  "When a subtasks call uses wait=false, continue only concrete independent work. As soon as that work is exhausted and the group findings are needed, call subtasks_wait once for the relevant group IDs; it blocks until all requested groups finish.",
  "Do not continuously poll subtasks_control for status. Use subtasks_wait for synchronization, and use subtasks_control list only for an on-demand status check, diagnosis, or cancellation workflow."
];
export const SUBTASK_CHILD_ENV = "PI_SUBTASK_CHILD";
export const SUBTASK_CHILD_SYSTEM_PROMPT = `## Subtask execution contract

- You are executing one delegated subtask directly. The subtasks tool is unavailable to prevent recursive delegation.
- The assignment controls the goal, scope, deliverable, acceptance criteria, and authorized side effects. Forked context supplies background but does not broaden permission.
- Tool availability is capability, not authorization. Preserve unrelated and concurrent changes, and do not modify files or state outside the assigned scope.
- When the assignment authorizes implementation, complete the changes rather than returning only a plan. Inspect as needed and make local design decisions within the assigned scope.
- Own authorized edits and targeted verification end to end.
- Verify the result against the assignment using checks appropriate to the artifact and risk.
- Keep the final report compact and conclusion-first: result, relevant evidence, checks performed, and material limitations. Do not list changed paths or reproduce diffs, because file changes are captured automatically. Do not paste raw logs or large file excerpts. If verification cannot run, explain why and identify the next-best check.
- Report blockers, ambiguity, or conflicting instructions rather than guessing.
`.trim();
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
}

export interface ChildResult {
  output: string;
  stderr: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  usage: SubtaskUsage;
  observedChanges: ObservedChanges;
}

export interface SubtaskGroupResultItem {
  id: string;
  status: SubtaskStatus;
  output: string;
  observedChanges: ObservedChanges;
}

export interface FormattedSubtaskGroupResult {
  content: string;
  truncatedTaskIds: string[];
  overflowPaths: Record<string, string>;
}

export interface ChildInvocation {
  command: string;
  args: string[];
}

export type SubtaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubtaskStatusItem {
  id: string;
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
  summary: string;
  metadata: string[];
  status: SubtaskStatus;
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

    if (item.model && item.thinking) {
      const thinking = `${item.thinking[0]?.toUpperCase()}${item.thinking.slice(1)}`;
      metadata.push(`${formatModel(item.model)} · ${thinking}`);
      metadata.push(formatSubtaskCost(item.cost));
    }
    if (item.contextWindow !== undefined) {
      metadata.push(`${formatTokens(item.contextTokens ?? 0)}/${formatTokens(item.contextWindow)} ctx`);
    }
    if (item.toolCalls !== undefined) {
      metadata.push(`${item.toolCalls} tool${item.toolCalls === 1 ? "" : "s"}`);
    }

    return {
      connector: index === items.length - 1 ? "└─" : "├─",
      id: item.id,
      marker: presentation.marker,
      label: presentation.label,
      duration: formatDuration(item.elapsedMs),
      summary,
      metadata,
      status: item.status,
    };
  });
}

export function formatSubtaskStatusLines(items: SubtaskStatusItem[]): string[] {
  return formatSubtaskStatusRows(items).map((row) => {
    const status = `${row.marker} ${row.label.padEnd(9)} ${row.duration}`;
    const metadata = row.metadata.length > 0 ? `  ${row.metadata.join("  ·  ")}` : "";
    return `${row.connector} [${row.id}] ${status}${metadata}  │  ${row.summary}`;
  });
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

  args.push("--append-system-prompt", SUBTASK_CHILD_SYSTEM_PROMPT);
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

function boundedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value.replace(/[\r\n\t]/g, (character) =>
    character === "\r" ? "\\r" : character === "\n" ? "\\n" : "\\t",
  );
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

function fitsObservedSummary(
  content: string,
  limits: { maxBytes: number; maxLines: number },
): boolean {
  return (
    Buffer.byteLength(content, "utf8") <= limits.maxBytes &&
    content.split("\n").length <= limits.maxLines
  );
}

export function formatObservedChanges(
  observed: ObservedChanges,
  limits: { maxBytes: number; maxLines: number } = {
    maxBytes: MAX_OBSERVED_CHANGES_SUMMARY_BYTES,
    maxLines: MAX_OBSERVED_CHANGES_SUMMARY_LINES,
  },
): string {
  if (observed.files.length === 0 && observed.omittedOperations === 0) return "";

  const sections = ["### File changes"];
  let omittedByFormatting = 0;
  for (let index = 0; index < observed.files.length; index += 1) {
    const file = observed.files[index]!;
    const block = [`#### \`${file.path.replace(/`/g, "\\`")}\``];
    for (const snippet of file.snippets) {
      const fenceSeparator = /\r\n$|[\r\n]$/.test(snippet.content) ? "" : "\n";
      block.push(`\`\`\`diff\n${snippet.content}${fenceSeparator}\`\`\``);
      if (snippet.truncated) block.push("[Diff truncated.]");
    }
    if (!fitsObservedSummary([...sections, block.join("\n")].join("\n"), limits)) {
      omittedByFormatting = observed.files
        .slice(index)
        .reduce((count, candidate) => count + candidate.snippets.length, 0);
      break;
    }
    sections.push(block.join("\n"));
  }

  let omitted = observed.omittedOperations + omittedByFormatting;
  if (omitted > 0) {
    const marker = () =>
      `_${omitted} additional operation${omitted === 1 ? "" : "s"} omitted._`;
    if (fitsObservedSummary([...sections, marker()].join("\n"), limits)) sections.push(marker());
    else if (sections.length > 1) {
      const removedFile = observed.files[sections.length - 2];
      omitted += removedFile?.snippets.length ?? 0;
      sections.pop();
      sections.push(marker());
    }
  }
  return sections.join("\n");
}

interface ChildOutputLimits {
  maxBytes: number;
  maxLines: number;
  marker?: string;
}

function completeChildOutput(output: string, observed: ObservedChanges): string {
  const summary = formatObservedChanges(observed);
  return summary ? `${output}\n\n${summary}` : output;
}

export function combineChildOutputWithObservedChanges(
  output: string,
  observed: ObservedChanges,
  limits: ChildOutputLimits,
): { content: string; truncated: boolean } {
  const formattedSummary = formatObservedChanges(observed, {
    maxBytes: Math.min(limits.maxBytes, MAX_OBSERVED_CHANGES_SUMMARY_BYTES),
    maxLines: Math.min(limits.maxLines, MAX_OBSERVED_CHANGES_SUMMARY_LINES),
  });
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
): Promise<FormattedSubtaskGroupResult> {
  if (items.length === 0) return { content: "", truncatedTaskIds: [], overflowPaths: {} };

  const headers = items.map((item) => `## Subtask ${item.id} [${item.status}]`);
  const completeOutputs = items.map((item) => completeChildOutput(item.output, item.observedChanges));
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
    let bounded = combineChildOutputWithObservedChanges(item.output, item.observedChanges, {
      maxBytes: taskBytes[index]!,
      maxLines: taskLines[index]!,
    });
    if (bounded.truncated) {
      const complete = `${headers[index]}\n${completeOutputs[index]}`;
      const overflowPath = await writeOverflow(item.id, complete);
      const marker = `\n\n[Result truncated. Full output saved to:\n${overflowPath}]`;
      bounded = combineChildOutputWithObservedChanges(item.output, item.observedChanges, {
        maxBytes: taskBytes[index]!,
        maxLines: taskLines[index]!,
        marker,
      });
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
  return { content, truncatedTaskIds, overflowPaths };
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
  const observedChanges: ObservedChanges = { files: [], omittedOperations: 0 };
  const pendingFileCalls = new Map<
    string,
    | { tool: "edit"; path?: string }
    | {
        tool: "write";
        path?: string;
        bytes: number;
        lines: number;
        diff: string;
        diffTruncated: boolean;
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
      const canTrackFileCall =
        pendingFileCalls.size + observedUsage(observedChanges).operations < MAX_OBSERVED_CHANGE_OPERATIONS;
      if (canTrackFileCall && typeof event.toolCallId === "string" && event.toolName === "edit") {
        pendingFileCalls.set(event.toolCallId, { tool: "edit", path: boundedPath(event.args?.path) });
      } else if (canTrackFileCall && typeof event.toolCallId === "string" && event.toolName === "write") {
        const content = typeof event.args?.content === "string" ? event.args.content : "";
        const boundedDiff = boundedWriteDiff(content);
        pendingFileCalls.set(event.toolCallId, {
          tool: "write",
          path: boundedPath(event.args?.path),
          bytes: Buffer.byteLength(content, "utf8"),
          lines: countContentLines(content),
          diff: boundedDiff.content,
          diffTruncated: boundedDiff.truncated,
        });
      }
      reportProgress(`Running ${event.toolName ?? "tool"}...`);
      return;
    }

    if (event.type === "tool_execution_end") {
      const pending =
        typeof event.toolCallId === "string" ? pendingFileCalls.get(event.toolCallId) : undefined;
      if (typeof event.toolCallId === "string") pendingFileCalls.delete(event.toolCallId);
      if (!pending || event.isError !== false) return;
      if (pending.tool === "write") {
        addObservedChange(
          observedChanges,
          pending.path,
          "write",
          { bytes: pending.bytes, lines: pending.lines },
          pending.diff,
          pending.diffTruncated,
        );
      } else {
        const patch = event.result?.details?.patch;
        if (typeof patch === "string") {
          addObservedChange(observedChanges, pending.path, "edit", parsePatchStats(patch), patch);
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

  if (aborted) throw new Error("Subtask was cancelled");
  return { output, stderr, exitCode, stopReason, errorMessage, usage, observedChanges };
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
