import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function createProject(page: Page) {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("流程资产回归");
  await page.getByRole("button", { name: "创建项目" }).click();
}

test("creates isolated environment, element, and a flow with user-authored steps", async ({ page }) => {
  await createProject(page);

  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.getByLabel("环境名称").fill("Worker 目标环境");
  await page.getByLabel("基础地址").fill("https://example.test");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("heading", { name: "Worker 目标环境" })).toBeVisible();

  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await page.getByRole("button", { name: "新建元素" }).click();
  await page.getByLabel("元素名称").fill("提交按钮");
  await page.getByLabel("所属页面路径").fill("/form");
  await page.getByLabel("定位值").fill("submit");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("提交按钮", { exact: true })).toBeVisible();

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill("表单提交验证");
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await expect(page.getByText("从左侧添加一个步骤开始编排", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "添加步骤" }).click();
  await expect(page.getByRole("heading", { name: "新步骤" })).toBeVisible();
  await page.getByRole("button", { name: "保存" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "新步骤" })).toBeVisible();
});
