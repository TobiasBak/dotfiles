import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRAGMATIC_STYLE =
  "Use a pragmatic communication style. Be direct, concise, and action-oriented. Prioritize concrete results and recommendations. State assumptions and material tradeoffs briefly; omit unnecessary narration.";

const OPENAI_APIS = new Set([
  "openai-codex-responses",
  "openai-responses",
  "openai-completions",
]);

const OPENAI_RESPONSES_APIS = new Set([
  "openai-codex-responses",
  "openai-responses",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGptModel(model: { id: string; api: string } | undefined): boolean {
  if (!model || !OPENAI_APIS.has(model.api)) return false;
  return /(?:^|\/)gpt-/i.test(model.id);
}

export default function gptStyle(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!isGptModel(ctx.model)) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${PRAGMATIC_STYLE}`,
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isGptModel(ctx.model) || !OPENAI_RESPONSES_APIS.has(ctx.model.api)) return;
    if (!isRecord(event.payload)) return;

    const payload = event.payload;
    const text = isRecord(payload.text) ? payload.text : {};
    const nextPayload: Record<string, unknown> = {
      ...payload,
      text: { ...text, verbosity: "low" },
    };

    if (isRecord(payload.reasoning)) {
      nextPayload.reasoning = { ...payload.reasoning, summary: "concise" };
    }

    return nextPayload;
  });
}
