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
