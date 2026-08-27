import { currentPlatformUserId, platformContextChangedEvent } from "../api/platform-context";
import {
  migrateUnscopedStorageKey,
  removeUserScopedStorageKeys,
  withSuppressedPersistWrites,
} from "./user-scoped-storage";
import { runStorageKey, useRunStore } from "../stores/run-store";
import { useFlowStore } from "../stores/flow-store";
import { useSecretStore } from "../stores/secret-store";
import { useWorkspaceStore, workspaceStorageKey } from "../stores/workspace-store";
import { clearAllConflictSnapshots, syncOutboxStorageKey } from "./sync-outbox";
// W1-7：运行派发幂等键也按登录用户分区持久化，切号时随其它分区一并清理。
import { RUN_DISPATCH_KEY_STORAGE } from "../pages/shared";

const userScopedBases = [
  workspaceStorageKey,
  runStorageKey,
  syncOutboxStorageKey,
  RUN_DISPATCH_KEY_STORAGE,
];

export function resetInMemoryWorkspaceState() {
  // 抑制 persist 写盘：重置内存态只应清空视图，不能把当前用户已持久化的数据覆盖成空对象。
  withSuppressedPersistWrites(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useRunStore.setState(useRunStore.getInitialState(), true);
    useSecretStore.setState(useSecretStore.getInitialState(), true);
    useFlowStore.getState().reset();
  });
}

export type AccountStateChange = {
  previousUserId: string;
  nextUserId: string;
};

// 登录/切到真实账号时：把模块加载期（可能处于匿名态）未迁移的旧 key 归入该
// 用户分区，再从磁盘重新 hydration 该用户的持久化数据（工作区/运行记录）。
export function restoreUserScopedState(userId: string) {
  for (const base of userScopedBases) {
    migrateUnscopedStorageKey(base, userId);
  }
  void useWorkspaceStore.persist.rehydrate();
  void useRunStore.persist.rehydrate();
}

// 账号切换的落地规则：
// - 切到任何身份都清空内存态（工作区/运行记录/编辑器草稿/会话密钥值）；
// - 仅在两个具体账号之间切换时删除前一账号的本地分区与冲突快照，
//   会话过期→同账号重登不清磁盘，离线草稿得以保留；
// - 切到真实账号时补跑旧 key 迁移并重新 hydration 该账号数据。
export function applyAccountStateChange(
  previousUserId: string,
  nextUserId: string,
): AccountStateChange {
  resetInMemoryWorkspaceState();
  if (nextUserId && previousUserId) {
    removeUserScopedStorageKeys(userScopedBases, previousUserId);
    clearAllConflictSnapshots();
  }
  if (nextUserId) {
    restoreUserScopedState(nextUserId);
  }
  return { previousUserId, nextUserId };
}

export type AccountStateResetOptions = {
  onAccountStateChanged?: (change: AccountStateChange) => void;
};

// main.tsx 安装一次；TanStack Query 缓存持有前一账号的服务器数据，必须随切换一并清空。
let installed = false;

export function installAccountStateReset(options: AccountStateResetOptions = {}) {
  if (installed) return;
  installed = true;
  let lastUserId = currentPlatformUserId();
  window.addEventListener(platformContextChangedEvent, () => {
    const nextUserId = currentPlatformUserId();
    if (nextUserId === lastUserId) return;
    const change = applyAccountStateChange(lastUserId, nextUserId);
    options.onAccountStateChanged?.(change);
    lastUserId = nextUserId;
  });
}
