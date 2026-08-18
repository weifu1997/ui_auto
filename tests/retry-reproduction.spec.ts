import { expect, test } from "./platform-test";
import type { Page } from "@playwright/test";
import { configureRetryReproductionUiMocks } from "./platform-ui-fixtures";
import { installPlatformWorkspaceMock } from "./platform-workspace-fixtures";

async function prepareRetryFlow(page: Page) {
  await installPlatformWorkspaceMock(page);
  await page.goto("/projects");
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("Retry 快照重现项目");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.getByLabel("环境名称").fill("默认环境");
  await page.getByLabel("基础地址").fill("https://default.example.test");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill("重现流程");
  await page.getByRole("button", { name: "创建并编辑" }).click();
  await page.getByRole("button", { name: "添加步骤" }).click();
  await page.locator(".step-form .ant-select").first().click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "打开页面" })
    .click();
  await page.locator(".step-form > label").nth(1).locator("input").fill("/retry-fixture");
  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".editor-topbar").getByRole("button").first().click();
  await expect(page).toHaveURL(/\/project\/project\/flows$/);
  await page.goto("/project/project/runs");
}

test("uses current published revision for fresh-run and exact A snapshot for retry", async ({ page }) => {
  await prepareRetryFlow(page);
  const calls = await configureRetryReproductionUiMocks(page, "project");
  await page.reload();

  const successSource = page.getByRole("row", { name: /source-success-a/ });
  await successSource.getByRole("button", { name: "再次运行（新运行） 重现流程" }).click();
  await expect(page).toHaveURL(/\/project\/project\/runs\/fresh-b-1$/);

  expect(calls.runs).toHaveLength(1);
  expect(calls.runs[0]).toMatchObject({ flowId: expect.stringMatching(/^flow-\d+$/), environmentId: expect.any(String) });
  expect(calls.runs[0]).not.toHaveProperty("revisionId");
  expect(calls.createdRuns).toHaveLength(2);
  expect(calls.createdRuns).toEqual(expect.arrayContaining([
    expect.objectContaining({ revisionId: "revision-retry-b", retryOfRunId: null, snapshot: expect.objectContaining({ flowRevisionChecksum: "checksum-retry-b", datasetRow: { number: 1, data: { account: "current-1" } } }) }),
    expect.objectContaining({ revisionId: "revision-retry-b", retryOfRunId: null, snapshot: expect.objectContaining({ flowRevisionChecksum: "checksum-retry-b", datasetRow: { number: 2, data: { account: "current-2" } } }) }),
  ]));

  await page.goto("/project/project/runs");
  const failedSource = page.getByRole("row", { name: /source-failed-a/ });
  await failedSource.getByRole("button", { name: "重试 重现流程" }).click();
  await expect(page).toHaveURL(/\/project\/project\/runs\/retry-failed-a$/);

  expect(calls.retryRunIds).toEqual(["source-failed-a"]);
  expect(calls.createdRuns).toHaveLength(3);
  expect(calls.createdRuns?.[2]).toMatchObject({
    revisionId: "revision-retry-a",
    retryOfRunId: "source-failed-a",
    snapshot: {
      flowRevisionChecksum: "checksum-retry-a",
      datasetRow: { number: 2, data: { account: "historical-failed-a" } },
    },
  });
  await expect(page.getByText("重试自")).toBeVisible();
  await page.getByRole("button", { name: "查看源运行 source-failed-a" }).click();
  await expect(page).toHaveURL(/\/project\/project\/runs\/source-failed-a$/);

  await page.goto("/project/project/runs");
  const beforeInvalidAttempts = calls.runs.length;
  const beforeInvalidCreated = calls.createdRuns?.length;
  await page.getByRole("row", { name: /source-missing-flow/ })
    .getByRole("button", { name: "再次运行（新运行） 缺少流程标识" })
    .click();
  expect(calls.runs).toHaveLength(beforeInvalidAttempts);
  expect(calls.createdRuns).toHaveLength(beforeInvalidCreated ?? 0);

  await page.getByRole("row", { name: /source-no-published/ })
    .getByRole("button", { name: "再次运行（新运行） 重现流程" })
    .click();
  await expect.poll(() => calls.runs.length).toBe(beforeInvalidAttempts + 1);
  expect(calls.createdRuns).toHaveLength(beforeInvalidCreated ?? 0);

  await expect(page.getByRole("row", { name: /source-running-a/ })
    .getByRole("button", { name: /重试|再次运行/ })).toHaveCount(0);
});
