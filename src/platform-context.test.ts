import { beforeEach, describe, expect, it } from "vitest";
import { canUseCapability } from "./pages/shared";
import {
  platformSessionStorageKey,
  storePlatformSession,
  storePlatformWorkspaceId,
} from "./platform-context";

describe("server-derived platform capability projection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses capabilities from the selected workspace only", () => {
    storePlatformSession({
      token: "server-session",
      user: {
        id: "user-1",
        email: "user@example.test",
        name: "User",
        globalRole: null,
      },
      workspaces: [
        {
          id: "workspace-admin",
          name: "Admin workspace",
          role: "admin",
          capabilities: ["member.manage", "invite.manage", "secret.manage"],
        },
        {
          id: "workspace-member",
          name: "Member workspace",
          role: "member",
          capabilities: ["flow.edit", "run.execute"],
        },
      ],
    });

    storePlatformWorkspaceId("workspace-member");

    expect(canUseCapability("flow.edit")).toBe(true);
    expect(canUseCapability("run.execute")).toBe(true);
    expect(canUseCapability("member.manage")).toBe(false);
    expect(canUseCapability("secret.manage")).toBe(false);
  });

  it("rejects persisted sessions with unknown roles or capabilities", () => {
    localStorage.setItem(
      platformSessionStorageKey,
      JSON.stringify({
        token: "forged-storage-shape",
        user: {
          id: "user-1",
          email: "user@example.test",
          name: "User",
          globalRole: null,
        },
        workspaces: [
          {
            id: "workspace-1",
            name: "Workspace",
            role: "owner",
            capabilities: ["all.access"],
          },
        ],
      }),
    );

    expect(canUseCapability("member.manage")).toBe(false);
    expect(canUseCapability("flow.edit")).toBe(false);
  });
});
