import { expect, test } from "./platform-test";
import type { Page } from "@playwright/test";
import { configurePlatformRunUiMocks } from "./platform-ui-fixtures";
import { installPlatformWorkspaceMock } from "./platform-workspace-fixtures";

async function createProject(page: Page, name: string) {
  await installPlatformWorkspaceMock(page);
  await page.goto("/projects");
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

async function createFlowWithStep(page: Page, name: string, path: string) {
  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill(name);
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await page.getByRole("button", { name: "添加步骤" }).click();
  await page.locator(".step-form .ant-select").first().click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "打开页面" })
    .click();
  await page.locator(".step-form > label").nth(1).locator("input").fill(path);
  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".editor-topbar").getByRole("button").first().click();
  await expect(page).toHaveURL(/\/project\/project\/flows$/);
}

async function prepareBatchFlows(
  page: Page,
  options?: { batchRunStatus?: "queued" | "running" | "success" | "failed" | "canceled" },
) {
  await createProject(page, "批量执行回归项目");
  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await createEnvironment(page, "默认环境", "https://default.example.test");
  await createFlowWithStep(page, "批量流程甲", "/__fixture/login");
  await createFlowWithStep(page, "批量流程乙", "/__fixture/response-json");

  const calls = await configurePlatformRunUiMocks(page, "project", options);
  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("row", { name: /批量流程甲/ }).locator(".ant-checkbox-input").check();
  await page.getByRole("row", { name: /批量流程乙/ }).locator(".ant-checkbox-input").check();
  await page.getByRole("button", { name: /批量运行（2）/ }).click();
  await page.getByRole("button", { name: "创建批次" }).click();
  return calls;
}

test("submits a serial batch from the flow list and tracks it in the runs center", async ({ page }) => {
  await createProject(page, "批量执行回归项目");
  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await createEnvironment(page, "默认环境", "https://default.example.test");
  await createFlowWithStep(page, "批量流程甲", "/__fixture/login");
  await createFlowWithStep(page, "批量流程乙", "/__fixture/response-json");

  const calls = await configurePlatformRunUiMocks(page, "project");

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("row", { name: /批量流程甲/ }).locator(".ant-checkbox-input").check();
  await page.getByRole("row", { name: /批量流程乙/ }).locator(".ant-checkbox-input").check();
  await page.getByRole("button", { name: /批量运行（2）/ }).click();
  await expect(page.getByRole("dialog").getByText("流程（2 个，共 2 步）")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("串行执行")).toBeVisible();

  await page.getByRole("button", { name: "创建批次" }).click();
  await expect(page).toHaveURL(/\/project\/project\/runs\?batch=platform-batch-1$/);
  await expect(page.getByText("批量运行（2 个流程）").first()).toBeVisible();
  await expect(page.getByText("全部通过").first()).toBeVisible();

  expect(calls.batches).toHaveLength(1);
  expect(calls.batches[0]).toMatchObject({
    environmentId: expect.any(String),
    clientRequestId: expect.any(String),
  });
  expect((calls.batches[0].flowIds as string[]).sort()).toEqual(
    expect.arrayContaining([expect.stringMatching(/^flow-\d+$/), expect.stringMatching(/^flow-\d+$/)]),
  );

  await page.locator(".ant-table-expanded-row .ant-table-row").first().waitFor({ state: "attached" });
  await expect(page.getByText("批量流程甲").first()).toBeVisible();
  await expect(page.getByText("批量流程乙").first()).toBeVisible();
});

test("cancels, retries, and restores a batch from the URL after refresh", async ({ page }) => {
  await prepareBatchFlows(page, { batchRunStatus: "queued" });
  await expect(page).toHaveURL(/\/project\/project\/runs\?batch=platform-batch-1$/);

  await page.getByRole("button", { name: "取消批次 platform-batch-1" }).click();
  await expect(page.getByText("已取消").first()).toBeVisible();
  await page.getByRole("button", { name: "重试批次 platform-batch-1" }).click();

  await expect(page).toHaveURL(/\/project\/project\/runs\?batch=platform-batch-2$/);
  await expect(page.getByText("重试批次（2 个流程）").first()).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/project\/project\/runs\?batch=platform-batch-2$/);
  await expect(page.getByText("重试批次（2 个流程）").first()).toBeVisible();
});
