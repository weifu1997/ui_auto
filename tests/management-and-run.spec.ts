import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { configurePlatformRunUiMocks } from "./platform-ui-fixtures";

async function createProject(page: Page, name: string) {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill(name);
  await page.getByRole("button", { name: "创建项目" }).click();
}

async function createEnvironment(page: Page, name: string, baseUrl: string) {
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.getByLabel("环境名称").fill(name);
  await page.getByLabel("基础地址").fill(baseUrl);
  await page.getByRole("button", { name: "保存配置" }).click();
}

async function createVariable(
  page: Page,
  name: string,
  value: string,
  scope = "项目变量",
) {
  await page.getByRole("button", { name: "新建变量" }).click();
  await page.getByLabel("变量名").fill(name);
  await page.getByLabel("值", { exact: true }).fill(value);
  if (scope === "环境变量") {
    await page.getByLabel("作用域").click();
    await page
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
      .filter({ hasText: "环境变量" })
      .click();
  }
  await page.getByRole("button", { name: "保存变量" }).click();
}

test("persists managed assets, settings, and project archival", async ({ page }) => {
  await createProject(page, "管理回归项目");

  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await createEnvironment(page, "待编辑环境", "https://before.example.test");
  await page.getByRole("button", { name: "待编辑环境更多操作" }).click();
  await page.getByRole("menuitem", { name: "编辑环境" }).click();
  await page.getByLabel("基础地址").fill("https://after.example.test");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("https://after.example.test", { exact: true })).toBeVisible();

  await page.locator(".project-nav-item").filter({ hasText: "变量" }).click();
  await createVariable(page, "account", "regression-user");
  await createVariable(page, "region", "cn-north", "环境变量");
  await expect(page.getByText("account", { exact: true })).toBeVisible();
  await expect(page.getByText("region", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("account", { exact: true })).toBeVisible();
  await expect(page.getByText("region", { exact: true })).toBeVisible();

  await page.locator(".project-nav-item").filter({ hasText: "项目设置" }).click();
  await page.getByLabel("项目名称").fill("已更新的管理项目");
  await page.getByLabel("项目说明").fill("设置保存后应保持不变");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.reload();
  await expect(page.getByLabel("项目名称")).toHaveValue("已更新的管理项目");

  await page.getByRole("button", { name: "归档项目" }).click();
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText("Sauce Demo 真实验证", { exact: true })).toBeVisible();
});

test("assembles a flow-list Platform run with its active environment and variables", async ({ page }) => {
  await createProject(page, "执行回归项目");

  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await createEnvironment(page, "默认环境", "https://default.example.test");
  await createEnvironment(page, "运行环境", "https://run.example.test");
  await page.locator(".environment-select").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".environment-select")).toContainText("运行环境");

  await page.locator(".project-nav-item").filter({ hasText: "变量" }).click();
  await createVariable(page, "username", "runner");
  await createVariable(page, "region", "cn-north", "环境变量");

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill("从列表运行的流程");
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await page.getByRole("button", { name: "添加步骤" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page).toHaveURL(/\/project\/project\/flows\/flow-\d+\/edit$/);
  await page.locator(".editor-topbar").getByRole("button").first().click();
  await expect(page).toHaveURL(/\/project\/project\/flows$/);

  const calls = await configurePlatformRunUiMocks(page, "project");

  await page.getByRole("button", { name: "运行流程 从列表运行的流程" }).click();
  await expect(page).toHaveURL(/\/project\/project\/runs$/);
  await expect(page.getByText("从列表运行的流程", { exact: true })).toBeVisible();
  expect(calls.revisions).toHaveLength(0);
  expect(calls.runs).toHaveLength(1);
  expect(calls.runs[0]).not.toHaveProperty("revisionId");
});
