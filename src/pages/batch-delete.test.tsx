import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

const mockProject = {
  id: "proj-1",
  name: "测试项目",
  description: "",
};

const mockFlows = [
  { id: "flow-1", name: "流程1", description: "", tags: [], steps: 1, definition: [], lastStatus: "queued", updatedAt: "刚刚" },
  { id: "flow-2", name: "流程2", description: "", tags: [], steps: 1, definition: [], lastStatus: "queued", updatedAt: "刚刚" },
];

const mockElements = [
  { id: "elem-1", name: "元素1", description: "", path: "/1", method: "testid", value: "e1", environment: "", validation: "valid", updatedAt: "刚刚" },
  { id: "elem-2", name: "元素2", description: "", path: "/2", method: "testid", value: "e2", environment: "", validation: "valid", updatedAt: "刚刚" },
];

const mockVariables = [
  { id: "var-1", name: "v1", description: "", scope: "项目" as const, secret: false, value: "val1", updatedAt: "刚刚" },
  { id: "var-2", name: "v2", description: "", scope: "环境" as const, secret: false, value: "val2", updatedAt: "刚刚" },
  { id: "var-builtin", name: "system_var", description: "", scope: "内置" as const, secret: false, value: "builtin", updatedAt: "刚刚" },
];

const mockPlatformRuns = [
  {
    id: "run-1",
    projectId: "proj-1",
    revisionId: "rev-1",
    environmentId: "env-1",
    agentId: "ag-1",
    executorType: "managed",
    status: "success",
    snapshot: { flow: { id: "flow-1", name: "流程1", steps: [{ id: "s1" }] }, environment: { id: "env-1", name: "测试环境" } },
    events: [{ id: 1, kind: "step.completed", data: "{}", createdAt: "2026-01-01" }],
    artifacts: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  {
    id: "run-2",
    projectId: "proj-1",
    revisionId: "rev-1",
    environmentId: "env-1",
    agentId: "ag-1",
    executorType: "managed",
    status: "failed",
    snapshot: { flow: { id: "flow-2", name: "流程2", steps: [{ id: "s1" }] }, environment: { id: "env-1", name: "测试环境" } },
    events: [],
    artifacts: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
];

vi.mock("../router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ search: "" }),
  Navigate: () => null,
}));

const mockSetFlows = vi.fn();
const mockSetElements = vi.fn();
const mockSetVariables = vi.fn();

vi.mock("../workspace-store", () => ({
  useWorkspaceStore: (selector: any) =>
    selector({
      projects: [mockProject],
      flowsByProject: { "proj-1": mockFlows },
      elementsByProject: { "proj-1": mockElements },
      variablesByProject: { "proj-1": mockVariables },
      environmentsByProject: { "proj-1": [] },
      activeEnvironmentByProject: { "proj-1": "" },
      setFlows: mockSetFlows,
      setElements: mockSetElements,
      setVariables: mockSetVariables,
      setPlatformProjectId: vi.fn(),
    }),
}));

const mockDeletePlatformRun = vi.fn(async () => ({ runId: "run-1", deleted: true }));
const mockDeletePlatformRuns = vi.fn(async () => ({ runIds: ["run-1", "run-2"], deletedCount: 2 }));

vi.mock("../platform-api", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPlatformRevisions: vi.fn(async () => ({ revisions: [] })),
    getPlatformRuns: vi.fn(async () => ({ total: 2, runs: mockPlatformRuns })),
    getPlatformRunBatches: vi.fn(async () => ({ total: 0, batches: [] })),
    deletePlatformRun: (...args: any[]) => (mockDeletePlatformRun as any)(...args),
    deletePlatformRuns: (...args: any[]) => (mockDeletePlatformRuns as any)(...args),
  };
});

vi.mock("../platform-context", () => ({
  platformProjectContext: () => undefined,
  readStoredPlatformSession: () => ({ token: "t1", user: { id: "u1" }, workspaces: [] }),
  readPlatformProjectMap: () => ({ "proj-1": "proj-1" }),
}));

