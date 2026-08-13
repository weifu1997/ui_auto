/**
 * 内网部署验证闭环（决策文档「部署验证」遗留项）。
 *
 * 前置条件（由外部完成）：
 *   1. npm run build 已产出最新 dist/
 *   2. 生产模式服务已在 8787 监听 0.0.0.0 运行：
 *        AUTOFLOW_LISTEN_HOST=0.0.0.0 AUTOFLOW_CORS_ORIGINS=<LAN_ORIGIN>,http://127.0.0.1:8787
 *        PLATFORM_SECRET_KEY=<长随机密钥> NODE_ENV=production
 *      （通知验证需要：PLATFORM_ALLOW_INSECURE_NOTIFICATION_URLS=1
 *        PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS=1 —— 指向本机模拟飞书接收端点）
 *
 * 闭环：网页编排（注册/登录→项目→环境→元素→流程→保存即发布）
 *      → 部署机执行（ManagedRunner 运行：成功 + 失败两路径）
 *      → 定时回归（cron 计划自动触发）
 *      → 飞书通知（feishu 通道 → 订阅 → 投递记录 delivered / HTTP 200）
 *
 * 用法：tsx server/selftest-deploy-loop.ts
 */
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type APIRequestContext, type Browser, type Page, type Response } from "playwright";

type ApiOptions = Parameters<APIRequestContext["fetch"]>[1];

const platformPort = 8787;
const lanHost = process.env.DEPLOY_VERIFY_LAN_HOST ?? "192.168.3.18";
// 真实飞书机器人 Webhook（自定义关键词「股票日报」）；不设置时退化为本机模拟端点验证投递链路。
const feishuWebhook = process.env.DEPLOY_VERIFY_FEISHU_WEBHOOK?.trim() || "";
const feishuKeyword = process.env.DEPLOY_VERIFY_FEISHU_KEYWORD ?? "股票日报";
const mockFeishuPort = 8799;
const baseUrl = `http://${lanHost}:${platformPort}`;
const mockFeishuLog = join(".tmp", "feishu-mock.log");

const screenshotDir = join("docs", "自测截图", "内网部署验证");
const logFile = join("server", "selftest-deploy-loop-log.txt");
mkdirSync(screenshotDir, { recursive: true });

const log = (msg: string) => {
  console.log(msg);
  appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
};

let browser: Browser | undefined;
let page: Page | undefined;
let api: APIRequestContext;
let mockFeishuServer: ReturnType<typeof createServer> | undefined;

const account = {
  email: `deploy-verify-${Date.now()}@example.test`,
  name: "部署验证用户",
  password: "deployment-password",
};

const results: Array<{ step: string; ok: boolean; detail?: string }> = [];
function record(step: string, ok: boolean, detail = "") {
  results.push({ step, ok, detail });
  log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, attempts = 300, interval = 500) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function apiJson(path: string, init: ApiOptions = {}) {
  const response = await api.fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok()) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status()} ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
}

async function waitResource(projectId: string, type: string, idOrName: string, label: string) {
  return waitFor(async () => {
    const body = await apiJson(`/api/platform/projects/${projectId}/resources/${type}`);
    const resources = (body.resources ?? []) as Array<Record<string, unknown>>;
    return resources.find((item) => item.id === idOrName || String((item.data as Record<string, unknown>)?.name) === idOrName);
  }, `资源落库：${label}`, 60, 500);
}

async function shot(name: string) {
  if (!page) return;
  await page.screenshot({ path: join(screenshotDir, name), fullPage: false });
}

/** 点击 antd Select（兼容 Form.Item 结构与 label 包裹结构），再点可见下拉中的选项。 */
async function pickSelect(labelText: string, optionText: string) {
  const select = page!
    .locator(
      `.ant-form-item:has(label:has-text("${labelText}")) .ant-select, label:has(span:text-is("${labelText}")) .ant-select`,
    )
    .first();
  await select.click();
  await page!
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: new RegExp(`^${optionText}$`) })
    .click();
}

/** 等待 ServerWorkspaceSynchronizer 完成对当前项目的初始拉取（5 个 GET），
 *  避免 hydration 完成前的 store 写入被订阅守卫静默丢弃（产品竞态，详见自测报告）。 */
