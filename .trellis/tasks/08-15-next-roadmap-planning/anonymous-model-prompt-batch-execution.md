# 匿名模型实现评测 Prompt：流程批量执行 MVP

> 将本文件从标题下一行开始，原样发送给每个参评模型。四个模型必须收到完全相同的内容。

你是一名在现有代码库中自主工作的高级全栈工程师。请在当前 AutoFlow Workbench 仓库中完整实现“流程批量执行 MVP”。这是一项真实编码任务，不是方案讨论；你需要阅读仓库、修改数据库迁移、服务、API、前端和测试，并实际运行验证。

本 Prompt 代表产品方已经明确批准以下现有计划，可以直接进入实现，不需要再询问是否开始：

- `.trellis/tasks/08-15-flow-batch-execution-mvp/prd.md`
- `.trellis/tasks/08-15-flow-batch-execution-mvp/design.md`
- `.trellis/tasks/08-15-flow-batch-execution-mvp/implement.md`

## 工作规则

1. 先阅读根目录 `AGENTS.md`、`.trellis/workflow.md`、前后端 spec 索引和上述三份计划，再检查实际代码。计划中的行号只是调查证据，必须以当前代码为准。
2. 遵守 Trellis 工作流。该子任务当前为 planning；本 Prompt 是对最终计划的实施批准，你可以启动该子任务并进入实现。
3. 自主完成工作，不等待人工确认。遇到实现细节不明确时，选择与计划、既有代码和最小可靠 MVP 最一致的方案，并在最终报告中说明。
4. 不得删除、跳过、放宽或改写已有测试来掩盖失败。不得回滚与本任务无关的已有工作区修改。
5. 不得提交真实账号、密码、token、本地 SQLite 数据、运行产物或依赖缓存。
6. 不得用前端 `Promise.all` 循环现有单运行 API 作为批量执行实现。Batch 必须是服务端持久实体并具有原子性和幂等性。
7. MVP 保持 ManagedRunner 单并发 FIFO；不得把“批量”偷偷改成不受控并行。
8. 不提交或推送 Git commit，除非评测环境另有明确要求。保留完整工作区 diff 供评测。

## 必须先修复的正确性缺陷

当前手工运行只传 environmentId，服务端可能选择项目最近发布的任意 revision。先修复为：

- 单流程入口至少传 `flowId` 或明确 `revisionId`。
- 无 revisionId 时按 `projectId + flowId + environmentId` 解析该流程最新 published revision。
- revisionId、flowId、environmentId 同时存在时必须一致。
- 列表运行流程 A 和编辑器“运行到此步骤”都必须运行 A 的 snapshot，不能运行最后保存的流程 B。

这个回归未通过前，不得开放批量运行 UI。

## 必须实现的用户结果

1. 在同一项目流程列表选择 2-20 个不同流程。
2. 选择一个共用环境，在确认界面看到流程、总步骤、“串行执行”和通知提示。
3. 一次创建一个持久 batch，并为每个流程原子创建一条 queued run。
4. 在运行中心看到 batch 总进度、状态计数和子 run，可进入现有 run 详情。
5. 可取消整个 batch；queued 项取消，running 项收到取消请求，终态项不变。
6. Batch 终态后可只重试 failed/canceled 项，新建 batch 并保留原历史。
7. 页面刷新和服务重启后仍可从服务端恢复 batch 与子 run 状态。

## 不可妥协的技术契约

### 范围

- 仅同一项目、同一环境、2-20 个 flow，每 flow 一条 run。
- 不支持 dataset、upToStepId、跨项目或超过 20 流程的 batch。
- 总步骤上限 2000；服务端必须校验 flow 去重、数量和总步骤，前端校验不能作为唯一防线。

### 原子性与幂等

- 创建前解析每个 `flowId + environmentId` 的最新 published revision，并验证步骤、Chromium 环境和必需 secret 是否存在。
- 任一项预检失败，返回带 flowId 的错误，数据库中不产生 batch 或 run。
- Batch 和所有 child runs 必须在同一个 `BEGIN IMMEDIATE` 事务中插入，提交后才 enqueue。
- 客户端提供 UUID `clientRequestId`。数据库以 `(project_id, client_request_id)` 唯一约束兜底。
- 相同 key 和相同 payload 重试返回原 batch；相同 key 不同 payload 返回 409；并发重复请求也只能产生一组 runs。
- 不得复用资源同步 outbox 发送运行命令。

