import { beforeEach, describe, expect, it } from "vitest";
import { storePlatformSession } from "../api/platform-context";
import {
  allSyncDraftPending,
  applyProjectDraft,
  buildProjectDraft,
  migrateLegacyOutbox,
  readProjectDraft,
  readSyncOutbox,
  removeProjectDraft,
  syncOutboxStorageKey,
  upsertProjectDraft,
} from "./sync-outbox";
import { useWorkspaceStore } from "../stores/workspace-store";
import { userScopedStorageKey } from "./user-scoped-storage";

function sessionFor(userId: string) {
  return {
    token: `token-${userId}`,
    user: { id: userId, email: `${userId}@example.test`, name: userId, globalRole: null },
    workspaces: [],
  };
}

function seedStore() {
  useWorkspaceStore.setState({
    projects: [{ id: "p-1", name: "Project", description: "" }],
    flowsByProject: {},
    elementsByProject: {},
    variablesByProject: {
      "p-1": [
        {
          id: "v-1",
          name: "api-token",
          description: "",
          value: "plaintext-secret",
          scope: "项目",
          secret: true,
          updatedAt: "刚刚",
        },
      ],
    },
    environmentsByProject: {},
    activeEnvironmentByProject: {},
  });
}

describe("sync outbox", () => {
  beforeEach(() => {
    localStorage.clear();
    seedStore();
  });

  it("never persists secret variable values", () => {
    const draft = buildProjectDraft("ws-1", "p-1", allSyncDraftPending);
    expect(draft.variables[0].value).toBe("");
    upsertProjectDraft(draft);
    const raw = localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey)) ?? "";
    expect(raw).not.toContain("plaintext-secret");
  });

  it("migrates a legacy unscoped outbox key into the current user's scope once", () => {
    storePlatformSession(sessionFor("user-x"));
    localStorage.setItem(syncOutboxStorageKey, JSON.stringify([{ not: "a-draft" }]));
    migrateLegacyOutbox();
    expect(localStorage.getItem(syncOutboxStorageKey)).toBeNull();
    expect(localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey))).toBe(JSON.stringify([{ not: "a-draft" }]));
    localStorage.setItem(syncOutboxStorageKey, "[]");
    migrateLegacyOutbox();
    expect(localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey))).toBe(JSON.stringify([{ not: "a-draft" }]));
  });

  it("does not migrate the legacy key while anonymous so login can claim it later", () => {
    // 模块加载时若处于匿名态，旧 key 必须原地保留，等真实账号登录后再归入其分区。
    localStorage.setItem(syncOutboxStorageKey, JSON.stringify([{ legacy: "data" }]));
    migrateLegacyOutbox();
    expect(localStorage.getItem(syncOutboxStorageKey)).toBe(JSON.stringify([{ legacy: "data" }]));
    expect(localStorage.getItem(userScopedStorageKey(syncOutboxStorageKey))).toBeNull();
  });

  it("replaces a project draft on upsert and removes it on demand", () => {
    upsertProjectDraft(buildProjectDraft("ws-1", "p-1", ["flows"]));
    upsertProjectDraft(buildProjectDraft("ws-1", "p-1", ["elements"]));
    expect(readSyncOutbox()).toHaveLength(1);
    expect(readProjectDraft("ws-1", "p-1")?.pending).toEqual(["elements"]);

    removeProjectDraft("ws-1", "p-1");
    expect(readProjectDraft("ws-1", "p-1")).toBeUndefined();
  });

  it("restores a draft into the workspace store", () => {
    const draft = {
      ...buildProjectDraft("ws-1", "p-1", []),
      flows: [{ id: "flow-1", name: "Flow", description: "", tags: [], steps: 0, lastStatus: "success" as const, updatedAt: "刚刚" }],
      activeEnvironmentId: "env-1",
    };
    upsertProjectDraft(draft);

    useWorkspaceStore.setState({
      flowsByProject: {},
      activeEnvironmentByProject: {},
    });
    applyProjectDraft(draft);

    expect(useWorkspaceStore.getState().flowsByProject["p-1"]).toHaveLength(1);
    expect(useWorkspaceStore.getState().activeEnvironmentByProject["p-1"]).toBe("env-1");
  });
});