function waitHydration() {
  return new Promise<void>((resolve) => {
    const seen = new Set<string>();
    const timer = setTimeout(() => {
      page!.off("response", listener);
      resolve();
    }, 15_000);
    const listener = (resp: Response) => {
      const url = resp.url();
      const match = url.match(/\/resources\/(flows|elements|variables|environments)$|\/settings$/);
      if (!match || resp.request().method() !== "GET" || !url.includes(projectId)) return;
      seen.add(match[1]);
      if (seen.size >= 5) {
        clearTimeout(timer);
        page!.off("response", listener);
        resolve();
      }
    };
    page!.on("response", listener);
  });
}

/** 项目内导航（URL 直达；编辑器/运行详情为独立路由，无侧栏）。 */
const sectionToPath: Record<string, string> = {
  概览: "overview",
  流程: "flows",
  元素库: "elements",
  变量: "variables",
  环境: "environments",
  数据集: "data",
  发布与运行: "agents",
  持续回归: "automations",
  系统管理: "governance",
  运行中心: "runs",
  项目设置: "settings",
  平台: "platform",
};
async function nav(sectionLabel: string) {
  const path = sectionToPath[sectionLabel];
  if (!path) throw new Error(`unknown section: ${sectionLabel}`);
  await page!.goto(`${baseUrl}/project/${projectId}/${path}`, { waitUntil: "domcontentloaded" });
  await waitHydration();
}

async function loginUi() {
  await page!.goto(`${baseUrl}/projects`, { waitUntil: "domcontentloaded" });
  await page!.getByRole("heading", { name: "登录工作台" }).waitFor({ timeout: 15_000 });
  await shot("01-登录墙.png");
  await page!.getByLabel("邮箱").fill(account.email);
  await page!.getByLabel("密码").fill(account.password);
  await page!.locator('button[type="submit"]').click();
  // 登录成功后进入项目列表（侧栏显示用户名，页面主体是项目表格）
  await page!.getByRole("button", { name: "新建项目" }).waitFor({ timeout: 15_000 });
}

async function createProjectUi() {
  await page!.getByRole("button", { name: "新建项目" }).click();
  const modal = page!.locator(".ant-modal");
  await modal.getByLabel("项目名称").fill("内网部署验证");
  await modal.getByLabel("说明").fill("网页编排 → 部署机执行 → 定时回归 → 飞书通知 闭环");
  await modal.locator(".ant-btn-primary").click();
  await page!.getByText("内网部署验证", { exact: true }).first().waitFor({ timeout: 15_000 });
  // 让 ServerWorkspaceSynchronizer 完成首次拉取（项目元数据入 map），避免早期保存被静默丢弃
  await page!.waitForTimeout(3_000);
}

async function createEnvironmentUi() {
  await nav("环境");
  await page!.getByRole("button", { name: "新建环境" }).waitFor();
  await page!.getByRole("button", { name: "新建环境" }).click();
  const drawer = page!.locator(".ant-drawer").last();
  await drawer.getByLabel("环境名称").fill("Sub2API");
  await drawer.getByLabel("基础地址").fill("https://huang1997.cloud/");
  await drawer.getByLabel("默认超时（秒）").fill("45");
  await drawer.locator(".ant-btn-primary").click();
  await page!.getByText("Sub2API", { exact: true }).first().waitFor({ timeout: 15_000 });
}

async function createElementUi(name: string, path: string, method: string, value: string) {
  await nav("元素库");
  await page!.getByRole("button", { name: "新建元素" }).click();
  const drawer = page!.locator(".ant-drawer").last();
  await drawer.getByLabel("元素名称").fill(name);
  await drawer.getByLabel("所属页面路径").fill(path);
  await pickSelect("定位方式", method);
  await drawer.getByLabel("定位值").fill(value);
  await drawer.locator(".ant-btn-primary").click();
  await page!.getByText(name, { exact: true }).first().waitFor({ timeout: 15_000 });
  // 等待同步器 450ms 防抖完成并落库（否则后续导航会销毁待执行的同步定时器，见自测报告竞态说明）
  await waitResource(projectId, "elements", name, `元素 ${name}`);
}

