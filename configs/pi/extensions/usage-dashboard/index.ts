import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface TokenCost {
  tokens: number;
  cost: number;
}

interface SessionRow {
  id: string;
  file: string;
  source: "Pi" | "Codex";
  costTracked: boolean;
  tokenCostsTracked: boolean;
  usagePending: boolean;
  cwd: string;
  name: string;
  startedAt: string;
  updatedAt: string;
  parentSessionId?: string;
  parentSessionFile?: string;
  agent?: string;
  models: string[];
  calls: number;
  input: TokenCost;
  cacheRead: TokenCost;
  cacheWrite: TokenCost;
  reasoning: TokenCost;
  output: TokenCost;
  apiCost: number;
}

interface DashboardData {
  generatedAt: string;
  sessions: SessionRow[];
  totals: Omit<SessionRow, "id" | "file" | "source" | "costTracked" | "tokenCostsTracked" | "usagePending" | "cwd" | "name" | "startedAt" | "updatedAt" | "models">;
}

interface SessionHeader {
  type: "session";
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

type JsonRecord = Record<string, any>;

interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type ModelPricing = ReadonlyMap<string, ModelRates>;

const html = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent usage dashboard</title>
<style>
:root { color-scheme: dark; --bg:#0b0d10; --panel:#13171c; --line:#29313a; --text:#e8edf2; --muted:#8f9ba8; --accent:#70b7ff; --money:#8ee6a2; }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
header { position:sticky; top:0; z-index:2; padding:18px 24px; background:rgba(11,13,16,.95); border-bottom:1px solid var(--line); backdrop-filter:blur(8px) }
h1 { margin:0; font:700 22px/1.2 system-ui,sans-serif }
.subtitle { margin:5px 0 14px; color:var(--muted); font:13px/1.4 system-ui,sans-serif }
.controls { display:flex; flex-wrap:wrap; gap:10px; align-items:center }
input,select,button { border:1px solid var(--line); border-radius:7px; background:var(--panel); color:var(--text); padding:8px 10px; font:inherit }
input { min-width:280px } button { cursor:pointer } button:hover { border-color:var(--accent) }
.check { display:flex; gap:7px; align-items:center; color:var(--muted); cursor:pointer }
main { padding:20px 24px 40px }
.summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(155px,1fr)); gap:10px; margin-bottom:18px }
.card { padding:13px 14px; border:1px solid var(--line); border-radius:9px; background:var(--panel) }
.card span { display:block; color:var(--muted); font-size:12px; margin-bottom:5px }.card strong { font-size:16px }
.table-wrap { overflow:auto; border:1px solid var(--line); border-radius:9px }
table { width:100%; min-width:1240px; border-collapse:collapse; background:var(--panel) }
th,td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap }
th { position:sticky; top:0; background:#171c22; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em }
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3) { text-align:left }
tr:hover td { background:#181e25 }.session { max-width:390px; overflow:hidden; text-overflow:ellipsis }.sub { padding-left:28px!important }
.model { color:var(--muted); max-width:260px; overflow:hidden; text-overflow:ellipsis }.money { color:var(--money); font-weight:700 }
small { color:var(--muted) }.empty { padding:40px; text-align:center; color:var(--muted) }
@media(max-width:700px){ header,main{padding-left:12px;padding-right:12px} input{min-width:100%;width:100%} }
</style>
</head>
<body>
<header>
  <h1>Agent usage</h1>
  <p class="subtitle">Token use and estimated API-equivalent cost across saved Pi and Codex CLI sessions.</p>
  <div class="controls">
    <input id="search" type="search" aria-label="Filter sessions" placeholder="Search sessions, projects, models, agents…">
    <select id="range" aria-label="Date range"><option value="all">All time</option><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
    <select id="source" aria-label="Harness"><option value="all">All harnesses</option><option value="Pi">Pi</option><option value="Codex">Codex CLI</option></select>
    <label class="check"><input id="hierarchy" type="checkbox" style="min-width:auto"> Group child sessions</label>
    <button id="refresh" type="button">Refresh now</button>
    <small id="status" role="status"></small>
  </div>
</header>
<main>
  <section id="summary" class="summary"></section>
  <div class="table-wrap"><table>
    <thead><tr><th>Session</th><th>Harness</th><th>Model(s)</th><th>Input</th><th>Cache read</th><th>Reasoning</th><th>Output</th><th>Est. cost</th><th>API calls</th><th>Updated</th></tr></thead>
    <tbody id="rows"></tbody>
  </table></div>
</main>
<script>
let data={sessions:[]};
const $=id=>document.getElementById(id);
const compact=new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1});
const integer=new Intl.NumberFormat();
const dollars=new Intl.NumberFormat(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const n=v=>compact.format(Math.round(v));
const usd=v=>v>0&&v<.01?'<$0.01':'$'+dollars.format(v);
const metric=(v,costTracked=true,pending=false)=>pending?'pending':n(v.tokens)+(costTracked?' · '+usd(v.cost):'');
const relative=value=>{const seconds=Math.round((Date.parse(value)-Date.now())/1000);const abs=Math.abs(seconds);const [amount,unit]=abs<60?[seconds,'second']:abs<3600?[Math.round(seconds/60),'minute']:abs<86400?[Math.round(seconds/3600),'hour']:[Math.round(seconds/86400),'day'];return new Intl.RelativeTimeFormat(undefined,{numeric:'auto'}).format(amount,unit)};
function filtered(){const q=$('search').value.toLowerCase();const days=$('range').value;const source=$('source').value;const cutoff=days==='all'?0:Date.now()-Number(days)*864e5;return data.sessions.filter(s=>Date.parse(s.updatedAt)>=cutoff&&(source==='all'||s.source===source)&&(!q||[s.name,s.cwd,s.source,s.agent,...s.models].filter(Boolean).join(' ').toLowerCase().includes(q)))}
function ordered(rows){if(!$('hierarchy').checked)return rows;const ids=new Set(rows.map(s=>s.id));const children=new Map();const roots=[];for(const s of rows){if(s.parentSessionId&&ids.has(s.parentSessionId)){const a=children.get(s.parentSessionId)||[];a.push(s);children.set(s.parentSessionId,a)}else roots.push(s)}const out=[];const add=(s,d)=>{out.push({...s,_depth:d});for(const c of children.get(s.id)||[])add(c,d+1)};for(const r of roots)add(r,0);return out}
function sum(rows,key){return rows.reduce((a,s)=>({tokens:a.tokens+s[key].tokens,cost:a.cost+s[key].cost}),{tokens:0,cost:0})}
function render(){const rows=filtered();const priced=rows.filter(s=>s.costTracked);const totalCost=priced.reduce((a,s)=>a+s.apiCost,0);const totalCalls=rows.reduce((a,s)=>a+s.calls,0);const allPriced=priced.length===rows.length;const allTokenCostsTracked=rows.every(s=>s.tokenCostsTracked);const metrics=[['Sessions',integer.format(rows.length)],['Input',metric(sum(rows,'input'),allTokenCostsTracked)],['Cache read',metric(sum(rows,'cacheRead'),allTokenCostsTracked)],['Reasoning',metric(sum(rows,'reasoning'),allTokenCostsTracked)],['Output',metric(sum(rows,'output'),allTokenCostsTracked)],['Estimated cost',priced.length?usd(totalCost)+(allPriced?'':' · tracked sessions only'):'n/a'],['API calls',integer.format(totalCalls)]];$('summary').replaceChildren(...metrics.map(([k,v])=>{const d=document.createElement('div');d.className='card';const l=document.createElement('span');l.textContent=k;const x=document.createElement('strong');x.textContent=v;d.append(l,x);return d}));const body=$('rows');body.replaceChildren();for(const s of ordered(rows)){const tr=document.createElement('tr');const updated=relative(s.updatedAt);const cells=[s.name,s.source,s.models.join(', ')||'—',metric(s.input,s.tokenCostsTracked,s.usagePending),metric(s.cacheRead,s.tokenCostsTracked,s.usagePending),metric(s.reasoning,s.tokenCostsTracked,s.usagePending),metric(s.output,s.tokenCostsTracked,s.usagePending),s.costTracked?usd(s.apiCost):'n/a',integer.format(s.calls),updated];cells.forEach((value,i)=>{const td=document.createElement('td');td.textContent=value;td.title=i===0?s.file:i===9?new Date(s.updatedAt).toLocaleString():value;if(i===0){td.className='session'+(s._depth?' sub':'');if(s.agent)td.textContent=(s._depth?'↳ ':'')+'['+s.agent+'] '+value}else if(i===2)td.className='model';else if(i===7)td.className='money';tr.append(td)});body.append(tr)}if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=10;td.className='empty';td.textContent='No sessions match current filters';tr.append(td);body.append(tr)}}
async function load(){try{$('refresh').disabled=true;$('status').textContent='Refreshing…';const r=await fetch('/api/sessions',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);data=await r.json();render();$('status').textContent='Updated '+new Date(data.generatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}catch(e){$('status').textContent='Refresh failed: '+e.message}finally{$('refresh').disabled=false}}
for(const id of ['search','range','source','hierarchy'])$(id).addEventListener(id==='search'?'input':'change',render);$('refresh').addEventListener('click',load);load();setInterval(load,15000);
</script>
</body></html>`;

const SCAN_CONCURRENCY = 16;
const JSONL_CACHE_LIMIT = 2_048;
const DASHBOARD_SCAN_CACHE_MS = 5_000;

interface JsonlSnapshot {
  mtimeMs: number;
  size: number;
  records: JsonRecord[];
}

const jsonlCache = new Map<string, JsonlSnapshot>();

async function mapBounded<T, R>(
  values: readonly T[],
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}

async function readJsonl(file: string): Promise<JsonlSnapshot> {
  const metadata = await stat(file);
  const cached = jsonlCache.get(file);
  if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
    jsonlCache.delete(file);
    jsonlCache.set(file, cached);
    return cached;
  }

  const raw = await readFile(file, "utf8");
  const records: JsonRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Active writers can expose a partial final line until the next scan.
    }
  }

  const snapshot = { mtimeMs: metadata.mtimeMs, size: metadata.size, records };
  jsonlCache.set(file, snapshot);
  while (jsonlCache.size > JSONL_CACHE_LIMIT) {
    const oldest = jsonlCache.keys().next().value;
    if (oldest === undefined) break;
    jsonlCache.delete(oldest);
  }
  return snapshot;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text")
    .map((item) => String(item.text ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function findJsonlFiles(root: string, exactName?: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const batch = pending.splice(0, SCAN_CONCURRENCY);
    const listings = await Promise.all(batch.map(async (dir) => {
      try {
        return await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    }));
    for (let index = 0; index < batch.length; index += 1) {
      for (const entry of listings[index] ?? []) {
        const path = join(batch[index]!, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && (!exactName || entry.name === exactName)) {
          files.push(path);
        }
      }
    }
  }
  return files;
}

function nearestThinking(entry: JsonRecord, byId: Map<string, JsonRecord>): string {
  let current: JsonRecord | undefined = entry;
  const seen = new Set<string>();
  while (current) {
    if (current.type === "thinking_level_change" && typeof current.thinkingLevel === "string") return current.thinkingLevel;
    const parentId = current.parentId;
    if (typeof parentId !== "string" || seen.has(parentId)) break;
    seen.add(parentId);
    current = byId.get(parentId);
  }
  return "off";
}

function truncateLabel(value: string, length = 80): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function usageSummary(entries: JsonRecord[], excludedIds = new Set<string>()): Pick<SessionRow, "models" | "calls" | "input" | "cacheRead" | "cacheWrite" | "reasoning" | "output" | "apiCost"> {
  const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]));
  const input = { tokens: 0, cost: 0 };
  const cacheRead = { tokens: 0, cost: 0 };
  const cacheWrite = { tokens: 0, cost: 0 };
  const reasoning = { tokens: 0, cost: 0 };
  const output = { tokens: 0, cost: 0 };
  const models = new Set<string>();
  let calls = 0;
  let apiCost = 0;

  for (const entry of entries) {
    if (typeof entry.id === "string" && excludedIds.has(entry.id)) continue;
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message || message.role !== "assistant" || !message.usage) continue;
    calls++;
    const usage = message.usage;
    const cost = usage.cost ?? {};
    const rawOutput = number(usage.output ?? usage.outputTokens);
    const reasoningTokens = Math.min(rawOutput, number(usage.reasoning ?? usage.reasoningTokens));
    const outputCost = number(cost.output);
    const reasoningCost = rawOutput > 0 ? outputCost * reasoningTokens / rawOutput : 0;
    input.tokens += number(usage.input ?? usage.inputTokens);
    input.cost += number(cost.input);
    cacheRead.tokens += number(usage.cacheRead);
    cacheRead.cost += number(cost.cacheRead);
    cacheWrite.tokens += number(usage.cacheWrite);
    cacheWrite.cost += number(cost.cacheWrite);
    reasoning.tokens += reasoningTokens;
    reasoning.cost += reasoningCost;
    output.tokens += Math.max(0, rawOutput - reasoningTokens);
    output.cost += Math.max(0, outputCost - reasoningCost);
    apiCost += number(cost.total) || number(cost.input) + outputCost + number(cost.cacheRead) + number(cost.cacheWrite);
    const provider = typeof message.provider === "string" ? `${message.provider}/` : "";
    const model = typeof message.model === "string" ? message.model : "unknown";
    models.add(`${provider}${model}:${nearestThinking(entry, byId)}`);
  }
  return { models: [...models], calls, input, cacheRead, cacheWrite, reasoning, output, apiCost };
}

async function parseSession(file: string): Promise<{ row: SessionRow; entries: JsonRecord[] } | undefined> {
  let snapshot: JsonlSnapshot;
  try {
    snapshot = await readJsonl(file);
  } catch {
    return undefined;
  }
  const records = snapshot.records;
  const header = records.find((record) => record.type === "session") as SessionHeader | undefined;
  if (!header) return undefined;
  const entries = records.filter((record) => record.type !== "session");
  const usage = usageSummary(entries);
  const sessionInfo = entries.filter((entry) => entry.type === "session_info" && typeof entry.name === "string").at(-1);
  const firstUser = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
  const label = sessionInfo?.name?.trim() || textFromContent(firstUser?.message?.content) || `Session ${String(header.id ?? "unknown").slice(0, 8)}`;
  const fileMtime = new Date(snapshot.mtimeMs).toISOString();
  const timestamps = records.map((record) => record.timestamp).filter((value): value is string => typeof value === "string");

  return {
    row: {
      id: `Pi:${String(header.id ?? resolve(file))}`,
      file: resolve(file),
      source: "Pi",
      costTracked: true,
      tokenCostsTracked: true,
      usagePending: false,
      cwd: header.cwd ?? "",
      name: truncateLabel(label),
      startedAt: header.timestamp ?? timestamps[0] ?? fileMtime,
      updatedAt: timestamps.at(-1) ?? fileMtime,
      ...(header.parentSession ? { parentSessionFile: resolve(dirname(file), header.parentSession) } : {}),
      ...usage,
    },
    entries,
  };
}

function priceCodexMetrics(
  metrics: Pick<SessionRow, "input" | "cacheRead" | "reasoning" | "output">,
  rates: ModelRates,
): number {
  metrics.input.cost = metrics.input.tokens * rates.input / 1_000_000;
  metrics.cacheRead.cost = metrics.cacheRead.tokens * rates.cacheRead / 1_000_000;
  metrics.reasoning.cost = metrics.reasoning.tokens * rates.output / 1_000_000;
  metrics.output.cost = metrics.output.tokens * rates.output / 1_000_000;
  return metrics.input.cost + metrics.cacheRead.cost + metrics.reasoning.cost + metrics.output.cost;
}

function addCodexUsage(
  usage: JsonRecord,
  metrics: Pick<SessionRow, "input" | "cacheRead" | "reasoning" | "output">,
): void {
  const cachedTokens = number(usage.cached_input_tokens);
  const inputTokens = Math.max(0, number(usage.input_tokens) - cachedTokens);
  const rawOutput = number(usage.output_tokens);
  const reasoningTokens = Math.min(rawOutput, number(usage.reasoning_output_tokens));
  const outputTokens = Math.max(0, rawOutput - reasoningTokens);
  metrics.input.tokens += inputTokens;
  metrics.cacheRead.tokens += cachedTokens;
  metrics.reasoning.tokens += reasoningTokens;
  metrics.output.tokens += outputTokens;
}

function codexUsageSummary(records: JsonRecord[], pricing: ModelPricing): Pick<SessionRow, "models" | "calls" | "input" | "cacheRead" | "cacheWrite" | "reasoning" | "output" | "apiCost" | "costTracked" | "tokenCostsTracked"> {
  const input = { tokens: 0, cost: 0 };
  const cacheRead = { tokens: 0, cost: 0 };
  const cacheWrite = { tokens: 0, cost: 0 };
  const reasoning = { tokens: 0, cost: 0 };
  const output = { tokens: 0, cost: 0 };
  const models = new Set<string>();
  const modelIds = new Set<string>();
  let calls = 0;
  let previousTotal: JsonRecord | undefined;

  for (const record of records) {
    if (record.type === "turn_context" && typeof record.payload?.model === "string") {
      const model = record.payload.model as string;
      modelIds.add(model);
      const effort = typeof record.payload.effort === "string" ? `:${record.payload.effort}` : "";
      models.add(`openai-codex/${model}${effort}`);
    }
    const info = record.type === "event_msg" && record.payload?.type === "token_count"
      ? record.payload.info
      : undefined;
    if (!info) continue;
    const total = info.total_token_usage;
    const usage = info.last_token_usage ?? (total ? {
      input_tokens: Math.max(0, number(total.input_tokens) - number(previousTotal?.input_tokens)),
      cached_input_tokens: Math.max(0, number(total.cached_input_tokens) - number(previousTotal?.cached_input_tokens)),
      output_tokens: Math.max(0, number(total.output_tokens) - number(previousTotal?.output_tokens)),
      reasoning_output_tokens: Math.max(0, number(total.reasoning_output_tokens) - number(previousTotal?.reasoning_output_tokens)),
    } : undefined);
    if (total) previousTotal = total;
    if (!usage) continue;
    calls++;
    addCodexUsage(usage, { input, cacheRead, reasoning, output });
  }

  const rates = modelIds.size === 1 ? pricing.get([...modelIds][0]!) : undefined;
  const costTracked = calls > 0 && Boolean(rates);
  const apiCost = rates ? priceCodexMetrics({ input, cacheRead, reasoning, output }, rates) : 0;
  return { models: [...models], calls, input, cacheRead, cacheWrite, reasoning, output, apiCost, costTracked, tokenCostsTracked: costTracked };
}

async function parseCodexSession(file: string, pricing: ModelPricing): Promise<{ row: SessionRow; entries: JsonRecord[] } | undefined> {
  let snapshot: JsonlSnapshot;
  try {
    snapshot = await readJsonl(file);
  } catch {
    return undefined;
  }
  const records = snapshot.records;
  const metadata = records.find((record) => record.type === "session_meta")?.payload;
  if (!metadata || typeof metadata !== "object") return undefined;

  const sessionId = String(metadata.id ?? metadata.session_id ?? resolve(file));
  const userMessage = records.find((record) => record.type === "event_msg" && record.payload?.type === "user_message");
  const label = typeof userMessage?.payload?.message === "string" && userMessage.payload.message.trim()
    ? userMessage.payload.message.trim()
    : `Codex session ${sessionId.slice(0, 8)}`;
  const spawn = metadata.source?.subagent?.thread_spawn;
  const parentId = typeof spawn?.parent_thread_id === "string" ? `Codex:${spawn.parent_thread_id}` : undefined;
  const agent = typeof spawn?.agent_nickname === "string"
    ? spawn.agent_nickname
    : typeof spawn?.agent_path === "string"
      ? spawn.agent_path.split("/").filter(Boolean).at(-1)
      : undefined;
  const fileMtime = new Date(snapshot.mtimeMs).toISOString();
  const timestamps = records.map((record) => record.timestamp).filter((value): value is string => typeof value === "string");

  return {
    row: {
      id: `Codex:${sessionId}`,
      file: resolve(file),
      source: "Codex",
      usagePending: false,
      cwd: typeof metadata.cwd === "string" ? metadata.cwd : "",
      name: truncateLabel(label),
      startedAt: typeof metadata.timestamp === "string" ? metadata.timestamp : timestamps[0] ?? fileMtime,
      updatedAt: timestamps.at(-1) ?? fileMtime,
      ...(parentId ? { parentSessionId: parentId } : {}),
      ...(agent ? { agent } : {}),
      ...codexUsageSummary(records, pricing),
    },
    entries: records,
  };
}

async function parseCodexEvents(file: string, pricing: ModelPricing): Promise<{ row: SessionRow; entries: JsonRecord[] } | undefined> {
  let snapshot: JsonlSnapshot;
  try {
    snapshot = await readJsonl(file);
  } catch {
    return undefined;
  }
  const records = snapshot.records;
  const threadId = records.find((record) => record.type === "thread.started")?.thread_id;
  if (typeof threadId !== "string") return undefined;

  let manifest: JsonRecord = {};
  try {
    manifest = JSON.parse(await readFile(join(dirname(file), "manifest.json"), "utf8"));
  } catch {
    // A running benchmark writes its manifest at completion. The event stream is still useful meanwhile.
  }
  const input = { tokens: 0, cost: 0 };
  const cacheRead = { tokens: 0, cost: 0 };
  const cacheWrite = { tokens: 0, cost: 0 };
  const reasoning = { tokens: 0, cost: 0 };
  const output = { tokens: 0, cost: 0 };
  let calls = 0;
  const model = typeof manifest.model === "string" ? manifest.model : "openai/unknown";
  const modelId = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const rates = pricing.get(modelId);
  for (const record of records) {
    if (record.type !== "turn.completed" || !record.usage) continue;
    calls++;
    addCodexUsage(record.usage, { input, cacheRead, reasoning, output });
  }
  const apiCost = rates ? priceCodexMetrics({ input, cacheRead, reasoning, output }, rates) : 0;
  const fileMtime = new Date(snapshot.mtimeMs).toISOString();
  const runId = typeof manifest.run_id === "string" ? manifest.run_id : `Codex session ${threadId.slice(0, 8)}`;
  const thinking = typeof manifest.thinking === "string" ? `:${manifest.thinking}` : "";
  const manifestCost = manifest.agent_usage?.estimated_api_cost_usd;
  const hasManifestCost = typeof manifestCost === "number" && Number.isFinite(manifestCost) && manifestCost >= 0;
  const costTracked = (calls > 0 && Boolean(rates)) || hasManifestCost;

  return {
    row: {
      id: `Codex:${threadId}`,
      file: resolve(file),
      source: "Codex",
      costTracked,
      tokenCostsTracked: calls > 0 && Boolean(rates),
      usagePending: manifest.status === "running" && calls === 0,
      cwd: typeof manifest.agent_worktree === "string" ? manifest.agent_worktree : dirname(file),
      name: truncateLabel(runId),
      startedAt: typeof manifest.started_at === "string" ? manifest.started_at : fileMtime,
      updatedAt: typeof manifest.finished_at === "string" ? manifest.finished_at : fileMtime,
      models: [`${model}${thinking}`],
      calls,
      input,
      cacheRead,
      cacheWrite,
      reasoning,
      output,
      apiCost: calls > 0 && rates ? apiCost : hasManifestCost ? manifestCost : 0,
    },
    entries: records,
  };
}

function childLinks(entries: JsonRecord[]): Array<{ file: string; agent?: string }> {
  const links: Array<{ file: string; agent?: string }> = [];
  const seen = new Set<string>();
  function walk(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as JsonRecord;
    if (typeof record.sessionFile === "string" && record.sessionFile.endsWith(".jsonl")) {
      const file = resolve(record.sessionFile);
      if (!seen.has(file)) {
        seen.add(file);
        links.push({ file, ...(typeof record.agent === "string" ? { agent: record.agent } : {}) });
      }
    }
    for (const nested of Object.values(record)) walk(nested);
  }
  for (const entry of entries) {
    const isToolResult = entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "subagent";
    const isSubagentCustom = entry.type === "custom_message" && String(entry.customType ?? "").includes("subagent");
    if (isToolResult) walk(entry.message.details);
    else if (isSubagentCustom) walk(entry.details);
  }
  return links;
}

function emptyTotals(): DashboardData["totals"] {
  return {
    calls: 0,
    input: { tokens: 0, cost: 0 },
    cacheRead: { tokens: 0, cost: 0 },
    cacheWrite: { tokens: 0, cost: 0 },
    reasoning: { tokens: 0, cost: 0 },
    output: { tokens: 0, cost: 0 },
    apiCost: 0,
  };
}

export async function scanSessions(
  sessionRoot?: string,
  codexSessionRoot?: string,
  benchmarkResultsRoots: string[] = [],
  pricing: ModelPricing = new Map(),
): Promise<DashboardData> {
  const piRoot = sessionRoot ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
  const codexRoot = codexSessionRoot ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const [piFiles, codexFiles] = await Promise.all([findJsonlFiles(piRoot), findJsonlFiles(codexRoot)]);
  const piParsed = (await mapBounded(piFiles, parseSession)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const discoveredResultsRoots = new Set(benchmarkResultsRoots.map((root) => resolve(root)));
  if (process.env.SWE_BENCHMARK_RESULTS_DIR) discoveredResultsRoots.add(resolve(process.env.SWE_BENCHMARK_RESULTS_DIR));
  for (const item of piParsed) {
    if (!item.row.cwd) continue;
    discoveredResultsRoots.add(resolve(item.row.cwd, "setup", "results"));
    discoveredResultsRoots.add(resolve(item.row.cwd, "results"));
  }
  const codexEventFiles = (await mapBounded(
    [...discoveredResultsRoots],
    (root) => findJsonlFiles(root, "codex-events.jsonl"),
  )).flat();
  const [codexParsed, eventParsed] = await Promise.all([
    mapBounded(codexFiles, (file) => parseCodexSession(file, pricing)),
    mapBounded(codexEventFiles, (file) => parseCodexEvents(file, pricing)),
  ]);
  const parsed = [...piParsed, ...codexParsed, ...eventParsed]
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  // Sessions may be copied into several artifact locations. Source-prefixed session id is canonical.
  const byId = new Map<string, typeof parsed[number]>();
  for (const item of parsed) {
    const previous = byId.get(item.row.id);
    if (!previous || item.row.updatedAt > previous.row.updatedAt) byId.set(item.row.id, item);
  }
  const byFile = new Map<string, typeof parsed[number]>();
  for (const item of byId.values()) byFile.set(resolve(item.row.file), item);

  // Forked child files contain copied parent history. Those calls belong only to the
  // parent session, so count only entry ids introduced by the child.
  for (const child of byId.values()) {
    if (!child.row.parentSessionFile) continue;
    const parent = byFile.get(resolve(child.row.parentSessionFile));
    if (!parent || parent.row.id === child.row.id) continue;
    const inheritedIds = new Set(parent.entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
    Object.assign(child.row, usageSummary(child.entries, inheritedIds));
  }

  for (const parent of byId.values()) {
    for (const link of childLinks(parent.entries)) {
      const child = byFile.get(link.file);
      if (!child || child.row.id === parent.row.id) continue;
      child.row.parentSessionId = parent.row.id;
      child.row.parentSessionFile = parent.row.file;
      if (link.agent) child.row.agent = link.agent;
    }
  }
  for (const item of byId.values()) {
    if (item.row.parentSessionId || !item.row.parentSessionFile) continue;
    const parent = byFile.get(resolve(item.row.parentSessionFile));
    if (parent && parent.row.id !== item.row.id) item.row.parentSessionId = parent.row.id;
  }

  const sessions = [...byId.values()].map((item) => item.row).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const totals = emptyTotals();
  for (const session of sessions) {
    totals.calls += session.calls;
    totals.apiCost += session.apiCost;
    for (const key of ["input", "cacheRead", "cacheWrite", "reasoning", "output"] as const) {
      totals[key].tokens += session[key].tokens;
      totals[key].cost += session[key].cost;
    }
  }
  return { generatedAt: new Date().toISOString(), sessions, totals };
}

let server: Server | undefined;
let dashboardUrl: string | undefined;
let dashboardToken: string | undefined;
let dashboardScanPromise: Promise<DashboardData> | undefined;
let dashboardScanCache: { expiresAt: number; data: DashboardData } | undefined;

function scanDashboard(pricing: ModelPricing): Promise<DashboardData> {
  const now = Date.now();
  if (dashboardScanCache && dashboardScanCache.expiresAt > now) {
    return Promise.resolve(dashboardScanCache.data);
  }
  dashboardScanPromise ??= scanSessions(undefined, undefined, [], pricing)
    .then((data) => {
      dashboardScanCache = { expiresAt: Date.now() + DASHBOARD_SCAN_CACHE_MS, data };
      return data;
    })
    .finally(() => {
      dashboardScanPromise = undefined;
    });
  return dashboardScanPromise;
}

const dashboardRegistry = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "usage-dashboard-server.json",
);

async function stopPreviousDashboard(): Promise<void> {
  try {
    const registry = JSON.parse(await readFile(dashboardRegistry, "utf8")) as { url?: unknown; token?: unknown };
    if (typeof registry.url !== "string" || typeof registry.token !== "string") return;
    const response = await fetch(new URL("api/shutdown", registry.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${registry.token}` },
      signal: AbortSignal.timeout(2000),
    });
    await response.text();
  } catch {
    // Missing or stale registry means no reachable previous dashboard.
  }
}

