import { expect, test } from "@playwright/test";

const session = {
  token: "governance-ui-token",
  user: { id: "owner-1", email: "owner@example.test", name: "Owner" },
  workspaces: [{ id: "workspace-1", name: "Workspace", role: "owner" }],
};

const analyticsBody = {
  analytics: {
    summary: { totalRuns: 42, successRate: 93, failedRuns: 3, canceledRuns: 0, failedRate: 7, canceledRate: 0 },
    previous: { totalRuns: 40, successRate: 90, failedRuns: 4, canceledRuns: 0, failedRate: 10, canceledRate: 0 },
    trend: [{ date: "2030-01-01", total: 12, success: 11, failed: 1, canceled: 0 }],
    failureCategories: [{ category: "timeout", count: 2, dimension: "message" }],
    slowSteps: [{ stepId: "checkout", title: "Checkout", count: 8, averageMs: 1600, maxMs: 2400 }],
    elementImpact: [{ elementId: "checkout-button", name: "Checkout button", runCount: 20, flowCount: 2, failedRuns: 1, lastUsedAt: "2030-01-01T00:00:00.000Z" }],
    runDurations: [{ date: "2030-01-01", averageMs: 1200, count: 5 }],
    scheduleHealth: { triggered: 8, skipped: 1, successRate: 89 },
  },
};

test("renders quality analysis, audit log and release audit", async ({ page }) => {
  await page.route("**/api/platform/projects/platform-sauce/analytics*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(analyticsBody),
  }));
  await page.route("**/api/platform/projects/platform-sauce/audit-events*", (route) => {
    const url = new URL(route.request().url());
    // 发布审计面板走 action=flow_revision. 过滤；审计日志面板走全量分页查询。
    const body = url.searchParams.get("action") === "flow_revision."
      ? { events: [{ id: "audit-1", actorType: "user", actorId: "owner-1", action: "flow_revision.published", targetType: "flow_revision", targetId: "revision-5", detail: {}, createdAt: "2030-01-01T00:00:00.000Z" }], total: 1, page: 1, pageSize: 12 }
      : { events: [{ id: "audit-2", actorType: "user", actorId: "owner-1", action: "auth.login_succeeded", targetType: "user", targetId: "owner-1", detail: { ip: "127.0.0.1" }, createdAt: "2030-01-01T00:00:00.000Z" }], total: 1, page: 1, pageSize: 20 };
    route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/project/sauce-demo/governance");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value.session));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "sauce-demo": "platform-sauce" }));
  }, { session });
  await page.reload();

  await expect(page.getByRole("heading", { name: "治理分析" })).toBeVisible();
  await expect(page.getByText("93%", { exact: true })).toBeVisible();
  await expect(page.getByText("↑3", { exact: true })).toBeVisible();
  await expect(page.getByText("Checkout button", { exact: true })).toBeVisible();
  await expect(page.getByText("flow_revision.published", { exact: true })).toBeVisible();
  // 审计日志面板：全量事件、筛选器与脱敏详情。
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();
  await expect(page.getByText("auth.login_succeeded", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加成员" })).toHaveCount(0);
  // 新增指标面板：运行时长与调度健康度。
  await expect(page.getByRole("heading", { name: "运行时长" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "调度健康度" })).toBeVisible();
  await expect(page.getByText("89%", { exact: true })).toBeVisible();
  if (process.env.CAPTURE_UI === "1") {
    await expect(page.locator(".ant-message-notice")).toHaveCount(0);
    await page.screenshot({ path: "governance-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "governance-mobile.png", fullPage: true });
  }
});
