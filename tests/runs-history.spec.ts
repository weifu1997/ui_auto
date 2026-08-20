import { expect, test } from "./platform-test";
import type { Page } from "@playwright/test";
import { platformAdminSession } from "./platform-session-fixture";

const session = platformAdminSession({
  token: "runs-token",
  user: { id: "runs-user", email: "runs@example.test", name: "Runs user" },
  workspaces: [{ id: "runs-workspace", name: "Runs workspace" }],
});

function platformRun(id: string, name: string, status: "running" | "success", createdAt: string) {
  return {
    id,
    projectId: "platform-run",
    revisionId: "revision-1",
    environmentId: "env-1",
    agentId: "agent-1",
    executorType: "managed",
    status,
    snapshot: {
      flow: { id: "flow-1", name },
      environment: { id: "env-1", name: "Env" },
    },
    cancellationRequested: false,
    createdAt,
    updatedAt: createdAt,
    artifacts: [],
    events: [],
    flowOutputs: [],
  };
}

async function seedRunsPage(page: Page, getRuns: () => Array<Record<string, unknown>>) {
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

  await page.route("**/api/workspaces/runs-workspace/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "platform-run",
        workspaceId: "runs-workspace",
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
    body: JSON.stringify({
      data: {
        sourceProjectId: "run-project",
        flows: [],
        elements: [],
        variables: [],
        environments: [],
        activeEnvironmentId: "",
        members: [],
      },
      version: 1,
    }),
  }));
  await page.route("**/api/platform/projects/platform-run/runs**", (route) => {
    const runs = getRuns();
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs, total: runs.length, page: 1, pageSize: 8 }),
    });
  });
  await page.reload();
}

test("loads platform run history on first entry with an empty run store", async ({ page }) => {
  await seedRunsPage(page, () => [
    platformRun("platform-run-1", "Platform history run", "success", "2030-01-01T00:00:00.000Z"),
  ]);
  await page.goto("/project/run-project/runs");

  await expect(page.getByText("Platform history run", { exact: true })).toBeVisible();
  await expect(page.getByText("platform-run-1", { exact: true })).toBeVisible();
  await expect(page.getByText("刷新状态")).toBeVisible();
});

test("shows scheduled or webhook runs without manual refresh while an active run is polling", async ({ page }) => {
  let runs = [
    platformRun("active-run", "Active run", "running", "2030-01-01T00:00:00.000Z"),
  ];
  let requests = 0;
  await seedRunsPage(page, () => {
    requests += 1;
    if (requests > 1) {
      runs = [
        platformRun("active-run", "Active run", "running", "2030-01-01T00:00:00.000Z"),
        platformRun("scheduled-run", "Scheduled run", "success", "2030-01-01T00:01:00.000Z"),
      ];
    }
    return runs;
  });
  await page.goto("/project/run-project/runs");

  await expect(page.getByText("Active run", { exact: true })).toBeVisible();
  await expect(page.getByText("Scheduled run", { exact: true })).toBeVisible({ timeout: 8_000 });
  expect(requests).toBeGreaterThanOrEqual(2);
});
