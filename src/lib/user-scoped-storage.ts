import type { StateStorage } from "zustand/middleware";
import { currentPlatformUserId } from "../api/platform-context";

const ANONYMOUS_SCOPE = "_anonymous";

// 跨账号共用浏览器时，持久化状态按登录用户分区，后登录者不会读到前一账号的缓存与离线草稿。
export function userScopedStorageKey(base: string, userId = currentPlatformUserId()) {
  return `${base}:u:${userId || ANONYMOUS_SCOPE}`;
}

// 一次性迁移：升级前没有用户维度的旧 key 归入当前用户分区，保留离线草稿。
// 匿名（未登录）时不迁移：登录前把旧数据挪进 `_anonymous` 分区并在登录后删除
// 旧 key，会让真实账号永远读不到这份数据（F3）。迁移推迟到确认拿到真实用户后执行。
export function migrateUnscopedStorageKey(base: string, userId = currentPlatformUserId()) {
  if (!userId) return;
  const scoped = userScopedStorageKey(base, userId);
  if (localStorage.getItem(scoped) !== null) return;
  const legacy = localStorage.getItem(base);
  if (legacy === null) return;
  localStorage.setItem(scoped, legacy);
  localStorage.removeItem(base);
}

export function removeUserScopedStorageKeys(bases: string[], userId: string) {
  for (const base of bases) {
    localStorage.removeItem(userScopedStorageKey(base, userId));
    localStorage.removeItem(base);
  }
}

// 账号切换期间，zustand persist 会在每次 setState 时把内存态写回 localStorage。
// 清空内存态（setState(initialState)）本意只是重置视图，若同时写盘会把当前用户
// 已持久化的数据覆盖成空对象。因此重置内存态时抑制 persist 写盘，重置结束后恢复。
let suppressPersistWrites = false;

export function withSuppressedPersistWrites<T>(fn: () => T): T {
  const previous = suppressPersistWrites;
  suppressPersistWrites = true;
  try {
    return fn();
  } finally {
    suppressPersistWrites = previous;
  }
}

export function userScopedStateStorage(): StateStorage {
  return {
    getItem: (name) => localStorage.getItem(userScopedStorageKey(name)),
    setItem: (name, value) => {
      if (suppressPersistWrites) return;
      localStorage.setItem(userScopedStorageKey(name), value);
    },
    removeItem: (name) => localStorage.removeItem(userScopedStorageKey(name)),
  };
}
