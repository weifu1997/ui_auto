import { expect, test } from "@playwright/test";

test("runs the seeded flow through the local Worker when Platform is not configured", async ({ page }) => {
  let workerRequest: Record<string, unknown> | undefined;
  const platformRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/platform/") || request.url().includes("/api/workspaces/")) {
      platformRequests.push(request.url());
    }
  });
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.route("**/api/projects/sauce-demo/runs", async (route) => {
    workerRequest = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: "run_local_fallback" }),
    });
  });

  await page.locator(".project-cell").filter({ hasText: "Sauce Demo" }).click();
  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "运行流程 Sauce Demo 下单回归" }).click();

  await expect(page).toHaveURL(/\/project\/sauce-demo\/runs$/);
  expect(workerRequest).toMatchObject({
    flow: { id: "sauce-demo-checkout" },
    environment: { id: "sauce-demo-web" },
  });
  expect(platformRequests).toEqual([]);
});

test("runs from the editor through the local Worker when Platform is not configured", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.route("**/api/projects/sauce-demo/runs", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: "run_local_editor_fallback" }),
    });
  });

  await page.goto("/project/sauce-demo/flows/sauce-demo-checkout/edit");
  await page.getByRole("button", { name: "运行整个流程" }).click();

  await expect(page).toHaveURL(/\/project\/sauce-demo\/runs\/run_local_editor_fallback$/);
});

test("falls back to the local Worker when Platform has no bound online Agent", async ({ page }) => {
  let platformRuns = 0;
  let workerRuns = 0;
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify({
      token: "test-token",
      user: { id: "test-user", email: "test@example.test", name: "Test" },
      workspaces: [{ id: "test-workspace", name: "Test workspace", role: "owner" }],
    }));
    localStorage.setItem("autoflow-platform-workspace", "test-workspace");
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({
      "test-workspace": { "sauce-demo": "platform-sauce-demo" },
    }));
  });
  await page.route("**/api/platform/projects/platform-sauce-demo/revisions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revisions: [{
          id: "published-sauce-demo",
          flowId: "sauce-demo-checkout",
          environmentId: "sauce-demo-web",
          status: "published",
        }],
      }),
    });
  });
  await page.route("**/api/platform/projects/platform-sauce-demo/agent-bindings", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ bindings: [] }) });
  });
  await page.route("**/api/platform/projects/platform-sauce-demo/runs", async (route) => {
    if (route.request().method() === "POST") {
      platformRuns += 1;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "UNEXPECTED" }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs: [] }) });
  });
  await page.route("**/api/projects/sauce-demo/runs", async (route) => {
    workerRuns += 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: "run_unbound_agent_fallback" }),
    });
  });

  await page.locator(".project-cell").filter({ hasText: "Sauce Demo" }).click();
  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "运行流程 Sauce Demo 下单回归" }).click();

  await expect(page).toHaveURL(/\/project\/sauce-demo\/runs$/);
  expect(workerRuns).toBe(1);
  expect(platformRuns).toBe(0);
});
