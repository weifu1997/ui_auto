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
