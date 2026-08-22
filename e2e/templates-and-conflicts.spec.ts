import { expect, test } from "./platform-test";
import { platformAdminSession } from "./platform-session-fixture";

const session = platformAdminSession({
  token: "template-ui-token",
  user: { id: "template-owner", email: "owner@example.test", name: "Template owner" },
  workspaces: [{ id: "template-workspace", name: "Template workspace" }],
});

test("publishes, updates, and applies an internal template", async ({ page }) => {
  let published: Record<string, unknown> | undefined;
  let updated: Record<string, unknown> | undefined;
  let applied: Record<string, unknown> | undefined;
  const template = { id: "template-1", name: "Checkout regression", description: "Frozen checkout flow", category: "Regression", sourceProjectId: "template-project", sourceRevisionId: "revision-1", createdBy: "template-owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z", favorite: false };

  await page.route("**/api/workspaces/template-workspace/projects", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      projects: [{
        id: "template-project",
        workspaceId: "template-workspace",
        slug: "template-project",
        name: "Template project",
        description: "",
        archivedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route("**/api/platform/projects/template-project/resources/**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ resources: [] }),
  }));
  await page.route("**/api/platform/projects/template-project/settings", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ settings: { data: { activeEnvironmentId: "" }, version: 1 } }),
  }));
  await page.route("**/api/platform/templates?*", async (route) => {
    if (route.request().method() === "POST") {
      published = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ template: { ...template, id: "template-2", ...published } }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ templates: [template] }) });
  });
  await page.route("**/api/platform/templates/template-1/apply", async (route) => {
    applied = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ templateId: template.id, projectId: applied.projectId, created: { flows: ["flow-copy"] } }) });
  });
  await page.route("**/api/platform/templates/template-1", async (route) => {
    if (route.request().method() === "PATCH") {
      updated = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ template: { ...template, ...updated } }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ template: { ...template, snapshot: { flow: { id: "flow-1" } } } }) });
  });
  await page.route("**/api/platform/projects/template-project/revisions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: [{ id: "revision-1", flowName: "Checkout", revisionNumber: 3, status: "published", checksum: "checksum", createdBy: "template-owner", createdAt: "2030-01-01T00:00:00.000Z", publishedAt: "2030-01-01T00:00:00.000Z", environmentId: "template-environment" }] }) }));

  await page.goto("/templates");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value));
    localStorage.setItem("autoflow-platform-workspace", value.workspaces[0].id);
    localStorage.setItem("autoflow-workspace-projects", JSON.stringify({
      state: {
        projects: [{ id: "template-project", name: "Template project", description: "" }],
        platformProjectIdsById: { "template-project": "template-project" },
      },
      version: 8,
    }));
  }, session);
  await page.reload();

  await expect(page.getByText("Checkout regression", { exact: true })).toBeVisible();
  await page.getByText("Checkout regression", { exact: true }).click();
  await page.getByRole("button", { name: "编辑模板" }).click();
  await page.getByLabel("模板名称").fill("Checkout nightly");
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect.poll(() => updated?.name).toBe("Checkout nightly");
  await page.getByRole("button", { name: "应用模板" }).click();
  await expect.poll(() => applied?.projectId).toBe("template-project");
  await page.getByRole("dialog", { name: "Checkout nightly" }).getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "发布模板" }).click();
  const publishDialog = page.getByRole("dialog", { name: "发布内部模板" });
  await publishDialog.getByLabel("模板名称").fill("New frozen template");
  await publishDialog.getByRole("button", { name: /发\s*布模板/ }).click();
  await expect.poll(() => published?.revisionId).toBe("revision-1");
});
