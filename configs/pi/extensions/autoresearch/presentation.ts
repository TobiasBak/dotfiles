import type { FleetSnapshot } from "./state.ts";

export type FleetWidgetSegmentRole = "frame" | "group" | "status" | "model" | "metadata" | "summary";

export interface FleetWidgetLine {
  kind: "group" | "worker";
  status?: string;
  segments: Array<{ role: FleetWidgetSegmentRole; text: string }>;
}

export interface FleetDashboardOptions {
  now?: number;
  canonicalHead?: string;
  canonicalDirty?: boolean;
  canonicalChanged?: boolean;
  protocolChanged?: boolean;
}

const STATUS_PRESENTATION: Record<string, { marker: string; label: string }> = {
  queued: { marker: "○", label: "queued" },
  launching: { marker: "○", label: "launching" },
  running: { marker: "●", label: "running" },
  idle: { marker: "○", label: "idle" },
  parked: { marker: "◇", label: "parked" },
  paused: { marker: "■", label: "paused" },
  blocked: { marker: "!", label: "blocked" },
  failed: { marker: "×", label: "failed" },
  complete: { marker: "✓", label: "done" },
  stopped: { marker: "■", label: "stopped" },
};

function text(value: unknown, fallback = "-"): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.replace(/\s+/g, " ").trim();
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function shortSessionId(value: unknown): string {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : "????????";
}

function clip(value: unknown, length: number): string {
  const normalized = text(value);
  return normalized.length <= length ? normalized : `${normalized.slice(0, Math.max(0, length - 1))}…`;
}

