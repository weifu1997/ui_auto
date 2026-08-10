import { expect, test } from "@playwright/test";

const session = {
  token: "template-ui-token",
  user: { id: "template-owner", email: "owner@example.test", name: "Template owner" },
  workspaces: [{ id: "template-workspace", name: "Template workspace", role: "owner" }],
};

test("publishes, updates, and applies an internal template", async ({ page }) => {
  let published: Record<string, unknown> | undefined;
  let updated: Record<string, unknown> | undefined;
  let applied: Record<string, unknown> | undefined;
  const template = { id: "template-1", name: "Checkout regression", description: "Frozen checkout flow", category: "Regression", sourceProjectId: "sauce-demo", sourceRevisionId: "revision-1", createdBy: "template-owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z", favorite: false };

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
  await page.route("**/api/platform/projects/sauce-demo/revisions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: [{ id: "revision-1", flowName: "Checkout", revisionNumber: 3, status: "published", checksum: "checksum", createdBy: "template-owner", createdAt: "2030-01-01T00:00:00.000Z", publishedAt: "2030-01-01T00:00:00.000Z", environmentId: "sauce-demo-web" }] }) }));

  await page.goto("/templates");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value));
    localStorage.setItem("autoflow-platform-workspace", value.workspaces[0].id);
  }, session);
  await page.reload();

  await expect(page.getByText("Checkout regression", { exact: true })).toBeVisible();
  await page.getByText("Checkout regression", { exact: true }).click();
  await page.getByRole("button", { name: "编辑模板" }).click();
  await page.getByLabel("模板名称").fill("Checkout nightly");
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect.poll(() => updated?.name).toBe("Checkout nightly");
  await page.getByRole("button", { name: "应用模板" }).click();
  await expect.poll(() => applied?.projectId).toBe("sauce-demo");
  await page.getByRole("dialog", { name: "Checkout nightly" }).getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "发布模板" }).click();
  const publishDialog = page.getByRole("dialog", { name: "发布内部模板" });
  await publishDialog.getByLabel("模板名称").fill("New frozen template");
  await publishDialog.getByRole("button", { name: /发\s*布模板/ }).click();
  await expect.poll(() => published?.revisionId).toBe("revision-1");
});

test("shows explicit recovery actions for an optimistic-lock conflict", async ({ page }) => {
  await page.goto("/project/sauce-demo/elements");
  await page.evaluate(() => {
    const persisted = JSON.parse(localStorage.getItem("autoflow-workspace-projects") ?? "{}") as { state?: Record<string, unknown> };
    const state = persisted.state ?? {};
    state.platformSyncErrorById = { ...(state.platformSyncErrorById as Record<string, string> ?? {}), "sauce-demo": "RESOURCE_VERSION_CONFLICT" };
    state.projectModesById = { ...(state.projectModesById as Record<string, string> ?? {}), "sauce-demo": "platform-enabled" };
    localStorage.setItem("autoflow-workspace-projects", JSON.stringify({ ...persisted, state }));
    sessionStorage.setItem("autoflow-conflict-sauce-demo", JSON.stringify({ savedAt: new Date().toISOString(), project: { name: "Sauce Demo", description: "" }, flows: [], elements: [], variables: [], environments: [], activeEnvironmentId: "" }));
  });
  await page.reload();
  await expect(page.getByText("检测到其他成员已更新同一资源", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制本地修改" })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新远端" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新提交" })).toBeVisible();
});
