import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMPACTION_HEADROOM_TOKENS = 32_000;
const STATUS_ID = "compact-tool-loop";
const COMPACTION_INSTRUCTIONS =
  "Preserve the current goal, completed work, exact file changes, command results, failures, and remaining steps. The agent will continue automatically after compaction.";
const RESUME_MESSAGE =
  "Automatic context compaction completed during the tool loop. Continue the same task from the summary and recent context without waiting for further user input.";
const BOUNDARY_MESSAGE =
  'Context compaction needs a safe turn boundary. Reply with exactly "READY" and do not call tools or continue the task yet.';
const NOTHING_TO_COMPACT_ERROR = "Nothing to compact (session too small)";

export default function (pi: ExtensionAPI) {
  let compactionInFlight = false;
  let boundaryRecoveryPending = false;
  let boundaryRecoveryAttempted = false;
  let resumeAfterCoreRetry = false;

  const resetRecovery = () => {
    boundaryRecoveryPending = false;
    boundaryRecoveryAttempted = false;
    resumeAfterCoreRetry = false;
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

  pi.on("session_start", () => {
    compactionInFlight = false;
    resetRecovery();
  });

  pi.on("session_compact", (event, ctx) => {
    if (!boundaryRecoveryPending || event.reason === "manual") return;

    if (event.willRetry) {
      resumeAfterCoreRetry = true;
      return;
    }

    resetRecovery();
    continueAutomatically(ctx, "Compaction boundary recovery completed. Continuing automatically.");
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!boundaryRecoveryPending || compactionInFlight) return;

    if (resumeAfterCoreRetry) {
      resetRecovery();
      continueAutomatically(ctx, "Compaction boundary recovery completed. Continuing automatically.");
      return;
    }

    resetRecovery();
    ctx.ui.setStatus(STATUS_ID, undefined);
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Tool-loop compaction created a safe turn boundary, but there is still no compactable history; automatic continuation stopped.",
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

    ctx.compact({
      customInstructions: COMPACTION_INSTRUCTIONS,
      onComplete: () => {
        compactionInFlight = false;
        resetRecovery();
        ctx.ui.setStatus(STATUS_ID, undefined);
        continueAutomatically(ctx, "Tool-loop compaction completed. Continuing automatically.");
      },
      onError: (error) => {
        compactionInFlight = false;
        ctx.ui.setStatus(STATUS_ID, undefined);

        if (error.message === NOTHING_TO_COMPACT_ERROR && !boundaryRecoveryAttempted) {
          boundaryRecoveryAttempted = true;
          boundaryRecoveryPending = true;
          if (ctx.hasUI) {
            ctx.ui.notify(
              "Tool-loop compaction found no safe prefix. Creating a safe turn boundary and retrying automatically.",
              "warning",
            );
          }

          try {
            sendUserMessage(ctx, BOUNDARY_MESSAGE);
          } catch (sendError) {
            resetRecovery();
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Could not create a compaction boundary: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
                "error",
              );
            }
          }
          return;
        }

        resetRecovery();
        if (ctx.hasUI) {
          ctx.ui.notify(`Tool-loop compaction failed; automatic continuation stopped: ${error.message}`, "error");
        }
      },
    });
  });
}
