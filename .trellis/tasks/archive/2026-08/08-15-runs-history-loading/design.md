# Design: Runs History Loading

## Boundary

只修改运行中心的服务端历史加载与轮询行为，不改变运行数据模型，不新增平台 API。

## Current Defect

`src/pages/RunsPage.tsx:62` 的 `refreshPlatformRuns` 只在 pathname 以 `/platform` 结尾时加载平台运行。运行中心实际路由是 `/project/:id/runs`，因此首次进入不会自动拉取服务端历史。

## Change

1. 移除 `refreshPlatformRuns` 中的 `/platform` 路径判断。
2. 使用 `platformProjectId ?? legacyPlatformProjectId` 作为 remote project id，避免 store 尚未 enable 时首次渲染漏加载。
3. 首次挂载立即拉取平台运行；随后轮询：
   - 存在非终态平台运行：3 秒刷新。
   - 只有终态历史：15 秒刷新，兼顾计划任务/Webhook 新运行自动出现。
   - 无 remote project id：不启动轮询。
4. 手动“刷新状态”继续同时刷新 Worker 与平台运行。

## Merge and Dedupe

- `useRunStore.upsertRun` 以 `run.id` 去重，平台运行与本地 Worker 运行不会因重复响应产生重复行。
- Worker 运行通过 `isWorkerRunId` 识别；平台运行使用服务端 UUID。
- 清空 `autoflow-run-records` 后，首次进入运行中心仍会从服务端重建历史。

## Polling Boundary

- Worker 运行继续由 SSE `watchWorkerRun` 订阅，不走平台轮询。
- 非终态平台运行使用短轮询，终态历史使用慢刷新，避免无界高频请求。
- `usePolling` 的 visibility 暂停逻辑保持不变。

## Tests

- Playwright：空 `autoflow-run-records` 下进入 `/project/:id/runs`，平台运行自动出现。
- Playwright：计划/Webhook 新增运行后，在约定刷新周期内自动出现。
- 保留现有本地 Worker 运行与平台运行合并去重。

## Rollback

- 回滚 `RunsPage.tsx` 的路径判断与轮询间隔即可恢复旧行为。
