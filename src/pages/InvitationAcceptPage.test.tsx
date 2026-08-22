import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformSession } from "../platform-api";
import { storePlatformSession } from "../platform-context";

const mocks = vi.hoisted(() => ({
  acceptWorkspaceInvitation: vi.fn(),
  navigate: vi.fn(),
  restorePlatformSession: vi.fn(),
  location: { search: "?token=invite-token" },
}));

vi.mock("../platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform-api")>()),
  acceptWorkspaceInvitation: mocks.acceptWorkspaceInvitation,
  restorePlatformSession: mocks.restorePlatformSession,
}));

vi.mock("../router", () => ({
  useLocation: () => mocks.location,
  useNavigate: () => mocks.navigate,
}));

import { InvitationAcceptPage } from "./InvitationAcceptPage";

const restoredSession: PlatformSession = {
  token: "cookie",
  user: {
    id: "new-user",
    email: "invitee@example.test",
    name: "Invitee",
    globalRole: null,
  },
  workspaces: [
    {
      id: "workspace-1",
      name: "Controlled workspace",
      role: "member",
      capabilities: ["flow.edit", "run.execute"],
    },
  ],
};

describe("InvitationAcceptPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.location.search = "?token=invite-token";
    mocks.acceptWorkspaceInvitation.mockResolvedValue({
      accepted: true,
      newAccount: true,
      user: restoredSession.user,
    });
    mocks.restorePlatformSession.mockResolvedValue(restoredSession);
  });

  it("creates a new account through the invitation route", async () => {
    const user = userEvent.setup();
    render(<InvitationAcceptPage />);

    await user.type(screen.getByLabelText("邀请邮箱"), "invitee@example.test");
    await user.type(screen.getByLabelText("姓名"), "Invitee");
    await user.type(screen.getByLabelText("设置密码"), "controlled-password");
    await user.click(screen.getByRole("button", { name: "创建账户并接受邀请" }));

    await waitFor(() => {
      expect(mocks.acceptWorkspaceInvitation).toHaveBeenCalledWith({
        token: "invite-token",
        email: "invitee@example.test",
        name: "Invitee",
        password: "controlled-password",
      });
    });
    expect(mocks.restorePlatformSession).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith("/projects", { replace: true });
  });

  it("uses the logged-in matching account path without asking for a password", async () => {
    const user = userEvent.setup();
    storePlatformSession({
      ...restoredSession,
      user: {
        id: "existing-user",
        email: "existing@example.test",
        name: "Existing user",
        globalRole: null,
      },
    });
    render(<InvitationAcceptPage />);

    expect(screen.getByText("将以 existing@example.test 接受邀请")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "接受邀请" }));

    await waitFor(() => {
      expect(mocks.acceptWorkspaceInvitation).toHaveBeenCalledWith({
        token: "invite-token",
        email: "existing@example.test",
        password: "",
      });
    });
  });
});
