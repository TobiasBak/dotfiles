import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

type RateLimitWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

type UsagePayload = {
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: RateLimitWindow;
    secondary_window?: RateLimitWindow;
  };
  additional_rate_limits?: Array<{
    limit_name?: string;
    metered_feature?: string;
    rate_limit?: {
      allowed?: boolean;
      limit_reached?: boolean;
      primary_window?: RateLimitWindow;
      secondary_window?: RateLimitWindow;
    };
  }>;
};

function decodeJwtPayload(token: string): any | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function getAccountId(token: string): string | undefined {
  try {
    const payload = decodeJwtPayload(token);
    const accountId = payload?.[OPENAI_AUTH_CLAIM]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function fmtDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "unknown window";
  const mins = Math.round(seconds / 60);
  if (mins % (60 * 24 * 7) === 0) return `${mins / (60 * 24 * 7)}w`;
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function fmtReset(unixSeconds?: number): string {
  if (!unixSeconds) return "reset unknown";
  const ms = unixSeconds * 1000;
  const diff = ms - Date.now();
  const mins = Math.max(0, Math.round(diff / 60000));
  const when = new Date(ms).toLocaleString();
  if (mins >= 60) return `resets in ${Math.round(mins / 60)}h (${when})`;
  return `resets in ${mins}m (${when})`;
}

function fmtWindow(label: string, window?: RateLimitWindow): string | undefined {
  if (!window) return undefined;
  const used = typeof window.used_percent === "number" ? window.used_percent : 0;
  const left = Math.max(0, 100 - used);
  const duration = fmtDuration(window.limit_window_seconds);
  return `${label || duration} limit: ${used.toFixed(0)}% used, ${left.toFixed(0)}% left, ${fmtReset(window.reset_at)}`;
}

function formatUsage(data: UsagePayload, modelName: string): string {
  const lines: string[] = [];
  lines.push(`Codex subscription usage for ${modelName}`);
  if (data.plan_type) lines.push(`Plan: ${data.plan_type}`);

  const primary = fmtWindow("5h", data.rate_limit?.primary_window);
  const secondary = fmtWindow("weekly", data.rate_limit?.secondary_window);
  if (primary) lines.push(primary);
  if (secondary) lines.push(secondary);

  for (const item of data.additional_rate_limits ?? []) {
    const name = item.limit_name ?? item.metered_feature ?? "additional";
    const p = fmtWindow(`${name} ${fmtDuration(item.rate_limit?.primary_window?.limit_window_seconds)}`, item.rate_limit?.primary_window);
    const s = fmtWindow(`${name} ${fmtDuration(item.rate_limit?.secondary_window?.limit_window_seconds)}`, item.rate_limit?.secondary_window);
    if (p) lines.push(p);
    if (s) lines.push(s);
  }

  if (lines.length <= (data.plan_type ? 2 : 1)) {
    lines.push("No displayable limit data returned by OpenAI.");
  }
  return lines.join("\n");
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<string> {
  const model = ctx.model;
  if (!model) return "No model is currently selected.";
  if (model.provider !== "openai-codex" && model.api !== "openai-codex-responses") {
    return `Current model is ${model.provider}/${model.id}, not an OpenAI Codex subscription model.`;
  }
  if (!ctx.modelRegistry.isUsingOAuth(model)) {
    return "Current Codex model is not using subscription/OAuth auth. /usage only works for ChatGPT Codex subscription auth.";
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return `Could not resolve Codex auth: ${auth.ok ? "missing token" : auth.error}`;

  const token = auth.apiKey;
  const accountId = auth.headers?.["chatgpt-account-id"] ?? getAccountId(token);
  if (!accountId) return "Could not determine ChatGPT account id from Codex token.";

  const baseUrl = model.baseUrl.replace(/\/$/, "");
  // Match upstream Codex CLI behavior: ChatGPT backend-api uses /wham/usage,
  // while non-backend Codex API style uses /api/codex/usage.
  const url = baseUrl.includes("/backend-api")
    ? `${baseUrl}/wham/usage`
    : `${baseUrl}/api/codex/usage`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      "User-Agent": "codex-cli",
      originator: "pi",
    },
  });

  const text = await res.text();
  if (!res.ok) return `Codex usage request failed: HTTP ${res.status}\n${text.slice(0, 1000)}`;

  let data: UsagePayload;
  try {
    data = JSON.parse(text);
  } catch {
    return `Codex usage response was not JSON:\n${text.slice(0, 1000)}`;
  }

  return formatUsage(data, `${model.provider}/${model.id}`);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show current Codex subscription rate limits for the selected model",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(await fetchCodexUsage(ctx), "info");
      } catch (err) {
        ctx.ui.notify(`Usage lookup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
