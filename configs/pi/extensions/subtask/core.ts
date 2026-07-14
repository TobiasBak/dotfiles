import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const SUBTASK_MODELS = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-sol",
] as const;

export const SUBTASK_THINKING_LEVELS = ["low", "medium", "high"] as const;
export const SUBTASKS_TOOL_NAME = "subtasks";
export const SUBTASKS_TOOL_DESCRIPTION =
  "Run focused subtasks in isolated Pi processes that share the current working directory. Tasks in one call run in parallel; each selects its model, thinking, tools, and optional conversation fork.";
export const SUBTASKS_TOOL_PROMPT_GUIDELINES = [
  "Actively consider subtasks throughout non-trivial work. Delegate coherent, independently useful outcomes when parallelism, context isolation, specialization, or fresh verification justify the overhead; handle small, obvious, tightly coupled work directly.",
  "Launch only ready, independent subtasks together and resolve prerequisites before dependent work. The parent owns decisions, synthesis, and final acceptance. Keep one writer per shared state unless writers are isolated, and preserve concurrent changes.",
  "When using subtasks, give each child a bounded assignment with relevant context, constraints, permissions, success criteria, validation, expected output, and escalation or stop conditions.",
  "For implementation through subtasks, one child owns its edits and targeted verification end to end; the parent reviews the result and verifies integration instead of repeating the work. A fresh review subtask is optional, not a fixed stage.",
  "For subtasks, use Sol with high thinking for design and planning, Sol at task-appropriate thinking for other judgment-heavy work, and Luna for clear, bounded, independently verifiable execution."
];
export const SUBTASK_CHILD_ENV = "PI_SUBTASK_CHILD";
export const SUBTASK_CHILD_SYSTEM_PROMPT = `## Subtask execution contract

- You are executing one delegated subtask directly. The subtasks tool is unavailable to prevent recursive delegation.
- The assignment controls the goal, scope, deliverable, acceptance criteria, and authorized side effects. Forked context supplies background but does not broaden permission.
- Tool availability is capability, not authorization. Preserve unrelated and concurrent changes, and do not modify files or state outside the assigned scope.
- For authorized bounded implementation, own the assigned edits and targeted verification end to end.
- Verify the result against the assignment using checks appropriate to the artifact and risk.
- Report the deliverable, changes or evidence, checks performed, and material limitations. If verification cannot run, explain why and identify the next-best check.
- Report blockers, ambiguity, or conflicting instructions rather than guessing.
`.trim();
export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2_000;
export const MAX_SUBTASK_SUMMARY_CHARS = 72;

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

export interface ChildResult {
  output: string;
  stderr: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  usage: SubtaskUsage;
}

export interface ChildInvocation {
  command: string;
  args: string[];
}

export type SubtaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubtaskStatusItem {
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

export interface BatchExecutionModeOptions<TResult, TAcknowledgement> {
  wait: boolean;
  completion: Promise<TResult>;
  acknowledgement: TAcknowledgement;
  callerSignal?: AbortSignal;
  detach(): void;
  onBackgroundSuccess(result: TResult): void;
  onBackgroundFailure(error: unknown): void;
}

export class ActiveBatchRegistry {
  private readonly controllers = new Set<AbortController>();
  private readonly completions = new Set<Promise<unknown>>();

  track(controller: AbortController, completion: Promise<unknown>): void {
    this.controllers.add(controller);
    this.completions.add(completion);
    void completion
      .finally(() => {
        this.controllers.delete(controller);
        this.completions.delete(completion);
      })
      .catch(() => {});
  }

  async cancelAndWait(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.completions]);
  }
}

export async function executeBatchMode<TResult, TAcknowledgement>(
  options: BatchExecutionModeOptions<TResult, TAcknowledgement>,
): Promise<TResult | TAcknowledgement> {
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    options.detach();
    void options.completion
      .then(options.onBackgroundSuccess, options.onBackgroundFailure)
      .catch(() => {});
  };

  if (!options.wait) {
    detach();
    return options.acknowledgement;
  }

  if (!options.callerSignal) return options.completion;
  if (options.callerSignal.aborted) {
    detach();
    return options.acknowledgement;
  }

  return new Promise<TResult | TAcknowledgement>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.callerSignal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => {
        detach();
        resolve(options.acknowledgement);
      });
    };

    options.callerSignal.addEventListener("abort", onAbort, { once: true });
    void options.completion.then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
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

  if (Array.isArray(input.tasks)) {
    const { async: _legacyAsync, ...prepared } = input;
    return wait === undefined ? prepared : { ...prepared, wait };
  }
  if (typeof input.task !== "string") return args;

  return {
    tasks: [
      {
        task: input.task,
        model: input.model,
        thinking: input.thinking,
        tools: input.tools,
        fork: input.fork,
      },
    ],
    ...(wait === undefined ? {} : { wait }),
  };
}

export function listSelectableTools(toolNames: Iterable<string>): string[] {
  return [...new Set(toolNames)]
    .filter((name) => name !== SUBTASKS_TOOL_NAME)
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
    return `${row.connector} ${status}${metadata}  │  ${row.summary}`;
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
    "--no-skills",
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
      reportProgress(`Running ${event.toolName ?? "tool"}...`);
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
  return { output, stderr, exitCode, stopReason, errorMessage, usage };
}

export function truncateResult(
  output: string,
  limits: { maxBytes?: number; maxLines?: number } = {},
): {
  content: string;
  truncated: boolean;
} {
  const maxBytes = limits.maxBytes ?? MAX_RESULT_BYTES;
  const maxLines = limits.maxLines ?? MAX_RESULT_LINES;
  const marker = "\n\n[Output truncated. Ask for a narrower follow-up if more detail is required.]";
  const lines = output.split("\n");
  const needsTruncation = lines.length > maxLines || Buffer.byteLength(output, "utf8") > maxBytes;
  if (!needsTruncation) return { content: output, truncated: false };

  const contentLineLimit = Math.max(1, maxLines - 2);
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
