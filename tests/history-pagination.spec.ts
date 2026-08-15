import { expect, test } from "@playwright/test";
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
          projectModesById: { "run-project": "platform-enabled" },
          platformProjectIdsById: { "run-project": "platform-run" },
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
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "sauce-demo": "platform-sauce" }));
  }, { session });
  await page.route("**/api/platform/projects/platform-sauce/deliveries?*", (route) => {
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

  await expect(page.getByText("delivery-paged", { exact: true })).toBeVisible();
  await expect.poll(() => deliveryQuery?.get("deliveryPage")).toBe("2");
  await expect.poll(() => deliveryQuery?.get("deliveryStatus")).toBe("delivered");
  await expect.poll(() => deliveryQuery?.get("deliveryChannel")).toBe("Ops");
});
