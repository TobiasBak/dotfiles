import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WEEKLY_USAGE_STATUS_KEY = "weekly-usage";

type WeeklyUsageRenderer = (
  theme: ExtensionContext["ui"]["theme"],
) => string | undefined;

/** Update the weekly subscription status owned by usage.ts. */
export function updateWeeklyUsage(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  renderer: WeeklyUsageRenderer | undefined,
): void {
  ctx.ui.setStatus(WEEKLY_USAGE_STATUS_KEY, renderer?.(ctx.ui.theme));
}

/** Clear the weekly subscription status owned by usage.ts. */
export function clearWeeklyUsage(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  ctx.ui.setStatus(WEEKLY_USAGE_STATUS_KEY, undefined);
}

// This top-level helper is auto-discovered as an extension, so retain a no-op
// factory. Weekly status lifecycle is owned by usage.ts.
export default function activityDockExtension(_pi: ExtensionAPI): void {}
