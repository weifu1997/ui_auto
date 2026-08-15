import { expect, test } from "@playwright/test";
import { configurePlatformRunUiMocks } from "./platform-ui-fixtures";

test("assembles a Platform fixture run and renders the mocked completed report", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [
            {
              id: "runtime",
              name: "Worker UI 回归",
              description: "真实 Worker 执行链路",
              environmentCount: 1,
              flowCount: 1,
              lastRun: "尚未运行",
              health: 100,
            },
          ],
          flowsByProject: {
            runtime: [
              {
                id: "fixture-login",
                name: "Fixture 登录流程",
                description: "登录并验证欢迎信息",
                tags: ["回归"],
                steps: 3,
                lastStatus: "queued",
                updatedAt: "刚刚",
                definition: [
                  {
                    id: "open",
                    title: "打开登录页",
                    action: "打开页面",
                    value: "/__fixture/login",
                    timeout: 10,
                    failurePolicy: "立即失败",
                    status: "pending",
                  },
                  {
                    id: "submit",
                    title: "提交登录",
                    action: "点击",
                    element: "登录按钮",
                    value: "",
                    timeout: 10,
                    failurePolicy: "立即失败",
                    status: "pending",
                  },
                  {
                    id: "welcome",
                    title: "验证欢迎信息",
                    action: "可见性断言",
                    element: "欢迎信息",
                    value: "",
                    timeout: 10,
                    failurePolicy: "立即失败",
                    status: "pending",
                  },
                ],
              },
            ],
          },
          elementsByProject: {
            runtime: [
              {
                id: "submit",
                name: "登录按钮",
                description: "Fixture 登录提交按钮",
                path: "/__fixture/login",
                method: "testid",
                value: "login-submit",
                environment: "fixture",
                validation: "unverified",
                updatedAt: "刚刚",
              },
              {
                id: "welcome",
                name: "欢迎信息",
                description: "Fixture 登录成功提示",
                path: "/__fixture/login",
                method: "testid",
                value: "welcome",
                environment: "fixture",
                validation: "unverified",
                updatedAt: "刚刚",
              },
            ],
          },
          variablesByProject: { runtime: [] },
          environmentsByProject: {
            runtime: [
              {
                id: "fixture",
                name: "Worker Fixture",
                description: "本地 Worker 测试站点",
                baseUrl: "http://127.0.0.1:8787",
                browser: "Chromium",
                auth: "无认证",
                timeout: 10,
                color: "teal",
                updatedAt: "刚刚",
              },
            ],
          },
          activeEnvironmentByProject: { runtime: "fixture" },
        },
        version: 4,
      }),
    );
  });
  await page.reload();
  await page.goto("/project/runtime/flows");
  await configurePlatformRunUiMocks(page, "runtime");

  await page.getByRole("button", { name: "运行流程 Fixture 登录流程" }).click();
  await expect(page).toHaveURL(/\/project\/runtime\/runs$/);
  await expect(page.getByText("通过", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("3/3", { exact: true })).toBeVisible();

  const refreshResponse = page.waitForResponse(
    (response) =>
      /\/api\/platform\/projects\/platform-runtime\/runs$/.test(response.url()) &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "刷新状态" }).click();
  await refreshResponse;
  await expect(page.getByText("运行状态已刷新", { exact: true })).toBeVisible();

  await page.locator(".run-link").click();
  await expect(page.getByRole("heading", { name: "Fixture 登录流程" })).toBeVisible();
  await expect(page.locator(".report-state strong")).toHaveText("通过", { timeout: 10_000 });
  await expect(page.getByText("trace.zip", { exact: true })).toBeVisible();

  const completedRunUrl = page.url();
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect.poll(() => page.url()).not.toBe(completedRunUrl);
  await expect(page.locator(".report-state strong")).toHaveText("通过", { timeout: 10_000 });
});
