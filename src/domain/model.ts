import type { AssertMatch, AssertOperator, AssertVisibility } from "./assertions";

export type Project = {
  id: string;
  name: string;
  description: string;
};

export type RunStatus = "success" | "failed" | "running" | "queued" | "canceled";

export type Flow = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: number;
  definition?: FlowStep[];
  lastStatus: RunStatus;
  updatedAt: string;
  // W2-4：模板快照写入的顶层扩展字段，转正为一等类型成员（此前会被
  // normalizeFlow 白名单剥掉，并在同步器整体 PUT 时静默丢失）。
  variables?: Record<string, string>;
  secretNames?: string[];
};

export type FlowStep = {
  id: string;
  title: string;
  action: string;
  element?: string;
  value: string;
  timeout: number;
  failurePolicy: string;
  status: "success" | "failed" | "pending";
  output?: string;
  outputSource?: "text" | "attribute" | "url" | "response";
  outputAttribute?: string;
  outputParameter?: string;
  responseUrl?: string;
  outputPath?: string;
  outputPublic?: boolean;
  // 断言字段：每个字段只属于一种断言类型，枚举互斥，不得跨类型取值。
  // 枚举/缺省由 ./assertions 单源（契约见 .trellis/spec/backend/assertion-field-contract.md）。
  /** 仅文本/属性断言：匹配方式（缺省 contains，兼容既有行为）。 */
  assertMatch?: AssertMatch;
  /** 仅可见性断言：可见/不可见（缺省 visible）。不复用 assertMatch。 */
  assertVisibility?: AssertVisibility;
  /** 仅数量断言：匹配元素个数与期望数的关系（缺省 =）。 */
  assertOperator?: AssertOperator;
  /** 仅属性断言：属性名（如 value / disabled / href / checked / text）。 */
  assertAttribute?: string;
  /** W2-5：文本断言比较前是否做空白归一化；缺省 true，显式 false 关闭。 */
  trimCompare?: boolean;
};

export type ElementAsset = {
  id: string;
  name: string;
  description: string;
  path: string;
  method: string;
  value: string;
  environment: string;
  requiresLogin?: boolean;
  validation: "valid" | "multiple" | "unverified";
  updatedAt: string;
};

export type Variable = {
  id: string;
  name: string;
  description: string;
  value: string;
  scope: "环境" | "项目" | "内置";
  secret: boolean;
  updatedAt: string;
};

export type Environment = {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  browser: string;
  auth: string;
  timeout: number;
  testIdAttribute?: string;
  keepBrowserOpenOnFailure?: boolean;
  /** 无头（后台执行，不弹窗）为默认；设为 false 时运行使用有头可见窗口。 */
  headless?: boolean;
  color: string;
  updatedAt: string;
};

export type Run = {
  id: string;
  flowName: string;
  status: RunStatus;
  environment: string;
  progress: number;
  completedSteps: number;
  totalSteps: number;
  startedAt: string;
  duration: string;
  screenshots: number;
  retries: number;
};

export const actionOptions = [
  "打开页面",
  "点击",
  "填写",
  "清空填写",
  "选择下拉项",
  "勾选",
  "键盘按键",
  "等待",
  "可见性断言",
  "文本断言",
  "数量断言",
  "属性断言",
  "截图",
];
