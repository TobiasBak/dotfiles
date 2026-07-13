import assert from "node:assert/strict";
import test from "node:test";

import compactToolLoop from "../configs/pi/extensions/compact-tool-loop.ts";

const HIGH_USAGE = { tokens: 249_327, contextWindow: 272_000, percent: 91.7 };
const NOTHING_TO_COMPACT = new Error("Nothing to compact (session too small)");

function createHarness() {
  const handlers = new Map();
  const compactCalls = [];
  const notifications = [];
  const sentMessages = [];
  let idle = false;

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };

  const ctx = {
    hasUI: true,
    getContextUsage: () => HIGH_USAGE,
    compact(options) {
      compactCalls.push(options);
    },
    isIdle: () => idle,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus() {},
    },
  };

  compactToolLoop(pi);

  return {
    compactCalls,
    ctx,
    handlers,
    notifications,
    sentMessages,
    setIdle(value) {
      idle = value;
    },
  };
}

function emitToolTurn(harness) {
  harness.handlers.get("turn_end")(
    { message: { role: "assistant", stopReason: "toolUse" } },
    harness.ctx,
  );
}

test("creates a safe turn boundary when the first tool-loop compaction has no compactable prefix", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  assert.equal(harness.compactCalls.length, 1);

  harness.compactCalls[0].onError(NOTHING_TO_COMPACT);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].message, /reply with exactly "READY"/i);
  assert.deepEqual(harness.sentMessages[0].options, { deliverAs: "followUp" });
  assert.match(harness.notifications.at(-1).message, /creating a safe turn boundary/i);
  assert.equal(harness.notifications.at(-1).level, "warning");
});

test("continues the task after built-in compaction uses the recovery boundary", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.compactCalls[0].onError(NOTHING_TO_COMPACT);
  harness.handlers.get("session_compact")(
    { reason: "threshold", willRetry: false },
    harness.ctx,
  );

  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1].message, /continue the same task/i);
  assert.deepEqual(harness.sentMessages[1].options, { deliverAs: "followUp" });
});

test("stops with a clear error when the safe boundary still cannot be compacted", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.compactCalls[0].onError(NOTHING_TO_COMPACT);
  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.notifications.at(-1).level, "error");
  assert.match(harness.notifications.at(-1).message, /still no compactable history/i);
});

test("continues the task once after core retries an overflowing boundary turn", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.compactCalls[0].onError(NOTHING_TO_COMPACT);
  harness.handlers.get("session_compact")(
    { reason: "overflow", willRetry: true },
    harness.ctx,
  );
  assert.equal(harness.sentMessages.length, 1);

  harness.setIdle(true);
  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1].message, /continue the same task/i);
  assert.equal(harness.sentMessages[1].options, undefined);
});

test("allows one more manual compaction after creating the boundary without retrying forever", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.compactCalls[0].onError(NOTHING_TO_COMPACT);
  emitToolTurn(harness);
  assert.equal(harness.compactCalls.length, 2);

  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.notEqual(harness.notifications.at(-1).level, "error");

  harness.compactCalls[1].onError(NOTHING_TO_COMPACT);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.notifications.at(-1).level, "error");
  assert.match(harness.notifications.at(-1).message, /automatic continuation stopped/i);
});

test("leaves non-structural compaction failures stopped", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.compactCalls[0].onError(new Error("Authentication failed"));

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.notifications.at(-1).level, "error");
  assert.match(harness.notifications.at(-1).message, /Authentication failed/);
});

test("manual recovery compaction has a single continuation owner", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.compactCalls[0].onError(NOTHING_TO_COMPACT);
  emitToolTurn(harness);
  harness.handlers.get("session_compact")(
    { reason: "manual", willRetry: false },
    harness.ctx,
  );
  assert.equal(harness.sentMessages.length, 1);

  harness.compactCalls[1].onComplete();
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1].message, /continue the same task/i);
});
