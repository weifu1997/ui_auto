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
};

export type ElementAsset = {
  id: string;
  name: string;
  description: string;
  path: string;
  method: string;
  value: string;
  environment: string;
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
  "截图",
];
