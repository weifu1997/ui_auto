import { beforeEach, describe, expect, it } from "vitest";
import { storePlatformSession } from "../api/platform-context";
import { applyAccountStateChange, installAccountStateReset } from "./account-state-reset";
import {
  buildProjectDraft,
  conflictSnapshotKey,
  readSyncOutbox,
  syncOutboxStorageKey,
  upsertProjectDraft,
  writeConflictSnapshot,
} from "./sync-outbox";
import { useRunStore } from "../stores/run-store";
import { useWorkspaceStore, workspaceStorageKey } from "../stores/workspace-store";
import { userScopedStorageKey } from "./user-scoped-storage";

function sessionFor(userId: string) {
  return {
    token: `token-${userId}`,
    user: { id: userId, email: `${userId}@example.test`, name: userId, globalRole: null },
    workspaces: [],
  };
}

function seedUserAState() {
  storePlatformSession(sessionFor("user-a"));
  useWorkspaceStore.setState({
    projects: [{ id: "p-1", name: "Project A", description: "" }],
    flowsByProject: {},
    elementsByProject: {},
    variablesByProject: {},
    environmentsByProject: {},
    activeEnvironmentByProject: {},
  });
  useRunStore.getState().upsertRun("p-1", { id: "run-a" } as never);
  upsertProjectDraft(buildProjectDraft("ws-1", "p-1", ["flows"]));
  writeConflictSnapshot("p-1", { savedAt: "2026-08-22T00:00:00.000Z" });
}

describe("account-scoped browser state", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useRunStore.setState(useRunStore.getInitialState(), true);
    installAccountStateReset();
  });

  it("持久化键按用户分区：outbox 与 workspace store 写入 u:<userId> 作用域", () => {
    seedUserAState();
    expect(localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey, "user-a"))).toContain("ws-1");
    expect(localStorage.getItem(userScopedStorageKey(workspaceStorageKey, "user-a"))).toContain("Project A");
    expect(localStorage.getItem(syncOutboxStorageKey)).toBeNull();
  });

  it("同用户会话刷新不清空任何数据", () => {
    seedUserAState();
    storePlatformSession(sessionFor("user-a"));
    expect(readSyncOutbox()).toHaveLength(1);
    expect(useWorkspaceStore.getState().projects).toHaveLength(1);
    expect(sessionStorage.getItem(conflictSnapshotKey("p-1", "user-a"))).not.toBeNull();
  });

  it("切换到另一账号：清空内存态、删除前一账号分区与冲突快照", () => {
    seedUserAState();
    storePlatformSession(sessionFor("user-b"));
    expect(useWorkspaceStore.getState().projects).toHaveLength(0);
    expect(useRunStore.getState().apiRuns["p-1"]).toBeUndefined();
    expect(readSyncOutbox()).toHaveLength(0);
    expect(localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey, "user-a"))).toBeNull();
    expect(localStorage.getItem(userScopedStorageKey(workspaceStorageKey, "user-a"))).toBeNull();
    expect(sessionStorage.getItem(conflictSnapshotKey("p-1", "user-a"))).toBeNull();
  });

  it("会话过期只清内存，磁盘分区保留供同账号重登恢复", () => {
    seedUserAState();
    storePlatformSession();
    expect(useWorkspaceStore.getState().projects).toHaveLength(0);
    expect(localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey, "user-a"))).toContain("ws-1");
    storePlatformSession(sessionFor("user-a"));
    expect(readSyncOutbox()).toHaveLength(1);
  });

  it("重登时重置内存态不覆盖同账号已持久化的工作区/运行数据", () => {
    seedUserAState();
    storePlatformSession();
    // 会话过期后 A 的磁盘分区仍在
    expect(localStorage.getItem(userScopedStorageKey(workspaceStorageKey, "user-a"))).toContain("Project A");
    // 同账号重登：applyAccountStateChange("", "user-a") 会重置内存态，
    // persist 不得把 A 已持久化的数据覆盖成空对象
    storePlatformSession(sessionFor("user-a"));
    expect(localStorage.getItem(userScopedStorageKey(workspaceStorageKey, "user-a"))).toContain("Project A");
    expect(localStorage.getItem(userScopedStorageKey(workspaceStorageKey, "user-a"))).not.toContain('"projects":[]');
  });

  it("匿名加载后登录：旧的无作用域 key 归入该账号分区并恢复数据", () => {
    // 模块加载时处于匿名态，旧 key 未迁移（F3）；登录后补迁移并 hydration。
    localStorage.setItem(
      workspaceStorageKey,
      JSON.stringify({
        state: { projects: [{ id: "legacy-p", name: "Legacy", description: "" }] },
        version: 8,
      }),
    );
    // 先落会话，使 rehydrate 时 currentPlatformUserId() = "user-a"，读对分区
    storePlatformSession(sessionFor("user-a"));
    applyAccountStateChange("", "user-a");
    expect(localStorage.getItem(userScopedStorageKey(workspaceStorageKey, "user-a"))).toContain("Legacy");
    expect(localStorage.getItem(workspaceStorageKey)).toBeNull();
    expect(useWorkspaceStore.getState().projects.some((p) => p.id === "legacy-p")).toBe(true);
  });
});

describe("applyAccountStateChange", () => {
  it("匿名之间的切换不触碰磁盘分区", () => {
    localStorage.setItem(userScopedStorageKey(syncOutboxStorageKey, "user-a"), "[]");
    applyAccountStateChange("", "user-b");
    expect(localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey, "user-a"))).toBe("[]");
  });
});
