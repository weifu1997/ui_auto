import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

const getPlatformSecretsMock = vi.fn(async (..._args: unknown[]) => ({ secrets: [] as PlatformSecret[] }));
const savePlatformSecretMock = vi.fn(async (..._args: unknown[]) => ({ secret: { id: "s-1", name: "n", keyVersion: 1 } }));

vi.mock("../api/platform-api", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPlatformSecrets: (...args: any[]) => getPlatformSecretsMock(...args),
    savePlatformSecret: (...args: any[]) => savePlatformSecretMock(...args),
  };
});

import { message, modal } from "../lib/antd-feedback";
import { platformWorkspaceStorageKey, storePlatformSession } from "../api/platform-context";
import type { PlatformSecret } from "../api/platform-api";
import { ensurePlatformRunSecrets, splitSecretRequirements } from "./shared";
import type { Variable } from "../lib/mock-data";

const secretVariable: Variable = {
  id: "v-1",
  name: "api-token",
  description: "",
  value: "",
  scope: "项目",
  secret: true,
  updatedAt: "刚刚",
};
const steps = [{ id: "s1", title: "调用接口", action: "点击", value: "Bearer {{ project.api-token }}", timeout: 10, failurePolicy: "立即失败", status: "pending" }];

function loginAs(capabilities: string[]) {
  storePlatformSession({
    token: "token-1",
    user: { id: "u-1", email: "u-1@example.test", name: "User", globalRole: null },
    workspaces: [{ id: "ws-1", name: "Workspace", role: capabilities.includes("secret.manage") ? "admin" : "member", capabilities: capabilities as never }],
  });
  localStorage.setItem(platformWorkspaceStorageKey, "ws-1");
}

describe("splitSecretRequirements", () => {
  it("服务器已配置的密钥不再计入 missing", () => {
    const { required, missing } = splitSecretRequirements([secretVariable], steps as never, ["project.api-token"]);
    expect(required).toHaveLength(1);
    expect(missing).toHaveLength(0);
  });

  it("未配置的密钥进入 missing", () => {
    const { missing } = splitSecretRequirements([secretVariable], steps as never, []);
    expect(missing.map((variable) => variable.name)).toEqual(["api-token"]);
  });
});

describe("ensurePlatformRunSecrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("全部已配置时直接放行，不弹窗、不写服务器", async () => {
    loginAs(["run.execute"]);
    getPlatformSecretsMock.mockResolvedValueOnce({ secrets: [{ id: "s-1", name: "project.api-token", keyVersion: 1, createdAt: "", updatedAt: "" }] });
    await expect(ensurePlatformRunSecrets("token-1", "p-1", [secretVariable], steps as never)).resolves.toBe(true);
    expect(modal.confirm).not.toHaveBeenCalled();
    expect(savePlatformSecretMock).not.toHaveBeenCalled();
  });

  it("member 遇到未配置密钥：提示联系管理员，不弹窗、不调用仅管理员可用的写入", async () => {
    loginAs(["run.execute"]);
    getPlatformSecretsMock.mockResolvedValueOnce({ secrets: [] });
    await expect(ensurePlatformRunSecrets("token-1", "p-1", [secretVariable], steps as never)).resolves.toBe(false);
    expect(message.error).toHaveBeenCalledWith(expect.stringContaining("api-token"));
    expect(modal.confirm).not.toHaveBeenCalled();
    expect(savePlatformSecretMock).not.toHaveBeenCalled();
  });

  it("admin 遇到未配置密钥：弹窗要求补齐，未填写时拒绝提交", async () => {
    loginAs(["run.execute", "secret.manage"]);
    getPlatformSecretsMock.mockResolvedValueOnce({ secrets: [] });
    const pending = ensurePlatformRunSecrets("token-1", "p-1", [secretVariable], steps as never);
    await vi.waitFor(() => expect(modal.confirm).toHaveBeenCalledTimes(1));
    const config = (modal.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await expect(config.onOk()).rejects.toThrow("SECRET_VALUE_REQUIRED");
    expect(savePlatformSecretMock).not.toHaveBeenCalled();
    config.onCancel();
    await expect(pending).resolves.toBe(false);
  });
});