### 数据模型与状态

- 新增持久 `run_batches`，并让 `platform_runs` 通过 nullable batch id/item index 关联；历史孤立 run 保持可读。
- Batch 状态从 child run 查询聚合，不维护容易漂移的第二份 status 真相。
- 状态至少为 queued、running、success、partial_failed、failed、canceled，并提供 total/completed/queued/running/success/failed/canceled 计数。
- 子项按用户选择的 item index 进入现有 FIFO。一个 run 失败不阻断后续 run。
- 服务重启复用现有 queued run 恢复机制；恢复后 batch 聚合必须正确。

### 取消与重试

- Batch cancel 幂等。数据库条件更新先提交，再调用 ManagedRunner cancel。
- queued 进入 canceled；running 只设置 cancellation requested 并由 runner 收口；success/failed/canceled 不被覆盖。
- 竞态完成不能把 success 写回 canceled 或 queued。
- Retry 只允许终态 batch，只选 failed/canceled，创建新 batch 并记录 retryOfBatchId；原 batch 不变。
- Retry 使用当前最新 published revision，而不是复制原 run snapshot。

### API、UI 与兼容

- API 提供 create/list/detail/cancel/retry-failed，并沿用平台 session、项目归属和 `run.execute` 权限。
- Batch 列表使用服务端分页；详情按 item index 返回子 run 摘要，不返回完整 snapshot 或 secret。
- FlowsPage 使用表格多选；单行运行仍可用。
- RunsPage 在现有服务端分页基础上显示 batch 和孤立 run，仅对非终态数据轮询。
- UI 明确使用“串行执行”，不得误导为并行。
- 创建、取消和重试写真实 batch id 的审计；保留每 child run 现有通知，不额外重复发送 batch 通知。
- 现有单运行、dataset、schedule、webhook、通知、run detail/cancel/retry 和历史分页保持兼容。

## 最低测试要求

至少新增并实际运行：

1. Revision 回归：A/B 两流程最后保存顺序不同，运行 A/B 各自得到正确 snapshot；flow/revision/environment mismatch。
2. Migration：已有 run 数据库升级、重复 migration、历史 run 可读、batch item 唯一索引。
3. Batch service：全量预检、事务回滚、相同 key 重试、不同 payload 冲突和并发幂等。
4. 聚合：全成功、全失败、全取消、部分成功、queued/running 混合。
5. 取消竞态和 retry latest revision。
6. 重启恢复：事务已提交但未 enqueue 的 queued runs 在启动后恢复。
7. 前端：多选、确认、稳定 idempotency key、错误定位、取消/retry、刷新恢复。
8. E2E：多流程串行、一个失败后继续、partial_failed、retry failed 和孤立 run 兼容。
9. 回归命令：

```bash
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
npm run test:windows
```

收尾应运行 `npm run test:all`。如果环境客观无法运行某项，保留失败输出并准确说明，不得声称通过。

## 实施顺序

严格按计划中的阶段关卡推进：

1. 修复单流程 revision 选择。
2. 向前兼容 migration 和可复用 run construction。
3. Batch create/query/aggregate/idempotency。
4. Cancel 和 retry failed。
5. FlowsPage 多选与确认。
6. RunsPage 批次展示、E2E 和全量回归。

优先保证服务端正确性和测试。不要用只有 UI、多次单请求或内存 batch 的演示版本代替生产实现。

## 最终交付格式

完成后只基于实际结果提交报告，包含：

- 实现摘要及关键设计选择。
- 修改文件清单和 migration 说明。
- 逐条对应验收标准的证据。
- 实际运行的命令及通过/失败数量。
- 未完成项、已知限制和残余风险。
- `git diff --stat` 和 `git status --short` 摘要。

不要在功能未闭环或测试未运行时宣称“完成”。
