import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
// 跨层 parity：后端 `step.asserted` / `result.assertions` 发出的 type 必须等于
// 前端 `ASSERTION_ACTIONS` 映射（断言 schema 单源，见 .trellis/spec/backend/assertion-field-contract.md）。
import { ASSERTION_ACTIONS } from "../src/domain/assertions";

// 真实后端核心链路冒烟：不 mock 前端 API，直接对生产服务器（npm run start）
// 建工作区/项目 → 内联 flow/environment/elements 创建发布版本 → 发起运行 →
// 由 ManagedRunner 线程用真实 Chromium 执行（打开 /__fixture/login + 文本断言）
// → 校验 GET /runs/{id} 中 result.assertions 与 step.asserted 事件的形状与顺序。
// 验证 B（runner 断言执行）与 C（result/事件透出）两层契约真实流通，供 F/G/H 复用。
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

test("文本断言经真实执行链路写入 result.assertions 与 step.asserted", async ({ request, baseURL }) => {
  test.setTimeout(120_000);
  const origin = baseURL!;
  const api = await login(request, origin);

  // 1. 工作区 + 项目（真实后端持久化）。
  const workspaceResponse = await api.post("/api/workspaces", { name: "断言契约工作区" });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspaceId = (await workspaceResponse.json()).workspace.id as string;
  const projectResponse = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    name: "断言契约项目",
    description: "",
  });
  expect(projectResponse.ok()).toBeTruthy();
  const projectId = (await projectResponse.json()).project.id as string;

  // 2. 发布版本：flow + environment + elements 内联，创建即 published。
  const revisionResponse = await api.post(`/api/platform/projects/${projectId}/revisions`, {
    flow: {
      id: "flow-contract-1",
      name: "断言契约流程",
      description: "",
      steps: [
        { id: "s1", action: "打开页面", title: "打开页面", value: "/__fixture/login", timeout: 15, failurePolicy: "立即失败" },
        { id: "s2", action: "文本断言", title: "断言页面标题", element: "contract-title", value: "Fixture login", assertMatch: "contains", timeout: 15, failurePolicy: "立即失败" },
        { id: "s3", action: "URL 断言", title: "断言落地 URL", value: "/__fixture/login", assertMatch: "contains", timeout: 15, failurePolicy: "立即失败" },
      ],
    },
    environment: {
      id: "env-contract-1",
      name: "契约环境",
      baseUrl: origin,
      browser: "Chromium",
      auth: "无认证",
      timeout: 15,
      testIdAttribute: "data-testid",
    },
    elements: [
      { id: "contract-title", name: "页面标题", path: "/__fixture/login", method: "css", value: "h1", environment: "env-contract-1" },
    ],
  });
  expect(revisionResponse.ok()).toBeTruthy();
  const revision = (await revisionResponse.json()).revision as { status: string; id: string };
  expect(revision.status).toBe("published");

  // 3. 发起运行并轮询至终态。
  const runResponse = await api.post(`/api/platform/projects/${projectId}/runs`, {
    flowId: "flow-contract-1",
    environmentId: "env-contract-1",
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
    const detail = await api.get(`/api/platform/projects/${projectId}/runs/${runId}`);
    expect(detail.ok()).toBeTruthy();
    run = (await detail.json()).run;
    if (["success", "failed", "canceled"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  expect(run!.status).toBe("success");

  // 4. 契约断言：result.assertions 形状与内容。
  const assertions = run!.result?.assertions;
  expect(Array.isArray(assertions)).toBe(true);
  const textType = ASSERTION_ACTIONS["文本断言"];
  const textAssertion = (assertions as Array<Record<string, unknown>>).find(
    (item) => item.type === textType,
  );
  expect(textAssertion).toMatchObject({
    stepIndex: 1,
    stepId: "s2",
    title: "断言页面标题",
    type: textType,
    passed: true,
    expected: "Fixture login",
    actual: "Fixture login",
  });

  // 5. 契约断言：step.asserted 事件可见且恒在对应结论事件之前（顺序是契约）。
  const assertedEvents = run!.events.filter((event) => event.kind === "step.asserted");
  expect(assertedEvents.length).toBeGreaterThanOrEqual(1);
  const assertedIndex = run!.events.findIndex(
    (event) => event.kind === "step.asserted" && event.data.stepId === "s2",
  );
  const completedIndex = run!.events.findIndex(
    (event) => event.kind === "step.completed" && event.data.stepId === "s2",
  );
  expect(assertedIndex).toBeGreaterThanOrEqual(0);
  expect(completedIndex).toBeGreaterThanOrEqual(0);
  expect(assertedIndex).toBeLessThan(completedIndex);
  expect(run!.events[assertedIndex].data).toMatchObject({
    stepId: "s2",
    type: textType,
    passed: true,
    expected: "Fixture login",
    actual: "Fixture login",
  });

  // 6. URL 断言（页面级，无元素）：同样经真实执行链路写入 result.assertions 与
  //    step.asserted，type 为 `url`（值域扩展，载荷形状不变）。
  const urlType = ASSERTION_ACTIONS["URL 断言"];
  const urlAssertion = (assertions as Array<Record<string, unknown>>).find(
    (item) => item.type === urlType,
  );
  expect(urlAssertion).toMatchObject({
    stepIndex: 2,
    stepId: "s3",
    title: "断言落地 URL",
    type: urlType,
    passed: true,
    expected: "/__fixture/login",
  });
  const urlAssertedIndex = run!.events.findIndex(
    (event) => event.kind === "step.asserted" && event.data.stepId === "s3",
  );
  const urlCompletedIndex = run!.events.findIndex(
    (event) => event.kind === "step.completed" && event.data.stepId === "s3",
  );
  expect(urlAssertedIndex).toBeGreaterThanOrEqual(0);
  expect(urlAssertedIndex).toBeLessThan(urlCompletedIndex);
  expect(run!.events[urlAssertedIndex].data).toMatchObject({
    stepId: "s3",
    type: urlType,
    passed: true,
  });
});
