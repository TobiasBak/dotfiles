import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FORK_CONTEXT_BLOCK_PERCENT,
  MAX_INLINE_CHILD_RESULT_BYTES,
  MAX_INLINE_GROUP_RESULT_BYTES,
  MAX_OBSERVED_CHANGE_OPERATIONS,
  MAX_OBSERVED_CHANGE_PATHS,
  MAX_OBSERVED_CHANGE_SNIPPET_BYTES,
  MAX_OBSERVED_CHANGES_DETAILS_BYTES,
  MAX_OBSERVED_CHANGES_DETAILS_LINES,
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
  SUBTASKS_WAIT_TOOL_NAME,
  appendSubtaskChildSystemPrompt,
  buildChildArgs,
  combineChildOutputWithObservedChanges,
  executeBatchMode,
  formatCapturedChangesMarkdown,
  formatObservedChanges,
  formatSubtaskGroupResult,
  formatSubtaskCost,
  formatSubtaskStatusLines,
  formatSubtaskWidgetLines,
  listSelectableTools,
  prepareSubtasksArguments,
  registerMutableWidget,
  runChild,
  shouldBlockForkedSubtasks,
  truncateResult,
} from "../configs/pi/extensions/subtask/core.ts";
import {
  createCapturedChangesWriter,
  createOverflowResultWriter,
} from "../configs/pi/extensions/subtask/overflow.ts";
import { createSubtasksExtension } from "../configs/pi/extensions/subtask/index.ts";
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

test("uses separate execution, wait, and control tools and excludes them from children", () => {
  assert.equal(SUBTASKS_TOOL_NAME, "subtasks");
  assert.equal(SUBTASKS_WAIT_TOOL_NAME, "subtasks_wait");
  assert.equal(SUBTASKS_CONTROL_TOOL_NAME, "subtasks_control");
  assert.deepEqual(
    listSelectableTools([
      "write",
      "subtasks",
      "subtasks_wait",
      "subtasks_control",
      "read",
      "write",
      "bash",
    ]),
    ["bash", "read", "write"],
  );
});

test("generates distinct task and group IDs", () => {
  const runtime = new SubtaskRuntimeState();
  const taskIds = new Set();
  const groupIds = new Set();
  for (let index = 0; index < 100; index += 1) {
    taskIds.add(runtime.allocateTaskId());
    groupIds.add(runtime.allocateGroupId());
  }

  assert.equal(taskIds.size, 100);
  assert.equal(groupIds.size, 100);
  assert.ok([...taskIds].every((id) => /^[0-9a-f]{6}$/.test(id)));
  assert.ok([...groupIds].every((id) => /^g-[0-9a-f]{6}$/.test(id)));
});

test("keeps execution metadata mechanical and delegation guidance tool-owned", () => {
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /isolated Pi processes/i);
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /share the current working directory/i);
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /Tasks in one call run in parallel/i);
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /all active eligible tools/i);
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /independently rediscover.*skills/i);
  assert.match(SUBTASKS_TOOL_DESCRIPTION, /parent-only CLI resources are not copied/i);
  assert.doesNotMatch(
    SUBTASKS_TOOL_DESCRIPTION,
    /1-16|research|implementation|\bLuna\b|\bSol\b|retrieval|architecture|high-consequence/i,
  );

  assert.ok(SUBTASKS_TOOL_PROMPT_GUIDELINES.length > 0);
});

const groupedTasks = [
  {
    id: "a1b2c3",
    groupId: "g-111111",
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
    groupId: "g-111111",
    task: "Verify behavior",
    status: "completed",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    elapsedMs: 65_000,
    contextTokens: 900,
    contextWindow: 272_000,
    toolCalls: 1,
  },
  {
    id: "112233",
    groupId: "g-222222",
    task: "Check failure",
    status: "failed",
  },
];

function widgetLineText(line) {
  return line.segments.map((segment) => segment.text).join("");
}

test("labels groups and keeps metadata before every task summary", () => {
  const lines = formatSubtaskStatusLines(groupedTasks);

  assert.equal(lines[0], "┌─ group g-111111 · 2 subtasks");
  assert.match(lines[1], /^├─ \[a1b2c3\] ● running\s+00:12/);
  assert.match(lines[2], /^└─ \[d4e5f6\] ✓ done\s+01:05/);
  assert.equal(lines[3], "┌─ group g-222222 · 1 subtask");
  assert.match(lines[4], /^└─ \[112233\] × failed\s+00:00/);
  assert.ok(lines[1].indexOf("$1.168") < lines[1].indexOf("18.2k/272k ctx"));
  assert.ok(lines[1].indexOf("18.2k/272k ctx") < lines[1].indexOf("3 tools"));
  assert.ok(lines[1].indexOf("3 tools") < lines[1].indexOf(" │ Inspect the target"));
});

