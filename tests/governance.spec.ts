import { expect, test } from "@playwright/test";

const session = {
  token: "governance-ui-token",
  user: { id: "owner-1", email: "owner@example.test", name: "Owner" },
  workspaces: [{ id: "workspace-1", name: "Workspace", role: "owner" }],
};

test("renders quality analysis and release audit", async ({ page }) => {
  await page.route("**/api/platform/projects/platform-sauce/analytics", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ analytics: { summary: { totalRuns: 42, successRate: 93, failedRuns: 3 }, trend: [{ date: "2030-01-01", total: 12, success: 11, failed: 1, canceled: 0 }], failureCategories: [{ category: "timeout", count: 2 }], slowSteps: [{ stepId: "checkout", title: "Checkout", count: 8, averageMs: 1600, maxMs: 2400 }], elementImpact: [{ elementId: "checkout-button", name: "Checkout button", runCount: 20, flowCount: 2, failedRuns: 1, lastUsedAt: "2030-01-01T00:00:00.000Z" }] } }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/audit-events", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: [{ id: "audit-1", actorType: "user", actorId: "owner-1", action: "flow_revision.published", targetType: "flow_revision", targetId: "revision-5", detail: {}, createdAt: "2030-01-01T00:00:00.000Z" }] }) }));

  await page.goto("/project/sauce-demo/governance");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value.session));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "sauce-demo": "platform-sauce" }));
  }, { session });
  await page.reload();

  await expect(page.getByRole("heading", { name: "治理分析" })).toBeVisible();
  await expect(page.getByText("93%", { exact: true })).toBeVisible();
  await expect(page.getByText("Checkout button", { exact: true })).toBeVisible();
  await expect(page.getByText("flow_revision.published", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加成员" })).toHaveCount(0);
  if (process.env.CAPTURE_UI === "1") {
    await expect(page.locator(".ant-message-notice")).toHaveCount(0);
    await page.screenshot({ path: "governance-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "governance-mobile.png", fullPage: true });
  }
});
