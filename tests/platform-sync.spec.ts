import { expect, test } from "@playwright/test";

const session = {
  token: "platform-sync-token",
  user: { id: "sync-user", email: "sync@example.test", name: "Sync user" },
  workspaces: [{ id: "workspace-sync", name: "Sync workspace", role: "owner" }],
};

test("hydrates a platform project, persists local edits, and restores them after local cache loss", async ({ page }) => {
  let version = 3;
  let document: Record<string, unknown> = {
    sourceProjectId: "collab-project",
    flows: [],
    elements: [],
    variables: [],
    environments: [{
      id: "collab-environment",
      name: "Collaborative environment",
      description: "",
      baseUrl: "https://example.test",
      browser: "Chromium",
      auth: "无认证",
      timeout: 30,
      testIdAttribute: "data-testid",
      keepBrowserOpenOnFailure: false,
      color: "teal",
      updatedAt: "刚刚",
    }],
    activeEnvironmentId: "collab-environment",
    members: [],
  };
  const savedDocuments: Array<Record<string, unknown>> = [];

  await page.route("**/api/workspaces/workspace-sync/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "platform-collab",
        workspaceId: "workspace-sync",
        sourceProjectId: "collab-project",
        slug: "collaborative-project",
        name: "Collaborative project",
        description: "Platform-backed project",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/platform-collab/document", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { data: Record<string, unknown>; expectedVersion: number };
      expect(body.expectedVersion).toBe(version);
      document = body.data;
      version += 1;
      savedDocuments.push(document);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: document, version }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: document, version }) });
  });

  await page.goto("/projects");
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value));
    localStorage.setItem("autoflow-platform-workspace", value.workspaces[0].id);
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({
      [value.workspaces[0].id]: { "collab-project": "platform-collab" },
    }));
    window.dispatchEvent(new Event("autoflow-platform-context-changed"));
  }, session);

  await expect(page.getByText("Collaborative project", { exact: true })).toBeVisible();
  await page.getByText("Collaborative project", { exact: true }).click();
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await page.getByRole("button", { name: "新建元素" }).click();
  await page.getByLabel("元素名称").fill("platform-saved-element");
  await page.getByLabel("所属页面路径").fill("/saved");
  await page.getByLabel("定位值").fill("saved-element");
  await page.getByRole("button", { name: "保存" }).click();

  await expect.poll(() => savedDocuments).toHaveLength(1);
  expect(JSON.stringify(savedDocuments[0])).toContain("platform-saved-element");

  await page.goto("/projects");
  await page.evaluate(() => {
    localStorage.removeItem("autoflow-workspace-projects");
    localStorage.removeItem("autoflow-platform-document-versions");
  });
  await page.reload();
  await expect(page.getByText("Collaborative project", { exact: true })).toBeVisible();
  await page.getByText("Collaborative project", { exact: true }).click();
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await expect(page.getByText("platform-saved-element", { exact: true })).toBeVisible();
});

test("uses the platform document when a seeded project has no local document version", async ({ page }) => {
  const remoteDocument = {
    sourceProjectId: "sauce-demo",
    flows: [],
    elements: [{
      id: "remote-element",
      name: "remote-only-element",
      description: "",
      path: "/remote",
      method: "testid",
      value: "remote-only",
      environment: "remote-environment",
      validation: "unverified",
      updatedAt: "刚刚",
    }],
    variables: [],
    environments: [{
      id: "remote-environment",
      name: "Remote environment",
      description: "",
      baseUrl: "https://example.test",
      browser: "Chromium",
      auth: "无认证",
      timeout: 30,
      testIdAttribute: "data-testid",
      keepBrowserOpenOnFailure: false,
      color: "teal",
      updatedAt: "刚刚",
    }],
    activeEnvironmentId: "remote-environment",
    members: [],
  };

  await page.route("**/api/workspaces/workspace-sync/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "platform-sauce",
        workspaceId: "workspace-sync",
        sourceProjectId: "sauce-demo",
        slug: "remote-sauce",
        name: "Remote Sauce project",
        description: "Restored from Platform",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/document", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: remoteDocument, version: 8 }),
  }));

  await page.goto("/projects");
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value));
    localStorage.setItem("autoflow-platform-workspace", value.workspaces[0].id);
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({
      [value.workspaces[0].id]: { "sauce-demo": "platform-sauce" },
    }));
    window.dispatchEvent(new Event("autoflow-platform-context-changed"));
  }, session);

  await expect(page.getByText("Remote Sauce project", { exact: true })).toBeVisible();
  await page.getByText("Remote Sauce project", { exact: true }).click();
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await expect(page.getByText("remote-only-element", { exact: true })).toBeVisible();
});

test("retries a transient platform document save failure without another local edit", async ({ page }) => {
  let version = 1;
  let attempts = 0;
  const document: Record<string, unknown> = {
    sourceProjectId: "retry-project",
    flows: [],
    elements: [],
    variables: [],
    environments: [],
    activeEnvironmentId: "",
    members: [],
  };

  await page.route("**/api/workspaces/workspace-sync/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "platform-retry",
        workspaceId: "workspace-sync",
        sourceProjectId: "retry-project",
        slug: "retry-project",
        name: "Retry project",
        description: "",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/platform-retry/document", async (route) => {
    if (route.request().method() === "PUT") {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "PLATFORM_UNAVAILABLE" }) });
        return;
      }
      const body = route.request().postDataJSON() as { data: Record<string, unknown>; expectedVersion: number };
      expect(body.expectedVersion).toBe(version);
      version += 1;
      Object.assign(document, body.data);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: document, version }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: document, version }) });
  });

  await page.goto("/projects");
  await page.evaluate((value) => {
    localStorage.clear();
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value));
    localStorage.setItem("autoflow-platform-workspace", value.workspaces[0].id);
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({
      [value.workspaces[0].id]: { "retry-project": "platform-retry" },
    }));
    window.dispatchEvent(new Event("autoflow-platform-context-changed"));
  }, session);

  await expect(page.getByText("Retry project", { exact: true })).toBeVisible();
  await page.getByText("Retry project", { exact: true }).click();
  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  await page.getByRole("button", { name: "新建元素" }).click();
  await page.getByLabel("元素名称").fill("retry-saved-element");
  await page.getByLabel("所属页面路径").fill("/retry");
  await page.getByLabel("定位值").fill("retry-element");
  await page.getByRole("button", { name: "保存" }).click();

  await expect.poll(() => attempts, { timeout: 10_000 }).toBe(2);
  expect(JSON.stringify(document)).toContain("retry-saved-element");
});
