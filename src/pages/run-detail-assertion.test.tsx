import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { PlatformRun } from "../api/platform-api";

vi.mock("../lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

vi.mock("../router", () => ({
  useParams: () => ({ projectId: "proj-test", runId: "run-1" }),
  useNavigate: () => vi.fn(),
  Navigate: () => null,
}));

vi.mock("../api/platform-context", () => ({
  currentPlatformUserId: () => "u1",
  platformProjectContext: (projectId: string) => ({
    session: { token: "token-1", user: { id: "u1" }, workspaces: [] },
    projectId,
  }),
  readStoredPlatformSession: () => null,
  readStoredPlatformWorkspaceId: () => undefined,
  storePlatformSession: vi.fn(),
  storePlatformWorkspaceId: vi.fn(),
}));

vi.mock("../api/platform-api", () => ({
  getPlatformRun: vi.fn(),
  cancelPlatformRun: vi.fn(),
  createPlatformRun: vi.fn(),
  retryPlatformRun: vi.fn(),
  createPlatformAssertionReport: vi.fn(),
  fetchPlatformArtifact: vi.fn(),
}));

import {
  createPlatformAssertionReport,
  fetchPlatformArtifact,
  getPlatformRun,
} from "../api/platform-api";
import RunDetailPage from "./RunDetailPage";

const mockProject = { id: "proj-test", name: "测试项目", description: "" };

vi.mock("../stores/workspace-store", () => ({
  useWorkspaceStore: (selector: any) =>
    selector({ projects: [mockProject] }),
}));

const statusMeta = {
  queued: { label: "排队中" },
  running: { label: "运行中" },
  success: { label: "通过" },
  failed: { label: "失败" },
  canceled: { label: "已取消" },
} as const;

function makeRun(overrides: Partial<PlatformRun> = {}): PlatformRun {
  return {
    id: "run-1",
    projectId: "proj-test",
    revisionId: "rev-1",
    environmentId: "env-1",
    agentId: "agent-1",
    executorType: "managed",
    status: "success",
    snapshot: {
      flow: { id: "flow-1", name: "断言流程", steps: [] },
      environment: { id: "env-1", name: "测试环境" },
    },
    result: undefined,
    cancellationRequested: false,
    retryOfRunId: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:01.000Z",
    artifacts: [],
    events: [],
    flowOutputs: [],
    ...overrides,
  };
}

function renderRun(run: PlatformRun) {
  (getPlatformRun as ReturnType<typeof vi.fn>).mockResolvedValue({ run });
  return render(
    <RunDetailPage
      ProjectLayout={({ children }: { children: ReactNode }) => <div>{children}</div>}
      PageHeading={({ title }: { title: string }) => <h1>{title}</h1>}
      statusTag={() => null}
      statusMeta={statusMeta}
    />,
  );
}

const passedAssertedEvent = {
  id: 5,
  kind: "step.asserted",
  data: {
    index: 1,
    stepId: "s2",
    title: "页面标题",
    type: "text",
    passed: true,
    expected: "Fixture login",
    actual: "Fixture login",
    durationMs: 31,
  },
  at: "2026-08-23T00:00:01.000Z",
};

const failedAssertedEvent = {
  id: 8,
  kind: "step.asserted",
  data: {
    index: 2,
    stepId: "s3",
    title: "订单数量",
    type: "count",
    passed: false,
    expected: "3",
    actual: "2",
    durationMs: 12,
  },
  at: "2026-08-23T00:00:01.200Z",
};

describe("RunDetailPage 断言结果区块", () => {
  it("有断言：展示逐条 名称/类型/通过·失败/期望 vs 实际", async () => {
    const run = makeRun({
      result: {
        status: "success",
        assertions: [
          { stepIndex: 1, stepId: "s2", title: "页面标题", type: "text", passed: true, expected: "Fixture login", actual: "Fixture login", durationMs: 31 },
          { stepIndex: 2, stepId: "s3", title: "订单数量", type: "count", passed: false, expected: "3", actual: "2", durationMs: 12 },
        ],
      },
      events: [
        { id: 1, kind: "run.started", data: {}, at: "2026-08-23T00:00:00.100Z" },
        { id: 2, kind: "step.started", data: { index: 0, stepId: "s1", title: "打开页面" }, at: "2026-08-23T00:00:00.200Z" },
        { id: 3, kind: "step.completed", data: { index: 0, stepId: "s1", title: "打开页面", durationMs: 23 }, at: "2026-08-23T00:00:00.300Z" },
        { id: 4, kind: "step.started", data: { index: 1, stepId: "s2", title: "页面标题" }, at: "2026-08-23T00:00:00.400Z" },
        passedAssertedEvent,
        { id: 6, kind: "step.completed", data: { index: 1, stepId: "s2", title: "页面标题", durationMs: 38 }, at: "2026-08-23T00:00:00.500Z" },
        { id: 7, kind: "step.started", data: { index: 2, stepId: "s3", title: "订单数量" }, at: "2026-08-23T00:00:00.600Z" },
        failedAssertedEvent,
        { id: 9, kind: "step.failed", data: { index: 2, stepId: "s3", title: "订单数量", message: "ASSERTION_FAILED: count expected=3 actual=2", durationMs: 12 }, at: "2026-08-23T00:00:00.700Z" },
        { id: 10, kind: "run.complete", data: { status: "failed", result: {} }, at: "2026-08-23T00:00:01.000Z" },
      ],
    });
    renderRun(run);

    expect(await screen.findByText("断言结果")).toBeInTheDocument();
    expect(screen.getByText("1/2 通过")).toBeInTheDocument();

    // 通过条目：名称 + 类型标签 + 期望/实际（expected 与 actual 同值）+ 判定。
    const passedRow = screen.getByText("页面标题").closest(".assertion-row") as HTMLElement;
    expect(within(passedRow).getByText("文本断言")).toBeInTheDocument();
    expect(within(passedRow).getAllByText("Fixture login", { selector: "code" })).toHaveLength(2);
    expect(within(passedRow).getByText("通过", { exact: true })).toBeInTheDocument();

    // 失败条目：显示 expected vs actual。
    const failedRow = screen.getByText("订单数量").closest(".assertion-row") as HTMLElement;
    expect(within(failedRow).getByText("数量断言")).toBeInTheDocument();
    expect(within(failedRow).getByText("3", { selector: "code" })).toBeInTheDocument();
    expect(within(failedRow).getByText("2", { selector: "code" })).toBeInTheDocument();
    expect(within(failedRow).getByText("失败", { exact: true })).toBeInTheDocument();

    // 时间线：step.asserted 判定行（通过绿/失败红 + expected/actual 摘要）。
    expect(screen.getByText("断言通过：期望 Fixture login，实际 Fixture login")).toBeInTheDocument();
    expect(screen.getByText("断言失败：期望 3，实际 2")).toBeInTheDocument();
  });

  it("无断言：不渲染断言结果区块", async () => {
    const run = makeRun({
      result: { status: "success" },
      events: [
        { id: 1, kind: "run.started", data: {}, at: "2026-08-23T00:00:00.100Z" },
        { id: 2, kind: "run.complete", data: { status: "success", result: {} }, at: "2026-08-23T00:00:01.000Z" },
      ],
    });
    renderRun(run);

    await screen.findByRole("heading", { name: "断言流程" });
    expect(screen.queryByText("断言结果")).not.toBeInTheDocument();
  });

  it("有断言：可导出 JSON/XLSX 报告（先创建再走下载链路）", async () => {
    const run = makeRun({
      result: {
        status: "success",
        assertions: [
          { stepIndex: 1, stepId: "s2", title: "页面标题", type: "text", passed: true, expected: "Fixture login", actual: "Fixture login", durationMs: 31 },
        ],
      },
    });
    (createPlatformAssertionReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      artifact: { id: "report-artifact-1", name: "assertion-report-run-1.json", contentType: "application/json", createdAt: "2026-08-23T00:00:00.000Z" },
    });
    (fetchPlatformArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(new Blob(["{}"], { type: "application/json" }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    renderRun(run);

    await screen.findByText("导出 JSON");
    await screen.getByText("导出 JSON").click();

    await vi.waitFor(() => {
      expect(createPlatformAssertionReport).toHaveBeenCalledWith("token-1", "proj-test", "run-1", "json");
    });
    expect(fetchPlatformArtifact).toHaveBeenCalledWith("token-1", "report-artifact-1");
    expect(click).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    revokeObjectURL.mockRestore();
    createObjectURL.mockRestore();
    click.mockRestore();
  });
});
