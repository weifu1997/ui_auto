import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

// 内网部署验证（生产形态）：网页编排 → 部署机执行 → 定时回归 → 飞书通知
// 前置：生产模式服务已启动（0.0.0.0 + NODE_ENV=production + PLATFORM_SECRET_KEY + 静态托管 dist/）
// 用法：AUTOFLOW_DEPLOY_BASE_URL=http://192.168.3.18:8788 AUTOFLOW_FEISHU_WEBHOOK_URL=<飞书 webhook> npx tsx server/selftest-deploy-verify.ts

const base = process.env.AUTOFLOW_DEPLOY_BASE_URL ?? "http://192.168.3.18:8788";
const apiBase = `${base}/api`;
const feishuUrl = process.env.AUTOFLOW_FEISHU_WEBHOOK_URL ?? "";
const email = process.env.AUTOFLOW_DEPLOY_EMAIL ?? `deploy-verify-${Date.now()}@example.test`;
const password = process.env.AUTOFLOW_DEPLOY_PASSWORD ?? "DeployVerify#2026";
const runToken = Date.now().toString(36).slice(-4);
const projectName = `内网部署验证项目-${runToken}`;
const screenshotDir = join("docs", "自测截图", "内网部署验证");
const logFile = join("server", "selftest-deploy-verify-log.txt");

mkdirSync(screenshotDir, { recursive: true });
const log = (msg: string) => {
  console.log(msg);
  appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
};
const waitFor = async <T>(read: () => Promise<T | undefined>, label: string, attempts = 300, interval = 500) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
async function api(request: APIRequestContext, method: "GET" | "POST" | "PUT" | "DELETE", path: string, data?: unknown): Promise<any> {
  const response = await request[method.toLowerCase() as "get" | "post" | "put" | "delete"](`${apiBase}${path}`, { data });
  let body: any = null;
  try { body = await response.json(); } catch { /* 无响应体 */ }
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}
const listOf = (body: any, key: string) => body?.[key] ?? [];

let browser: Browser | undefined;

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: join(screenshotDir, name) });
  log(`screenshot: ${name}`);
}

