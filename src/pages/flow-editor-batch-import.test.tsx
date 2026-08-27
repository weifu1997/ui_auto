import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useFlowStore } from "../stores/flow-store";

vi.mock("../lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

const mockProject = {
  id: "proj-test",
  name: "测试项目",
  description: "",
};

const mockFlowDefinitionState: { definition: any[] } = {
  definition: [
    { id: "s1", title: "步骤1", action: "打开页面", value: "https://test.com", timeout: 10, failurePolicy: "立即失败", status: "pending" },
  ],
};

const mockFlow = {
  id: "flow-new",
  name: "批量流程",
  description: "",
  tags: [],
  steps: 1,
  get definition() {
    return mockFlowDefinitionState.definition;
  },
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

const mockElements = [
  { id: "el-1", name: "标题", path: "/", method: "css", value: "#order-title", environment: "env-1" },
  { id: "el-2", name: "输入框", path: "/", method: "css", value: "#name-input", environment: "env-1" },
];

vi.mock("../router", () => ({
  useParams: () => ({ projectId: "proj-test", flowId: "flow-new" }),
  useNavigate: () => vi.fn(),
  Navigate: () => null,
}));

let mockRevisionsList: any[] = [];
const mockCreatePlatformRevision = vi.fn(async (..._args: any[]) => ({ revision: { id: "rev-created", revisionNumber: 1 } }));
const mockCreatePlatformRun = vi.fn(async (..._args: any[]) => ({ runs: [{ id: "run-1", status: "queued" }], runIds: ["run-1"] }));

const recordingSession = {
  id: "rec-1",
  projectId: "proj-test",
  flowId: "flow-new",
  environmentId: "env-1",
  status: "recording",
  lastSeq: 0,
  recordedStepCount: 0,
  events: [],
  currentUrl: "https://test.com",
};

const recordingResult = {
  steps: [
    { id: "open", title: "打开页面", action: "打开页面", value: "/" },
    { id: "click", title: "点击", action: "点击", element: "标题" },
  ],
  elements: [
    { id: "r1", name: "标题", path: "/", method: "css", value: "#order-title" },
  ],
  requiredBindings: [],
  warnings: [],
  lastSeq: 2,
};

vi.mock("../api/platform-api", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPlatformRevisions: vi.fn(async () => ({ revisions: mockRevisionsList })),
    getPlatformSecrets: vi.fn(async () => ({ secrets: [] })),
    createPlatformRevision: (token: string, pid: string, input: any) => mockCreatePlatformRevision(token, pid, input),
    createPlatformRun: (token: string, pid: string, input: any) => mockCreatePlatformRun(token, pid, input),
    createPlatformElementValidation: vi.fn(),
    getPlatformElementValidation: vi.fn(),
    savePlatformSecret: vi.fn(),
    cancelActiveRecordingSession: vi.fn(async () => ({ canceled: false })),
    cancelRecordingSession: vi.fn(async () => ({ session: { ...recordingSession, status: "canceled" } })),
    createRecordingSession: vi.fn(async () => ({ session: recordingSession })),
    getRecordingEvents: vi.fn(async () => ({ events: [], lastSeq: 0, hasMore: false })),
    getRecordingSession: vi.fn(async () => ({ session: recordingSession })),
    pauseRecordingSession: vi.fn(async () => ({ session: { ...recordingSession, status: "paused" } })),
    resumeRecordingSession: vi.fn(async () => ({ session: recordingSession })),
    stopRecordingSession: vi.fn(async () => ({
      session: { ...recordingSession, status: "stopped" },
      result: recordingResult,
    })),
  };
});

vi.mock("../api/platform-context", () => ({
  currentPlatformUserId: () => "u1",
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
      elementsByProject: { "proj-test": mockElements },
      variablesByProject: { "proj-test": [] },
      environmentsByProject: { "proj-test": [mockEnvironment] },
      activeEnvironmentByProject: { "proj-test": "env-1" },
      setFlows: vi.fn(),
      setElements: vi.fn(),
    }),
}));

import FlowEditorPage from "./FlowEditorPage";

function pickOption(label: string, option: string) {
  const input = screen.getByLabelText(label);
  fireEvent.mouseDown(input);
  document.querySelectorAll(".rc-virtual-list-holder").forEach((holder) => {
    (holder as HTMLElement).style.height = "600px";
    fireEvent.scroll(holder, { target: { scrollTop: 100000 } });
  });
  // rc-select 打开时同一选项会同时渲染为 listbox 的 role=option 与
  // .ant-select-item-option-content 两个节点，取 closest 限定到可点击的选项。
  const candidates = screen
    .getAllByText(option)
    .map((el) => el.closest(".ant-select-item-option"))
    .filter((el): el is HTMLElement => Boolean(el));
  const item = candidates[0];
  fireEvent.mouseDown(item);
  fireEvent.click(item);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRevisionsList = [];
  mockFlowDefinitionState.definition = [
    { id: "s1", title: "步骤1", action: "打开页面", value: "https://test.com", timeout: 10, failurePolicy: "立即失败", status: "pending" },
  ];
  useFlowStore.getState().reset();
});

