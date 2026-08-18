import { expect, test } from "./platform-test";
import type { Page } from "@playwright/test";

const session = {
  token: "pagination-token",
  user: { id: "pagination-user", email: "pagination@example.test", name: "Pagination user" },
  workspaces: [{ id: "pagination-workspace", name: "Pagination workspace", role: "owner" }],
};

async function seedRunsWorkspace(page: Page, getRuns: () => Array<Record<string, unknown>>, onQuery: (query: URLSearchParams) => void) {
  await page.goto("/projects");
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value.session));
    localStorage.setItem("autoflow-platform-workspace", value.session.workspaces[0].id);
    localStorage.setItem(
      "autoflow-platform-project-map",
      JSON.stringify({
        [value.session.workspaces[0].id]: { "run-project": "platform-run" },
      }),
    );
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [{ id: "run-project", name: "Run project", description: "" }],
          flowsByProject: { "run-project": [] },
          elementsByProject: { "run-project": [] },
          variablesByProject: { "run-project": [] },
          environmentsByProject: { "run-project": [] },
          activeEnvironmentByProject: { "run-project": "" },
          platformSyncStatusById: { "run-project": "synced" },
          platformSyncErrorById: {},
        },
        version: 7,
      }),
    );
  }, { session });
  await page.route("**/api/workspaces/pagination-workspace/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "platform-run",
        workspaceId: "pagination-workspace",
        sourceProjectId: "run-project",
        slug: "run-project",
        name: "Run project",
        description: "",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/platform-run/document", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: { sourceProjectId: "run-project", flows: [], elements: [], variables: [], environments: [], activeEnvironmentId: "", members: [] }, version: 1 }),
  }));
  await page.route("**/api/platform/projects/platform-run/runs?*", (route) => {
    onQuery(new URL(route.request().url()).searchParams);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: getRuns(), total: 25, page: 2, pageSize: 8 }),
    });
  });
  await page.route("**/api/platform/projects/platform-run/runs", (route) => {
    onQuery(new URL(route.request().url()).searchParams);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: getRuns(), total: 25, page: 1, pageSize: 8 }),
    });
  });
  await page.reload();
}

test("restores run filters and page from URL", async ({ page }) => {
  let query: URLSearchParams | undefined;
  await seedRunsWorkspace(page, () => [{
    id: "paged-run",
    projectId: "platform-run",
    revisionId: "revision-1",
    environmentId: "env-1",
    agentId: "agent-1",
    executorType: "managed",
    status: "success",
    snapshot: { flow: { name: "Checkout" }, environment: { name: "Env" } },
    cancellationRequested: false,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    artifacts: [],
    events: [],
    flowOutputs: [],
  }], (value) => { query = value; });

  await page.goto("/project/run-project/runs?status=success&flow=Checkout&source=schedule&page=2");
  await expect(page.getByText("paged-run", { exact: true })).toBeVisible();
  await expect.poll(() => query?.get("page")).toBe("2");
  await expect.poll(() => query?.get("status")).toBe("success");
  await expect.poll(() => query?.get("flow")).toBe("Checkout");
});

test("restores delivery filters and page from URL", async ({ page }) => {
  let deliveryQuery: URLSearchParams | undefined;
  await page.goto("/project/sauce-demo/data");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value.session));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "sauce-demo": "sauce-demo" }));
  }, { session });
  await page.route("**/api/workspaces/pagination-workspace/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "sauce-demo",
        workspaceId: "pagination-workspace",
        slug: "sauce-demo",
        name: "Sauce Demo",
        description: "",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/sauce-demo/resources/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ resources: [] }) }));
  await page.route("**/api/platform/projects/sauce-demo/settings", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ settings: { data: { activeEnvironmentId: "" }, version: 1 } }) }));
  await page.route("**/api/platform/projects/sauce-demo", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: { id: "sauce-demo", workspaceId: "pagination-workspace", sourceProjectId: "sauce-demo", name: "Sauce Demo" } }) }));
  await page.route("**/api/platform/projects/sauce-demo/datasets", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ datasets: [] }) }));
  await page.route("**/api/platform/projects/sauce-demo/revisions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: [{ id: "revision-1", revisionNumber: 5, status: "published", checksum: "checksum", createdBy: "user-1", createdAt: "2030-01-01T00:00:00.000Z", publishedAt: "2030-01-01T00:00:00.000Z", environmentId: "sauce-demo-web" }] }) }));
  await page.route("**/api/platform/projects/sauce-demo/schedules", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ schedules: [] }) }));
  await page.route("**/api/platform/projects/sauce-demo/webhook-triggers", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ triggers: [] }) }));
  await page.route("**/api/platform/workspaces/pagination-workspace/notification-channels", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ channels: [] }) }));
  await page.route("**/api/platform/projects/sauce-demo/notification-subscriptions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ subscriptions: [] }) }));
  await page.route("**/api/platform/projects/sauce-demo/deliveries?*", (route) => {
    deliveryQuery = new URL(route.request().url()).searchParams;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        deliveries: [{
          id: "delivery-paged",
          runId: "run-1",
          status: "delivered",
          attempts: 1,
          responseCode: 200,
          error: null,
          createdAt: "2030-01-01T00:00:00.000Z",
          deliveredAt: "2030-01-01T00:00:01.000Z",
          channel: { name: "Ops", type: "webhook" },
        }],
        total: 30,
        page: 2,
        pageSize: 8,
      }),
    });
  });
  await page.reload();
  await page.goto("/project/sauce-demo/automations?deliveryStatus=delivered&deliveryChannel=Ops&deliveryPage=2");

  // 投递表当前渲染 通道/状态/时间 三列，不显示 id；断言真实渲染的数据行。
  await expect(page.getByRole("row", { name: /Ops/ })).toBeVisible();
  // API 请求参数为 page/status/channel（页面 URL 参数 deliveryPage 等经 URL 恢复后映射）。
  await expect.poll(() => deliveryQuery?.get("page")).toBe("2");
  await expect.poll(() => deliveryQuery?.get("status")).toBe("delivered");
  await expect.poll(() => deliveryQuery?.get("channel")).toBe("Ops");
});