test("keeps metadata before the task summary in narrow layouts", () => {
  const lines = formatSubtaskWidgetLines([groupedTasks[0]], 40);

  assert.deepEqual(
    lines.map((line) => line.kind),
    ["group", "status", "detail", "detail", "detail"],
  );
  assert.equal(widgetLineText(lines[0]), "┌─ group g-111111 · 1 subtask");
  assert.match(widgetLineText(lines[1]), /\[a1b2c3\].*running.*00:12/);
  assert.match(widgetLineText(lines[2]), /Sol\/Low.*\$1\.168/);
  assert.match(widgetLineText(lines[3]), /18\.2k\/272k ctx.*3 tools/);
  assert.match(widgetLineText(lines[4]), /Inspect the target/);
});

test("keeps telemetry compact in wide layouts", () => {
  const lines = formatSubtaskWidgetLines(groupedTasks.slice(0, 2), 120);
  const taskLines = lines.slice(1).map(widgetLineText);

  assert.equal(lines.length, 3);
  assert.match(taskLines[0], /Sol\/Low.*\$1\.168.*18\.2k\/272k ctx.*3 tools.*│.*Inspect the target/);
  assert.match(taskLines[1], /Luna\/Medium.*\$0\.000.*900\/272k ctx.*1 tool.*│.*Verify behavior/);
});

test("updates a registered widget in place without changing widget order", () => {
  const registrations = [];
  const widgets = new Map();
  let renders = 0;
  const tui = { requestRender: () => { renders += 1; } };
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
  const ctx = {
    mode: "tui",
    ui: {
      setWidget(key, content) {
        widgets.delete(key);
        if (content === undefined) return;
        registrations.push(key);
        widgets.set(key, content(tui, theme));
      },
    },
  };
  const running = [{ id: "a1b2c3", task: "First", status: "running", elapsedMs: 1_000 }];
  const widget = registerMutableWidget({
    setWidget: ctx.ui.setWidget,
    key: "subtasks:first",
    initialValue: running,
    placement: "belowEditor",
    createComponent: (getTasks) => ({
      render: () => formatSubtaskStatusLines(getTasks()),
      invalidate() {},
    }),
  });
  ctx.ui.setWidget("subtasks:second", () => ({ render: () => ["second"], invalidate() {} }));

  widget.update([{ ...running[0], status: "completed", elapsedMs: 2_000 }]);
  widget.update([{ ...running[0], status: "completed", elapsedMs: 3_000 }]);

  assert.deepEqual([...widgets.keys()], ["subtasks:first", "subtasks:second"]);
  assert.equal(registrations.filter((key) => key === "subtasks:first").length, 1);
  assert.equal(renders, 2);
  assert.match(widgets.get("subtasks:first").render(120).join("\n"), /✓ done\s+00:03/);

  widget.clear();
  assert.equal(widgets.has("subtasks:first"), false);
});

test("bounds the task summary without splitting Unicode", () => {
  const lines = formatSubtaskWidgetLines([
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
  ], 120);
  const summary = lines.flatMap((line) => line.segments).find((segment) => segment.role === "summary").text;

  assert.equal(Array.from(summary).length, MAX_SUBTASK_SUMMARY_CHARS);
  assert.ok(summary.endsWith("…"));
  assert.ok(!summary.includes("�"));
});

test("formats child costs compactly with small-cost precision", () => {
  assert.equal(formatSubtaskCost(), "$0.000");
  assert.equal(formatSubtaskCost(1.1684), "$1.168");
  assert.equal(formatSubtaskCost(0.00042), "$0.000");
});

test("builds a fresh child invocation without overriding discovered append prompts", () => {
  const args = buildChildArgs({
    task: "Inspect the target",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "low",
    tools: ["read", "grep"],
  });

  assert.ok(args.includes("--no-session"));
  assert.equal(args.includes("--no-skills"), false);
  assert.ok(args.includes("--no-prompt-templates"));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), [
    "--tools",
    "read,grep",
  ]);
  assert.equal(args.includes("--append-system-prompt"), false);
  assert.equal(args.at(-1), "Task:\nInspect the target");
});

test("keeps caller task unchanged in a forked child", () => {
  const task = "Review the prior decision\n\nDo not edit files.";
  const args = buildChildArgs({
    task,
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    tools: [],
    sessionFile: "/tmp/fork.jsonl",
  });

  assert.equal(args.includes("--append-system-prompt"), false);
  assert.equal(args.at(-1), `Task:\n${task}`);
  assert.equal(args.includes("--session"), true);
  assert.equal(args.includes("--no-session"), false);
});

test("appends the child contract after the discovered system prompt", () => {
  assert.equal(
    appendSubtaskChildSystemPrompt("discovered prompt"),
    `discovered prompt\n\n${SUBTASK_CHILD_SYSTEM_PROMPT}`,
  );
});

