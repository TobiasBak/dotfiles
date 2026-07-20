import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { SubtaskStatusItem } from "./core.ts";

export interface SubtaskCancellationResult {
  cancelled: string[];
  notRunning: string[];
}

export type SubtaskGroupStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubtaskGroupStatusItem {
  id: string;
  taskIds: string[];
  status: SubtaskGroupStatus;
}

export interface SubtaskGroupWaitResult {
  groups: SubtaskGroupWaitItem[];
  aborted: boolean;
}

export interface BackgroundSubtaskDelivery {
  content: string;
  details: Record<string, unknown>;
}

export interface SubtaskGroupWaitItem extends SubtaskGroupStatusItem {
  result?: BackgroundSubtaskDelivery;
}

export interface SubtaskGroupCompletion {
  status: Exclude<SubtaskGroupStatus, "running">;
  result: BackgroundSubtaskDelivery;
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

interface SubtaskGroupRecord {
  id: string;
  taskIds: string[];
  controller?: AbortController | undefined;
  status: SubtaskGroupStatus;
  result?: BackgroundSubtaskDelivery;
  settled: Promise<void>;
}

const MAX_RETAINED_SUBTASK_GROUPS = 64;

class SubtaskGroupRegistry {
  private readonly allocatedIds = new Set<string>();
  private readonly groups = new Map<string, SubtaskGroupRecord>();

  allocateId(): string {
    for (;;) {
      const id = `g-${randomBytes(3).toString("hex")}`;
      if (this.allocatedIds.has(id)) continue;
      this.allocatedIds.add(id);
      return id;
    }
  }

  track(
    id: string,
    taskIds: string[],
    controller: AbortController,
    completion: Promise<SubtaskGroupCompletion>,
  ): void {
    if (this.groups.has(id)) throw new Error(`Subtask group ID already exists: ${id}`);
    this.pruneTerminalGroups();
    this.allocatedIds.add(id);

    const record: SubtaskGroupRecord = {
      id,
      taskIds: [...taskIds],
      controller,
      status: "running",
      settled: Promise.resolve(),
    };
    record.settled = completion.then((result) => {
      record.result = result.result;
      record.status = result.status;
      record.controller = undefined;
    });
    this.groups.set(id, record);
  }

  list(ids?: Iterable<string>): SubtaskGroupStatusItem[] {
    const requested = ids ? new Set(ids) : undefined;
    return [...this.groups.values()]
      .filter((group) => !requested || requested.has(group.id))
      .map((group) => ({ id: group.id, taskIds: [...group.taskIds], status: group.status }));
  }

  async wait(ids: Iterable<string>, signal?: AbortSignal): Promise<SubtaskGroupWaitResult> {
    const requested = [...new Set(ids)];
    const unknown = requested.filter((id) => !this.groups.has(id));
    if (unknown.length > 0) throw new Error(`Unknown subtask group IDs: ${unknown.join(", ")}`);

    const records = requested.map((id) => this.groups.get(id)!);
    const listWaitItems = (): SubtaskGroupWaitItem[] =>
      records.map((record) => ({
        id: record.id,
        taskIds: [...record.taskIds],
        status: record.status,
        ...(record.result ? { result: record.result } : {}),
      }));
    const completion = Promise.all(records.map((record) => record.settled));
    if (!signal) {
      await completion;
      return { groups: listWaitItems(), aborted: false };
    }
    if (signal.aborted) return { groups: listWaitItems(), aborted: true };

    const aborted = await new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (value: boolean) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(true);
      signal.addEventListener("abort", onAbort, { once: true });
      void completion.then(() => finish(false));
    });
    return { groups: listWaitItems(), aborted };
  }

  forget(ids: Iterable<string>): void {
    for (const id of new Set(ids)) {
      const group = this.groups.get(id);
      if (!group || group.status === "running") continue;
      this.groups.delete(id);
      this.allocatedIds.delete(id);
    }
  }

  async cancelAndWait(): Promise<void> {
    const running = [...this.groups.values()].filter((group) => group.status === "running");
    for (const group of running) group.controller?.abort();
    await Promise.all(running.map((group) => group.settled));
  }

  clear(): void {
    this.groups.clear();
    this.allocatedIds.clear();
  }

  private pruneTerminalGroups(): void {
    if (this.groups.size < MAX_RETAINED_SUBTASK_GROUPS) return;
    for (const [id, group] of this.groups) {
      if (group.status === "running") continue;
      this.groups.delete(id);
      this.allocatedIds.delete(id);
      if (this.groups.size < MAX_RETAINED_SUBTASK_GROUPS) return;
    }
  }
}

