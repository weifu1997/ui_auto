import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const session = {
  token: "automation-edit-token",
  user: { id: "edit-user", email: "edit@example.test", name: "Edit user" },
  workspaces: [{ id: "workspace-1", name: "Workspace", role: "owner" }],
};

async function installAutomationMocks(page: Page) {
  await page.route("**/api/platform/projects/platform-sauce/datasets", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ datasets: [] }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/revisions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      revisions: [{
        id: "revision-1",
        revisionNumber: 5,
        status: "published",
        checksum: "checksum",
        createdBy: "user-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        publishedAt: "2030-01-01T00:00:00.000Z",
        environmentId: "sauce-demo-web",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/schedules", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      schedules: [{
        id: "schedule-1",
        revisionId: "revision-1",
        environmentId: "sauce-demo-web",
        datasetVersionId: null,
        name: "Daily checkout",
        cron: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
        enabled: true,
        lastRunAt: null,
        nextRunAt: "2030-01-02T01:00:00.000Z",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/webhook-triggers", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      triggers: [{
        id: "trigger-1",
        revisionId: "revision-1",
        environmentId: "sauce-demo-web",
        datasetVersionId: null,
        name: "Release hook",
        enabled: true,
        createdAt: "2030-01-01T00:00:00.000Z",
        lastTriggeredAt: null,
      }],
    }),
  }));
  await page.route("**/api/platform/workspaces/workspace-1/notification-channels", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      channels: [{
        id: "channel-1",
        name: "Ops",
        type: "webhook",
        enabled: true,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/notification-subscriptions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ subscriptions: [] }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/deliveries**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ deliveries: [] }),
  }));
}

async function openAutomations(page: Page) {
  await page.goto("/project/sauce-demo/data");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value.session));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "sauce-demo": "platform-sauce" }));
  }, { session });
  await page.reload();
  await page.goto("/project/sauce-demo/automations");
  await expect(page.getByRole("heading", { name: "持续回归" })).toBeVisible();
}

test("edits an existing schedule", async ({ page }) => {
  let scheduleUpdate: Record<string, unknown> | undefined;
  await installAutomationMocks(page);
  await page.route("**/api/platform/projects/platform-sauce/schedules/schedule-1", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    scheduleUpdate = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ schedule: { id: "schedule-1", ...scheduleUpdate } }),
    });
  });
  await openAutomations(page);

  await page.getByRole("button", { name: "编辑计划 Daily checkout" }).click();
  await page.getByLabel("名称").fill("Nightly updated");
  await page.getByRole("button", { name: "保存计划" }).click();

  await expect.poll(() => scheduleUpdate?.name).toBe("Nightly updated");
  expect(scheduleUpdate?.revisionId).toBe("revision-1");
});

test("rotates a webhook signing secret and shows it once", async ({ page }) => {
  let rotateCalls = 0;
  await installAutomationMocks(page);
  await page.route("**/api/platform/projects/platform-sauce/webhook-triggers/trigger-1/rotate-secret", (route) => {
    rotateCalls += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ triggerId: "trigger-1", signingSecret: "whsec_rotated" }),
    });
  });
  await openAutomations(page);

  await page.getByRole("button", { name: "轮换 Webhook Release hook" }).click();
  await expect(page.getByText("whsec_rotated", { exact: false })).toBeVisible();
  await expect.poll(() => rotateCalls).toBe(1);
});

test("sends a test notification", async ({ page }) => {
  let testCalls = 0;
  await installAutomationMocks(page);
  await page.route("**/api/platform/workspaces/workspace-1/notification-channels/channel-1/test", (route) => {
    testCalls += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tested: true, status: 200, error: null }),
    });
  });
  await openAutomations(page);

  await page.getByRole("button", { name: "测试通知 Ops" }).click();
  await expect.poll(() => testCalls).toBe(1);
  await expect(page.getByText("测试通知已发送", { exact: true })).toBeVisible();
});