export function formatElapsed(since: unknown, now = Date.now()): string {
  if (typeof since !== "number" || !Number.isFinite(since)) return "--:--";
  const totalSeconds = Math.max(0, Math.floor((now - since) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

function formatTokens(value: unknown): string {
  const tokens = Math.max(0, finiteNumber(value));
  if (tokens < 1_000) return String(Math.floor(tokens));
  const thousands = tokens / 1_000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

function formatModel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const id = value.split("/").at(-1) ?? value;
  if (id.endsWith("-sol")) return "Sol";
  if (id.endsWith("-luna")) return "Luna";
  return id;
}

function formatThinking(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function activeIntent(snapshot: FleetSnapshot, workerId: unknown): Record<string, unknown> | undefined {
  return snapshot.intents.find((intent) => intent.worker_id === workerId && intent.status === "active");
}

function workerTask(snapshot: FleetSnapshot, worker: Record<string, unknown>): string {
  const intent = activeIntent(snapshot, worker.worker_id);
  const task = text(intent?.question, text(worker.task, "Selecting research direction"));
  const summary = text(worker.summary, "");
  return summary && summary !== task ? `${task} · ${summary}` : task;
}

export function fleetDashboardWidgetLines(
  snapshot: FleetSnapshot,
  options: FleetDashboardOptions = {},
): FleetWidgetLine[] {
  const now = options.now ?? Date.now();
  const fleetStatus = text(snapshot.fleet?.status, "off");
  const canonical = options.canonicalHead ? options.canonicalHead.slice(0, 8) : "unknown";
  const markers = `${options.canonicalDirty ? " dirty" : ""}${options.canonicalChanged ? " head-changed" : ""}${options.protocolChanged ? " protocol-change" : ""}`;
  const workerCount = snapshot.workers.length;
  const completedCampaigns = Math.max(0, Math.floor(finiteNumber(snapshot.fleet?.completed_campaigns)));
  const frontier = Math.max(0, Math.floor(finiteNumber(snapshot.fleet?.frontier_version)));
  const lines: FleetWidgetLine[] = [{
    kind: "group",
    segments: [
      { role: "frame", text: "┌─ " },
      { role: "group", text: "autoresearch" },
      { role: "metadata", text: ` · ${fleetStatus} · ${workerCount} worker${workerCount === 1 ? "" : "s"} · ${completedCampaigns} campaign${completedCampaigns === 1 ? "" : "s"} completed · frontier ${frontier} · canonical ${canonical}${markers}` },
    ],
  }];

  snapshot.workers.forEach((worker, index) => {
    const statusValue = text(worker.status, "idle");
    const status = STATUS_PRESENTATION[statusValue] ?? { marker: "?", label: statusValue };
    const connector = index === snapshot.workers.length - 1 ? "└─" : "├─";
    const turns = Math.max(0, Math.floor(finiteNumber(worker.turns)));
    const tools = Math.max(0, Math.floor(finiteNumber(worker.tool_calls)));
    const model = formatModel(worker.model);
    const thinking = formatThinking(worker.thinking);
    const contextWindow = Math.max(0, finiteNumber(worker.context_window));
    const stage = text(worker.stage, "");
    const currentTool = text(worker.current_tool, "");
    const activity = [
      stage || undefined,
      currentTool ? `${currentTool} ${formatElapsed(worker.current_tool_started_at, now)}` : undefined,
    ].filter((item): item is string => Boolean(item)).join(" · ");
    const modelLabel = model && [model, thinking].filter(Boolean).join(" · ");
    const metadata = [
      `$${Math.max(0, finiteNumber(worker.cost)).toFixed(3)}`,
      `${tools} tool${tools === 1 ? "" : "s"}`,
      contextWindow > 0 ? `${formatTokens(worker.context_tokens)}/${formatTokens(contextWindow)} ctx` : undefined,
      activity || undefined,
    ].filter((item): item is string => Boolean(item));
    const elapsedUntil = ["complete", "failed", "stopped"].includes(statusValue)
      ? finiteNumber(worker.last_seen, now)
      : now;
    const statusText = `${status.marker} ${status.label.padEnd(9)} age ${formatElapsed(worker.started_at, elapsedUntil)}`;

    lines.push({
      kind: "worker",
      status: statusValue,
      segments: [
        { role: "frame", text: `${connector} [${text(worker.worker_id)}:${shortSessionId(worker.session_id)}] ` },
        { role: "status", text: statusText },
        { role: "metadata", text: `  ${turns} turn${turns === 1 ? "" : "s"}` },
        ...(modelLabel || metadata.length > 0 ? [{ role: "frame" as const, text: " │ " }] : []),
        ...(modelLabel ? [{ role: "model" as const, text: modelLabel }] : []),
        ...(metadata.length > 0 ? [{ role: "metadata" as const, text: `${modelLabel ? " · " : ""}${metadata.join(" · ")}` }] : []),
        { role: "frame", text: " │ " },
        { role: "summary", text: workerTask(snapshot, worker) },
      ],
    });
  });
  return lines;
}

export function fleetDashboardLines(snapshot: FleetSnapshot, options: FleetDashboardOptions = {}): string[] {
  return fleetDashboardWidgetLines(snapshot, options).map((line) => line.segments.map((segment) => segment.text).join(""));
}

export function compactFleetContext(snapshot: FleetSnapshot): string {
  const recentOutcomes = snapshot.intents.filter((intent) => intent.status !== "active" && typeof intent.outcome === "string").slice(0, 5)
    .map((intent) => `${text(intent.worker_id)}:${text(intent.outcome)}`).join(", ");
  const rows = snapshot.workers.map((worker) => {
    const intent = activeIntent(snapshot, worker.worker_id);
    return `- ${text(worker.worker_id)} ${shortSessionId(worker.session_id)}: ${text(worker.status)}; process=${text(worker.process_state)}; intent=${clip(intent?.question, 140)}; experiment=${clip(intent?.experiment, 160)}; stage=${text(worker.stage)}; tool=${text(worker.current_tool)}; summary=${clip(worker.summary, 180)}; error=${clip(worker.error, 180)}`;
  });
  return [
    `[autoresearch fleet snapshot; informational operational state, not Git truth; generation ${String(snapshot.fleet?.generation ?? "?")}; frontier ${String(snapshot.fleet?.frontier_version ?? 0)}]`,
    recentOutcomes ? `Recent outcomes: ${recentOutcomes}` : "Recent outcomes: none",
    ...rows,
  ].join("\n");
}

export function compactWorkerContext(snapshot: FleetSnapshot, workerId: string): string {
  const intentions = snapshot.intents
    .filter((intent) => intent.status === "active")
    .map((intent) => `${text(intent.worker_id)}: ${clip(intent.question, 120)} -> ${clip(intent.experiment, 140)}`);
  const own = snapshot.intents.find((intent) => intent.worker_id === workerId && intent.status === "active");
  const recentOutcomes = snapshot.intents.filter((intent) => intent.status !== "active" && typeof intent.outcome === "string").slice(0, 5)
    .map((intent) => `${text(intent.worker_id)}:${text(intent.outcome)}`).join(", ");
  return [
    `[autoresearch shared state for ${workerId}; informational, non-exclusive, and not Git truth; frontier ${String(snapshot.fleet?.frontier_version ?? 0)}]`,
    own
      ? `Your active intent: ${text(own.question)}; experiment=${text(own.experiment)}; reason=${text(own.reason)}`
      : "You have no active intent. Read durable research and choose a valuable direction before publishing one.",
    intentions.length > 0 ? `Active worker intentions: ${intentions.join(" | ")}` : "Active worker intentions: none.",
    recentOutcomes ? `Recent outcomes: ${recentOutcomes}` : "Recent outcomes: none.",
    "Choose a different mechanism from active intents by default. Overlap is allowed only when independent replication or a materially different evidence path answers a specific uncertainty; justify that overlap explicitly in the intent reason.",
  ].join("\n");
}

const MODEL_HIDDEN_FIELDS = new Set([
  "canonical_root", "parent_session", "worktree", "session_dir", "session_file", "launch_receipt", "continuation_command",
]);

function modelVisibleRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !MODEL_HIDDEN_FIELDS.has(key)));
}

export function modelVisibleSnapshot(snapshot: FleetSnapshot): FleetSnapshot {
  return {
    fleet: snapshot.fleet ? modelVisibleRow(snapshot.fleet) : null,
    workers: snapshot.workers.map(modelVisibleRow),
    intents: snapshot.intents.map(modelVisibleRow),
    checkpoints: snapshot.checkpoints.map(modelVisibleRow),
    events: snapshot.events.map(modelVisibleRow),
  };
}

export function boundedInspect(snapshot: FleetSnapshot, view: "summary" | "recent"): Record<string, unknown> {
  const visible = modelVisibleSnapshot(snapshot);
  const base = { fleet: visible.fleet, workers: visible.workers, intents: visible.intents };
  return view === "recent" ? { ...base, checkpoints: visible.checkpoints, events: visible.events } : base;
}
