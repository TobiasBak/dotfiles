import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import compactToolLoop from "./compact-tool-loop.ts";
import { registerAutoresearchControl, type AutoresearchOptions } from "./autoresearch/control.ts";
import { makeAutoresearchRuntime } from "./autoresearch/effect-runtime.ts";
import { registerAutoresearchSupervisor } from "./autoresearch/supervisor.ts";
import { registerWorkerAutoresearch } from "./autoresearch/worker.ts";

export { registerAutoresearchControl };
export type { AutoresearchOptions };

export const AUTORESEARCH_PROGRAM_DESIGN_SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "autoresearch",
  "skills",
  "autoresearch-program-design",
  "SKILL.md",
);

export function registerAutoresearch(pi: ExtensionAPI, options: AutoresearchOptions = {}): void {
  const runtime = makeAutoresearchRuntime(pi, {
    now: options.now ?? Date.now,
    ...(options.supervisor?.dashboardIntervalMs !== undefined
      ? { dashboardIntervalMs: options.supervisor.dashboardIntervalMs }
      : {}),
  });

  if (process.env.AUTORESEARCH_ROLE === "worker") {
    compactToolLoop(pi);
    registerWorkerAutoresearch(pi, options.worker, runtime);
    pi.on("session_shutdown", () => runtime.dispose());
    return;
  }

  pi.on("resources_discover", () => ({ skillPaths: [AUTORESEARCH_PROGRAM_DESIGN_SKILL_PATH] }));
  const supportsSupervisor =
    typeof pi.registerTool === "function" &&
    typeof pi.getActiveTools === "function" &&
    typeof pi.setActiveTools === "function" &&
    typeof pi.getThinkingLevel === "function";
  const supervisor = supportsSupervisor ? registerAutoresearchSupervisor(pi, runtime, options.supervisor) : undefined;
  registerAutoresearchControl(pi, {
    ...options,
    ...(supervisor ? { fleetCommandHandler: supervisor } : {}),
  });
  pi.on("session_shutdown", () => runtime.dispose());
}

export default registerAutoresearch;
