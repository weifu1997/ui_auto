import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { platformAdminSession } from "./platform-session-fixture";

const session = platformAdminSession({
  user: { id: "sync-user", email: "sync@example.test", name: "Sync user" },
  workspaces: [{ id: "workspace-sync", name: "Sync workspace" }],
});

const environment = {
  id: "env-1",
  name: "Production environment",
  description: "",
  baseUrl: "https://example.test",
  browser: "Chromium",
  auth: "无认证",
  timeout: 30,
  testIdAttribute: "data-testid",
  keepBrowserOpenOnFailure: false,
  color: "teal",
  updatedAt: "刚刚",
};

async function installProductionWorkspace(page: Page, options: {
  getElements: () => Array<Record<string, unknown>>;
  onElementWrite?: (
    attempt: number,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
  ) => Promise<{ status?: number; error?: string } | void> | { status?: number; error?: string } | void;
}) {
  let version = 1;
  let writeAttempts = 0;
  await page.route("**/api/auth/session", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(session),
  }));
  await page.route("**/api/workspaces/workspace-sync/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "production-p",
        workspaceId: "workspace-sync",
        sourceProjectId: "production-p",
        slug: "production-project",
        name: "Production project",
        description: "",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/production-p/settings", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      settings: { data: { activeEnvironmentId: environment.id }, version: 1 },
    }),
  }));
  await page.route("**/api/platform/projects/production-p/resources/**", async (route) => {
    const request = route.request();
    const segments = new URL(request.url()).pathname.split("/").filter(Boolean);
    const type = segments.at(-2) === "resources" ? segments.at(-1)! : segments.at(-2)!;
    if (request.method() === "GET") {
      const resources = type === "elements"
        ? options.getElements().map((data) => ({
            id: data.id,
            data,
            version,
            archivedAt: null,
            updatedAt: "2030-01-01T00:00:00.000Z",
            updatedBy: session.user.id,
          }))
        : type === "environments"
          ? [{ id: environment.id, data: environment, version, archivedAt: null, updatedAt: "2030-01-01T00:00:00.000Z", updatedBy: session.user.id }]
          : [];
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ resources }),
      });
      return;
    }
    if ((request.method() === "POST" && type === "elements") || (request.method() === "PUT" && type === "elements")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      const result = await options.onElementWrite?.(++writeAttempts, request.method() as "POST" | "PUT", body);
      if (result?.status && result.status !== 200) {
        await route.fulfill({
          status: result.status,
          contentType: "application/json",
          body: JSON.stringify({ error: result.error ?? "PLATFORM_UNAVAILABLE" }),
        });
        return;
      }
      version += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          resource: {
            id: String(body.id),
            data: body.data,
            version,
            archivedAt: null,
            updatedAt: "2030-01-01T00:00:01.000Z",
            updatedBy: session.user.id,
          },
        }),
      });
      return;
    }
    await route.continue();
  });
}

async function createElement(page: Page, name: string) {
  await page.getByRole("button", { name: "新建元素" }).click();
  await page.getByLabel("元素名称").fill(name);
  await page.getByLabel("所属页面路径").fill("/saved");
  await page.getByLabel("定位值").fill("saved-element");
  await page.getByRole("button", { name: "保存" }).click();
}

test("restores and retries a saved edit after reload", async ({ page }) => {
  let serverElements: Array<Record<string, unknown>> = [];
  let putAttempts = 0;
  let savedElement: Record<string, unknown> | undefined;
  await installProductionWorkspace(page, {
    getElements: () => serverElements,
    onElementWrite: async (attempt, _method, body) => {
      putAttempts = attempt;
      if (attempt === 1) {
        return { status: 503, error: "PLATFORM_UNAVAILABLE" };
      }
      savedElement = body.data as Record<string, unknown>;
      serverElements = [body.data as Record<string, unknown>];
    },
  });

  await page.goto("/projects");
  await expect(page.getByText("Production project", { exact: true })).toBeVisible();
  await page.getByText("Production project", { exact: true }).click();
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await createElement(page, "production-saved-element");

  await expect.poll(() => page.evaluate(() => localStorage.getItem("autoflow-sync-outbox-v1") ?? "")).toContain("production-saved-element");
  await page.reload();

  await expect.poll(() => putAttempts, { timeout: 10_000 }).toBeGreaterThan(1);
  expect(savedElement).toMatchObject({ name: "production-saved-element" });
  await expect(page.getByText("production-saved-element", { exact: true })).toBeVisible();
});

test("keeps the draft on conflict and resubmits against the latest version", async ({ page }) => {
  let serverElements: Array<Record<string, unknown>> = [{
    id: "element-1",
    name: "server-element",
    description: "",
    path: "/remote",
    method: "testid",
    value: "remote-value",
    environment: "env-1",
    validation: "unverified",
    updatedAt: "刚刚",
  }];
  let putAttempts = 0;
  let savedElement: Record<string, unknown> | undefined;
  await installProductionWorkspace(page, {
    getElements: () => serverElements,
    onElementWrite: async (attempt, _method, body) => {
      putAttempts = attempt;
      if (attempt === 1) {
        serverElements = [{
          id: "element-1",
          name: "server-element",
          description: "",
          path: "/remote",
          method: "testid",
          value: "remote-value",
          environment: "env-1",
          validation: "unverified",
          updatedAt: "刚刚",
        }];
        return { status: 409, error: "RESOURCE_VERSION_CONFLICT" };
      }
      savedElement = body.data as Record<string, unknown>;
      serverElements = [body.data as Record<string, unknown>];
    },
  });

  await page.goto("/projects");
  await expect(page.getByText("Production project", { exact: true })).toBeVisible();
  await page.getByText("Production project", { exact: true }).click();
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await page.getByRole("button", { name: "编辑元素 server-element" }).click();
  await page.getByLabel("元素名称").fill("local-element");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(page.getByText("检测到其他成员已更新同一资源", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("autoflow-sync-outbox-v1") ?? "")).toContain("local-element");

  await page.getByRole("button", { name: "重新提交" }).click();
  await expect.poll(() => putAttempts, { timeout: 10_000 }).toBe(2);
  expect(savedElement).toMatchObject({ name: "local-element" });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("autoflow-sync-outbox-v1") ?? "[]")).toBe("[]");
});

test("refreshing after conflict drops the local draft and restores the server element", async ({ page }) => {
  const serverElements: Array<Record<string, unknown>> = [{
    id: "element-1",
    name: "server-element",
    description: "",
    path: "/remote",
    method: "testid",
    value: "remote-value",
    environment: "env-1",
    validation: "unverified",
    updatedAt: "刚刚",
  }];
  let putAttempts = 0;
  await installProductionWorkspace(page, {
    getElements: () => serverElements,
    onElementWrite: async (attempt) => {
      putAttempts = attempt;
      return { status: 409, error: "RESOURCE_VERSION_CONFLICT" };
    },
  });

  await page.goto("/projects");
  await expect(page.getByText("Production project", { exact: true })).toBeVisible();
  await page.getByText("Production project", { exact: true }).click();
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await page.getByRole("button", { name: "编辑元素 server-element" }).click();
  await page.getByLabel("元素名称").fill("local-element");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(page.getByText("检测到其他成员已更新同一资源", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "刷新远端" }).click();

  await expect(page.getByText("server-element", { exact: true })).toBeVisible();
  await expect(page.getByText("local-element", { exact: true })).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("autoflow-sync-outbox-v1") ?? "[]")).toBe("[]");
  expect(putAttempts).toBe(1);
});
