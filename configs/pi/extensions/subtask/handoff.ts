export interface ParentHandoffTiming {
  groupId: string;
  batchId?: string;
  resultBytes: number;
  resultQueuedAt: number;
  resultAcceptedAt: number;
  payloadBuiltAt?: number;
  streamStartedAt?: number;
  responseCompletedAt?: number;
}

export interface AcceptedParentHandoff {
  groupId: string;
  batchId?: string;
  resultBytes: number;
  resultQueuedAt: number;
  resultAcceptedAt: number;
}

function copyTiming(timing: ParentHandoffTiming): ParentHandoffTiming {
  return { ...timing };
}

/**
 * Correlates one or more accepted subtask result messages with the next parent
 * provider request. Pi drains all queued steering messages before building that
 * request, so every handoff pending at before_provider_request belongs to it.
 */
export class ParentHandoffTracker {
  private readonly timings = new Map<string, ParentHandoffTiming>();
  private readonly pendingGroupIds: string[] = [];
  private activeGroupIds: string[] = [];
  private readonly completedGroupIds: string[] = [];

  accept(handoff: AcceptedParentHandoff): ParentHandoffTiming {
    const existing = this.timings.get(handoff.groupId);
    if (existing) return copyTiming(existing);

    const timing: ParentHandoffTiming = { ...handoff };
    this.timings.set(handoff.groupId, timing);
    this.pendingGroupIds.push(handoff.groupId);
    return copyTiming(timing);
  }

  markPayloadBuilt(timestamp = Date.now()): string[] {
    if (this.activeGroupIds.length > 0 || this.pendingGroupIds.length === 0) return [];

    this.activeGroupIds = this.pendingGroupIds.splice(0);
    for (const groupId of this.activeGroupIds) {
      this.timings.get(groupId)!.payloadBuiltAt = timestamp;
    }
    return [...this.activeGroupIds];
  }

  markStreamStarted(timestamp = Date.now()): void {
    for (const groupId of this.activeGroupIds) {
      const timing = this.timings.get(groupId)!;
      timing.streamStartedAt ??= timestamp;
    }
  }

  markResponseCompleted(timestamp = Date.now()): ParentHandoffTiming[] {
    if (this.activeGroupIds.length === 0) return [];

    const completed = this.activeGroupIds.map((groupId) => {
      const timing = this.timings.get(groupId)!;
      timing.responseCompletedAt = timestamp;
      this.completedGroupIds.push(groupId);
      return copyTiming(timing);
    });
    this.activeGroupIds = [];
    return completed;
  }

  list(): ParentHandoffTiming[] {
    return [...this.timings.values()].map(copyTiming);
  }

  drainCompleted(): ParentHandoffTiming[] {
    const completed = this.completedGroupIds.splice(0).map((groupId) => {
      const timing = this.timings.get(groupId)!;
      this.timings.delete(groupId);
      return copyTiming(timing);
    });
    return completed;
  }

  clear(): void {
    this.timings.clear();
    this.pendingGroupIds.length = 0;
    this.activeGroupIds = [];
    this.completedGroupIds.length = 0;
  }
}

function formatDuration(milliseconds: number): string {
  const bounded = Math.max(0, milliseconds);
  if (bounded < 1_000) return `${Math.round(bounded)}ms`;
  if (bounded < 10_000) return `${(bounded / 1_000).toFixed(1)}s`;
  return `${Math.round(bounded / 1_000)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

export function formatParentHandoffTiming(
  timing: ParentHandoffTiming,
  now = Date.now(),
): string {
  const boundary = (timestamp: number | undefined, waitingLabel: string): string =>
    timestamp === undefined
      ? `${waitingLabel}...`
      : `+${formatDuration(timestamp - timing.resultQueuedAt)}`;

  const fields = [
    timing.groupId,
    formatBytes(timing.resultBytes),
    `accepted ${boundary(timing.resultAcceptedAt, "accepting")}`,
    `payload ${boundary(timing.payloadBuiltAt, "waiting")}`,
    `stream ${boundary(timing.streamStartedAt, "waiting")}`,
    timing.responseCompletedAt === undefined
      ? `elapsed +${formatDuration(now - timing.resultQueuedAt)}`
      : `done +${formatDuration(timing.responseCompletedAt - timing.resultQueuedAt)}`,
  ];
  return fields.join(" · ");
}
