import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const COMPACTION_HEADROOM_TOKENS = 32_000;
const STATUS_ID = "compact-tool-loop";
const RESUME_MESSAGE =
  "Automatic context compaction completed during the tool loop. Continue the same task from the summary and recent context without waiting for further user input.";
const BOUNDARY_MESSAGE =
  'Context compaction needs a safe turn boundary. Reply with exactly "READY" and do not call tools or continue the task yet.';

export default function (pi: ExtensionAPI) {
  let compactionInFlight = false;
  let boundaryRecoveryPending = false;
  let boundaryRecoveryAttempted = false;

  const resetRecovery = () => {
    boundaryRecoveryPending = false;
    boundaryRecoveryAttempted = false;
  };

  const clearCompactionStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_ID, undefined);
  };

  const sendUserMessage = (ctx: ExtensionContext, message: string) => {
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  };

  const continueAutomatically = (ctx: ExtensionContext, notification: string) => {
    if (ctx.hasUI) ctx.ui.notify(notification, "info");
    try {
      sendUserMessage(ctx, RESUME_MESSAGE);
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Compaction completed, but automatic continuation failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
  };

  const requestBoundaryRecovery = (ctx: ExtensionContext) => {
    boundaryRecoveryAttempted = true;
    boundaryRecoveryPending = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Pi did not compact at the stopped tool boundary. Creating a safe turn boundary and retrying once automatically.",
        "warning",
      );
    }

    try {
      sendUserMessage(ctx, BOUNDARY_MESSAGE);
    } catch (error) {
      resetRecovery();
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Could not create a compaction boundary: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
  };

  pi.on("session_start", () => {
    compactionInFlight = false;
    resetRecovery();
  });

  pi.on("session_compact", (event, ctx) => {
    if (event.reason === "manual") return;
    if (!compactionInFlight && !boundaryRecoveryPending) return;

    compactionInFlight = false;
    clearCompactionStatus(ctx);

    if (event.willRetry) {
      resetRecovery();
      return;
    }

    resetRecovery();
    continueAutomatically(ctx, "Tool-loop compaction completed. Continuing automatically.");
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (compactionInFlight) {
      compactionInFlight = false;
      clearCompactionStatus(ctx);

      if (!boundaryRecoveryAttempted) {
        requestBoundaryRecovery(ctx);
        return;
      }
    }

    if (!boundaryRecoveryPending) return;

    resetRecovery();
    clearCompactionStatus(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Pi still did not compact after creating a safe turn boundary; automatic continuation stopped. Check auto-compaction settings, model authentication, and Pi errors.",
        "error",
      );
    }
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

    // Stop at this completed tool boundary. Pi's post-agent threshold check owns
    // compaction, avoiding a competing manual ctx.compact() call.
    ctx.abort();
  });
}
