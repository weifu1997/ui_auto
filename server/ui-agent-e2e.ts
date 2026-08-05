import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { removeWorkerRoot, startWorker, stopWorker, type TestWorker } from "./worker-test-utils.ts";

let worker: TestWorker | undefined;
let frontend: ReturnType<typeof spawn> | undefined;
let agent: ReturnType<typeof spawn> | undefined;
let browser: Browser | undefined;
let peerContext: BrowserContext | undefined;
let root: string | undefined;
let frontendOutput = "";
let agentOutput = "";

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Unable to reserve a local test port"));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, diagnostics: () => string, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}\n\n${diagnostics()}`);
}

async function isVisible(locator: Locator) {
  return locator.isVisible().catch(() => false);
}

async function waitForFrontend(port: number) {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/projects`);
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "Vite UI",
    () => `Vite output:\n${frontendOutput || "(no stdout/stderr received)"}`,
  );
}

async function stopProcess(childProcess: ReturnType<typeof spawn> | undefined) {
  if (!childProcess || childProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await once(killer, "exit").catch(() => undefined);
    return;
  }
  childProcess.kill();
  await once(childProcess, "exit").catch(() => undefined);
}

async function chooseFirstOption(page: Page, select: Locator) {
  await select.click();
  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").last();
  await dropdown.locator(".ant-select-item-option").first().click();
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

try {
  const platformPort = await availablePort();
  const frontendPort = await availablePort();
  worker = await startWorker({ port: platformPort });
  root = worker.root;

  frontend = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"],
    {
      cwd: process.cwd(),
      env: { ...process.env, VITE_WORKER_API_URL: `http://127.0.0.1:${platformPort}/api` },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  frontend.stdout?.on("data", (chunk: Buffer | string) => {
    frontendOutput += chunk.toString();
  });
  frontend.stderr?.on("data", (chunk: Buffer | string) => {
    frontendOutput += chunk.toString();
  });
  await waitForFrontend(frontendPort);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${frontendPort}/project/sauce-demo/agents`);

  const loginPanel = page.locator(".platform-login-panel");
  await loginPanel.locator("input").nth(0).fill("ui-agent-e2e@example.test");
  await loginPanel.locator("input").nth(1).fill("ui-agent-e2e-password");
  await loginPanel.locator("button").last().click();
  await page.locator(".agent-toolbar").waitFor({ timeout: 15_000 });

  const agentToolbar = page.locator(".agent-toolbar");
  await agentToolbar.locator("button").last().click();
  const registration = await page.locator(".ant-modal-wrap:visible textarea").inputValue();
  const registrationToken = registration.split(/\r?\n/, 1)[0];
  assert(registrationToken?.startsWith("agt_"), "The UI did not create an Agent registration token");
  await page.locator(".ant-modal-wrap:visible .ant-modal-footer button").last().click();

  agent = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "agent/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOFLOW_PLATFORM_URL: `http://127.0.0.1:${platformPort}`,
      AUTOFLOW_AGENT_REGISTRATION_TOKEN: registrationToken,
      AUTOFLOW_AGENT_NAME: "ui-agent-e2e",
      AUTOFLOW_AGENT_IDENTITY_PATH: join(root, "ui-agent.identity.json"),
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

  await page.locator(".platform-import-alert button").click();
  await waitFor(
    async () => page.evaluate(() => {
      const session = JSON.parse(localStorage.getItem("autoflow-platform-session") ?? "{}") as { workspaces?: Array<{ id?: string }> };
      const workspaceId = session.workspaces?.[0]?.id;
      const maps = JSON.parse(localStorage.getItem("autoflow-platform-project-map") ?? "{}") as Record<string, Record<string, string>>;
      return workspaceId && maps[workspaceId]?.["sauce-demo"] ? true : undefined;
    }),
    "platform project import",
    () => `Agent output:\n${agentOutput || "(no stdout/stderr received)"}`,
  );
  await page.reload();
  await page.locator(".agent-toolbar").waitFor({ timeout: 15_000 });

  await page.locator(".project-nav-item").nth(2).click();
  await page.getByRole("button", { name: "新建元素" }).click();
  const elementDrawer = page.locator(".ant-drawer-content-wrapper");
  await elementDrawer.getByLabel("元素名称").fill("ui-synchronized-element");
  await elementDrawer.getByLabel("所属页面路径").fill("/");
  await elementDrawer.getByLabel("定位值").fill("ui-synchronized-element");
  await elementDrawer.getByRole("button", { name: "保存", exact: true }).click();
  await waitFor(
    async () => page.evaluate(() => {
      const versions = JSON.parse(localStorage.getItem("autoflow-platform-document-versions") ?? "{}") as Record<string, Record<string, number>>;
      return Object.values(versions).some((workspace) => Object.values(workspace).some((version) => version >= 2))
        ? true
        : undefined;
    }),
    "platform document persistence",
    () => `Agent output:\n${agentOutput || "(no stdout/stderr received)"}`,
  );

  const peerStorage = await page.evaluate(() => ({
    session: localStorage.getItem("autoflow-platform-session"),
    workspace: localStorage.getItem("autoflow-platform-workspace"),
  }));
  const peerSession = peerStorage.session;
  const peerWorkspace = peerStorage.workspace;
  assert(peerSession && peerWorkspace, "The UI did not persist the platform session");
  peerContext = await browser.newContext();
  await peerContext.addInitScript((storage) => {
    localStorage.setItem("autoflow-platform-session", storage.session);
    localStorage.setItem("autoflow-platform-workspace", storage.workspace);
  }, { session: peerSession, workspace: peerWorkspace });
  const peerPage = await peerContext.newPage();
  await peerPage.goto(`http://127.0.0.1:${frontendPort}/projects`);
  await peerPage.locator(".project-cell").first().click();
  await peerPage.locator(".project-nav-item").nth(2).click();
  await peerPage.getByText("ui-synchronized-element", { exact: true }).first().waitFor({ timeout: 30_000 });
  await peerContext.close();
  peerContext = undefined;
  await page.goto(`http://127.0.0.1:${frontendPort}/project/sauce-demo/agents`);
  await page.locator(".agent-toolbar").waitFor({ timeout: 15_000 });

  await waitFor(
    async () => {
      await agentToolbar.locator("button").first().click();
      return await isVisible(page.getByText("ui-agent-e2e", { exact: true })) ? true : undefined;
    },
    "online Agent displayed by the UI",
    () => `Agent output:\n${agentOutput || "(no stdout/stderr received)"}`,
  );

  const bindingSection = page.locator(".agent-binding-section").first();
  await bindingSection.locator(":scope > button").click();
  const bindingModal = page.locator(".ant-modal-wrap:visible");
  await chooseFirstOption(page, bindingModal.locator(".ant-select").nth(0));
  await chooseFirstOption(page, bindingModal.locator(".ant-select").nth(1));
  await bindingModal.locator(".ant-modal-footer button.ant-btn-primary").click();
  await bindingModal.waitFor({ state: "detached", timeout: 15_000 });

  const revisionSection = page.locator(".agent-binding-section").nth(1);
  await revisionSection.locator(":scope > button").click();
  const releaseModal = page.locator(".ant-modal-wrap:visible");
  await releaseModal.locator(".ant-modal-footer button.ant-btn-primary").click();
  await releaseModal.waitFor({ state: "detached", timeout: 20_000 });
  await waitFor(
    async () => (await revisionSection.locator("tbody tr").count()) > 0 ? true : undefined,
    "published revision displayed by the UI",
    () => `Agent output:\n${agentOutput || "(no stdout/stderr received)"}`,
  );

  await page.locator(".project-nav-item").nth(1).click();
  const flowRow = page.locator(".ant-table-tbody tr").first();
  await flowRow.locator("button").nth(1).click();
  await page.waitForURL(/\/project\/sauce-demo\/runs$/, { timeout: 20_000 });
  await page.getByText("13/13", { exact: true }).waitFor({ timeout: 150_000 });
  await page.locator(".run-link").first().click();
  await page.getByText("trace.zip", { exact: true }).waitFor({ timeout: 30_000 });
  console.log("True UI -> Platform -> headed Agent -> Sauce Demo gate passed");
} finally {
  await peerContext?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopProcess(agent);
  await stopProcess(frontend);
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}
