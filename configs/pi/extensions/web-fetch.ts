import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import TurndownService from "turndown";

const DEFAULT_MAX_BYTES = 9000;
const MIN_MAX_BYTES = 1000;
const MAX_MAX_BYTES = 40000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

function decodeHtmlEntities(text: string) {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[entity] ?? match;
  });
}

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function ipv4InCidr(ip: string, base: string, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isPrivateIp(address: string) {
  const version = isIP(address);
  if (version === 4) {
    return (
      ipv4InCidr(address, "0.0.0.0", 8) ||
      ipv4InCidr(address, "10.0.0.0", 8) ||
      ipv4InCidr(address, "127.0.0.0", 8) ||
      ipv4InCidr(address, "169.254.0.0", 16) ||
      ipv4InCidr(address, "172.16.0.0", 12) ||
      ipv4InCidr(address, "192.168.0.0", 16) ||
      ipv4InCidr(address, "224.0.0.0", 4) ||
      ipv4InCidr(address, "240.0.0.0", 4)
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
    if (lower.startsWith("ff")) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mapped) return isPrivateIp(mapped);
  }
  return version === 0;
}

async function assertPublicHttpUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// and https:// URLs are allowed.");
  const host = url.hostname.toLowerCase();
  if (!host || ["localhost", "metadata", "metadata.google.internal"].includes(host)) throw new Error("Blocked private/internal URL.");
  if (host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".intranet")) {
    throw new Error("Blocked private/internal URL.");
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Blocked private/internal URL.");
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (error) {
    throw new Error(`DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (records.length === 0 || records.some((record) => isPrivateIp(record.address))) throw new Error("Blocked private/internal URL.");
}

function normalizeUrl(input: string) {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed) ? new URL(trimmed) : new URL(`https://${trimmed}`);
}

async function safeFetch(url: URL, init: RequestInit, signal?: AbortSignal) {
  let current = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, { ...init, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current.href, redirects: redirect };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current.href, redirects: redirect };
    current = new URL(location, current);
  }
  throw new Error("Too many redirects.");
}

function stripNoiseHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function htmlToMarkdownish(html: string, sourceUrl: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const main = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
  const body = main && main.length > 600 ? main : html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link", "svg", "noscript", "template"]);
  turndown.addRule("absoluteLinks", {
    filter: "a",
    replacement(content, node) {
      const href = node.getAttribute("href");
      if (!href) return content;
      const absolute = (() => { try { return new URL(href, sourceUrl).href; } catch { return href; } })();
      const label = content.trim() || absolute;
      return `[${label}](${absolute})`;
    },
  });
  const markdown = turndown.turndown(stripNoiseHtml(body))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const cleanTitle = title ? decodeHtmlEntities(title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) : undefined;
  return cleanTitle && !markdown.startsWith("# ") ? `# ${cleanTitle}\n\n${markdown}` : markdown;
}

function withTimeout(signal: AbortSignal | undefined, timeoutSeconds: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutSeconds * 1000);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); } };
}

async function responseTextLimited(response: Response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit).");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit).");
  return new TextDecoder().decode(buffer);
}

async function fetchText(url: URL, signal: AbortSignal | undefined, accept: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
  const timed = withTimeout(signal, timeoutSeconds);
  try {
    const { response, finalUrl, redirects } = await safeFetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        accept,
      },
    }, timed.signal);
    return { response, finalUrl, redirects, text: await responseTextLimited(response), contentType: response.headers.get("content-type") ?? "" };
  } finally {
    timed.cleanup();
  }
}

async function tryLlmsTxt(url: URL, signal?: AbortSignal) {
  const candidates = [new URL("/llms.txt", url), new URL("/llms-full.txt", url)];
  for (const candidate of candidates) {
    try {
      const result = await fetchText(candidate, signal, "text/markdown,text/plain,*/*");
      if (result.response.ok && result.text.trim().length > 0) return { ...result, llmsUrl: candidate.href };
    } catch {
      // Ignore discovery failures; normal fetch can continue.
    }
  }
  return undefined;
}