try {
  appendFileSync(logFile, `\n===== DEPLOY VERIFY ${new Date().toISOString()} =====\n`);
  log(`target: ${base} | email: ${email} | feishu: ${feishuUrl ? "configured" : "SKIPPED (AUTOFLOW_FEISHU_WEBHOOK_URL 未设置)"}`);

  // ---- 0. 服务守卫（模拟另一台内网机器的原始 HTTP 请求）----
  const health = await (await fetch(`${base}/health`)).json();
  const ready = await (await fetch(`${base}/ready`)).json();
  if (!health.ok || !ready.ok) throw new Error(`health/ready 异常: ${JSON.stringify({ health, ready })}`);
  log(`guard: /health ok, /ready database=${(ready as any).database}`);

  const corsForbidden = await fetch(`${apiBase}/auth/session`, { headers: { Origin: "http://evil.example" } });
  if (corsForbidden.status !== 403) throw new Error(`CORS 白名单外 Origin 应 403，实际 ${corsForbidden.status}`);
  const corsAllowed = await fetch(`${apiBase}/auth/session`, { headers: { Origin: base } });
  if (corsAllowed.status === 403) throw new Error(`CORS 白名单内 Origin 被拒（${corsAllowed.status}）`);
  log(`guard: CORS 白名单外=${corsForbidden.status} 白名单内=${corsAllowed.status}`);

  const legacy = await fetch(`${apiBase}/projects/guard-check/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const legacyBody = await legacy.json();
  if (legacyBody.error !== "LEGACY_WORKER_API_DISABLED") throw new Error(`legacy API 应禁用，实际: ${JSON.stringify(legacyBody)}`);
  log("guard: legacy Worker API 已禁用（LEGACY_WORKER_API_DISABLED）");

  const spa = await fetch(`${base}/projects`);
  if (!spa.ok || !(spa.headers.get("content-type") ?? "").includes("text/html")) throw new Error("生产静态托管异常");
  log("guard: 生产 SPA 静态托管正常（/projects -> index.html）");

  // ---- 1. 注册账号（open 注册）+ 获取工作空间 ----
  browser = await chromium.launch({ headless: true });
  const probe = await browser.newContext();
  const register = await probe.request.post(`${apiBase}/auth/register`, { data: { email, name: "部署验证", password } });
  if (!register.ok() && register.status() !== 409) throw new Error(`注册失败: ${register.status()} ${(await register.text()).slice(0, 200)}`);
  if (register.status() === 409) {
    const login = await probe.request.post(`${apiBase}/auth/login`, { data: { email, password } });
    if (!login.ok()) throw new Error(`账号已存在但登录失败: ${login.status()}`);
    log(`账号已存在（${email}），改用登录`);
  } else {
    log(`registered ${email}`);
  }
  const session = await (await probe.request.get(`${apiBase}/auth/session`)).json();
  const workspaceId = (session as any).workspaces?.[0]?.id;
  if (!workspaceId) throw new Error(`注册会话缺少工作空间: ${JSON.stringify(session).slice(0, 200)}`);
  await probe.close();
  log(`session ok, workspace=${workspaceId}`);

  // ---- 2. 全新浏览器上下文：登录墙 → 网页编排全流程 ----
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

  await page.goto(`${base}/projects`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("heading", { name: "登录工作台" }).waitFor({ timeout: 15000 });
  await screenshot(page, "D1-登录墙.png");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.getByRole("heading", { name: "测试项目" }).waitFor({ timeout: 20000 });
  await screenshot(page, "D2-项目列表.png");
  log("UI 登录成功（Cookie 会话）");

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByText(projectName, { exact: true }).first().waitFor({ timeout: 20000 });
  await screenshot(page, "D3-项目已创建.png");

  // SPA pushState 导航不触发 load 事件；行刚创建时存在重渲染竞态，用「点击 + 轮询 + 重试」兜底
  const clickUntil = async (locator: Locator, condition: () => boolean, label: string, attempts = 5) => {
    for (let i = 0; i < attempts; i += 1) {
      if (condition()) return;
      await locator.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1200);
      if (condition()) return;
    }
    throw new Error(`点击后仍未满足条件: ${label}`);
  };
  await page.locator(".project-cell").filter({ hasText: projectName }).first().waitFor({ timeout: 20000 });
  await clickUntil(
    page.locator(".project-cell").filter({ hasText: projectName }).first(),
    () => page.url().includes("/project/"),
    "进入项目",
  );
  const routeProjectId = new URL(page.url()).pathname.split("/")[2];
  const platformProjects = await api(context.request, "GET", `/workspaces/${workspaceId}/projects`);
  const platformProject = listOf(platformProjects, "projects").find((p: any) => p.name === projectName);
  if (!platformProject) throw new Error("平台侧找不到新建项目");
  log(`project: route=${routeProjectId} platform=${platformProject.id}${platformProject.id === routeProjectId ? "（一致）" : "（不一致！）"}`);
  const platformProjectId = platformProject.id as string;

  // 环境
  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await page.getByRole("button", { name: "新建环境" }).click();
  const envDrawer = page.locator(".ant-drawer-content-wrapper");
  await envDrawer.waitFor({ timeout: 15000 });
  await envDrawer.getByLabel("环境名称").fill("部署验证环境");
  await envDrawer.getByLabel("基础地址").fill(base);
  await envDrawer.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("部署验证环境", { exact: true }).first().waitFor({ timeout: 15000 });
  await screenshot(page, "D4-环境已创建.png");
  log(`环境已创建: baseUrl=${base}`);

  // 变量（项目作用域，供 {{project.verify_account}} 插值）
  await page.locator(".project-nav-item").filter({ hasText: "变量" }).click();
  await page.getByRole("button", { name: "新建变量" }).click();
  const varDrawer = page.locator(".ant-drawer-content-wrapper");
  await varDrawer.waitFor({ timeout: 15000 });
  await varDrawer.getByLabel("变量名").fill("verify_account");
  await varDrawer.getByLabel("值").fill("deploy-verify-account");
  await varDrawer.getByRole("button", { name: "保存变量" }).click();
  await page.getByText("verify_account", { exact: true }).waitFor({ timeout: 15000 });

  // 元素 ×4（默认定位方式 testid）
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  for (const [name, testid] of [["账号输入框", "login-account"], ["密码输入框", "login-password"], ["登录按钮", "login-submit"], ["欢迎文案", "welcome"]] as const) {
    await page.getByRole("button", { name: "新建元素" }).click();
    const d = page.locator(".ant-drawer-content-wrapper");
    await d.waitFor({ timeout: 15000 });
    await d.getByLabel("元素名称").fill(name);
    await d.getByLabel("所属页面路径").fill("/__fixture/login");
    await d.getByLabel("定位值").fill(testid);
    await d.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText(name, { exact: true }).waitFor({ timeout: 15000 });
  }
  await screenshot(page, "D5-元素库就绪.png");
  log("元素库 4 个元素已就绪");

  // 流程编排（六步：打开页面 → 填写×2 → 点击 → 断言可见 → 截图）
  const selectOption = async (trigger: Locator, text: string) => {
    await trigger.click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: text }).first().click();
    await page.waitForTimeout(200);
  };
  const stepForm = () => page.locator(".step-form");
  const stepField = (labelText: string) =>
    stepForm().locator("label").filter({ has: stepForm().locator(`span:text-is("${labelText}")`) }).locator("input").first();
  const addStep = async () => {
    await page.locator(".add-step").click();
    await stepForm().waitFor({ timeout: 15000 });
  };

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill("登录回归验证流程");
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await page.locator(".add-step").waitFor({ timeout: 15000 });

  await addStep();
  await selectOption(stepForm().locator(".ant-select").first(), "打开页面");
  await stepField("页面路径").fill("/__fixture/login");
  await addStep();
  await selectOption(stepForm().locator(".ant-select").first(), "填写");
  await selectOption(stepForm().locator(".ant-select").nth(1), "账号输入框");
  await stepField("参数").fill("{{project.verify_account}}");
  await addStep();
  await selectOption(stepForm().locator(".ant-select").first(), "填写");
  await selectOption(stepForm().locator(".ant-select").nth(1), "密码输入框");
  await stepField("参数").fill("deploy-verify-pwd");
  await addStep();
  await selectOption(stepForm().locator(".ant-select").first(), "点击");
  await selectOption(stepForm().locator(".ant-select").nth(1), "登录按钮");
  await addStep();
  await selectOption(stepForm().locator(".ant-select").first(), "断言可见");
  await selectOption(stepForm().locator(".ant-select").nth(1), "欢迎文案");
  await addStep();
  await selectOption(stepForm().locator(".ant-select").first(), "截图");
  log("六步流程编排完成");

  await page.locator(".editor-topbar").getByRole("button", { name: "保存" }).click();
  await page.getByText("流程已保存", { exact: true }).waitFor({ timeout: 15000 });
  await screenshot(page, "D6-流程已保存.png");

  // 保存即发布：等待同步器生成发布快照
  const revision = await waitFor(async () => {
    const body = await api(context.request, "GET", `/platform/projects/${platformProjectId}/revisions`);
    const revisions = listOf(body, "revisions");
    return revisions.length > 0 ? revisions[0] : undefined;
  }, "保存即发布的修订快照", 120, 500);
  log(`保存即发布: revision=${revision.id} checksum=${revision.checksum}`);

  // ---- 3. 部署机执行（ManagedRunner）----
  await clickUntil(
    page.locator(".editor-topbar").getByRole("button", { name: "运行整个流程" }),
    () => /\/runs\/[^/]+$/.test(page.url()),
    "运行整个流程并跳转运行详情",
  );
  const runId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("heading", { name: "登录回归验证流程" }).waitFor({ timeout: 20000 });
  log(`运行已创建: ${runId}（运行详情轮询中）`);
  const finishedRun = await waitFor(async () => {
    const run = await api(context.request, "GET", `/platform/projects/${platformProjectId}/runs/${runId}`);
    return ["success", "failed", "canceled"].includes(run.status) ? run : undefined;
  }, "运行到达终态", 240, 1000);
  if (finishedRun.status !== "success") throw new Error(`运行失败: ${JSON.stringify(finishedRun.result ?? finishedRun).slice(0, 600)}`);
  const artifacts = finishedRun.artifacts ?? [];
  if (!artifacts.some((a: any) => a.name === "trace.zip")) throw new Error(`运行产物缺少 trace.zip: ${JSON.stringify(artifacts.map((a: any) => a.name))}`);
  const events = finishedRun.events ?? [];
  if (JSON.stringify(events).includes("deploy-verify-pwd")) throw new Error("运行事件泄漏步骤参数");
  log(`部署机执行成功: status=${finishedRun.status} artifacts=${artifacts.map((a: any) => a.name).join(",")} events=${events.length}`);
  await page.getByText("trace.zip", { exact: true }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await screenshot(page, "D7-运行成功详情.png");

  // ---- 4. 定时回归（cron 自动触发 + 立即执行）----
  await page.locator(".project-nav-item").filter({ hasText: "持续回归" }).click();
  const schedulePanel = page.locator(".automation-panel").filter({ hasText: "计划任务" });
  const createSchedule = schedulePanel.getByRole("button", { name: "新建" });
  await waitFor(async () => (await createSchedule.isDisabled()) ? undefined : true, "计划任务新建可用", 120, 500);
  await createSchedule.click();
  const scheduleModal = page.locator(".ant-modal-wrap:visible");
  await scheduleModal.waitFor({ timeout: 15000 });
  await scheduleModal.getByLabel("名称").fill("部署验证定时回归");
  await scheduleModal.getByLabel("已发布版本").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
  await scheduleModal.getByLabel("环境").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
  await scheduleModal.getByLabel("Cron").fill("*/2 * * * *");
  await scheduleModal.getByLabel("时区").fill("Asia/Shanghai");
  await scheduleModal.getByRole("button", { name: "创建计划" }).click();
  await page.getByText("部署验证定时回归", { exact: true }).waitFor({ timeout: 15000 });
  await screenshot(page, "D8-计划任务已创建.png");
  log("计划任务已创建: cron=*/2 * * * * Asia/Shanghai");

  const countScheduleRuns = async () => {
    const body = await api(context.request, "GET", `/platform/projects/${platformProjectId}/runs`);
    return listOf(body, "runs").filter((r: any) => r.snapshot?.trigger === "schedule");
  };
  const autoRuns = await waitFor(async () => {
    const runs = await countScheduleRuns();
    return runs.length > 0 ? runs : undefined;
  }, "cron 自动触发（每 2 分钟）", 260, 1000);
  log(`cron 自动触发成功: runIds=${autoRuns.map((r: any) => r.id).join(",")}`);

  await schedulePanel.getByRole("button", { name: /立即执行 部署验证定时回归/ }).click();
  await waitFor(async () => {
    const runs = await countScheduleRuns();
    return runs.length > autoRuns.length ? true : undefined;
  }, "立即执行产生新运行", 60, 500);
  log("立即执行（run-now）成功产生新运行");

  await schedulePanel.locator("tr").filter({ hasText: "部署验证定时回归" }).locator("button.ant-switch").first().click();
  await waitFor(async () => {
    const body = await api(context.request, "GET", `/platform/projects/${platformProjectId}/schedules`);
    const schedule = listOf(body, "schedules").find((s: any) => s.name === "部署验证定时回归");
    return schedule && !schedule.enabled ? true : undefined;
  }, "计划任务已停用", 60, 500);
  log("计划任务已停用（避免持续触发）");

  // ---- 5. 飞书通知（真实 webhook）----
  if (feishuUrl) {
    const channelPanel = page.locator(".automation-panel").filter({ hasText: "通知通道" });
    await channelPanel.getByRole("button", { name: "添加" }).click();
    const channelModal = page.locator(".ant-modal-wrap:visible");
    await channelModal.waitFor({ timeout: 15000 });
    await channelModal.getByLabel("名称").fill("飞书部署验证");
    await channelModal.getByLabel("类型").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "feishu" }).click();
    await channelModal.getByLabel("投递地址").fill(feishuUrl);
    await channelModal.getByRole("button", { name: "保存通道" }).click();
    await page.getByText("飞书部署验证", { exact: true }).waitFor({ timeout: 15000 });
    await screenshot(page, "D9-飞书通道已配置.png");
    log("飞书通知通道已加密保存");

    const channelRow = channelPanel.locator("tr").filter({ hasText: "飞书部署验证" });
    const failureSwitch = channelRow.locator("button.ant-switch").nth(1);
    if ((await failureSwitch.getAttribute("aria-checked")) !== "true") {
      await failureSwitch.click();
      await page.waitForTimeout(800);
    }
    log("失败通知订阅已开启");

    // 构造失败运行 → 投递失败通知
    await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
    await page.getByRole("button", { name: "新建流程" }).click();
    await page.getByLabel("流程名称").fill("失败通知验证流程");
    await page.getByRole("button", { name: "创建并编辑" }).click();
    await page.locator(".add-step").waitFor({ timeout: 15000 });
    await addStep();
    await selectOption(stepForm().locator(".ant-select").first(), "打开页面");
    await stepField("页面路径").fill("/__fixture/login");
    await addStep();
    await selectOption(stepForm().locator(".ant-select").first(), "断言文本");
    await selectOption(stepForm().locator(".ant-select").nth(1), "欢迎文案");
    await stepField("期望值").fill("绝不存在的文案XYZ");
    await page.locator(".editor-topbar").getByRole("button", { name: "保存" }).click();
    await page.getByText("流程已保存", { exact: true }).waitFor({ timeout: 15000 });
    await waitFor(async () => {
      const body = await api(context.request, "GET", `/platform/projects/${platformProjectId}/revisions`);
      const revisions = listOf(body, "revisions");
      return revisions.length > 1 ? revisions[0] : undefined;
    }, "失败流程的发布快照", 120, 500);
    await clickUntil(
      page.locator(".editor-topbar").getByRole("button", { name: "运行整个流程" }),
      () => /\/runs\/[^/]+$/.test(page.url()),
      "运行失败流程并跳转运行详情",
    );
    const failRunId = new URL(page.url()).pathname.split("/").pop()!;
    const failedRun = await waitFor(async () => {
      const run = await api(context.request, "GET", `/platform/projects/${platformProjectId}/runs/${failRunId}`);
      return ["success", "failed", "canceled"].includes(run.status) ? run : undefined;
    }, "失败运行到达终态", 240, 1000);
    if (failedRun.status !== "failed") throw new Error(`预期失败运行，实际 ${failedRun.status}`);
    log(`失败运行完成: ${failRunId}`);

    const delivery = await waitFor(async () => {
      const body = await api(context.request, "GET", `/platform/projects/${platformProjectId}/deliveries`);
      return listOf(body, "deliveries").find((d: any) => d.channel?.name === "飞书部署验证" && d.status === "delivered");
    }, "飞书投递 delivered", 240, 1000);
    log(`飞书投递成功: status=${delivery.status} runId=${delivery.runId ?? ""}`);
    await page.locator(".project-nav-item").filter({ hasText: "持续回归" }).click();
    await page.getByText("delivered", { exact: true }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    await screenshot(page, "D10-飞书投递记录.png");
    log("PLEASE CONFIRM: 请检查飞书群是否收到「失败通知验证流程」的失败通知消息。");
  } else {
    log("飞书通知阶段跳过：未设置 AUTOFLOW_FEISHU_WEBHOOK_URL");
  }

  // ---- 6. 治理分析 + 审计 ----
  const analytics = await api(context.request, "GET", `/platform/projects/${platformProjectId}/analytics`);
  const audit = await api(context.request, "GET", `/platform/projects/${platformProjectId}/audit-events`);
  const auditEvents = listOf(audit, "events");
  if (!analytics || typeof analytics !== "object") throw new Error("治理分析返回空");
  if (auditEvents.length === 0) throw new Error("审计事件为空");
  log(`治理分析 ok（keys=${Object.keys(analytics).join(",")}）; 审计事件 ${auditEvents.length} 条`);

  if (pageErrors.length > 0) log(`WARN: 页面未捕获异常: ${JSON.stringify(pageErrors.slice(0, 5))}`);
  if (consoleErrors.length > 0) log(`WARN: 浏览器 console 错误 ${consoleErrors.length} 条: ${JSON.stringify(consoleErrors.slice(0, 5))}`);
  log("DEPLOY VERIFY PASSED" + (feishuUrl ? "" : "（飞书阶段跳过）"));
} catch (error) {
  log("DEPLOY VERIFY FAILED: " + String(error));
  if (error instanceof Error && error.stack) log("STACK: " + error.stack.split("\n").slice(0, 8).join(" | "));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  log("finally done");
}
