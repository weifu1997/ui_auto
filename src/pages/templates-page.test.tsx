import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

const mockTemplates = [
  {
    id: "tmpl-1",
    name: "登录流程模板",
    description: "标准账号密码登录",
    category: "认证",
    sourceProjectId: "proj-1",
    sourceRevisionId: "rev-1",
    createdBy: "user-1",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    favorite: false,
    snapshot: {
      flow: {
        id: "flow-1",
        name: "登录流程",
        steps: [
          { id: "s1", action: "点击", element: "登录按钮", elementId: "elem-1", value: "{{project.apiKey}}" },
        ],
        secretNames: ["project.apiKey"],
      },
      elements: [
        { id: "elem-1", name: "登录按钮", method: "css", value: "#submit" },
      ],
      variables: [
        { id: "var-1", name: "apiKey", scope: "项目", secret: true },
      ],
      environments: [
        { id: "env-1", name: "生产环境" },
      ],
    },
  },
];

vi.mock("../platform-api", () => ({
  getPlatformTemplates: vi.fn(async () => ({ templates: mockTemplates })),
  getPlatformTemplate: vi.fn(async (_token, id) => ({
    template: mockTemplates.find((t) => t.id === id) || mockTemplates[0],
  })),
  getPlatformRevisions: vi.fn(async () => ({
    revisions: [
      { id: "rev-2", revisionNumber: 2, status: "published", flowName: "登录流程v2", createdAt: "2026-08-19" },
      { id: "rev-1", revisionNumber: 1, status: "published", flowName: "登录流程v1", createdAt: "2026-08-18" },
    ],
  })),
  getTemplateApplyCandidates: vi.fn(async () => ({
    candidates: [
      { id: "cand-1", name: "目标已有登录按钮", selector: "#target-btn", method: "css" },
    ],
    elements: [],
  })),
  applyPlatformTemplate: vi.fn(async () => ({
    templateId: "tmpl-1",
    projectId: "proj-1",
    created: { flows: ["new-flow-1"], elements: [], variables: ["new-var-1"], environments: [] },
    conflicts: [{ resourceType: "flows", originalName: "登录流程", newName: "登录流程_2" }],
    warnings: [],
  })),
  createPlatformTemplate: vi.fn(),
  updatePlatformTemplate: vi.fn(),
  deletePlatformTemplate: vi.fn(),
  favoritePlatformTemplate: vi.fn(),
  rePublishPlatformTemplate: vi.fn(),
}));

vi.mock("../platform-context", () => ({
  readStoredPlatformSession: () => ({
    token: "mock-token",
    user: { id: "user-1", email: "user@test.com", name: "User", globalRole: null },
    workspaces: [{
      id: "ws-1",
      name: "Workspace",
      role: "admin",
      capabilities: ["project.view", "project.edit", "project.manage", "flow.edit", "element.manage", "variable.manage", "environment.manage", "secret.manage", "release.submit", "release.publish", "run.execute", "dataset.manage", "automation.manage", "member.manage", "invite.manage", "workspace.manage"],
    }],
  }),
  readStoredPlatformWorkspaceId: () => "ws-1",
}));

vi.mock("../workspace-store", () => ({
  useWorkspaceStore: (selector: any) =>
    selector({
      projects: [{ id: "proj-1", name: "目标测试项目" }],
    }),
}));

import { BrowserRouter } from "../router";
import { TemplatesPage } from "./TemplatesPage";

describe("TemplatesPage UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染模板列表卡片并检测到新版本标签", async () => {
    render(<BrowserRouter><TemplatesPage /></BrowserRouter>);
    await waitFor(() => {
      expect(screen.getByText("登录流程模板")).toBeInTheDocument();
    });
    expect(screen.getByText("标准账号密码登录")).toBeInTheDocument();
    expect(screen.getByText("有新版本")).toBeInTheDocument();
  });

  it("点击模板卡片打开应用抽屉，展示三段内容与重映射", async () => {
    const user = userEvent.setup();
    render(<BrowserRouter><TemplatesPage /></BrowserRouter>);
    await waitFor(() => {
      expect(screen.getByText("登录流程模板")).toBeInTheDocument();
    });

    await user.click(screen.getByText("登录流程模板"));

    // 检查抽屉内预览部分
    await waitFor(() => {
      expect(screen.getByText("1. 快照内容预览与勾选")).toBeInTheDocument();
      expect(screen.getByText("2. 元素重映射配置")).toBeInTheDocument();
      expect(screen.getByText("3. 应用模板到项目")).toBeInTheDocument();
    });

    // 流程步骤与元素展示
    expect(screen.getByText(/流程：登录流程/)).toBeInTheDocument();
    expect(screen.getAllByText("登录按钮").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("apiKey")).toBeInTheDocument();

    // 点击应用模板
    const buttons = screen.getAllByRole("button");
    const applyBtn = buttons.find(b => (b.textContent || "").includes("应用模板"))!;
    expect(applyBtn).toBeDefined();
    await user.click(applyBtn);

    // 验证冲突提示展示
    await waitFor(() => {
      expect(screen.getByText("检测到同名资源，已自动重命名（避免覆盖）")).toBeInTheDocument();
      expect(screen.getByText("登录流程_2")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "前往流程编辑器校验元素定位" })).toBeInTheDocument();
    });
  });
});
