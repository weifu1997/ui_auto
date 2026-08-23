import type { ElementAsset, Environment, Flow, Variable } from "./mock-data";
import { useWorkspaceStore } from "../stores/workspace-store";
import { currentPlatformUserId } from "../api/platform-context";
import { migrateUnscopedStorageKey, userScopedStorageKey } from "./user-scoped-storage";

export const syncOutboxStorageKey = "autoflow-sync-outbox-v1";
migrateUnscopedStorageKey(syncOutboxStorageKey);

export type SyncDraftPending =
  | "flows"
  | "elements"
  | "variables"
  | "environments"
  | "settings"
  | "metadata";

export const allSyncDraftPending: SyncDraftPending[] = [
  "flows",
  "elements",
  "variables",
  "environments",
  "settings",
  "metadata",
];

export type SyncDraft = {
  id: string;
  workspaceId: string;
  projectId: string;
  savedAt: string;
  project: { name: string; description: string };
  flows: Flow[];
  elements: ElementAsset[];
  variables: Variable[];
  environments: Environment[];
  activeEnvironmentId: string;
  pending: SyncDraftPending[];
  conflict?: boolean;
};

function isSyncDraft(value: unknown): value is SyncDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<SyncDraft>;
  return (
    typeof draft.id === "string"
    && typeof draft.workspaceId === "string"
    && typeof draft.projectId === "string"
    && typeof draft.savedAt === "string"
    && typeof draft.project === "object"
    && draft.project !== null
    && Array.isArray(draft.flows)
    && Array.isArray(draft.elements)
    && Array.isArray(draft.variables)
    && Array.isArray(draft.environments)
    && typeof draft.activeEnvironmentId === "string"
    && Array.isArray(draft.pending)
  );
}

function outboxStorageKey() {
  return userScopedStorageKey(syncOutboxStorageKey);
}

// 测试与升级路径显式触发旧 key 迁移；模块加载时已自动执行一次。
export function migrateLegacyOutbox() {
  migrateUnscopedStorageKey(syncOutboxStorageKey);
}

export function readSyncOutbox() {
  try {
    const parsed = JSON.parse(localStorage.getItem(outboxStorageKey()) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSyncDraft) : [];
  } catch {
    return [];
  }
}

function writeSyncOutbox(drafts: SyncDraft[]) {
  try {
    localStorage.setItem(outboxStorageKey(), JSON.stringify(drafts));
  } catch {
    // 内存同步仍然继续；持久化失败会让用户看到同步失败，避免静默丢数据。
  }
}

export function readProjectDraft(workspaceId: string, projectId: string) {
  return readSyncOutbox().find(
    (draft) => draft.workspaceId === workspaceId && draft.projectId === projectId,
  );
}

export function upsertProjectDraft(draft: SyncDraft) {
  const drafts = readSyncOutbox().filter(
    (item) => item.workspaceId !== draft.workspaceId || item.projectId !== draft.projectId,
  );
  writeSyncOutbox([...drafts, draft]);
}

export function updateProjectDraft(
  workspaceId: string,
  projectId: string,
  patch: Partial<Omit<SyncDraft, "id" | "workspaceId" | "projectId">>,
) {
  const drafts = readSyncOutbox();
  const index = drafts.findIndex(
    (item) => item.workspaceId === workspaceId && item.projectId === projectId,
  );
  if (index < 0) return;
  drafts[index] = { ...drafts[index], ...patch, savedAt: new Date().toISOString() };
  writeSyncOutbox(drafts);
}

export function removeProjectDraft(workspaceId: string, projectId: string) {
  writeSyncOutbox(
    readSyncOutbox().filter(
      (item) => item.workspaceId !== workspaceId || item.projectId !== projectId,
    ),
  );
}

function sanitizeVariable(variable: Variable): Variable {
  return variable.secret ? { ...variable, value: "" } : variable;
}

export function buildProjectDraft(
  workspaceId: string,
  projectId: string,
  pending: SyncDraftPending[],
  conflict = false,
): SyncDraft {
  const state = useWorkspaceStore.getState();
  const project = state.projects.find((item) => item.id === projectId);
  return {
    id: `${workspaceId}:${projectId}`,
    workspaceId,
    projectId,
    savedAt: new Date().toISOString(),
    project: {
      name: project?.name ?? projectId,
      description: project?.description ?? "",
    },
    flows: state.flowsByProject[projectId] ?? [],
    elements: state.elementsByProject[projectId] ?? [],
    variables: (state.variablesByProject[projectId] ?? []).map(sanitizeVariable),
    environments: state.environmentsByProject[projectId] ?? [],
    activeEnvironmentId: state.activeEnvironmentByProject[projectId] ?? "",
    pending,
    conflict,
  };
}

export function applyProjectDraft(draft: SyncDraft) {
  const store = useWorkspaceStore.getState();
  if (store.projects.some((project) => project.id === draft.projectId)) {
    store.updateProject(draft.projectId, draft.project);
  }
  store.setFlows(draft.projectId, draft.flows);
  store.setElements(draft.projectId, draft.elements);
  store.setVariables(draft.projectId, draft.variables);
  store.setEnvironments(draft.projectId, draft.environments);
  store.setActiveEnvironment(draft.projectId, draft.activeEnvironmentId);
}

export function sanitizeResourceData<T extends Record<string, unknown>>(data: T): T {
  if (
    data.secret === true
    && typeof data.value === "string"
  ) {
    return { ...data, value: "" };
  }
  return data;
}

// 冲突快照与 outbox 一样按用户分区，避免后登录者读到前一账号的冲突草稿。
export function conflictSnapshotKey(projectId: string, userId = currentPlatformUserId()) {
  return `autoflow-conflict:${userId || "_anonymous"}:${projectId}`;
}

export function readConflictSnapshotRaw(projectId: string) {
  try {
    return sessionStorage.getItem(conflictSnapshotKey(projectId));
  } catch {
    return null;
  }
}

export function writeConflictSnapshot(projectId: string, draft: unknown) {
  try {
    sessionStorage.setItem(conflictSnapshotKey(projectId), JSON.stringify(draft));
  } catch {
    // 快照仅用于冲突恢复提示；写入失败不阻断同步流程。
  }
}

export function clearConflictSnapshot(projectId: string) {
  try {
    sessionStorage.removeItem(conflictSnapshotKey(projectId));
  } catch {
    // 忽略：快照不存在时 removeItem 也是无害的。
  }
}

export function clearAllConflictSnapshots() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("autoflow-conflict")) sessionStorage.removeItem(key);
    }
  } catch {
    // 忽略：清理失败不影响账号切换主流程。
  }
}
