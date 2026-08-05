import { expect, test } from "@playwright/test";

test("does not fabricate an element validation result when Worker task creation fails", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("worker validation");
  await page.getByRole("button", { name: "创建项目" }).click();

  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.getByLabel("环境名称").fill("验证环境");
  await page.getByLabel("基础地址").fill("https://example.test");
  await page.getByRole("button", { name: "保存配置" }).click();

  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await page.getByRole("button", { name: "新建元素" }).click();
  await page.getByLabel("元素名称").fill("验证元素");
  await page.getByLabel("所属页面路径").fill("/");
  await page.getByLabel("定位值").fill("target");
  await page.getByRole("button", { name: "保存" }).click();

  await page.route("**/api/projects/worker-validation/validations", (route) => route.abort());
  await page.getByRole("button", { name: "验证元素 验证元素" }).click();
  await page.getByRole("button", { name: "开始验证" }).click();
  await expect(page.getByText("创建元素验证任务失败，请检查 Playwright Worker。", { exact: true })).toBeVisible();
  await expect(page.getByText("定位器唯一匹配", { exact: true })).toHaveCount(0);
});
