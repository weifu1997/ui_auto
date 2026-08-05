import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import type { ElementAsset, Environment, FlowStep } from "../src/mock-data";
import { createPlatformApi } from "./platform.ts";

const port = Number(process.env.PORT ?? 8787);
const listenHost = process.env.AUTOFLOW_LISTEN_HOST ?? "127.0.0.1";
const artifactDirectory = resolve(process.env.WORKER_ARTIFACT_DIRECTORY ?? join("server", ".artifacts"));
const dataDirectory = resolve(process.env.WORKER_DATA_DIRECTORY ?? join("server", ".data"));
const localListenHosts = new Set(["127.0.0.1", "::1", "localhost"]);
if (!localListenHosts.has(listenHost) && !process.env.PLATFORM_SECRET_KEY) {
  throw new Error("PLATFORM_SECRET_KEY is required when AUTOFLOW_LISTEN_HOST is not loopback");
}
const legacyWorkerApiEnabled = process.env.AUTOFLOW_ENABLE_LEGACY_WORKER_API === "1"
  || (process.env.AUTOFLOW_ENABLE_LEGACY_WORKER_API !== "0" && localListenHosts.has(listenHost));
const configuredCorsOrigins = (process.env.AUTOFLOW_CORS_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
await mkdir(dataDirectory, { recursive: true });
const platform = createPlatformApi(dataDirectory);
const database = new DatabaseSync(join(dataDirectory, "autoflow.sqlite"));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS worker_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    artifact_ids TEXT NOT NULL,
    result TEXT,
    request TEXT,
    summary TEXT,
    browser_state TEXT NOT NULL DEFAULT 'queued',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_events (
    task_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (task_id, event_id)
  );
  CREATE TABLE IF NOT EXISTS worker_artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content_type TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS worker_tasks_project_created
    ON worker_tasks (project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS worker_events_task
    ON worker_events (task_id, event_id);
`);

type TaskStatus = "queued" | "running" | "success" | "failed" | "canceled";
type EventKind = "status" | "log" | "step" | "result";
type TaskEvent = {
  id: number;
  kind: EventKind;
  at: string;
  data: Record<string, unknown>;
};
type Artifact = {
  id: string;
  projectId: string;
  path: string;
  contentType: string;
  name: string;
};
type TaskSummary = {
  flowName: string;
  environmentName: string;
  totalSteps: number;
  upToStepId?: string;
};
type FlowPayload = {
  id: string;
  name: string;
  steps: FlowStep[];
};
type RunRequest = {
  environment: Environment;
  flow: FlowPayload;
  elements: ElementAsset[];
  variables?: Record<string, string>;
  secretKeys?: string[];
  upToStepId?: string;
};
type ValidationRequest = {
  environment: Environment;
  element: ElementAsset;
};
type Task = {
  id: string;
  projectId: string;
  type: "run" | "validation";
  status: TaskStatus;
  createdAt: string;
  events: TaskEvent[];
  nextEventId: number;
  listeners: Set<ServerResponse>;
  controller: AbortController;
  artifactIds: string[];
  result?: Record<string, unknown>;
  request?: RunRequest;
  executionRequest?: RunRequest;
  summary?: TaskSummary;
  sensitive: boolean;
  browserState: "queued" | "launching" | "running" | "waiting" | "closing" | "closed";
  browser?: Browser;
  context?: BrowserContext;
};

const runs = new Map<string, Task>();
const validations = new Map<string, Task>();
const artifacts = new Map<string, Artifact>();

type StoredTask = {
  id: string;
  project_id: string;
  type: Task["type"];
  status: TaskStatus;
  created_at: string;
  artifact_ids: string;
  result: string | null;
  request: string | null;
  summary: string | null;
  browser_state: Task["browserState"];
};

type StoredArtifact = {
  id: string;
  project_id: string;
  path: string;
  content_type: string;
  name: string;
};

type StoredEvent = {
  event_id: number;
  kind: EventKind;
  occurred_at: string;
  data: string;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function redactRunRequest(request: RunRequest): RunRequest {
  const secretKeys = new Set(request.secretKeys ?? []);
  return {
    ...request,
    variables: Object.fromEntries(
      Object.entries(request.variables ?? {}).map(([key, value]) => [
        key,
        secretKeys.has(key) ? "***" : value,
      ]),
    ),
  };
}

function redactTaskText(task: Task, value: string) {
  const secretKeys = new Set(task.executionRequest?.secretKeys ?? []);
  let redacted = value;
  for (const [key, secret] of Object.entries(task.executionRequest?.variables ?? {})) {
    if (secretKeys.has(key) && secret) redacted = redacted.replaceAll(secret, "***");
  }
  return redacted;
}

function redactTaskData(task: Task, value: unknown): unknown {
  if (typeof value === "string") return redactTaskText(task, value);
  if (Array.isArray(value)) return value.map((item) => redactTaskData(task, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactTaskData(task, item)]),
    );
  }
  return value;
}

function taskErrorMessage(task: Task, error: unknown) {
  return redactTaskText(task, error instanceof Error ? error.message : "RUN_FAILED");
}

function persistTask(task: Task) {
  database.prepare(`
    INSERT INTO worker_tasks (
      id, project_id, type, status, created_at, artifact_ids, result, request, summary, browser_state, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      artifact_ids = excluded.artifact_ids,
      result = excluded.result,
      request = excluded.request,
      summary = excluded.summary,
      browser_state = excluded.browser_state,
      updated_at = excluded.updated_at
  `).run(
    task.id,
    task.projectId,
    task.type,
    task.status,
    task.createdAt,
    JSON.stringify(task.artifactIds),
    task.result ? JSON.stringify(redactTaskData(task, task.result)) : null,
    task.request ? JSON.stringify(task.request) : null,
    task.summary ? JSON.stringify(task.summary) : null,
    task.browserState,
    now(),
  );
}

function persistEvent(task: Task, event: TaskEvent) {
  database.prepare(`
    INSERT OR REPLACE INTO worker_events (task_id, event_id, kind, occurred_at, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(task.id, event.id, event.kind, event.at, JSON.stringify(event.data));
}

function persistArtifact(artifact: Artifact) {
  database.prepare(`
    INSERT INTO worker_artifacts (id, project_id, path, content_type, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      path = excluded.path,
      content_type = excluded.content_type,
      name = excluded.name
  `).run(
    artifact.id,
    artifact.projectId,
    artifact.path,
    artifact.contentType,
    artifact.name,
    now(),
  );
}

function hydratePersistedTasks() {
  const storedArtifacts = database.prepare(`
    SELECT id, project_id, path, content_type, name FROM worker_artifacts
  `).all() as StoredArtifact[];
  for (const artifact of storedArtifacts) {
    artifacts.set(artifact.id, {
      id: artifact.id,
      projectId: artifact.project_id,
      path: artifact.path,
      contentType: artifact.content_type,
      name: artifact.name,
    });
  }

  const storedTasks = database.prepare(`
    SELECT id, project_id, type, status, created_at, artifact_ids, result, request, summary, browser_state
    FROM worker_tasks
  `).all() as StoredTask[];
  for (const stored of storedTasks) {
    const events = database.prepare(`
      SELECT event_id, kind, occurred_at, data FROM worker_events
      WHERE task_id = ? ORDER BY event_id DESC LIMIT 250
    `).all(stored.id) as StoredEvent[];
    const task: Task = {
      id: stored.id,
      projectId: stored.project_id,
      type: stored.type,
      status: stored.status,
      createdAt: stored.created_at,
      events: events.reverse().map((event) => ({
        id: event.event_id,
        kind: event.kind,
        at: event.occurred_at,
        data: parseJson(event.data, {}),
      })),
      nextEventId: Math.max(0, ...events.map((event) => event.event_id)) + 1,
      listeners: new Set(),
      controller: new AbortController(),
      artifactIds: parseJson(stored.artifact_ids, []),
      result: parseJson(stored.result, undefined),
      request: parseJson(stored.request, undefined),
      summary: parseJson(stored.summary, undefined),
      sensitive: Boolean(parseJson<RunRequest | undefined>(stored.request, undefined)?.secretKeys?.length),
      browserState: stored.browser_state ?? "closed",
    };
    if (task.status === "queued" || task.status === "running") {
      task.status = "failed";
      task.browserState = "closed";
      task.result = {
        ...(task.result ?? {}),
        error: "WORKER_RESTARTED",
        completedSteps: Number(task.result?.completedSteps ?? 0),
      };
      task.events.push({
        id: task.nextEventId++,
        kind: "status",
        at: now(),
        data: { status: "failed", error: "WORKER_RESTARTED" },
      });
      persistEvent(task, task.events.at(-1)!);
    }
    (task.type === "run" ? runs : validations).set(task.id, task);
    persistTask(task);
  }
}

class WorkerQueue {
  private active = 0;
  private readonly jobs: Array<{ task: Task; run: () => Promise<void> }> = [];

  enqueue(task: Task, run: () => Promise<void>) {
    this.jobs.push({ task, run });
    task.browserState = "queued";
    persistTask(task);
    void this.drain();
  }

  cancel(taskId: string) {
    const index = this.jobs.findIndex((job) => job.task.id === taskId);
    if (index < 0) return false;
    this.jobs.splice(index, 1);
    return true;
  }

  position(taskId: string) {
    const index = this.jobs.findIndex((job) => job.task.id === taskId);
    return index >= 0 ? index + 1 : undefined;
  }

  get isBusy() {
    return this.active > 0;
  }

  private async drain() {
    if (this.active > 0) return;
    const next = this.jobs.shift();
    if (!next) return;
    this.active += 1;
    try {
      if (next.task.controller.signal.aborted) {
        if (next.task.status !== "canceled") setStatus(next.task, "canceled");
      } else {
        await next.run();
      }
    } finally {
      this.active -= 1;
      void this.drain();
    }
  }
}

const queue = new WorkerQueue();

function now() {
  return new Date().toISOString();
}

function taskResponse(task: Task) {
  return {
    id: task.id,
    projectId: task.projectId,
    type: task.type,
    status: task.status,
    createdAt: task.createdAt,
    artifactIds: task.artifactIds,
    artifacts: task.artifactIds.flatMap((id) => {
      const artifact = artifacts.get(id);
      return artifact
        ? [{ id: artifact.id, name: artifact.name, contentType: artifact.contentType }]
        : [];
    }),
    summary: task.summary,
    result: task.result ? redactTaskData(task, task.result) : undefined,
    browserState: task.browserState,
    queue: {
      position: queue.position(task.id),
      active: queue.isBusy,
    },
    events: task.events,
  };
}

function publish(task: Task, kind: EventKind, data: Record<string, unknown>) {
  const event: TaskEvent = {
    id: task.nextEventId++,
    kind,
    at: now(),
    data: redactTaskData(task, data) as Record<string, unknown>,
  };
  task.events.push(event);
  if (task.events.length > 250) task.events.shift();
  persistEvent(task, event);
  persistTask(task);
  const serialized = formatSse(event);
  for (const listener of task.listeners) listener.write(serialized);
}

function setStatus(task: Task, status: TaskStatus) {
  task.status = status;
  publish(task, "status", { status });
}

async function launchBrowser() {
  if (process.env.PLAYWRIGHT_LAUNCH_FAILURE === "1") {
    throw new Error("BROWSER_LAUNCH_FAILED");
  }
  return chromium.launch({ headless: false });
}

function observeBrowser(task: Task, browser: Browser) {
  browser.once("disconnected", () => {
    if (task.browser !== browser || task.browserState === "closing" || task.browserState === "closed") {
      return;
    }
    task.browserState = "closed";
    persistTask(task);
    publish(task, "log", { level: "info", message: "浏览器窗口已关闭" });
  });
}

function waitForStopOrBrowserClose(task: Task, browser: Browser) {
  if (task.controller.signal.aborted || !browser.isConnected()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => resolve();
    task.controller.signal.addEventListener("abort", finish, { once: true });
    browser.once("disconnected", finish);
  });
}

async function cancelTask(task: Task) {
  task.controller.abort();
  queue.cancel(task.id);
  task.browserState = "closing";
  persistTask(task);
  await Promise.all([
    task.context?.close().catch(() => undefined),
    task.browser?.close().catch(() => undefined),
  ]);
  task.context = undefined;
  task.browser = undefined;
  task.browserState = "closed";
  if (task.status !== "canceled") setStatus(task, "canceled");
  else persistTask(task);
}

function formatSse(event: TaskEvent) {
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function createTask(projectId: string, type: Task["type"]) {
  const task: Task = {
    id: `${type === "run" ? "run" : "validation"}_${randomUUID()}`,
    projectId,
    type,
    status: "queued",
    createdAt: now(),
    events: [],
    nextEventId: 1,
    listeners: new Set(),
    controller: new AbortController(),
    artifactIds: [],
    sensitive: false,
    browserState: "queued",
  };
  publish(task, "status", { status: "queued" });
  return task;
}

function projectOrThrow(projectId: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(projectId)) {
    throw new Error("PROJECT_NOT_FOUND");
  }
  return { id: projectId };
}

function summarizeRun(request: RunRequest): TaskSummary {
  const { flow, environment } = request;
  const upToIndex = request.upToStepId
    ? flow.steps.findIndex((step) => step.id === request.upToStepId)
    : -1;
  return {
    flowName: flow.name,
    environmentName: environment.name,
    totalSteps: upToIndex >= 0 ? upToIndex + 1 : flow.steps.length,
    upToStepId: request.upToStepId,
  };
}

function scopedVariables(supplied?: Record<string, string>) {
  return supplied ?? {};
}

function interpolate(value: string, input: {
  environment: Environment;
  variables: Record<string, string>;
  flow: FlowPayload;
}) {
  return value.replace(/{{\s*([^}]+)\s*}}/g, (_match, expression: string) => {
    const [scope, key] = expression.trim().split(".");
    if (scope === "env") {
      return key === "baseUrl"
        ? input.environment.baseUrl
        : input.variables[`env.${key}`] ?? "";
    }
    if (scope === "project") {
      return input.variables[`project.${key}`] ?? input.variables[key] ?? "";
    }
    if (scope === "run" && key === "timestamp") return now();
    if (scope === "flow") return input.variables[`flow.${key}`] ?? "";
    return "";
  });
}

function environmentUrl(baseUrl: string, value: string) {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(value || "/", base);
  } catch {
    throw new Error("ENVIRONMENT_URL_INVALID");
  }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || target.origin !== base.origin) {
    throw new Error("TARGET_URL_ORIGIN_FORBIDDEN");
  }
  return target.toString();
}