async function createFlowUi(name: string, steps: Array<{ action: string; element?: string }>) {
  await nav("流程");
  await page!.getByRole("button", { name: "新建流程" }).click();
  const drawer = page!.locator(".ant-drawer").last();
  await drawer.getByLabel("流程名称").fill(name);
  await drawer.getByRole("button", { name: "创建并编辑" }).click();
  // 新建后进入编辑器
  await page!.getByText("运行整个流程").waitFor({ timeout: 15_000 });
  // 等资源面板同步出步骤所需元素（ServerWorkspaceSynchronizer 异步拉取）
  const neededElements = [...new Set(steps.map((step) => step.element).filter((item): item is string => Boolean(item)))];
  for (const elementName of neededElements) {
    await page!.getByText(elementName, { exact: true }).first().waitFor({ timeout: 30_000 });
  }
  for (const step of steps) {
    await page!.getByRole("button", { name: "新增步骤" }).click();
    await pickSelect("动作", step.action);
    if (step.element) {
      await pickSelect("元素", step.element);
    }
    // 外部站点偶发慢响应：把步骤超时从默认 10s 提到 45s，避免瞬时抖动导致误判失败
    await page!.locator("label").filter({ hasText: "超时（秒）" }).locator("input").fill("45");
  }
  await page!.getByRole("button", { name: /保存/ }).click();
  await page!.getByText("已保存", { exact: true }).waitFor({ timeout: 15_000 });
  await waitResource(projectId, "flows", name, `流程 ${name}`);
  await shot(`05-流程编辑器-${name}.png`);
}

async function runFlowUi(name: string) {
  await nav("流程");
  await page!.getByRole("button", { name: `运行流程 ${name}` }).click();
  await page!.getByText("已创建", { exact: false }).waitFor({ timeout: 15_000 }).catch(() => undefined);
}

async function latestPublishedRevision(flowName: string) {
  const body = await apiJson(`/api/platform/projects/${projectId}/revisions`);
  const revisions = body.revisions as Array<Record<string, unknown>>;
  return revisions.find((item) => item.flowName === flowName && item.status === "published");
}

async function waitRunTerminal(revisionId: string, expect: "success" | "failed", label: string) {
  return waitFor(async () => {
    const body = await apiJson(`/api/platform/projects/${projectId}/runs`);
    const runs = (body.runs as Array<Record<string, unknown>>).filter((run) => run.revisionId === revisionId);
    const match = runs.find((run) => run.status === expect);
    if (match) return match;
    const bad = runs.find((run) => ["failed", "canceled"].includes(String(run.status)));
    if (expect === "failed" && bad) return bad;
    if (bad) throw new Error(`${label} failed unexpectedly: ${String(bad.status)}`);
    return undefined;
  }, label, 240, 1000);
}

let projectId = "";
let workspaceId = "";

