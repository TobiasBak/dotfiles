import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DefaultResourceLoader,
  DEFAULT_COMPACTION_SETTINGS,
  SessionManager,
  SettingsManager,
  createAgentSession,
  shouldCompact,
} from "../configs/pi/extensions/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import {
  Type,
  fauxAssistantMessage,
  fauxToolCall,
} from "../configs/pi/extensions/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  registerFauxProvider,
  streamSimple,
} from "../configs/pi/extensions/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";

const settings = JSON.parse(
  readFileSync(new URL("../configs/pi/settings.json", import.meta.url), "utf8"),
).compaction;

test("keeps Pi core compaction enabled at the shared threshold", () => {
  assert.deepEqual(settings, {
    enabled: true,
    reserveTokens: 32_000,
    keepRecentTokens: 20_000,
  });
  assert.equal(settings.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
});

test("Pi core compacts only after the configured threshold is crossed", () => {
  const contextWindow = 272_000;
  const threshold = contextWindow - settings.reserveTokens;

  assert.equal(shouldCompact(threshold, contextWindow, settings), false);
  assert.equal(shouldCompact(threshold + 1, contextWindow, settings), true);
});

const textOf = (message) => {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "toolCall") return `${block.name}:${block.id}`;
      return "";
    })
    .join("\n");
};

const countBranchText = (branch, text) =>
  branch.filter((entry) => {
    if (entry.type === "message" || entry.type === "custom_message") {
      return textOf(entry.type === "message" ? entry.message : entry) === text;
    }
    return false;
  }).length;

test("shadow-compacts a large mid-loop tool result without aborting or losing queued work", async () => {
  const provider = "shadow-compaction-faux";
  const faux = registerFauxProvider({
    api: "shadow-compaction-faux-api",
    provider,
    models: [
      {
        id: "shadow-model",
        name: "Shadow Compaction Faux",
        contextWindow: 64_000,
        maxTokens: 8_192,
      },
    ],
  });
  const model = faux.getModel();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-compaction-test-"));
  const sessionManager = SessionManager.inMemory(process.cwd());
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 32_000,
      keepRecentTokens: 20_000,
    },
    steeringMode: "all",
    followUpMode: "all",
    retry: { enabled: false },
  });

  // Two old, large turns put the first request below the threshold. The tool
  // result crosses it, while core's keep-recent cut retains the current tool pair.
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: `old-a:${"a".repeat(48_000)}` }],
    timestamp: Date.now(),
  });
  sessionManager.appendMessage(fauxAssistantMessage("old-a acknowledged"));
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: `old-b:${"b".repeat(52_000)}` }],
    timestamp: Date.now(),
  });
  sessionManager.appendMessage(fauxAssistantMessage("old-b acknowledged"));

  const extensionPath = new URL(
    "../configs/pi/extensions/compact-tool-loop.ts",
    import.meta.url,
  ).pathname;
  const actualProviderContexts = [];
  const summaryProviderContexts = [];
  const settledSnapshots = [];
  const extensionErrors = [];
  let session;

  const queuedLabels = [
    "steer-one",
    "custom-steer",
    "steer-two",
    "follow-one",
    "custom-follow",
    "follow-two",
  ];

  const harnessFactory = (pi) => {
    pi.registerProvider(provider, {
      api: faux.api,
      baseUrl: model.baseUrl,
      apiKey: "test-key",
      streamSimple,
      models: [
        {
          id: model.id,
          name: model.name,
          reasoning: false,
          input: ["text"],
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
      ],
    });

    pi.registerTool({
      name: "large_result",
      label: "Large result",
      description: "Returns a large test result",
      parameters: Type.Object({}),
      async execute() {
        await session.steer("steer-one");
        await session.sendCustomMessage(
          { customType: "queued-test", content: "custom-steer", display: false },
          { deliverAs: "steer" },
        );
        await session.steer("steer-two");
        await session.followUp("follow-one");
        await session.sendCustomMessage(
          { customType: "queued-test", content: "custom-follow", display: false },
          { deliverAs: "followUp" },
        );
        await session.followUp("follow-two");
        return {
          content: [{ type: "text", text: `large-result:${"x".repeat(40_000)}` }],
          details: {},
        };
      },
    });

    pi.on("agent_settled", (_event, ctx) => {
      settledSnapshots.push(ctx.sessionManager.getBranch());
    });
  };

  const snapshotContext = (context) => ({
    systemPrompt: context.systemPrompt,
    messages: structuredClone(context.messages),
  });

  faux.setResponses([
    (context) => {
      actualProviderContexts.push(snapshotContext(context));
      return fauxAssistantMessage(
        fauxToolCall("large_result", {}, { id: "large-tool-call" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      summaryProviderContexts.push(snapshotContext(context));
      return fauxAssistantMessage("SHADOW SUMMARY");
    },
    (context) => {
      actualProviderContexts.push(snapshotContext(context));
      return fauxAssistantMessage("continued after tool and steering");
    },
    (context) => {
      actualProviderContexts.push(snapshotContext(context));
      return fauxAssistantMessage("finished after followups");
    },
  ]);

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    extensionFactories: [{ name: "shadow-compaction-harness", factory: harnessFactory }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    ({ session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      model,
      thinkingLevel: "off",
      tools: ["large_result"],
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    }));

    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    await session.prompt("run the large result tool");

    assert.deepEqual(extensionErrors, []);
    assert.equal(summaryProviderContexts.length, 1);
    assert.equal(actualProviderContexts.length, 3);
    assert.equal(faux.state.callCount, 4);

    const compactedContext = actualProviderContexts[1];
    assert.ok(compactedContext.messages.some((message) => textOf(message).includes("SHADOW SUMMARY")));
    assert.ok(!compactedContext.messages.some((message) => textOf(message).includes("old-a:")));

    const toolCallIndex = compactedContext.messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (block) => block.type === "toolCall" && block.id === "large-tool-call",
        ),
    );
    const toolResultIndex = compactedContext.messages.findIndex(
      (message) => message.role === "toolResult" && message.toolCallId === "large-tool-call",
    );
    assert.ok(toolCallIndex >= 0);
    assert.equal(toolResultIndex, toolCallIndex + 1);

    const branch = sessionManager.getBranch();
    const assistants = branch
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .map((entry) => entry.message);
    assert.ok(assistants.every((message) => message.stopReason !== "aborted" && message.stopReason !== "error"));
    assert.ok(!branch.some((entry) => entry.type === "message" && textOf(entry.message) === "READY"));
    assert.ok(
      !branch.some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType !== "queued-test",
      ),
    );

    for (const label of queuedLabels) assert.equal(countBranchText(branch, label), 1, label);
    assert.equal(settledSnapshots.length, 1);
    for (const label of queuedLabels) {
      assert.equal(countBranchText(settledSnapshots[0], label), 1, `settled before ${label}`);
    }

    const markers = sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "compact-tool-loop.shadow-compaction");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].data.version, 1);
    assert.equal(markers[0].data.compaction.summary.includes("SHADOW SUMMARY"), true);

    const callsBeforeMaterialization = faux.state.callCount;
    const materialized = await session.compact();
    assert.equal(faux.state.callCount, callsBeforeMaterialization);
    assert.equal(materialized.summary, markers[0].data.compaction.summary);
    assert.ok(sessionManager.getBranch().some((entry) => entry.type === "compaction"));
  } finally {
    session?.dispose();
    faux.unregister();
    rmSync(agentDir, { recursive: true, force: true });
  }
});
