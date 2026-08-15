import { randomBytes } from "node:crypto";
import { removeWorkerRoot, startWorker, stopWorker, type TestWorker } from "./worker-test-utils";

/**
 * 回归：流程缺少「打开页面」步骤时的自动打开与友好报错。
 * - 第一步直接操作元素（无导航步骤）时，runner 应自动打开元素记录的页面，而不是在空白页上超时。
 * - 元素确实不存在时，报错应包含当前页面 URL 与修复提示（而非裸 locator timeout）。
 * 同时覆盖 managed 平台执行路径（runner-core）与本地 worker 执行路径（server/index.ts）。
 */

const managedPort = 8798;
let worker: TestWorker | undefined;
let root: string | undefined;

// 测试密钥仅用于加密临时工作目录的 SQLite 数据，运行结束后随临时目录销毁；
// 与仓库既有 smoke 一致，这里改为每次启动随机生成，避免在源码中保留静态密钥。
const smokeSecret = process.env.PLATFORM_SECRET_KEY ?? `auto-open-smoke-${randomBytes(8).toString("hex")}`;

async function api<T>(port: number, path: string, init: RequestInit = {}): Promise<{ response: Response; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: await response.json() as T };
}

function authenticated(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function waitForRun(token: string, port: number, projectId: string, runId: string, statuses: string[]) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await api<{ run: { status: string; result?: { error?: string; completedSteps?: number } } }>(port, `/api/platform/projects/${projectId}/runs/${runId}`, { headers: authenticated(token) });
    if (statuses.includes(response.body.run.status)) return response.body.run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed run ${runId} did not reach ${statuses.join(", ")}`);
}

async function waitForTask(port: number, path: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    if (response.ok) {
      const task = (await response.json()) as { status: string; result?: { error?: string; completedSteps?: number } };
      if (["success", "failed", "canceled"].includes(task.status)) return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Worker task timed out: ${path}`);
}

