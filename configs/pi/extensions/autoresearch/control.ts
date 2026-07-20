import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  parseAutoresearchFleetCount,
  type FleetCommandHandler,
  type SupervisorOptions,
} from "./supervisor.ts";
import type { WorkerRegistrationOptions } from "./worker.ts";

export interface AutoresearchOptions {
  readonly now?: () => number;
  readonly supervisor?: SupervisorOptions;
  readonly worker?: WorkerRegistrationOptions;
}

export interface AutoresearchControlOptions extends AutoresearchOptions {
  readonly fleetCommandHandler?: FleetCommandHandler;
}

export function registerAutoresearchControl(
  pi: ExtensionAPI,
  options: AutoresearchControlOptions = {},
): void {
  const fleet = options.fleetCommandHandler;

  const unavailable = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.notify("Autoresearch workers require the full Pi extension API.", "error");
  };

  pi.registerCommand("autoresearch", {
    description: "Maintain N disposable autonomous research workers",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      const count = parseAutoresearchFleetCount(requested);
      if (count !== undefined) {
        if (!fleet) unavailable(ctx);
        else await fleet.start(count, ctx);
        return;
      }

      const action = requested || "status";
      if (!fleet) {
        unavailable(ctx);
        return;
      }
      if (action === "on") {
        if (fleet.isActive()) {
          if (ctx.hasUI) ctx.ui.notify("Autoresearch fleet is already active.", "info");
        } else {
          await fleet.start(1, ctx);
        }
      } else if (action === "off") {
        if (!(await fleet.stop(ctx)) && ctx.hasUI) ctx.ui.notify("Autoresearch is already off.", "info");
      } else if (action === "status") {
        if (!(await fleet.status(ctx)) && ctx.hasUI) ctx.ui.notify("Autoresearch is off.", "info");
      } else if (ctx.hasUI) {
        ctx.ui.notify("Usage: /autoresearch [N|on|off|status], where N is any positive safe integer", "warning");
      }
    },
  });
}
