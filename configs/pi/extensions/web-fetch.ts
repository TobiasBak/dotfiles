import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

function htmlToReadableText(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();

  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return cleanLabel ? `${cleanLabel} (${href})` : href;
    })
    .replace(/<[^>]+>/g, " ");

  text = decodeHtmlEntities(text)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const cleanTitle = title ? decodeHtmlEntities(title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) : undefined;
  return cleanTitle ? `# ${cleanTitle}\n\n${text}` : text;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch an HTTP or HTTPS URL and return concise, readable text by default.",
    promptSnippet: "Fetch HTTP/HTTPS URLs and return cleaned readable text with status and content type.",
    promptGuidelines: [
      "Use web_fetch when the user asks to read a web page, online documentation, or a URL.",
      "Use web_fetch only for HTTP or HTTPS URLs.",
      "Do not use web_fetch for local files; use read instead.",
      "Prefer the default cleaned output. Request raw output only when the user needs exact HTML, XML, JSON, or source text.",
      "Keep maxBytes small unless the user explicitly asks for a full page or large document.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "HTTP or HTTPS URL to fetch.",
      }),
      maxBytes: Type.Optional(
        Type.Number({
          description: "Maximum number of characters to return. Defaults to 30000 and is capped at 120000.",
          default: 30000,
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description: "Return raw response text instead of cleaning HTML. Use for JSON, XML, source files, or exact HTML inspection.",
          default: false,
        }),
      ),
      reader: Type.Optional(
        Type.Boolean({
          description: "Use Jina Reader to convert the page to LLM-friendly Markdown. This sends the URL to r.jina.ai. Useful for noisy pages or search results.",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      let url: URL;
      try {
        url = new URL(params.url);
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid URL: ${params.url}` }],
        };
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {
          isError: true,
          content: [{ type: "text", text: "Only http:// and https:// URLs are allowed." }],
        };
      }

      const requestedUrl = url.href;
      const fetchUrl = params.reader ? `https://r.jina.ai/${requestedUrl}` : requestedUrl;
      const maxBytes = Math.min(Math.max(params.maxBytes ?? 30000, 1000), 120000);

      try {
        const response = await fetch(fetchUrl, {
          signal,
          headers: {
            "user-agent": "pi-agent-web-fetch/1.1",
            accept: params.reader
              ? "text/markdown,text/plain,*/*"
              : "text/html,text/plain,application/json,application/xml,text/xml,*/*",
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const rawText = await response.text();
        const shouldClean = !params.raw && !params.reader && /html/i.test(contentType);
        const outputText = shouldClean ? htmlToReadableText(rawText) : rawText;

        const truncated = outputText.length > maxBytes;
        const body = truncated ? outputText.slice(0, maxBytes) : outputText;

        return {
          content: [
            {
              type: "text",
              text:
                `URL: ${requestedUrl}\n` +
                `Fetched URL: ${fetchUrl}\n` +
                `Status: ${response.status} ${response.statusText}\n` +
                `Content-Type: ${contentType}\n` +
                `Mode: ${params.reader ? "reader" : params.raw ? "raw" : shouldClean ? "cleaned-html" : "text"}\n` +
                `Truncated: ${truncated}\n\n` +
                body,
            },
          ],
          details: {
            url: requestedUrl,
            fetchedUrl: fetchUrl,
            status: response.status,
            statusText: response.statusText,
            contentType,
            mode: params.reader ? "reader" : params.raw ? "raw" : shouldClean ? "cleaned-html" : "text",
            truncated,
            returnedCharacters: body.length,
            originalCharacters: rawText.length,
            outputCharacters: outputText.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to fetch ${requestedUrl}: ${message}` }],
          details: { url: requestedUrl, error: message },
        };
      }
    },
  });
}