function locatorFor(page: Page, element: ElementAsset, testIdAttribute = "data-testid"): Locator {
  const value = element.value;
  switch (element.method) {
    case "testid": {
      if (!/^[a-zA-Z_][\w:-]*$/.test(testIdAttribute)) {
        throw new Error("INVALID_TEST_ID_ATTRIBUTE");
      }
      return page.locator(`[${testIdAttribute}=${JSON.stringify(value)}]`);
    }
    case "label":
      return page.getByLabel(value);
    case "text":
      return page.getByText(value, { exact: true });
    case "role": {
      const match = value.match(/^([\w-]+)(?:\[name=["']?(.*?)["']?\])?$/);
      const role = (match?.[1] ?? value) as Parameters<Page["getByRole"]>[0];
      const name = match?.[2];
      return page.getByRole(role, name ? { name } : undefined);
    }
    case "XPath":
      return page.locator(`xpath=${value}`);
    default:
      return page.locator(value);
  }
}

async function saveArtifact(
  task: Task,
  name: string,
  extension: string,
  contentType: string,
  save: (path: string) => Promise<unknown>,
) {
  await mkdir(artifactDirectory, { recursive: true });
  const id = `artifact_${randomUUID()}`;
  const path = join(artifactDirectory, `${id}.${extension}`);
  await save(path);
  const artifact = { id, projectId: task.projectId, path, contentType, name };
  artifacts.set(id, artifact);
  persistArtifact(artifact);
  task.artifactIds.push(id);
  persistTask(task);
  return id;
}

async function executeStep(
  page: Page,
  step: FlowStep,
  input: {
    environment: Environment;
    flow: FlowPayload;
    variables: Record<string, string>;
    elements: ElementAsset[];
  },
  task: Task,
) {
  const value = interpolate(step.value, input);
  const element = step.element
    ? input.elements.find((item) => item.name === step.element)
    : undefined;
  const locator = element
    ? locatorFor(page, element, input.environment.testIdAttribute)
    : undefined;
  const timeout = step.timeout * 1000;
  const action = step.action;

  if (action === "打开页面") {
    const target = environmentUrl(input.environment.baseUrl, value);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout });
  } else if (action === "点击") {
    if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
    await locator.click({ timeout });
  } else if (action === "填写") {
    if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
    await locator.fill(value, { timeout });
  } else if (action === "清空填写") {
    if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
    await locator.fill("", { timeout });
  } else if (action === "选择下拉项") {
    if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
    await locator.selectOption(value, { timeout });
  } else if (action === "勾选") {
    if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
    await locator.check({ timeout });
  } else if (action === "键盘按键") {
    if (locator) await locator.press(value, { timeout });
    else await page.keyboard.press(value);
  } else if (action === "等待") {
    await page.waitForTimeout(Number(value) || step.timeout * 1000);
  } else if (action === "可见性断言") {
    if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
    await locator.waitFor({ state: "visible", timeout });
  } else if (action === "文本断言") {
    if (!locator) throw new Error("STEP_ELEMENT_REQUIRED");
    const actual = await locator.textContent({ timeout });
    if (!(actual ?? "").includes(value)) {
      throw new Error(`TEXT_ASSERTION_FAILED: expected ${value}, received ${actual ?? ""}`);
    }
  } else if (action === "截图") {
    if (task.sensitive) {
      publish(task, "log", { level: "info", message: "敏感运行已跳过截图步骤" });
      return;
    }
    const artifactId = await saveArtifact(
      task,
      `${step.title}.png`,
      "png",
      "image/png",
      (path) => page.screenshot({ path, fullPage: true }),
    );
    publish(task, "log", { level: "info", message: "已生成截图", artifactId });
  } else {
    throw new Error(`UNSUPPORTED_ACTION: ${action}`);
  }
}

async function executeRun(task: Task, request: RunRequest) {
  const { environment, flow } = request;
  const input = {
    environment,
    flow,
    variables: scopedVariables(request.variables),
    elements: request.elements,
  };
  const totalSteps = request.upToStepId
    ? Math.max(0, flow.steps.findIndex((step) => step.id === request.upToStepId) + 1)
    : flow.steps.length;

  if (task.controller.signal.aborted) {
    if (task.status !== "canceled") setStatus(task, "canceled");
    return;
  }
  setStatus(task, "running");
  const started = Date.now();
  publish(task, "log", { level: "info", message: `Worker 已开始执行 ${flow.name}` });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let tracingStarted = false;
  let completed = 0;
  let finalStatus: TaskStatus = "success";
  try {
    task.browserState = "launching";
    persistTask(task);
    browser = await launchBrowser();
    task.browser = browser;
    observeBrowser(task, browser);
    context = await browser.newContext();
    task.context = context;
    page = await context.newPage();
    task.browserState = "running";
    persistTask(task);
    if (task.sensitive) {
      publish(task, "log", { level: "info", message: "敏感运行已关闭 Trace 与截图工件" });
    } else {
      await context.tracing.start({ screenshots: true, snapshots: true });
      tracingStarted = true;
    }
    for (const [index, step] of flow.steps.entries()) {
      if (task.controller.signal.aborted) throw new Error("RUN_CANCELED");
      publish(task, "step", { index, stepId: step.id, status: "running", title: step.title });
      const started = Date.now();
      const attempts = step.failurePolicy === "重试 1 次" ? 2 : 1;
      let completedStep = false;
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await executeStep(page!, step, input, task);
          completed += 1;
          completedStep = true;
          publish(task, "step", {
            index,
            stepId: step.id,
            status: "success",
            title: step.title,
            durationMs: Date.now() - started,
          });
          break;
        } catch (error) {
          const message = taskErrorMessage(task, error);
          if (message === "RUN_CANCELED") throw error;
          lastError = error;
          if (attempt + 1 < attempts) {
            publish(task, "log", {
              level: "info",
              message: `步骤“${step.title}”失败，正在重试（${attempt + 1}/${attempts - 1}）`,
            });
          }
        }
      }
      if (!completedStep) {
        const message = taskErrorMessage(task, lastError);
        const screenshotId = task.sensitive
          ? undefined
          : await saveArtifact(
              task,
              `failure-step-${index + 1}.png`,
              "png",
              "image/png",
              (path) => page!.screenshot({ path, fullPage: true }),
            );
        publish(task, "step", {
          index,
          stepId: step.id,
          status: "failed",
          title: step.title,
          durationMs: Date.now() - started,
          error: message,
          artifactId: screenshotId,
        });
        if (step.failurePolicy === "继续执行") continue;
        throw lastError;
      }
      if (request.upToStepId === step.id) break;
    }
    task.result = { completedSteps: completed, totalSteps, elapsedMs: Date.now() - started };
    finalStatus = task.controller.signal.aborted ? "canceled" : "success";
  } catch (error) {
    if (task.controller.signal.aborted || (error instanceof Error && error.message === "RUN_CANCELED")) {
      finalStatus = "canceled";
    } else {
      task.result = {
        completedSteps: completed,
        totalSteps,
        elapsedMs: Date.now() - started,
        error:
          task.browserState === "launching"
            ? `BROWSER_LAUNCH_FAILED: ${taskErrorMessage(task, error)}`
            : taskErrorMessage(task, error),
      };
      finalStatus = "failed";
    }
    if (finalStatus === "failed" && environment.keepBrowserOpenOnFailure && browser?.isConnected()) {
      task.browserState = "waiting";
      persistTask(task);
      publish(task, "log", { level: "info", message: "浏览器已保持打开，取消运行可关闭窗口" });
      await waitForStopOrBrowserClose(task, browser);
      finalStatus = task.controller.signal.aborted ? "canceled" : "failed";
    }
  } finally {
    task.browserState = "closing";
    persistTask(task);
    try {
      if (context && tracingStarted) {
        try {
          const traceId = await saveArtifact(
            task,
            "trace.zip",
            "zip",
            "application/zip",
            (path) => context!.tracing.stop({ path }),
          );
          publish(task, "log", { level: "info", message: "已生成 Trace", artifactId: traceId });
        } catch (error) {
          publish(task, "log", { level: "info", message: `Trace 未保存: ${taskErrorMessage(task, error)}` });
        }
      }
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      task.context = undefined;
      task.browser = undefined;
      task.browserState = "closed";
      if (finalStatus === "canceled" && !task.result) {
        task.result = { completedSteps: completed, totalSteps, elapsedMs: Date.now() - started };
      }
      persistTask(task);
      setStatus(task, finalStatus);
    }
  }
}

