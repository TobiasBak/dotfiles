import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEND = "mcp__t3-code__t3_thread_send";
const KINDS = ["go_request", "merge_ready", "done", "blocked", "finding", "tobias_decision"] as const;
const FAILURE_FIELDS = ["step", "cause", "evidence", "next_probe", "diagnosis_owner"] as const;
const PARAMETERS = Type.Object({
  kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
  text: Type.String({ minLength: 1, description: "The report for the chief of staff." }),
  outcome: Type.Optional(Type.Union([Type.Literal("green"), Type.Literal("red")], {
    description: "Required for done. Use red for any failed/RED outcome, even when the assignment is complete.",
  })),
  failure: Type.Optional(Type.Object({
    step: Type.Optional(Type.String({ description: "Failing phase or step." })),
    cause: Type.Optional(Type.String({ description: "Evidence-backed explanation, or the literal unknown. Do not claim flaky/unrelated without evidence." })),
    evidence: Type.Optional(Type.String({ description: "Evidence actually inspected: paths and/or commands, with observations supporting the cause." })),
    next_probe: Type.Optional(Type.String({ description: "Required when cause is unknown: next observation that distinguishes remaining explanations." })),
    diagnosis_owner: Type.Optional(Type.String({ description: "Required when cause is unknown: who keeps diagnosing." })),
  }, { description: "Required for blocked, finding and done with outcome red. step, cause and evidence are mandatory; unknown cause also requires next_probe and diagnosis_owner." })),
  pr_url: Type.Optional(Type.String({ description: "Required for merge_ready." })),
  head_sha: Type.Optional(Type.String({ description: "Required for merge_ready: full 40-hex PR head commit SHA." })),
});

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

// The bridge puts the complete MCP envelope in structuredContent. Its model
// content is the fallback for persisted or text-only results.
function payload(value: unknown): RecordValue | undefined {
  const outer = record(value);
  if (!outer) return;
  const structured = record(outer.structuredContent);
  if (structured) return payload(structured) ?? structured;
  if (Array.isArray(outer.content)) {
    for (const part of outer.content) {
      const block = record(part);
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      try {
        const parsed = record(JSON.parse(block.text));
        if (parsed) return payload(parsed) ?? parsed;
      } catch { /* Plain model-facing text is not a status or error code. */ }
    }
  }
  return outer;
}

function failed(value: unknown): boolean {
  const outer = record(value);
  return outer?.isError === true || record(outer?.structuredContent)?.isError === true;
}

function errorCode(value: unknown): unknown {
  const data = payload(value);
  return record(data?.error)?.code ?? data?.code;
}

function taskLiveness(data: RecordValue): "live" | "terminal" | "unknown" {
  if (data.hasPendingChildRuns === true || data.workState === "waiting_for_children") return "live";
  if (["queued", "running", "waiting"].includes(String(data.status))) return "live";
  if (["completed", "failed", "cancelled", "interrupted"].includes(String(data.status)) &&
      data.hasPendingChildRuns === false && data.workState === "result_available") return "terminal";
  return "unknown";
}

