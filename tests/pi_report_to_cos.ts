import assert from "node:assert/strict";
import { Value } from "typebox/value";
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
    async report(params = { kind: "done", outcome: "green", text: "Reviewed and complete" } as any) {
      return tools.get("report_to_cos").execute("report-call", params,
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
    const approval = harness(["CoS-thread: cos"]);
    const design = { kind: "go_request", text: "Request design GO before implementation" };
    const approved = await approval.report(design);
    assert.equal(approved.details.kind, "go_request");
    assert.equal(approval.sends.length, 1);
    assert.equal(approval.sends[0].message, `[go_request] ${design.text}`);
    await approval.report(design);
    assert.equal(approval.sends[0].clientRequestId, approval.sends[1].clientRequestId);
    const readiness = harness(["CoS-thread: cos"]);
    assert.equal(Value.Check(readiness.tools.get("report_to_cos").parameters,
      { kind: "slot_request", text: "Request the heavy slot for the final gate" }), false,
      "retired slot_request kind must be rejected by the tool schema");
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
    const failures = harness(["CoS-thread: cos"]);
    const schema = failures.tools.get("report_to_cos").parameters;
    const known = {
      step: "Windows qualification / export",
      cause: "cleanup removed stdout.txt before host export",
      evidence: "agents/windows-vm/cleanup-job.ps1: Remove-Item; log/job-42.txt\ninspected failed export trace",
    };
    const unknown = {
      ...known, cause: "unknown", next_probe: "Compare guest task state with retained stderr",
      diagnosis_owner: "VM owner thread",
    };
    const settle = (lead: ReturnType<typeof harness>) =>
      lead.emit("agent_before_settle", { outcome: "completed", entries: [] });
    const rejected = async (params: any, error: string) => {
      const before = failures.sends.length;
      assert.equal(Value.Check(schema, params), true, "missing conditional fields must reach actionable execute validation");
      await assert.rejects(failures.report(params), (caught: Error) => {
        assert.equal(caught.message, error);
        if (params.kind === "blocked" && params.failure && params.failure.evidence === undefined) {
          console.log(`Rejected report: ${caught.message}`);
        }
        return true;
      });
      assert.equal(failures.sends.length, before, "invalid reports must not reach CoS");
    };
    await rejected({ kind: "done", text: "Gate RED" },
      "Missing outcome: done requires green or red so a failed/RED outcome cannot omit failure details");
    for (const [kind, extra, why] of [
      ["blocked", {}, "blocked reports must explain the obstacle"],
      ["done", { outcome: "red" }, "red outcomes must explain the failure"],
      ["finding", {}, "findings must explain the changed cause of a reported failure"],
    ] as const) {
      await rejected({ kind, text: "Failure", ...extra }, `Missing failure: ${why}; provide step, cause and evidence`);
      for (const [field, reason] of [
        ["step", "identify the failing phase or step"],
        ["cause", "provide an evidence-backed explanation or the literal unknown"],
        ["evidence", "name the paths/commands actually inspected to support the explanation"],
        ["next_probe", "unknown cause requires the next observation to distinguish remaining explanations"],
        ["diagnosis_owner", "unknown cause requires who keeps diagnosing"],
      ]) {
        for (const missing of [undefined, "", " \n "]) {
          await rejected({ kind, text: "Failure", ...extra, failure: { ...unknown, [field]: missing } },
            `Missing failure.${field}: ${reason}`);
        }
      }
      for (const failure of [known, unknown]) {
        const params = { kind, text: "Failure", ...extra, failure };
        assert.equal(Value.Check(schema, params), true);
        const accepted = await failures.report(params);
        assert.equal(accepted.details.kind, kind);
        const sent = failures.sends.at(-1);
        assert.equal(sent.message, `[${kind}] Failure` + (kind === "done" ? "\noutcome: red" : "") +
          Object.entries(failure).map(([field, value]) => `\nfailure.${field}: ${value}`).join(""));
        await failures.report(params);
        assert.equal(sent.clientRequestId, failures.sends.at(-1).clientRequestId);
        await failures.report({ ...params, failure: { ...failure, evidence: "new log inspected" } });
        assert.notEqual(sent.clientRequestId, failures.sends.at(-1).clientRequestId,
          "changed evidence must not be deduplicated even when summary text is unchanged");
      }
    }
    assert.equal(Value.Check(schema, { kind: "done", text: "Complete", outcome: "RED" }), false);
    const finding = harness(["CoS-thread: cos"]);
    await finding.report({ kind: "finding", text: "Cause established", failure: known });
    assert.equal(settle(finding)?.continue, true, "a finding must not satisfy the terminal report guard");
    for (const params of [
      { kind: "done", outcome: "green", text: "Complete" },
      { kind: "done", outcome: "red", text: "Gate failed", failure: unknown },
      { kind: "blocked", text: "Needs diagnosis", failure: unknown },
    ]) {
      const terminal = harness(["CoS-thread: cos"]);
      assert.equal(Value.Check(schema, params), true);
      await terminal.report(params);
      assert.equal(settle(terminal), undefined, "accepted terminal report satisfies the report guard");
    }
    const invalid = harness(["CoS-thread: cos"]);
    await assert.rejects(invalid.report({ kind: "blocked", text: "Needs diagnosis" }));
    assert.equal(settle(invalid)?.continue, true, "rejected report must not satisfy the report guard");
    const merge = harness(["CoS-thread: cos"]);
    await merge.report({ kind: "merge_ready", text: "Reviewed", pr_url: "https://example.com/pull/42", head_sha: "a".repeat(40) });
    assert.match(merge.sends[0].message, /PR: https:\/\/example.com\/pull\/42\nHead: a{40}$/);
    console.log("PASS report-to-cos: retargeting, delivery, dedup, activation, approvals, failure contract accept/reject, verbatim evidence, non-terminal findings, terminal guard, merge_ready");
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
