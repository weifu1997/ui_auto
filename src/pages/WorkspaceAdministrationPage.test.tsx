import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readStoredPlatformSession,
  storePlatformSession,
  storePlatformWorkspaceId,
} from "../api/platform-context";

const mocks = vi.hoisted(() => ({
  createWorkspaceInvitation: vi.fn(),
  createPlatformWorkspace: vi.fn(),
  getPlatformAccounts: vi.fn(),
  getWorkspaceInvitations: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  issuePlatformPasswordReset: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
  updatePlatformAccount: vi.fn(),
  updateWorkspaceMemberRole: vi.fn(),
  restorePlatformSession: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

vi.mock("../router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/projects">{children}</a>,
  Navigate: () => null,
  useLocation: () => ({ pathname: "/workspace/administration", search: "" }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/platform-api")>()),
  ...mocks,
}));

import { WorkspaceAdministrationPage } from "./WorkspaceAdministrationPage";

describe("WorkspaceAdministrationPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    storePlatformSession({
      token: "server-session-token",
      user: {
        id: "admin-1",
        email: "admin@example.test",
        name: "Workspace admin",
        globalRole: null,
      },
      workspaces: [
        {
          id: "workspace-1",
          name: "Controlled workspace",
          role: "admin",
          capabilities: ["member.manage", "invite.manage"],
        },
      ],
    });
    storePlatformWorkspaceId("workspace-1");
    mocks.getWorkspaceMembers.mockResolvedValue({
      members: [
        {
          id: "admin-1",
          email: "admin@example.test",
          name: "Workspace admin",
          enabled: true,
          globalRole: null,
          role: "admin",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    mocks.getWorkspaceInvitations.mockResolvedValue({ invitations: [] });
    mocks.getPlatformAccounts.mockResolvedValue({ accounts: [] });
    mocks.createWorkspaceInvitation.mockResolvedValue({
      invitation: {
        id: "invite-1",
        workspaceId: "workspace-1",
        email: "invitee@example.test",
        role: "member",
        expiresAt: "2026-08-21T00:00:00.000Z",
        token: "raw-invite-token",
      },
    });
    mocks.createPlatformWorkspace.mockResolvedValue({
      workspace: {
        id: "workspace-2",
        name: "New workspace",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    });
  });

  it("shows a created invitation token once without placing it in browser storage", async () => {
    const user = userEvent.setup();
    render(<WorkspaceAdministrationPage />);

    await waitFor(() => expect(mocks.getWorkspaceMembers).toHaveBeenCalled());
    await screen.findByRole("button", { name: /邀请成员/ });
    await user.click(screen.getByRole("button", { name: /邀请成员/ }));
    await user.type(screen.getByLabelText("邮箱"), "invitee@example.test");
    await user.click(screen.getByRole("button", { name: "创建邀请" }));

    const invitationLink = await screen.findByLabelText("一次性邀请链接");
    expect(invitationLink).toHaveValue(
      `${window.location.origin}/invitations/accept?token=raw-invite-token`,
    );
    expect(mocks.createWorkspaceInvitation).toHaveBeenCalledWith(
      "server-session-token",
      "workspace-1",
      { email: "invitee@example.test", role: "member" },
    );
    await waitFor(() => {
      const stored = Array.from(
        { length: localStorage.length },
        (_, index) => localStorage.getItem(localStorage.key(index) ?? "") ?? "",
      ).join("\n");
      expect(stored).not.toContain("raw-invite-token");
    });
  });

  it("lets a bootstrap super-admin create and select the first workspace from the UI", async () => {
    const user = userEvent.setup();
    storePlatformSession({
      token: "bootstrap-cookie-session",
      user: {
        id: "super-1",
        email: "super@example.test",
        name: "Deployment admin",
        globalRole: "super_admin",
      },
      workspaces: [],
    });
    mocks.getPlatformAccounts.mockResolvedValue({ accounts: [] });
    mocks.restorePlatformSession.mockResolvedValue({
      token: "cookie",
      user: {
        id: "super-1",
        email: "super@example.test",
        name: "Deployment admin",
        globalRole: "super_admin",
      },
      workspaces: [{
        id: "workspace-2",
        name: "New workspace",
        role: "super_admin",
        capabilities: ["project.view", "account.manage"],
      }],
    });

    render(<WorkspaceAdministrationPage />);

    await user.click(await screen.findByRole("button", { name: /创建工作区/ }));
    await user.type(screen.getByLabelText("工作区名称"), "New workspace");
    await user.click(screen.getByRole("button", { name: "创建工作区" }));

    await waitFor(() => {
      expect(mocks.createPlatformWorkspace).toHaveBeenCalledWith(
        "bootstrap-cookie-session",
        "New workspace",
      );
    });
    expect(mocks.restorePlatformSession).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(readStoredPlatformSession()?.workspaces).toEqual([
        expect.objectContaining({
          id: "workspace-2",
          role: "super_admin",
          capabilities: ["project.view", "account.manage"],
        }),
      ]);
    });
    expect(localStorage.getItem("autoflow-platform-workspace")).toBe("workspace-2");
    expect(mocks.navigate).toHaveBeenCalledWith("/projects", { replace: true });
  });
});
