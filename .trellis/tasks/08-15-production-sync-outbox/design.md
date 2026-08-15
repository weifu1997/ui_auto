# Design: Production Sync Outbox

## Boundary

只修改生产 `ServerWorkspaceSynchronizer` 的持久化与重试行为，不改变服务端 API 契约，不统一开发/生产两套同步器。

## Problem

当前同步器只在内存里维护 `versions`、`pendingSyncs` 和定时器；刷新/导航会清空定时器，普通修改没有持久 outbox，因此服务端未收到时刷新会被远端旧数据覆盖。失败分支也没有自动重试。

## Persistent Draft

新增 `src/sync-outbox.ts`，使用 `localStorage` key `autoflow-sync-outbox-v1` 保存项目级可恢复草稿：

```ts
type SyncDraft = {
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
  pending: Array<
    | "flows" | "elements" | "variables" | "environments"
    | "settings" | "metadata"
  >;
  conflict?: boolean;
};
```

`sync-outbox.ts` 负责：

- 读取、校验、写入和按 `workspaceId + projectId` 替换草稿。
- 从当前 workspace store 构建 sanitized draft。
- 将 draft 回灌到 workspace store。
- 对 `secret === true` 的变量强制 `value: ""`，确保密钥明文不落盘。

任何资源、环境、项目元数据或 active environment 变更都先 upsert 全项目 draft，再进入 450 ms 防抖网络同步。

## Hydration Flow

1. 组件挂载时，把当前 workspace 的 draft 回灌到 store，避免刷新后先被远端覆盖。
2. TanStack Query 返回服务端资源后，若项目存在 draft，则 `localSerialized` 不等于远端且 `lastApplied` 为空，保持本地 draft。
3. 对冲突 draft 显示冲突状态，不自动重试；普通 draft 设置 `queued` 并启动同步。
4. 查询失败时 draft 仍在 store 中，项目可继续显示并进入重试。

## Sync and Retry

用项目级 `syncProject(projectId)` 替代按资源类型直接调度：

- 从 `pending` 中逐个处理资源类型、settings、metadata。
- 资源逻辑沿用现有 create/update/archive 与版本 map。
- 每个成功项从 `pending` 移除并更新持久 draft。
- `pending` 清空后删除 draft、设置 `synced`，并调度 revision snapshot。
- `inFlightProjects` 防止同一项目并发同步。

错误分类：

- `PlatformApiError.status` 为 `0`、`429`、`5xx`，以及非 API 网络错误：保留 draft，设置 `retrying`，指数退避重试；延迟 `min(30_000, 1000 * 2 ** attempts)`，成功后重置。
- `RESOURCE_VERSION_CONFLICT`：先读取远端资源；若远端 data 与本地 sanitized data 相同，视为已同步；否则设置 `conflict`，写 sessionStorage 冲突草稿并显示现有恢复动作。
- 其他 4xx：设置 `failed`，保留 draft，供用户处理。

## Conflict Recovery

- `刷新远端`：删除 outbox draft 与 sessionStorage 冲突草稿，然后 refetch，以服务端为准。
- `重新提交`：清除 conflict 标记，保留 draft，refetch 后按最新版本重新同步。

## Status Model

扩展 `PlatformSyncStatus`：

```ts
type PlatformSyncStatus =
  | "queued" | "syncing" | "retrying" | "conflict" | "synced" | "failed";
```

`AgentsPage` 状态标签增加“等待同步”“重试中”“冲突”文案。

## Secret Safety

- draft 中 secret variable 的 `value` 始终为空字符串。
- outbox 不保存 revision snapshot、运行请求或平台 session。
- localStorage 写入失败时仍保留内存同步路径，并显示失败状态。

## Compatibility

- 不改变现有 API 响应结构。
- 旧 `autoflow-conflict-<projectId>` sessionStorage 格式继续兼容。
- `workspace-store` 持久化版本可保持；新增 status 枚举不需要数据迁移，旧值仍有效。

## Rollback

- 可回滚点：`src/sync-outbox.ts`、`ServerWorkspaceSynchronizer.tsx`、`workspace-store.ts` 状态类型、UI 文案、Playwright 配置。
- 回滚后回到内存同步行为，不删除用户浏览器中已有 draft；必要时可手动清 `autoflow-sync-outbox-v1`。
