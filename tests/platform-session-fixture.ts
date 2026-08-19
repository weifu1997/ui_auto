import { platformCapabilities } from "../src/platform-api";
import type { PlatformSession } from "../src/platform-api";

type PlatformAdminSessionInput = {
  token?: string;
  user: Pick<PlatformSession["user"], "id" | "email" | "name">;
  workspaces: Array<Pick<PlatformSession["workspaces"][number], "id" | "name">>;
};

const platformAdminCapabilities = platformCapabilities.filter(
  (capability) => capability !== "account.manage",
);

// Browser fixtures model the session projection issued by the server. Keeping
// this in one place prevents old roles or locally invented capabilities from
// silently bypassing the storage-boundary contract.
export function platformAdminSession({
  token = "platform-test-token",
  user,
  workspaces,
}: PlatformAdminSessionInput): PlatformSession {
  return {
    token,
    user: { ...user, globalRole: null },
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      role: "admin",
      capabilities: [...platformAdminCapabilities],
    })),
  };
}
