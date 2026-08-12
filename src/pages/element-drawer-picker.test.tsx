import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElementAsset, Environment, Project } from "../mock-data";

vi.mock("../antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

type PickSelection = {
  captureId: string;
  candidateIndex: number;
  candidate: { method: string; value: string; count: number; score: number; label: string };
  path: string;
  environmentId: string;
  suggestedName: string;
};

const pickSelection: PickSelection = {
  captureId: "capture-1",
  candidateIndex: 0,
  candidate: { method: "testid", value: "login-submit", count: 1, score: 98, label: "data-testid: login-submit" },
  path: "/login",
  environmentId: "env-1",
  suggestedName: "login-submit",
};

vi.mock("./LocalElementPickerPanel", () => ({
  LocalElementPickerPanel: ({ preferredEnvironmentId, onSelectCandidate }: { preferredEnvironmentId?: string; onSelectCandidate?: (selection: PickSelection) => void }) => (
    <div data-testid="local-picker-panel">
      <span data-testid="local-picker-env">{preferredEnvironmentId ?? ""}</span>
      <button type="button" onClick={() => onSelectCandidate?.(pickSelection)}>pick-candidate</button>
    </div>
  ),
}));

import { message } from "../antd-feedback";
import { ElementDrawer } from "./ElementsPage";

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

function seedPlatformContext() {
  localStorage.setItem("autoflow-platform-session", JSON.stringify({
    token: "token-1",
    user: { id: "u-1", email: "u@example.test", name: "User" },
    workspaces: [{ id: "ws-1", name: "Workspace", role: "owner" }],
  }));
  localStorage.setItem("autoflow-platform-workspace", JSON.stringify("ws-1"));
  localStorage.setItem("autoflow-platform-project-map", JSON.stringify({ "ws-1": { "p-1": "platform-1" } }));
}

function renderDrawer(element?: ElementAsset, elements: ElementAsset[] = [], environments: Environment[] = [environment]) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <ElementDrawer
      open
      element={element}
      project={project}
      environments={environments}
      elements={elements}
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { onSave, onClose };
}

describe("ElementDrawer 从页面获取（统一本地通道）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("未连接平台时使用本地通道并回填定位信息", async () => {
    renderDrawer();
    await waitFor(() => {
      const envSelect = document.querySelectorAll(".ant-select-content")[1];
      expect(envSelect?.getAttribute("title")).toBe("测试环境");
    }, { timeout: 4_000 });
    fireEvent.click(screen.getByRole("button", { name: /从页面获取/ }));
    await waitFor(() => expect(screen.getByTestId("local-picker-panel")).toBeTruthy(), { timeout: 4_000 });
    expect(screen.getByTestId("local-picker-env").textContent).toBe("env-1");
    fireEvent.click(screen.getByRole("button", { name: "pick-candidate" }));
    await waitFor(() => {
      expect(screen.getByLabelText("定位值")).toHaveValue("login-submit");
      expect(screen.getByLabelText("所属页面路径")).toHaveValue("/login");
    });
    const methodContent = document.querySelector(".ant-select-content") as HTMLElement | null;
    expect(methodContent?.textContent).toBe("testid");
  });

  it("已连接平台但未选环境时给出明确提示", () => {
    seedPlatformContext();
    renderDrawer(undefined, [], []);
    fireEvent.click(screen.getByRole("button", { name: /从页面获取/ }));
    expect(message.warning).toHaveBeenCalledWith("请先在表单中选择默认验证环境");
    expect(screen.queryByTestId("local-picker-panel")).toBeNull();
  });

  it("已连接平台时同样走本地通道，选定候选后自动回填并提示重复定位器但不阻断", async () => {
    seedPlatformContext();
    const existing: ElementAsset = {
      id: "element-existing",
      name: "旧登录按钮",
      description: "",
      path: "/login",
      method: "testid",
      value: "login-submit",
      environment: "env-1",
      validation: "unverified",
      updatedAt: "刚刚",
    };
    renderDrawer(undefined, [existing]);
    await waitFor(() => {
      const envSelect = document.querySelectorAll(".ant-select-content")[1];
      expect(envSelect?.getAttribute("title")).toBe("测试环境");
    }, { timeout: 4_000 });
    fireEvent.click(screen.getByRole("button", { name: /从页面获取/ }));
    await waitFor(() => expect(screen.getByTestId("local-picker-panel")).toBeTruthy(), { timeout: 4_000 });
    expect(screen.getByTestId("local-picker-env").textContent).toBe("env-1");
    fireEvent.click(screen.getByRole("button", { name: "pick-candidate" }));
    await waitFor(() => {
      expect(screen.getByLabelText("定位值")).toHaveValue("login-submit");
      expect(screen.getByLabelText("所属页面路径")).toHaveValue("/login");
    });
    expect(message.warning).toHaveBeenCalledWith("元素库中已存在相同定位器，保存后可能产生重复元素");
  });
});
