import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

vi.mock("../router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ search: "" }),
  Navigate: () => null,
}));

const mockProject = { id: "proj-1", name: "测试项目", description: "" };

vi.mock("../stores/workspace-store", () => ({
  useWorkspaceStore: (selector: any) =>
    selector({
      projects: [mockProject],
      flowsByProject: {},
      elementsByProject: {},
      variablesByProject: {},
      environmentsByProject: {},
      activeEnvironmentByProject: {},
      setFlows: vi.fn(),
      setElements: vi.fn(),
      setVariables: vi.fn(),
      setPlatformProjectId: vi.fn(),
    }),
}));

const mockGetPlatformAssertionStats = vi.fn();
const mockGetPlatformRuns = vi.fn();
const mockGetPlatformRunBatches = vi.fn();
const mockGetPlatformRunBatch = vi.fn();

vi.mock("../api/platform-api", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPlatformAssertionStats: (...args: any[]) => (mockGetPlatformAssertionStats as any)(...args),
    getPlatformRuns: (...args: any[]) => (mockGetPlatformRuns as any)(...args),
    getPlatformRunBatches: (...args: any[]) => (mockGetPlatformRunBatches as any)(...args),
    getPlatformRunBatch: (...args: any[]) => (mockGetPlatformRunBatch as any)(...args),
  };
});

vi.mock("../api/platform-context", () => ({
  currentPlatformUserId: () => "u1",
  platformProjectContext: () => undefined,
  readStoredPlatformSession: () => ({
    token: "t1",
    user: { id: "u1", email: "u1@example.test", name: "Test user", globalRole: null },
    workspaces: [{
      id: "workspace-1",
      name: "Workspace",
      role: "admin",
      capabilities: ["flow.edit", "element.manage", "variable.manage", "run.execute"],
    }],
  }),
  readStoredPlatformWorkspaceId: () => "workspace-1",
  readPlatformProjectMap: () => ({ "proj-1": "proj-1" }),
}));

import { RunsPage } from "./RunsPage";

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
    events: [],
    artifacts: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
];

describe("RunsPage 断言聚合展示", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPlatformRuns.mockResolvedValue({ total: 1, runs: mockPlatformRuns });
    mockGetPlatformRunBatches.mockResolvedValue({ total: 0, batches: [] });
    mockGetPlatformAssertionStats.mockResolvedValue({
      runsWithAssertions: 2,
      totalAssertions: 4,
      passedAssertions: 3,
      failedAssertions: 1,
      windowDays: 30,
    });
  });

  it("全项目断言通过率来自独立端点（含窗口说明）", async () => {
    render(<RunsPage project={mockProject as any} />);

    await screen.findByText("流程1");
    await waitFor(() => {
      expect(mockGetPlatformAssertionStats).toHaveBeenCalledWith("t1", "proj-1", 30);
    });
    expect(screen.getByText("断言通过率")).toBeInTheDocument();
    // 3/4 = 75%
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("含断言运行 2 次")).toBeInTheDocument();
    expect(screen.getByText("通过 3 · 失败 1")).toBeInTheDocument();
    expect(screen.getByText(/近 30 天/)).toBeInTheDocument();
  });

  it("batch detail 展开后展示断言汇总与失败明细", async () => {
    const batch = {
      id: "batch-1",
      projectId: "proj-1",
      environmentId: "env-1",
      clientRequestId: "client-1",
      source: "manual",
      retryOfBatchId: null,
      flowIds: ["flow-1", "flow-2"],
      cancellationRequested: false,
      createdBy: "u1",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      status: "failed",
      counts: { total: 2, queued: 0, running: 0, success: 1, failed: 1, canceled: 0, completed: 2 },
    };
    mockGetPlatformRunBatches.mockResolvedValue({ total: 1, batches: [batch] });
    mockGetPlatformRunBatch.mockResolvedValue({
      batch,
      runs: [
        { id: "sub-run-1", status: "success", revisionId: "rev-1", environmentId: "env-1", flowName: "流程1", cancellationRequested: false, retryOfRunId: null, batchItemIndex: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
        { id: "sub-run-2", status: "failed", revisionId: "rev-1", environmentId: "env-1", flowName: "流程2", cancellationRequested: false, retryOfRunId: null, batchItemIndex: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      ],
      assertionStats: { runsWithAssertions: 2, totalAssertions: 3, passedAssertions: 2, failedAssertions: 1 },
      assertionFailures: [
        { runId: "sub-run-2", flowName: "流程2", title: "数量断言", type: "count", expected: "3", actual: "2" },
      ],
    });

    render(<RunsPage project={mockProject as any} />);

    await waitFor(() => {
      expect(screen.getByText(/批量运行（2 个流程）/)).toBeInTheDocument();
    });
    const expandIcon = document.querySelector(".ant-table-row-expand-icon");
    expect(expandIcon).not.toBeNull();
    (expandIcon as HTMLElement).click();

    expect(await screen.findByText("断言汇总")).toBeInTheDocument();
    expect(screen.getByText("2/3 通过", { exact: false })).toBeInTheDocument();
    // 失败明细：名称 + 期望/实际。
    expect(screen.getByText("数量断言")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(mockGetPlatformRunBatch).toHaveBeenCalledWith("t1", "proj-1", "batch-1");
  });
});