describe("FlowEditorPage 批量编辑断言步骤", () => {
  it("仅断言步骤可勾选；批量条可改匹配方式与失败策略，跨类型不写入", async () => {
    const user = userEvent.setup();
    mockFlowDefinitionState.definition = [
      { id: "s-open", title: "打开页面", action: "打开页面", value: "https://test.com", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      { id: "s-text", title: "文本断言", action: "文本断言", element: "标题", value: "hello", assertMatch: "contains", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      { id: "s-vis", title: "可见性断言", action: "可见性断言", element: "输入框", value: "", assertVisibility: "visible", timeout: 10, failurePolicy: "立即失败", status: "pending" },
    ];
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    // 打开页面步骤不是断言，不出现勾选框。
    expect(screen.queryByLabelText("选择步骤：打开页面")).not.toBeInTheDocument();
    // 断言步骤出现勾选框。
    const textCheck = screen.getByLabelText("选择步骤：文本断言");
    const visCheck = screen.getByLabelText("选择步骤：可见性断言");
    expect(textCheck).toBeInTheDocument();
    expect(visCheck).toBeInTheDocument();

    // 批量条初始不出现。
    expect(screen.queryByText(/已选 \d+ 个断言步骤/)).not.toBeInTheDocument();

    fireEvent.click(textCheck);
    expect(screen.getByText("已选 1 个断言步骤")).toBeInTheDocument();
    fireEvent.click(visCheck);
    expect(screen.getByText("已选 2 个断言步骤")).toBeInTheDocument();

    // 批量失败策略应用到所有选中步骤。
    pickOption("批量失败策略", "继续执行");
    const steps = useFlowStore.getState().steps;
    expect(steps.find((step) => step.id === "s-text")?.failurePolicy).toBe("继续执行");
    expect(steps.find((step) => step.id === "s-vis")?.failurePolicy).toBe("继续执行");

    // 批量匹配方式仅写文本/属性断言步骤；可见性断言不写 assertMatch（跨类型跳过）。
    pickOption("批量匹配方式", "精确匹配");
    const after = useFlowStore.getState().steps;
    expect(after.find((step) => step.id === "s-text")?.assertMatch).toBe("exact");
    expect(after.find((step) => step.id === "s-vis")?.assertMatch).toBeUndefined();
    expect(after.find((step) => step.id === "s-vis")?.assertVisibility).toBe("visible");

    // 清除选择后批量条消失。
    const clearBtn = screen.getByLabelText("清除步骤选择");
    await user.click(clearBtn);
    expect(screen.queryByText(/已选 \d+ 个断言步骤/)).not.toBeInTheDocument();
  });
});

describe("FlowEditorPage 录制导入生成候选断言", () => {
  async function stopRecordingAndOpenResult() {
    render(<FlowEditorPage />);
    await screen.findByRole("button", { name: /录制/ });
    fireEvent.click(screen.getByRole("button", { name: /录制/ }));
    const startBtn = await screen.findByRole("button", { name: /开始录制/ });
    fireEvent.click(startBtn);
    const stopBtn = await screen.findByRole("button", { name: /停止录制/ });
    fireEvent.click(stopBtn);
    // 录制结果弹窗出现，含候选断言区块。
    await screen.findByText("候选断言（含可见性，以及可挑选的文本/属性建议草稿；默认不勾选）：");
  }

  it("默认不勾选：确认导入仅并入录制步骤，不含候选断言", async () => {
    await stopRecordingAndOpenResult();
    // 候选断言展示但默认未勾选。
    const assertionCheck = screen.getByRole("checkbox", { name: "「标题」可见" });
    expect(assertionCheck).not.toBeChecked();

    const confirmBtn = await screen.findByRole("button", { name: /确认导入/ });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const steps = useFlowStore.getState().steps;
      // 原 1 步 + 录制 2 步；未勾选所以不含可见性断言。
      expect(steps).toHaveLength(3);
      expect(steps.some((step) => step.action === "可见性断言")).toBe(false);
    });
  });

  it("勾选候选断言：确认导入并入 assertVisibility 断言步骤", async () => {
    await stopRecordingAndOpenResult();
    const assertionCheck = screen.getByRole("checkbox", { name: "「标题」可见" });
    fireEvent.click(assertionCheck);
    expect(assertionCheck).toBeChecked();

    const confirmBtn = await screen.findByRole("button", { name: /确认导入/ });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const steps = useFlowStore.getState().steps;
      const assertion = steps.find((step) => step.action === "可见性断言");
      expect(assertion).toBeDefined();
      expect(assertion?.assertVisibility).toBe("visible");
      expect(assertion?.element).toBe("标题");
    });
  });
});
