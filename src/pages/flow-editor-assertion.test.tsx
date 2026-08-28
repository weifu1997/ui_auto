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

const mockFlow = {
  id: "flow-new",
  name: "断言流程",
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
    cancelActiveRecordingSession: vi.fn(),
    cancelRecordingSession: vi.fn(),
    createRecordingSession: vi.fn(),
    getRecordingEvents: vi.fn(),
    getRecordingSession: vi.fn(),
    getRecordingSessionResult: vi.fn(),
    pauseRecordingSession: vi.fn(),
    resumeRecordingSession: vi.fn(),
    stopRecordingSession: vi.fn(),
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
    }),
}));

import FlowEditorPage from "./FlowEditorPage";

// 动作下拉（13 项）在 jsdom 下被 rc-virtual-list 虚拟化，靠后的
// 「数量断言/属性断言」渲染不出来；且重复 open/close 时有 toggle 吞点击问题。
// 该下拉已开 showSearch：点输入框聚焦 → 键入目标文本过滤（过滤后列表仅剩目标项，
// 必然渲染）→ Enter 选中并收起，绕开虚拟化与 toggle 两个坑。
// jsdom 下 rc-virtual-list 只渲染视口内的少量选项，靠后的「数量断言/属性断言」
// 会被虚拟化掉导致 getByText 找不到。做法：mouseDown 打开下拉 → 滚动虚拟列表
// 到底 → 全部选项渲染出来 → 在选项容器（承载选中事件）上 mouseDown+click 选中
// 并收起。holder 用 aria-controls 关联的 listbox 限定作用域，避免误滚其它下拉。
function pickOption(label: string, option: string) {
  const input = screen.getByLabelText(label);
  fireEvent.mouseDown(input);
  // jsdom 无布局，holder 高度为 0 → scrollTop 被钳为 0，虚拟列表不会渲染尾部
  // 选项。给每个可见下拉的 holder 一个真实高度再滚动到底，强制渲染全部选项。
  document.querySelectorAll(".rc-virtual-list-holder").forEach((holder) => {
    (holder as HTMLElement).style.height = "600px";
    fireEvent.scroll(holder, { target: { scrollTop: 100000 } });
  });
  const content = screen.getByText(option);
  const item = content.closest(".ant-select-item-option") as HTMLElement;
  fireEvent.mouseDown(item);
  fireEvent.click(item);
}

async function selectAction(_user: ReturnType<typeof userEvent.setup>, action: string) {
  pickOption("步骤动作", action);
}

async function selectOption(_user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  pickOption(label, option);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRevisionsList = [];
  useFlowStore.getState().reset();
});