async function removeOwnRegistry(token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    const registry = JSON.parse(await readFile(dashboardRegistry, "utf8")) as { token?: unknown };
    if (registry.token === token) await unlink(dashboardRegistry);
  } catch {}
}

async function closeDashboard(): Promise<void> {
  dashboardScanCache = undefined;
  const activeServer = server;
  const activeToken = dashboardToken;
  server = undefined;
  dashboardUrl = undefined;
  dashboardToken = undefined;
  if (activeServer) {
    await new Promise<void>((resolvePromise) => activeServer.close(() => resolvePromise()));
  }
  await removeOwnRegistry(activeToken);
}

async function startDashboard(pricing: ModelPricing): Promise<string> {
  if (server?.listening && dashboardUrl) return dashboardUrl;
  await stopPreviousDashboard();
  dashboardScanCache = undefined;
  dashboardToken = randomUUID();
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    if (url.pathname === "/api/shutdown" && request.method === "POST") {
      if (request.headers.authorization !== `Bearer ${dashboardToken}`) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Dashboard stopped");
      const activeServer = server;
      server = undefined;
      dashboardUrl = undefined;
      dashboardToken = undefined;
      setImmediate(() => activeServer?.close());
    } else if (request.method !== "GET") {
      response.writeHead(405).end("Method not allowed");
    } else if (url.pathname === "/api/sessions") {
      try {
        const data = await scanDashboard(pricing);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(data));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    } else {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine dashboard port");
  dashboardUrl = `http://127.0.0.1:${address.port}/`;
  await writeFile(
    dashboardRegistry,
    JSON.stringify({ url: dashboardUrl, token: dashboardToken, pid: process.pid }),
    { encoding: "utf8", mode: 0o600 },
  );
  return dashboardUrl;
}

async function openBrowser(pi: ExtensionAPI, url: string): Promise<boolean> {
  const candidates = process.platform === "win32"
    ? [["cmd.exe", ["/c", "start", "", url]]] as const
    : process.env.WSL_DISTRO_NAME
      ? [["wslview", [url]], ["cmd.exe", ["/c", "start", "", url]], ["xdg-open", [url]]] as const
      : process.platform === "darwin"
        ? [["open", [url]]] as const
        : [["xdg-open", [url]]] as const;
  for (const [command, args] of candidates) {
    try {
      const result = await pi.exec(command, [...args], { timeout: 5000 });
      if (result.code === 0) return true;
    } catch {}
  }
  return false;
}

function codexModelPricing(ctx: ExtensionCommandContext): ModelPricing {
  return new Map(
    ctx.modelRegistry.getAll()
      .filter((model) => model.provider === "openai-codex")
      .map((model) => [model.id, {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
      }]),
  );
}

export default function usageDashboard(pi: ExtensionAPI) {
  pi.registerCommand("usage-dashboard", {
    description: "Open browser dashboard for historical Pi and Codex CLI session usage",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const url = await startDashboard(codexModelPricing(ctx));
        const opened = await openBrowser(pi, url);
        ctx.ui.notify(opened ? `Usage dashboard opened: ${url}` : `Usage dashboard ready: ${url}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not start usage dashboard: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await closeDashboard();
  });
}