function maybeFilterByQuery(markdown: string, query?: string) {
  if (!query?.trim()) return markdown;
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  if (terms.length === 0) return markdown;
  const sections = markdown.split(/(?=^#{1,4}\s+)/m);
  const kept = sections.filter((section, index) => index === 0 || terms.some((term) => section.toLowerCase().includes(term)));
  return kept.length > 1 ? kept.join("\n\n") : markdown;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch an HTTP/HTTPS URL and return concise LLM-friendly Markdown/text with SSRF protection.",
    promptSnippet: "Fetch HTTP/HTTPS URLs as concise Markdown/text with SSRF protection and llms.txt/Jina Reader support.",
    promptGuidelines: [
      "Use web_fetch when the user asks to read a web page, online documentation, or a URL.",
      "Use web_fetch only for HTTP or HTTPS URLs; use read for local files.",
      "web_fetch defaults to concise LLM-friendly output; request raw only for exact JSON/XML/source/HTML.",
      "web_fetch supports query for relevant-section extraction when only part of a page matters.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP/HTTPS URL or bare domain to fetch." }),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum characters to return. Defaults to 9000 and caps at 40000.", default: DEFAULT_MAX_BYTES })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Request timeout in seconds. Defaults to 30 and caps at 120.", default: DEFAULT_TIMEOUT_SECONDS })),
      format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], { description: "Output format. Defaults to markdown. raw=true maps to html/raw exact output.", default: "markdown" })),
      raw: Type.Optional(Type.Boolean({ description: "Return raw response text. Use only for exact JSON/XML/source/HTML. Prefer format when possible.", default: false })),
      reader: Type.Optional(Type.Boolean({ description: "Force Jina Reader Markdown. Auto mode already uses it for HTML.", default: false })),
      llms: Type.Optional(Type.Boolean({ description: "Try /llms.txt and /llms-full.txt before normal fetch. Auto-enabled for docs/root-like URLs.", default: false })),
      query: Type.Optional(Type.String({ description: "Optional topic/query. Matching Markdown sections are prioritized before truncation." })),
    }),
    async execute(_toolCallId, params, signal) {
      let requested: URL;
      try {
        requested = normalizeUrl(params.url);
        await assertPublicHttpUrl(requested);
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Invalid or blocked URL: ${params.url}\n${error instanceof Error ? error.message : String(error)}` }] };
      }

      const maxBytes = Math.min(Math.max(params.maxBytes ?? DEFAULT_MAX_BYTES, MIN_MAX_BYTES), MAX_MAX_BYTES);
      const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS);
      const format = params.raw ? "html" : (params.format ?? "markdown");
      const looksDocsRoot = /docs|developer|api|reference/i.test(requested.hostname + requested.pathname) || requested.pathname === "/" || requested.pathname === "";
      const tryLlms = params.llms ?? looksDocsRoot;

      try {
        let mode = "text";
        let fetchedUrl = requested.href;
        let status = 0;
        let statusText = "";
        let contentType = "";
        let redirects = 0;
        let outputText = "";

        if (!params.raw && tryLlms) {
          const llms = await tryLlmsTxt(requested, signal);
          if (llms) {
            mode = "llms.txt";
            fetchedUrl = llms.llmsUrl;
            status = llms.response.status;
            statusText = llms.response.statusText;
            contentType = llms.contentType;
            redirects = llms.redirects;
            outputText = llms.text;
          }
        }

        if (!outputText) {
          const accept = format === "markdown"
            ? "text/markdown;q=1.0,text/plain;q=0.8,text/html;q=0.7,*/*;q=0.1"
            : format === "text"
              ? "text/plain;q=1.0,text/markdown;q=0.9,text/html;q=0.8,*/*;q=0.1"
              : "text/html;q=1.0,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1";
          const first = await fetchText(requested, signal, accept, timeoutSeconds);
          fetchedUrl = first.finalUrl;
          status = first.response.status;
          statusText = first.response.statusText;
          contentType = first.contentType;
          redirects = first.redirects;

          if (/^image\//i.test(contentType)) {
            throw new Error(`Unsupported image content (${contentType}).`);
          }

          if (params.raw || format === "html" || /json|xml|text\/plain/i.test(contentType) && !/html/i.test(contentType)) {
            mode = params.raw ? "raw" : format;
            outputText = first.text;
          } else if (format === "markdown" && (params.reader || /html/i.test(contentType))) {
            try {
              const readerUrl = new URL(`https://r.jina.ai/${requested.href}`);
              const reader = await fetchText(readerUrl, signal, "text/markdown,text/plain,*/*", timeoutSeconds);
              if (reader.response.ok && reader.text.trim()) {
                mode = "jina-reader";
                fetchedUrl = reader.finalUrl;
                status = reader.response.status;
                statusText = reader.response.statusText;
                contentType = reader.contentType;
                redirects = reader.redirects;
                outputText = reader.text;
              } else {
                mode = "readability-fallback";
                outputText = htmlToMarkdownish(first.text, first.finalUrl);
              }
            } catch {
              mode = "readability-fallback";
              outputText = htmlToMarkdownish(first.text, first.finalUrl);
            }
          } else if (format === "text" && /html/i.test(contentType)) {
            mode = "text";
            outputText = htmlToMarkdownish(first.text, first.finalUrl).replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
          } else {
            mode = "text";
            outputText = first.text;
          }
        }

        outputText = maybeFilterByQuery(outputText, params.query);
        const truncated = outputText.length > maxBytes;
        const body = truncated ? `${outputText.slice(0, maxBytes)}\n\n[...truncated: ${outputText.length} chars total, maxBytes=${maxBytes}]` : outputText;

        return {
          content: [{
            type: "text",
            text:
              `URL: ${requested.href}\n` +
              `Fetched URL: ${fetchedUrl}\n` +
              `Status: ${status} ${statusText}\n` +
              `Content-Type: ${contentType}\n` +
              `Mode: ${mode}\n` +
              `Redirects: ${redirects}\n` +
              `Truncated: ${truncated}\n\n` +
              body,
          }],
          details: { url: requested.href, fetchedUrl, status, statusText, contentType, mode, redirects, truncated, returnedCharacters: body.length, outputCharacters: outputText.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `Failed to fetch ${requested.href}: ${message}` }], details: { url: requested.href, error: message } };
      }
    },
  });
}
