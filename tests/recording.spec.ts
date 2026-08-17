import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { configurePlatformRecordingUiMocks } from "./platform-ui-fixtures";

async function createProject(page: Page, name: string) {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill(name);
  await page.getByRole("button", { name: "创建项目" }).click();
}

async function createEnvironment(page: Page) {
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.getByLabel("环境名称").fill("录制环境");
  await page.getByLabel("基础地址").fill("https://default.example.test");
  await page.getByRole("button", { name: "保存配置" }).click();
}

async function createFlow(page: Page) {
  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill("录制回归流程");
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await page.getByRole("button", { name: "添加步骤" }).click();
  await page.locator(".step-form .ant-select").first().click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "打开页面" })
    .click();
  await page.locator(".step-form > label").nth(1).locator("input").fill("/login");
  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".editor-topbar").getByRole("button").first().click();
}

test("records, recovers controls, reviews, validates, and imports a flow draft", async ({ page }) => {
  await createProject(page, "录制回归项目");
  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await createEnvironment(page);
  await createFlow(page);

  const calls = await configurePlatformRecordingUiMocks(page, "project");
  await page.getByRole("button", { name: "录制回归流程" }).click();

  await page.getByRole("button", { name: "录制" }).click();
  await page.getByLabel("录制起始 URL").fill("https://default.example.test/login?token=discarded");
  await page.getByLabel("从头录制（不使用已有登录态）").check();
  await page.getByRole("button", { name: "开始录制" }).click();
  await expect(page.getByRole("button", { name: "暂停录制" })).toBeVisible();

  await expect.poll(() => calls.eventCursors).toEqual(expect.arrayContaining([0, 100]));
  expect(calls.sessions[0]).toMatchObject({ freshLogin: true });

  await page.reload();
  await expect(page.getByRole("button", { name: "暂停录制" })).toBeVisible();
  await page.getByRole("button", { name: "暂停录制" }).click();
  await expect(page.getByRole("button", { name: "继续录制" })).toBeVisible();
  await page.getByRole("button", { name: "继续录制" }).click();
  await page.getByRole("button", { name: "停止录制" }).click();

  const review = page.getByRole("dialog", { name: "录制结果" });
  await expect(review.getByText("录制打开页面")).toBeVisible();
  await expect(review.getByText("录制登录按钮：testid=login-submit（待校验）")).toBeVisible();
  await expect(review.getByText(/不支持的 iframe/)).toBeVisible();
  await review.getByRole("button", { name: "确认导入" }).click();

  await expect(page.getByText("录制点击登录")).toBeVisible();
  expect(calls.validations).toHaveLength(1);
});