describe("FlowEditorPage 断言配置面板", () => {
  it("切换到文本断言：出现匹配方式与期望值，跨类型字段不出现", async () => {
    const user = userEvent.setup();
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    await selectAction(user, "文本断言");

    expect(await screen.findByLabelText("匹配方式")).toBeInTheDocument();
    expect(screen.getByLabelText("期望值")).toBeInTheDocument();
    expect(screen.queryByLabelText("期望状态")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("比较符")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("属性名")).not.toBeInTheDocument();
  });

  it("文本断言：匹配方式选完全匹配并填写期望值，保存到步骤字段", async () => {
    const user = userEvent.setup();
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    await selectAction(user, "文本断言");
    await selectOption(user, "匹配方式", "完全匹配");

    const valueInput = screen.getByLabelText("期望值");
    await user.clear(valueInput);
    await user.type(valueInput, "Order #12345");

    const [step] = useFlowStore.getState().steps;
    expect(step.action).toBe("文本断言");
    expect(step.assertMatch).toBe("exact");
    expect(step.value).toBe("Order #12345");
    // 跨类型字段未写入。
    expect(step.assertVisibility).toBeUndefined();
    expect(step.assertOperator).toBeUndefined();
    expect(step.assertAttribute).toBeUndefined();
  });

  it("可见性断言：出现期望状态且隐藏期望值输入", async () => {
    const user = userEvent.setup();
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    await selectAction(user, "可见性断言");

    expect(await screen.findByLabelText("期望状态")).toBeInTheDocument();
    expect(screen.queryByLabelText("期望值")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("匹配方式")).not.toBeInTheDocument();

    await selectOption(user, "期望状态", "不可见");
    const [step] = useFlowStore.getState().steps;
    expect(step.assertVisibility).toBe("hidden");
  });

  it("数量断言：出现比较符，缺省为等于；跨类型字段被清理", async () => {
    const user = userEvent.setup();
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    // 先在文本断言设置 exact，验证切到数量断言后被清理。
    await selectAction(user, "文本断言");
    await selectOption(user, "匹配方式", "完全匹配");
    expect(useFlowStore.getState().steps[0].assertMatch).toBe("exact");

    await selectAction(user, "数量断言");
    expect(await screen.findByLabelText("比较符")).toBeInTheDocument();
    expect(screen.queryByLabelText("匹配方式")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("期望状态")).not.toBeInTheDocument();

    // 缺省为等于：面板显示 "="，但不写入字段（后端缺省语义，旧流程无字段保持兼容）。
    const [step] = useFlowStore.getState().steps;
    expect(step.assertOperator).toBeUndefined();
    expect(step.assertMatch).toBeUndefined();
    expect(step.assertVisibility).toBeUndefined();
    expect(step.assertAttribute).toBeUndefined();

    await selectOption(user, "比较符", ">=");
    expect(useFlowStore.getState().steps[0].assertOperator).toBe(">=");
  });

  it("属性断言：出现属性名下拉与匹配方式", async () => {
    const user = userEvent.setup();
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    await selectAction(user, "属性断言");

    expect(await screen.findByLabelText("属性名")).toBeInTheDocument();
    expect(screen.getByLabelText("匹配方式")).toBeInTheDocument();
    expect(screen.queryByLabelText("期望状态")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("比较符")).not.toBeInTheDocument();
  });

  it("URL 断言：出现匹配方式与期望值，隐藏元素与跨类型字段", async () => {
    const user = userEvent.setup();
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    await selectAction(user, "URL 断言");

    // 页面级断言：无元素选择器。
    expect(screen.queryByLabelText("步骤元素")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("匹配方式")).toBeInTheDocument();
    expect(screen.getByLabelText("期望值")).toBeInTheDocument();
    expect(screen.queryByLabelText("期望状态")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("比较符")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("属性名")).not.toBeInTheDocument();
  });

  it("URL 断言：匹配方式选完全匹配并填写期望值，保存到步骤字段", async () => {
    const user = userEvent.setup();
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    // 先在文本断言写入 assertMatch=exact，验证切到 URL 断言后 assertMatch 被保留
    // （R3-1 值域扩展回归：URL 断言不是非断言动作，不得落入「全部清除」）。
    await selectAction(user, "文本断言");
    await selectOption(user, "匹配方式", "完全匹配");
    const textValue = screen.getByLabelText("期望值");
    await user.clear(textValue);
    await user.type(textValue, "Order #12345");
    expect(useFlowStore.getState().steps[0].assertMatch).toBe("exact");

    await selectAction(user, "URL 断言");
    expect(useFlowStore.getState().steps[0].assertMatch).toBe("exact");
    const valueInput = screen.getByLabelText("期望值");
    await user.clear(valueInput);
    await user.type(valueInput, "https://test.com/__fixture/login");

    const [step] = useFlowStore.getState().steps;
    expect(step.action).toBe("URL 断言");
    expect(step.assertMatch).toBe("exact");
    expect(step.value).toBe("https://test.com/__fixture/login");
    // 页面级断言不写元素；跨类型字段未写入。
    expect(step.element).toBeUndefined();
    expect(step.assertVisibility).toBeUndefined();
    expect(step.assertOperator).toBeUndefined();
    expect(step.assertAttribute).toBeUndefined();
  });

  it("保存时新断言字段随步骤写入发布版本", async () => {
    const user = userEvent.setup();
    mockRevisionsList = [];
    render(<FlowEditorPage />);

    await screen.findByLabelText("步骤动作");
    await selectAction(user, "文本断言");
    await selectOption(user, "匹配方式", "完全匹配");
    const valueInput = screen.getByLabelText("期望值");
    await user.clear(valueInput);
    await user.type(valueInput, "Order #12345");

    const saveBtn = await screen.findByRole("button", { name: /保\s*存/ });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => expect(mockCreatePlatformRevision).toHaveBeenCalledTimes(1));
    const input = mockCreatePlatformRevision.mock.calls[0][2] as any;
    const savedStep = input.flow.steps[0];
    expect(savedStep.assertMatch).toBe("exact");
    expect(savedStep.value).toBe("Order #12345");
    expect(savedStep.action).toBe("文本断言");
  });
});
