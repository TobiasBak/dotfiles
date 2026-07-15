import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTORESEARCH_COMPACTION_INSTRUCTIONS,
  AUTORESEARCH_CONTINUATION_PROMPT,
  AUTORESEARCH_STATE_TYPE,
  COMPACT_TOOL_LOOP_PAUSED_EVENT,
  registerAutoresearch,
} from "../configs/pi/extensions/autoresearch.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const TEST_START_TIME = 1_000_000;

const enabledState = (turns = 0) => ({
  version: 2,
  enabled: true,
  startedAt: TEST_START_TIME,
  turns,
});

const disabledState = { version: 2, enabled: false, startedAt: null, turns: 0 };

function userEntry(text) {
  return {
    type: "message",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function assistantMessage(stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text: "checkpoint" }],
    stopReason,
    timestamp: Date.now(),
  };
}

function createHarness(
  initialEntries = [],
  { autoStart = true, compaction = "success" } = {},
) {
  const handlers = new Map();
  const commands = new Map();
  const eventListeners = new Map();
  const entries = [...initialEntries];
  const notifications = [];
  const widgets = [];
  const sentMessages = [];
  const compactions = [];
  let abortCalls = 0;
  let idle = true;
  let pendingMessages = false;
  let currentTime = TEST_START_TIME;

  const ctx = {
    hasUI: true,
    mode: "tui",
    abort() {
      abortCalls += 1;
    },
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    compact(options) {
      compactions.push(options);
      queueMicrotask(() => {
        if (compaction === "success") options.onComplete({});
        else if (compaction === "too-small") {
          options.onError(new Error("Nothing to compact (session too small)"));
        } else if (compaction === "error") {
          options.onError(new Error("provider unavailable"));
        }
      });
    },
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      theme: {
        fg(_color, text) {
          return text;
        },
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(id, value) {
        widgets.push({ id, value: value === undefined ? undefined : [value] });
      },
    },
  };

  const pi = {
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    events: {
      emit(event, data) {
        for (const listener of eventListeners.get(event) ?? []) listener(data);
      },
      on(event, listener) {
        const listeners = eventListeners.get(event) ?? [];
        listeners.push(listener);
        eventListeners.set(event, listeners);
        return () => {
          const current = eventListeners.get(event) ?? [];
          eventListeners.set(
            event,
            current.filter((candidate) => candidate !== listener),
          );
        };
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    sendUserMessage(message, options) {
      sentMessages.push({ message, options });
      handlers.get("input")({ source: "extension", text: message }, ctx);
      if (autoStart) {
        idle = false;
        handlers.get("agent_start")({}, ctx);
      }
    },
  };

  registerAutoresearch(pi, {
    startTimeoutMs: 15,
    compactionTimeoutMs: 15,
    statusIntervalMs: 0,
    loadProgram: () => "# Test Research Program\n\nRun one bounded experiment.",
    now: () => currentTime,
  });
  handlers.get("session_start")({ reason: "startup" }, ctx);

  return {
    commands,
    compactions,
    ctx,
    entries,
    eventBus: pi.events,
    get abortCalls() {
      return abortCalls;
    },
    handlers,
    notifications,
    sentMessages,
    advanceTime(durationMs) {
      currentTime += durationMs;
    },
    setIdle(value) {
      idle = value;
    },
    setPendingMessages(value) {
      pendingMessages = value;
    },
    widgets,
  };
}

async function command(harness, args) {
  await harness.commands.get("autoresearch").handler(args, harness.ctx);
}

function assertStatus(harness, phase, turns) {
  const turnLabel = `${turns} ${turns === 1 ? "turn" : "turns"}`;
  assert.match(
    harness.widgets.at(-1).value[0],
    new RegExp(`^/autoresearch · ${phase} · ${turnLabel} · \\d+(?:[hms]|m \\d+s|h \\d+m)$`),
  );
}

function startOperatorRun(harness, prompt = "Run the research program") {
  harness.entries.push(userEntry(prompt));
  harness.handlers.get("input")({ source: "interactive", text: prompt }, harness.ctx);
  harness.setIdle(false);
  harness.handlers.get("agent_start")({}, harness.ctx);
}

function settleRun(harness, stopReason = "stop") {
  harness.handlers.get("agent_end")({ messages: [assistantMessage(stopReason)] }, harness.ctx);
  harness.setIdle(true);
  harness.handlers.get("agent_settled")({}, harness.ctx);
}

test("is off by default and does not continue settled work", async () => {
  const harness = createHarness();

  startOperatorRun(harness);
  settleRun(harness);
  await tick();

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.widgets.at(-1).value, undefined);
});

test("bare command toggles persisted state and the footer status", async () => {
  const harness = createHarness();

  await command(harness, "");
  assert.deepEqual(harness.entries.at(-1).data, enabledState());
  assertStatus(harness, "ready", 0);

  await command(harness, "");
  assert.deepEqual(harness.entries.at(-1).data, disabledState);
  assert.equal(harness.widgets.at(-1).value, undefined);
});

test("bare command toggles off from restored enabled state", async () => {
  const harness = createHarness([
    { type: "custom", customType: AUTORESEARCH_STATE_TYPE, data: { version: 1, enabled: true } },
  ]);

  await command(harness, "");

  assert.deepEqual(harness.entries.at(-1).data, disabledState);
  assert.equal(harness.widgets.at(-1).value, undefined);
});

test("on persists branch-local state in an empty session", async () => {
  const harness = createHarness();

  await command(harness, "on");
  await tick();

  assert.deepEqual(harness.entries.at(-1), {
    type: "custom",
    customType: AUTORESEARCH_STATE_TYPE,
    data: enabledState(),
  });
  assert.equal(harness.sentMessages.length, 0);
  assertStatus(harness, "ready", 0);
  assert.match(harness.notifications.at(-1).message, /submit a research program/i);
});

test("footer tracks autoresearch turns and elapsed duration", async () => {
  const harness = createHarness();
  await command(harness, "on");
  harness.advanceTime(65_000);

  startOperatorRun(harness);

  assert.deepEqual(harness.entries.at(-1).data, enabledState(1));
  assert.equal(
    harness.widgets.at(-1).value[0],
    "/autoresearch · running · 1 turn · 1m 5s",
  );
});

test("restores persisted autoresearch metrics", () => {
  const harness = createHarness([
    {
      type: "custom",
      customType: AUTORESEARCH_STATE_TYPE,
      data: {
        version: 2,
        enabled: true,
        startedAt: TEST_START_TIME - 65_000,
        turns: 4,
      },
    },
  ]);

  assert.equal(
    harness.widgets.at(-1).value[0],
    "/autoresearch · ready · 4 turns · 1m 5s",
  );
});

test("compacts and rereads program.md exactly once after a successful run", async () => {
  const harness = createHarness();
  await command(harness, "on");

  startOperatorRun(harness);
  settleRun(harness);
  await tick();

  assert.equal(harness.compactions.length, 1);
  assert.equal(
    harness.compactions[0].customInstructions,
    AUTORESEARCH_COMPACTION_INSTRUCTIONS,
  );
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].options, undefined);
  assert.match(harness.sentMessages[0].message, /^\[autoresearch continuation.*\n@program\.md/);
  assert.match(harness.sentMessages[0].message, /# Test Research Program/);
  assert.match(AUTORESEARCH_CONTINUATION_PROMPT, /@program\.md/);
  assert.deepEqual(harness.entries.at(-1).data, enabledState(2));
  assertStatus(harness, "running", 2);
});

test("continues when the session is too small to compact", async () => {
  const harness = createHarness([], { compaction: "too-small" });
  await command(harness, "on");

  startOperatorRun(harness);
  settleRun(harness);
  await tick();

  assert.equal(harness.compactions.length, 1);
  assert.match(harness.sentMessages[0].message, /# Test Research Program/);
});

test("reissuing on cannot overlap a checkpoint compaction", async () => {
  const harness = createHarness([], { compaction: "pending" });
  await command(harness, "on");
  startOperatorRun(harness);
  settleRun(harness);
  await tick();

  await command(harness, "on");
  assert.equal(harness.compactions.length, 1);
  assertStatus(harness, "checkpointing", 1);

  harness.compactions[0].onComplete({});
  await tick();
  assert.equal(harness.sentMessages.length, 1);
});

test("pauses when checkpoint compaction fails", async () => {
  const harness = createHarness([], { compaction: "error" });
  await command(harness, "on");

  startOperatorRun(harness);
  settleRun(harness);
  await tick();

  assert.equal(harness.sentMessages.length, 0);
  assertStatus(harness, "paused", 1);
  assert.match(harness.notifications.at(-1).message, /compaction failed/i);
});

test("operator input during compaction prevents automatic continuation", async () => {
  const harness = createHarness([], { compaction: "pending" });
  await command(harness, "on");
  startOperatorRun(harness);
  settleRun(harness);
  await tick();
  assert.equal(harness.compactions.length, 1);
  assertStatus(harness, "checkpointing", 1);

  harness.handlers.get("input")({ source: "interactive", text: "Operator follow-up" }, harness.ctx);
  harness.compactions[0].onComplete({});
  await tick();

  assert.equal(harness.sentMessages.length, 0);
  assertStatus(harness, "ready", 1);
});

test("reissuing on kicks an idle session with an existing objective", async () => {
  const harness = createHarness([userEntry("Improve the benchmark repeatedly")]);

  await command(harness, "on");
  await tick();

  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.sentMessages[0].message.startsWith(AUTORESEARCH_CONTINUATION_PROMPT));
  assert.match(harness.sentMessages[0].message, /# Test Research Program/);
});

test("pauses when a submitted continuation never starts", async () => {
  const harness = createHarness([userEntry("Continue experimenting")], { autoStart: false });

  await command(harness, "on");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(harness.sentMessages.length, 1);
  assertStatus(harness, "paused", 0);
  assert.match(harness.notifications.at(-1).message, /did not start/i);
});

test("off aborts an autoresearch-owned run and prevents restart", async () => {
  const harness = createHarness([userEntry("Continue experimenting")]);
  await command(harness, "on");
  await tick();
  assert.equal(harness.sentMessages.length, 1);

  await command(harness, "off");
  settleRun(harness, "aborted");
  await tick();

  assert.equal(harness.abortCalls, 1);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.entries.at(-1).data, disabledState);
  assert.equal(harness.widgets.at(-1).value, undefined);
});

test("stale aborted settlement cannot pause a quickly re-enabled session", async () => {
  const harness = createHarness([userEntry("Continue experimenting")]);
  await command(harness, "on");
  await tick();
  assert.equal(harness.sentMessages.length, 1);

  await command(harness, "off");
  await command(harness, "on");
  settleRun(harness, "aborted");
  await tick();

  assert.deepEqual(harness.entries.at(-1).data, enabledState());
  assertStatus(harness, "ready", 0);
  assert.equal(harness.sentMessages.length, 1);
  assert.doesNotMatch(harness.notifications.at(-1).message, /paused/i);
});

test("off during continuation preflight aborts it as soon as its run starts", async () => {
  const harness = createHarness([userEntry("Continue experimenting")], { autoStart: false });
  await command(harness, "on");
  await tick();
  assert.equal(harness.sentMessages.length, 1);

  await command(harness, "off");
  harness.setIdle(false);
  harness.handlers.get("agent_start")({}, harness.ctx);

  assert.equal(harness.abortCalls, 1);
  assert.equal(harness.widgets.at(-1).value, undefined);
});

test("off during an operator run disables continuation without aborting user work", async () => {
  const harness = createHarness();
  await command(harness, "on");
  startOperatorRun(harness);

  await command(harness, "off");
  settleRun(harness);
  await tick();

  assert.equal(harness.abortCalls, 0);
  assert.equal(harness.sentMessages.length, 0);
});

test("errors, aborts, length limits, and tool boundaries pause instead of looping", async () => {
  for (const reason of ["error", "aborted", "length", "toolUse"]) {
    const harness = createHarness();
    await command(harness, "on");
    startOperatorRun(harness);
    settleRun(harness, reason);
    await tick();

    assert.equal(harness.sentMessages.length, 0, reason);
    assertStatus(harness, "paused", 1);
  }
});

test("queued input and input arriving in the settled race take priority", async () => {
  const queued = createHarness();
  await command(queued, "on");
  startOperatorRun(queued);
  queued.setPendingMessages(true);
  settleRun(queued);
  await tick();
  assert.equal(queued.sentMessages.length, 0);

  const raced = createHarness();
  await command(raced, "on");
  startOperatorRun(raced);
  settleRun(raced);
  raced.handlers.get("input")({ source: "interactive", text: "Operator follow-up" }, raced.ctx);
  await tick();
  assert.equal(raced.sentMessages.length, 0);
});

test("compact-tool-loop safety pause cancels a scheduled continuation", async () => {
  const harness = createHarness();
  await command(harness, "on");
  startOperatorRun(harness);
  settleRun(harness);

  harness.eventBus.emit(COMPACT_TOOL_LOOP_PAUSED_EVENT, {
    reason: "recovery-boundary-did-not-compact",
  });
  await tick();

  assert.equal(harness.sentMessages.length, 0);
  assertStatus(harness, "paused", 1);
});

test("restores the newest valid state on reload and tree navigation", async () => {
  const harness = createHarness([
    { type: "custom", customType: AUTORESEARCH_STATE_TYPE, data: { version: 1, enabled: true } },
    { type: "custom", customType: AUTORESEARCH_STATE_TYPE, data: { version: 1, enabled: false } },
  ]);
  assert.equal(harness.widgets.at(-1).value, undefined);

  harness.entries.push({
    type: "custom",
    customType: AUTORESEARCH_STATE_TYPE,
    data: { version: 1, enabled: true },
  });
  harness.handlers.get("session_tree")({}, harness.ctx);

  assertStatus(harness, "ready", 0);
  assert.equal(harness.sentMessages.length, 0);
});

test("fails closed on malformed persisted state", () => {
  const harness = createHarness([
    { type: "custom", customType: AUTORESEARCH_STATE_TYPE, data: { version: 2, enabled: true } },
  ]);

  assert.equal(harness.widgets.at(-1).value, undefined);
  assert.match(harness.notifications.at(-1).message, /malformed/i);
});

test("session shutdown cancels deferred continuation", async () => {
  const harness = createHarness();
  await command(harness, "on");
  startOperatorRun(harness);
  settleRun(harness);
  harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
  await tick();

  assert.equal(harness.sentMessages.length, 0);
});
