import { expect, test } from "@playwright/test";
import { configurePlatformRunUiMocks } from "./platform-ui-fixtures";

test("completes a user journey from a new project to a Platform run report", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("完整用户流程");
  await page.getByRole("button", { name: "创建项目" }).click();

  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.getByLabel("环境名称").fill("本地 Worker 环境");
  await page.getByLabel("基础地址").fill("http://127.0.0.1:8787");
  await page.getByRole("button", { name: "保存配置" }).click();

  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await page.getByRole("button", { name: "新建元素" }).click();
  await page.getByLabel("元素名称").fill("登录按钮");
  await page.getByLabel("所属页面路径").fill("/__fixture/login");
  await page.getByLabel("定位值").fill("login-submit");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("登录按钮", { exact: true })).toBeVisible();

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill("访问登录页");
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await page.getByRole("button", { name: "添加步骤" }).click();
  await page.locator(".step-form .ant-select").first().click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "打开页面" })
    .click();
  await page.locator(".step-form > label").nth(1).locator("input").fill("/__fixture/login");
  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".editor-topbar").getByRole("button").first().click();
  const calls = await configurePlatformRunUiMocks(page, "project");

  await page.getByRole("button", { name: "运行流程 访问登录页" }).click();
  await expect(page).toHaveURL(/\/project\/project\/runs$/);
  await expect(page.getByText("通过", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1/1", { exact: true })).toBeVisible();

  await page.locator(".run-link").click();
  await expect(page.getByRole("heading", { name: "访问登录页" })).toBeVisible();
  await expect(page.getByText("trace.zip", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(calls.revisions).toHaveLength(0);
  expect(calls.runs).toHaveLength(1);
  expect(calls.runs[0]).not.toHaveProperty("revisionId");
});
