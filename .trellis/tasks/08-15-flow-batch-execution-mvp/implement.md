# Implementation Plan: Flow Batch Execution MVP

## Preconditions And Ordering

- 本任务依赖运行历史分页任务的 API/URL 契约，先合并或明确 rebase 点，再修改 `handler.py`、`platform-api.ts` 和 `RunsPage.tsx`。
- 硬依赖 `08-15-flow-revision-selection-correctness` 已通过并归档；本任务只消费其 resolver/error 契约，不实现 P0。
- 保持任务为 `planning`，经人工批准后再执行 `task.py start`。
- 开发前读取 backend/frontend spec 和 cross-layer 指南，运行基线 `build/lint/test:unit/test:py`。
- External Gate 是硬前置；单流程 revision 选择任务未通过前不得启动本任务或开放 batch UI。

## External Gate: P0 Revision Selection

- [ ] 独立 P0 任务状态已完成，A/B flow、显式 revision、environment mismatch 与运行到此步骤回归有可引用证据。
- [ ] Batch 设计使用 P0 的唯一 resolver owner 和错误码，不添加第二套 revision SQL。

**Gate**：未满足以上两项时停止，不进入 Phase 1。

## Phase 1: Schema And Reusable Run Construction

- [ ] 新增可重复 migration：`run_batches`、platform_runs batch columns 和索引；保护已有数据库和历史运行。
- [ ] 在 services 层实现 typed batch/run response helper 和集中 aggregate query。
- [ ] 把 `queue_published_runs` 拆成无副作用 `resolve_run_spec` 和可加入外部事务的 `insert_run_from_spec`。
- [ ] 保持 dataset 单运行创建多 run、dispatchKey 幂等、secret 检查、snapshot 和 queued event 行为不回归。
- [ ] 增加 migration、resolver、单运行和 helper 单测。

**Gate**：历史 DB migration 后原 run 可读取；单运行完整回归；helper 本身不 begin/commit 或 enqueue。

## Phase 2: Batch Create, Query And Idempotency

- [ ] 实现 flowIds 去重、2-20 数量、总步骤 2000、禁止 dataset/upToStep 的服务端校验。
- [ ] 预检所有 flow specs，聚合带 flowId 的错误；没有任何数据库写入。
- [ ] `BEGIN IMMEDIATE` 后检查/插入 idempotency key，在一个事务内插入 batch、所有 runs 和 queued events。
- [ ] 处理并发 UNIQUE 冲突：读取已有 payload，等价返回原 batch，不等价返回 409。
- [ ] COMMIT 后按 itemIndex enqueue；增加模拟提交后进程退出并在重启恢复 queued runs 的测试。
- [ ] 实现批次分页列表、详情和 SQL 状态聚合，不在 API 层重复解释状态。
- [ ] 写 create audit，真实 batch id 作为 target。

**Gate**：原子失败、并发幂等、payload key 冲突、顺序、聚合六类测试通过。

## Phase 3: Batch Cancel And Retry

- [ ] 实现幂等 batch cancel，条件更新 queued/running 子项并在事务后调用现有 runner cancel。
- [ ] 只为状态实际变化的 run 追加一次 cancel requested event。
- [ ] 覆盖 queued、running、已 success、混合和完成竞态。
- [ ] 实现 retry failed/canceled，仅允许终态 batch；创建新 batch 并记录 retryOfBatchId。
- [ ] Retry 复用事务/入队 helper，但按每个子项原 run 的 revision 快照（允许 superseded，复用 P0 重试解析）构建 spec，不解析最新 revision。
- [ ] 写 cancel/retry audit，确保不含 secret/snapshot。

**Gate**：取消竞态不覆盖终态；重试只创建失败/取消项；原 batch 永不变回 running。

## Phase 4: FlowsPage Batch UX

- [ ] 为流程表格增加 rowSelection 和稳定 selected ids；删除/筛选流程后清理无效选择。
- [ ] 批量操作仅在平台模式、有权限和选择 2-20 项时可用；单行运行保持原样。
- [ ] 确认 Modal 显示环境、流程、总步骤、串行和通知提示；不做卡片嵌套。
- [ ] 用户确认时生成 clientRequestId，请求超时重试复用同一 key，避免重复运行。
- [ ] 预检错误按 flow name 展示；成功后清空选择并导航到带 batch 定位参数的运行中心。
- [ ] 扩展 `platform-api.ts` 的 Batch DTO/API，组件不得本地 cast raw payload。

**Gate**：Vitest 覆盖选择、权限、确认、key 复用、错误和成功导航；build/lint 通过。

## Phase 5: Runs Center And End-To-End

- [ ] 在服务端分页的 RunsPage 上接入 batch list/detail，不恢复客户端固定 200 条或全量加载。
- [ ] 展示 batch 状态、计数、串行说明、子 run 展开和现有 run 详情链接。
- [ ] 终态 batch 显示“重试失败项”，非终态显示取消；操作后刷新 batch/run 查询。
- [ ] 仅有非终态 batch/run 时轮询；刷新和新浏览器会话从服务端恢复。
- [ ] E2E 覆盖全成功、部分失败继续执行、取消、retry、重复提交、刷新恢复和孤立单 run。
- [ ] 回归 schedule/webhook、dataset 单运行、通知、运行分页和重启恢复。
- [ ] 更新用户文档，明确批量串行、20 流程/2000 步上限、部分失败和通知行为。

## Validation Commands

```bash
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
npm run test:windows
```

开发中先运行新增精确测试；收尾运行 `npm run test:all`。无法运行的命令必须报告原因、错误和残余风险。

## Review Gates

- [ ] 单流程和 batch 都不会按项目最新任意 revision 猜测流程。
- [ ] Batch 创建在所有失败路径上全有或全无。
- [ ] Idempotency 由数据库唯一约束保证，前端重复点击不是唯一防线。
- [ ] Batch 状态由 child runs 聚合，不存在需要双写同步的 status 字段。
- [ ] ManagedRunner 仍是单 active；一个失败不阻断后续项。
- [ ] 取消使用条件更新，完成竞态不会覆盖 success/failed。
- [ ] 历史 run、dataset、schedule、webhook 和孤立单 run 保持兼容。
- [ ] 列表走服务端分页，批次响应不包含执行 snapshot 或 secret。

## Risky Files And Rollback Points

- `server-py/autoflow/services.py`：先独立提交 run construction 重构，确保没有行为变化，再叠加 batch。
- `server-py/autoflow/migrations.py`：只做向前兼容 add table/column/index；生产回滚保留 schema 和历史关联。
- `server-py/autoflow/handler.py`、`src/platform-api.ts`、`src/pages/RunsPage.tsx`：与分页任务重叠，必须在分页基线后修改并重新跑其专项测试。
- `src/pages/FlowsPage.tsx`：单流程 revision 修复和 batch UI 分开提交，便于独立回滚。
- 回滚顺序：隐藏前端 batch 入口，停止创建新 batch，保留查询和历史；不要删除 batch 表或清空 run 关联。

## Suggested Commit Sequence

1. `refactor(runs): extract reusable run construction`
2. `feat(batch): persist idempotent run batches`
3. `feat(batch): cancel and retry failed items`
4. `feat(flows): add batch run selection`
5. `feat(runs): display batch progress and actions`
6. `test(batch): cover recovery and execution closure`