import { FlowsPage } from "./FlowsPage";
import { ElementsPage } from "./ElementsPage";
import { VariablesPage } from "./VariablesPage";
import { RunsPage } from "./RunsPage";

describe("Batch Delete across Flows, Elements, Variables, and Runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("FlowsPage 具有批量删除按钮及选择交互", async () => {
    const user = userEvent.setup();
    render(<FlowsPage project={mockProject as any} />);
    const batchDelBtn = screen.getByRole("button", { name: /批量删除/ });
    expect(batchDelBtn).toBeDisabled();

    // Select all flows
    const selectAllCheckbox = screen.getAllByRole("checkbox")[0];
    fireEvent.click(selectAllCheckbox);

    expect(batchDelBtn).not.toBeDisabled();
    expect(batchDelBtn).toHaveTextContent("批量删除（2）");

    // Click batch delete
    await user.click(batchDelBtn);

    // Popconfirm confirm button
    const confirmBtn = await screen.findByRole("button", { name: /^删\s*除$/ });
    await user.click(confirmBtn);

    expect(mockSetFlows).toHaveBeenCalled();
  });

  it("ElementsPage 具有批量删除按钮及选择交互", async () => {
    const user = userEvent.setup();
    render(<ElementsPage project={mockProject as any} />);
    const batchDelBtn = screen.getByRole("button", { name: /批量删除/ });
    expect(batchDelBtn).toBeDisabled();

    const selectAllCheckbox = screen.getAllByRole("checkbox")[0];
    fireEvent.click(selectAllCheckbox);

    expect(batchDelBtn).not.toBeDisabled();
    expect(batchDelBtn).toHaveTextContent("批量删除（2）");

    await user.click(batchDelBtn);
    const confirmBtn = await screen.findByRole("button", { name: /^删\s*除$/ });
    await user.click(confirmBtn);

    expect(mockSetElements).toHaveBeenCalled();
  });

  it("VariablesPage 具有批量删除按钮，且内置变量禁用勾选", async () => {
    const user = userEvent.setup();
    render(<VariablesPage project={mockProject as any} />);
    const batchDelBtn = screen.getByRole("button", { name: /批量删除/ });
    expect(batchDelBtn).toBeDisabled();

    const checkboxes = screen.getAllByRole("checkbox");
    // Built-in variable checkbox is disabled
    const builtinCheckbox = checkboxes[checkboxes.length - 1];
    expect(builtinCheckbox).toBeDisabled();

    // Select all selectable
    const selectAllCheckbox = checkboxes[0];
    fireEvent.click(selectAllCheckbox);

    expect(batchDelBtn).not.toBeDisabled();
    expect(batchDelBtn).toHaveTextContent("批量删除（2）");

    await user.click(batchDelBtn);
    const confirmBtn = await screen.findByRole("button", { name: /^删\s*除$/ });
    await user.click(confirmBtn);

    expect(mockSetVariables).toHaveBeenCalled();
  });

  it("RunsPage 具有单条删除与批量删除运行记录功能", async () => {
    const user = userEvent.setup();
    render(<RunsPage project={mockProject as any} />);

    const batchDelBtn = await screen.findByRole("button", { name: /批量删除/ });
    expect(batchDelBtn).toBeDisabled();

    // Wait for table to load runs
    await screen.findByText("流程1");

    const selectAllCheckbox = screen.getAllByRole("checkbox")[0];
    fireEvent.click(selectAllCheckbox);

    expect(batchDelBtn).not.toBeDisabled();
    expect(batchDelBtn).toHaveTextContent("批量删除（2）");

    await user.click(batchDelBtn);
    const confirmBtn = await screen.findByRole("button", { name: /^删\s*除$/ });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mockDeletePlatformRuns).toHaveBeenCalledWith("t1", "proj-1", ["run-1", "run-2"]);
    });
  });
});
