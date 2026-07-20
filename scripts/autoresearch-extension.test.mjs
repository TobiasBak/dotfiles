import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTORESEARCH_PROGRAM_DESIGN_SKILL_PATH,
  registerAutoresearch,
  registerAutoresearchControl,
} from "../configs/pi/extensions/autoresearch.ts";

function controlHarness(fleet) {
  const commands = new Map();
  const notifications = [];
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = {
    hasUI: true,
    ui: { notify(message, type) { notifications.push({ message, type }); } },
  };
  registerAutoresearchControl(pi, fleet ? { fleetCommandHandler: fleet } : {});
  return { command: commands.get("autoresearch"), ctx, notifications };
}

function fakeFleet() {
  const calls = [];
  let active = false;
  return {
    calls,
    async start(count) { calls.push(["start", count]); active = true; return true; },
    async stop() { calls.push(["stop"]); const wasActive = active; active = false; return wasActive; },
    async status() { calls.push(["status"]); return active; },
    isActive() { return active; },
  };
}

test("control command starts one disposable worker for on and has no compaction mode", async () => {
  const fleet = fakeFleet();
  const harness = controlHarness(fleet);
  await harness.command.handler("on", harness.ctx);
  assert.deepEqual(fleet.calls, [["start", 1]]);
  assert.equal("compact" in harness.ctx, false);
});

test("control command accepts any positive safe worker count without a ceiling", async () => {
  const fleet = fakeFleet();
  const harness = controlHarness(fleet);
  await harness.command.handler("20", harness.ctx);
  assert.deepEqual(fleet.calls, [["start", 20]]);
  await harness.command.handler(String(Number.MAX_SAFE_INTEGER), harness.ctx);
  assert.deepEqual(fleet.calls.at(-1), ["start", Number.MAX_SAFE_INTEGER]);
});

test("bare command is observational and never toggles a fleet", async () => {
  const fleet = fakeFleet();
  const harness = controlHarness(fleet);
  await harness.command.handler("", harness.ctx);
  await harness.command.handler("on", harness.ctx);
  await harness.command.handler("", harness.ctx);
  assert.deepEqual(fleet.calls, [["status"], ["start", 1], ["status"]]);
});

test("invalid commands do not launch workers", async () => {
  const fleet = fakeFleet();
  const harness = controlHarness(fleet);
  for (const value of ["0", "-1", "1.5", "claim", "compact"]) await harness.command.handler(value, harness.ctx);
  assert.deepEqual(fleet.calls, []);
  assert.equal(harness.notifications.length, 5);
  assert.match(harness.notifications[0].message, /Usage:/);
});

test("limited extension APIs fail closed instead of falling back to transcript continuation", async () => {
  const harness = controlHarness(undefined);
  await harness.command.handler("on", harness.ctx);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /full Pi extension API/i);
});

test("worker-mode registration installs the shadow context compactor before worker coordination", () => {
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getActiveTools: () => [],
    setActiveTools() {},
  };
  const previousRole = process.env.AUTORESEARCH_ROLE;
  process.env.AUTORESEARCH_ROLE = "worker";
  try {
    registerAutoresearch(pi, {
      worker: {
        env: {
          AUTORESEARCH_CANONICAL_ROOT: "/repo",
          AUTORESEARCH_WORKER_ID: "w1",
          AUTORESEARCH_SESSION_ID: "00000001-0000-4000-8000-000000000001",
          AUTORESEARCH_STATE_DIR: "/state",
          AUTORESEARCH_FLEET_DB: "/state/fleet.sqlite",
          AUTORESEARCH_GENERATION: "1",
        },
        createStore: () => ({ snapshot: () => ({ workers: [] }) }),
      },
    });
    assert.equal(handlers.get("context")?.length, 1);
    assert.equal(handlers.get("session_before_compact")?.length, 1);
    assert.ok(tools.has("autoresearch_worker_state"));
    assert.equal(handlers.has("resources_discover"), false);
  } finally {
    if (previousRole === undefined) delete process.env.AUTORESEARCH_ROLE;
    else process.env.AUTORESEARCH_ROLE = previousRole;
  }
});

test("main extension exposes program-design skill discovery without starting research", async () => {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  registerAutoresearch(pi);
  const discovered = await handlers.get("resources_discover")[0]();
  assert.deepEqual(discovered, { skillPaths: [AUTORESEARCH_PROGRAM_DESIGN_SKILL_PATH] });
  assert.ok(commands.has("autoresearch"));
  assert.equal(handlers.has("agent_end"), false);
  assert.equal(handlers.has("agent_settled"), false);
  assert.equal(handlers.has("context"), false, "parent mode does not duplicate the worker context compactor");
});
