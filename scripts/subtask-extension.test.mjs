import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ActiveBatchRegistry,
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
  MAX_SUBTASK_SUMMARY_CHARS,
  SUBTASK_CHILD_SYSTEM_PROMPT,
  SUBTASK_MODELS,
  SUBTASK_THINKING_LEVELS,
  SUBTASKS_TOOL_DESCRIPTION,
  SUBTASKS_TOOL_NAME,
  SUBTASKS_TOOL_PROMPT_GUIDELINES,
  buildChildArgs,
  executeBatchMode,
  formatSubtaskCost,
  formatSubtaskStatusLines,
  listSelectableTools,
  prepareSubtasksArguments,
  runChild,
  truncateResult,
} from "../configs/pi/extensions/subtask/core.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Condition was not reached");
}


test("exposes only Luna and Sol with low, medium, and high thinking", () => {
  assert.deepEqual(SUBTASK_MODELS, [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-sol",
  ]);
  assert.deepEqual(SUBTASK_THINKING_LEVELS, ["low", "medium", "high"]);
});

test("uses the plural tool name and excludes it from child tools", () => {
  assert.equal(SUBTASKS_TOOL_NAME, "subtasks");
  assert.deepEqual(listSelectableTools(["write", "subtasks", "read", "write", "bash"]), [
    "bash",
    "read",
    "write",
  ]);
});

test("keeps execution metadata mechanical and delegation guidance tool-owned", () => {
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /isolated Pi processes/i);
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /share the current working directory/i);
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /Tasks in one call run in parallel/i);
  assert.doesNotMatch(
    SUBTASKS_TOOL_DESCRIPTION,
    /1-16|research|implementation|\bLuna\b|\bSol\b|retrieval|architecture|high-consequence/i,
  );

  assert.ok(SUBTASKS_TOOL_PROMPT_GUIDELINES.length > 0);
  assert.ok(SUBTASKS_TOOL_PROMPT_GUIDELINES.every((guideline) => /subtasks/i.test(guideline)));
});

test("formats one below-editor tree row per subtask", () => {
  assert.deepEqual(
    formatSubtaskStatusLines([
      {
        task: "Inspect the target\nwith extra context",
        status: "running",
        model: "openai-codex/gpt-5.6-sol",
        thinking: "low",
        elapsedMs: 12_000,
        contextTokens: 18_200,
        contextWindow: 272_000,
        cost: 1.1684,
        toolCalls: 3,
      },
      {
        task: "Verify behavior",
        status: "completed",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "medium",
        elapsedMs: 65_000,
        contextTokens: 900,
        contextWindow: 272_000,
        toolCalls: 1,
      },
      { task: "Check failure", status: "failed" },
    ]),
    [
      "├─ ● running   00:12  Sol · Low  ·  $1.168  ·  18.2k/272k ctx  ·  3 tools  │  Inspect the target",
      "├─ ✓ done      01:05  Luna · Medium  ·  $0.000  ·  900/272k ctx  ·  1 tool  │  Verify behavior",
      "└─ × failed    00:00  │  Check failure",
    ],
  );
});

test("puts a bounded task summary after all status metadata", () => {
  const [line] = formatSubtaskStatusLines([
    {
      task: "Inspect 😀 " + "a".repeat(100),
      status: "running",
      model: "openai-codex/gpt-5.6-luna",
      thinking: "medium",
      contextTokens: 12_000,
      contextWindow: 272_000,
      toolCalls: 4,
    },
  ]);

  const summary = line.split("  │  ").at(-1);
  assert.equal(Array.from(summary).length, MAX_SUBTASK_SUMMARY_CHARS);
  assert.ok(summary.endsWith("…"));
  assert.match(line, /Luna · Medium.*\$0\.000.*12k\/272k ctx.*4 tools.*│.*Inspect/);
});

test("formats child costs compactly with small-cost precision", () => {
  assert.equal(formatSubtaskCost(), "$0.000");
  assert.equal(formatSubtaskCost(1.1684), "$1.168");
  assert.equal(formatSubtaskCost(0.00042), "$0.000");
});

test("builds a fresh child invocation with the fixed system contract", () => {
  const args = buildChildArgs({
    task: "Inspect the target",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "low",
    tools: ["read", "grep"],
  });

  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-prompt-templates"));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), [
    "--tools",
    "read,grep",
  ]);
  const appendIndex = args.indexOf("--append-system-prompt");
  assert.notEqual(appendIndex, -1);
  assert.equal(args.filter((arg) => arg === "--append-system-prompt").length, 1);
  assert.equal(args[appendIndex + 1], SUBTASK_CHILD_SYSTEM_PROMPT);
  assert.equal(args.at(-1), "Task:\nInspect the target");
  assert.ok(args.indexOf("--append-system-prompt") < args.indexOf("Task:\nInspect the target"));
});

