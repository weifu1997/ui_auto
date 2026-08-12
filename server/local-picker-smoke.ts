import { chromium } from "playwright";
import { removeWorkerRoot, startWorker, stopWorker, type TestWorker } from "./worker-test-utils.ts";

const port = 8794;
const cdpPort = 9364;
let worker: TestWorker | undefined;
let root: string | undefined;

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: (await response.json()) as T };
}
async function waitFor<T>(read: () => Promise<T | undefined>, label: string, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  worker = await startWorker({
    port,
    env: { WORKER_PICKER_HEADLESS: "1", WORKER_PICKER_REMOTE_DEBUG_PORT: String(cdpPort) },
  });
  root = worker.root;
  const projectId = "local-picker-fixture";
  const environment = {
    id: "fixture",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${port}`,
    browser: "Chromium",
    auth: "无认证",
    timeout: 15,
    testIdAttribute: "data-test",
    color: "teal",
    updatedAt: "now",
  };

  // 1) 本地采集会话：创建 + 导航起始 URL
  const created = await api<{ session: { id: string; currentUrl: string } }>(`/api/projects/${projectId}/local-picker/sessions`, {
    method: "POST",
    body: JSON.stringify({ environment, startUrl: "/__fixture/login" }),
  });
  const sessionId = created.body.session?.id;
  if (!created.response.ok || !sessionId) throw new Error(`local picker session creation failed: ${JSON.stringify(created.body)}`);
  await waitFor(async () => {
    const list = await api<{ sessions: Array<{ id: string; currentUrl: string }> }>(`/api/projects/${projectId}/local-picker/sessions`);
    const session = list.body.sessions.find((item) => item.id === sessionId);
    return session?.currentUrl?.includes("/__fixture/login") ? session : undefined;
  }, "local picker session navigated to start URL");

  // 2) 启用选取 -> CDP 模拟点击 -> 轮询候选
  const enabled = await api(`/api/projects/${projectId}/local-picker/sessions/${sessionId}/picker/enable`, { method: "POST" });
  if (!enabled.response.ok) throw new Error("local picker enable failed");
  const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  try {
    const pages = cdpBrowser.contexts().flatMap((context) => context.pages());
    const page = pages.find((item) => item.url().includes("/__fixture/login"));
    if (!page) throw new Error("local picker page not reachable over CDP");
    await page.click("[data-testid=login-submit]", { timeout: 5_000 });
    const capture = await waitFor(async () => {
      const response = await api<{ captures: Array<{ id: string; candidates: Array<{ method: string; value: string; count: number }> }> }>(`/api/projects/${projectId}/local-picker/sessions/${sessionId}/picker-captures`);
      const item = response.body.captures[0];
      return item?.candidates.some((candidate) => candidate.method === "testid" && candidate.value === "login-submit") ? item : undefined;
    }, "local picker candidates");
    // 3) 预览高亮
    const preview = await api(`/api/projects/${projectId}/local-picker/sessions/${sessionId}/picker-captures/${capture.id}/preview`, {
      method: "POST",
      body: JSON.stringify({ candidateIndex: 0 }),
    });
    if (!preview.response.ok) throw new Error("local picker preview failed");
    // 4) 仅回填不落库确认
    const confirmed = await api<{ target: string; candidate: { method: string; value: string }; path: string; environmentId: string; suggestedName: string }>(`/api/projects/${projectId}/local-picker/sessions/${sessionId}/picker-captures/${capture.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ candidateIndex: 0, name: "login submit" }),
    });
    if (!confirmed.response.ok || confirmed.body.target !== "fillback" || confirmed.body.candidate.value !== "login-submit" || confirmed.body.environmentId !== "fixture") {
      throw new Error(`local picker confirm failed: ${JSON.stringify(confirmed.body)}`);
    }
    // 5) 截图可用（等待首个定时截图生成）
    await waitFor(async () => {
      const list = await api<{ sessions: Array<{ id: string; hasScreenshot: boolean }> }>(`/api/projects/${projectId}/local-picker/sessions`);
      return list.body.sessions.find((item) => item.id === sessionId)?.hasScreenshot ? true : undefined;
    }, "local picker first screenshot", 60);
    const screenshot = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/local-picker/sessions/${sessionId}/screenshot`);
    if (!screenshot.ok || (screenshot.headers.get("content-type") ?? "").indexOf("image/png") < 0) {
      throw new Error("local picker screenshot unavailable");
    }
  } finally {
    await cdpBrowser.close().catch(() => undefined);
  }
  // 6) 结束会话
  const stopped = await api(`/api/projects/${projectId}/local-picker/sessions/${sessionId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command: "stop" }),
  });
  if (!stopped.response.ok) throw new Error("local picker stop failed");
  const afterStop = await api<{ sessions: Array<{ id: string }> }>(`/api/projects/${projectId}/local-picker/sessions`);
  if (afterStop.body.sessions.some((item) => item.id === sessionId)) throw new Error("local picker session not removed after stop");
  console.log("Local picker smoke test passed");
} finally {
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}