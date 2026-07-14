import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_OBSERVED_CHANGE_OPERATIONS,
  MAX_OBSERVED_CHANGE_PATHS,
  MAX_OBSERVED_CHANGE_SNIPPET_BYTES,
  MAX_OBSERVED_CHANGES_DETAILS_BYTES,
  MAX_OBSERVED_CHANGES_DETAILS_LINES,
  MAX_OBSERVED_CHANGES_SUMMARY_BYTES,
  MAX_OBSERVED_CHANGES_SUMMARY_LINES,
  MAX_RESULT_BYTES,
  MAX_RESULT_LINES,
  MAX_SUBTASK_SUMMARY_CHARS,
  SUBTASK_CHILD_SYSTEM_PROMPT,
  SUBTASK_MODELS,
  SUBTASK_THINKING_LEVELS,
  SUBTASKS_CONTROL_TOOL_NAME,
  SUBTASKS_TOOL_DESCRIPTION,
  SUBTASKS_TOOL_NAME,
  SUBTASKS_TOOL_PROMPT_GUIDELINES,
  buildChildArgs,
  combineChildOutputWithObservedChanges,
  executeBatchMode,
  formatObservedChanges,
  formatSubtaskCost,
  formatSubtaskStatusLines,
  listSelectableTools,
  prepareSubtasksArguments,
  runChild,
  truncateResult,
} from "../configs/pi/extensions/subtask/core.ts";
import {
  SubtaskRuntimeState,
  getSubtaskRuntimeState,
} from "../configs/pi/extensions/subtask/runtime.ts";

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

test("uses separate execution and control tools and excludes both from children", () => {
  assert.equal(SUBTASKS_TOOL_NAME, "subtasks");
  assert.equal(SUBTASKS_CONTROL_TOOL_NAME, "subtasks_control");
  assert.deepEqual(
    listSelectableTools([
      "write",
      "subtasks",
      "subtasks_control",
      "read",
      "write",
      "bash",
    ]),
    ["bash", "read", "write"],
  );
});

test("generates unique six-character hexadecimal task IDs", () => {
  const runtime = new SubtaskRuntimeState();
  const ids = new Set();
  for (let index = 0; index < 100; index += 1) ids.add(runtime.allocateTaskId());

  assert.equal(ids.size, 100);
  assert.ok([...ids].every((id) => /^[0-9a-f]{6}$/.test(id)));
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
        id: "a1b2c3",
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
        id: "d4e5f6",
        task: "Verify behavior",
        status: "completed",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "medium",
        elapsedMs: 65_000,
        contextTokens: 900,
        contextWindow: 272_000,
        toolCalls: 1,
      },
      { id: "112233", task: "Check failure", status: "failed" },
    ]),
    [
      "├─ [a1b2c3] ● running   00:12  Sol · Low  ·  $1.168  ·  18.2k/272k ctx  ·  3 tools  │  Inspect the target",
      "├─ [d4e5f6] ✓ done      01:05  Luna · Medium  ·  $0.000  ·  900/272k ctx  ·  1 tool  │  Verify behavior",
      "└─ [112233] × failed    00:00  │  Check failure",
    ],
  );
});