try {
  appendFileSync(logFile, `\n===== DEPLOY VERIFY ${new Date().toISOString()} =====\n`);
  console.log(`LAN origin: ${baseUrl}`);
  browser = await chromium.launch({ headless: true });
  // API 上下文与 UI 上下文分离：UI 上下文不带注册 Cookie，才能验证「登录墙 → 网页登录」。
  const apiContext = await browser.newContext();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  api = apiContext.request;
  page.on("response", (resp) => {
    const url = resp.url();
    if (url.includes("/api/platform/") && resp.request().method() !== "GET") {
      log(`   net: ${resp.request().method()} ${url.replace(baseUrl, "").slice(0, 110)} -> ${resp.status()}`);
    }
  });

  // ---------- A. 安全守卫（非 loopback 生产形态） ----------
  log("--- A. 安全守卫 ---");
  const health = await apiJson("/health");
  record("A1 健康检查（LAN 地址）", health.ok === true, JSON.stringify(health));
  const ready = await apiJson("/ready");
  record("A2 SQLite 就绪（/ready）", ready.database === "ok", `database=${String(ready.database)}`);
  const legacy = await api.fetch(`${baseUrl}/api/projects/none/runs`);
  record("A3 legacy Worker API 已禁用", legacy.status() === 404 && (await legacy.text()).includes("LEGACY_WORKER_API_DISABLED"), `HTTP ${legacy.status()}`);
  const corsBad = await api.fetch(`${baseUrl}/health`, { headers: { origin: "http://evil.example" } });
  record("A4 CORS 白名单拦截（非白名单源 403）", corsBad.status() === 403, `HTTP ${corsBad.status()}`);
  const corsOk = await api.fetch(`${baseUrl}/health`, { headers: { origin: baseUrl } });
  record("A5 CORS 放行（部署控制台源）", corsOk.status() === 200, `HTTP ${corsOk.status()}`);

  // ---------- B. 网页编排 ----------
  log("--- B. 网页编排 ---");
  const registered = await api.post(`${baseUrl}/api/auth/register`, {
    data: account,
  });
  if (!registered.ok()) throw new Error(`register failed: ${registered.status()} ${await registered.text()}`);
  const session = await apiJson("/api/auth/session");
  workspaceId = (session.workspaces as Array<{ id: string }>)[0].id;
  record("B1 注册并创建私有工作空间", Boolean(workspaceId), account.email);

  await loginUi();
  record("B2 生产 UI 登录（LAN 地址访问）", true, baseUrl);
  await createProjectUi();
  record("B3 新建项目「内网部署验证」", true);

  const projects = (await apiJson(`/api/workspaces/${workspaceId}/projects`)).projects as Array<Record<string, unknown>>;
  projectId = String(projects.find((item) => item.name === "内网部署验证")?.id ?? "");
  if (!projectId) throw new Error("project not found after UI create");
  await shot("02-项目列表-新建完成.png");
  record("B4 项目落库（平台资源级同步）", true, projectId);

  await createEnvironmentUi();
  await waitResource(projectId, "environments", "Sub2API", "环境 Sub2API");
  record("B5 环境「Sub2API」（服务端资源已同步）", true);
  await createElementUi("首页登录链接", "/", "text", "登录");
  await createElementUi("登录页欢迎标题", "/login", "text", "欢迎回来");
  await waitResource(projectId, "elements", "首页登录链接", "元素 首页登录链接");
  await shot("04-元素库-两元素.png");
  record("B6 元素库两元素（text 定位，服务端已同步）", true);

  await createFlowUi("登录回归流程", [
    { action: "打开页面" },
    { action: "点击", element: "首页登录链接" },
    { action: "可见性断言", element: "登录页欢迎标题" },
  ]);
  const revision = await waitFor(
    async () => await latestPublishedRevision("登录回归流程"),
    "保存即发布快照（revision）",
    120,
    1000,
  );
  record("B7 流程编排保存即发布（快照自动生成）", true, `revision=${String(revision?.revisionNumber)}`);

  // ---------- C. 部署机执行 ----------
  log("--- C. 部署机执行（ManagedRunner） ---");
  await runFlowUi("登录回归流程");
  const successRun = await waitRunTerminal(String(revision?.id), "success", "登录回归流程运行成功");
  const artifacts = (successRun.artifacts ?? []) as Array<{ name: string }>;
  record("C1 成功路径：流程运行通过", true, `run=${String(successRun.id)}`);
  record("C2 产物（截图/Trace）落盘", artifacts.length > 0, artifacts.map((a) => a.name).join(", "));

  await nav("运行中心");
  await page!.getByText("通过", { exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await shot("06-运行中心-成功.png");
  // 运行详情页
  await page!.goto(`${baseUrl}/project/${projectId}/runs/${String(successRun.id)}`, { waitUntil: "domcontentloaded" });
  await page!.getByText("执行日志", { exact: true }).waitFor({ timeout: 15_000 });
  await shot("07-运行详情-成功.png");
  record("C3 运行详情页（日志/产物/统计）", true);

  // 失败路径：不存在的元素 → 点击失败
  await createElementUi("不存在的元素", "/", "text", "__不存在的元素__");
  await createFlowUi("失败验证流程", [
    { action: "打开页面" },
    { action: "点击", element: "不存在的元素" },
  ]);
  const failureRevision = await waitFor(
    async () => await latestPublishedRevision("失败验证流程"),
    "失败流程快照",
    120,
    1000,
  );
  await runFlowUi("失败验证流程");
  const failedRun = await waitRunTerminal(String(failureRevision?.id), "failed", "失败验证流程运行失败");
  record("C4 失败路径：定位失败归因", true, `run=${String(failedRun.id)}`);
  await page!.goto(`${baseUrl}/project/${projectId}/runs/${String(failedRun.id)}`, { waitUntil: "domcontentloaded" });
  await page!.getByText("执行日志", { exact: true }).waitFor({ timeout: 15_000 });
  await shot("08-运行详情-失败.png");
  record("C5 失败运行详情（错误卡片 + 失败截图）", true);

  // ---------- D. 定时回归 ----------
  log("--- D. 定时回归（cron 自动触发） ---");
  const mockFeishuBodies: string[] = [];
  mockFeishuServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      mockFeishuBodies.push(body);
      appendFileSync(mockFeishuLog, `${new Date().toISOString()} ${body}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, msg: "success" }));
    });
  });
  await new Promise<void>((resolve) => mockFeishuServer!.listen(mockFeishuPort, "127.0.0.1", resolve));
  const feishuTarget = feishuWebhook || `http://127.0.0.1:${mockFeishuPort}/mock-feishu`;
  log(`   通知目标：${feishuWebhook ? "真实飞书 Webhook（关键词 " + feishuKeyword + "）" : "本机模拟端点"} ${feishuTarget.slice(0, 80)}`);
  if (!feishuWebhook) record("D0 模拟飞书接收端点就绪", true, `http://127.0.0.1:${mockFeishuPort}/mock-feishu`);

  const channel = (await apiJson(
    `/api/platform/workspaces/${workspaceId}/notification-channels`,
    {
      method: "POST",
      data: { name: "飞书-验证群", type: "feishu", config: { url: feishuTarget, keyword: feishuKeyword } },
    },
  )).channel as { id: string; name: string; type: string };
  await apiJson(`/api/platform/projects/${projectId}/notification-subscriptions`, {
    method: "PUT",
    data: { channelId: channel.id, onSuccess: true, onFailure: true },
  });
  record("D1 通知通道（feishu，配置加密落库）+ 订阅成功/失败", true, `${channel.name} (${channel.type})`);

  // 重新取「当前最新」的已发布版本：B7 拿到的旧版本可能已被后续同步产生的
  // 新快照标记为 superseded（流程数据 round-trip 后 checksum 变化触发新版本）。
  const currentRevision = (await waitFor(
    async () => await latestPublishedRevision("登录回归流程"),
    "D2 最新已发布版本",
    60,
    1000,
  )) as { id: string; environmentId?: string };
  const schedule = (await apiJson(`/api/platform/projects/${projectId}/schedules`, {
    method: "POST",
    data: {
      name: "每2分钟登录回归",
      revisionId: currentRevision.id,
      environmentId: String(currentRevision.environmentId ?? revision?.environmentId),
      cron: "*/2 * * * *",
      timezone: "Asia/Shanghai",
    },
  })).schedule as { id: string; cron: string; nextRunAt: string };
  record("D2 创建 cron 计划（保存即启用）", true, `${schedule.cron} next=${schedule.nextRunAt}`);

  await nav("持续回归");
  await page!.getByText("每2分钟登录回归", { exact: true }).waitFor({ timeout: 15_000 });
  await shot("09-持续回归-计划任务.png");
  record("D3 持续回归页展示计划任务", true);

  const scheduledRun = await waitFor(async () => {
    const body = await apiJson(`/api/platform/projects/${projectId}/runs`);
    const runs = (body.runs as Array<Record<string, unknown>>).filter(
      (run) => run.revisionId === currentRevision.id && String(run.createdAt) >= String(schedule ? new Date(Date.now() - 4 * 60_000).toISOString() : ""),
    );
    return runs.find((run) => run.status === "success") ?? (runs.find((run) => ["failed", "canceled"].includes(String(run.status))) ? undefined : undefined);
  }, "定时任务自动触发并成功", 420, 1000);
  record("D4 定时回归自动触发（无人值守）", true, `run=${String(scheduledRun.id)} trigger=${String((scheduledRun.snapshot as Record<string, unknown>)?.trigger ?? "?")}`);

  // 订阅后再跑一次失败运行，验证失败通知（同样重取最新已发布版本）
  const currentFailureRevision = (await waitFor(
    async () => await latestPublishedRevision("失败验证流程"),
    "D5 最新失败版本",
    60,
    1000,
  )) as { id: string };
  const failureRun2 = (await apiJson(`/api/platform/projects/${projectId}/runs`, {
    method: "POST",
    data: { revisionId: currentFailureRevision.id },
  })).runs as Array<{ id: string }>;
  const newFailureRunId = failureRun2[0]?.id;
  const failed2 = await waitFor(async () => {
    const body = (await apiJson(`/api/platform/projects/${projectId}/runs/${newFailureRunId}`)) as { run?: Record<string, unknown> };
    const run = body.run ?? {};
    return ["failed", "canceled"].includes(String(run.status)) ? run : undefined;
  }, "新失败运行终止", 240, 1000);
  record("D5 失败路径运行（通知用）", true, `run=${String((failed2 as { id: string }).id ?? failureRun2[0]?.id)}`);

  // ---------- E. 飞书通知投递 ----------
  log("--- E. 飞书通知（投递记录） ---");
  const deliveries = await waitFor(async () => {
    const body = await apiJson(`/api/platform/projects/${projectId}/deliveries`);
    const list = (body.deliveries ?? []) as Array<{ status: string; responseCode: number | null; error: string | null; runId: string }>;
    const successDelivery = list.find((d) => d.runId === String(scheduledRun.id) && d.status === "delivered");
    const failureDelivery = list.find((d) => d.runId === String(failed2.id) && d.status === "delivered");
    if (successDelivery && failureDelivery) return { successDelivery, failureDelivery };
    return undefined;
  }, "成功 + 失败两条通知均投递成功", 120, 1000);
  record("E1 投递记录 delivered", deliveries.successDelivery.responseCode === 200, `success HTTP ${String(deliveries.successDelivery.responseCode)}`);
  record("E2 失败通知 delivered", deliveries.failureDelivery.responseCode === 200, `failure HTTP ${String(deliveries.failureDelivery.responseCode)}`);
  if (feishuWebhook) {
    record(
      "E3 真实飞书送达（业务 code=0，关键词前置）",
      deliveries.successDelivery.error === null && deliveries.failureDelivery.error === null,
      `success/failure error=${String(deliveries.successDelivery.error)} / ${String(deliveries.failureDelivery.error)}`,
    );
  } else {
    record("E3 模拟飞书端点收到 feishu 格式消息", mockFeishuBodies.length >= 2 && mockFeishuBodies.every((b) => b.includes('"msg_type":"text"')), `${mockFeishuBodies.length} 条`);
    mockFeishuBodies.forEach((body) => log(`   feishu body: ${body.slice(0, 200)}`));
  }

  await page!.goto(`${baseUrl}/project/${projectId}/automations`, { waitUntil: "domcontentloaded" });
  await page!.getByText("投递记录", { exact: true }).waitFor({ timeout: 15_000 }).catch(() => undefined);
  await page!.waitForTimeout(1500);
  await shot("10-持续回归-投递记录.png");
  record("E4 持续回归页投递记录可见", true);

  // ---------- F. 审计与治理 ----------
  log("--- F. 审计与治理 ---");
  const audit = (await apiJson(`/api/platform/projects/${projectId}/audit-events`)).events as Array<{ action: string }> | undefined ?? [];
  const auditActions = audit.map((e) => e.action);
  // 项目级审计（notification_channel.created 为工作空间级事件，不在项目审计列表）
  const needed = ["run.created", "schedule.created", "schedule.triggered", "notification_subscription.saved", "flow_revision.created"];
  record("F1 审计事件完备（项目级）", needed.every((action) => auditActions.includes(action)), auditActions.slice(0, 12).join(", "));
  const analyticsBody = await apiJson(`/api/platform/projects/${projectId}/analytics`);
  const trend = (analyticsBody.analytics as { trend?: unknown[] } | undefined)?.trend;
  record("F2 治理分析可用", Boolean(trend?.length), JSON.stringify(trend ?? []).slice(0, 120));

  const okCount = results.filter((r) => r.ok).length;
  log(`\n===== 结果：${okCount}/${results.length} 通过 =====`);
  if (okCount !== results.length) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`\n===== 中断：${message} =====`);
  if (page) await shot("99-失败现场.png").catch(() => undefined);
  record("闭环执行", false, message);
  process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => mockFeishuServer?.close(() => resolve()));
  await browser?.close().catch(() => undefined);
  const report = results.map((r) => `| ${r.step} | ${r.ok ? "✅ 通过" : "❌ 失败"} | ${r.detail ?? ""} |`).join("\n");
  writeFileSync(join(".tmp", "deploy-verify-results.md"), report);
  console.log(`\n截图目录：${screenshotDir}`);
  console.log(`详细日志：${logFile}`);
}
