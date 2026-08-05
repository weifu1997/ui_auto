import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { configurePlatformRunUiMocks } from "./platform-ui-fixtures";

test.setTimeout(120_000);

const elements = [
  ["用户名", "username"],
  ["密码", "password"],
  ["登录", "login-button"],
  ["加入背包", "add-to-cart-sauce-labs-backpack"],
  ["购物车", "shopping-cart-link"],
  ["结算", "checkout"],
  ["名字", "firstName"],
  ["姓氏", "lastName"],
  ["邮编", "postalCode"],
  ["继续", "continue"],
  ["完成订单", "finish"],
  ["订单完成标题", "complete-header"],
] as const;

async function chooseOption(
  page: Page,
  trigger: ReturnType<Page["locator"]>,
  value: string,
  searchable = false,
) {
  await trigger.click();
  if (searchable) await trigger.getByRole("combobox").fill(value);
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .last()
    .locator(`.ant-select-item-option[title="${value}"]`)
    .click();
}

async function addStep(
  page: Page,
  action: string,
  element?: string,
  value = "",
) {
  await page.getByRole("button", { name: "添加步骤" }).click();
  await chooseOption(
    page,
    page.locator(".step-form > label").first().locator(".ant-select"),
    action,
  );
  const valueLabelIndex = element ? 2 : 1;
  if (element) {
    await chooseOption(
      page,
      page.locator(".step-form > label").nth(1).locator(".ant-select"),
      element,
      true,
    );
  }
  if (value) {
    await page
      .locator(".step-form > label")
      .nth(valueLabelIndex)
      .locator("input")
      .fill(value);
  }
  await page.locator(".step-form .form-row label").first().locator("input").fill("30");
}

test("assembles a Sauce Demo login, cart, and checkout Platform run request", async ({ page }) => {
  await page.goto("/projects");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("Sauce Demo 真实验证");
  await page.getByLabel("项目说明").fill("公开演示站点的端到端回归流程");
  await page.getByRole("button", { name: "创建项目" }).click();

  await page.locator(".project-nav-item").filter({ hasText: "环境" }).click();
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.getByLabel("环境名称").fill("Sauce Demo");
  await page.getByLabel("基础地址").fill("https://www.saucedemo.com/");
  await page.getByLabel("默认超时（秒）").fill("20");
  await page.getByRole("button", { name: "保存配置" }).click();

  await page.locator(".project-nav-item").filter({ hasText: "元素库" }).click();
  for (const [name, value] of elements) {
    await page.getByRole("button", { name: "新建元素" }).click();
    await page.getByLabel("元素名称").fill(name);
    await page.getByLabel("所属页面路径").fill("/");
    await chooseOption(page, page.getByLabel("定位方式"), "CSS");
    await page.getByLabel("定位值").fill(`[data-test="${value}"]`);
    await page.getByRole("button", { name: "保存" }).click();
  }
  await expect(page.getByText("订单完成标题", { exact: true })).toBeVisible();

  await page.locator(".project-nav-item").filter({ hasText: "流程" }).click();
  await page.getByRole("button", { name: "新建流程" }).click();
  await page.getByLabel("流程名称").fill("Sauce Demo 下单回归");
  await page.getByRole("button", { name: "创建并编辑" }).click();

  await addStep(page, "打开页面", undefined, "/");
  await addStep(page, "填写", "用户名", "standard_user");
  await addStep(page, "填写", "密码", "secret_sauce");
  await addStep(page, "点击", "登录");
  await addStep(page, "点击", "加入背包");
  await addStep(page, "点击", "购物车");
  await addStep(page, "点击", "结算");
  await addStep(page, "填写", "名字", "Auto");
  await addStep(page, "填写", "姓氏", "Flow");
  await addStep(page, "填写", "邮编", "100000");
  await addStep(page, "点击", "继续");
  await addStep(page, "点击", "完成订单");
  await addStep(page, "文本断言", "订单完成标题", "Thank you for your order!");

  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".editor-topbar").getByRole("button").first().click();
  const projectId = new URL(page.url()).pathname.split("/")[2];
  await configurePlatformRunUiMocks(page, projectId);
  await page.getByRole("button", { name: "运行流程 Sauce Demo 下单回归" }).click();

  await expect(page).toHaveURL(/\/project\/[^/]+\/runs$/);
  await expect(page.getByText("通过", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("13/13", { exact: true })).toBeVisible();
  await page.locator(".run-link").click();
  await expect(page.getByRole("heading", { name: "Sauce Demo 下单回归" })).toBeVisible();
  await expect(page.getByText("trace.zip", { exact: true })).toBeVisible({ timeout: 30_000 });
});
