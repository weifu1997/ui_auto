import { expect, test } from "./platform-test";
import { installPlatformWorkspaceMock } from "./platform-workspace-fixtures";

test.beforeEach(async ({ page }) => {
  await installPlatformWorkspaceMock(page);
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("creates and restores a server-backed Platform project", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "测试项目" })).toBeVisible();
  await expect(page.getByText("尚未创建测试项目", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("空工作空间回归");
  await page.getByLabel("项目说明").fill("由测试创建，不依赖浏览器种子数据");
  await page.getByRole("button", { name: "创建项目" }).click();

  await expect(page).toHaveURL(/\/project\/project\/overview$/);
  await expect(page.getByText("空工作空间回归", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("空工作空间回归", { exact: true })).toBeVisible();
});

test("discards retired local demo data instead of restoring a product mode", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [{ id: "commerce", name: "Retired demo", description: "legacy demo" }],
          flowsByProject: { commerce: [] },
          elementsByProject: { commerce: [] },
          variablesByProject: { commerce: [] },
          environmentsByProject: { commerce: [] },
          activeEnvironmentByProject: { commerce: "" },
        },
        version: 7,
      }),
    );
  });

  await page.reload();
  await expect(page.getByText("尚未创建测试项目", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("autoflow-workspace-projects") ?? ""))
    .not.toContain("commerce");
});
