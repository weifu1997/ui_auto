import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import WebSocket from "ws";

type AgentIdentity = {
  agentId: string;
  credential: string;
  platformUrl: string;
};

type RunLease = {
  type: "run.lease";
  lease: { id: string; expiresAt: string; attempt: number };
  run: {
    id: string;
    projectId: string;
    snapshot: Record<string, unknown>;
    secrets: Record<string, string>;
  };
};

type ValidationStart = {
  type: "validation.start";
  validation: {
    id: string;
    projectId: string;
    environmentId: string;
    environment: Record<string, unknown>;
    element: Record<string, unknown>;
  };
};

type DebugStart = {
  type: "debug.start";
  session: {
    id: string;
    projectId: string;
    revisionId: string | null;
    environmentId: string;
    currentStep: number;
    snapshot: Record<string, unknown>;
    secrets: Record<string, string>;
    idleExpiresAt: string;
    maxExpiresAt: string;
  };
};

type DebugRuntime = {
  id: string;
  context: BrowserContext;
  page: Page;
  profile: string;
  currentStep: number;
  steps: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
  secrets: Record<string, string>;
  baseUrl: string;
  testIdAttribute: string;
  paused: boolean;
  executing: boolean;
  ended: boolean;
  controller: AbortController;
  screenshotTimer?: ReturnType<typeof setInterval>;
  values: RuntimeValues;
};

type RunRuntime = {
  controller: AbortController;
  context?: BrowserContext;
};

type ValidationRuntime = {
  controller: AbortController;
  context?: BrowserContext;
};

type PickerCandidate = {
  method: "testid" | "role" | "label" | "text" | "css";
  value: string;
  count: number;
  score: number;
  label: string;
};

type RuntimeResponse = { sequence: number; url: string; body: unknown; ready?: Promise<void> };

type RuntimeValues = {
  variables: Record<string, string>;
  data: Record<string, string>;
  flowOutputs: Record<string, string>;
  publicFlowOutputs: Record<string, string>;
  responses: RuntimeResponse[];
  nextResponseSequence: number;
  responseWaiters: Array<{
    expectedUrl: string;
    afterSequence: number;
    resolve: (response: RuntimeResponse | undefined) => void;
  }>;
  screenshots: Array<{ name: string; content: Buffer }>;
};

const platformUrl = (process.env.AUTOFLOW_PLATFORM_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const identityPath = process.env.AUTOFLOW_AGENT_IDENTITY_PATH ?? join("agent", ".identity.json");
const running = new Map<string, RunRuntime>();
const validating = new Map<string, ValidationRuntime>();
const debugSessions = new Map<string, DebugRuntime>();
const debugScreenshotIntervalMs = Number(process.env.AUTOFLOW_DEBUG_SCREENSHOT_INTERVAL_MS ?? 15_000);
const chromiumHeadless = process.env.AUTOFLOW_AGENT_HEADLESS === "1";

function loopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function requireSecurePlatformTransport(value: string) {
  const target = new URL(value);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("AUTOFLOW_PLATFORM_URL must use http or https");
  }
  if (
    target.protocol === "http:" &&
    !loopbackHostname(target.hostname) &&
    process.env.AUTOFLOW_ALLOW_INSECURE_PLATFORM_TRANSPORT !== "1"
  ) {
    throw new Error("AUTOFLOW_PLATFORM_URL must use HTTPS outside loopback; set AUTOFLOW_ALLOW_INSECURE_PLATFORM_TRANSPORT=1 only for isolated development");
  }
  return target;
}

function agentWebSocketUrl(value: string) {
  const target = requireSecurePlatformTransport(value);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = "/api/agents/connect";
  target.search = "";
  return target;
}

