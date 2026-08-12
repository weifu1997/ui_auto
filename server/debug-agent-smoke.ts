import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { chromium } from "playwright";
import { removeWorkerRoot, startWorker, stopWorker, type TestWorker } from "./worker-test-utils.ts";

const port = 8796;
let worker: TestWorker | undefined;
let root: string | undefined;
let agent: ReturnType<typeof spawn> | undefined;
let agentOutput = "";

function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: (await response.json()) as T };
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}\n\nAgent output:\n${agentOutput || "(no stdout/stderr received)"}`);
}

async function stopAgent() {
  if (!agent || agent.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(agent.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await once(killer, "exit").catch(() => undefined);
  } else {
    agent.kill();
    await once(agent, "exit").catch(() => undefined);
  }
}

try {
  worker = await startWorker({ port, env: { AUTOFLOW_EXECUTOR_TYPE: "agent" } });
  root = worker.root;
  const registration = await api<{ token: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "debug-agent@example.test", name: "Debug Agent", password: "test-password" }),
  });
  if (!registration.response.ok || !registration.body.token) throw new Error("Platform registration failed");
  const login = await api<{ token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "debug-agent@example.test", password: "test-password" }),
  });
  const token = login.body.token;
  const session = await api<{ workspaces: Array<{ id: string }> }>("/api/auth/session", { headers: headers(token) });
  const workspaceId = session.body.workspaces[0]?.id;
  if (!token || !workspaceId) throw new Error("Platform login did not create workspace");

  const projectResponse = await api<{ project: { id: string } }>(`/api/workspaces/${workspaceId}/projects`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Debug Agent fixture" }),
  });
  const projectId = projectResponse.body.project?.id;
  if (!projectId) throw new Error("Platform project creation failed");
  const fixtureEnvironment = { id: "fixture", name: "Fixture", baseUrl: `http://127.0.0.1:${port}`, browser: "Chromium", testIdAttribute: "data-test" };
  const sauceDemoEnvironment = { id: "sauce-demo", name: "Sauce Demo", baseUrl: "https://www.saucedemo.com/", browser: "Chromium", testIdAttribute: "data-test" };
  const currentDocument = await api<{ version: number }>(`/api/platform/projects/${projectId}/document`, { headers: headers(token) });
  if (!currentDocument.response.ok) throw new Error("Platform project document lookup failed");
  const document = await api(`/api/platform/projects/${projectId}/document`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ data: { environments: [fixtureEnvironment, sauceDemoEnvironment] }, expectedVersion: currentDocument.body.version }),
  });
  if (!document.response.ok) throw new Error("Platform project document setup failed");
  const revisionResponse = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: {
        id: "debug-agent-flow",
        name: "Debug Agent flow",
        steps: [
          { id: "open", title: "Open login", action: "open", value: "/__fixture/login", timeout: 10 },
          { id: "account", title: "Fill account", action: "fill", element: "account", value: "debug-user", timeout: 10 },
        ],
      },
      environment: fixtureEnvironment,
      elements: [{ id: "account", name: "account", method: "testid", value: "login-account" }],
      dataset: null,
    }),
  });
  const revisionId = revisionResponse.body.revision?.id;
  if (!revisionId) throw new Error("Platform revision creation failed");
  const published = await api(`/api/platform/projects/${projectId}/revisions/${revisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!published.response.ok) throw new Error("Platform revision publish failed");

  const agentRegistration = await api<{ registrationToken: string }>("/api/agent-tokens", {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ workspaceId }),
  });
  agent = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "agent/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOFLOW_PLATFORM_URL: `http://127.0.0.1:${port}`,
       AUTOFLOW_AGENT_REGISTRATION_TOKEN: agentRegistration.body.registrationToken,
      AUTOFLOW_AGENT_NAME: "debug-agent-smoke",
      AUTOFLOW_AGENT_HEADLESS: "1",
      AUTOFLOW_AGENT_BROWSER_REMOTE_DEBUG_PORT: "9360",
      AUTOFLOW_AGENT_IDENTITY_PATH: join(root, "agent.identity.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  agent.stdout?.on("data", (chunk: Buffer | string) => {
    agentOutput += chunk.toString();
  });
  agent.stderr?.on("data", (chunk: Buffer | string) => {
    agentOutput += chunk.toString();
  });
  const registeredAgent = await waitFor(async () => {
    const response = await api<{ agents: Array<{ id: string; status: string }> }>(`/api/agents?workspaceId=${workspaceId}`, { headers: headers(token) });
    return response.body.agents.find((item) => item.status === "online");
  }, "Agent heartbeat");
  const binding = await api(`/api/platform/projects/${projectId}/agent-bindings`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ environmentId: "fixture", agentId: registeredAgent.id }),
  });
  if (!binding.response.ok) throw new Error("Agent binding failed");

  const elementValidation = await api<{ validation: { id: string } }>(`/api/platform/projects/${projectId}/element-validations`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      environmentId: "fixture",
      element: { id: "account", name: "account", path: "/__fixture/login", method: "testid", value: "login-account" },
    }),
  });
  const elementValidationId = elementValidation.body.validation?.id;
  if (!elementValidation.response.ok || !elementValidationId) throw new Error("Agent element validation creation failed");
  const validationComplete = await waitFor(async () => {
    const response = await api<{ validation: { status: string; result?: { count?: number; firstMatch?: string } } }>(`/api/platform/projects/${projectId}/element-validations/${elementValidationId}`, { headers: headers(token) });
    return ["success", "failed", "canceled"].includes(response.body.validation.status) ? response.body.validation : undefined;
  }, "Agent element validation");
  if (validationComplete.status !== "success" || validationComplete.result?.count !== 1 || !validationComplete.result.firstMatch?.includes("login-account")) {
    throw new Error(`Agent element validation failed: ${JSON.stringify(validationComplete)}`);
  }

  const created = await api<{ session: { id: string } }>(`/api/platform/projects/${projectId}/debug-sessions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ revisionId, environmentId: "fixture" }),
  });
  const sessionId = created.body.session?.id;
  if (!created.response.ok || !sessionId) throw new Error(`Debug session creation failed: ${JSON.stringify(created.body)}`);
  await waitFor(async () => {
    const response = await api<{ session: { status: string; currentUrl: string | null } }>(`/api/platform/projects/${projectId}/debug-sessions/${sessionId}`, { headers: headers(token) });
    return response.body.session.status === "paused" ? response.body.session : undefined;
  }, "debug browser readiness");
  const firstStep = await api(`/api/platform/projects/${projectId}/debug-sessions/${sessionId}/commands`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ command: "runCurrent" }),
  });
  if (!firstStep.response.ok) throw new Error("First debug step command failed");
  await waitFor(async () => {
    const response = await api<{ session: { status: string; currentStep: number; currentUrl: string | null } }>(`/api/platform/projects/${projectId}/debug-sessions/${sessionId}`, { headers: headers(token) });
    const value = response.body.session;
    return value.status === "paused" && value.currentStep === 1 && value.currentUrl?.includes("/__fixture/login") ? value : undefined;
  }, "first persistent debug step");
  const secondStep = await api(`/api/platform/projects/${projectId}/debug-sessions/${sessionId}/commands`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ command: "runCurrent" }),
  });
  if (!secondStep.response.ok) throw new Error("Second debug step command failed");
  const complete = await waitFor(async () => {
    const response = await api<{ session: { status: string; currentStep: number; currentUrl: string | null; artifacts: Array<{ contentType: string }> } }>(`/api/platform/projects/${projectId}/debug-sessions/${sessionId}`, { headers: headers(token) });
    const value = response.body.session;
    return value.status === "paused" && value.currentStep === 2 && value.currentUrl?.includes("/__fixture/login") && value.artifacts.some((artifact) => artifact.contentType === "image/png") ? value : undefined;
  }, "persistent debug step and screenshot");
  if (!complete.currentUrl?.includes("/__fixture/login")) throw new Error("Debug Agent did not preserve page URL");
  const stopped = await api(`/api/platform/projects/${projectId}/debug-sessions/${sessionId}/commands`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ command: "stop" }),
  });
  if (!stopped.response.ok) throw new Error("Debug stop command failed");
  await waitFor(async () => {
    const response = await api<{ session: { status: string } }>(`/api/platform/projects/${projectId}/debug-sessions/${sessionId}`, { headers: headers(token) });
    return response.body.session.status === "ended" ? response.body.session : undefined;
  }, "debug browser cleanup");

  const secret = await api(`/api/platform/projects/${projectId}/secrets`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "login_password", value: "not-for-artifacts" }),
  });
  if (!secret.response.ok) throw new Error("Secret setup failed");
  const secretRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: { id: "sensitive-debug-flow", name: "Sensitive debug flow", steps: [{ id: "open", title: "Open login", action: "open", value: "/__fixture/login?token=not-for-artifacts", timeout: 10 }] },
       environment: fixtureEnvironment,
      elements: [],
      secretNames: ["login_password"],
    }),
  });
  const secretRevisionId = secretRevision.body.revision?.id;
  if (!secretRevisionId) throw new Error("Sensitive revision creation failed");
  const secretPublished = await api(`/api/platform/projects/${projectId}/revisions/${secretRevisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!secretPublished.response.ok) throw new Error("Sensitive revision publish failed");
  const sensitiveDebug = await api<{ session: { id: string } }>(`/api/platform/projects/${projectId}/debug-sessions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ revisionId: secretRevisionId, environmentId: "fixture" }),
  });
  const sensitiveDebugId = sensitiveDebug.body.session?.id;
  if (!sensitiveDebug.response.ok || !sensitiveDebugId) throw new Error("Sensitive debug session creation failed");
  await waitFor(async () => {
    const response = await api<{ session: { status: string } }>(`/api/platform/projects/${projectId}/debug-sessions/${sensitiveDebugId}`, { headers: headers(token) });
    return response.body.session.status === "paused" ? response.body.session : undefined;
  }, "sensitive debug browser readiness");
  await api(`/api/platform/projects/${projectId}/debug-sessions/${sensitiveDebugId}/commands`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ command: "runCurrent" }),
  });
  const sensitiveComplete = await waitFor(async () => {
    const response = await api<{ session: { currentStep: number; artifacts: unknown[]; currentUrl?: string } }>(`/api/platform/projects/${projectId}/debug-sessions/${sensitiveDebugId}`, { headers: headers(token) });
    return response.body.session.currentStep === 1 ? response.body.session : undefined;
  }, "sensitive debug step");
  if (sensitiveComplete.artifacts.length !== 0) throw new Error("Sensitive debug session uploaded an artifact");
  if ((sensitiveComplete.currentUrl ?? "").includes("not-for-artifacts")) {
    throw new Error(`Sensitive debug session persisted a secret in currentUrl: ${sensitiveComplete.currentUrl}`);
  }
  if (!(sensitiveComplete.currentUrl ?? "").includes("***")) {
    throw new Error("Sensitive debug session currentUrl was not redacted");
  }
  await api(`/api/platform/projects/${projectId}/debug-sessions/${sensitiveDebugId}/commands`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ command: "stop" }),
  });
  await waitFor(async () => {
    const response = await api<{ session: { status: string } }>(`/api/platform/projects/${projectId}/debug-sessions/${sensitiveDebugId}`, { headers: headers(token) });
    return response.body.session.status === "ended" ? response.body.session : undefined;
  }, "sensitive debug cleanup");

  const blankDebug = await api<{ session: { id: string } }>(`/api/platform/projects/${projectId}/debug-sessions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ blank: true, environmentId: "fixture", startUrl: "/__fixture/login" }),
  });
  const blankDebugId = blankDebug.body.session?.id;
  if (!blankDebug.response.ok || !blankDebugId) throw new Error(`Blank debug session creation failed: ${JSON.stringify(blankDebug.body)}`);
  await waitFor(async () => {
    const response = await api<{ session: { status: string; currentUrl: string | null } }>(`/api/platform/projects/${projectId}/debug-sessions/${blankDebugId}`, { headers: headers(token) });
    return response.body.session.status === "paused" && response.body.session.currentUrl?.includes("/__fixture/login") ? response.body.session : undefined;
  }, "blank debug session navigated to start URL");
  const pickerEnabled = await api(`/api/platform/projects/${projectId}/debug-sessions/${blankDebugId}/picker/enable`, { method: "POST", headers: headers(token) });
  if (!pickerEnabled.response.ok) throw new Error("Blank session picker enable failed");
  const cdpBrowser = await chromium.connectOverCDP("http://127.0.0.1:9360");
  try {
    const pages = cdpBrowser.contexts().flatMap((context) => context.pages());
    const debugPage = pages.find((page) => page.url().includes("/__fixture/login"));
    if (!debugPage) throw new Error("Debug browser page was not reachable over CDP");
    await debugPage.click("[data-testid=login-submit]", { timeout: 5_000 });
    const captured = await waitFor(async () => {
      const response = await api<{ captures: Array<{ id: string; candidates: Array<{ method: string; value: string }> }> }>(`/api/platform/projects/${projectId}/debug-sessions/${blankDebugId}/picker-captures`, { headers: headers(token) });
      const capture = response.body.captures[0];
      return capture?.candidates.some((candidate) => candidate.method === "testid" && candidate.value === "login-submit") ? capture : undefined;
    }, "real agent picker candidates");
    const preview = await api(`/api/platform/projects/${projectId}/debug-sessions/${blankDebugId}/picker-captures/${captured.id}/preview`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ candidateIndex: 0 }),
    });
    if (!preview.response.ok) throw new Error("Real agent picker preview failed");
    const fillback = await api<{ target: string; candidate: { method: string; value: string }; path: string; environmentId: string }>(`/api/platform/projects/${projectId}/debug-sessions/${blankDebugId}/picker-captures/${captured.id}/confirm`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ candidateIndex: 0, target: "fillback", name: "blank login submit" }),
    });
    if (!fillback.response.ok || fillback.body.target !== "fillback" || fillback.body.candidate.value !== "login-submit") {
      throw new Error(`Real agent fillback failed: ${JSON.stringify(fillback.body)}`);
    }
    const documentAfterFillback = await api<{ data: { elements?: unknown[] } }>(`/api/platform/projects/${projectId}/document`, { headers: headers(token) });
    const elementCount = Array.isArray(documentAfterFillback.body.data.elements) ? documentAfterFillback.body.data.elements.length : 0;
    if (elementCount !== 0) throw new Error(`Fillback created an element: ${elementCount}`);
  } finally {
    await cdpBrowser.close().catch(() => undefined);
  }
  await api(`/api/platform/projects/${projectId}/debug-sessions/${blankDebugId}/commands`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ command: "stop" }),
  });
  await waitFor(async () => {
    const response = await api<{ session: { status: string } }>(`/api/platform/projects/${projectId}/debug-sessions/${blankDebugId}`, { headers: headers(token) });
    return response.body.session.status === "ended" ? response.body.session : undefined;
  }, "blank debug session cleanup");

  const dataset = await api<{ version: { id: string } }>(`/api/platform/projects/${projectId}/datasets`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name: "Agent parameters", fileName: "agent-parameters.csv", contentBase64: Buffer.from("account\nalice\n").toString("base64") }),
  });
  const datasetVersionId = dataset.body.version?.id;
  if (!dataset.response.ok || !datasetVersionId) throw new Error("Agent parameter dataset import failed");
  const parameterizedRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: {
        id: "parameterized-agent-flow",
        name: "Parameterized agent flow",
        steps: [
          { id: "open", title: "Open interpolation", action: "open", value: "/__fixture/interpolation?account=alice", output: "accountEcho", outputSource: "url", outputParameter: "account", outputPublic: true, timeout: 10 },
          { id: "data", title: "Fill data", action: "fill", element: "data-input", value: "{{data.account}}", timeout: 10 },
          { id: "attribute", title: "Capture element attribute", action: "assertVisible", element: "data-input", value: "", output: "elementTestId", outputSource: "attribute", outputAttribute: "data-testid", outputPublic: true, timeout: 10 },
          { id: "flow", title: "Reuse flow output", action: "fill", element: "flow-input", value: "{{flow.accountEcho}}", timeout: 10 },
          { id: "apply", title: "Apply values", action: "click", element: "apply", value: "", timeout: 10 },
          { id: "assert", title: "Assert values", action: "assertText", element: "result", value: "{{data.account}}|{{flow.accountEcho}}", timeout: 10 },
          { id: "response-page", title: "Open response fixture", action: "open", value: "/__fixture/response-output", timeout: 10 },
          { id: "response", title: "Capture response", action: "click", element: "fetch-output", value: "", output: "responseOrderId", outputSource: "response", responseUrl: "/__fixture/response-json", outputPath: "order.id", outputPublic: true, timeout: 10 },
        ],
      },
      environment: fixtureEnvironment,
      elements: [
        { id: "data-input", name: "data-input", method: "testid", value: "project-value" },
        { id: "flow-input", name: "flow-input", method: "testid", value: "environment-value" },
        { id: "apply", name: "apply", method: "testid", value: "apply" },
        { id: "result", name: "result", method: "testid", value: "result" },
        { id: "fetch-output", name: "fetch-output", method: "testid", value: "fetch-output" },
      ],
      datasetVersionId,
    }),
  });
  const parameterizedRevisionId = parameterizedRevision.body.revision?.id;
  if (!parameterizedRevisionId) throw new Error("Parameterized Agent revision creation failed");
  const parameterizedPublished = await api(`/api/platform/projects/${projectId}/revisions/${parameterizedRevisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!parameterizedPublished.response.ok) throw new Error("Parameterized Agent revision publish failed");
  const parameterizedRun = await api<{ runs: Array<{ id: string }> }>(`/api/platform/projects/${projectId}/runs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ revisionId: parameterizedRevisionId, environmentId: "fixture", datasetVersionId }),
  });
  const parameterizedRunId = parameterizedRun.body.runs[0]?.id;
  if (!parameterizedRun.response.ok || !parameterizedRunId || parameterizedRun.body.runs.length !== 1) throw new Error("Parameterized Agent run creation failed");
  const parameterizedComplete = await waitFor(async () => {
    const response = await api<{ run: { status: string; result?: Record<string, unknown>; events?: unknown[]; flowOutputs: Array<{ name: string; value: string }> } }>(`/api/platform/projects/${projectId}/runs/${parameterizedRunId}`, { headers: headers(token) });
    return ["success", "failed", "canceled"].includes(response.body.run.status) ? response.body.run : undefined;
  }, "parameterized Agent run");
  if (parameterizedComplete.status !== "success") throw new Error(`Parameterized Agent run failed: ${JSON.stringify({ result: parameterizedComplete.result, events: parameterizedComplete.events })}`);
  if (parameterizedComplete.flowOutputs.find((output) => output.name === "accountEcho")?.value !== "alice" || parameterizedComplete.flowOutputs.find((output) => output.name === "elementTestId")?.value !== "project-value" || parameterizedComplete.flowOutputs.find((output) => output.name === "responseOrderId")?.value !== "response-order-1") {
    throw new Error("Agent did not persist data and flow interpolation output");
  }

  const sauceRevision = await api<{ revision: { id: string } }>(`/api/platform/projects/${projectId}/revisions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow: {
        id: "sauce-demo-agent-flow",
        name: "Sauce Demo headed Agent flow",
        steps: [
          { id: "open", title: "Open Sauce Demo", action: "open", value: "/", timeout: 30 },
          { id: "username", title: "Fill username", action: "fill", element: "username", value: "standard_user", timeout: 15 },
          { id: "password", title: "Fill password", action: "fill", element: "password", value: "secret_sauce", timeout: 15 },
          { id: "login", title: "Log in", action: "click", element: "login", value: "", timeout: 15 },
          { id: "backpack", title: "Add backpack", action: "click", element: "backpack", value: "", timeout: 15 },
          { id: "cart", title: "Open cart", action: "click", element: "cart", value: "", timeout: 15 },
          { id: "checkout", title: "Checkout", action: "click", element: "checkout", value: "", timeout: 15 },
          { id: "first-name", title: "Fill first name", action: "fill", element: "first-name", value: "Auto", timeout: 15 },
          { id: "last-name", title: "Fill last name", action: "fill", element: "last-name", value: "Flow", timeout: 15 },
          { id: "postal-code", title: "Fill postal code", action: "fill", element: "postal-code", value: "100000", timeout: 15 },
          { id: "continue", title: "Continue checkout", action: "click", element: "continue", value: "", timeout: 15 },
          { id: "finish", title: "Finish order", action: "click", element: "finish", value: "", timeout: 15 },
          { id: "complete", title: "Assert completion", action: "assertText", element: "complete", value: "Thank you for your order!", timeout: 15 },
        ],
      },
      environment: sauceDemoEnvironment,
      elements: [
        { id: "username", name: "username", method: "testid", value: "username" },
        { id: "password", name: "password", method: "testid", value: "password" },
        { id: "login", name: "login", method: "testid", value: "login-button" },
        { id: "backpack", name: "backpack", method: "testid", value: "add-to-cart-sauce-labs-backpack" },
        { id: "cart", name: "cart", method: "testid", value: "shopping-cart-link" },
        { id: "checkout", name: "checkout", method: "testid", value: "checkout" },
        { id: "first-name", name: "first-name", method: "testid", value: "firstName" },
        { id: "last-name", name: "last-name", method: "testid", value: "lastName" },
        { id: "postal-code", name: "postal-code", method: "testid", value: "postalCode" },
        { id: "continue", name: "continue", method: "testid", value: "continue" },
        { id: "finish", name: "finish", method: "testid", value: "finish" },
        { id: "complete", name: "complete", method: "testid", value: "complete-header" },
      ],
    }),
  });
  const sauceRevisionId = sauceRevision.body.revision?.id;
  if (!sauceRevision.response.ok || !sauceRevisionId) throw new Error("Sauce Demo Agent revision creation failed");
  const saucePublished = await api(`/api/platform/projects/${projectId}/revisions/${sauceRevisionId}/publish`, { method: "POST", headers: headers(token) });
  if (!saucePublished.response.ok) throw new Error("Sauce Demo Agent revision publish failed");
  const sauceBinding = await api(`/api/platform/projects/${projectId}/agent-bindings`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ environmentId: "sauce-demo", agentId: registeredAgent.id }),
  });
  if (!sauceBinding.response.ok) throw new Error("Sauce Demo Agent binding failed");
  const sauceRun = await api<{ runIds: string[] }>(`/api/platform/projects/${projectId}/runs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ revisionId: sauceRevisionId, environmentId: "sauce-demo" }),
  });
  const sauceRunId = sauceRun.body.runIds[0];
  if (!sauceRun.response.ok || !sauceRunId) throw new Error("Sauce Demo Agent run creation failed");
  const sauceComplete = await waitFor(async () => {
    const response = await api<{ run: { status: string; result?: Record<string, unknown>; events?: unknown[] } }>(`/api/platform/projects/${projectId}/runs/${sauceRunId}`, { headers: headers(token) });
    return ["success", "failed", "canceled"].includes(response.body.run.status) ? response.body.run : undefined;
  }, "headed Sauce Demo Agent run", 400);
  if (sauceComplete.status !== "success") {
    throw new Error(`Headed Sauce Demo Agent run failed: ${JSON.stringify({ result: sauceComplete.result, events: sauceComplete.events, agentOutput })}`);
  }
  console.log("Debug and headed Sauce Demo Agent smoke test passed");
} finally {
  await stopAgent();
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}