/**
 * Process-owned subtask state. Pi extension runtimes bind as temporary delivery
 * adapters, while child ownership and result queues remain stable across /reload.
 */
export class SubtaskRuntimeState {
  private readonly activeTasks = new ActiveTaskRegistry();
  private readonly groups = new SubtaskGroupRegistry();
  private readonly temporaryPaths = new Set<string>();
  private deliveryAdapter: BackgroundSubtaskDeliveryAdapter | undefined;
  private readonly pendingDeliveries: BackgroundSubtaskDelivery[] = [];
  private acceptingDeliveries = false;

  allocateTaskId(): string {
    return this.activeTasks.allocateId();
  }

  allocateGroupId(): string {
    return this.groups.allocateId();
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

  trackGroup(
    id: string,
    taskIds: string[],
    controller: AbortController,
    completion: Promise<SubtaskGroupCompletion>,
  ): void {
    this.groups.track(id, taskIds, controller, completion);
  }

  listGroups(ids?: Iterable<string>): SubtaskGroupStatusItem[] {
    return this.groups.list(ids);
  }

  waitForGroups(ids: Iterable<string>, signal?: AbortSignal): Promise<SubtaskGroupWaitResult> {
    return this.groups.wait(ids, signal);
  }

  forgetGroups(ids: Iterable<string>): void {
    this.groups.forget(ids);
  }

  retainTemporaryPath(path: string): void {
    this.temporaryPaths.add(path);
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
    try {
      await Promise.all([
        this.activeTasks.cancelAndWait(),
        this.groups.cancelAndWait(),
      ]);
    } finally {
      this.groups.clear();
      const temporaryPaths = [...this.temporaryPaths];
      this.temporaryPaths.clear();
      await Promise.allSettled(
        temporaryPaths.map((path) => fs.promises.rm(path, { recursive: true, force: true })),
      );
    }
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

function addTemporaryPathSupport(existing: Record<string, any>): void {
  if (typeof existing.retainTemporaryPath === "function") return;
  const temporaryPaths = new Set<string>();
  const stopAndCancel = existing.stopAndCancel.bind(existing) as () => Promise<void>;
  existing.retainTemporaryPath = (path: string) => temporaryPaths.add(path);
  existing.stopAndCancel = async () => {
    try {
      await stopAndCancel();
    } finally {
      const retained = [...temporaryPaths];
      temporaryPaths.clear();
      await Promise.allSettled(
        retained.map((path) => fs.promises.rm(path, { recursive: true, force: true })),
      );
    }
  };
}

function upgradeRuntimeState(existing: Record<string, any>): SubtaskRuntimeState {
  if (typeof existing.allocateGroupId === "function") {
    existing.forgetGroups ??= () => {};
    addTemporaryPathSupport(existing);
    return existing as SubtaskRuntimeState;
  }

  // Keep active tasks, batches, and queued deliveries owned by the pre-group
  // runtime alive across the first /reload that introduces group waiting.
  const groups = new SubtaskGroupRegistry();
  const stopAndCancel = existing.stopAndCancel.bind(existing) as () => Promise<void>;
  existing.allocateGroupId = () => groups.allocateId();
  existing.trackGroup = (
    id: string,
    taskIds: string[],
    controller: AbortController,
    completion: Promise<SubtaskGroupCompletion>,
  ) => groups.track(id, taskIds, controller, completion);
  existing.listGroups = (ids?: Iterable<string>) => groups.list(ids);
  existing.waitForGroups = (ids: Iterable<string>, signal?: AbortSignal) => groups.wait(ids, signal);
  existing.forgetGroups = (ids: Iterable<string>) => groups.forget(ids);
  existing.stopAndCancel = async () => {
    await Promise.all([stopAndCancel(), groups.cancelAndWait()]);
    groups.clear();
  };
  addTemporaryPathSupport(existing);
  return existing as SubtaskRuntimeState;
}

export function getSubtaskRuntimeState(): SubtaskRuntimeState {
  const processGlobals = globalThis as typeof globalThis & Record<string, unknown>;
  const existing = processGlobals[SUBTASK_RUNTIME_GLOBAL_KEY];
  if (existing && typeof existing === "object") {
    return upgradeRuntimeState(existing as Record<string, any>);
  }

  const runtime = new SubtaskRuntimeState();
  processGlobals[SUBTASK_RUNTIME_GLOBAL_KEY] = runtime;
  return runtime;
}
