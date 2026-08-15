import { chromium } from "playwright";
import { resolve } from "node:path";
import { removeWorkerRoot, startWorker, stopWorker, type TestWorker } from "./worker-test-utils";

const port = 8798;
let worker: TestWorker | undefined;
let root: string | undefined;

try {
  worker = await startWorker({ port, env: { NODE_ENV: "production", PLATFORM_SECRET_KEY: "production-ui-smoke-secret", AUTOFLOW_STATIC_DIRECTORY: resolve("dist"), MANAGED_RUNNER_HEADLESS: "1" } });
  root = worker.root;
  const registration = await fetch(`http://127.0.0.1:${port}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "production@example.test", name: "Production Admin", password: "development-password" }) });
  if (!registration.ok) throw new Error("Production smoke account registration failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    const navigation = await page.goto(`http://127.0.0.1:${port}/projects`);
    await page.waitForTimeout(2_000);
    if (await page.getByRole("heading", { name: "登录工作台" }).count() === 0) {
      throw new Error(`Production login did not render (HTTP ${navigation?.status()}): ${errors.join(" | ")} BODY=${(await page.locator("body").innerText()).slice(0, 500)}`);
    }
    errors.length = 0;
    await page.getByLabel("邮箱").fill("production@example.test");
    await page.getByLabel("密码").fill("development-password");
    await page.locator('button[type="submit"]').click();
    await page.getByRole("heading", { name: "测试项目" }).waitFor();
    if (/\b(?:Worker|Agent)\b/i.test(await page.locator("body").innerText())) throw new Error("Production UI exposes development execution terminology");
    const screenshotBase = process.env.PRODUCTION_SCREENSHOT_PATH;
    if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("heading", { name: "测试项目" }).waitFor();
    if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-mobile.png`, fullPage: true });
    const bodyBox = await page.locator("body").boundingBox();
    if (!bodyBox || bodyBox.width < 300 || bodyBox.height < 500) throw new Error("Production UI rendered blank or collapsed");
    const emptyBox = await page.locator(".project-table .ant-empty").boundingBox();
    if (!emptyBox || emptyBox.x < 0 || emptyBox.x + emptyBox.width > 390) throw new Error("Mobile project empty state is clipped outside the viewport");
    if (errors.length > 0) throw new Error(`Production UI emitted browser errors: ${errors.join(" | ")}`);
  } finally {
    await browser.close();
  }
  console.log("Production UI smoke test passed");
} finally {
  if (worker) await stopWorker(worker);
  if (root) await removeWorkerRoot(root);
}
