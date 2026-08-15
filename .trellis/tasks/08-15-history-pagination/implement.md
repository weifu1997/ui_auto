# Implementation Plan: History Pagination

## Order

1. 服务端实现 runs 查询参数、过滤、计数和分页。
2. 服务端实现 deliveries 查询参数、过滤、计数和分页。
3. 更新 `src/platform-api.ts` 的 `getPlatformRuns` / `getPlatformDeliveries` 类型与 query。
4. `RunsPage` 接入 URL query、服务端分页和 Worker 合并。
5. `AutomationsPage` 投递区域接入 URL query、服务端分页和筛选。
6. 新增后端分页测试和 Playwright URL 恢复测试。

## Validation Commands

```bash
npm run lint
npm run build
npm run test:unit
npm run test:py
npx playwright test tests/history-pagination.spec.ts
npm run test:e2e
```

## Review Gates

- 运行/投递接口返回分页总数，且只请求当前页。
- 状态、流程、来源、通道和时间范围筛选可在服务端生效。
- URL 刷新后筛选和页码恢复。
- 现有运行中心 Worker 兼容与投递记录展示保持可用。

## Rollback Points

- 后端 query 参数可逐个回滚。
- 前端 query helper 可独立移除。
