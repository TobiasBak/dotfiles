import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFERRED_WEB_TOOLS = ["fetch_content", "get_search_content"] as const;
const DEFERRED_WEB_TOOL_SET = new Set<string>(DEFERRED_WEB_TOOLS);
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()]+/i;

export function promptContainsUrl(prompt: string): boolean {
  return URL_PATTERN.test(prompt);
}

export function setDeferredWebToolsActive(pi: ExtensionAPI, enabled: boolean): string[] {
  const active = pi.getActiveTools();
  const next = enabled
    ? [...new Set([...active, ...DEFERRED_WEB_TOOLS])]
    : active.filter((name) => !DEFERRED_WEB_TOOL_SET.has(name));

  if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
    pi.setActiveTools(next);
  }

  return next;
}

interface WebSearchResultDetails {
  searchId?: unknown;
  fetchId?: unknown;
  fetchUrls?: unknown;
  queryCount?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildWebSearchRetrievalHint(details: unknown, visibleText = ""): string | undefined {
  if (!details || typeof details !== "object") return undefined;

  const result = details as WebSearchResultDetails;
  const searchId = nonEmptyString(result.searchId);
  const fetchId = nonEmptyString(result.fetchId);
  const lines: string[] = [];

  if (searchId && !visibleText.includes(searchId)) {
    const queryCount =
      typeof result.queryCount === "number" && Number.isInteger(result.queryCount) && result.queryCount > 0
        ? result.queryCount
        : undefined;
    const range = queryCount && queryCount > 1 ? ` Valid queryIndex values: 0-${queryCount - 1}.` : "";
    lines.push(
      `Search results responseId: "${searchId}". ` +
        `Use get_search_content({ responseId: "${searchId}", queryIndex: 0 }).${range}`,
    );
  }

  if (fetchId && !visibleText.includes(fetchId)) {
    const pending = Array.isArray(result.fetchUrls) && result.fetchUrls.length > 0;
    lines.push(
      pending
        ? `Full-page content is being fetched under responseId: "${fetchId}". Wait for the content-ready notification before using get_search_content({ responseId: "${fetchId}", urlIndex: 0 }).`
        : `Full-page content responseId: "${fetchId}". Use get_search_content({ responseId: "${fetchId}", urlIndex: 0 }).`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    setDeferredWebToolsActive(pi, false);
  });

  pi.on("before_agent_start", (event) => {
    if (promptContainsUrl(event.prompt)) {
      setDeferredWebToolsActive(pi, true);
    }
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "web_search") {
      setDeferredWebToolsActive(pi, true);
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "get_search_content") {
      const details = event.details as { error?: unknown } | undefined;
      if (typeof details?.error === "string") return { isError: true };
      return;
    }

    if (event.toolName !== "web_search") return;

    const visibleText = event.content
      .filter((block): block is Extract<(typeof event.content)[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const hint = buildWebSearchRetrievalHint(event.details, visibleText);
    if (!hint) return;

    const firstTextIndex = event.content.findIndex((block) => block.type === "text");
    if (firstTextIndex === -1) {
      return { content: [...event.content, { type: "text" as const, text: hint }] };
    }

    return {
      content: event.content.map((block, index) =>
        index === firstTextIndex && block.type === "text"
          ? { ...block, text: `${block.text}\n\n---\n${hint}` }
          : block,
      ),
    };
  });

  pi.registerCommand("web-tools", {
    description: "Show or change deferred web fetch tool availability: /web-tools [on|off]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") setDeferredWebToolsActive(pi, true);
      else if (action === "off") setDeferredWebToolsActive(pi, false);
      else if (action !== "") {
        ctx.ui.notify("Usage: /web-tools [on|off]", "warning");
        return;
      }

      const active = pi.getActiveTools();
      const enabled = DEFERRED_WEB_TOOLS.filter((name) => active.includes(name));
      ctx.ui.notify(
        enabled.length === DEFERRED_WEB_TOOLS.length
          ? `Deferred web tools active: ${enabled.join(", ")}`
          : "Deferred web tools inactive. They activate after web_search or before prompts containing a URL.",
        "info",
      );
    },
  });
}
