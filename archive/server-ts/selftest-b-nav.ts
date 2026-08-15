import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { startWorker, stopWorker, type TestWorker } from "./worker-test-utils.ts";

const screenshotDir = join("docs", "自测截图");
const logFile = join("server", "selftest-b-log.txt");
const log = (msg: string) => { console.log(msg); appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); };
const platformPort = 8787;
const frontendPort = 4173;
let worker: TestWorker | undefined;
let frontend: ReturnType<typeof spawn> | undefined;
let browser: Browser | undefined;
let root: string | undefined;

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${platformPort}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: (await response.json()) as T };
}
async function waitFor<T>(read: () => Promise<T | undefined>, label: string, attempts = 200, interval = 300) {
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
  appendFileSync(logFile, `\n===== B NAV SELF-TEST ${new Date().toISOString()} =====\n`);
  worker = await startWorker({ port: platformPort });
  root = worker.root;
  frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_WORKER_API_URL: `http://127.0.0.1:${platformPort}/api` },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${frontendPort}/projects`)).ok ? true : undefined; } catch { return undefined; } }, "vite");

  const reg = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ email: "b-nav@example.test", name: "BNav", password: "bnav-password" }) });
  const token = (reg.body as { token: string }).token;
  const session = await api<{ workspaces: Array<{ id: string }> }>("/api/auth/session", { headers: { authorization: `Bearer ${token}` } });
  const workspaceId = session.body.workspaces[0].id;
  const localId = "self";
  const importResult = await api<{ projects: Array<{ sourceProjectId: string; projectId: string }> }>(`/api/workspaces/${workspaceId}/imports/local-storage`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: `project-${localId}`, data: { projects: [{ id: localId, name: "平台模式自测项目", description: "" }], flowsByProject: { [localId]: [] }, elementsByProject: { [localId]: [] }, variablesByProject: { [localId]: [] }, environmentsByProject: { [localId]: [] }, activeEnvironmentByProject: { [localId]: "" }, membersByProject: { [localId]: [] } } }),
  });
  const platformId = importResult.body.projects[0]?.projectId;
  log("platformId=" + platformId);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(({ token, workspaceId, localId, platformId }) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify({ token, user: { id: "u-bnav", email: "b-nav@example.test", name: "BNav" }, workspaces: [{ id: workspaceId, name: "Workspace", role: "owner" }] }));
    localStorage.setItem("autoflow-platform-workspace", JSON.stringify(workspaceId));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ [workspaceId]: { [localId]: platformId } }));
    if (!localStorage.getItem("autoflow-workspace-projects")) {
      localStorage.setItem("autoflow-workspace-projects", JSON.stringify({ version: 7, state: {
        projects: [{ id: localId, name: "平台模式自测项目", description: "" }],
        flowsByProject: { [localId]: [] }, elementsByProject: { [localId]: [] }, variablesByProject: { [localId]: [] }, environmentsByProject: { [localId]: [] }, activeEnvironmentByProject: { [localId]: "" }, membersByProject: { [localId]: [] },
        projectModesById: { [localId]: "platform-enabled" }, platformProjectIdsById: { [localId]: platformId }, platformSyncStatusById: { [localId]: "synced" }, platformSyncErrorById: {},
      } }));
    }
  }, { token, workspaceId, localId, platformId });
  await page.goto(`http://127.0.0.1:${frontendPort}/project/${localId}/overview`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await screenshot("B2-platform-enabled-nav.png");
  log("overview loaded: " + page.url());

  await page.goto(`http://127.0.0.1:${frontendPort}/project/${localId}/platform`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await screenshot("B3-platform-page-tabs-dev.png");
  const tabs = (await page.locator(".ant-tabs-tab").allInnerTexts()).map((t) => t.trim());
  log("PLATFORM PAGE TABS (dev): " + JSON.stringify(tabs));
  log("B NAV SELF-TEST PASSED");
} catch (error) {
  log("B NAV SELF-TEST FAILED: " + String(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stopProcess(frontend);
  if (worker) await stopWorker(worker);
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  log("finally done");
}