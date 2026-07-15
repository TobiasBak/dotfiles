import assert from "node:assert/strict";
import test from "node:test";

import gptStyle from "../configs/pi/extensions/gpt-style.ts";

function createHarness(model) {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  gptStyle(pi);
  return { handlers, ctx: { model } };
}

const CODEX_GPT = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  api: "openai-codex-responses",
};

const API_GPT = {
  provider: "openai",
  id: "gpt-5.4",
  api: "openai-responses",
};

const CLAUDE = {
  provider: "anthropic",
  id: "claude-opus-4-6",
  api: "anthropic-messages",
};

test("adds pragmatic communication guidance for GPT models", () => {
  const harness = createHarness(CODEX_GPT);
  const result = harness.handlers.get("before_agent_start")(
    { systemPrompt: "Base system prompt" },
    harness.ctx,
  );

  assert.ok(result.systemPrompt.startsWith("Base system prompt\n\n"));
  assert.ok(result.systemPrompt.length > "Base system prompt".length);
});

test("sets low verbosity and concise reasoning summaries for Codex GPT requests", () => {
  const harness = createHarness(CODEX_GPT);
  const payload = {
    model: "gpt-5.6-sol",
    text: { format: { type: "text" }, verbosity: "medium" },
    reasoning: { effort: "high", summary: "auto" },
  };

  const result = harness.handlers.get("before_provider_request")(
    { payload },
    harness.ctx,
  );

  assert.deepEqual(result.text, {
    format: { type: "text" },
    verbosity: "low",
  });
  assert.deepEqual(result.reasoning, { effort: "high", summary: "concise" });
  assert.equal(payload.text.verbosity, "medium");
  assert.equal(payload.reasoning.summary, "auto");
});

test("adds text verbosity to standard OpenAI Responses requests", () => {
  const harness = createHarness(API_GPT);
  const result = harness.handlers.get("before_provider_request")(
    { payload: { model: "gpt-5.4", reasoning: { effort: "medium" } } },
    harness.ctx,
  );

  assert.deepEqual(result.text, { verbosity: "low" });
  assert.deepEqual(result.reasoning, { effort: "medium", summary: "concise" });
});

test("does not create a reasoning object when reasoning is disabled", () => {
  const harness = createHarness(API_GPT);
  const result = harness.handlers.get("before_provider_request")(
    { payload: { model: "gpt-5.4" } },
    harness.ctx,
  );

  assert.deepEqual(result.text, { verbosity: "low" });
  assert.equal("reasoning" in result, false);
});

test("leaves non-GPT models unchanged", () => {
  const harness = createHarness(CLAUDE);

  assert.equal(
    harness.handlers.get("before_agent_start")(
      { systemPrompt: "Base system prompt" },
      harness.ctx,
    ),
    undefined,
  );
  assert.equal(
    harness.handlers.get("before_provider_request")(
      { payload: { model: "claude-opus-4-6" } },
      harness.ctx,
    ),
    undefined,
  );
});
