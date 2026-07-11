import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const DEFAULT_TIMEOUT_SECONDS = 25;
const MAX_TIMEOUT_SECONDS = 60;

function checksum(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function selectProvider(): "exa" | "parallel" {
  const override = process.env.PI_WEBSEARCH_PROVIDER ?? process.env.OPENCODE_WEBSEARCH_PROVIDER;
  if (override === "exa" || override === "parallel") return override;
  if (process.env.PARALLEL_API_KEY) return "parallel";
  return "exa";
}

function withTimeout(signal: AbortSignal | undefined, timeoutSeconds: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("web_search request timed out")), timeoutSeconds * 1000);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); } };
}

function parseMcpPayload(payload: string) {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const data = JSON.parse(trimmed) as { result?: { content?: Array<{ type?: string; text?: string }> } };
    return data.result?.content?.find((item) => item.text)?.text;
  } catch {
    return undefined;
  }
}

function parseMcpResponse(body: string) {
  const direct = parseMcpPayload(body);
  if (direct) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const parsed = parseMcpPayload(line.slice(6));
    if (parsed) return parsed;
  }
  return undefined;
}

async function callMcp(url: string, tool: string, args: unknown, signal: AbortSignal | undefined, timeoutSeconds: number, headers: Record<string, string> = {}) {
  const timed = withTimeout(signal, timeoutSeconds);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: timed.signal,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
    if (!response.ok) throw new Error(`Provider returned ${response.status} ${response.statusText}: ${await response.text()}`);
    return parseMcpResponse(await response.text());
  } finally {
    timed.cleanup();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web through Exa or Parallel hosted MCP search providers.",
    promptSnippet: "Search the web for current information and source discovery.",
    promptGuidelines: [
      "Use web_search for discovery, recent info, or facts beyond model cutoff.",
      "Include current year in query for latest/current-event searches.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Web search query." }),
      numResults: Type.Optional(Type.Number({ description: "Number of search results to return. Defaults to 8.", default: 8 })),
      livecrawl: Type.Optional(Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], { description: "Live crawl mode. Defaults to fallback.", default: "fallback" })),
      type: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], { description: "Search type. Defaults to auto.", default: "auto" })),
      contextMaxCharacters: Type.Optional(Type.Number({ description: "Max LLM-optimized context chars. Defaults provider-side." })),
      provider: Type.Optional(Type.Union([Type.Literal("exa"), Type.Literal("parallel")], { description: "Search provider override. Defaults to env/provider availability." })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Request timeout seconds. Defaults to 25 and caps at 60.", default: DEFAULT_TIMEOUT_SECONDS })),
    }),
    async execute(_toolCallId, params, signal) {
      const provider = params.provider ?? selectProvider();
      const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS);
      try {
        const result = provider === "parallel"
          ? await callMcp(PARALLEL_URL, "web_search", {
            objective: params.query,
            search_queries: [params.query],
            session_id: `pi-${checksum(params.query)}`,
          }, signal, timeoutSeconds, {
            "user-agent": "pi-agent-web-search/1.0",
            ...(process.env.PARALLEL_API_KEY ? { authorization: `Bearer ${process.env.PARALLEL_API_KEY}` } : {}),
          })
          : await callMcp(EXA_URL, "web_search_exa", {
            query: params.query,
            type: params.type ?? "auto",
            numResults: params.numResults ?? 8,
            livecrawl: params.livecrawl ?? "fallback",
            contextMaxCharacters: params.contextMaxCharacters,
          }, signal, timeoutSeconds);

        return {
          content: [{
            type: "text",
            text: `Query: ${params.query}\nProvider: ${provider}\n\n${result ?? "No search results found. Try different query."}`,
          }],
          details: { query: params.query, provider },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Failed to search web for ${params.query}: ${message}` }], details: { query: params.query, provider, error: message } };
      }
    },
  });
}
