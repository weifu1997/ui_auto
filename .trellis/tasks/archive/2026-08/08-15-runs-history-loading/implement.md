# Implementation Plan: Runs History Loading

## Order

1. 修改 `src/pages/RunsPage.tsx`：
   - 去掉 `/platform` pathname 限制。
   - 使用 remote project id fallback。
   - 首次挂载拉取平台运行。
   - 根据是否存在非终态平台运行切换 3s/15s 轮询。
2. 新增 `tests/runs-history.spec.ts`，覆盖空缓存、计划触发和 Worker 合并场景。
3. 更新前端 spec 中关于运行中心的说明。

## Validation Commands

```bash
npm run lint
npm run build
npm run test:unit
npx playwright test tests/runs-history.spec.ts
npm run test:e2e
```

## Review Gates

- 清空 `autoflow-run-records` 后进入 `/project/:id/runs` 仍显示服务端历史。
- 首次进入不需要点击“刷新状态”。
- 非终态运行短轮询；终态历史不持续高频轮询。
- 本地 Worker 与平台运行合并后无重复行。

## Rollback Points

- `RunsPage.tsx` 可单独回滚。
- 新增测试不影响现有运行中心行为。