function abortable<T>(signal: AbortSignal, promise: Promise<T>) {
  if (signal.aborted) return Promise.reject(new Error("RUN_CANCELED"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("RUN_CANCELED"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function send(socket: WebSocket, value: Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function agentHeaders(identity: AgentIdentity) {
  return { authorization: `Bearer ${identity.credential}`, "content-type": "application/json" };
}

async function loadIdentity(): Promise<AgentIdentity | undefined> {
  try {
    return JSON.parse(await readFile(identityPath, "utf8")) as AgentIdentity;
  } catch {
    return undefined;
  }
}

async function register(): Promise<AgentIdentity> {
  const registrationToken = process.env.AUTOFLOW_AGENT_REGISTRATION_TOKEN;
  if (!registrationToken) {
    throw new Error("AUTOFLOW_AGENT_REGISTRATION_TOKEN is required for first registration");
  }
  const response = await fetch(`${platformUrl.split("?")[0]}/api/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      registrationToken,
      name: process.env.AUTOFLOW_AGENT_NAME ?? `agent-${process.env.COMPUTERNAME ?? "local"}`,
      browserVersion: "Chromium",
      os: process.platform,
      maxConcurrency: 1,
    }),
  });
  const body = (await response.json()) as { agent?: { id: string }; credential?: string; error?: string };
  if (!response.ok || !body.agent?.id || !body.credential) throw new Error(body.error ?? "Agent registration failed");
  const identity = { agentId: body.agent.id, credential: body.credential, platformUrl };
  await mkdir(dirname(identityPath), { recursive: true });
  await writeFile(identityPath, JSON.stringify(identity), { encoding: "utf8", mode: 0o600 });
  return identity;
}

async function uploadArtifact(identity: AgentIdentity, leaseId: string, name: string, contentType: string, content: Buffer) {
  const response = await fetch(`${identity.platformUrl}/api/agents/${encodeURIComponent(identity.agentId)}/leases/${encodeURIComponent(leaseId)}/artifacts`, {
    method: "POST",
    headers: agentHeaders(identity),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ name, contentType, contentBase64: content.toString("base64") }),
  });
  if (!response.ok) throw new Error("Artifact upload failed");
}

async function uploadDebugArtifact(identity: AgentIdentity, sessionId: string, name: string, contentType: string, content: Buffer) {
  const response = await fetch(`${identity.platformUrl}/api/agents/${encodeURIComponent(identity.agentId)}/debug-sessions/${encodeURIComponent(sessionId)}/artifacts`, {
    method: "POST",
    headers: agentHeaders(identity),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ name, contentType, contentBase64: content.toString("base64") }),
  });
  if (!response.ok) throw new Error("Debug artifact upload failed");
}

function interpolate(value: unknown, secrets: Record<string, string>, runtime?: RuntimeValues) {
  if (typeof value !== "string") return "";
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expression: string) => {
    const [scope, ...rest] = expression.trim().split(".");
    const key = rest.join(".");
    if (scope === "secret") return secrets[key] ?? "";
    if (scope === "project" || scope === "env") return runtime?.variables[expression.trim()] ?? secrets[expression.trim()] ?? "";
    if (scope === "data") return runtime?.data[key] ?? "";
    if (scope === "flow") return runtime?.flowOutputs[key] ?? "";
    return secrets[expression.trim()] ?? "";
  });
}

function redact(value: string, secrets: Record<string, string>) {
  let result = value;
  for (const secret of Object.values(secrets)) {
    if (secret) result = result.replaceAll(secret, "***");
  }
  return result;
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

function testIdAttributeFor(environment: Record<string, unknown>) {
  const value = typeof environment.testIdAttribute === "string" ? environment.testIdAttribute : "data-testid";
  if (!/^[a-zA-Z_][\w:-]*$/.test(value)) throw new Error("INVALID_TEST_ID_ATTRIBUTE");
  return value;
}

function getLocator(page: Page, elements: Array<Record<string, unknown>>, name: string, testIdAttribute = "data-testid"): Locator {
  const element = elements.find((item) => item.id === name || item.name === name);
  if (!element) throw new Error(`ELEMENT_NOT_FOUND:${name}`);
  const method = String(element.method ?? "CSS").toLowerCase();
  const value = String(element.value ?? "");
  if (method === "testid") return page.locator(`[${testIdAttribute}=${JSON.stringify(value)}]`);
  if (method === "role") {
    const match = value.match(/^([\w-]+)(?:\[name=["']?(.*?)["']?\])?$/);
    if (!match) throw new Error(`ROLE_LOCATOR_INVALID:${value}`);
    return page.getByRole(match[1] as never, match[2] ? { name: match[2] } : undefined);
  }
  if (method === "label") return page.getByLabel(value);
  if (method === "text") return page.getByText(value, { exact: true });
  return page.locator(value);
}

async function executeStep(page: Page, step: Record<string, unknown>, elements: Array<Record<string, unknown>>, secrets: Record<string, string>, signal: AbortSignal, runtime?: RuntimeValues, testIdAttribute = "data-testid") {
  if (signal.aborted) throw new Error("RUN_CANCELED");
  const action = String(step.action ?? step.type ?? "");
  const timeout = Math.max(1, Number(step.timeout ?? 30)) * 1000;
  const value = interpolate(step.value, secrets, runtime);
  const elementName = typeof step.element === "string" ? step.element : typeof step.elementId === "string" ? step.elementId : "";
  if (action === "open" || action === "navigate" || action === "打开页面") {
    let navigationError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await abortable(signal, page.goto(value, { waitUntil: "domcontentloaded", timeout }));
        return;
      } catch (error) {
        navigationError = error;
        if (attempt === 0) await abortable(signal, page.waitForTimeout(500));
      }
    }
    throw navigationError;
  }
  if (action === "wait" || action === "等待") {
    await abortable(signal, page.waitForTimeout(Math.min(timeout, Math.max(0, Number(value) || 0))));
    return;
  }
  if (action === "screenshot" || action === "截图") {
    const image = await abortable(signal, page.screenshot({ type: "png" }));
    runtime?.screenshots.push({ name: `step-${String(step.id ?? "screenshot")}.png`, content: image });
    return;
  }
  if ((action === "press" || action === "键盘按键") && !elementName) {
    await abortable(signal, page.keyboard.press(value));
    return;
  }
  const locator = getLocator(page, elements, elementName, testIdAttribute);
  if (action === "click" || action === "点击") {
    await abortable(signal, locator.click({ timeout }));
    return;
  }
  if (action === "fill" || action === "填写") {
    await abortable(signal, locator.fill(value, { timeout }));
    return;
  }
  if (action === "clear" || action === "清空填写") {
    await abortable(signal, locator.fill("", { timeout }));
    return;
  }
  if (action === "select" || action === "下拉选择") {
    await abortable(signal, locator.selectOption(value, { timeout }));
    return;
  }
  if (action === "check" || action === "勾选") {
    await abortable(signal, locator.check({ timeout }));
    return;
  }
  if (action === "press" || action === "键盘按键") {
    await abortable(signal, locator.press(value, { timeout }));
    return;
  }
  if (action === "assertVisible" || action === "可见性断言") {
    await abortable(signal, locator.waitFor({ state: "visible", timeout }));
    return;
  }
  if (action === "assertText" || action === "文本断言") {
    const text = await abortable(signal, locator.textContent({ timeout }));
    if (!text?.includes(value)) throw new Error(`TEXT_ASSERTION_FAILED:${value}`);
    return;
  }
  throw new Error(`ACTION_NOT_SUPPORTED:${action}`);
}

async function executeStepWithPolicy(
  page: Page,
  step: Record<string, unknown>,
  elements: Array<Record<string, unknown>>,
  secrets: Record<string, string>,
  signal: AbortSignal,
  runtime: RuntimeValues,
  testIdAttribute: string,
) {
  const attempts = step.failurePolicy === "重试 1 次" ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await executeStep(page, step, elements, secrets, signal, runtime, testIdAttribute);
      return { succeeded: true };
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  if (step.failurePolicy === "继续执行") {
    return { succeeded: false, error: lastError };
  }
  throw lastError;
}

function readObjectPath(value: unknown, path: string) {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => (
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[key]
      : undefined
  ), value);
}

function waitForResponse(
  runtime: RuntimeValues,
  expectedUrl: string,
  timeoutMs: number,
  afterSequence: number,
  signal?: AbortSignal,
) {
  const existing = [...runtime.responses]
    .reverse()
    .find((item) => item.sequence > afterSequence && (!expectedUrl || item.url.includes(expectedUrl)));
  if (existing) return Promise.resolve(existing);
  if (signal?.aborted) return Promise.reject(new Error("RUN_CANCELED"));
  return new Promise<RuntimeResponse | undefined>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (response: RuntimeResponse | undefined) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const index = runtime.responseWaiters.indexOf(waiter);
      if (index >= 0) runtime.responseWaiters.splice(index, 1);
      resolve(response);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const index = runtime.responseWaiters.indexOf(waiter);
      if (index >= 0) runtime.responseWaiters.splice(index, 1);
      reject(new Error("RUN_CANCELED"));
    };
    const waiter = {
      expectedUrl,
      afterSequence,
      resolve: finish,
    };
    timer = setTimeout(() => finish(undefined), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    runtime.responseWaiters.push(waiter);
  });
}

async function captureFlowOutput(
  page: Page,
  step: Record<string, unknown>,
  elements: Array<Record<string, unknown>>,
  runtime: RuntimeValues,
  testIdAttribute = "data-testid",
  responseSequenceBefore = 0,
  signal?: AbortSignal,
) {
  const name = typeof step.output === "string" ? step.output.trim() : typeof step.storeAs === "string" ? step.storeAs.trim() : "";
  if (!name) return;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error("FLOW_OUTPUT_NAME_INVALID");
  const source = typeof step.outputSource === "string" ? step.outputSource : "text";
  const elementName = typeof step.element === "string" ? step.element : typeof step.elementId === "string" ? step.elementId : "";
  let value: unknown;
  if (source === "url") {
    const parameter = typeof step.outputParameter === "string" ? step.outputParameter : name;
    value = new URL(page.url()).searchParams.get(parameter);
  } else if (source === "response") {
    const expectedUrl = typeof step.responseUrl === "string" ? step.responseUrl : "";
    const response = await waitForResponse(
      runtime,
      expectedUrl,
      Math.max(1, Number(step.timeout ?? 30)) * 1000,
      responseSequenceBefore,
      signal,
    );
    await response?.ready;
    value = response ? readObjectPath(response.body, typeof step.outputPath === "string" ? step.outputPath : name) : undefined;
  } else {
    const locator = getLocator(page, elements, elementName, testIdAttribute);
    value = source === "attribute"
      ? await locator.getAttribute(typeof step.outputAttribute === "string" ? step.outputAttribute : "value")
      : await locator.textContent();
  }
  if (value === undefined || value === null) throw new Error(`FLOW_OUTPUT_NOT_FOUND:${name}`);
  const captured = String(value).slice(0, 20_000);
  runtime.flowOutputs[name] = captured;
  if (step.outputPublic === true) runtime.publicFlowOutputs[name] = captured;
}

function observeApiResponses(page: Page, runtime: RuntimeValues) {
  page.on("response", (response) => {
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) return;
    const item: RuntimeResponse = { sequence: ++runtime.nextResponseSequence, url: response.url(), body: undefined };
    item.ready = response.json().then((body) => { item.body = body; }).catch(() => undefined);
    runtime.responses.push(item);
    if (runtime.responses.length > 20) runtime.responses.shift();
    for (const [index, waiter] of [...runtime.responseWaiters.entries()].reverse()) {
      if (item.sequence > waiter.afterSequence && (!waiter.expectedUrl || item.url.includes(waiter.expectedUrl))) {
        runtime.responseWaiters.splice(index, 1);
        waiter.resolve(item);
      }
    }
  });
}

function debugEvent(socket: WebSocket, runtime: DebugRuntime, kind: string, data: Record<string, unknown> = {}) {
  send(socket, {
    type: "debug.event",
    sessionId: runtime.id,
    kind,
    currentStep: runtime.currentStep,
    currentUrl: runtime.page.url(),
    data,
  });
}

function debugState(socket: WebSocket, runtime: DebugRuntime, status: "active" | "paused") {
  send(socket, {
    type: "debug.state",
    sessionId: runtime.id,
    status,
    currentStep: runtime.currentStep,
    currentUrl: runtime.page.url(),
  });
}

async function captureDebugScreenshot(socket: WebSocket, identity: AgentIdentity, runtime: DebugRuntime, reason: string) {
  if (Object.keys(runtime.secrets).length > 0) return;
  try {
    const image = await runtime.page.screenshot({ type: "png" });
    await uploadDebugArtifact(identity, runtime.id, `debug-${runtime.currentStep}-${Date.now()}.png`, "image/png", image);
    debugEvent(socket, runtime, "screenshot.captured", { reason });
  } catch (error) {
    debugEvent(socket, runtime, "screenshot.failed", { message: error instanceof Error ? error.message : "SCREENSHOT_FAILED" });
  }
}

async function endDebugSession(socket: WebSocket, runtime: DebugRuntime, status: "ended" | "failed", reason?: string) {
  if (runtime.ended) return;
  runtime.ended = true;
  runtime.paused = true;
  runtime.controller.abort();
  clearInterval(runtime.screenshotTimer);
  debugSessions.delete(runtime.id);
  await runtime.context.close().catch(() => undefined);
  await rm(runtime.profile, { recursive: true, force: true });
  send(socket, { type: "debug.ended", sessionId: runtime.id, status, reason });
}

async function executeDebugSteps(socket: WebSocket, identity: AgentIdentity, runtime: DebugRuntime, mode: "all" | "single") {
  if (runtime.executing || runtime.ended) return;
  runtime.executing = true;
  runtime.paused = false;
  debugState(socket, runtime, "active");
  const limit = mode === "single" ? runtime.currentStep + 1 : runtime.steps.length;
  try {
    while (
      runtime.currentStep < runtime.steps.length &&
      runtime.currentStep < limit &&
      !runtime.paused &&
      !runtime.ended &&
      !runtime.controller.signal.aborted
    ) {
      const source = runtime.steps[runtime.currentStep];
      const step = { ...source };
      const action = String(step.action ?? step.type ?? "");
      if (action === "open" || action === "navigate" || action === "打开页面") {
        step.value = environmentUrl(runtime.baseUrl, interpolate(step.value, runtime.secrets, runtime.values));
      }
      debugEvent(socket, runtime, "step.started", { stepId: step.id ?? String(runtime.currentStep), title: step.title ?? "" });
      const responseSequenceBefore = runtime.values.nextResponseSequence;
      const outcome = await executeStepWithPolicy(
        runtime.page,
        step,
        runtime.elements,
        runtime.secrets,
        runtime.controller.signal,
        runtime.values,
        runtime.testIdAttribute,
      );
      if (runtime.ended || runtime.controller.signal.aborted) break;
      if (!outcome.succeeded) {
        debugEvent(socket, runtime, "step.failed", {
          message: redact(outcome.error instanceof Error ? outcome.error.message : "DEBUG_STEP_FAILED", runtime.secrets),
          stepId: step.id ?? String(runtime.currentStep),
          continued: true,
        });
      } else {
        await captureFlowOutput(
          runtime.page,
          step,
          runtime.elements,
          runtime.values,
          runtime.testIdAttribute,
          responseSequenceBefore,
          runtime.controller.signal,
        );
      }
      runtime.currentStep += 1;
      debugEvent(socket, runtime, "step.completed", { stepId: step.id ?? String(runtime.currentStep - 1) });
      await captureDebugScreenshot(socket, identity, runtime, "step.completed");
    }
  } catch (error) {
    if (!runtime.ended && !runtime.controller.signal.aborted) {
      const message = redact(error instanceof Error ? error.message : "DEBUG_STEP_FAILED", runtime.secrets);
      debugEvent(socket, runtime, "step.failed", { message, stepId: runtime.steps[runtime.currentStep]?.id ?? String(runtime.currentStep) });
      await captureDebugScreenshot(socket, identity, runtime, "step.failed");
    }
  } finally {
    runtime.executing = false;
    if (!runtime.ended) {
      runtime.paused = true;
      debugState(socket, runtime, "paused");
    }
  }
}

async function startDebugSession(socket: WebSocket, identity: AgentIdentity, payload: DebugStart) {
  const existing = debugSessions.get(payload.session.id);
  if (existing) {
    send(socket, {
      type: "debug.ready",
      sessionId: existing.id,
      currentStep: existing.currentStep,
      currentUrl: existing.page.url(),
      browserContextId: existing.id,
    });
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), "autoflow-debug-"));
  try {
    const remoteDebugPort = process.env.AUTOFLOW_AGENT_BROWSER_REMOTE_DEBUG_PORT;
    const context = await chromium.launchPersistentContext(profile, {
      headless: chromiumHeadless,
      args: remoteDebugPort ? [`--remote-debugging-port=${remoteDebugPort}`] : [],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const flow = (payload.session.snapshot.flow ?? {}) as Record<string, unknown>;
    const environment = (payload.session.snapshot.environment ?? {}) as Record<string, unknown>;
    const runtime: DebugRuntime = {
      id: payload.session.id,
      context,
      page,
      profile,
      currentStep: Math.max(0, payload.session.currentStep),
      steps: Array.isArray(flow.steps) ? flow.steps.map((item) => item as Record<string, unknown>) : [],
      elements: Array.isArray(payload.session.snapshot.elements) ? payload.session.snapshot.elements.map((item) => item as Record<string, unknown>) : [],
      secrets: payload.session.secrets,
      baseUrl: String(environment.baseUrl ?? ""),
      testIdAttribute: testIdAttributeFor(environment),
      paused: true,
      executing: false,
      ended: false,
      controller: new AbortController(),
      values: {
        variables: Object.fromEntries(Object.entries(flow.variables && typeof flow.variables === "object" && !Array.isArray(flow.variables) ? flow.variables as Record<string, unknown> : {}).map(([key, value]) => [key, String(value ?? "")])),
        data: {},
        flowOutputs: {},
        publicFlowOutputs: {},
        responses: [],
        responseWaiters: [],
        nextResponseSequence: 0,
        screenshots: [],
      },
    };
    debugSessions.set(runtime.id, runtime);
    observeApiResponses(page, runtime.values);
    await page.exposeBinding("autoflowDebugPickerCapture", async (_source, payload) => {
      const target = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const candidates = await buildPickerCandidates(runtime, target);
      send(socket, { type: "picker.captured", sessionId: runtime.id, target: typeof target.target === "string" ? target.target : "", candidates });
    });
    page.on("console", (entry) => {
      if (entry.type() === "error") {
        debugEvent(socket, runtime, "console.error", { message: redact(entry.text(), runtime.secrets) });
      }
    });
    page.on("requestfailed", (request) => {
      debugEvent(socket, runtime, "network.failed", {
        url: redact(request.url(), runtime.secrets),
        error: redact(request.failure()?.errorText ?? "NETWORK_FAILED", runtime.secrets),
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) debugState(socket, runtime, runtime.executing ? "active" : "paused");
    });
    if (runtime.steps.length === 0) {
      // Blank debug session: navigate straight to the start URL (defaults to the environment base URL).
      const startUrl = typeof payload.session.snapshot.startUrl === "string" && payload.session.snapshot.startUrl.trim()
        ? payload.session.snapshot.startUrl.trim()
        : "/";
      const timeout = Math.max(10, Number(environment.timeout ?? 30)) * 1000;
      await page.goto(environmentUrl(runtime.baseUrl, startUrl), { waitUntil: "domcontentloaded", timeout });
    }
    if (Object.keys(runtime.secrets).length === 0) {
      runtime.screenshotTimer = setInterval(() => {
        void captureDebugScreenshot(socket, identity, runtime, "interval");
      }, Math.max(5_000, debugScreenshotIntervalMs));
    }
    await captureDebugScreenshot(socket, identity, runtime, "session.ready");
    send(socket, {
      type: "debug.ready",
      sessionId: runtime.id,
      currentStep: runtime.currentStep,
      currentUrl: page.url(),
      browserContextId: randomUUID(),
    });
  } catch (error) {
    console.error("Failed to start debug session", error);
    await rm(profile, { recursive: true, force: true });
    send(socket, { type: "debug.ended", sessionId: payload.session.id, status: "failed", reason: error instanceof Error ? error.message : "DEBUG_BROWSER_LAUNCH_FAILED" });
  }
}

async function handleDebugMessage(socket: WebSocket, identity: AgentIdentity, message: Record<string, unknown>) {
  if (message.type === "debug.start") {
    await startDebugSession(socket, identity, message as unknown as DebugStart);
    return;
  }
  const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
  const runtime = debugSessions.get(sessionId);
  if (message.type === "debug.reconnect") {
    if (runtime) {
      send(socket, { type: "debug.ready", sessionId: runtime.id, currentStep: runtime.currentStep, currentUrl: runtime.page.url(), browserContextId: runtime.id });
    } else {
      send(socket, { type: "debug.ended", sessionId, status: "failed", reason: "DEBUG_CONTEXT_NOT_RECOVERABLE" });
    }
    return;
  }
  if (message.type === "picker.enable" && runtime) {
    await enablePicker(socket, runtime);
    return;
  }
  if (message.type === "picker.preview" && runtime) {
    const candidate = message.candidate as PickerCandidate | undefined;
    if (candidate && typeof candidate.method === "string" && typeof candidate.value === "string") {
      await previewPickerCandidate(socket, runtime, candidate, typeof message.captureId === "string" ? message.captureId : "", Number(message.candidateIndex ?? 0));
    }
    return;
  }
  if (message.type !== "debug.command") return;
  const command = message.command;
  const commandId = typeof message.commandId === "string" ? message.commandId : undefined;
  const acknowledge = (accepted: boolean, reason?: string) => {
    if (!commandId) return;
    send(socket, { type: "debug.command.ack", sessionId, commandId, command, accepted, reason });
  };
  if (!runtime) {
    acknowledge(false, "DEBUG_SESSION_NOT_READY");
    return;
  }
  if (runtime.executing && command !== "pause" && command !== "stop") {
    acknowledge(false, "DEBUG_SESSION_BUSY");
    return;
  }
  acknowledge(true);
  if (command === "stop") {
    await endDebugSession(socket, runtime, "ended", typeof message.reason === "string" ? message.reason : "MANUAL_STOP");
    return;
  }
  if (command === "pause") {
    runtime.paused = true;
    debugState(socket, runtime, "paused");
    return;
  }
  if (command === "skip") {
    const skipped = runtime.steps[runtime.currentStep];
    runtime.currentStep = Math.min(runtime.currentStep + 1, runtime.steps.length);
    runtime.paused = true;
    debugEvent(socket, runtime, "step.skipped", { stepId: skipped?.id ?? String(runtime.currentStep - 1) });
    debugState(socket, runtime, "paused");
    return;
  }
  if (command === "runCurrent" || command === "retry") {
    void executeDebugSteps(socket, identity, runtime, "single");
    return;
  }
  if (command === "continue") {
    void executeDebugSteps(socket, identity, runtime, "all");
    return;
  }
  if (command === "start") {
    runtime.currentStep = 0;
    runtime.values.flowOutputs = {};
    runtime.values.publicFlowOutputs = {};
    runtime.values.responses = [];
    runtime.values.screenshots = [];
    void executeDebugSteps(socket, identity, runtime, "all");
  }
}

function candidateLocator(page: Page, candidate: Pick<PickerCandidate, "method" | "value">, testIdAttribute = "data-testid") {
  if (candidate.method === "testid") return page.locator(`[${testIdAttribute}=${JSON.stringify(candidate.value)}]`);
  if (candidate.method === "role") return page.getByRole(candidate.value as never);
  if (candidate.method === "label") return page.getByLabel(candidate.value);
  if (candidate.method === "text") return page.getByText(candidate.value, { exact: true });
  return page.locator(candidate.value);
}

function pickerScore(method: PickerCandidate["method"], count: number) {
  const base = { testid: 98, role: 84, label: 80, text: 62, css: 52 }[method];
  if (count === 1) return base;
  if (count === 0) return 0;
  return Math.max(5, base - Math.min(70, (count - 1) * 12));
}

async function buildPickerCandidates(runtime: DebugRuntime, target: Record<string, unknown>) {
  const source = [
    { method: "testid" as const, value: target.testid, label: runtime.testIdAttribute },
    { method: "role" as const, value: target.role, label: "role" },
    { method: "label" as const, value: target.label, label: "label" },
    { method: "text" as const, value: target.text, label: "text" },
    { method: "css" as const, value: target.css, label: "css" },
  ];
  const seen = new Set<string>();
  const candidates: PickerCandidate[] = [];
  for (const item of source) {
    const value = item.value;
    if (typeof value !== "string" || !value.trim() || value.length > 500) continue;
    if (Object.values(runtime.secrets).some((secret) => secret && value.includes(secret))) continue;
    const key = `${item.method}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const count = await candidateLocator(runtime.page, { method: item.method, value }, runtime.testIdAttribute).count();
      candidates.push({ method: item.method, value, count, score: pickerScore(item.method, count), label: `${item.label}: ${value}`.slice(0, 160) });
    } catch {
      // Ignore a locator that cannot be evaluated in the current document.
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

async function enablePicker(socket: WebSocket, runtime: DebugRuntime) {
  // Inject the picker as a plain-JS string: tsx transforms arrow/function declarations with
  // an `__name` helper that is not available inside page.evaluate's serialized function.
  const script = `
    (() => {
      const testIdAttribute = ${JSON.stringify(runtime.testIdAttribute)};
      const current = window;
      if (current.__autoflowPickerCleanup) current.__autoflowPickerCleanup();
      const cssPath = (element) => {
        const id = element.getAttribute("id");
        if (id) return "#" + CSS.escape(id);
        const segments = [];
        let node = element;
        while (node && segments.length < 5) {
          const tag = node.tagName.toLowerCase();
          const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName) : [];
          const index = siblings.indexOf(node) + 1;
          segments.unshift(tag + ":nth-of-type(" + Math.max(1, index) + ")");
          node = node.parentElement;
        }
        return segments.join(" > ");
      };
      const roleFor = (element) => {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        if (element.tagName === "BUTTON") return "button";
        if (element.tagName === "A") return "link";
        if (element.tagName === "SELECT") return "combobox";
        if (element.tagName === "TEXTAREA") return "textbox";
        if (element.tagName === "INPUT") return element.getAttribute("type") === "checkbox" ? "checkbox" : "textbox";
        return "";
      };
      const listener = (event) => {
        const element = event.target instanceof HTMLElement ? event.target : undefined;
        if (!element) return;
        event.preventDefault();
        event.stopPropagation();
        const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? [...(element.labels || [])].map((label) => (label.textContent || "").trim()).filter(Boolean)
          : [];
        if (current.autoflowDebugPickerCapture) {
          current.autoflowDebugPickerCapture({
            target: element.tagName.toLowerCase() + (element.id ? "#" + element.id : ""),
            testid: element.getAttribute(testIdAttribute) || "",
            role: roleFor(element),
            label: labels[0] || element.getAttribute("aria-label") || "",
            text: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120),
            css: cssPath(element),
          });
        }
        if (current.__autoflowPickerCleanup) current.__autoflowPickerCleanup();
      };
      document.addEventListener("click", listener, true);
      current.__autoflowPickerCleanup = () => document.removeEventListener("click", listener, true);
    })();
  `;
  await runtime.page.evaluate(script);
  debugEvent(socket, runtime, "picker.enabled");
}

async function previewPickerCandidate(socket: WebSocket, runtime: DebugRuntime, candidate: PickerCandidate, captureId: string, candidateIndex: number) {
  const locator = candidateLocator(runtime.page, candidate, runtime.testIdAttribute);
  const count = await locator.count();
  if (count > 0) {
    await locator.first().evaluate((element) => {
      const target = element as HTMLElement;
      const prior = target.style.outline;
      const priorOffset = target.style.outlineOffset;
      target.style.outline = "3px solid #e5a11a";
      target.style.outlineOffset = "2px";
      target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      window.setTimeout(() => {
        target.style.outline = prior;
        target.style.outlineOffset = priorOffset;
      }, 4000);
    });
  }
  send(socket, { type: "picker.previewed", sessionId: runtime.id, captureId, candidateIndex, count });
}

async function runValidation(socket: WebSocket, payload: ValidationStart) {
  const { validation } = payload;
  if (validating.has(validation.id)) return;
  const controller = new AbortController();
  const runtime: ValidationRuntime = { controller };
  validating.set(validation.id, runtime);
  const startedAt = Date.now();
  let profile: string | undefined;
  let context: BrowserContext | undefined;
  try {
    const testIdAttribute = testIdAttributeFor(validation.environment);
    const path = typeof validation.element.path === "string" ? validation.element.path : "/";
    const baseUrl = String(validation.environment.baseUrl ?? "");
    const elementName = typeof validation.element.id === "string"
      ? validation.element.id
      : typeof validation.element.name === "string"
        ? validation.element.name
        : "";
    if (!baseUrl || !elementName) throw new Error("ELEMENT_VALIDATION_INPUT_INVALID");
    profile = await mkdtemp(join(tmpdir(), "autoflow-validation-"));
    context = await chromium.launchPersistentContext(profile, { headless: chromiumHeadless });
    runtime.context = context;
    const page = context.pages()[0] ?? (await context.newPage());
    send(socket, { type: "validation.started", validationId: validation.id });
    const timeout = Math.max(1, Number(validation.environment.timeout ?? 30)) * 1000;
    await abortable(controller.signal, page.goto(environmentUrl(baseUrl, path), { waitUntil: "domcontentloaded", timeout }));
    const locator = getLocator(page, [validation.element], elementName, testIdAttribute);
    const count = await abortable(controller.signal, locator.count());
    const firstMatch = count > 0
      ? await abortable(controller.signal, locator.first().evaluate((node) => node.outerHTML.slice(0, 2_000)))
      : undefined;
    send(socket, {
      type: "validation.complete",
      validationId: validation.id,
      status: "success",
      result: { count, firstMatch, elapsedMs: Date.now() - startedAt },
    });
  } catch (error) {
    send(socket, {
      type: "validation.complete",
      validationId: validation.id,
      status: "failed",
      error: controller.signal.aborted ? "VALIDATION_CANCELED" : error instanceof Error ? error.message : "VALIDATION_FAILED",
      result: { count: 0, elapsedMs: Date.now() - startedAt },
    });
  } finally {
    await context?.close().catch(() => undefined);
    if (profile) await rm(profile, { recursive: true, force: true });
    validating.delete(validation.id);
  }
}

async function runLease(socket: WebSocket, identity: AgentIdentity, payload: RunLease) {
  const { lease, run } = payload;
  if (running.has(lease.id)) return;
  const controller = new AbortController();
  const runRuntime: RunRuntime = { controller };
  running.set(lease.id, runRuntime);
  const snapshot = run.snapshot;
  const environment = (snapshot.environment ?? {}) as Record<string, unknown>;
  const flow = (snapshot.flow ?? {}) as Record<string, unknown>;
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements.map((item) => item as Record<string, unknown>) : [];
  const steps = Array.isArray(flow.steps) ? flow.steps.map((item) => item as Record<string, unknown>) : [];
  const upToStepId = typeof snapshot.upToStepId === "string" ? snapshot.upToStepId : undefined;
  const runSteps = upToStepId ? steps.slice(0, steps.findIndex((step) => step.id === upToStepId) + 1) : steps;
  const baseUrl = String(environment.baseUrl ?? "");
  let testIdAttribute = "data-testid";
  const hasSecrets = Object.keys(run.secrets).length > 0;
  const datasetRow = ((snapshot.datasetRow ?? {}) as Record<string, unknown>).data;
  const runtime: RuntimeValues = {
    variables: Object.fromEntries(Object.entries(flow.variables && typeof flow.variables === "object" && !Array.isArray(flow.variables) ? flow.variables as Record<string, unknown> : {}).map(([key, value]) => [key, String(value ?? "")])),
    data: Object.fromEntries(Object.entries(datasetRow && typeof datasetRow === "object" && !Array.isArray(datasetRow) ? datasetRow as Record<string, unknown> : {}).map(([key, value]) => [key, String(value ?? "")])),
    flowOutputs: {},
    publicFlowOutputs: {},
    responses: [],
    responseWaiters: [],
    nextResponseSequence: 0,
    screenshots: [],
  };
  const profile = await mkdtemp(join(tmpdir(), "autoflow-agent-"));
  let context: BrowserContext | undefined;
  let activeStep: { index: number; id: string; title: string } | undefined;
  let completedSteps = 0;
  let failedSteps = 0;
  const renewal = setInterval(() => send(socket, { type: "lease.renew", leaseId: lease.id }), 15_000);
  try {
    testIdAttribute = testIdAttributeFor(environment);
    context = await chromium.launchPersistentContext(profile, { headless: chromiumHeadless });
    runRuntime.context = context;
    if (!hasSecrets) await context.tracing.start({ screenshots: true, snapshots: true });
    const page = context.pages()[0] ?? (await context.newPage());
    observeApiResponses(page, runtime);
    for (const [index, step] of runSteps.entries()) {
      if (controller.signal.aborted) throw new Error("RUN_CANCELED");
      activeStep = { index, id: String(step.id ?? index), title: String(step.title ?? "") };
      const stepStartedAt = Date.now();
      const rawValue = interpolate(step.value, run.secrets, runtime);
      if (String(step.action ?? step.type) === "open" || String(step.action ?? step.type) === "navigate" || String(step.action ?? step.type) === "打开页面") {
        step.value = environmentUrl(baseUrl, rawValue);
      }
      const responseSequenceBefore = runtime.nextResponseSequence;
      send(socket, { type: "run.event", leaseId: lease.id, kind: "step.started", data: { index, stepId: activeStep.id, title: activeStep.title } });
      const outcome = await executeStepWithPolicy(page, step, elements, run.secrets, controller.signal, runtime, testIdAttribute);
      if (!outcome.succeeded) {
        failedSteps += 1;
        const message = redact(outcome.error instanceof Error ? outcome.error.message : "STEP_FAILED", run.secrets);
        send(socket, { type: "run.event", leaseId: lease.id, kind: "step.failed", data: { index, stepId: activeStep.id, title: activeStep.title, durationMs: Date.now() - stepStartedAt, message, continued: true } });
        continue;
      }
      await captureFlowOutput(
        page,
        step,
        elements,
        runtime,
        testIdAttribute,
        responseSequenceBefore,
        controller.signal,
      );
      completedSteps += 1;
      send(socket, { type: "run.event", leaseId: lease.id, kind: "step.completed", data: { index, stepId: activeStep.id, title: activeStep.title, durationMs: Date.now() - stepStartedAt } });
    }
    if (!hasSecrets) {
      for (const screenshot of runtime.screenshots) {
        await uploadArtifact(identity, lease.id, screenshot.name, "image/png", screenshot.content);
      }
      const tracePath = join(profile, "trace.zip");
      await context.tracing.stop({ path: tracePath });
      await uploadArtifact(identity, lease.id, "trace.zip", "application/zip", await readFile(tracePath));
    }
    const sensitiveFlowOutputs = Object.keys(runtime.flowOutputs).filter((name) => !Object.hasOwn(runtime.publicFlowOutputs, name));
    send(socket, {
      type: "run.complete",
      leaseId: lease.id,
      status: failedSteps === 0 ? "success" : "failed",
      result: {
        completedSteps,
        failedSteps,
        flowOutputs: runtime.publicFlowOutputs,
        sensitiveFlowOutputs,
      },
    });
  } catch (error) {
    const message = controller.signal.aborted
      ? "RUN_CANCELED"
      : redact(error instanceof Error ? error.message : "RUN_FAILED", run.secrets);
    send(socket, {
      type: "run.event",
      leaseId: lease.id,
      kind: controller.signal.aborted ? "run.canceled" : "run.failed",
      data: { message, stepId: activeStep?.id, stepIndex: activeStep?.index, title: activeStep?.title },
    });
    send(socket, { type: "run.complete", leaseId: lease.id, status: "failed", result: { error: message } });
  } finally {
    clearInterval(renewal);
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
    running.delete(lease.id);
  }
}

async function start() {
  requireSecurePlatformTransport(platformUrl);
  const identity = (await loadIdentity()) ?? (await register());
  const wsUrl = agentWebSocketUrl(platformUrl);
  wsUrl.searchParams.set("agentId", identity.agentId);
  const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${identity.credential}` } });
  let debugMessageQueue = Promise.resolve();
  const heartbeat = setInterval(() => send(socket, {
    type: "heartbeat",
    browserVersion: "Chromium",
    os: process.platform,
    currentTask: [...running.keys()][0] ?? [...validating.keys()][0] ?? [...debugSessions.keys()][0] ?? null,
  }), 15_000);
  socket.on("open", () => send(socket, { type: "ready", browserVersion: "Chromium", os: process.platform }));
  socket.on("message", (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "run.lease") {
      void runLease(socket, identity, message as unknown as RunLease).catch((error) => {
        console.error("Unhandled run lease error", error);
      });
    }
    if (message.type === "run.cancel" && typeof message.leaseId === "string") {
      const runtime = running.get(message.leaseId);
      runtime?.controller.abort();
      void runtime?.context?.close().catch(() => undefined);
    }
    if (message.type === "validation.start") {
      void runValidation(socket, message as unknown as ValidationStart).catch((error) => {
        console.error("Unhandled validation error", error);
      });
      return;
    }
    if (typeof message.type === "string" && (message.type.startsWith("debug.") || message.type.startsWith("picker."))) {
      debugMessageQueue = debugMessageQueue
        .then(() => handleDebugMessage(socket, identity, message))
        .catch((error) => {
          console.error("Unhandled debug message error", error);
        });
    }
  });
  socket.on("close", () => {
    clearInterval(heartbeat);
    for (const runtime of running.values()) {
      runtime.controller.abort();
      void runtime.context?.close().catch(() => undefined);
    }
    for (const runtime of validating.values()) {
      runtime.controller.abort();
      void runtime.context?.close().catch(() => undefined);
    }
    for (const runtime of [...debugSessions.values()]) {
      void endDebugSession(socket, runtime, "failed", "AGENT_CONNECTION_LOST");
    }
    setTimeout(() => void start(), 5_000).unref();
  });
  socket.on("error", () => socket.close());
}

void start();
