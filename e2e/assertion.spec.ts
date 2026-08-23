import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

// 真实后端 + 真实 Chromium 的断言端到端（implement.md 阶段 I1）：
// 打开页面 → 文本断言通过 → 数量断言失败（继续执行）→ 结果载荷/事件一致；
// 另加断言报告导出（JSON/XLSX artifact）+ RunDetail 断言区块（真实 UI 会话）。
// 不 mock 前端 API，直接对生产服务器（npm run start）全链路执行。
// 管理员由 playwright.config.ts 的 webServer 引导命令预置。

const ADMIN_EMAIL = "e2e-admin@example.test";
const ADMIN_PASSWORD = "playwright-e2e-password";

type Client = {
  get: (path: string) => Promise<import("@playwright/test").APIResponse>;
  post: (path: string, data?: unknown) => Promise<import("@playwright/test").APIResponse>;
};

async function login(request: APIRequestContext, baseURL: string): Promise<Client> {
  const response = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const token = body.token as string;
  expect(typeof token).toBe("string");
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: (path: string) => request.get(`${baseURL}${path}`, { headers }),
    post: (path: string, data?: unknown) => request.post(`${baseURL}${path}`, { headers, data }),
  };
}

// 三步骤流程：打开页面 → 文本断言通过（h1 命中 "Fixture login"）→
// 数量断言失败（登录页恰有 2 个 input，期望 3 个，operator "=" 判失败；
// failurePolicy 继续执行 → 运行整体仍为 success）。
function assertionFlow(baseUrl: string, suffix: string) {
  return {
    flow: {
      id: `flow-assert-${suffix}`,
      name: `断言端到端流程-${suffix}`,
      description: "",
      steps: [
        { id: "s1", action: "打开页面", title: "打开页面", value: "/__fixture/login", timeout: 15, failurePolicy: "立即失败" },
        { id: "s2", action: "文本断言", title: "标题文本断言", element: "assert-title", value: "Fixture login", assertMatch: "contains", timeout: 15, failurePolicy: "立即失败" },
        { id: "s3", action: "数量断言", title: "输入框数量断言", element: "assert-inputs", value: "3", assertOperator: "=", timeout: 15, failurePolicy: "继续执行" },
      ],
    },
    environment: {
      id: `env-assert-${suffix}`,
      name: `断言环境-${suffix}`,
      baseUrl,
      browser: "Chromium",
      auth: "无认证",
      timeout: 15,
      testIdAttribute: "data-testid",
    },
    elements: [
      { id: "assert-title", name: "页面标题", path: "/__fixture/login", method: "css", value: "h1", environment: `env-assert-${suffix}` },
      { id: "assert-inputs", name: "登录输入框", path: "/__fixture/login", method: "css", value: "input", environment: `env-assert-${suffix}` },
    ],
  };
}