test("puts a bounded task summary after all status metadata", () => {
  const [line] = formatSubtaskStatusLines([
    {
      id: "abcdef",
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

test("process-global runtime preserves active task identity across reloaded modules", async () => {
  const runtime = getSubtaskRuntimeState();
  await runtime.stopAndCancel();
  const reloadedModule = await import(
    new URL("../configs/pi/extensions/subtask/runtime.ts?simulated-reload", import.meta.url)
  );
  assert.equal(reloadedModule.getSubtaskRuntimeState(), runtime);

  const controller = new AbortController();
  const completion = deferred();
  const id = runtime.allocateTaskId();
  runtime.trackTask(id, controller, completion.promise, () => ({
    id,
    task: "Survive reload",
    status: "running",
  }));
  runtime.bindDelivery(() => {});
  runtime.suspendForReload();

  assert.deepEqual(runtime.listTasks().map((task) => task.id), [id]);
  assert.equal(controller.signal.aborted, false);

  completion.resolve("done");
  await eventually(() => runtime.listTasks().length === 0);
  await runtime.stopAndCancel();
});

test("a fixed inherited ID set excludes tasks launched after reload", async () => {
  const runtime = new SubtaskRuntimeState();
  const inherited = deferred();
  const launchedLater = deferred();
  const inheritedId = runtime.allocateTaskId();
  runtime.trackTask(inheritedId, new AbortController(), inherited.promise, () => ({
    id: inheritedId,
    task: "Inherited",
    status: "running",
  }));
  const inheritedIds = new Set(runtime.listTasks().map((task) => task.id));

  const laterId = runtime.allocateTaskId();
  runtime.trackTask(laterId, new AbortController(), launchedLater.promise, () => ({
    id: laterId,
    task: "Launched later",
    status: "running",
  }));

  assert.deepEqual(runtime.listTasks(inheritedIds).map((task) => task.id), [inheritedId]);
  inherited.resolve("done");
  launchedLater.resolve("done");
  await eventually(() => runtime.listTasks().length === 0);
});

test("runtime queues background delivery while suspended and flushes through the rebound adapter", () => {
  const runtime = new SubtaskRuntimeState();
  const oldRuntimeDeliveries = [];
  const newRuntimeDeliveries = [];
  runtime.bindDelivery((delivery) => oldRuntimeDeliveries.push(delivery.content));
  runtime.deliver({ content: "before reload", details: {} });

  runtime.suspendForReload();
  runtime.deliver({ content: "during reload", details: { id: "a1b2c3" } });
  assert.deepEqual(oldRuntimeDeliveries, ["before reload"]);

  runtime.bindDelivery((delivery) => newRuntimeDeliveries.push(delivery.content));
  assert.deepEqual(newRuntimeDeliveries, ["during reload"]);
});

test("runtime requeues a delivery rejected by a stale adapter", () => {
  const runtime = new SubtaskRuntimeState();
  const reboundDeliveries = [];
  runtime.bindDelivery(() => {
    throw new Error("stale Pi runtime");
  });

  runtime.deliver({ content: "completed during replacement", details: {} });
  runtime.bindDelivery((delivery) => reboundDeliveries.push(delivery.content));
  assert.deepEqual(reboundDeliveries, ["completed during replacement"]);
});

test("runtime lists tasks and cancels only requested IDs", async () => {
  const runtime = new SubtaskRuntimeState();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = deferred();
  const second = deferred();
  firstController.signal.addEventListener("abort", () => first.reject(new Error("first cancelled")));
  secondController.signal.addEventListener("abort", () => second.reject(new Error("second cancelled")));

  runtime.trackTask("a1b2c3", firstController, first.promise, () => ({
    id: "a1b2c3",
    task: "First",
    status: "running",
  }));
  runtime.trackTask("d4e5f6", secondController, second.promise, () => ({
    id: "d4e5f6",
    task: "Second",
    status: "running",
  }));

  assert.deepEqual(runtime.listTasks().map((task) => task.id), ["a1b2c3", "d4e5f6"]);
  assert.deepEqual(await runtime.cancelTasks(["a1b2c3", "ffffff"]), {
    cancelled: ["a1b2c3"],
    notRunning: ["ffffff"],
  });
  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, false);
  assert.deepEqual(runtime.listTasks().map((task) => task.id), ["d4e5f6"]);

  second.resolve("done");
  await eventually(() => runtime.listTasks().length === 0);
});

test("normal shutdown cancels tasks and batches, awaits them, and drops queued delivery", async () => {
  const runtime = new SubtaskRuntimeState();
  const taskController = new AbortController();
  const batchController = new AbortController();
  const task = deferred();
  const batch = deferred();
  taskController.signal.addEventListener("abort", () => task.reject(new Error("task cancelled")));
  batchController.signal.addEventListener("abort", () => batch.reject(new Error("batch cancelled")));
  runtime.trackTask("a1b2c3", taskController, task.promise, () => ({
    id: "a1b2c3",
    task: "Stop normally",
    status: "running",
  }));
  runtime.trackBatch(batchController, batch.promise);
  runtime.bindDelivery(() => {});
  runtime.suspendForReload();
  runtime.deliver({ content: "must be dropped", details: {} });

  await runtime.stopAndCancel();
  assert.equal(taskController.signal.aborted, true);
  assert.equal(batchController.signal.aborted, true);
  assert.deepEqual(runtime.listTasks(), []);

  const deliveries = [];
  runtime.bindDelivery((delivery) => deliveries.push(delivery.content));
  assert.deepEqual(deliveries, []);
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

test("collects successful edit and write calls by path with deterministic statistics", async () => {
  const patch = [
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,5 +1,5 @@",
    "-old one",
    "-old two",
    "+new one",
    "+new two",
    "+added line",
    " unchanged",
    "-deleted line",
    " tail",
  ].join("\n");
  const events = [
    {
      type: "tool_execution_start",
      toolCallId: "edit-ok",
      toolName: "edit",
      args: { path: "src/example.ts", edits: [{ oldText: "private source", newText: "secret replacement" }] },
    },
    {
      type: "tool_execution_start",
      toolCallId: "write-ok",
      toolName: "write",
      args: { path: "src/example.ts", content: "alpha\n😀\n" },
    },
    {
      type: "tool_execution_start",
      toolCallId: "write-failed",
      toolName: "write",
      args: { path: "ignored.txt", content: "must not be retained" },
    },
    {
      type: "tool_execution_start",
      toolCallId: "edit-failed",
      toolName: "edit",
      args: { path: "also-ignored.txt", edits: [] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "write-failed",
      toolName: "write",
      result: { content: [] },
      isError: true,
    },
    {
      type: "tool_execution_end",
      toolCallId: "edit-failed",
      toolName: "edit",
      result: { details: { patch } },
      isError: true,
    },
    {
      type: "tool_execution_end",
      toolCallId: "write-ok",
      toolName: "write",
      result: { content: [] },
      isError: false,
    },
    {
      type: "tool_execution_end",
      toolCallId: "edit-ok",
      toolName: "edit",
      result: { details: { patch } },
      isError: false,
    },
  ];
  const script = events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`).join(";");
  const result = await runChild({
    invocation: { command: process.execPath, args: ["-e", script] },
    cwd: process.cwd(),
  });

  assert.deepEqual(result.observedChanges, {
    files: [
      {
        path: "src/example.ts",
        edit: { calls: 1, replacements: 2, additions: 1, deletions: 1 },
        write: { calls: 1, bytes: 11, lines: 2 },
        snippets: [
          { kind: "write", content: "+alpha\n+😀\n", truncated: false },
          { kind: "edit", content: patch, truncated: false },
        ],
      },
    ],
    omittedOperations: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /private source|secret replacement|must not be retained/);
  const summary = formatObservedChanges(result.observedChanges);
  assert.match(summary, /### File changes/);
  assert.doesNotMatch(summary, /not a definitive final diff|write 1 call|prior content was unavailable/);
  assert.match(summary, /#### `src\/example\.ts`/);
  assert.match(summary, /```diff\n\+alpha\n\+😀\n```/);
  assert.ok(summary.includes(`\`\`\`diff\n${patch}\n\`\`\``));
  assert.doesNotMatch(summary, /ignored\.txt|also-ignored\.txt/);
});

test("keeps observed-change metadata and formatting bounded", async () => {
  const script = `
    for (let index = 0; index < ${MAX_OBSERVED_CHANGE_PATHS + 12}; index += 1) {
      const toolCallId = String(index);
      const args = { path: "p" + index + "/" + "x".repeat(700), content: "line\\n" };
      console.log(JSON.stringify({ type: "tool_execution_start", toolCallId, toolName: "write", args }));
      console.log(JSON.stringify({ type: "tool_execution_end", toolCallId, toolName: "write", result: {}, isError: false }));
    }
  `;
  const result = await runChild({
    invocation: { command: process.execPath, args: ["-e", script] },
    cwd: process.cwd(),
  });
  const summary = formatObservedChanges(result.observedChanges);

  assert.ok(result.observedChanges.files.length <= MAX_OBSERVED_CHANGE_PATHS);
  assert.equal(
    result.observedChanges.files.length + result.observedChanges.omittedOperations,
    MAX_OBSERVED_CHANGE_PATHS + 12,
  );
  assert.ok(
    Buffer.byteLength(
      result.observedChanges.files.map((file) => file.path + file.snippets.map((snippet) => snippet.content).join("")).join(""),
      "utf8",
    ) <= MAX_OBSERVED_CHANGES_DETAILS_BYTES,
  );
  assert.ok(
    result.observedChanges.files
      .flatMap((file) => file.snippets)
      .reduce((lines, snippet) => lines + (snippet.content.match(/\r\n|\r|\n/g)?.length ?? 0) + 1, 0) <=
      MAX_OBSERVED_CHANGES_DETAILS_LINES,
  );
  assert.ok(Buffer.byteLength(summary, "utf8") <= MAX_OBSERVED_CHANGES_SUMMARY_BYTES);
  assert.ok(summary.split("\n").length <= MAX_OBSERVED_CHANGES_SUMMARY_LINES);
  assert.match(summary, /output truncated|additional operations omitted/i);
});

test("bounds retained change text and truncates Unicode without replacement characters", async () => {
  const secret = "SECRET_BOUNDARY_" + "😀".repeat(MAX_OBSERVED_CHANGE_SNIPPET_BYTES * 2);
  const patch = `--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n-old\n+${secret}`;
  const events = [
    { type: "tool_execution_start", toolCallId: "w", toolName: "write", args: { path: "write.txt", content: secret } },
    { type: "tool_execution_start", toolCallId: "e", toolName: "edit", args: { path: "edit.txt", edits: [] } },
    { type: "tool_execution_end", toolCallId: "e", toolName: "edit", result: { details: { patch } }, isError: false },
    { type: "tool_execution_end", toolCallId: "w", toolName: "write", result: {}, isError: false },
  ];
  const script = events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`).join(";");
  const result = await runChild({ invocation: { command: process.execPath, args: ["-e", script] }, cwd: process.cwd() });
  const serialized = JSON.stringify(result.observedChanges);

  assert.ok(result.observedChanges.files.flatMap((file) => file.snippets).length <= MAX_OBSERVED_CHANGE_OPERATIONS);
  assert.ok(result.observedChanges.files.flatMap((file) => file.snippets).every((snippet) => Buffer.byteLength(snippet.content, "utf8") <= MAX_OBSERVED_CHANGE_SNIPPET_BYTES));
  assert.ok(result.observedChanges.files.flatMap((file) => file.snippets).every((snippet) => snippet.truncated));
  assert.doesNotMatch(serialized, /�/);
  assert.ok(Buffer.byteLength(serialized, "utf8") < Buffer.byteLength(secret, "utf8"));
  assert.match(formatObservedChanges(result.observedChanges), /Diff truncated/i);
});

test("omits the file-change section when no edit or write was observed", () => {
  const combined = combineChildOutputWithObservedChanges(
    "read-only result",
    { files: [], omittedOperations: 0 },
    { maxBytes: 1_024, maxLines: 30 },
  );

  assert.equal(combined.content, "read-only result");
  assert.equal(combined.truncated, false);
});

test("reserves observed-change summary space beside oversized child prose", () => {
  const observed = {
    files: [{
      path: "kept.txt",
      write: { calls: 1, bytes: 6, lines: 1 },
      snippets: [{ kind: "write", content: "+kept!", truncated: false }],
    }],
    omittedOperations: 0,
  };
  const combined = combineChildOutputWithObservedChanges("child prose ".repeat(10_000), observed, {
    maxBytes: 1_024,
    maxLines: 30,
  });

  assert.equal(combined.truncated, true);
  assert.ok(Buffer.byteLength(combined.content, "utf8") <= 1_024);
  assert.ok(combined.content.split("\n").length <= 30);
  assert.match(combined.content, /Output truncated/i);
  assert.match(combined.content, /### File changes/);
  assert.match(combined.content, /```diff\n\+kept!\n```/);
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