try {
  worker = await startWorker({ port: managedPort, env: { PLATFORM_SECRET_KEY: smokeSecret, MANAGED_RUNNER_HEADLESS: "1" } });
  root = worker.root;
  const baseUrl = `http://127.0.0.1:${managedPort}`;
  const environment = { id: "auto-open-env", name: "Auto open", description: "", baseUrl, browser: "Chromium", auth: "无认证", timeout: 5, headless: true, color: "teal", updatedAt: "now" };
  const loginElements = [
    { id: "submit", name: "登录按钮", description: "", path: "/__fixture/login", method: "testid", value: "login-submit", environment: environment.id, validation: "unverified", updatedAt: "now" },
    { id: "welcome", name: "欢迎信息", description: "", path: "/__fixture/login", method: "testid", value: "welcome", environment: environment.id, validation: "unverified", updatedAt: "now" },
    { id: "missing", name: "缺失元素", description: "", path: "/__fixture/login", method: "testid", value: "no-such-element", environment: environment.id, validation: "unverified", updatedAt: "now" },
  ];

  // ---- managed 平台路径 ----
  const registration = await api<{ token: string }>(managedPort, "/api/auth/register", { method: "POST", body: JSON.stringify({ email: "auto-open@example.test", name: "Auto open", password: "development-password" }) });
  const token = registration.body.token;
  const session = await api<{ workspaces: Array<{ id: string }> }>(managedPort, "/api/auth/session", { headers: authenticated(token) });
  const workspaceId = session.body.workspaces[0]?.id;
  const project = await api<{ project: { id: string } }>(managedPort, `/api/workspaces/${workspaceId}/projects`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ name: "Auto open smoke" }) });
  const projectId = project.body.project.id;
  const environmentResource = await api(managedPort, `/api/platform/projects/${projectId}/resources/environments`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ id: environment.id, data: environment }) });
  if (!environmentResource.response.ok) throw new Error("Managed environment setup failed");

  const autoOpenFlow = {
    id: "auto-open-flow",
    name: "自动打开流程",
    steps: [
      { id: "login", title: "登录", action: "点击", element: "登录按钮", value: "", timeout: 5, failurePolicy: "立即失败", status: "pending" as const },
      { id: "assert", title: "断言欢迎", action: "可见性断言", element: "欢迎信息", value: "", timeout: 5, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const autoOpenRevision = await api<{ revision: { id: string; status: string } }>(managedPort, `/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ flow: autoOpenFlow, environment, elements: loginElements }) });
  if (!autoOpenRevision.response.ok || autoOpenRevision.body.revision.status !== "published") throw new Error("Auto-open revision was not created as published");
  const autoOpenRun = await api<{ runIds: string[] }>(managedPort, `/api/platform/projects/${projectId}/runs`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ revisionId: autoOpenRevision.body.revision.id, environmentId: environment.id }) });
  const autoOpenResult = await waitForRun(token, managedPort, projectId, autoOpenRun.body.runIds[0], ["success", "failed"]);
  if (autoOpenResult.status !== "success" || autoOpenResult.result?.completedSteps !== 2) {
    throw new Error(`Managed auto-open run did not succeed without 打开页面 step: ${JSON.stringify(autoOpenResult)}`);
  }

  const missingFlow = {
    id: "missing-flow",
    name: "缺失元素流程",
    steps: [
      { id: "click", title: "点击缺失", action: "点击", element: "缺失元素", value: "", timeout: 3, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const missingRevision = await api<{ revision: { id: string; status: string } }>(managedPort, `/api/platform/projects/${projectId}/revisions`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ flow: missingFlow, environment, elements: loginElements }) });
  if (!missingRevision.response.ok || missingRevision.body.revision.status !== "published") throw new Error("Missing-element revision was not created as published");
  const missingRun = await api<{ runIds: string[] }>(managedPort, `/api/platform/projects/${projectId}/runs`, { method: "POST", headers: authenticated(token), body: JSON.stringify({ revisionId: missingRevision.body.revision.id, environmentId: environment.id }) });
  const missingResult = await waitForRun(token, managedPort, projectId, missingRun.body.runIds[0], ["success", "failed"]);
  const managedError = missingResult.result?.error ?? "";
  if (missingResult.status !== "failed" || !managedError.includes("当前页面") || !managedError.includes("/__fixture/login") || !managedError.includes("请确认流程已通过")) {
    throw new Error(`Managed missing-element error was not friendly: ${JSON.stringify(missingResult.result)}`);
  }

  // ---- 本地 worker 路径（与平台同一进程，使用同一端口）；headless: false 验证有头模式可配置 ----
  const workerEnvironment = { id: "fixture", name: "Worker fixture", description: "", baseUrl: `http://127.0.0.1:${managedPort}`, browser: "Chromium", auth: "无认证", timeout: 5, headless: false, color: "teal", updatedAt: "now" };
  const workerElements = [
    { ...loginElements[0], environment: "fixture" },
    { ...loginElements[1], environment: "fixture" },
    { ...loginElements[2], environment: "fixture" },
  ];
  const workerAutoOpenFlow = {
    id: "worker-auto-open",
    name: "Worker 自动打开",
    steps: [
      { id: "login", title: "登录", action: "点击", element: "登录按钮", value: "", timeout: 5, failurePolicy: "立即失败", status: "pending" as const },
      { id: "assert", title: "断言欢迎", action: "可见性断言", element: "欢迎信息", value: "", timeout: 5, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const workerRun = await api<{ runId: string }>(managedPort, "/api/projects/fixture-project/runs", { method: "POST", body: JSON.stringify({ environment: workerEnvironment, flow: workerAutoOpenFlow, elements: workerElements }) });
  const workerRunTask = await waitForTask(managedPort, `/api/projects/fixture-project/runs/${workerRun.body.runId}`);
  if (workerRunTask.status !== "success" || workerRunTask.result?.completedSteps !== 2) {
    throw new Error(`Worker auto-open run did not succeed without 打开页面 step: ${JSON.stringify(workerRunTask)}`);
  }

  const workerMissingFlow = {
    id: "worker-missing",
    name: "Worker 缺失元素",
    steps: [
      { id: "click", title: "点击缺失", action: "点击", element: "缺失元素", value: "", timeout: 3, failurePolicy: "立即失败", status: "pending" as const },
    ],
  };
  const workerMissingRun = await api<{ runId: string }>(managedPort, "/api/projects/fixture-project/runs", { method: "POST", body: JSON.stringify({ environment: workerEnvironment, flow: workerMissingFlow, elements: workerElements }) });
  const workerMissingTask = await waitForTask(managedPort, `/api/projects/fixture-project/runs/${workerMissingRun.body.runId}`);
  const workerError = workerMissingTask.result?.error ?? "";
  if (workerMissingTask.status !== "failed" || !workerError.includes("当前页面") || !workerError.includes("/__fixture/login") || !workerError.includes("请确认流程已通过")) {
    throw new Error(`Worker missing-element error was not friendly: ${JSON.stringify(workerMissingTask.result)}`);
  }

  console.log("Auto-open smoke test passed (managed + worker, success and friendly error)");
} finally {
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}
