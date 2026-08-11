import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "playwright";
import { executeBrowserRun, executeElementValidation } from "./runner-core";
import type { ElementValidationInput, RunnerHooks, RunnerInput } from "./runner-core";

export type ManagedRunCallbacks = {
  started: () => void;
  event: (kind: string, data: Record<string, unknown>) => void;
  artifact: (input: { name: string; contentType: string; path: string }) => void;
  completed: (result: Awaited<ReturnType<typeof executeBrowserRun>>) => void;
};

export type ManagedValidationCallbacks = {
  started: () => void;
  artifact: (input: { name: string; contentType: string; path: string }) => void;
  completed: (result: Awaited<ReturnType<typeof executeElementValidation>>) => void;
};

type RunQueueItem = { kind: "run"; id: string; input: RunnerInput; callbacks: ManagedRunCallbacks; controller: AbortController };
type ValidationQueueItem = { kind: "validation"; id: string; input: ElementValidationInput; callbacks: ManagedValidationCallbacks; controller: AbortController };
type QueueItem = RunQueueItem | ValidationQueueItem;

export class ManagedRunner {
  private queue: QueueItem[] = [];
  private active?: QueueItem & { browser?: Browser; context?: BrowserContext };
  private readonly artifactDirectory: string;

  constructor(artifactDirectory: string) {
    this.artifactDirectory = artifactDirectory;
  }

  enqueue(id: string, input: RunnerInput, callbacks: ManagedRunCallbacks) {
    if (this.active?.id === id || this.queue.some((item) => item.id === id)) return;
    this.queue.push({ kind: "run", id, input, callbacks, controller: new AbortController() });
    void this.drain();
  }

  enqueueValidation(id: string, input: ElementValidationInput, callbacks: ManagedValidationCallbacks) {
    if (this.active?.id === id || this.queue.some((item) => item.id === id)) return;
    this.queue.push({ kind: "validation", id, input, callbacks, controller: new AbortController() });
    void this.drain();
  }

  cancel(id: string) {
    const queued = this.queue.find((item) => item.id === id);
    if (queued) {
      queued.controller.abort();
      this.queue = this.queue.filter((item) => item.id !== id);
      if (queued.kind === "run") queued.callbacks.completed({ status: "canceled", completedSteps: 0, totalSteps: queued.input.flow.steps.length, elapsedMs: 0, error: "RUN_CANCELED", flowOutputs: {} });
      else queued.callbacks.completed({ status: "canceled", count: 0, elapsedMs: 0, error: "VALIDATION_CANCELED" });
      return true;
    }
    if (this.active?.id !== id) return false;
    this.active.controller.abort();
    void Promise.all([this.active.context?.close().catch(() => undefined), this.active.browser?.close().catch(() => undefined)]);
    return true;
  }

  private async drain() {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) return;
    this.active = item;
    try {
      item.callbacks.started();
      await mkdir(this.artifactDirectory, { recursive: true });
      const hooks: RunnerHooks = {
        signal: item.controller.signal,
        artifactPath: (_name, extension) => join(this.artifactDirectory, `artifact_${randomUUID()}.${extension}`),
        artifact: item.callbacks.artifact,
        event: item.kind === "run" ? item.callbacks.event : () => undefined,
        browser: (browser, context) => {
          if (!this.active || this.active.id !== item.id) return;
          this.active.browser = browser;
          this.active.context = context;
        },
      };
      if (item.kind === "run") item.callbacks.completed(await executeBrowserRun(item.input, hooks));
      else item.callbacks.completed(await executeElementValidation(item.input, hooks));
    } catch (error) {
      console.error("ManagedRunner item failed", error);
      const message = error instanceof Error ? error.message : "MANAGED_RUNNER_FAILED";
      if (item.kind === "run") item.callbacks.completed({ status: "failed", completedSteps: 0, totalSteps: item.input.flow.steps.length, elapsedMs: 0, error: message, flowOutputs: {} });
      else item.callbacks.completed({ status: "failed", count: 0, elapsedMs: 0, error: message });
    } finally {
      this.active = undefined;
      void this.drain();
    }
  }
}
