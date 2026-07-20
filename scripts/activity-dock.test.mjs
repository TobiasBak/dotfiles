import assert from "node:assert/strict";
import test from "node:test";

import activityDockExtension, {
  WEEKLY_USAGE_STATUS_KEY,
  clearWeeklyUsage,
  updateWeeklyUsage,
} from "../configs/pi/extensions/activity-dock.ts";
import multipurposeTabExtension from "../configs/pi/extensions/multipurpose-tab.ts";

function createContext(mode = "tui") {
  const statuses = [];
  const theme = { fg: (_role, text) => text };
  return {
    statuses,
    ctx: {
      mode,
      ui: {
        theme,
        setStatus(key, text) { statuses.push({ key, text }); },
      },
    },
  };
}

test("updates and clears the real weekly usage footer status in every UI mode", () => {
  for (const mode of ["tui", "rpc", "json", "print"]) {
    const { ctx, statuses } = createContext(mode);
    updateWeeklyUsage({}, ctx, () => "Weekly usage 84% remaining");
    clearWeeklyUsage({}, ctx);
    assert.deepEqual(statuses, [
      { key: WEEKLY_USAGE_STATUS_KEY, text: "Weekly usage 84% remaining" },
      { key: WEEKLY_USAGE_STATUS_KEY, text: undefined },
    ]);
  }
});

test("activity helper entrypoint registers no tracking events or header widgets", () => {
  const calls = [];
  const pi = new Proxy({}, {
    get(_target, property) {
      return (...args) => calls.push([property, ...args]);
    },
  });

  activityDockExtension(pi);
  assert.deepEqual(calls, []);
});

test("multipurpose Tab preserves an editor already installed by another extension", () => {
  let sessionStart;
  const notifications = [];
  let replacement;
  multipurposeTabExtension({
    on(event, handler) {
      if (event === "session_start") sessionStart = handler;
    },
  });
  const existingEditor = () => ({ render: () => [], invalidate() {} });
  sessionStart({}, {
    mode: "tui",
    ui: {
      getEditorComponent: () => existingEditor,
      setEditorComponent: (factory) => { replacement = factory; },
      notify: (message, type) => notifications.push({ message, type }),
    },
  });

  assert.equal(replacement, undefined);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /another custom editor/i);
  assert.equal(notifications[0].type, "warning");
});