async function executeValidation(task: Task, request: ValidationRequest) {
  const environment = request.environment;
  const element = request.element;
  if (task.controller.signal.aborted) {
    if (task.status !== "canceled") setStatus(task, "canceled");
    return;
  }
  setStatus(task, "running");
  const started = Date.now();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    task.browserState = "launching";
    persistTask(task);
    browser = await launchBrowser();
    task.browser = browser;
    observeBrowser(task, browser);
    context = await browser.newContext();
    task.context = context;
    page = await context.newPage();
    task.browserState = "running";
    persistTask(task);
    const target = environmentUrl(environment.baseUrl, element.path);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: environment.timeout * 1000 });
    const locator = locatorFor(page!, element, environment.testIdAttribute);
    const count = await locator.count();
    const screenshotId = await saveArtifact(
      task,
      `validation-${element.id}.png`,
      "png",
      "image/png",
      (path) => page!.screenshot({ path, fullPage: true }),
    );
    const firstMatch = count > 0 ? await locator.first().evaluate((node) => node.outerHTML.slice(0, 500)) : undefined;
    task.result = { count, elapsedMs: Date.now() - started, firstMatch, screenshotId };
    publish(task, "result", task.result);
    setStatus(task, "success");
  } catch (error) {
    task.result = {
      count: 0,
      elapsedMs: Date.now() - started,
      reason: task.controller.signal.aborted
        ? "RUN_CANCELED"
        : task.browserState === "launching"
          ? `BROWSER_LAUNCH_FAILED: ${taskErrorMessage(task, error)}`
          : taskErrorMessage(task, error),
    };
    publish(task, "result", task.result);
    setStatus(task, task.controller.signal.aborted ? "canceled" : "failed");
  } finally {
    task.browserState = "closing";
    persistTask(task);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    task.context = undefined;
    task.browser = undefined;
    task.browserState = "closed";
    persistTask(task);
  }
}

