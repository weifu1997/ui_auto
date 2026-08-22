import { expect, test } from "./platform-test";
import { platformAdminSession } from "./platform-session-fixture";

const workspaceId = "administration-workspace";
const oneTimeToken = "invite-token-visible-once";
const session = platformAdminSession({
  token: "administration-session-token",
  user: {
    id: "administration-admin",
    email: "administrator@example.test",
    name: "Workspace administrator",
  },
  workspaces: [{ id: workspaceId, name: "Controlled workspace" }],
});

test("admin creates a controlled invitation and its raw link never reaches browser storage", async ({ page }) => {
  let inviteInput: Record<string, unknown> | undefined;
  await page.route(`**/api/workspaces/${workspaceId}/members`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      members: [{
        id: "administration-admin",
        email: "administrator@example.test",
        name: "Workspace administrator",
        enabled: true,
        globalRole: null,
        role: "admin",
        createdAt: "2030-01-01T00:00:00.000Z",
      }],
    }),
  }));
  await page.route(`**/api/workspaces/${workspaceId}/invitations`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ invitations: [] }),
      });
      return;
    }
    inviteInput = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        invitation: {
          id: "invite-1",
          workspaceId,
          email: "invitee@example.test",
          role: "member",
          expiresAt: "2030-01-02T00:00:00.000Z",
          token: oneTimeToken,
        },
      }),
    });
  });

  await page.goto("/workspace/administration");
  await page.evaluate(({ session, workspaceId }) => {
    localStorage.setItem("autoflow-platform-session", JSON.stringify(session));
    localStorage.setItem("autoflow-platform-workspace", workspaceId);
  }, { session, workspaceId });
  await page.reload();

  await expect(page.getByRole("heading", { name: "成员与账户" })).toBeVisible();
  await page.getByRole("button", { name: "邀请成员" }).click();
  await page.getByLabel("邮箱").fill("invitee@example.test");
  await page.getByRole("button", { name: "创建邀请" }).click();

  await expect.poll(() => inviteInput).toEqual({
    email: "invitee@example.test",
    role: "member",
  });
  await expect(page.getByLabel("一次性邀请链接")).toHaveValue(
    new RegExp(`token=${oneTimeToken}$`),
  );
  const persistedBeforeClose = await page.evaluate(() => [localStorage, sessionStorage]
    .flatMap((storage) => Array.from(
      { length: storage.length },
      (_, index) => storage.getItem(storage.key(index) ?? "") ?? "",
    ))
    .join("\n"));
  expect(persistedBeforeClose).not.toContain(oneTimeToken);

  await page.getByRole("button", { name: "已复制或安全保存" }).click();
  await expect(page.getByLabel("一次性邀请链接")).not.toBeVisible();
  const persistedAfterClose = await page.evaluate(() => [localStorage, sessionStorage]
    .flatMap((storage) => Array.from(
      { length: storage.length },
      (_, index) => storage.getItem(storage.key(index) ?? "") ?? "",
    ))
    .join("\n"));
  expect(persistedAfterClose).not.toContain(oneTimeToken);
});
