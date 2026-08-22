import { beforeEach, describe, expect, it } from "vitest";
import {
  allSyncDraftPending,
  applyProjectDraft,
  buildProjectDraft,
  readProjectDraft,
  readSyncOutbox,
  removeProjectDraft,
  syncOutboxStorageKey,
  upsertProjectDraft,
} from "./sync-outbox";
import { useWorkspaceStore } from "../stores/workspace-store";

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
    const raw = localStorage.getItem(syncOutboxStorageKey) ?? "";
    expect(raw).not.toContain("plaintext-secret");
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
