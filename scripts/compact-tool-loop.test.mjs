import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import compactToolLoop, {
  COMPACTION_HEADROOM_TOKENS,
} from "../configs/pi/extensions/compact-tool-loop.ts";

const HIGH_USAGE = { tokens: 249_327, contextWindow: 272_000, percent: 91.7 };
const LOW_USAGE = { tokens: 200_000, contextWindow: 272_000, percent: 73.5 };

function createHarness({ usage = HIGH_USAGE } = {}) {
  const handlers = new Map();
  const notifications = [];
  const sentMessages = [];
  const emittedEvents = [];
  let abortCalls = 0;
  let idle = false;
  let directPromptStarted = false;
  let queuedPromptPreflight = false;
  const queuedMessageErrors = [];
  const runtimeErrors = [];

  const pi = {
    events: {
      emit(event, data) {
        emittedEvents.push({ event, data });
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(message, options) {
      if (idle || options?.deliverAs === "followUp") {
        if (options === undefined) directPromptStarted = true;
        sentMessages.push({ message, options });
        return;
      }
      runtimeErrors.push(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    },
  };

  const ctx = {
    hasUI: true,
    getContextUsage: () => usage,
    abort() {
      abortCalls += 1;
    },
    compact() {
      throw new Error("The extension must not start a competing manual compaction");
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
    get abortCalls() {
      return abortCalls;
    },
    ctx,
    emittedEvents,
    handlers,
    notifications,
    queuedMessageErrors,
    runtimeErrors,
    sentMessages,
    startQueuedPromptPreflight(delayMs = 0) {
      queuedPromptPreflight = true;
      const finishPreflight = () => {
        if (!queuedPromptPreflight) return;
        queuedPromptPreflight = false;
        if (directPromptStarted) {
          queuedMessageErrors.push(
            "Failed to send queued message: Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
          );
          return;
        }
        idle = false;
      };
      if (delayMs > 0) setTimeout(finishPreflight, delayMs);
      else queueMicrotask(finishPreflight);
    },
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

function emitCoreCompaction(harness, { reason = "threshold", willRetry = false } = {}) {
  harness.handlers.get("session_compact")({ reason, willRetry }, harness.ctx);
}

test("uses the same compaction headroom configured for Pi core", () => {
  const settings = JSON.parse(
    readFileSync(new URL("../configs/pi/settings.json", import.meta.url), "utf8"),
  );

  assert.equal(settings.compaction.reserveTokens, COMPACTION_HEADROOM_TOKENS);
});

test("stops the tool loop and leaves compaction ownership to Pi core", () => {
  const harness = createHarness();

  emitToolTurn(harness);

  assert.equal(harness.abortCalls, 1);
  assert.match(harness.notifications.at(-1).message, /compacting before the next model request/i);
  assert.equal(harness.notifications.at(-1).level, "warning");
});

test("does not stop below the compaction threshold", () => {
  const harness = createHarness({ usage: LOW_USAGE });

  emitToolTurn(harness);

  assert.equal(harness.abortCalls, 0);
  assert.equal(harness.notifications.length, 0);
});

test("queues continuation through Pi core after threshold compaction", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  emitCoreCompaction(harness);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].message, /continue the same task/i);
  assert.deepEqual(harness.sentMessages[0].options, { deliverAs: "followUp" });

  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.sentMessages.length, 1);
  assert.doesNotMatch(harness.notifications.at(-1).message, /failed/i);
});

test("lets core own continuation when overflow compaction will retry", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  emitCoreCompaction(harness, { reason: "overflow", willRetry: true });
  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 0);
});

test("creates a safe turn boundary when core cannot compact the stopped tool loop", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].message, /reply with exactly "READY"/i);
  assert.deepEqual(harness.sentMessages[0].options, { deliverAs: "followUp" });
  assert.match(harness.notifications.at(-1).message, /creating a safe turn boundary/i);
  assert.equal(harness.notifications.at(-1).level, "warning");
});

test("queues continuation when the compacted recovery boundary starts", async () => {
  const harness = createHarness();
  harness.setIdle(true);

  emitToolTurn(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  emitCoreCompaction(harness);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].message, /reply with exactly "READY"/i);

  harness.setIdle(false);
  harness.handlers.get("agent_start")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1].message, /continue the same task/i);
  assert.deepEqual(harness.sentMessages[1].options, { deliverAs: "followUp" });
});

test("replaces a deferred recovery message when compaction wins the race", async () => {
  const harness = createHarness();
  harness.setIdle(true);

  emitToolTurn(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  emitCoreCompaction(harness);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.sentMessages.length, 0);

  harness.setIdle(false);
  harness.handlers.get("agent_start")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].message, /continue the same task/i);
});

test("stops clearly when core still does not compact the recovery boundary", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  harness.handlers.get("agent_settled")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.emittedEvents, [
    {
      event: "compact-tool-loop:paused",
      data: { reason: "recovery-boundary-did-not-compact" },
    },
  ]);
  assert.equal(harness.notifications.at(-1).level, "error");
  assert.match(harness.notifications.at(-1).message, /still did not compact/i);
  assert.match(harness.notifications.at(-1).message, /settings.*authentication/i);
});

test("ignores unrelated and duplicate compaction events", () => {
  const harness = createHarness();

  emitCoreCompaction(harness);
  assert.equal(harness.sentMessages.length, 0);

  emitToolTurn(harness);
  emitCoreCompaction(harness);
  emitCoreCompaction(harness);
  assert.equal(harness.sentMessages.length, 1);

  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(harness.sentMessages.length, 1);
});

test("does not treat manual compaction as the requested core auto-compaction", () => {
  const harness = createHarness();

  emitToolTurn(harness);
  emitCoreCompaction(harness, { reason: "manual", willRetry: false });

  assert.equal(harness.sentMessages.length, 0);
  harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.match(harness.sentMessages[0].message, /reply with exactly "READY"/i);
});

test("waits for agent_start through a delayed queued-prompt preflight", async () => {
  const harness = createHarness();
  harness.setIdle(true);

  emitToolTurn(harness);
  emitCoreCompaction(harness);
  harness.startQueuedPromptPreflight(10);

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(harness.queuedMessageErrors, []);
  assert.deepEqual(harness.runtimeErrors, []);
  assert.equal(harness.sentMessages.length, 0);

  harness.handlers.get("agent_start")({}, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0].options, { deliverAs: "followUp" });
});