async function readJson<T>(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("PAYLOAD_TOO_LARGE");
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function attachSse(request: IncomingMessage, response: ServerResponse, task: Task) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write(": connected\n\n");
  for (const event of task.events) response.write(formatSse(event));
  task.listeners.add(response);
  request.on("close", () => task.listeners.delete(response));
}

function parseProjectRoute(pathname: string, resource: "runs" | "validations") {
  return pathname.match(new RegExp(`^/api/projects/([^/]+)/${resource}(?:/([^/]+))?(?:/(events|cancel|retry))?$`));
}

function fixtureHtml(pathname: string) {
  if (pathname === "/__fixture/login") {
    return `<!doctype html><html><body><main><h1>Fixture login</h1><label>账号<input data-testid="login-account" data-test="login-account" /></label><label>密码<input data-testid="login-password" data-test="login-password" type="password" /></label><button data-testid="login-submit" data-test="login-submit">登录</button><p data-testid="welcome" data-test="welcome" hidden>欢迎回来</p></main><script>document.querySelector('[data-testid=login-submit]').onclick=()=>document.querySelector('[data-testid=welcome]').hidden=false</script></body></html>`;
  }
  if (pathname === "/__fixture/multiple") {
    return `<!doctype html><html><body><button class="candidate">立即参与</button><button class="candidate">立即参与</button><button class="candidate">立即参与</button></body></html>`;
  }
  if (pathname === "/__fixture/retry") {
    return `<!doctype html><html><body><p data-testid="retry-target" hidden>已准备就绪</p><script>setTimeout(() => { document.querySelector('[data-testid=retry-target]').hidden = false }, 1200)</script></body></html>`;
  }
  if (pathname === "/__fixture/interpolation") {
    return `<!doctype html><html><body><input data-testid="project-value" data-test="project-value" /><input data-testid="environment-value" data-test="environment-value" /><button data-testid="apply" data-test="apply">应用</button><p data-testid="result" data-test="result"></p><script>document.querySelector('[data-testid=apply]').onclick=()=>document.querySelector('[data-testid=result]').textContent=document.querySelector('[data-testid=project-value]').value+'|'+document.querySelector('[data-testid=environment-value]').value</script></body></html>`;
  }
  if (pathname === "/__fixture/response-output") {
    return `<!doctype html><html><body><button data-testid="fetch-output" data-test="fetch-output">Fetch output</button><script>document.querySelector('[data-testid=fetch-output]').onclick=()=>fetch('/__fixture/response-json')</script></body></html>`;
  }
  return undefined;
}

