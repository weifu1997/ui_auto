import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElementAsset, Project } from "../mock-data";
import { storePlatformSession, storePlatformWorkspaceId } from "../platform-context";
import { useWorkspaceStore } from "../workspace-store";

vi.mock("../antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

import { ElementsPage } from "./ElementsPage";

const project: Project = { id: "p-1", name: "Demo", description: "" };
const element: ElementAsset = {
  id: "element-1",
  name: "登录按钮",
  description: "登录页按钮",
  path: "/login",
  method: "testid",
  value: "login-submit",
  environment: "env-1",
  validation: "unverified",
  updatedAt: "刚刚",
};

describe("元素库删除", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    storePlatformSession({
      token: "element-test-token",
      user: {
        id: "element-test-user",
        email: "element@example.test",
        name: "Element test user",
        globalRole: null,
      },
      workspaces: [{
        id: "element-workspace",
        name: "Element workspace",
        role: "admin",
        capabilities: ["element.manage", "run.execute"],
      }],
    });
    storePlatformWorkspaceId("element-workspace");
    useWorkspaceStore.getState().setElements("p-1", [element]);
  });

  it("确认后从元素库删除该元素", async () => {
    const user = userEvent.setup();
    render(<ElementsPage project={project} />);
    await screen.findByText("登录按钮", { exact: true });
    await user.click(screen.getByRole("button", { name: "删除元素 登录按钮" }));
    await screen.findByText(/确定删除元素「登录按钮」/);
    await user.click(screen.getByRole("button", { name: /^删\s*除$/ }));
    await waitFor(() => {
      expect(screen.queryByText("登录按钮", { exact: true })).toBeNull();
    });
    expect(useWorkspaceStore.getState().elementsByProject["p-1"]).toHaveLength(0);
  });
});
