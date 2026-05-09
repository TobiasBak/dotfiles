import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const PositionParams = Type.Object({
	file: Type.String({ description: "Python file path, relative to cwd or absolute" }),
	line: Type.Optional(Type.Number({ description: "1-based line number" })),
	col: Type.Optional(Type.Number({ description: "1-based column number" })),
	symbol: Type.Optional(Type.String({ description: "Symbol text to locate when line/col omitted" })),
});

const ReferenceParams = Type.Object({
	file: Type.String({ description: "Python file path, relative to cwd or absolute" }),
	line: Type.Optional(Type.Number({ description: "1-based line number" })),
	col: Type.Optional(Type.Number({ description: "1-based column number" })),
	symbol: Type.Optional(Type.String({ description: "Symbol text to locate when line/col omitted" })),
	includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the symbol declaration in returned references.", default: true })),
});

const FileParams = Type.Object({
	file: Type.Optional(Type.String({ description: "Python file path. If omitted, return cached workspace diagnostics." })),
});

function uriToPath(uri: string): string {
	return fileURLToPath(uri);
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRange(range: any) {
	return {
		start: { line: (range?.start?.line ?? 0) + 1, col: (range?.start?.character ?? 0) + 1 },
		end: { line: (range?.end?.line ?? 0) + 1, col: (range?.end?.character ?? 0) + 1 },
	};
}

function normalizeLocation(loc: any) {
	if (!loc) return null;
	const uri = loc.uri ?? loc.targetUri;
	const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
	return { file: uri ? uriToPath(uri) : undefined, range: normalizeRange(range) };
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSymbolPosition(absFile: string, symbol?: string): { line: number; character: number } {
	if (!symbol) return { line: 0, character: 0 };
	const lines = readFileSync(absFile, "utf8").split(/\r?\n/);
	const exactToken = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(symbol)}(?![A-Za-z0-9_])`);
	for (let i = 0; i < lines.length; i++) {
		const match = exactToken.exec(lines[i]);
		if (match?.index !== undefined) return { line: i, character: match.index };
	}
	throw new Error(`Exact symbol token not found in ${absFile}: ${symbol}`);
}

class PythonLspClient {
	private proc?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private ready?: Promise<void>;
	private diagnostics = new Map<string, any[]>();

	constructor(private cwd: string) {}

	async ensure(signal?: AbortSignal) {
		if (this.ready) return this.ready;
		this.ready = this.start(signal);
		return this.ready;
	}

	private async start(signal?: AbortSignal) {
		const stderrChunks: Buffer[] = [];
		this.proc = spawn("uv", ["run", "--with", "basedpyright", "basedpyright-langserver", "--stdio"], {
			cwd: this.cwd,
			stdio: "pipe",
		});

		this.proc.stdout.on("data", (chunk) => this.onData(chunk));
		this.proc.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		this.proc.on("exit", (code) => {
			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
			const err = new Error(`basedpyright-langserver exited with code ${code}. Command: uv run --with basedpyright basedpyright-langserver --stdio${stderr ? `\n${stderr}` : ""}`);
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
			this.ready = undefined;
			this.proc = undefined;
		});

		const rootUri = pathToFileURL(this.cwd).href;
		await this.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: path.basename(this.cwd) }],
			capabilities: {
				textDocument: { definition: {}, references: {}, hover: {}, documentSymbol: {}, publishDiagnostics: {} },
				workspace: { symbol: {}, workspaceFolders: true },
			},
		}, signal);
		this.notify("initialized", {});
	}

	shutdown() {
		this.proc?.kill();
		this.proc = undefined;
		this.ready = undefined;
	}

	private onData(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.buffer.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length: (\d+)/i.exec(header);
			if (!match) throw new Error("LSP response missing Content-Length");
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (this.buffer.length < bodyEnd) return;
			const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
			this.buffer = this.buffer.subarray(bodyEnd);
			this.handleMessage(JSON.parse(body));
		}
	}

	private handleMessage(msg: any) {
		if (msg.method === "textDocument/publishDiagnostics") {
			this.diagnostics.set(uriToPath(msg.params.uri), msg.params.diagnostics ?? []);
			return;
		}
		if (typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
			else p.resolve(msg.result);
		}
	}

	private send(payload: any) {
		const body = JSON.stringify(payload);
		this.proc?.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
	}

	request(method: string, params: any, signal?: AbortSignal): Promise<any> {
		const id = this.nextId++;
		this.send({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(id);
				reject(new Error("Aborted"));
			};
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve, reject });
		});
	}

	notify(method: string, params: any) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	openFile(absFile: string) {
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri: pathToFileURL(absFile).href,
				languageId: "python",
				version: 1,
				text: readFileSync(absFile, "utf8"),
			},
		});
	}

	getDiagnostics(absFile?: string) {
		if (absFile) return this.diagnostics.get(absFile) ?? [];
		return [...this.diagnostics.entries()].map(([file, diagnostics]) => ({ file, diagnostics }));
	}
}

let client: PythonLspClient | undefined;
let clientCwd: string | undefined;
let lspActive = false;

function absPath(cwd: string, file: string) {
	return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

async function getClient(ctx: any, signal?: AbortSignal) {
	if (!client || clientCwd !== ctx.cwd) {
		client?.shutdown();
		client = new PythonLspClient(ctx.cwd);
		clientCwd = ctx.cwd;
		lspActive = false;
	}
	await client.ensure(signal);
	lspActive = true;
	return client;
}

function isPythonProject(cwd: string) {
	return existsSync(path.join(cwd, "pyproject.toml"));
}

async function textDocumentPosition(ctx: any, params: any, signal?: AbortSignal) {
	const c = await getClient(ctx, signal);
	const file = absPath(ctx.cwd, params.file);
	c.openFile(file);
	const position = params.line && params.col
		? { line: params.line - 1, character: params.col - 1 }
		: findSymbolPosition(file, params.symbol);
	return { c, file, textDocument: { uri: pathToFileURL(file).href }, position };
}

export default function pythonLspExtension(pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		if (!isPythonProject(ctx.cwd)) return;

		ctx.ui.setStatus("python-lsp", "py-lsp: starting");
		void getClient(ctx, ctx.signal)
			.then(() => {
				if (ctx.signal?.aborted) return;
				try {
					ctx.ui.setStatus("python-lsp", "py-lsp: ready");
					if (event.reason === "startup" || event.reason === "reload") {
						ctx.ui.notify("Python LSP ready (basedpyright via uv --with)", "success");
					}
				} catch {
					// Session was replaced/reloaded after async LSP startup completed.
				}
			})
			.catch((error) => {
				lspActive = false;
				if (ctx.signal?.aborted) return;
				try {
					ctx.ui.setStatus("python-lsp", "py-lsp: failed");
					ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}`, "warning");
				} catch {
					// Session was replaced/reloaded after async LSP startup failed.
				}
			});
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!lspActive || clientCwd !== ctx.cwd || !isPythonProject(ctx.cwd)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\nPython LSP is active for this uv project via uv run --with basedpyright. Prefer py_lsp_* tools for Python symbol lookup, definitions, references, hover/type info, file/workspace symbols, and diagnostics before grep/bash.`,
		};
	});

	pi.registerTool({
		name: "py_lsp_definition",
		label: "Python Definition",
		description: "Find Python symbol definition using basedpyright LSP via uv --with basedpyright.",
		promptSnippet: "Find exact Python definitions via basedpyright LSP.",
		parameters: PositionParams,
		async execute(_id, params, signal, _update, ctx) {
			const { c, textDocument, position } = await textDocumentPosition(ctx, params, signal);
			const result = await c.request("textDocument/definition", { textDocument, position }, signal);
			const definitions = asArray(result).map(normalizeLocation).filter(Boolean);
			return { content: [{ type: "text", text: `Found ${definitions.length} definition(s).` }], details: { definitions } };
		},
	});

	pi.registerTool({
		name: "py_lsp_references",
		label: "Python References",
		description: "Find Python symbol references using basedpyright LSP via uv --with basedpyright.",
		promptSnippet: "Find exact Python references via basedpyright LSP.",
		parameters: ReferenceParams,
		async execute(_id, params, signal, _update, ctx) {
			const { c, textDocument, position } = await textDocumentPosition(ctx, params, signal);
			let rawReferences = asArray(await c.request("textDocument/references", { textDocument, position, context: { includeDeclaration: params.includeDeclaration ?? true } }, signal));
			let usedDefinitionFallback = false;

			if (rawReferences.length <= 1) {
				const definitions = asArray(await c.request("textDocument/definition", { textDocument, position }, signal));
				const definition = definitions[0];
				const definitionUri = definition?.uri ?? definition?.targetUri;
				const definitionRange = definition?.range ?? definition?.targetSelectionRange ?? definition?.targetRange;
				if (definitionUri && definitionRange?.start) {
					const fallbackReferences = asArray(await c.request("textDocument/references", {
						textDocument: { uri: definitionUri },
						position: definitionRange.start,
						context: { includeDeclaration: params.includeDeclaration ?? true },
					}, signal));
					if (fallbackReferences.length > rawReferences.length) {
						rawReferences = fallbackReferences;
						usedDefinitionFallback = true;
					}
				}
			}

			const references = rawReferences.map(normalizeLocation).filter(Boolean);
			return { content: [{ type: "text", text: `Found ${references.length} reference(s).` }], details: { references, usedDefinitionFallback } };
		},
	});

	pi.registerTool({
		name: "py_lsp_hover",
		label: "Python Hover",
		description: "Get Python type/signature/docs at position using basedpyright LSP via uv --with basedpyright.",
		promptSnippet: "Get Python type info/docs via basedpyright LSP.",
		parameters: PositionParams,
		async execute(_id, params, signal, _update, ctx) {
			const { c, textDocument, position } = await textDocumentPosition(ctx, params, signal);
			const hover = await c.request("textDocument/hover", { textDocument, position }, signal);
			return { content: [{ type: "text", text: typeof hover?.contents === "string" ? hover.contents : JSON.stringify(hover?.contents ?? null) }], details: { hover } };
		},
	});

	pi.registerTool({
		name: "py_lsp_symbols",
		label: "Python File Symbols",
		description: "List Python symbols in a file using basedpyright LSP via uv --with basedpyright.",
		promptSnippet: "List classes, functions, and methods in Python file via LSP.",
		parameters: Type.Object({ file: Type.String({ description: "Python file path" }) }),
		async execute(_id, params, signal, _update, ctx) {
			const c = await getClient(ctx, signal);
			const file = absPath(ctx.cwd, params.file);
			c.openFile(file);
			const symbols = await c.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(file).href } }, signal);
			return { content: [{ type: "text", text: `Found ${asArray(symbols).length} top-level symbol(s).` }], details: { symbols } };
		},
	});

	pi.registerTool({
		name: "py_lsp_workspace_symbols",
		label: "Python Workspace Symbols",
		description: "Search Python workspace symbols using basedpyright LSP via uv --with basedpyright.",
		promptSnippet: "Search Python class/function symbols across workspace via LSP.",
		parameters: Type.Object({ query: Type.String({ description: "Symbol name query" }) }),
		async execute(_id, params, signal, _update, ctx) {
			const c = await getClient(ctx, signal);
			const symbols = await c.request("workspace/symbol", { query: params.query }, signal);
			return { content: [{ type: "text", text: `Found ${asArray(symbols).length} workspace symbol(s).` }], details: { symbols } };
		},
	});

	pi.registerTool({
		name: "py_lsp_diagnostics",
		label: "Python Diagnostics",
		description: "Get cached basedpyright diagnostics via uv --with basedpyright. With file, opens file and waits briefly for diagnostics.",
		promptSnippet: "Get Python type diagnostics from basedpyright LSP.",
		parameters: FileParams,
		async execute(_id, params, signal, _update, ctx) {
			const c = await getClient(ctx, signal);
			const file = params.file ? absPath(ctx.cwd, params.file) : undefined;
			if (file) {
				c.openFile(file);
				await sleep(800);
			}
			const diagnostics = c.getDiagnostics(file);
			const count = Array.isArray(diagnostics) ? (file ? diagnostics.length : diagnostics.reduce((n: number, x: any) => n + (x.diagnostics?.length ?? 0), 0)) : 0;
			return { content: [{ type: "text", text: `Python diagnostics: ${count}` }], details: { diagnostics } };
		},
	});

	pi.on("session_shutdown", () => {
		client?.shutdown();
		client = undefined;
		clientCwd = undefined;
		lspActive = false;
	});
}