test("blocks forked subtasks at 65 percent parent context usage", () => {
  assert.equal(FORK_CONTEXT_BLOCK_PERCENT, 65);
  assert.equal(shouldBlockForkedSubtasks(true, 64.999), false);
  assert.equal(shouldBlockForkedSubtasks(true, 65), true);
  assert.equal(shouldBlockForkedSubtasks(true, 90), true);
  assert.equal(shouldBlockForkedSubtasks(false, 90), false);
  assert.equal(shouldBlockForkedSubtasks(true, null), false);
  assert.equal(shouldBlockForkedSubtasks(true, undefined), false);
});

test("maps legacy arguments without exposing async or per-child tools", () => {
  assert.deepEqual(
    prepareSubtasksArguments({ tasks: [{ task: "A", tools: ["read"] }], async: true }),
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
  assert.deepEqual(
    prepareSubtasksArguments({
      task: "A",
      model: "openai-codex/gpt-5.6-luna",
      thinking: "low",
      tools: [],
    }),
    {
      tasks: [{
        task: "A",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "low",
        fork: undefined,
      }],
    },
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
  assert.equal(args.includes("--append-system-prompt"), false);
});

test("extension keeps fork and wait guidance with their parameters", () => {
  const source = readFileSync(
    new URL("../configs/pi/extensions/subtask/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /wait: Type\.Optional\(\s*Type\.Boolean/);
  assert.match(source, /appendSubtaskChildSystemPrompt\(event\.systemPrompt\)/);
  assert.match(source, /through the current user message, excluding the current assistant turn/);
  assert.match(source, /name: SUBTASKS_WAIT_TOOL_NAME/);
  assert.match(source, /runtime\.waitForGroups\(params\.groupIds, signal\)/);
  assert.doesNotMatch(source, /async: Type\.Optional\(\s*Type\.Boolean/);
  assert.match(source, /promptGuidelines: SUBTASKS_TOOL_PROMPT_GUIDELINES/);
  assert.doesNotMatch(source, /tools:\s*Type\.Array/);
  assert.match(source, /const childTools = getSelectableToolNames\(pi\)/);
  assert.match(source, /tools: childTools/);
  assert.match(source, /default: true/);
  assert.match(source, /retained for subtasks_wait retrieval/);
  assert.doesNotMatch(source, /Results were delivered automatically/);
  assert.doesNotMatch(source, /steer queue/);
  assert.match(source, /deliverAs: "steer", triggerTurn: true/);
});

test("defaults Pi steering delivery to all queued messages", () => {
  const settings = JSON.parse(
    readFileSync(new URL("../configs/pi/settings.json", import.meta.url), "utf8"),
  );

  assert.equal(settings.steeringMode, "all");
});

test("wait mode holds the tool open and delivers completion through steer", async () => {
  const batch = deferred();
  const deliveries = [];
  let detached = false;
  let settled = false;
  const execution = executeBatchMode({
    wait: true,
    completion: batch.promise,
    detach: () => {
      detached = true;
    },
    deliverSuccess: (result) => deliveries.push({ type: "steer", result }),
    deliverFailure: (error) => deliveries.push({ type: "failure", error }),
  }).finally(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(detached, false);
  assert.deepEqual(deliveries, []);

  batch.resolve("finished");
  await execution;
  assert.equal(detached, false);
  assert.deepEqual(deliveries, [{ type: "steer", result: "finished" }]);
});

test("wait mode delivers failure through steer instead of rejecting the tool", async () => {
  const batch = deferred();
  const deliveries = [];
  const execution = executeBatchMode({
    wait: true,
    completion: batch.promise,
    detach() {},
    deliverSuccess: (value) => deliveries.push({ type: "success", value }),
    deliverFailure: (error) => deliveries.push({ type: "failure", error }),
  });

  const failure = new Error("child exploded");
  batch.reject(failure);
  await execution;
  assert.deepEqual(deliveries, [{ type: "failure", error: failure }]);
});

test("wait=false returns immediately and delivers eventual success once", async () => {
  const batch = deferred();
  const deliveries = [];
  let detachCount = 0;
  await executeBatchMode({
    wait: false,
    completion: batch.promise,
    detach: () => {
      detachCount += 1;
    },
    deliverSuccess: (value) => deliveries.push({ type: "steer", value }),
    deliverFailure: (error) => deliveries.push({ type: "failure", error }),
  });

  assert.equal(detachCount, 1);
  assert.deepEqual(deliveries, []);
  batch.resolve("background result");
  await eventually(() => deliveries.length === 1);
  assert.deepEqual(deliveries, [{ type: "steer", value: "background result" }]);
});

test("caller abort detaches wait without cancelling completion", async () => {
  const batch = deferred();
  const caller = new AbortController();
  const backgroundEvents = [];
  let detachCount = 0;
  const execution = executeBatchMode({
    wait: true,
    completion: batch.promise,
    callerSignal: caller.signal,
    detach: () => {
      detachCount += 1;
    },
    deliverSuccess: (value) => backgroundEvents.push({ type: "steer", value }),
    deliverFailure: (error) => backgroundEvents.push({ type: "failure", error }),
  });

  caller.abort();
  await execution;
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
    detach() {},
    deliverSuccess: (value) => backgroundEvents.push({ type: "success", value }),
    deliverFailure: (error) => backgroundEvents.push({ type: "failure", error }),
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

test("detached completion remains recoverable after best-effort delivery is lost", async () => {
  const runtime = new SubtaskRuntimeState();
  const batch = deferred();
  const caller = new AbortController();
  const adapterInvocations = [];
  let detachCount = 0;
  const retained = {
    content: "## Subtask group g-a1b2c3 [completed]\n\nchild report survived",
    details: { groupId: "g-a1b2c3", status: "completed" },
  };
  const completion = batch.promise.then(() => ({ status: "completed", result: retained }));
  runtime.trackGroup("g-a1b2c3", ["111111"], new AbortController(), completion);
  runtime.bindDelivery((delivery) => {
    // The adapter accepts the call synchronously, but the simulated Pi steer is
    // never persisted.
    adapterInvocations.push(delivery.content);
  });

  const execution = executeBatchMode({
    wait: true,
    completion,
    callerSignal: caller.signal,
    detach: () => {
      detachCount += 1;
    },
    deliverSuccess: ({ result }) => runtime.deliver(result),
    deliverFailure: (error) => {
      throw error;
    },
  });
  caller.abort();
  await execution;
  assert.equal(detachCount, 1);

  batch.resolve();
  await eventually(() => adapterInvocations.length === 1);
  assert.deepEqual(adapterInvocations, [retained.content]);
  assert.deepEqual(await runtime.waitForGroups(["g-a1b2c3"]), {
    groups: [
      {
        id: "g-a1b2c3",
        taskIds: ["111111"],
        status: "completed",
        result: retained,
      },
    ],
    aborted: false,
  });
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

test("waits once for every requested group and retains terminal results", async () => {
  const runtime = new SubtaskRuntimeState();
  const first = deferred();
  const second = deferred();
  const completedResult = { content: "completed report", details: { status: "completed" } };
  const failedResult = { content: "failure report", details: { status: "failed" } };
  runtime.trackGroup("g-a1b2c3", ["111111"], new AbortController(), first.promise);
  runtime.trackGroup("g-d4e5f6", ["222222", "333333"], new AbortController(), second.promise);

  let settled = false;
  const waiting = runtime.waitForGroups(["g-a1b2c3", "g-d4e5f6"]).finally(() => {
    settled = true;
  });
  first.resolve({ status: "completed", result: completedResult });
  await Promise.resolve();
  assert.equal(settled, false);

  second.resolve({ status: "failed", result: failedResult });
  assert.deepEqual(await waiting, {
    groups: [
      {
        id: "g-a1b2c3",
        taskIds: ["111111"],
        status: "completed",
        result: completedResult,
      },
      {
        id: "g-d4e5f6",
        taskIds: ["222222", "333333"],
        status: "failed",
        result: failedResult,
      },
    ],
    aborted: false,
  });
  assert.deepEqual(runtime.listGroups(), [
    { id: "g-a1b2c3", taskIds: ["111111"], status: "completed" },
    { id: "g-d4e5f6", taskIds: ["222222", "333333"], status: "failed" },
  ]);

  runtime.forgetGroups(["g-a1b2c3", "g-d4e5f6"]);
  assert.deepEqual(runtime.listGroups(), []);
});

test("prunes the oldest terminal group together with its retained result", async () => {
  const runtime = new SubtaskRuntimeState();
  for (let index = 0; index < 64; index += 1) {
    const id = `g-${index.toString(16).padStart(6, "0")}`;
    runtime.trackGroup(id, [], new AbortController(), Promise.resolve({
      status: "completed",
      result: { content: `result ${index}`, details: { index } },
    }));
  }
  await eventually(() => runtime.listGroups().every((group) => group.status === "completed"));

  const newestResult = { content: "newest result", details: { index: 64 } };
  runtime.trackGroup("g-000040", [], new AbortController(), Promise.resolve({
    status: "completed",
    result: newestResult,
  }));
  assert.equal(runtime.listGroups().length, 64);
  assert.deepEqual(runtime.listGroups(["g-000000"]), []);
  assert.deepEqual(await runtime.waitForGroups(["g-000040"]), {
    groups: [
      {
        id: "g-000040",
        taskIds: [],
        status: "completed",
        result: newestResult,
      },
    ],
    aborted: false,
  });
});

test("aborting a group wait detaches the waiter without cancelling subtasks", async () => {
  const runtime = new SubtaskRuntimeState();
  const groupController = new AbortController();
  const completion = deferred();
  runtime.trackGroup("g-a1b2c3", ["111111"], groupController, completion.promise);
  const caller = new AbortController();

  const waiting = runtime.waitForGroups(["g-a1b2c3"], caller.signal);
  caller.abort();
  assert.deepEqual(await waiting, {
    groups: [{ id: "g-a1b2c3", taskIds: ["111111"], status: "running" }],
    aborted: true,
  });
  assert.equal(groupController.signal.aborted, false);

  const retained = { content: "finished later", details: {} };
  completion.resolve({ status: "completed", result: retained });
  assert.deepEqual(await runtime.waitForGroups(["g-a1b2c3"]), {
    groups: [
      {
        id: "g-a1b2c3",
        taskIds: ["111111"],
        status: "completed",
        result: retained,
      },
    ],
    aborted: false,
  });
});

test("rejects waits for unknown group IDs instead of hanging", async () => {
  const runtime = new SubtaskRuntimeState();
  await assert.rejects(runtime.waitForGroups(["g-ffffff"]), /Unknown subtask group IDs: g-ffffff/);
});

test("subtasks_wait returns the retained report and forgets it after retrieval", async () => {
  const runtime = getSubtaskRuntimeState();
  await runtime.stopAndCancel();
  const handlers = new Map();
  const tools = new Map();
  let activeTools = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next) {
      activeTools = next;
    },
    sendMessage() {},
  };
  const childEnvironment = process.env.PI_SUBTASK_CHILD;
  delete process.env.PI_SUBTASK_CHILD;
  try {
    createSubtasksExtension()(pi);
  } finally {
    if (childEnvironment === undefined) delete process.env.PI_SUBTASK_CHILD;
    else process.env.PI_SUBTASK_CHILD = childEnvironment;
  }
  handlers.get("session_start")({ reason: "startup" }, {});

  const completion = deferred();
  const retained = {
    content: "## Subtask group g-a1b2c3 [failed]\n\nrecoverable failure details",
    details: { groupId: "g-a1b2c3", status: "failed" },
  };
  runtime.trackGroup("g-a1b2c3", ["111111"], new AbortController(), completion.promise);
  completion.resolve({ status: "failed", result: retained });

  const toolResult = await tools.get(SUBTASKS_WAIT_TOOL_NAME).execute(
    "wait-call",
    { groupIds: ["g-a1b2c3"] },
  );
  assert.equal(toolResult.content[0].text, retained.content);
  assert.deepEqual(toolResult.details.groups[0].result, retained);
  assert.deepEqual(runtime.listGroups(), []);
  await runtime.stopAndCancel();
});

test("normal shutdown cancels tasks and groups, awaits them, and drops queued delivery", async () => {
  const runtime = new SubtaskRuntimeState();
  const taskController = new AbortController();
  const groupController = new AbortController();
  const task = deferred();
  const group = deferred();
  taskController.signal.addEventListener("abort", () => task.reject(new Error("task cancelled")));
  groupController.signal.addEventListener("abort", () =>
    group.resolve({
      status: "cancelled",
      result: { content: "group cancelled", details: { status: "cancelled" } },
    }),
  );
  runtime.trackTask("a1b2c3", taskController, task.promise, () => ({
    id: "a1b2c3",
    task: "Stop normally",
    status: "running",
  }));
  runtime.trackGroup("g-a1b2c3", ["a1b2c3"], groupController, group.promise);
  runtime.bindDelivery(() => {});
  runtime.suspendForReload();
  runtime.deliver({ content: "must be dropped", details: {} });

  await runtime.stopAndCancel();
  assert.equal(taskController.signal.aborted, true);
  assert.equal(groupController.signal.aborted, true);
  assert.deepEqual(runtime.listTasks(), []);
  assert.deepEqual(runtime.listGroups(), []);

  const deliveries = [];
  runtime.bindDelivery((delivery) => deliveries.push(delivery.content));
  assert.deepEqual(deliveries, []);
});

test("writes private Markdown overflow results under the session and group", async () => {
  const sessionId = `test-${process.pid}-${Date.now()}`;
  const retainedPaths = [];
  const writer = createOverflowResultWriter(sessionId, "g-a1b2c3", (temporaryPath) => {
    retainedPaths.push(temporaryPath);
  });
  const expectedSessionDirectory = join(tmpdir(), "pi-subtasks", sessionId);

  try {
    const outputPath = await writer("d4e5f6", "# Full result\n\nDetails");
    assert.equal(
      outputPath,
      join(expectedSessionDirectory, "g-a1b2c3", "d4e5f6.md"),
    );
    assert.deepEqual(retainedPaths, [expectedSessionDirectory]);
    assert.equal(readFileSync(outputPath, "utf8"), "# Full result\n\nDetails");
    assert.equal(statSync(expectedSessionDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(join(expectedSessionDirectory, "g-a1b2c3")).mode & 0o777, 0o700);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  } finally {
    rmSync(expectedSessionDirectory, { recursive: true, force: true });
  }
});

test("writes private per-subtask captured-change artifacts", async () => {
  const sessionId = `test-${process.pid}-${Date.now()}`;
  const retainedPaths = [];
  const writer = createCapturedChangesWriter(sessionId, "g-a1b2c3", (temporaryPath) => {
    retainedPaths.push(temporaryPath);
  });
  const expectedSessionDirectory = join(tmpdir(), "pi-subtasks", sessionId);

  try {
    const outputPath = await writer("d4e5f6", "# Captured changes\n\nDetails");
    assert.equal(
      outputPath,
      join(expectedSessionDirectory, "g-a1b2c3", "d4e5f6-changes.md"),
    );
    assert.deepEqual(retainedPaths, [expectedSessionDirectory]);
    assert.equal(readFileSync(outputPath, "utf8"), "# Captured changes\n\nDetails");
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  } finally {
    rmSync(expectedSessionDirectory, { recursive: true, force: true });
  }
});

test("retained subtask outputs survive reload and are removed at normal shutdown", async () => {
  const runtime = new SubtaskRuntimeState();
  const directory = mkdtempSync(join(tmpdir(), "pi-subtask-runtime-test-"));
  writeFileSync(join(directory, "result.md"), "retained output");
  runtime.retainTemporaryPath(directory);

  runtime.suspendForReload();
  assert.equal(existsSync(directory), true);
  await runtime.stopAndCancel();
  assert.equal(existsSync(directory), false);
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
      type: "tool_execution_start",
      toolCallId: "shell-change",
      toolName: "hypa_shell",
      args: { command: "printf ignored > shell-only.txt" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "shell-change",
      toolName: "hypa_shell",
      result: { content: [] },
      isError: false,
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
    changedPaths: ["src/example.ts"],
    capturedOperations: 2,
  });
  assert.deepEqual(result.capturedChanges, [
    { kind: "write", path: "src/example.ts", content: "alpha\n😀\n" },
    { kind: "edit", path: "src/example.ts", content: patch },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private source|secret replacement|must not be retained/);
  const summary = formatObservedChanges(result.observedChanges, "/tmp/a1b2c3-changes.md");
  assert.match(summary, /### File changes/);
  assert.match(summary, /Full captured changes: `\/tmp\/a1b2c3-changes\.md`/);
  assert.match(summary, /1 file changed in 2 captured edit\/write operations/);
  assert.match(summary, /- `src\/example\.ts`/);
  assert.doesNotMatch(summary, /ignored\.txt|also-ignored\.txt|shell-only\.txt|```diff/);

  const artifact = formatCapturedChangesMarkdown("a1b2c3", result.capturedChanges);
  assert.match(artifact, /## Files changed/);
  assert.match(artifact, /Complete content passed to `write`/);
  assert.match(artifact, /alpha\n😀/);
  assert.ok(artifact.includes(patch));
});

test("keeps inline metadata bounded while retaining every changed path", async () => {
  const script = `
    for (let index = 0; index < ${MAX_OBSERVED_CHANGE_PATHS + 12}; index += 1) {
      const toolCallId = String(index);
      const args = { path: "p" + index + ".txt", content: "line\\n" };
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
  assert.equal(result.observedChanges.changedPaths.length, MAX_OBSERVED_CHANGE_PATHS + 12);
  assert.equal(result.observedChanges.capturedOperations, MAX_OBSERVED_CHANGE_PATHS + 12);
  assert.match(summary, /p0\.txt/);
  assert.match(summary, new RegExp(`p${MAX_OBSERVED_CHANGE_PATHS + 11}\\.txt`));
  assert.doesNotMatch(summary, /additional operations omitted/i);
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
  assert.deepEqual(result.observedChanges.changedPaths, ["edit.txt", "write.txt"]);
  assert.equal(result.capturedChanges.length, 2);
  const artifact = formatCapturedChangesMarkdown("a1b2c3", result.capturedChanges);
  assert.ok(artifact.includes(secret));
  assert.doesNotMatch(artifact, /�/);
});

test("returns complete child results inline when the group fits", async () => {
  const overflowWrites = [];
  const result = await formatSubtaskGroupResult(
    [
      {
        id: "a1b2c3",
        status: "completed",
        output: "first complete result",
        observedChanges: { files: [], omittedOperations: 0 },
      },
      {
        id: "d4e5f6",
        status: "completed",
        output: "second complete result",
        observedChanges: { files: [], omittedOperations: 0 },
      },
      {
        id: "000000",
        status: "completed",
        output: "",
        observedChanges: { files: [], omittedOperations: 0 },
      },
    ],
    async (taskId, content) => {
      overflowWrites.push({ taskId, content });
      return `/tmp/${taskId}.md`;
    },
  );

  assert.deepEqual(result.truncatedTaskIds, []);
  assert.deepEqual(result.overflowPaths, {});
  assert.deepEqual(overflowWrites, []);
  assert.match(result.content, /first complete result/);
  assert.match(result.content, /second complete result/);
});

test("always reports isolated captured-change artifacts for children that edited files", async () => {
  const overflowWrites = [];
  const changeWrites = [];
  const items = [
    {
      id: "a1b2c3",
      status: "completed",
      output: "first result",
      observedChanges: {
        files: [],
        omittedOperations: 1,
        changedPaths: ["src/first.ts"],
        capturedOperations: 1,
      },
      capturedChanges: [
        { kind: "edit", path: "src/first.ts", content: "@@ -1 +1 @@\n-old\n+first" },
      ],
    },
    {
      id: "d4e5f6",
      status: "completed",
      output: "second result",
      observedChanges: {
        files: [],
        omittedOperations: 1,
        changedPaths: ["src/second.ts"],
        capturedOperations: 1,
      },
      capturedChanges: [
        { kind: "write", path: "src/second.ts", content: "second\n" },
      ],
    },
  ];

  const result = await formatSubtaskGroupResult(
    items,
    async (taskId, content) => {
      overflowWrites.push({ taskId, content });
      return `/tmp/${taskId}.md`;
    },
    async (taskId, content) => {
      changeWrites.push({ taskId, content });
      return `/tmp/${taskId}-changes.md`;
    },
  );

  assert.deepEqual(overflowWrites, []);
  assert.deepEqual(result.changeArtifactPaths, {
    a1b2c3: "/tmp/a1b2c3-changes.md",
    d4e5f6: "/tmp/d4e5f6-changes.md",
  });
  assert.match(result.content, /Full captured changes: `\/tmp\/a1b2c3-changes\.md`/);
  assert.match(result.content, /Full captured changes: `\/tmp\/d4e5f6-changes\.md`/);
  assert.match(result.content, /- `src\/first\.ts`/);
  assert.match(result.content, /- `src\/second\.ts`/);
  assert.ok(changeWrites[0].content.includes("first"));
  assert.doesNotMatch(changeWrites[0].content, /src\/second\.ts|second result/);
  assert.ok(changeWrites[1].content.includes("second"));
  assert.doesNotMatch(changeWrites[1].content, /src\/first\.ts|first result/);
});

test("uses spare group capacity before truncating a larger child result", async () => {
  const overflowWrites = [];
  const items = [
    {
      id: "a1b2c3",
      status: "completed",
      output: "x".repeat(45 * 1024),
      observedChanges: { files: [], omittedOperations: 0 },
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `${index}`.repeat(6),
      status: "completed",
      output: "y".repeat(1_024),
      observedChanges: { files: [], omittedOperations: 0 },
    })),
  ];
  const result = await formatSubtaskGroupResult(items, async (taskId, content) => {
    overflowWrites.push({ taskId, content });
    return `/tmp/${taskId}.md`;
  });

  assert.deepEqual(result.truncatedTaskIds, []);
  assert.deepEqual(overflowWrites, []);
  assert.equal(result.content.includes("x".repeat(45 * 1024)), true);
});

test("saves oversized child results and returns searchable file paths", async () => {
  const overflowWrites = [];
  const observedChanges = {
    files: [
      {
        path: "src/example.ts",
        write: { calls: 1, bytes: 4, lines: 1 },
        snippets: [{ kind: "write", content: "+new", truncated: false }],
      },
    ],
    omittedOperations: 0,
  };
  const oversized = `conclusion first\n${"x".repeat(MAX_INLINE_CHILD_RESULT_BYTES + 1_000)}`;
  const result = await formatSubtaskGroupResult(
    [{ id: "a1b2c3", status: "completed", output: oversized, observedChanges }],
    async (taskId, content) => {
      overflowWrites.push({ taskId, content });
      return `/tmp/pi-subtasks/group/${taskId}.md`;
    },
  );

  assert.deepEqual(result.truncatedTaskIds, ["a1b2c3"]);
  assert.equal(result.overflowPaths.a1b2c3, "/tmp/pi-subtasks/group/a1b2c3.md");
  assert.equal(overflowWrites.length, 1);
  assert.match(overflowWrites[0].content, /conclusion first/);
  assert.match(overflowWrites[0].content, /### File changes/);
  assert.match(result.content, /Full output saved to:/);
  assert.match(result.content, /\/tmp\/pi-subtasks\/group\/a1b2c3\.md/);
  assert.match(result.content, /### File changes/);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= MAX_INLINE_CHILD_RESULT_BYTES);
});

test("shares the group context budget fairly and preserves every overflow result", async () => {
  const overflowWrites = [];
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `${index}`.repeat(6),
    status: "completed",
    output: `result ${index}\n${String(index).repeat(MAX_INLINE_CHILD_RESULT_BYTES)}`,
    observedChanges: { files: [], omittedOperations: 0 },
  }));
  const result = await formatSubtaskGroupResult(items, async (taskId, content) => {
    overflowWrites.push({ taskId, content });
    return `/tmp/pi-subtasks/group/${taskId}.md`;
  });

  assert.equal(result.truncatedTaskIds.length, 5);
  assert.equal(overflowWrites.length, 5);
  for (const item of items) {
    assert.match(result.content, new RegExp(`Subtask ${item.id}`));
    assert.match(result.content, new RegExp(`${item.id}\\.md`));
  }
  assert.ok(Buffer.byteLength(result.content, "utf8") <= MAX_INLINE_GROUP_RESULT_BYTES);
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
  const combined = combineChildOutputWithObservedChanges(
    "child prose ".repeat(10_000),
    observed,
    { maxBytes: 1_024, maxLines: 30 },
    "/tmp/a1b2c3-changes.md",
  );

  assert.equal(combined.truncated, true);
  assert.ok(Buffer.byteLength(combined.content, "utf8") <= 1_024);
  assert.ok(combined.content.split("\n").length <= 30);
  assert.match(combined.content, /Output truncated/i);
  assert.match(combined.content, /### File changes/);
  assert.match(combined.content, /Full captured changes: `\/tmp\/a1b2c3-changes\.md`/);
  assert.match(combined.content, /- `kept\.txt`/);
  assert.doesNotMatch(combined.content, /```diff/);
});

test("preserves the overflow path when the changed-file list fills the inline budget", () => {
  const changedPaths = Array.from({ length: 100 }, (_, index) =>
    `src/${index}-${"x".repeat(80)}.ts`
  );
  const observed = {
    files: [],
    omittedOperations: changedPaths.length,
    changedPaths,
    capturedOperations: changedPaths.length,
  };
  const overflowMarker = "\n\n[Result truncated. Full output saved to:\n/tmp/a1b2c3.md]";
  const combined = combineChildOutputWithObservedChanges(
    "child result",
    observed,
    { maxBytes: 1_024, maxLines: 30, marker: overflowMarker },
    "/tmp/a1b2c3-changes.md",
  );

  assert.equal(combined.truncated, true);
  assert.match(combined.content, /Full captured changes: `\/tmp\/a1b2c3-changes\.md`/);
  assert.match(combined.content, /Result truncated\. Full output saved to:/);
  assert.match(combined.content, /\/tmp\/a1b2c3\.md/);
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

test("keeps captures isolated when concurrent children reuse tool-call IDs", async () => {
  const childScript = (path, content) => {
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "shared-id",
        toolName: "write",
        args: { path, content },
      },
      {
        type: "tool_execution_end",
        toolCallId: "shared-id",
        toolName: "write",
        result: {},
        isError: false,
      },
    ];
    return events
      .map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`)
      .join(";");
  };

  const [first, second] = await Promise.all([
    runChild({
      invocation: { command: process.execPath, args: ["-e", childScript("first.txt", "first")] },
      cwd: process.cwd(),
    }),
    runChild({
      invocation: { command: process.execPath, args: ["-e", childScript("second.txt", "second")] },
      cwd: process.cwd(),
    }),
  ]);

  assert.deepEqual(first.capturedChanges, [
    { kind: "write", path: "first.txt", content: "first" },
  ]);
  assert.deepEqual(second.capturedChanges, [
    { kind: "write", path: "second.txt", content: "second" },
  ]);
});

test("cancels the child process while preserving completed file changes", async () => {
  const controller = new AbortController();
  const events = [
    {
      type: "tool_execution_start",
      toolCallId: "same-id",
      toolName: "write",
      args: { path: "before-cancel.txt", content: "preserved\n" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "same-id",
      toolName: "write",
      result: {},
      isError: false,
    },
  ];
  const script = `${events
    .map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`)
    .join(";")}; setInterval(() => {}, 1000)`;
  const running = runChild({
    invocation: { command: process.execPath, args: ["-e", script] },
    cwd: process.cwd(),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Subtask was cancelled");
  assert.deepEqual(result.observedChanges.changedPaths, ["before-cancel.txt"]);
  assert.deepEqual(result.capturedChanges, [
    { kind: "write", path: "before-cancel.txt", content: "preserved\n" },
  ]);
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