// 建工作区/项目/发布版本 → 发起运行 → 轮询至终态。返回 workspaceId/projectId/runId/终态 run。
async function createAssertionRun(client: Client, origin: string, suffix: string) {
  const workspaceResponse = await client.post("/api/workspaces", { name: `断言工作区-${suffix}` });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspaceId = (await workspaceResponse.json()).workspace.id as string;
  const projectResponse = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    name: `断言项目-${suffix}`,
    description: "",
  });
  expect(projectResponse.ok()).toBeTruthy();
  const projectId = (await projectResponse.json()).project.id as string;

  const { flow, environment, elements } = assertionFlow(origin, suffix);
  const revisionResponse = await client.post(`/api/platform/projects/${projectId}/revisions`, {
    flow,
    environment,
    elements,
  });
  expect(revisionResponse.ok()).toBeTruthy();
  const revision = (await revisionResponse.json()).revision as { status: string; id: string };
  expect(revision.status).toBe("published");

  const runResponse = await client.post(`/api/platform/projects/${projectId}/runs`, {
    flowId: flow.id,
    environmentId: environment.id,
  });
  expect(runResponse.ok()).toBeTruthy();
  const runIds = (await runResponse.json()).runIds as string[];
  expect(runIds).toHaveLength(1);
  const runId = runIds[0];

  let run: {
    status: string;
    result?: Record<string, unknown>;
    events: Array<{ id: number; kind: string; data: Record<string, unknown>; at: string }>;
  };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const detail = await client.get(`/api/platform/projects/${projectId}/runs/${runId}`);
    expect(detail.ok()).toBeTruthy();
    run = (await detail.json()).run;
    if (["success", "failed", "canceled"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  expect(run!.status).toBe("success");
  return { workspaceId, projectId, runId, run: run! };
}

test("打开页面→文本断言通过→数量断言失败(继续执行)→结果载荷/事件一致 + 断言报告导出", async ({ request, baseURL }) => {
  test.setTimeout(120_000);
  const origin = baseURL!;
  const api = await login(request, origin);
  const { projectId, runId, run } = await createAssertionRun(api, origin, "api");

  // 1. 结果载荷：两条断言记录，文本通过、数量失败；继续执行不中止运行。
  expect(run.result?.completedSteps).toBe(2);
  const assertions = run.result?.assertions as Array<Record<string, unknown>>;
  expect(Array.isArray(assertions)).toBe(true);
  const textAssertion = assertions.find((item) => item.type === "text");
  const countAssertion = assertions.find((item) => item.type === "count");
  expect(textAssertion).toMatchObject({
    stepIndex: 1,
    stepId: "s2",
    title: "标题文本断言",
    type: "text",
    passed: true,
    expected: "Fixture login",
    actual: "Fixture login",
  });
  expect(countAssertion).toMatchObject({
    stepIndex: 2,
    stepId: "s3",
    title: "输入框数量断言",
    type: "count",
    passed: false,
    expected: "3",
    actual: "2",
  });

  // 2. 事件顺序契约：step.asserted 恒在对应结论事件（completed/failed）之前，载荷一致。
  const conclusionCases = [
    { stepId: "s2", conclusion: "step.completed", type: "text", passed: true, expected: "Fixture login", actual: "Fixture login" },
    { stepId: "s3", conclusion: "step.failed", type: "count", passed: false, expected: "3", actual: "2" },
  ] as const;
  for (const target of conclusionCases) {
    const assertedIndex = run.events.findIndex(
      (event) => event.kind === "step.asserted" && event.data.stepId === target.stepId,
    );
    const conclusionIndex = run.events.findIndex(
      (event) => event.kind === target.conclusion && event.data.stepId === target.stepId,
    );
    expect(assertedIndex).toBeGreaterThanOrEqual(0);
    expect(conclusionIndex).toBeGreaterThan(assertedIndex);
    expect(run.events[assertedIndex].data).toMatchObject({
      stepId: target.stepId,
      type: target.type,
      passed: target.passed,
      expected: target.expected,
      actual: target.actual,
    });
  }
  const failedEvent = run.events.find(
    (event) => event.kind === "step.failed" && event.data.stepId === "s3",
  );
  expect(String(failedEvent?.data.error)).toContain("ASSERTION_FAILED: count");
  expect(String(failedEvent?.data.error)).toContain("expected=3");
  expect(String(failedEvent?.data.error)).toContain("actual=2");

  // 3. 断言报告导出：JSON artifact 逐字段校验。
  const jsonResponse = await api.post(
    `/api/platform/projects/${projectId}/runs/${runId}/assertion-report?format=json`,
  );
  expect(jsonResponse.status()).toBe(201);
  const jsonArtifact = (await jsonResponse.json()).artifact as { id: string; name: string; contentType: string };
  expect(jsonArtifact.name).toMatch(/\.json$/);
  const jsonDownload = await api.get(`/api/platform/artifacts/${jsonArtifact.id}`);
  expect(jsonDownload.ok()).toBeTruthy();
  const report = (await jsonDownload.json()) as {
    runId: string;
    flowName: string;
    status: string;
    assertionCount: number;
    assertions: Array<Record<string, unknown>>;
  };
  expect(report.runId).toBe(runId);
  expect(report.status).toBe("success");
  expect(report.assertionCount).toBe(2);
  expect(report.assertions).toHaveLength(2);
  expect(report.assertions.find((item) => item.type === "text")).toMatchObject({
    stepId: "s2",
    type: "text",
    passed: true,
    expected: "Fixture login",
    actual: "Fixture login",
  });
  expect(report.assertions.find((item) => item.type === "count")).toMatchObject({
    stepId: "s3",
    type: "count",
    passed: false,
    expected: "3",
    actual: "2",
  });

  // 4. 断言报告导出：XLSX artifact 生成且可下载（zip 魔数）。
  const xlsxResponse = await api.post(
    `/api/platform/projects/${projectId}/runs/${runId}/assertion-report?format=xlsx`,
  );
  expect(xlsxResponse.status()).toBe(201);
  const xlsxArtifact = (await xlsxResponse.json()).artifact as { id: string; name: string; contentType: string };
  expect(xlsxArtifact.name).toMatch(/\.xlsx$/);
  expect(xlsxArtifact.contentType).toContain("spreadsheetml");
  const xlsxDownload = await api.get(`/api/platform/artifacts/${xlsxArtifact.id}`);
  expect(xlsxDownload.ok()).toBeTruthy();
  const xlsxBuffer = await xlsxDownload.body();
  expect(xlsxBuffer.length).toBeGreaterThan(0);
  expect(xlsxBuffer.subarray(0, 2).toString()).toBe("PK");
});

test("RunDetail 断言区块渲染真实运行结果（真实 UI 会话登录 + 导出）", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const origin = baseURL!;

  // 建数据走 bearer-token API（会话 cookie 为 Secure，Node 侧 page.request 不发送；
  // 同一 super-admin 账号经两种会话访问同一项目）。
  const api = await login(request, origin);
  const { workspaceId, projectId, runId } = await createAssertionRun(api, origin, "ui");

  // 真实 UI 登录：匿名态渲染 LoginPage，提交后建立 autoflow_session cookie。
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  await page.getByLabel("邮箱").fill(ADMIN_EMAIL);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/projects$/);

  // 登录后默认落点是最早创建的工作区（可能不是本测试的工作区）；预置活动工作区
  // 键后再整页加载 RunDetail，让 ServerWorkspaceSynchronizer 加载目标项目。
  await page.evaluate(
    (workspaceId) => localStorage.setItem("autoflow-platform-workspace", workspaceId),
    workspaceId,
  );
  // 打开 RunDetail：断言区块展示真实结果（1 通过 / 1 失败）。
  await page.goto(`/project/${projectId}/runs/${runId}`);
  await expect(page.locator(".assertion-block h2")).toHaveText("断言结果");
  await expect(page.locator(".assertion-heading > span")).toHaveText("1/2 通过");

  const rows = page.locator(".assertion-row");
  await expect(rows).toHaveCount(2);

  const passedRow = rows.filter({ hasText: "标题文本断言" });
  await expect(passedRow).toContainText("文本断言");
  await expect(passedRow.locator(".assertion-verdict")).toHaveText("通过");
  const passedCodes = passedRow.locator(".assertion-compare code");
  await expect(passedCodes.nth(0)).toHaveText("Fixture login");
  await expect(passedCodes.nth(1)).toHaveText("Fixture login");

  const failedRow = rows.filter({ hasText: "输入框数量断言" });
  await expect(failedRow).toContainText("数量断言");
  await expect(failedRow.locator(".assertion-verdict")).toHaveText("失败");
  const failedCodes = failedRow.locator(".assertion-compare code");
  await expect(failedCodes.nth(0)).toHaveText("3");
  await expect(failedCodes.nth(1)).toHaveText("2");

  // 导出断言报告按钮存在且 JSON 导出触发真实下载（artifact 名断言报告-{runId}.json）。
  await expect(page.getByRole("button", { name: "导出 JSON" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 Excel" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^assertion-report-.*\.json$/);
});
