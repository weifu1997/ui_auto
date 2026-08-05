import { expect, test } from "@playwright/test";

const session = {
  token: "debug-ui-token",
  user: { id: "user-1", email: "debug@example.test", name: "Debug user" },
  workspaces: [{ id: "workspace-1", name: "Workspace", role: "owner" }],
};

const debugSession = {
  id: "debug-session-1",
  projectId: "platform-sauce",
  revisionId: "revision-1",
  environmentId: "sauce-demo-web",
  agentId: "agent-1",
  status: "paused",
  currentStep: 2,
  currentUrl: "https://www.saucedemo.com/inventory.html",
  idleExpiresAt: "2030-01-01T00:15:00.000Z",
  maxExpiresAt: "2030-01-01T02:00:00.000Z",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  agent: { id: "agent-1", name: "Internal Chromium", browserVersion: "Chromium 130", os: "win32", lastSeenAt: "2030-01-01T00:00:00.000Z" },
  artifacts: [{ id: "debug-shot", name: "debug-2.png", contentType: "image/png", createdAt: "2030-01-01T00:00:00.000Z" }],
  events: [{ id: 1, kind: "console.error", data: { message: "fixture console error" }, at: "2030-01-01T00:00:00.000Z" }],
};

test("renders the persistent debug workbench and sends an explicit step command", async ({ page }) => {
  let receivedCommand: Record<string, unknown> | undefined;
  let pickerConfirmation: Record<string, unknown> | undefined;
  await page.route("**/api/platform/projects/platform-sauce/revisions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: [{ id: "revision-1", revisionNumber: 1, status: "published", checksum: "checksum", createdBy: "user-1", createdAt: "2030-01-01T00:00:00.000Z", publishedAt: "2030-01-01T00:00:00.000Z" }] }) }));
  await page.route("**/api/platform/projects/platform-sauce/debug-sessions/debug-session-1/commands", async (route) => {
    receivedCommand = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ session: debugSession }) });
  });
  await page.route("**/api/platform/projects/platform-sauce/debug-sessions/debug-session-1/picker-captures", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ captures: [{ id: "capture-1", sessionId: "debug-session-1", target: "button#save", status: "pending", capturedAt: "2030-01-01T00:00:00.000Z", confirmedAt: null, candidates: [{ method: "testid", value: "save-button", count: 1, score: 98, label: "data-testid: save-button" }] }] }),
  }));
  await page.route("**/api/platform/projects/platform-sauce/debug-sessions/debug-session-1/picker-captures/capture-1/confirm", async (route) => {
    pickerConfirmation = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        element: {
          id: "element-picked-save",
          name: "save-button",
          description: "Captured from a debug browser session",
          path: "/inventory.html",
          method: "testid",
          value: "save-button",
          environment: "sauce-demo-web",
          validation: "verified",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
        documentVersion: 2,
        target: "element",
      }),
    });
  });
  await page.route("**/api/platform/projects/platform-sauce/debug-sessions", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [debugSession] }) }));
  await page.route("**/api/platform/debug-artifacts/debug-shot", (route) => route.fulfill({
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+zNyV0QAAAABJRU5ErkJggg==", "base64"),
  }));

  await page.goto("/project/sauce-demo/debug");
  await page.evaluate((value) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(value.session));
    localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "sauce-demo": "platform-sauce" }));
  }, { session });
  await page.reload();

  await expect(page.getByRole("heading", { name: "调试" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#debug-se" })).toBeVisible();
  await expect(page.locator("img.debug-screenshot")).toBeVisible();
  await expect(page.getByText("save-button", { exact: true })).toBeVisible();
  await page.locator(".picker-candidate-row").getByRole("button").last().click();
  await expect.poll(() => pickerConfirmation?.target).toBe("element");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("autoflow-workspace-projects") ?? "")).toContain("element-picked-save");
  await page.getByRole("button", { name: "跳过" }).click();
  await expect.poll(() => receivedCommand?.command).toBe("skip");
});
