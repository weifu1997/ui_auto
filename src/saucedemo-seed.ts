import { actionOptions } from "./mock-data";
import type { ElementAsset, Environment, Flow, FlowStep, Project, Variable } from "./mock-data";

const [openPage, click, fill, , , , , , , textAssertion] = actionOptions;

const project: Project = {
  id: "sauce-demo",
  name: "Sauce Demo 真实验证",
  description: "Sauce Demo 登录、购物车与结算的真实站点回归流程",
};

const environment: Environment = {
  id: "sauce-demo-web",
  name: "Sauce Demo",
  description: "Sauce Labs 官方公开演示站点",
  baseUrl: "https://www.saucedemo.com/",
  browser: "Chromium",
  auth: "无认证",
  timeout: 45,
  testIdAttribute: "data-test",
  keepBrowserOpenOnFailure: false,
  color: "teal",
  updatedAt: "已导入",
};

const elementDefinitions = [
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

function createElements(): ElementAsset[] {
  return elementDefinitions.map(([name, testValue]) => ({
    id: `sauce-demo-${testValue}`,
    name,
    description: `Sauce Demo ${name} 元素`,
    path: "/",
    method: "testid",
    value: testValue,
    environment: environment.id,
    validation: "unverified",
    updatedAt: "已导入",
  }));
}

function createSteps(): FlowStep[] {
  const [username, password, login, backpack, cart, checkout, firstName, lastName, postalCode, continueButton, finish, completeHeader] = elementDefinitions.map(([name]) => name);
  const step = (id: string, title: string, action: string, element?: string, value = ""): FlowStep => ({
    id,
    title,
    action,
    element,
    value,
    timeout: 45,
    failurePolicy: "立即失败",
    status: "pending",
  });
  return [
    step("open", "打开 Sauce Demo", openPage, undefined, "/"),
    step("username", "填写用户名", fill, username, "standard_user"),
    step("password", "填写密码", fill, password, "secret_sauce"),
    step("login", "点击登录", click, login),
    step("backpack", "加入 Sauce Labs Backpack", click, backpack),
    step("cart", "打开购物车", click, cart),
    step("checkout", "进入结算", click, checkout),
    step("first-name", "填写名字", fill, firstName, "Auto"),
    step("last-name", "填写姓氏", fill, lastName, "Flow"),
    step("postal-code", "填写邮编", fill, postalCode, "100000"),
    step("continue", "继续结算", click, continueButton),
    step("finish", "完成订单", click, finish),
    step("assert-complete", "断言订单完成", textAssertion, completeHeader, "Thank you for your order!"),
  ];
}

export type SauceDemoSeed = {
  project: Project;
  environment: Environment;
  elements: ElementAsset[];
  variables: Variable[];
  flows: Flow[];
};

export function createSauceDemoSeed(): SauceDemoSeed {
  const definition = createSteps();
  return {
    project,
    environment,
    elements: createElements(),
    variables: [],
    flows: [
      {
        id: "sauce-demo-checkout",
        name: "Sauce Demo 下单回归",
        description: "验证登录、加入购物车和完成订单的真实 UI 流程",
        tags: ["真实站点", "结算"],
        steps: definition.length,
        definition,
        lastStatus: "queued",
        updatedAt: "已导入",
      },
    ],
  };
}
