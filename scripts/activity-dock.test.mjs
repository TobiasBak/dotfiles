import assert from "node:assert/strict";
import test from "node:test";

import activityDockExtension, {
  beginActivityDock,
  clearWeeklyUsage,
  endActivityDock,
  updateWeeklyUsage,
} from "../configs/pi/extensions/activity-dock.ts";

function createHarness() {
  const eventListeners = new Map();
  const extensionHandlers = new Map();
  const events = {
    on(channel, handler) {
      const handlers = eventListeners.get(channel) ?? [];
      handlers.push(handler);
      eventListeners.set(channel, handlers);
      return () => eventListeners.set(channel, handlers.filter((candidate) => candidate !== handler));
    },
    emit(channel, data) {
      for (const handler of eventListeners.get(channel) ?? []) handler(data);
    },
  };
  const coordinatorPi = {
    events,
    on(event, handler) {
      const handlers = extensionHandlers.get(event) ?? [];
      handlers.push(handler);
      extensionHandlers.set(event, handlers);
    },
  };
  const clientPi = { events };
  return {
    coordinatorPi,
    clientPi,
    dispatch(event, ...args) {
      for (const handler of extensionHandlers.get(event) ?? []) handler(...args);
    },
  };
}

test("keeps weekly usage in the footer while activity widgets are active", () => {
  const statuses = [];
  const widgets = new Map();
  const registrations = [];
  let renders = 0;
  const theme = { fg: (_role, text) => text };
  const ctx = {
    mode: "tui",
    ui: {
      theme,
      setStatus(key, text) { statuses.push({ key, text }); },
      setWidget(key, content, options) {
        widgets.delete(key);
        if (content === undefined) return;
        registrations.push({ key, options });
        widgets.set(key, content({ requestRender: () => { renders += 1; } }, theme));
      },
    },
  };
  const harness = createHarness();
  activityDockExtension(harness.coordinatorPi);
  harness.dispatch("session_start", {}, ctx);

  updateWeeklyUsage(harness.clientPi, ctx, () => "Weekly usage 84% remaining");
  assert.equal(statuses.at(-1).text, "Weekly usage 84% remaining");

  beginActivityDock(harness.clientPi, ctx, "subtasks:first");
  beginActivityDock(harness.clientPi, ctx, "autoresearch-fleet");
  assert.equal(registrations.length, 0);
  assert.equal(statuses.at(-1).text, "Weekly usage 84% remaining");

  updateWeeklyUsage(harness.clientPi, ctx, () => "Weekly usage 83% remaining");
  assert.equal(registrations.length, 0);
  assert.equal(renders, 0);
  assert.equal(statuses.at(-1).text, "Weekly usage 83% remaining");

  endActivityDock(harness.clientPi, ctx, "subtasks:first");
  endActivityDock(harness.clientPi, ctx, "autoresearch-fleet");
  assert.equal(widgets.size, 0);
  assert.equal(statuses.at(-1).text, "Weekly usage 83% remaining");

  clearWeeklyUsage(harness.clientPi, ctx);
  assert.equal(statuses.at(-1).text, undefined);

  updateWeeklyUsage(harness.clientPi, ctx, () => "Weekly usage 82% remaining");
  beginActivityDock(harness.clientPi, ctx, "autoresearch-fleet");
  assert.equal(widgets.size, 0);
  assert.equal(statuses.at(-1).text, "Weekly usage 82% remaining");

  harness.dispatch("session_shutdown", {}, ctx);
  assert.equal(widgets.has("activity-dock-header"), false);
  assert.equal(statuses.at(-1).text, undefined);
  const statusCount = statuses.length;
  updateWeeklyUsage(harness.clientPi, ctx, () => "Weekly usage 81% remaining");
  assert.equal(statuses.length, statusCount);
});
