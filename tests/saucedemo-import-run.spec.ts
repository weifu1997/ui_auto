import { expect, test } from "@playwright/test";
import { configurePlatformRunUiMocks } from "./platform-ui-fixtures";

test.setTimeout(120_000);

test("assembles a Platform run for the automatically seeded Sauce Demo project", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.locator(".project-cell").filter({ hasText: "Sauce Demo 真实验证" }).click();
  await expect(page).toHaveURL(/\/project\/sauce-demo\/overview$/);

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await configurePlatformRunUiMocks(page, "sauce-demo");
  await page.getByRole("button", { name: "运行流程 Sauce Demo 下单回归" }).click();

  await expect(page).toHaveURL(/\/project\/sauce-demo\/runs$/);
  await expect(page.getByText("通过", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("13/13", { exact: true })).toBeVisible();
  await page.locator(".run-link").click();
  await expect(page.getByRole("heading", { name: "Sauce Demo 下单回归" })).toBeVisible();
  await expect(page.getByText("trace.zip", { exact: true })).toBeVisible({ timeout: 30_000 });
});
