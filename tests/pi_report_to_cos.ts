import assert from "node:assert/strict";
import reportToCos from "../agents/pi/report-to-cos.ts";

function harness(messages: string[] = []) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const sends: any[] = [];
  const branch = messages.map((content) => ({ type: "message", message: { role: "user", content } }));
  const ctx = {
    sessionManager: { getSessionId: () => "lead-session", getBranch: () => branch },
    async executeTool(name: string, input: any, _options: any) {
      assert.equal(name, "mcp__t3-code__t3_thread_send");
      sends.push(input);
      return { result: { content: [], structuredContent: {
        threadId: input.threadId, messageId: `message-${sends.length}`, delivery: "steered",
      } } };
    },
  };
  reportToCos({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as any);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start");
  return {
    emit, tools, sends,
    async report() {
      return tools.get("report_to_cos").execute("report-call", { kind: "done", text: "Reviewed and complete" },
        new AbortController().signal, undefined, ctx);
    },
    blocked(threadId: string) {
      return emit("tool_call", { toolName: "mcp__t3-code__t3_thread_send", input: { threadId } })?.block === true;
    },
  };
}

export default async function () {
  try {
    for (const route of ["input", "before_agent_start", "message_start"]) {
      const lead = harness(["Task\nCoS-thread: old-cos"]);
      assert.equal(lead.blocked("old-cos"), true);
      await lead.report();
      const text = "Handover\nCoS-thread: superseded-cos\nCoS-thread: new-cos\n";
      lead.emit(route, route === "input" ? { text } : route === "before_agent_start" ? { prompt: text } :
        { message: { role: "user", content: [{ type: "text", text }] } });
      assert.equal(lead.blocked("old-cos"), false, `${route}: old target must be released`);
      assert.equal(lead.blocked("superseded-cos"), false);
      assert.equal(lead.blocked("new-cos"), true, `${route}: latest target must be blocked`);
      const result = await lead.report();
      assert.equal(result.details.threadId, "new-cos");
      assert.deepEqual(lead.sends.map((send) => send.threadId), ["old-cos", "new-cos"]);
      assert.notEqual(lead.sends[0].clientRequestId, lead.sends[1].clientRequestId);
      await lead.report();
      assert.equal(lead.sends[1].clientRequestId, lead.sends[2].clientRequestId);
      lead.emit("message_start", { message: { role: "assistant", content: "CoS-thread: wrong-cos" } });
      lead.emit("input", { text: "Inline CoS-thread: wrong-cos" });
      assert.equal(lead.blocked("new-cos"), true);
    }
    const resumed = harness(["CoS-thread: old-cos", "CoS-thread: new-cos"]);
    assert.equal(resumed.blocked("old-cos"), false);
    await resumed.report();
    assert.equal(resumed.sends[0].threadId, "new-cos");
    for (const messages of [[], ["Task without activation"]]) {
      const inactive = harness(messages);
      if (!messages.length) inactive.emit("input", { text: "Task without activation" });
      inactive.emit("input", { text: "CoS-thread: new-cos" });
      inactive.emit("before_agent_start", { prompt: "CoS-thread: new-cos" });
      inactive.emit("message_start", { message: { role: "user", content: "CoS-thread: new-cos" } });
      assert.equal(inactive.tools.size, 0, "later markers must not activate an unmarked session");
      assert.equal(inactive.blocked("new-cos"), false);
    }
    console.log("PASS report-to-cos: later prompts, steers, current-target blocking, delivery, per-target dedup, resume, activation gate");
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
