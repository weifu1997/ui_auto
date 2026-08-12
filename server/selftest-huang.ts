import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startWorker, stopWorker, type TestWorker } from "./worker-test-utils.ts";

const screenshotDir = join("docs", "自测截图");
const logFile = join("server", "selftest-log.txt");
const log = (msg: string) => { console.log(msg); appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); };

const cdpPort = 9363;
const platformPort = 8787;
const frontendPort = 4173;
let worker: TestWorker | undefined;
let frontend: ReturnType<typeof spawn> | undefined;
let agent: ReturnType<typeof spawn> | undefined;
let browser: Browser | undefined;
let cdpBrowser: Browser | undefined;
let root: string | undefined;
let token = "";
let workspaceId = "";
let platformId = "";
let sessionId = "";
let environmentId = "";

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${platformPort}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: (await response.json()) as T };
}
const authHeaders = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
async function waitFor<T>(read: () => Promise<T | undefined>, label: string, attempts = 240, interval = 250) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function stopProcess(child: ReturnType<typeof spawn> | undefined) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await once(killer, "exit").catch(() => undefined);
    return;
  }
  child.kill();
  await once(child, "exit").catch(() => undefined);
}
async function debugPage(): Promise<Page> {
  const pages = cdpBrowser!.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => p.url().includes("huang1997.cloud"));
  if (!page) throw new Error("debug browser page not found");
  return page;
}
async function screenshot(name: string) {
  const context = browser!.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await page.screenshot({ path: join(screenshotDir, name) });
}

