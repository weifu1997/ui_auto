import { expect, test } from "./platform-test";
import type { Page } from "@playwright/test";
import { configurePlatformRecordingUiMocks } from "./platform-ui-fixtures";
import { installPlatformWorkspaceMock } from "./platform-workspace-fixtures";

async function createProject(page: Page, name: string) {
  await installPlatformWorkspaceMock(page);
  await page.goto("/projects");
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

async function expectRecordingFormLayout(page: Page) {
  const form = page.locator(".recording-form");
  const fields = form.locator(":scope > label");
  const [formBox, environmentBox, startUrlBox, freshLoginBox] = await Promise.all([
    form.boundingBox(),
    fields.nth(0).boundingBox(),
    fields.nth(1).boundingBox(),
    form.locator(".ant-checkbox-wrapper").boundingBox(),
  ]);
  if (!formBox || !environmentBox || !startUrlBox || !freshLoginBox) {
    throw new Error("录制表单字段未正确渲染");
  }

  expect(environmentBox.y + environmentBox.height).toBeLessThanOrEqual(startUrlBox.y);
  expect(startUrlBox.y + startUrlBox.height).toBeLessThanOrEqual(freshLoginBox.y);
  expect(environmentBox.width).toBeGreaterThanOrEqual(formBox.width - 1);
  expect(startUrlBox.width).toBeGreaterThanOrEqual(formBox.width - 1);
  expect(freshLoginBox.width).toBeGreaterThanOrEqual(formBox.width - 1);

  const [freshLoginCheckboxBox, freshLoginTextBox] = await Promise.all([
    form.locator(".ant-checkbox-wrapper .ant-checkbox").boundingBox(),
    form.locator(".ant-checkbox-wrapper .ant-checkbox-label").boundingBox(),
  ]);
  if (!freshLoginCheckboxBox || !freshLoginTextBox) {
    throw new Error("录制复选框未正确渲染");
  }
  const checkboxCenter =
    freshLoginCheckboxBox.y + freshLoginCheckboxBox.height / 2;
  const textCenter = freshLoginTextBox.y + freshLoginTextBox.height / 2;
  expect(Math.abs(checkboxCenter - textCenter)).toBeLessThanOrEqual(2);
}

test("records, recovers controls, reviews, validates, and imports a flow draft", async ({ page }) => {
  await createProject(page, "录制回归项目");
  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await createEnvironment(page);
  await createFlow(page);

  const calls = await configurePlatformRecordingUiMocks(page, "project");
  await page.locator(".name-link", { hasText: "录制回归流程" }).click();

  await page.getByRole("button", { name: "录制" }).click();
  await expectRecordingFormLayout(page);
  await page.setViewportSize({ width: 480, height: 900 });
  await expectRecordingFormLayout(page);
  await page.getByLabel("录制环境").click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "录制环境" })
    .click();
  await page.getByLabel("录制起始 URL").fill("https://default.example.test/login?token=discarded");
  await page.getByLabel("从头录制（不使用已有登录态）").check();
  await page.getByRole("button", { name: "开始录制" }).click();
  await expect(page.getByRole("button", { name: "暂停录制" })).toBeVisible();

  await expect.poll(() => calls.eventCursors).toEqual(expect.arrayContaining([0, 100]));
  expect(calls.sessions[0]).toMatchObject({
    environmentId: expect.any(String),
    startUrl: "https://default.example.test/login?token=discarded",
    freshLogin: true,
  });

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
  await review.getByRole("button", { name: "校验全部" }).click();
  const importButton = review.getByRole("button", { name: "确认导入" });
  await expect(importButton).toBeEnabled();
  await importButton.click();

  await expect(page.locator(".step-list").getByText("录制点击登录", { exact: true })).toBeVisible();
  expect(calls.validations).toHaveLength(1);
});
