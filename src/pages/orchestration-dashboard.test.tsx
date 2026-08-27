import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestrationDashboard } from "./OrchestrationDashboard";

const mockGetPlatformRunTrend = vi.fn();

vi.mock("../api/platform-api", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPlatformRunTrend: (...args: any[]) => (mockGetPlatformRunTrend as any)(...args),
  };
});

const session = { token: "t1", user: { id: "u1" }, workspaces: [] };

const TREND = {
  windowDays: 14,
  points: [
    { date: "2026-08-13", runTotal: 3, runPassed: 2, runFailed: 1, assertionTotal: 3, assertionPassed: 2 },
    { date: "2026-08-14", runTotal: 2, runPassed: 1, runFailed: 1, assertionTotal: 1, assertionPassed: 1 },
  ],
};

function renderDashboard() {
  return render(
    <OrchestrationDashboard
      platformSession={session as any}
      platformProjectId="proj-1"
      refreshKey={0}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlatformRunTrend.mockResolvedValue(TREND);
});

describe("OrchestrationDashboard 编排看板（R4-2）", () => {
  it("有数据：渲染双图表卡片，缺省按近 14 天拉取", async () => {
    renderDashboard();

    expect(await screen.findByLabelText("编排看板")).toBeInTheDocument();
    expect(screen.getByText("断言通过率趋势")).toBeInTheDocument();
    expect(screen.getByText("运行状态分布")).toBeInTheDocument();
    expect(mockGetPlatformRunTrend).toHaveBeenCalledWith("t1", "proj-1", 14);
  });

  it("空数据：不渲染看板（空态）", async () => {
    mockGetPlatformRunTrend.mockResolvedValue({ windowDays: 14, points: [] });
    const { container } = renderDashboard();

    await waitFor(() => expect(mockGetPlatformRunTrend).toHaveBeenCalled());
    expect(screen.queryByLabelText("编排看板")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("窗口切换：重拉并携带 window_days", async () => {
    renderDashboard();
    await screen.findByLabelText("编排看板");

    const input = screen.getByLabelText("趋势窗口");
    fireEvent.mouseDown(input);
    document.querySelectorAll(".rc-virtual-list-holder").forEach((holder) => {
      (holder as HTMLElement).style.height = "600px";
      fireEvent.scroll(holder, { target: { scrollTop: 100000 } });
    });
    const option = screen.getByText("近 7 天");
    const item = option.closest(".ant-select-item-option") as HTMLElement;
    fireEvent.mouseDown(item);
    fireEvent.click(item);

    await waitFor(() => expect(mockGetPlatformRunTrend).toHaveBeenCalledWith("t1", "proj-1", 7));
  });
});
