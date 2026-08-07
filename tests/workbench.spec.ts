import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("starts with the Sauce Demo seed and persists a user-created project", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "测试项目" })).toBeVisible();
  await expect(page.getByText("Sauce Demo 真实验证", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("空工作空间回归");
  await page.getByLabel("项目说明").fill("由测试创建，不依赖预置数据");
  await page.getByRole("button", { name: "创建项目" }).click();

  await expect(page).toHaveURL(/\/project\/project\/overview$/);
  await expect(page.getByText("空工作空间回归", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("空工作空间回归", { exact: true })).toBeVisible();
});

test("persists the automatic Sauce Demo seed in the current browser workspace", async ({ page }) => {
  await page.locator(".project-cell").filter({ hasText: "Sauce Demo 真实验证" }).click();
  await expect(page).toHaveURL(/\/project\/sauce-demo\/overview$/);
  await expect(page.locator(".project-switcher")).toContainText("Sauce Demo 真实验证");

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await expect(page.getByText("Sauce Demo 下单回归", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Sauce Demo 下单回归", { exact: true })).toBeVisible();
  await page.goto("/projects");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const persisted = JSON.parse(localStorage.getItem("autoflow-workspace-projects") ?? "{}");
        const state = persisted.state ?? {};
        return {
          projects: state.projects?.filter((project: { id: string }) => project.id === "sauce-demo").length,
          environments: state.environmentsByProject?.["sauce-demo"]?.length,
          elements: state.elementsByProject?.["sauce-demo"]?.length,
          flows: state.flowsByProject?.["sauce-demo"]?.length,
          activeEnvironment: state.activeEnvironmentByProject?.["sauce-demo"],
        };
      }),
    )
    .toEqual({
      projects: 1,
      environments: 1,
      elements: 12,
      flows: 1,
      activeEnvironment: "sauce-demo-web",
    });
});

test("restores Sauce Demo when a current-version workspace was persisted empty", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [],
          flowsByProject: {},
          elementsByProject: {},
          variablesByProject: {},
          environmentsByProject: {},
          activeEnvironmentByProject: {},
          membersByProject: {},
        },
        version: 6,
      }),
    );
  });
  await page.reload();
  await expect(page.getByText("Sauce Demo 真实验证", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("autoflow-workspace-projects") ?? ""))
    .toContain("sauce-demo");
});

test("removes retired demo storage before resolving an old project route", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => {
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [
            {
              id: "commerce",
              name: "Demo project",
              description: "legacy demo",
              environmentCount: 2,
              flowCount: 3,
              lastRun: "today",
              health: 100,
            },
          ],
          flowsByProject: { commerce: [] },
          elementsByProject: { commerce: [] },
          variablesByProject: { commerce: [] },
          environmentsByProject: { commerce: [] },
          activeEnvironmentByProject: { commerce: "" },
        },
        version: 4,
      }),
    );
  });

  await page.reload();
  await page.goto("/project/commerce/runs");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText("Sauce Demo 真实验证", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const persisted = JSON.parse(localStorage.getItem("autoflow-workspace-projects") ?? "{}");
        return persisted.state?.projects?.length ?? -1;
      }),
    )
    .toBe(1);
});

test("opens the local publish page with a pre-mode persisted workspace", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [{ id: "legacy-local", name: "Legacy local", description: "" }],
          flowsByProject: { "legacy-local": [] },
          elementsByProject: { "legacy-local": [] },
          variablesByProject: { "legacy-local": [] },
          environmentsByProject: { "legacy-local": [] },
          activeEnvironmentByProject: { "legacy-local": "" },
          membersByProject: { "legacy-local": [] },
        },
        version: 7,
      }),
    );
  });

  await page.reload();
  await page.goto("/project/legacy-local/platform");
  await expect(page.getByRole("heading", { name: "发布与远程执行" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "发布当前项目" })).toBeVisible();
});

test("returns a published-project attempt with an invalid session to the Platform login form", async ({ page }) => {
  await page.route("**/api/workspaces/workspace-invalid/imports/local-storage", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "SESSION_INVALID" }),
    }),
  );
  await page.evaluate(() => {
    localStorage.setItem(
      "autoflow-platform-session",
      JSON.stringify({
        token: "expired-token",
        user: { id: "user-invalid", email: "invalid@example.test", name: "Invalid" },
        workspaces: [{ id: "workspace-invalid", name: "Invalid workspace", role: "owner" }],
      }),
    );
    localStorage.setItem("autoflow-platform-workspace", "workspace-invalid");
  });

  await page.goto("/project/sauce-demo/platform");
  await page.getByRole("button", { name: "发布到 Platform" }).click();

  await expect(page.getByText("Platform 登录凭证已失效，请重新登录后重试发布。")).toBeVisible();
  await expect(page.locator(".platform-login-panel button").first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("autoflow-platform-session")))
    .toBeNull();
});
