import { expect, test } from "@playwright/test";
import { configurePlatformRunUiMocks } from "./platform-ui-fixtures";

test("injects a secret only for the current run and asks again after a refresh", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [{ id: "secret-ui", name: "Secret UI", description: "" }],
          flowsByProject: {
            "secret-ui": [
              {
                id: "secret-flow",
                name: "密钥流程",
                description: "",
                tags: [],
                steps: 1,
                lastStatus: "queued",
                updatedAt: "now",
                definition: [
                  {
                    id: "open",
                    title: "open",
                    action: "打开页面",
                    value: "{{project.密码}}",
                    timeout: 10,
                    failurePolicy: "立即失败",
                    status: "pending",
                  },
                ],
              },
            ],
          },
          elementsByProject: { "secret-ui": [] },
          variablesByProject: {
            "secret-ui": [
              {
                id: "password",
                name: "密码",
                description: "",
                value: "",
                scope: "项目",
                secret: true,
                updatedAt: "now",
              },
            ],
          },
          environmentsByProject: {
            "secret-ui": [
              {
                id: "fixture",
                name: "Fixture",
                description: "",
                baseUrl: "http://127.0.0.1:8787",
                browser: "Chromium",
                auth: "无认证",
                timeout: 10,
                color: "teal",
                updatedAt: "now",
              },
            ],
          },
          activeEnvironmentByProject: { "secret-ui": "fixture" },
          membersByProject: { "secret-ui": [] },
        },
        version: 6,
      }),
    );
  });
  await page.reload();
  await page.goto("/project/secret-ui/flows");
  const calls = await configurePlatformRunUiMocks(page, "secret-ui");
  await page.getByRole("button", { name: "运行流程 密钥流程" }).click();
  await expect(page.getByRole("dialog")).toContainText("运行前注入密钥");
  await page.getByLabel("运行密钥 密码").fill("only-in-memory");
  await page.getByRole("button", { name: "注入并运行" }).click();
  await expect.poll(() => calls.secrets.length).toBe(1);
  expect(calls.secrets[0]).toMatchObject({ name: "project.密码", value: "only-in-memory" });
  await expect.poll(() => page.url()).toContain("/project/secret-ui/runs");
  await expect.poll(() => page.evaluate(() => JSON.stringify(localStorage))).not.toContain("only-in-memory");

  await page.reload();
  await page.goto("/project/secret-ui/flows");
  await page.getByRole("button", { name: "运行流程 密钥流程" }).click();
  await expect(page.getByRole("dialog")).toContainText("运行前注入密钥");
  await expect(page.getByLabel("运行密钥 密码")).toHaveValue("");
});
