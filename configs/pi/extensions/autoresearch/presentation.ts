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
  paused: { marker: "■", label: "paused" },
  blocked: { marker: "!", label: "blocked" },
  decision: { marker: "!", label: "decision" },
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

function workerTask(worker: Record<string, unknown>): string {
  const task = text(worker.task, text(worker.summary, "Claiming a campaign"));
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
  const lines: FleetWidgetLine[] = [{
    kind: "group",
    segments: [
      { role: "frame", text: "┌─ " },
      { role: "group", text: "autoresearch" },
      { role: "metadata", text: ` · ${fleetStatus} · ${workerCount} worker${workerCount === 1 ? "" : "s"} · evidence ${snapshot.evidence.active}/${snapshot.evidence.max} · canonical ${canonical}${markers}` },
    ],
  }];

  const reservedWorkers = new Set(snapshot.reservations.map((reservation) => String(reservation.worker_id)));
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
    const activity = [stage, currentTool].filter(Boolean).join("/");
    const modelLabel = model && [model, thinking].filter(Boolean).join(" · ");
    const metadata = [
      `$${Math.max(0, finiteNumber(worker.cost)).toFixed(3)}`,
      `${tools} tool${tools === 1 ? "" : "s"}`,
      contextWindow > 0 ? `${formatTokens(worker.context_tokens)}/${formatTokens(contextWindow)} ctx` : undefined,
      activity || undefined,
      reservedWorkers.has(String(worker.worker_id)) ? "evidence" : undefined,
    ].filter((item): item is string => Boolean(item));
    const elapsedUntil = ["complete", "failed", "stopped"].includes(statusValue)
      ? finiteNumber(worker.last_seen, now)
      : now;
    const statusText = `${status.marker} ${status.label.padEnd(9)} ${formatElapsed(worker.started_at, elapsedUntil)}`;

    lines.push({
      kind: "worker",
      status: statusValue,
      segments: [
        { role: "frame", text: `${connector} [${text(worker.worker_id)}:${shortSessionId(worker.session_id)}] ` },
        { role: "status", text: statusText },
        { role: "metadata", text: `  ${turns} turn${turns === 1 ? "" : "s"}` },
        { role: "frame", text: " │ " },
        { role: "summary", text: workerTask(worker) },
        ...(modelLabel || metadata.length > 0 ? [{ role: "frame" as const, text: " │ " }] : []),
        ...(modelLabel ? [{ role: "model" as const, text: modelLabel }] : []),
        ...(metadata.length > 0 ? [{ role: "metadata" as const, text: `${modelLabel ? " · " : ""}${metadata.join(" · ")}` }] : []),
      ],
    });
  });
  return lines;
}

export function fleetDashboardLines(snapshot: FleetSnapshot, options: FleetDashboardOptions = {}): string[] {
  return fleetDashboardWidgetLines(snapshot, options).map((line) => line.segments.map((segment) => segment.text).join(""));
}

export function compactFleetContext(snapshot: FleetSnapshot): string {
  const rows = snapshot.workers.map((worker) => {
    const reservation = snapshot.reservations.some((item) => item.worker_id === worker.worker_id) ? " evidence=reserved" : "";
    return `- ${text(worker.worker_id)} ${shortSessionId(worker.session_id)}: ${text(worker.status)}; stage=${text(worker.stage)}; tool=${text(worker.current_tool)}; task=${clip(worker.task, 120)}; summary=${clip(worker.summary, 180)}${reservation}`;
  });
  return [
    `[autoresearch fleet snapshot; operational state, not Git truth; generation ${String(snapshot.fleet?.generation ?? "?")}]`,
    `Evidence capacity: ${snapshot.evidence.active}/${snapshot.evidence.max} active.`,
    ...rows,
  ].join("\n");
}

export function compactWorkerContext(snapshot: FleetSnapshot, workerId: string): string {
  const workers = snapshot.workers.map((worker) =>
    `${text(worker.worker_id)} ${shortSessionId(worker.session_id)}=${text(worker.status)}/${text(worker.stage)}:${clip(worker.summary, 100)}`,
  );
  const claims = snapshot.checkpoints
    .flatMap((checkpoint) => Array.isArray(checkpoint.claimed_scopes) ? checkpoint.claimed_scopes : [])
    .filter((scope): scope is string => typeof scope === "string")
    .slice(0, 12);
  const ownSessionId = snapshot.workers.find((worker) => worker.worker_id === workerId)?.session_id;
  return [
    `[autoresearch shared snapshot for ${workerId}; session ${text(ownSessionId)}; operational state, not Git truth]`,
    `Workers: ${workers.join(" | ") || "none"}`,
    `Evidence: ${snapshot.evidence.active}/${snapshot.evidence.max} active. Reserve before evidence-stage work.`,
    claims.length > 0 ? `Claimed scopes: ${claims.join(", ")}` : "Claimed scopes: none recorded.",
  ].join("\n");
}

export function boundedInspect(snapshot: FleetSnapshot, view: "summary" | "recent"): Record<string, unknown> {
  const base = {
    fleet: snapshot.fleet,
    workers: snapshot.workers,
    evidence: snapshot.evidence,
    reservations: snapshot.reservations,
  };
  return view === "recent"
    ? { ...base, checkpoints: snapshot.checkpoints, events: snapshot.events }
    : base;
}
