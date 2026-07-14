import { randomBytes } from "node:crypto";
import type { SubtaskStatusItem } from "./core.ts";

export interface SubtaskCancellationResult {
  cancelled: string[];
  notRunning: string[];
}

export interface BackgroundSubtaskDelivery {
  content: string;
  details: Record<string, unknown>;
}

export type BackgroundSubtaskDeliveryAdapter = (delivery: BackgroundSubtaskDelivery) => void;

interface ActiveTask {
  controller: AbortController;
  completion: Promise<unknown>;
  getStatus(): SubtaskStatusItem;
}

class ActiveTaskRegistry {
  private readonly allocatedIds = new Set<string>();
  private readonly tasks = new Map<string, ActiveTask>();

  allocateId(): string {
    for (;;) {
      const id = randomBytes(3).toString("hex");
      if (this.allocatedIds.has(id)) continue;
      this.allocatedIds.add(id);
      return id;
    }
  }

  track(
    id: string,
    controller: AbortController,
    completion: Promise<unknown>,
    getStatus: () => SubtaskStatusItem,
  ): void {
    if (this.tasks.has(id)) throw new Error(`Subtask ID is already active: ${id}`);
    this.allocatedIds.add(id);
    const activeTask = { controller, completion, getStatus };
    this.tasks.set(id, activeTask);
    void completion
      .finally(() => {
        if (this.tasks.get(id) === activeTask) this.tasks.delete(id);
      })
      .catch(() => {});
  }

  list(): SubtaskStatusItem[] {
    return [...this.tasks.values()].map((task) => task.getStatus());
  }

  async cancelAndWait(ids?: Iterable<string>): Promise<SubtaskCancellationResult> {
    const requested = ids ? [...new Set(ids)] : [...this.tasks.keys()];
    const cancelled: string[] = [];
    const notRunning: string[] = [];
    const completions: Promise<unknown>[] = [];

    for (const id of requested) {
      const task = this.tasks.get(id);
      if (!task) {
        notRunning.push(id);
        continue;
      }
      cancelled.push(id);
      completions.push(task.completion);
      task.controller.abort();
    }

    await Promise.allSettled(completions);
    return { cancelled, notRunning };
  }
}

class ActiveBatchRegistry {
  private readonly controllers = new Set<AbortController>();
  private readonly completions = new Set<Promise<unknown>>();

  track(controller: AbortController, completion: Promise<unknown>): void {
    this.controllers.add(controller);
    this.completions.add(completion);
    void completion
      .finally(() => {
        this.controllers.delete(controller);
        this.completions.delete(completion);
      })
      .catch(() => {});
  }

  async cancelAndWait(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.completions]);
  }
}

/**
 * Process-owned subtask state. Pi extension runtimes bind as temporary delivery
 * adapters, while child ownership and result queues remain stable across /reload.
 */
export class SubtaskRuntimeState {
  private readonly activeTasks = new ActiveTaskRegistry();
  private readonly activeBatches = new ActiveBatchRegistry();
  private deliveryAdapter?: BackgroundSubtaskDeliveryAdapter;
  private readonly pendingDeliveries: BackgroundSubtaskDelivery[] = [];
  private acceptingDeliveries = false;

  allocateTaskId(): string {
    return this.activeTasks.allocateId();
  }

  trackTask(
    id: string,
    controller: AbortController,
    completion: Promise<unknown>,
    getStatus: () => SubtaskStatusItem,
  ): void {
    this.activeTasks.track(id, controller, completion, getStatus);
  }

  listTasks(ids?: ReadonlySet<string>): SubtaskStatusItem[] {
    const tasks = this.activeTasks.list();
    return ids ? tasks.filter((task) => ids.has(task.id)) : tasks;
  }

  cancelTasks(ids?: Iterable<string>): Promise<SubtaskCancellationResult> {
    return this.activeTasks.cancelAndWait(ids);
  }

  trackBatch(controller: AbortController, completion: Promise<unknown>): void {
    this.activeBatches.track(controller, completion);
  }

  bindDelivery(adapter: BackgroundSubtaskDeliveryAdapter): void {
    this.acceptingDeliveries = true;
    this.deliveryAdapter = adapter;
    this.flushDeliveries();
  }

  suspendForReload(): void {
    this.acceptingDeliveries = true;
    this.deliveryAdapter = undefined;
  }

  deliver(delivery: BackgroundSubtaskDelivery): void {
    if (!this.acceptingDeliveries) return;
    if (this.tryDelivery(delivery)) return;
    this.pendingDeliveries.push(delivery);
  }

  async stopAndCancel(): Promise<void> {
    this.acceptingDeliveries = false;
    this.deliveryAdapter = undefined;
    this.pendingDeliveries.length = 0;
    await Promise.all([
      this.activeTasks.cancelAndWait(),
      this.activeBatches.cancelAndWait(),
    ]);
  }

  private tryDelivery(delivery: BackgroundSubtaskDelivery): boolean {
    if (!this.deliveryAdapter) return false;
    try {
      this.deliveryAdapter(delivery);
      return true;
    } catch {
      this.deliveryAdapter = undefined;
      return false;
    }
  }

  private flushDeliveries(): void {
    while (this.pendingDeliveries.length > 0) {
      const delivery = this.pendingDeliveries[0]!;
      if (!this.tryDelivery(delivery)) return;
      this.pendingDeliveries.shift();
    }
  }
}

const SUBTASK_RUNTIME_GLOBAL_KEY = "__tobiasPiSubtaskRuntimeV1";

export function getSubtaskRuntimeState(): SubtaskRuntimeState {
  const processGlobals = globalThis as typeof globalThis & Record<string, unknown>;
  const existing = processGlobals[SUBTASK_RUNTIME_GLOBAL_KEY];
  if (existing) return existing as SubtaskRuntimeState;

  const runtime = new SubtaskRuntimeState();
  processGlobals[SUBTASK_RUNTIME_GLOBAL_KEY] = runtime;
  return runtime;
}