hydratePersistedTasks();

function corsOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return undefined;
  if (configuredCorsOrigins.includes(origin)) return origin;
  if (configuredCorsOrigins.length === 0 && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return origin;
  return null;
}

const server = createServer(async (request, response) => {
  const origin = corsOrigin(request);
  if (origin === null) {
    sendJson(response, 403, { error: "CORS_ORIGIN_FORBIDDEN" });
    return;
  }
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/__fixture/response-json") {
    sendJson(response, 200, { order: { id: "response-order-1" } });
    return;
  }
  const fixture = fixtureHtml(url.pathname);
  if (fixture) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true, queue: "online" });
    return;
  }
  if (await platform.handle(request, response, url)) return;
  if (!legacyWorkerApiEnabled && url.pathname.startsWith("/api/projects/")) {
    sendJson(response, 404, { error: "LEGACY_WORKER_API_DISABLED" });
    return;
  }
  const artifactMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactMatch && request.method === "GET") {
    const projectId = decodeURIComponent(artifactMatch[1]);
    projectOrThrow(projectId);
    const artifact = artifacts.get(artifactMatch[2]);
    if (!artifact || artifact.projectId !== projectId) {
      sendJson(response, 404, { error: "ARTIFACT_NOT_FOUND" });
      return;
    }
    response.writeHead(200, {
      "content-type": artifact.contentType,
      "content-disposition": `inline; filename="${basename(artifact.name)}"`,
    });
    createReadStream(artifact.path).pipe(response);
    return;
  }
  try {
    const runRoute = parseProjectRoute(url.pathname, "runs");
    if (runRoute) {
      const [, encodedProjectId, taskId, action] = runRoute;
      const projectId = decodeURIComponent(encodedProjectId);
      projectOrThrow(projectId);
      if (!taskId && request.method === "POST") {
        const body = await readJson<RunRequest>(request);
        if (!body.environment) throw new Error("ENVIRONMENT_REQUIRED");
        if (!body.flow) throw new Error("FLOW_REQUIRED");
        if (!Array.isArray(body.flow.steps)) throw new Error("FLOW_STEPS_REQUIRED");
        if (!Array.isArray(body.elements)) throw new Error("ELEMENTS_REQUIRED");
        if ((body.secretKeys ?? []).some((key) => !body.variables?.[key])) {
          throw new Error("RUN_SECRETS_REQUIRED");
        }
        const task = createTask(projectId, "run");
        task.executionRequest = body;
        task.request = redactRunRequest(body);
        task.sensitive = Boolean(body.secretKeys?.length);
        task.summary = summarizeRun(body);
        runs.set(task.id, task);
        queue.enqueue(task, () => executeRun(task, body));
        sendJson(response, 202, { runId: task.id });
        return;
      }
      const task = taskId ? runs.get(taskId) : undefined;
      if (!task || task.projectId !== projectId) throw new Error("RUN_NOT_FOUND");
      if (action === "events" && request.method === "GET") return attachSse(request, response, task);
      if (action === "cancel" && request.method === "POST") {
        await cancelTask(task);
        sendJson(response, 202, taskResponse(task));
        return;
      }
      if (action === "retry" && request.method === "POST") {
        if (!task.request) throw new Error("RUN_RETRY_NOT_AVAILABLE");
        if (task.sensitive) throw new Error("RUN_SECRETS_REQUIRED");
        const executionRequest = task.executionRequest ?? task.request;
        const retry = createTask(projectId, "run");
        retry.executionRequest = executionRequest;
        retry.request = redactRunRequest(executionRequest);
        retry.sensitive = false;
        retry.summary = summarizeRun(executionRequest);
        runs.set(retry.id, retry);
        queue.enqueue(retry, () => executeRun(retry, executionRequest));
        sendJson(response, 202, { runId: retry.id });
        return;
      }
      if (!action && request.method === "GET") {
        sendJson(response, 200, taskResponse(task));
        return;
      }
    }
    const validationRoute = parseProjectRoute(url.pathname, "validations");
    if (validationRoute) {
      const [, encodedProjectId, taskId, action] = validationRoute;
      const projectId = decodeURIComponent(encodedProjectId);
      projectOrThrow(projectId);
      if (!taskId && request.method === "POST") {
        const body = await readJson<ValidationRequest>(request);
        if (!body.environment) throw new Error("ENVIRONMENT_REQUIRED");
        if (!body.element) throw new Error("ELEMENT_REQUIRED");
        const task = createTask(projectId, "validation");
        validations.set(task.id, task);
        queue.enqueue(task, () => executeValidation(task, body));
        sendJson(response, 202, { validationId: task.id });
        return;
      }
      const task = taskId ? validations.get(taskId) : undefined;
      if (!task || task.projectId !== projectId) throw new Error("VALIDATION_NOT_FOUND");
      if (action === "events" && request.method === "GET") return attachSse(request, response, task);
      if (action === "cancel" && request.method === "POST") {
        await cancelTask(task);
        sendJson(response, 202, taskResponse(task));
        return;
      }
      if (!action && request.method === "GET") {
        sendJson(response, 200, taskResponse(task));
        return;
      }
    }
    sendJson(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const status = message.includes("NOT_FOUND")
      ? 404
      : message === "PAYLOAD_TOO_LARGE"
        ? 413
        : message === "RUN_SECRETS_REQUIRED"
          ? 409
          : 400;
    sendJson(response, status, { error: message });
  }
});

server.on("upgrade", (request, socket, head) => {
  if (!platform.handleUpgrade(request, socket, head)) socket.destroy();
});

server.listen(port, listenHost, () => {
  console.log(`AutoFlow Worker API listening on http://${listenHost}:${port}`);
});
