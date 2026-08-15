# Implementation Plan: Production Sync Outbox

## Order

1. 新增 `src/sync-outbox.ts`，实现 draft 存储、构建、回灌和 secret sanitization。
2. 扩展 `src/workspace-store.ts` 的 `PlatformSyncStatus`，增加 `queued` 与 `conflict`。
3. 重构 `src/ServerWorkspaceSynchronizer.tsx`：
   - store 变更先 upsert draft。
   - hydration 前回灌 draft。
   - 项目级 `syncProject` 处理 pending。
   - transient failure 指数退避重试。
   - 409 冲突保留草稿并支持刷新/重提。
4. 更新 `src/pages/AgentsPage.tsx` 状态标签文案。
5. 新增 `scripts/dev-auth.mjs`，提供 `VITE_AUTH_REQUIRED=1` 的 Vite 服务，用于 production/auth-required E2E。
6. 更新 `playwright.config.ts`，增加 production auth 项目与测试匹配。
7. 新增 `src/sync-outbox.test.ts` 和 `tests/production-sync.spec.ts`。

## Test Scenarios

- 保存后立即导航/刷新，draft 仍在 outbox，刷新后服务端恢复并同步。
- 首个请求 5xx，第二次请求成功，无需再次编辑自动同步。
- 409 冲突后显示冲突动作；刷新远端丢弃本地 draft，重新提交按最新版本重试。
- secret variable 的 value 不进入 localStorage outbox。
- outbox 能按 workspace/project 替换旧 draft。

## Validation Commands

```bash
npm run lint
npm run build
npm run test:unit
npm run test:py
npx playwright test tests/production-sync.spec.ts
npm run test:e2e
```

## Review Gates

- 刷新前后 `autoflow-sync-outbox-v1` 中存在非空 draft，直到服务端确认。
- 5xx 恢复后不需要再次编辑。
- 409 不覆盖远端，且用户可选择刷新或重提。
- `localStorage` 中不包含 secret variable value。
- 现有 `platform-sync.spec.ts` 与 `templates-and-conflicts.spec.ts` 保持通过。

## Rollback Points

- `src/sync-outbox.ts` 可独立移除。
- 若 Playwright auth 服务造成不稳定，可先回退 `playwright.config.ts` 与 `scripts/dev-auth.mjs`。
- 不删除用户浏览器中的 draft，除非用户明确选择“刷新远端”。
