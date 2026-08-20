import { expect, test } from "./platform-test";
import { platformAdminSession } from "./platform-session-fixture";

const session = platformAdminSession({
  token: "automation-ui-token",
  user: { id: "user-1", email: "automation@example.test", name: "Automation user" },
  workspaces: [{ id: "workspace-1", name: "Workspace" }],
});

test("renders versioned data and creates a published-version schedule", async ({ page }) => {
  let scheduleInput: Record<string, unknown> | undefined;
  await page.route("**/api/platform/projects/sauce-demo/datasets", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ datasets: [{ id: "dataset-1", name: "Accounts", description: "Checkout accounts", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z", latestVersion: { id: "dataset-version-1", datasetId: "dataset-1", projectId: "sauce-demo", versionNumber: 2, columns: ["account", "expectedOrder"], rowCount: 24, checksum: "dataset-checksum", sourceName: "accounts.xlsx", createdAt: "2030-01-01T00:00:00.000Z" } }] }),
  }));
  await page.route("**/api/platform/projects/sauce-demo/revisions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: [{ id: "revision-1", revisionNumber: 5, status: "published", checksum: "checksum", createdBy: "user-1", createdAt: "2030-01-01T00:00:00.000Z", publishedAt: "2030-01-01T00:00:00.000Z", environmentId: "sauce-demo-web" }] }) }));
  await page.route("**/api/platform/projects/sauce-demo/schedules", async (route) => {
    if (route.request().method() === "POST") {
      scheduleInput = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ schedule: { id: "schedule-1" } }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ schedules: [{ id: "schedule-0", revisionId: "revision-1", environmentId: "sauce-demo-web", datasetVersionId: "dataset-version-1", name: "Daily checkout", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai", enabled: true, lastRunAt: null, nextRunAt: "2030-01-02T01:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }] }) });
  });
  await page.route("**/api/platform/projects/sauce-demo/webhook-triggers", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ triggers: [] }) }));
  await page.route("**/api/platform/workspaces/workspace-1/notification-channels", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ channels: [{ id: "channel-1", name: "Quality webhook", type: "webhook", enabled: true, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }] }) }));
  await page.route("**/api/platform/projects/sauce-demo/notification-subscriptions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ subscriptions: [{ channelId: "channel-1", name: "Quality webhook", type: "webhook", channelEnabled: true, onSuccess: false, onFailure: true }] }) }));
  await page.route("**/api/platform/projects/sauce-demo/deliveries**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ deliveries: [], total: 0, page: 1, pageSize: 8 }) }));

  await page.goto("/project/sauce-demo/data");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value.session));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "sauce-demo": "sauce-demo" }));
  }, { session });
  await page.reload();

  await expect(page.getByRole("heading", { name: "数据集" })).toBeVisible();
  await expect(page.getByText("Accounts", { exact: true })).toBeVisible();
  await expect(page.getByText("24", { exact: true })).toBeVisible();

  await page.goto("/project/sauce-demo/automations");
  await expect(page.getByRole("heading", { name: "持续回归" })).toBeVisible();
  await expect(page.getByText("Daily checkout", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建" }).first().click();
  await page.getByLabel("名称").fill("Nightly checkout");
  await page.getByRole("dialog").getByRole("combobox").nth(2).click();
  await page.getByText("Accounts v2 (24 行)", { exact: true }).click();
  await page.getByRole("button", { name: "创建计划" }).click();
  await expect.poll(() => scheduleInput?.datasetVersionId).toBe("dataset-version-1");
  await expect(scheduleInput?.revisionId).toBe("revision-1");
  await expect(page.getByRole("dialog")).toBeHidden();
});