try {
  appendFileSync(logFile, `\n===== SELF-TEST START ${new Date().toISOString()} =====\n`);
  worker = await startWorker({ port: platformPort, env: { AUTOFLOW_EXECUTOR_TYPE: "agent" } });
  root = worker.root;

  frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_WORKER_API_URL: `http://127.0.0.1:${platformPort}/api` },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${frontendPort}/projects`)).ok ? true : undefined; } catch { return undefined; } }, "vite");

  // 平台账号 + 项目导入（source_project_id = self）
  const reg = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ email: "huang-selftest@example.test", name: "自测用户", password: "selftest-password" }) });
  token = (reg.body as { token: string }).token;
  const session = await api<{ workspaces: Array<{ id: string }> }>("/api/auth/session", { headers: authHeaders() });
  workspaceId = session.body.workspaces[0].id;
  const localId = "self";
  const importResult = await api<{ projects: Array<{ sourceProjectId: string; projectId: string }> }>(`/api/workspaces/${workspaceId}/imports/local-storage`, {
    method: "POST", headers: authHeaders(),
    body: JSON.stringify({ sourceId: `project-${localId}`, data: { projects: [{ id: localId, name: "Sub2API 自测项目", description: "" }], flowsByProject: { [localId]: [] }, elementsByProject: { [localId]: [] }, variablesByProject: { [localId]: [] }, environmentsByProject: { [localId]: [] }, activeEnvironmentByProject: { [localId]: "" }, membersByProject: { [localId]: [] } } }),
  });
  platformId = importResult.body.projects[0]?.projectId;
  if (!platformId) throw new Error("platform import failed");
  log("platformId=" + platformId);

  // 前端浏览器：注入会话/项目映射/本地项目
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(({ token, workspaceId, localId, platformId }) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify({ token, user: { id: "u-selftest", email: "huang-selftest@example.test", name: "自测用户" }, workspaces: [{ id: workspaceId, name: "默认工作空间", role: "owner" }] }));
    localStorage.setItem("autoflow-platform-workspace", JSON.stringify(workspaceId));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ [workspaceId]: { [localId]: platformId } }));
    if (!localStorage.getItem("autoflow-workspace-projects")) {
      localStorage.setItem("autoflow-workspace-projects", JSON.stringify({
        version: 7,
        state: {
          projects: [{ id: localId, name: "Sub2API 自测项目", description: "" }],
          flowsByProject: { [localId]: [] },
          elementsByProject: { [localId]: [] },
          variablesByProject: { [localId]: [] },
          environmentsByProject: { [localId]: [] },
          activeEnvironmentByProject: { [localId]: "" },
          membersByProject: { [localId]: [] },
          projectModesById: { [localId]: "platform-enabled" },
          platformProjectIdsById: { [localId]: platformId },
          platformSyncStatusById: { [localId]: "synced" },
          platformSyncErrorById: {},
        },
      }));
    }
  }, { token, workspaceId, localId, platformId });
  await page.goto(`http://127.0.0.1:${frontendPort}/project/${localId}/environments`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  log("frontend loaded at " + page.url());

  // ---- 环境表单自测：下拉选择 + 手动输入 ----
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.locator(".ant-drawer-content-wrapper").waitFor({ timeout: 10000 });
  const envNameInput = page.locator(".ant-drawer-content-wrapper").getByLabel("环境名称");
  await envNameInput.click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { hasText: "正式环境" }).first().waitFor({ timeout: 5000 });
  await screenshot("04-env-form-dropdowns.png");
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { hasText: "测试环境" }).first().click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const attrInput = page.locator(".ant-drawer-content-wrapper").getByLabel("测试属性名");
  await attrInput.click();
  await page.waitForTimeout(400);
  // 清空默认值后展示全部可选测试属性
  await attrInput.fill("");
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { hasText: "data-cy" }).first().waitFor({ timeout: 5000 });
  await screenshot("05-env-attr-options.png");
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { hasText: "data-cy" }).first().click();
  await screenshot("05-env-form-selected.png");
  await page.locator(".ant-drawer-content-wrapper").getByLabel("基础地址").fill("https://huang1997.cloud/");
  await page.locator(".ant-drawer-content-wrapper").getByRole("button", { name: "保存配置" }).click();
  await page.getByText("测试环境", { exact: true }).first().waitFor({ timeout: 10000 });
  await screenshot("06-env-form-saved.png");
  // 诊断：页面内直接调用平台 API（验证 CORS/网络）
  const healthPage = await browser!.newPage();
  try { const resp = await healthPage.goto(`http://127.0.0.1:${platformPort}/health`, { timeout: 10000 }); log("HEALTH PAGE STATUS: " + resp?.status()); } catch (e) { log("HEALTH PAGE ERR: " + String(e)); }
  await healthPage.close();
  page.on("console", (msg) => { if (msg.type() === "error") log("PAGE CONSOLE: " + msg.text().slice(0, 200)); });
  const directFetch = await page.evaluate(async ({ platformPort, platformId, token }) => {
    try {
      const r = await fetch(`http://127.0.0.1:${platformPort}/api/platform/projects/${platformId}/document`, { headers: { authorization: `Bearer ${token}` } });
      return "status:" + r.status;
    } catch (e) {
      return "ERR:" + (e instanceof Error ? e.message : String(e));
    }
  }, { platformPort, platformId, token });
  log("DIRECT FETCH: " + directFetch);
  // 诊断：保存后的本地状态
  await page.waitForTimeout(2000);
  const diag = await page.evaluate(() => {
    try {
      const state = JSON.parse(localStorage.getItem("autoflow-workspace-projects") ?? "{}").state;
      return {
        mode: state.projectModesById,
        ids: state.platformProjectIdsById,
        sync: state.platformSyncStatusById,
        err: state.platformSyncErrorById,
        envs: state.environmentsByProject?.self?.map((e: { name: string; baseUrl: string }) => ({ name: e.name, baseUrl: e.baseUrl })),
        map: localStorage.getItem("autoflow-platform-project-map"),
        docVersion: localStorage.getItem("autoflow-platform-document-versions"),
      };
    } catch { return "no store"; }
  });
  log("DIAG: " + JSON.stringify(diag));
  // 读取保存后的环境 id（同步器 450ms 防抖 + 网络，轮询等待）
  const env = await waitFor(async () => {
    const doc = await api<{ data: { environments?: Array<{ id: string; name: string; baseUrl: string }> } }>(`/api/platform/projects/${platformId}/document`, { headers: authHeaders() });
    return doc.body.data.environments?.find((item) => item.name === "测试环境");
  }, "environment synced to platform");
  environmentId = env.id ?? "";
  if (!environmentId) throw new Error("environment not synced to platform");
  log("environmentId=" + environmentId);

  // ---- 执行节点：有头 Chromium + CDP ----
  const tokenRes = await api<{ registrationToken: string }>("/api/agent-tokens", { method: "POST", headers: authHeaders(), body: JSON.stringify({ workspaceId }) });
  agent = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "agent/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOFLOW_PLATFORM_URL: `http://127.0.0.1:${platformPort}`,
      AUTOFLOW_AGENT_REGISTRATION_TOKEN: tokenRes.body.registrationToken,
      AUTOFLOW_AGENT_NAME: "huang-selftest-agent",
      AUTOFLOW_AGENT_BROWSER_REMOTE_DEBUG_PORT: String(cdpPort),
      AUTOFLOW_AGENT_IDENTITY_PATH: join(root, "selftest.identity.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let agentOut = "";
  agent.stdout?.on("data", (buf: Buffer) => { agentOut += buf.toString(); });
  agent.stderr?.on("data", (buf: Buffer) => { agentOut += buf.toString(); });
  const registered = await waitFor(async () => {
    const r = await api<{ agents: Array<{ id: string; status: string }> }>(`/api/agents?workspaceId=${workspaceId}`, { headers: authHeaders() });
    return r.body.agents.find((a) => a.status === "online");
  }, "agent online");
  const binding = await api(`/api/platform/projects/${platformId}/agent-bindings`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ environmentId, agentId: registered.id }) });
  if (!binding.response.ok) throw new Error("agent binding failed");
  log("agent bound");

  // ---- 调试会话页：空白会话 ----
  await page.goto(`http://127.0.0.1:${frontendPort}/project/${localId}/debug`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "调试" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "新建调试会话" }).click();
  const modal = page.locator(".ant-modal-wrap:visible");
  await modal.waitFor({ timeout: 10000 });
  await page.waitForTimeout(1000);
  log("CREATE MODAL TEXT: " + JSON.stringify((await modal.innerText()).slice(0, 300)));
  await screenshot("07-debug-create-modal.png");
  // 关闭弹窗。采集面板会自动为当前环境复用/创建空白调试会话并打开站点（即「从页面获取」的浏览器）。
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await waitFor(async () => {
    const sessions = await api<{ sessions: Array<{ id: string; currentUrl: string | null }> }>(`/api/platform/projects/${platformId}/debug-sessions`, { headers: authHeaders() });
    return sessions.body.sessions.find((s) => (s.currentUrl ?? "").includes("huang1997.cloud"));
  }, "auto-created blank session on huang1997.cloud");
  const sessionsNow = await api<{ sessions: Array<{ id: string; currentUrl: string | null }> }>(`/api/platform/projects/${platformId}/debug-sessions`, { headers: authHeaders() });
  sessionId = sessionsNow.body.sessions.find((s) => (s.currentUrl ?? "").includes("huang1997.cloud"))?.id ?? "";
  if (!sessionId) throw new Error("no auto-created huang session");
  log("blank session auto-created via panel: " + sessionId);
  await waitFor(async () => {
    const img = page.locator("img.debug-screenshot").first();
    return (await img.count()) > 0 ? true : undefined;
  }, "debug screenshot in UI");
  await waitFor(async () => {
    const url = await page.evaluate(() => document.querySelector(".debug-session-meta dd")?.textContent ?? "");
    return url.includes("huang1997.cloud") ? true : undefined;
  }, "debug session opened huang1997.cloud", 120, 500).catch(() => undefined);
  await screenshot("08-debug-session-screenshot.png");



  // ---- 元素采集（公开首页）：启用选取 -> 点击「登录」链接 -> 候选 ----
  cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const dbg = await debugPage();
  await dbg.waitForTimeout(3000);
  await dbg.screenshot({ path: join(screenshotDir, "01-site-home.png") });
  await screenshot("09a-picker-home.png");
  await api(`/api/platform/projects/${platformId}/debug-sessions/${sessionId}/picker/enable`, { method: "POST", headers: authHeaders() });
  await dbg.waitForTimeout(800);
  const loginLink = dbg.locator("a", { hasText: "登录" }).first();
  if (await loginLink.isVisible().catch(() => false)) {
    log("PICKER CLICK: 登录链接");
    await loginLink.click({ timeout: 5000 }).catch(() => undefined);
  } else {
    const interactive = await dbg.locator("button, a").all();
    for (const el of interactive) {
      if (await el.isVisible().catch(() => false)) {
        log("PICKER CLICK: " + ((await el.textContent().catch(() => "")) ?? "").trim().slice(0, 40));
        await el.click({ timeout: 5000 }).catch(() => undefined);
        break;
      }
    }
  }
  const capture = await waitFor(async () => {
    const r = await api<{ captures: Array<{ id: string; candidates: Array<{ method: string; value: string; count: number; score: number }> }> }>(`/api/platform/projects/${platformId}/debug-sessions/${sessionId}/picker-captures`, { headers: authHeaders() });
    return r.body.captures[0];
  }, "picker candidates");
  log("CANDIDATES: " + JSON.stringify(capture.candidates.slice(0, 4)));
  await screenshot("09-picker-candidates.png");
  const fillback = await api<{ target: string; candidate: { method: string; value: string }; path: string; environmentId: string }>(`/api/platform/projects/${platformId}/debug-sessions/${sessionId}/picker-captures/${capture.id}/confirm`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ candidateIndex: 0, target: "fillback", name: "首页登录链接" }),
  });
  if (!fillback.response.ok || fillback.body.target !== "fillback") throw new Error("fillback failed");
  const docAfter = await api<{ data: { elements?: unknown[] } }>(`/api/platform/projects/${platformId}/document`, { headers: authHeaders() });
  log("FILLBACK candidate=" + JSON.stringify(fillback.body.candidate) + " elementCount=" + (Array.isArray(docAfter.body.data.elements) ? docAfter.body.data.elements.length : 0));

  // ---- 登录自测：test@qq.com / 123456 ----
  await dbg.goto("https://huang1997.cloud/login", { waitUntil: "domcontentloaded", timeout: 30000 });
  await dbg.waitForTimeout(3000);
  await dbg.screenshot({ path: join(screenshotDir, "02-login-page.png") });
  await dbg.fill("#email", "test@qq.com");
  await dbg.fill("#password", "123456");
  await dbg.click('button[type="submit"]');
  await waitFor(async () => (dbg.url().includes("/login") ? undefined : dbg.url()), "login navigation", 120, 500);
  await dbg.waitForTimeout(3000);
  await dbg.screenshot({ path: join(screenshotDir, "03-login-success.png") });
  log("login done, url=" + dbg.url());

  // ---- 元素抽屉「从页面获取」：回填 -> 命名保存 -> 验证 ----
  await page.goto(`http://127.0.0.1:${frontendPort}/project/${localId}/elements`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建元素" }).click();
  const drawer = page.locator(".ant-drawer-content-wrapper");
  await drawer.waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /从页面获取/ }).click();
  const pickerModal = page.locator(".ant-modal-wrap:visible");
  await pickerModal.waitFor({ timeout: 10000 });
  await screenshot("10-element-picker-modal.png");
  const confirmButton = pickerModal.locator(".picker-candidate-row").first().locator("button.ant-btn-primary");
  await confirmButton.first().click({ timeout: 15000 });
  await screenshot("11-element-drawer-filled.png");
  await drawer.getByLabel("元素名称").fill("首页登录链接");
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("首页登录链接", { exact: true }).waitFor({ timeout: 10000 });
  await screenshot("12-element-saved.png");
  // 结束调试会话，释放单并发执行节点，使元素验证可调度
  await api(`/api/platform/projects/${platformId}/debug-sessions/${sessionId}/commands`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ command: "stop" }) });
  await waitFor(async () => {
    const r = await api<{ session: { status: string } }>(`/api/platform/projects/${platformId}/debug-sessions/${sessionId}`, { headers: authHeaders() });
    return r.body.session.status === "ended" ? true : undefined;
  }, "debug session ended for validation");
  log("debug session ended, running element validation");
  // 通过平台验证接口运行元素验证（与 UI「验证元素」走同一服务端流程：创建 -> 轮询结果）
  const validationCreated = await api<{ validation: { id: string } }>(`/api/platform/projects/${platformId}/element-validations`, {
    method: "POST", headers: authHeaders(),
    body: JSON.stringify({ environmentId, element: { id: "home-login-link", name: "首页登录链接", path: "/", method: "text", value: "登录", environment: environmentId, validation: "unverified" } }),
  });
  const validationId = validationCreated.body.validation?.id;
  if (!validationCreated.response.ok || !validationId) throw new Error("validation creation failed: " + JSON.stringify(validationCreated.body));
  const validationResult = await waitFor(async () => {
    const r = await api<{ validation: { status: string; result?: { count?: number }; error?: string } }>(`/api/platform/projects/${platformId}/element-validations/${validationId}`, { headers: authHeaders() });
    return ["success", "failed", "canceled"].includes(r.body.validation.status) ? r.body.validation : undefined;
  }, "element validation via API", 240, 500);
  log("VALIDATION API RESULT: " + JSON.stringify({ status: validationResult.status, count: validationResult.result?.count, error: validationResult.error }));
  await page.reload();
  await page.getByText("首页登录链接", { exact: true }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(2000);
  await screenshot("13-element-validation.png");
  const validated = validationResult.status === "success" ? (validationResult.result?.count === 1 ? "unique" : validationResult.result?.count && validationResult.result.count > 1 ? "multiple" : "not-found") : "failed";
  log("validation: " + validated);

  log("SELF-TEST PASSED");
} catch (error) {
  log("SELF-TEST FAILED: " + String(error));
  if (error instanceof Error && error.stack) log("STACK: " + error.stack.split("\n").slice(0, 6).join(" | "));
  process.exitCode = 1;
} finally {
  await cdpBrowser?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopProcess(agent);
  await stopProcess(frontend);
  if (worker) await stopWorker(worker);
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  log("finally done");
}