test("keeps caller task unchanged and adds one contract to a forked child", () => {
  const task = "Review the prior decision\n\nDo not edit files.";
  const args = buildChildArgs({
    task,
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    tools: [],
    sessionFile: "/tmp/fork.jsonl",
  });

  assert.equal(args.filter((arg) => arg === "--append-system-prompt").length, 1);
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], SUBTASK_CHILD_SYSTEM_PROMPT);
  assert.equal(args.at(-1), `Task:\n${task}`);
  assert.equal(args.includes("--session"), true);
  assert.equal(args.includes("--no-session"), false);
});

test("maps legacy async arguments to wait without exposing async", () => {
  assert.deepEqual(
    prepareSubtasksArguments({ tasks: [{ task: "A" }], async: true }),
    { tasks: [{ task: "A" }], wait: false },
  );
  assert.deepEqual(
    prepareSubtasksArguments({ tasks: [{ task: "A" }], async: false }),
    { tasks: [{ task: "A" }], wait: true },
  );
  assert.deepEqual(
    prepareSubtasksArguments({ tasks: [{ task: "A" }], async: true, wait: true }),
    { tasks: [{ task: "A" }], wait: true },
  );
});

test("supports no tools while preserving the forked child contract", () => {
  const args = buildChildArgs({
    task: "Review the prior decision",
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    tools: [],
    sessionFile: "/tmp/fork.jsonl",
  });

  assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), [
    "--session",
    "/tmp/fork.jsonl",
  ]);
  assert.ok(args.includes("--no-tools"));
  assert.ok(!args.includes("--no-session"));
  assert.equal(args.filter((arg) => arg === "--append-system-prompt").length, 1);
});