function messageText(content: string | { type: string; text?: string }[]): string {
  return typeof content === "string" ? content :
    content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function latestTarget(text: string): string | undefined {
  let target: string | undefined;
  for (const match of text.matchAll(/^CoS-thread:[ \t]+([^\s]+)[ \t]*\r?$/gm)) target = match[1];
  return target;
}

function t3Tool(name: string, operation: string): boolean {
  return name === `mcp__t3-code__${operation}` || name === `mcp__t3_code__${operation}`;
}

export default function reportToCos(pi: ExtensionAPI) {
  let sessionId: string | undefined;
  let target: string | undefined;
  let firstPromptSeen = false;
  let registered = false;
  let disabled = false;
  let reported = false;
  let reminded = false;
  let run = 0;
  const authorizedParents = new Set<string>();
  const candidates = new Set<string>();

  function resetRun() {
    run++;
    reported = false;
    reminded = false;
  }

  // T3 delivers terminal task notifications through ordinary RPC input. This
  // exact transport notice retires stale observations even before task_status.
  function observeCompletion(text: string) {
    const task = /^Delegated task (\S+) reached a terminal state\. Use task_status with taskId \1 to read the result\.$/.exec(text.trim());
    if (task) candidates.delete(task[1]);
  }

  function observeTask(value: unknown, cancelled = false) {
    if (failed(value)) return;
    const data = payload(value);
    if (typeof data?.taskId !== "string") return;
    const cancelAccepted = cancelled &&
      ["cancel_requested", "completed", "failed", "cancelled", "interrupted"].includes(String(data.status));
    if (cancelAccepted || taskLiveness(data) === "terminal") candidates.delete(data.taskId);
    else candidates.add(data.taskId);
  }

  function register(exposure: "direct" | "hidden") {
    pi.registerTool({
      name: "report_to_cos",
      label: "Report to CoS",
      exposure,
      description: "Report to the chief of staff. Use go_request for design, scope and protected-surface approvals, merge_ready for a reviewed PR, done for completion, blocked for an obstacle, or tobias_decision for a decision Tobias must make. finding is the only non-terminal report: send it as soon as evidence changes a reported failure's known cause. Do not send routine progress. done requires outcome green or red. blocked, finding and red done require failure.step, failure.cause (evidence-backed explanation or literal unknown), and failure.evidence (paths/commands inspected). Unknown cause also requires failure.next_probe and failure.diagnosis_owner. merge_ready requires pr_url and head_sha.",
      promptGuidelines: [
        "Use report_to_cos, not t3_thread_send, to report to the CoS thread. Report before settling unless a delegated child is still live. A finding does not replace a final report.",
        "Send a finding that changes a reported failure's known cause as soon as you have it; it is the only non-terminal report, not routine progress.",
        "Explain failures before handing them off: blocked, finding and done outcome red require failure.step, cause and evidence inspected. Use cause unknown if unestablished, with next_probe and diagnosis_owner. done always requires an explicit green/red outcome; completion of an assignment does not make a failed check green.",
      ],
      parameters: PARAMETERS,
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const destination = target;
        const leadSession = ctx.sessionManager.getSessionId();
        const reportRun = run;
        if (!destination || leadSession !== sessionId) throw new Error("No CoS marker in the first user message");
        if (!params.text.trim()) throw new Error("Report text must not be empty");
        if (params.kind === "done" && !params.outcome) {
          throw new Error("Missing outcome: done requires green or red so a failed/RED outcome cannot omit failure details");
        }
        const failureReason = params.kind === "blocked" ? "blocked reports must explain the obstacle" :
          params.kind === "finding" ? "findings must explain the changed cause of a reported failure" :
          params.outcome === "red" ? "red outcomes must explain the failure" : undefined;
        if (failureReason && !params.failure) {
          throw new Error(`Missing failure: ${failureReason}; provide step, cause and evidence`);
        }
        if (params.failure) {
          const required = params.failure.cause?.trim() === "unknown" ? FAILURE_FIELDS : FAILURE_FIELDS.slice(0, 3);
          for (const field of required) {
            if (!params.failure[field]?.trim()) {
              const why = field === "step" ? "identify the failing phase or step" :
                field === "cause" ? "provide an evidence-backed explanation or the literal unknown" :
                field === "evidence" ? "name the paths/commands actually inspected to support the explanation" :
                field === "next_probe" ? "unknown cause requires the next observation to distinguish remaining explanations" :
                "unknown cause requires who keeps diagnosing";
              throw new Error(`Missing failure.${field}: ${why}`);
            }
          }
        }
        if (params.kind === "merge_ready") {
          if (!params.pr_url || !/^https?:\/\//.test(params.pr_url)) throw new Error("merge_ready requires a PR URL");
          const url = new URL(params.pr_url);
          if (!url.hostname || url.username || url.password) throw new Error("merge_ready requires a PR URL without credentials");
          if (!params.head_sha || !/^[0-9a-fA-F]{40}$/.test(params.head_sha)) throw new Error("merge_ready requires a 40-hex head_sha");
        }
        const message = `[${params.kind}] ${params.text}` +
          (params.outcome ? `\noutcome: ${params.outcome}` : "") +
          (params.failure ? FAILURE_FIELDS.filter((field) => params.failure![field] !== undefined)
            .map((field) => `\nfailure.${field}: ${params.failure![field]}`).join("") : "") +
          (params.pr_url ? `\nPR: ${params.pr_url}` : "") +
          (params.head_sha ? `\nHead: ${params.head_sha}` : "");
        const identity = params.kind === "merge_ready" ? params.head_sha!.toLowerCase() : message;
        const requestId = "cos-" + createHash("sha256")
          .update(JSON.stringify([leadSession, destination, params.kind, identity])).digest("hex");
        authorizedParents.add(toolCallId);
        try {
          const args = { threadId: destination, message, clientRequestId: requestId };
          let outcome = await ctx.executeTool(SEND, { ...args, mode: "steer" }, { signal });
          if ((outcome.isError || failed(outcome.result)) && errorCode(outcome.result) === "thread_not_sendable") {
            outcome = await ctx.executeTool(SEND, { ...args, mode: "auto" }, { signal });
          }
          if (outcome.isError || failed(outcome.result)) {
            return { ...outcome.result, isError: true };
          }
          const receipt = payload(outcome.result);
          if (receipt?.threadId !== destination || typeof receipt.messageId !== "string" ||
              !["started", "queued", "steered", "restarted"].includes(String(receipt.delivery))) {
            throw new Error("CoS send returned no acceptance receipt");
          }
          if (params.kind !== "finding" && sessionId === leadSession && run === reportRun && target === destination) reported = true;
          return {
            content: [{ type: "text", text: `Reported [${params.kind}] to CoS (${receipt.delivery}).` }],
            details: { kind: params.kind, threadId: destination, requestId, messageId: receipt.messageId },
          };
        } finally {
          authorizedParents.delete(toolCallId);
        }
      },
    });
    registered = true;
  }

  function activate(ctx: ExtensionContext, prompt?: string) {
    const current = ctx.sessionManager.getSessionId();
    if (current !== sessionId) {
      sessionId = current;
      target = undefined;
      disabled = false;
      firstPromptSeen = false;
      candidates.clear();
      authorizedParents.clear();
      resetRun();
      if (registered) register("hidden");
    }
    if (firstPromptSeen) return;
    const branch = ctx.sessionManager.getBranch();
    const first = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
    let text = prompt;
    if (first?.type === "message" && first.message.role === "user") {
      text = messageText(first.message.content);
    }
    if (text === undefined) return;
    const initialTarget = latestTarget(text);
    if (initialTarget) {
      target = initialTarget;
      register("direct");
      for (const entry of branch) {
        if (entry.type === "message" && entry.message.role === "toolResult" &&
            (t3Tool(entry.message.toolName, "delegate_task") || t3Tool(entry.message.toolName, "task_status") ||
             t3Tool(entry.message.toolName, "task_cancel"))) {
          observeTask(entry.message, t3Tool(entry.message.toolName, "task_cancel"));
        } else if (entry.type === "message" && entry.message.role === "user") {
          const content = messageText(entry.message.content);
          target = latestTarget(content) ?? target;
          observeCompletion(content);
        }
      }
    }
    firstPromptSeen = true;
  }

  pi.on("session_start", (_event, ctx) => {
    try { activate(ctx); } catch { disabled = true; }
  });
  pi.on("input", (event, ctx) => {
    if (disabled) return;
    try {
      activate(ctx, event.text);
      if (target) {
        target = latestTarget(event.text) ?? target;
        observeCompletion(event.text);
      }
    } catch { disabled = true; }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (disabled) return;
    try {
      activate(ctx, event.prompt);
      if (target) {
        target = latestTarget(event.prompt) ?? target;
        resetRun();
      }
    } catch { disabled = true; }
  });
  // Steering and queued user messages can arrive without before_agent_start.
  // Custom reminder entries are not user messages and cannot reset this guard.
  pi.on("message_start", (event) => {
    if (disabled) return;
    try {
      if (target && event.message.role === "user") {
        target = latestTarget(messageText(event.message.content)) ?? target;
        resetRun();
      }
    } catch { disabled = true; }
  });
  pi.on("tool_call", (event) => {
    if (disabled) return;
    try {
      if (!target || !t3Tool(event.toolName, "t3_thread_send") || record(event.input)?.threadId !== target) return;
      if (event.parentToolCallId && authorizedParents.has(event.parentToolCallId)) return;
      return { block: true, reason: `use report_to_cos (kinds: ${KINDS.join(", ")})` };
    } catch { disabled = true; }
  });
  pi.on("tool_result", (event) => {
    if (disabled) return;
    try {
      if (target && (t3Tool(event.toolName, "delegate_task") || t3Tool(event.toolName, "task_status") ||
                     t3Tool(event.toolName, "task_cancel"))) {
        observeTask(event, t3Tool(event.toolName, "task_cancel"));
      }
    } catch { disabled = true; }
  });
  pi.on("agent_before_settle", (event) => {
    if (disabled) return;
    try {
      // Lifecycle contexts cannot call tools. Use observed child results only;
      // unresolved or uncertain candidates allow settlement without a reminder.
      if (!target || reported || reminded || candidates.size > 0 ||
          event.outcome !== "completed") return;
      reminded = true;
      return {
        entries: [...event.entries, {
          type: "custom_message", customType: "report-to-cos-reminder", display: false,
          content: "Before settling, either use report_to_cos to send the chief of staff the outcome, blocker, approval request, or decision, or leave a delegated child running. A finding alone does not replace this final report. done requires outcome green/red; blocked and red outcomes require structured failure details, including next_probe and diagnosis_owner when cause is unknown. Do not send routine progress. This reminder is issued only once for this external run.",
        }],
        continue: true,
      };
    } catch { disabled = true; }
  });
}
