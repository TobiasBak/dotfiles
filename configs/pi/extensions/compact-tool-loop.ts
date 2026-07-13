import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMPACTION_HEADROOM_TOKENS = 32_000;
const STATUS_ID = "compact-tool-loop";
const COMPACTION_INSTRUCTIONS =
  "Preserve the current goal, completed work, exact file changes, command results, failures, and remaining steps. The agent will continue automatically after compaction.";
const RESUME_MESSAGE =
  "Automatic context compaction completed during the tool loop. Continue the same task from the summary and recent context without waiting for further user input.";

export default function (pi: ExtensionAPI) {
  let compactionInFlight = false;

  pi.on("session_start", () => {
    compactionInFlight = false;
  });

  pi.on("turn_end", (event, ctx) => {
    if (compactionInFlight) return;
    if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;

    const threshold = Math.max(0, usage.contextWindow - COMPACTION_HEADROOM_TOKENS);
    if (usage.tokens <= threshold) return;

    compactionInFlight = true;
    ctx.ui.setStatus(STATUS_ID, `compacting at ${Math.round(usage.percent ?? 0)}%`);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Tool-loop context reached ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens. Compacting before the next model request.`,
        "warning",
      );
    }

    ctx.compact({
      customInstructions: COMPACTION_INSTRUCTIONS,
      onComplete: () => {
        compactionInFlight = false;
        ctx.ui.setStatus(STATUS_ID, undefined);
        if (ctx.hasUI) ctx.ui.notify("Tool-loop compaction completed. Continuing automatically.", "info");

        try {
          if (ctx.isIdle()) pi.sendUserMessage(RESUME_MESSAGE);
          else pi.sendUserMessage(RESUME_MESSAGE, { deliverAs: "followUp" });
        } catch (error) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Compaction completed, but automatic continuation failed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
        }
      },
      onError: (error) => {
        compactionInFlight = false;
        ctx.ui.setStatus(STATUS_ID, undefined);
        if (ctx.hasUI) {
          ctx.ui.notify(`Tool-loop compaction failed; automatic continuation stopped: ${error.message}`, "error");
        }
      },
    });
  });
}
