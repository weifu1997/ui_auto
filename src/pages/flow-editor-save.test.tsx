import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

const mockProject = {
  id: "proj-test",
  name: "测试项目",
  description: "",
};

const mockFlow = {
  id: "flow-new",
  name: "新导入流程",
  description: "",
  tags: [],
  steps: 1,
  definition: [
    { id: "s1", title: "步骤1", action: "打开页面", value: "https://test.com", timeout: 10, failurePolicy: "立即失败", status: "pending" },
  ],
  lastStatus: "queued",
  updatedAt: "刚刚",
};

const mockEnvironment = {
  id: "env-1",
  name: "测试环境",
  description: "",
  baseUrl: "https://test.com",
  browser: "Chromium",
  auth: "无认证",
  timeout: 30,
  testIdAttribute: "data-testid",
  color: "teal",
  updatedAt: "刚刚",
};

vi.mock("../router", () => ({
  useParams: () => ({ projectId: "proj-test", flowId: "flow-new" }),
  useNavigate: () => vi.fn(),
  Navigate: () => null,
}));

let mockRevisionsList: any[] = [];
const mockCreatePlatformRevision = vi.fn(async (..._args: any[]) => ({ revision: { id: "rev-created", revisionNumber: 1 } }));
const mockCreatePlatformRun = vi.fn(async (..._args: any[]) => ({ runs: [{ id: "run-1", status: "queued" }], runIds: ["run-1"] }));

vi.mock("../api/platform-api", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
  getPlatformRevisions: vi.fn(async () => ({ revisions: mockRevisionsList })),
  createPlatformRevision: (token: string, pid: string, input: any) => mockCreatePlatformRevision(token, pid, input),
  createPlatformRun: (token: string, pid: string, input: any) => mockCreatePlatformRun(token, pid, input),
  createPlatformElementValidation: vi.fn(),
  getPlatformElementValidation: vi.fn(),
  savePlatformSecret: vi.fn(),
  cancelActiveRecordingSession: vi.fn(),
  cancelRecordingSession: vi.fn(),
  createRecordingSession: vi.fn(),
  getRecordingEvents: vi.fn(),
  getRecordingSession: vi.fn(),
  pauseRecordingSession: vi.fn(),
  resumeRecordingSession: vi.fn(),
  stopRecordingSession: vi.fn(),
  };
});

vi.mock("../api/platform-context", () => ({
  platformProjectContext: (projectId: string) => ({
    session: { token: "token-1", user: { id: "u1" }, workspaces: [] },
    projectId,
  }),
}));

vi.mock("../stores/workspace-store", () => ({
  useWorkspaceStore: (selector: any) =>
    selector({
      projects: [mockProject],
      flowsByProject: { "proj-test": [mockFlow] },
      elementsByProject: { "proj-test": [] },
      variablesByProject: { "proj-test": [] },
      environmentsByProject: { "proj-test": [mockEnvironment] },
      activeEnvironmentByProject: { "proj-test": "env-1" },
      setFlows: vi.fn(),
    }),
}));

import FlowEditorPage from "./FlowEditorPage";

describe("FlowEditorPage Save & Run with no published revision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevisionsList = [];
  });

  it("无已发布版本的流程打开时，保存按钮处于可点击状态（解除置灰）", async () => {
    mockRevisionsList = []; // 没有 published revision
    render(<FlowEditorPage />);

    // 等待异步检查完成
    await waitFor(() => {
      const saveBtn = screen.getByRole("button", { name: /保\s*存/ });
      expect(saveBtn).not.toBeDisabled();
    });
  });

  it("已有 published 版本的流程且未做修改时，保存按钮处于置灰状态", async () => {
    mockRevisionsList = [{ id: "rev-1", flowId: "flow-new", status: "published" }];
    render(<FlowEditorPage />);

    await waitFor(() => {
      const saveBtn = screen.getByRole("button", { name: /保\s*存/ });
      expect(saveBtn).toBeDisabled();
    });
  });

  it("无 published 版本的流程直接点击运行，会自动先发布版本再创建运行", async () => {
    const user = userEvent.setup();
    mockRevisionsList = []; // 无版本
    render(<FlowEditorPage />);

    await waitFor(() => {
      const runBtn = screen.getByRole("button", { name: /运行整个流程/ });
      expect(runBtn).not.toBeDisabled();
    });

    const runBtn = await screen.findByRole("button", { name: /运行整个流程/ });
    await user.click(runBtn);

    await waitFor(() => {
      expect(mockCreatePlatformRevision).toHaveBeenCalledTimes(1);
      expect(mockCreatePlatformRun).toHaveBeenCalledTimes(1);
    });
  });

  it("点击保存会直接发布快照版本，且 getPlatformRevisions 仅请求一次避免死循环", async () => {
    const user = userEvent.setup();
    mockRevisionsList = [];
    render(<FlowEditorPage />);

    await waitFor(() => {
      const saveBtn = screen.getByRole("button", { name: /保\s*存/ });
      expect(saveBtn).not.toBeDisabled();
    });

    const saveBtn = screen.getByRole("button", { name: /保\s*存/ });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockCreatePlatformRevision).toHaveBeenCalledTimes(1);
      expect(saveBtn).toBeDisabled();
    });
  });
});
