import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment, Project } from "../mock-data";
import { useWorkspaceStore } from "../workspace-store";

vi.mock("../antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

const workerApi = vi.hoisted(() => ({
  getWorkerHealth: vi.fn(),
  getLocalPickerSessions: vi.fn(),
  createLocalPickerSession: vi.fn(),
  getLocalPickerCaptures: vi.fn(),
  enableLocalPicker: vi.fn(),
  previewLocalPickerCandidate: vi.fn(),
  confirmLocalPickerCandidate: vi.fn(),
  stopLocalPickerSession: vi.fn(),
  localPickerScreenshotUrl: vi.fn((_p, id) => `http://worker/screenshot/${id}`),
}));

vi.mock("../worker-api", () => workerApi);

import { LocalElementPickerPanel } from "./LocalElementPickerPanel";

const project: Project = { id: "p-1", name: "Demo", description: "" };
const environment: Environment = {
  id: "env-1",
  name: "测试环境",
  description: "",
  baseUrl: "https://example.test",
  browser: "Chromium",
  auth: "无认证",
  timeout: 30,
  testIdAttribute: "data-testid",
  color: "teal",
  updatedAt: "刚刚",
};
const capture = {
  id: "capture-1",
  sessionId: "session-1",
  target: "button#login",
  capturedAt: "2026-08-12T00:00:00.000Z",
  candidates: [
    { method: "testid" as const, value: "login-submit", count: 1, score: 98, label: "data-testid: login-submit" },
    { method: "role" as const, value: "button", count: 2, score: 72, label: "role: button" },
  ],
};

describe("LocalElementPickerPanel 本地采集通道", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.getState().setEnvironments("p-1", [environment]);
  });

  it("本机执行服务离线时给出明确提示而非静默失败", async () => {
    workerApi.getWorkerHealth.mockRejectedValue(new Error("offline"));
    render(<LocalElementPickerPanel project={project} preferredEnvironmentId="env-1" />);
    await waitFor(() => expect(screen.getByText("本机执行服务未运行，无法从页面获取元素。")).toBeTruthy());
    expect(screen.getByText(/npm run server/)).toBeTruthy();
  });

  it("本机服务在线时自动创建会话并展示等待点击状态", async () => {
    workerApi.getWorkerHealth.mockResolvedValue({ ok: true });
    const sessionRecord = { id: "session-1", projectId: "p-1", environmentId: "env-1", environmentName: "测试环境", currentUrl: "https://example.test/", status: "active", captureCount: 0, hasScreenshot: false };
    workerApi.getLocalPickerSessions
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValue({ sessions: [sessionRecord] });
    workerApi.createLocalPickerSession.mockResolvedValue({ session: sessionRecord });
    workerApi.getLocalPickerCaptures.mockResolvedValue({ captures: [] });
    render(<LocalElementPickerPanel project={project} preferredEnvironmentId="env-1" />);
    await waitFor(() => expect(screen.getByText("等待浏览器点击")).toBeTruthy(), { timeout: 4_000 });
    expect(workerApi.createLocalPickerSession).toHaveBeenCalledWith("p-1", environment);
  });

  it("确认候选后通过 onSelectCandidate 回填（仅回填不落库）", async () => {
    const onSelectCandidate = vi.fn();
    workerApi.getWorkerHealth.mockResolvedValue({ ok: true });
    workerApi.getLocalPickerSessions.mockResolvedValue({ sessions: [{ id: "session-1", projectId: "p-1", environmentId: "env-1", environmentName: "测试环境", currentUrl: "https://example.test/login", status: "active", captureCount: 1, hasScreenshot: true }] });
    workerApi.getLocalPickerCaptures.mockResolvedValue({ captures: [capture] });
    workerApi.confirmLocalPickerCandidate.mockResolvedValue({
      target: "fillback",
      candidate: capture.candidates[0],
      path: "/login",
      environmentId: "env-1",
      suggestedName: "login-submit",
    });
    const user = userEvent.setup();
    render(<LocalElementPickerPanel project={project} preferredEnvironmentId="env-1" onSelectCandidate={onSelectCandidate} />);
    await waitFor(() => expect(screen.getByText("login-submit", { exact: true })).toBeTruthy(), { timeout: 4_000 });
    const confirmButtons = screen.getAllByRole("button");
    const confirm = confirmButtons.find((button) => button.querySelector(".anticon-check-circle")) ?? confirmButtons[confirmButtons.length - 1];
    await user.click(confirm);
    await waitFor(() => expect(onSelectCandidate).toHaveBeenCalledTimes(1));
    const selection = onSelectCandidate.mock.calls[0][0] as { candidate: { value: string }; path: string; environmentId: string };
    expect(selection.candidate.value).toBe("login-submit");
    expect(selection.path).toBe("/login");
    expect(selection.environmentId).toBe("env-1");
  });
});