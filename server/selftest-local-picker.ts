import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { startWorker, stopWorker, type TestWorker } from "./worker-test-utils.ts";

const screenshotDir = join("docs", "自测截图");
const logFile = join("server", "selftest-local-log.txt");
const log = (msg: string) => { console.log(msg); appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); };

const platformPort = 8787;
const frontendPort = 4173;
const cdpPort = 9365;
let worker: TestWorker | undefined;
let frontend: ReturnType<typeof spawn> | undefined;
let browser: Browser | undefined;
let cdpBrowser: Browser | undefined;
let root: string | undefined;

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${platformPort}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: (await response.json()) as T };
}
async function waitFor<T>(read: () => Promise<T | undefined>, label: string, attempts = 240, interval = 400) {
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
async function screenshot(name: string) {
  await browser!.contexts()[0].pages()[0].screenshot({ path: join(screenshotDir, name) });
}

try {
  appendFileSync(logFile, `\n===== LOCAL PICKER SELF-TEST ${new Date().toISOString()} =====\n`);
  // 本机 Worker：有头浏览器（WORKER_PICKER_HEADLESS 不设置）+ CDP 端口供模拟点击
  worker = await startWorker({ port: platformPort, env: { WORKER_PICKER_REMOTE_DEBUG_PORT: String(cdpPort) } });
  root = worker.root;

  frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_WORKER_API_URL: `http://127.0.0.1:${platformPort}/api` },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${frontendPort}/projects`)).ok ? true : undefined; } catch { return undefined; } }, "vite");

  // 未连接平台：全新本地工作空间（无平台会话/无项目映射，local 模式）
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    localStorage.removeItem("autoflow-platform-session");
    localStorage.removeItem("autoflow-platform-project-map");
    if (localStorage.getItem("autoflow-workspace-projects")) return;
    localStorage.setItem("autoflow-workspace-projects", JSON.stringify({
      version: 7,
      state: {
        projects: [{ id: "self", name: "本地采集自测项目", description: "" }],
        flowsByProject: { self: [] },
        elementsByProject: { self: [] },
        variablesByProject: { self: [] },
        environmentsByProject: { self: [] },
        activeEnvironmentByProject: { self: "" },
        membersByProject: { self: [] },
        projectModesById: { self: "local" },
        platformProjectIdsById: {},
        platformSyncStatusById: {},
        platformSyncErrorById: {},
      },
    }));
  });
  await page.goto(`http://127.0.0.1:${frontendPort}/project/self/environments`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  log("local mode frontend loaded: " + page.url());

  // 创建环境（baseUrl 指向公开站点）
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.locator(".ant-drawer-content-wrapper").waitFor({ timeout: 10000 });
  await page.locator(".ant-drawer-content-wrapper").getByLabel("环境名称").fill("本地采集环境");
  await page.locator(".ant-drawer-content-wrapper").getByLabel("基础地址").fill("https://huang1997.cloud/");
  await page.locator(".ant-drawer-content-wrapper").getByRole("button", { name: "保存配置" }).click();
  await page.getByText("本地采集环境", { exact: true }).first().waitFor({ timeout: 10000 });
  await screenshot("L1-local-env-saved.png");

  // 元素库 -> 新建元素 -> 从页面获取（本地通道）
  await page.goto(`http://127.0.0.1:${frontendPort}/project/self/elements`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "新建元素" }).click();
  const drawer = page.locator(".ant-drawer-content-wrapper");
  await drawer.waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /从页面获取/ }).click();
  await page.waitForTimeout(2500);
  const healthFromBrowser = await page.evaluate(async () => {
    try { const r = await fetch("http://127.0.0.1:8787/health"); return "status:" + r.status; } catch (e) { return "ERR:" + (e instanceof Error ? e.message : String(e)); }
  });
  log("BROWSER HEALTH: " + healthFromBrowser);
  const panelHtml = await page.locator(".element-picker-panel").first().innerHTML().catch(() => "(no panel)");
  log("PANEL HTML: " + panelHtml.slice(0, 300));
  log("MODALS: " + (await page.locator(".ant-modal-wrap").count()) + " visible: " + (await page.locator(".ant-modal-wrap:visible").count()));
  log("MODAL TEXTS: " + JSON.stringify((await page.locator(".ant-modal-wrap").allInnerTexts()).map((t) => t.slice(0, 120))));
  log("MESSAGES: " + JSON.stringify((await page.locator(".ant-message-notice").allInnerTexts()).map((t) => t.slice(0, 120))));
  await screenshot("L2b-after-click.png");
  const modal = page.locator(".ant-modal-wrap:visible");
  await modal.waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  await screenshot("L2-local-picker-modal.png");
  log("local picker modal opened; modal text: " + JSON.stringify((await modal.innerText()).slice(0, 200)));

  // 等待本地会话自动创建并导航到站点（附带诊断）
  for (let i = 0; i < 10; i += 1) {
    const list = await api<{ sessions: Array<{ id: string; currentUrl: string }> }>("/api/projects/self/local-picker/sessions");
    log("SESSIONS POLL: " + JSON.stringify(list.body.sessions.map((s) => ({ id: s.id.slice(0, 8), url: s.currentUrl }))));
    log("MODAL TEXT: " + JSON.stringify((await modal.innerText()).slice(0, 200)));
    await new Promise((r) => setTimeout(r, 2000));
  }
  const session = await waitFor(async () => {
    const list = await api<{ sessions: Array<{ id: string; currentUrl: string }> }>("/api/projects/self/local-picker/sessions");
    return list.body.sessions.find((item) => (item.currentUrl ?? "").includes("huang1997.cloud"));
  }, "local session on huang1997.cloud");
  log("local session created: " + session.id + " url=" + session.currentUrl);
  await screenshot("L3-local-browser-open.png");

  // 启用选取（API）+ CDP 点击「登录」链接 -> 候选
  await api(`/api/projects/self/local-picker/sessions/${session.id}/picker/enable`, { method: "POST" });
  cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = cdpBrowser.contexts().flatMap((c) => c.pages());
  const debugPage = pages.find((p) => p.url().includes("huang1997.cloud"));
  if (!debugPage) throw new Error("local picker page not reachable over CDP");
  await debugPage.waitForTimeout(2000);
  const loginLink = debugPage.locator("a", { hasText: "登录" }).first();
  if (await loginLink.isVisible().catch(() => false)) {
    log("LOCAL PICKER CLICK: 登录链接");
    await loginLink.click({ timeout: 5000 }).catch(() => undefined);
  } else {
    const interactive = await debugPage.locator("button, a").all();
    for (const el of interactive) {
      if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 5000 }).catch(() => undefined); break; }
    }
  }
  const capture = await waitFor(async () => {
    const r = await api<{ captures: Array<{ id: string; candidates: Array<{ method: string; value: string; count: number; score: number }> }> }>(`/api/projects/self/local-picker/sessions/${session.id}/picker-captures`);
    return r.body.captures[0];
  }, "local picker candidates");
  log("LOCAL CANDIDATES: " + JSON.stringify(capture.candidates.slice(0, 4)));
  await screenshot("L4-local-candidates.png");

  // UI 中确认候选 -> 回填表单
  const confirmButton = modal.locator(".picker-candidate-row").first().locator("button.ant-btn-primary");
  await confirmButton.first().click({ timeout: 10000 });
  await page.waitForTimeout(800);
  await screenshot("L5-local-drawer-filled.png");
  const value = await drawer.getByLabel("定位值").inputValue().catch(() => "");
  const path = await drawer.getByLabel("所属页面路径").inputValue().catch(() => "");
  log("FILLED value=" + value + " path=" + path);
  await drawer.getByLabel("元素名称").fill("首页登录链接（本地采集）");
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("首页登录链接（本地采集）", { exact: true }).waitFor({ timeout: 10000 });
  await screenshot("L6-local-element-saved.png");
  log("LOCAL ELEMENT SAVED");

  // B：local 模式导航截图（侧边栏 + 平台入口=执行节点页）
  await page.goto(`http://127.0.0.1:${frontendPort}/project/self/overview`);
  await page.waitForTimeout(1500);
  await screenshot("B1-local-nav.png");

  log("LOCAL PICKER SELF-TEST PASSED");
} catch (error) {
  log("LOCAL PICKER SELF-TEST FAILED: " + String(error));
  if (error instanceof Error && error.stack) log("STACK: " + error.stack.split("\n").slice(0, 6).join(" | "));
  process.exitCode = 1;
} finally {
  await cdpBrowser?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopProcess(frontend);
  if (worker) await stopWorker(worker);
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  log("finally done");
}