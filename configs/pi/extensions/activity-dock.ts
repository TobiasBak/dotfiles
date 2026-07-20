import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const WEEKLY_USAGE_STATUS_KEY = "weekly-usage";

const ACTIVITY_HEADER_WIDGET_KEY = "activity-dock-header";
const ACTIVITY_BEGIN_EVENT = "activity-dock:begin";
const ACTIVITY_END_EVENT = "activity-dock:end";
const WEEKLY_USAGE_UPDATE_EVENT = "activity-dock:weekly-usage-update";
const WEEKLY_USAGE_CLEAR_EVENT = "activity-dock:weekly-usage-clear";
const DIVIDER_WIDTH = 32;

type Theme = ExtensionContext["ui"]["theme"];
type WeeklyUsageRenderer = (theme: Theme) => string | undefined;

interface ActivityEvent {
  key: string;
}

interface WeeklyUsageEvent {
  renderer: WeeklyUsageRenderer | undefined;
}

export function updateWeeklyUsage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  renderer: WeeklyUsageRenderer | undefined,
): void {
  pi.events.emit(WEEKLY_USAGE_UPDATE_EVENT, { renderer } satisfies WeeklyUsageEvent);
  if (ctx.mode !== "tui") ctx.ui.setStatus(WEEKLY_USAGE_STATUS_KEY, renderer?.(ctx.ui.theme));
}

export function beginActivityDock(pi: ExtensionAPI, ctx: ExtensionContext, key: string): void {
  if (ctx.mode === "tui") pi.events.emit(ACTIVITY_BEGIN_EVENT, { key } satisfies ActivityEvent);
}

export function endActivityDock(pi: ExtensionAPI, ctx: ExtensionContext, key: string): void {
  if (ctx.mode === "tui") pi.events.emit(ACTIVITY_END_EVENT, { key } satisfies ActivityEvent);
}

export function clearWeeklyUsage(pi: ExtensionAPI, ctx: ExtensionContext): void {
  pi.events.emit(WEEKLY_USAGE_CLEAR_EVENT, undefined);
  if (ctx.mode !== "tui") ctx.ui.setStatus(WEEKLY_USAGE_STATUS_KEY, undefined);
}

export default function activityDockExtension(pi: ExtensionAPI): void {
  const activeActivities = new Set<string>();
  let weeklyUsageRenderer: WeeklyUsageRenderer | undefined;
  let currentCtx: ExtensionContext | undefined;
  let headerRegistered = false;
  let requestHeaderRender = () => {};

  const weeklyUsageText = (theme: Theme): string | undefined => weeklyUsageRenderer?.(theme);

  const clearHeader = (ctx: ExtensionContext): void => {
    if (headerRegistered) ctx.ui.setWidget(ACTIVITY_HEADER_WIDGET_KEY, undefined);
    headerRegistered = false;
    requestHeaderRender = () => {};
  };

  const registerHeader = (ctx: ExtensionContext): void => {
    if (headerRegistered || ctx.mode !== "tui") return;

    ctx.ui.setWidget(
      ACTIVITY_HEADER_WIDGET_KEY,
      (tui, theme) => {
        requestHeaderRender = () => tui.requestRender();
        return {
          render(width: number): string[] {
            const usage = weeklyUsageText(theme);
            if (!usage) return [];
            const divider = theme.fg("borderMuted", "─".repeat(Math.min(DIVIDER_WIDTH, Math.max(0, width))));
            return [truncateToWidth(usage, width), divider, ""];
          },
          invalidate() {},
        };
      },
      { placement: "aboveEditor" },
    );
    headerRegistered = true;
  };

  const refreshUsage = (): void => {
    const ctx = currentCtx;
    if (!ctx) return;
    clearHeader(ctx);
    ctx.ui.setStatus(WEEKLY_USAGE_STATUS_KEY, weeklyUsageText(ctx.ui.theme));
  };

  const unsubscribe = [
    pi.events.on(WEEKLY_USAGE_UPDATE_EVENT, (data) => {
      const renderer = (data as Partial<WeeklyUsageEvent> | undefined)?.renderer;
      weeklyUsageRenderer = typeof renderer === "function" ? renderer : undefined;
      refreshUsage();
    }),
    pi.events.on(WEEKLY_USAGE_CLEAR_EVENT, () => {
      weeklyUsageRenderer = undefined;
      refreshUsage();
    }),
    pi.events.on(ACTIVITY_BEGIN_EVENT, (data) => {
      const key = (data as Partial<ActivityEvent> | undefined)?.key;
      if (!key || activeActivities.has(key)) return;
      activeActivities.add(key);
      try {
        refreshUsage();
      } catch (error) {
        activeActivities.delete(key);
        refreshUsage();
        throw error;
      }
    }),
    pi.events.on(ACTIVITY_END_EVENT, (data) => {
      const key = (data as Partial<ActivityEvent> | undefined)?.key;
      if (!key || !activeActivities.delete(key)) return;
      refreshUsage();
    }),
  ];


  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    refreshUsage();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    for (const stopListening of unsubscribe.splice(0)) stopListening();
    clearHeader(ctx);
    ctx.ui.setStatus(WEEKLY_USAGE_STATUS_KEY, undefined);
    activeActivities.clear();
    weeklyUsageRenderer = undefined;
    currentCtx = undefined;
  });
}
