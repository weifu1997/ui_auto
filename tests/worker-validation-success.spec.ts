import { expect, test } from "@playwright/test";

test("validates an element with the real Worker and presents its result", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "autoflow-workspace-projects",
      JSON.stringify({
        state: {
          projects: [
            {
              id: "validation",
              name: "元素验证回归",
              description: "真实元素验证链路",
              environmentCount: 1,
              flowCount: 0,
              lastRun: "尚未运行",
              health: 100,
            },
          ],
          flowsByProject: { validation: [] },
          elementsByProject: {
            validation: [
              {
                id: "candidates",
                name: "候选按钮",
                description: "Fixture 中的重复定位元素",
                path: "/__fixture/multiple",
                method: "CSS",
                value: ".candidate",
                environment: "fixture",
                validation: "unverified",
                updatedAt: "刚刚",
              },
            ],
          },
          variablesByProject: { validation: [] },
          environmentsByProject: {
            validation: [
              {
                id: "fixture",
                name: "Worker Fixture",
                description: "本地 Worker 测试站点",
                baseUrl: "http://127.0.0.1:8787",
                browser: "Chromium",
                auth: "无认证",
                timeout: 10,
                color: "teal",
                updatedAt: "刚刚",
              },
            ],
          },
          activeEnvironmentByProject: { validation: "fixture" },
        },
        version: 4,
      }),
    );
  });
  await page.reload();
  await page.goto("/project/validation/elements");

  await page.getByRole("button", { name: "验证元素 候选按钮" }).click();
  await page.getByRole("button", { name: "开始验证" }).click();
  await expect(page.getByRole("heading", { name: "发现 3 个匹配元素" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByAltText("Worker 验证截图")).toBeVisible();
  await page.getByRole("button", { name: /完\s*成/ }).click();
  await expect(page.getByText("多个匹配", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("多个匹配", { exact: true })).toBeVisible();
});
