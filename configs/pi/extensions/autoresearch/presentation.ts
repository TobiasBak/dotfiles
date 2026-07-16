import type { FleetSnapshot } from "./state.ts";

function text(value: unknown, fallback = "-"): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.replace(/\s+/g, " ").trim();
}

function shortSessionId(value: unknown): string {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : "????????";
}

function clip(value: unknown, length: number): string {
  const normalized = text(value);
  return normalized.length <= length ? normalized : `${normalized.slice(0, Math.max(0, length - 1))}…`;
}

export function formatElapsed(since: unknown, now = Date.now()): string {
  if (typeof since !== "number" || !Number.isFinite(since)) return "-";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function fleetDashboardLines(snapshot: FleetSnapshot, options: {
  now?: number;
  canonicalHead?: string;
  canonicalDirty?: boolean;
  canonicalChanged?: boolean;
  protocolChanged?: boolean;
} = {}): string[] {
  const now = options.now ?? Date.now();
  const fleetStatus = text(snapshot.fleet?.status, "off");
  const canonical = options.canonicalHead ? options.canonicalHead.slice(0, 8) : "unknown";
  const markers = `${options.canonicalDirty ? " dirty" : ""}${options.canonicalChanged ? " head-changed" : ""}${options.protocolChanged ? " protocol-change" : ""}`;
  const lines = [`autoresearch fleet ${fleetStatus} | canonical ${canonical}${markers}`];
  for (const worker of snapshot.workers) {
    const stage = text(worker.current_tool, text(worker.stage, "idle"));
    const elapsed = formatElapsed(worker.last_seen ?? worker.started_at, now);
    lines.push(`${text(worker.worker_id)} ${shortSessionId(worker.session_id)} ${text(worker.status)} | ${clip(stage, 22)} | ${elapsed} | ${clip(worker.summary, 56)}`);
  }
  lines.push(`evidence ${snapshot.evidence.active}/${snapshot.evidence.max} active`);
  return lines;
}

export function compactFleetContext(snapshot: FleetSnapshot): string {
  const rows = snapshot.workers.map((worker) => {
    const reservation = snapshot.reservations.some((item) => item.worker_id === worker.worker_id) ? " evidence=reserved" : "";
    return `- ${text(worker.worker_id)} ${shortSessionId(worker.session_id)}: ${text(worker.status)}; stage=${text(worker.stage)}; tool=${text(worker.current_tool)}; summary=${clip(worker.summary, 180)}${reservation}`;
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