test("extension keeps fork and wait guidance with their parameters", () => {
  const source = readFileSync(
    new URL("../configs/pi/extensions/subtask/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /wait: Type\.Optional\(\s*Type\.Boolean/);
  assert.doesNotMatch(source, /async: Type\.Optional\(\s*Type\.Boolean/);
  assert.match(source, /promptGuidelines: SUBTASKS_TOOL_PROMPT_GUIDELINES/);
  assert.match(source, /default: true/);
  assert.match(source, /deliverAs: "steer", triggerTurn: true/);
  assert.match(source, /await activeBatches\.cancelAndWait\(\)/);
});

test("wait mode returns normal completion without background delivery", async () => {
  const batch = deferred();
  const backgroundEvents = [];
  let detached = false;
  let settled = false;
  const execution = executeBatchMode({
    wait: true,
    completion: batch.promise,
    acknowledgement: "started",
    detach: () => {
      detached = true;
    },
    onBackgroundSuccess: (result) => backgroundEvents.push(result),
    onBackgroundFailure: (error) => backgroundEvents.push(error),
  }).finally(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(detached, false);

  batch.resolve("finished");
  assert.equal(await execution, "finished");
  assert.equal(detached, false);
  assert.deepEqual(backgroundEvents, []);
});

test("wait=false acknowledges immediately and delivers eventual success once", async () => {
  const batch = deferred();
  const backgroundEvents = [];
  let detachCount = 0;
  const result = await executeBatchMode({
    wait: false,
    completion: batch.promise,
    acknowledgement: { status: "running" },
    detach: () => {
      detachCount += 1;
    },
    onBackgroundSuccess: (value) => backgroundEvents.push({ type: "steer", value }),
    onBackgroundFailure: (error) => backgroundEvents.push({ type: "failure", error }),
  });

  assert.deepEqual(result, { status: "running" });
  assert.equal(detachCount, 1);
  batch.resolve("background result");
  await eventually(() => backgroundEvents.length === 1);
  assert.deepEqual(backgroundEvents, [{ type: "steer", value: "background result" }]);
});

test("caller abort detaches wait without cancelling completion", async () => {
  const batch = deferred();
  const caller = new AbortController();
  const backgroundEvents = [];
  let detachCount = 0;
  const execution = executeBatchMode({
    wait: true,
    completion: batch.promise,
    acknowledgement: "detached",
    callerSignal: caller.signal,
    detach: () => {
      detachCount += 1;
    },
    onBackgroundSuccess: (value) => backgroundEvents.push({ type: "steer", value }),
    onBackgroundFailure: (error) => backgroundEvents.push({ type: "failure", error }),
  });

  caller.abort();
  assert.equal(await execution, "detached");
  assert.equal(detachCount, 1);
  assert.equal(backgroundEvents.length, 0);

  batch.resolve("finished after escape");
  await eventually(() => backgroundEvents.length === 1);
  assert.deepEqual(backgroundEvents, [{ type: "steer", value: "finished after escape" }]);
});

test("detached batch routes failure once", async () => {
  const batch = deferred();
  const backgroundEvents = [];
  await executeBatchMode({
    wait: false,
    completion: batch.promise,
    acknowledgement: "started",
    detach() {},
    onBackgroundSuccess: (value) => backgroundEvents.push({ type: "success", value }),
    onBackgroundFailure: (error) => backgroundEvents.push({ type: "failure", error }),
  });

  const failure = new Error("child exploded");
  batch.reject(failure);
  await eventually(() => backgroundEvents.length === 1);
  assert.deepEqual(backgroundEvents, [{ type: "failure", error: failure }]);
});

test("active batch registry cancels and waits for independent batches", async () => {
  const registry = new ActiveBatchRegistry();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = deferred();
  const second = deferred();
  firstController.signal.addEventListener("abort", () => first.reject(new Error("first cancelled")));
  secondController.signal.addEventListener("abort", () => second.reject(new Error("second cancelled")));
  registry.track(firstController, first.promise);
  registry.track(secondController, second.promise);

  await registry.cancelAndWait();
  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, true);
});

test("parses final output and usage from a JSON-mode child", async () => {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "focused result" }],
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 23,
      cost: { total: 0.0123 },
    },
    stopReason: "stop",
  };
  const script = [
    `console.log(${JSON.stringify(JSON.stringify({ type: "tool_execution_start", toolName: "read" }))})`,
    `console.log(${JSON.stringify(JSON.stringify({ type: "message_end", message: assistant }))})`,
  ].join(";");
  const progress = [];

  const result = await runChild({
    invocation: { command: process.execPath, args: ["-e", script] },
    cwd: process.cwd(),
    onProgress: (message) => progress.push(message),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "focused result");
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.usage, {
    input: 11,
    output: 7,
    cacheRead: 3,
    cacheWrite: 2,
    cost: 0.0123,
    contextTokens: 23,
    turns: 1,
  });
  assert.match(progress[0].message, /read/);
  assert.equal(progress[0].toolCalls, 1);
  assert.equal(progress.at(-1).contextTokens, 23);
});

test("accumulates assistant usage cost in child progress", async () => {
  const messages = [0.0123, 0.0045].map((cost, index) => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `turn ${index + 1}` }],
      usage: { totalTokens: (index + 1) * 10, cost: { total: cost } },
    },
  }));
  const script = messages.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`).join(";");
  const progress = [];
  const result = await runChild({
    invocation: { command: process.execPath, args: ["-e", script] },
    cwd: process.cwd(),
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.usage.cost, 0.0168);
  assert.deepEqual(progress.map((value) => value.cost), [0.0123, 0.0168]);
});

test("preserves UTF-8 JSON split across stdout chunks", async () => {
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "split 😀 output" }],
      usage: { totalTokens: 4, cost: { total: 0 } },
      stopReason: "stop",
    },
  });
  const script = `
    const bytes = Buffer.from(${JSON.stringify(`${event}\n`)});
    const emoji = Buffer.from("😀");
    const split = bytes.indexOf(emoji) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
  `;

  const result = await runChild({
    invocation: { command: process.execPath, args: ["-e", script] },
    cwd: process.cwd(),
  });

  assert.equal(result.output, "split 😀 output");
});

test("cancels the child process", async () => {
  const controller = new AbortController();
  const running = runChild({
    invocation: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
    cwd: process.cwd(),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, /cancelled/);
});

test("truncates oversized output without splitting Unicode", () => {
  const output = `${"😀".repeat(MAX_RESULT_BYTES)}\n${"line\n".repeat(MAX_RESULT_LINES + 5)}`;
  const result = truncateResult(output);

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= MAX_RESULT_BYTES);
  assert.ok(result.content.split("\n").length <= MAX_RESULT_LINES);
  assert.ok(!result.content.includes("�"));
  assert.match(result.content, /output truncated/i);
});
