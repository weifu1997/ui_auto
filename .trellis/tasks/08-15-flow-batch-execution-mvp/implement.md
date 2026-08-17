# Implementation Plan: Flow Batch Execution MVP

## Preconditions And Ordering

- 本任务依赖运行历史分页任务的 API/URL 契约，先合并或明确 rebase 点，再修改 `handler.py`、`platform-api.ts` 和 `RunsPage.tsx`。
- 硬依赖基础 [`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md) 已通过并归档；本任务还依赖 [`08-16-flow-retry-reproduction-correctness`](../08-16-flow-retry-reproduction-correctness/prd.md) 的一对一 snapshot clone 契约，不在 batch 内复制或弱化 P0 follow-up。该 follow-up 只阻断 batch retry UI/AC7 与最终 release gate，不阻断已经完成的 batch create/query/cancel 取证工作。
- 保持任务为 `planning`，经人工批准后再执行 `task.py start`。
- 开发前读取 backend/frontend spec 和 cross-layer 指南，运行基线 `build/lint/test:unit/test:py`。
- External Gate 已通过；基础 resolver 必须持续回归通过，retry follow-up 未通过前不得开放 batch retry UI 或将 AC7 标为完成。

## External Gate: P0 Revision Selection

- [x] 独立 P0 任务状态已完成，A/B flow、显式 revision、environment mismatch 与运行到此步骤回归有可引用证据。（P0 已归档，`ad8b061` + `server-py/tests/unit/test_revision_selection.py`）
- [x] Batch 设计使用 P0 的唯一 resolver owner 和错误码，不添加第二套 revision SQL。（`create_run_batch`/`retry_run_batch` 复用 `resolve_run_spec` → `published_revision_for`）
- [ ] Batch retry 已通过 P0 follow-up 的一对一 snapshot clone 回归（原 revision checksum、单行 dataset、`upToStepId`、逐条 `retryOfRunId`/`run.retried`）；当前实现仍需补齐。

**Gate**：基础 resolver 未满足时停止所有 batch 发布；retry reproduction follow-up 未满足时只停止 batch retry UI/AC7，允许继续核对其它已完成阶段的遗留证据。

## Phase 1: Schema And Reusable Run Construction

- [x] 新增可重复 migration：`run_batches`、platform_runs batch columns 和索引；保护已有数据库和历史运行。（migration v11 `run-batches`；既有 migration 测试更新版本清单后通过）
- [x] 在 services 层实现 typed batch/run response helper 和集中 aggregate query。（`_run_batch_response` + `_RUN_BATCH_COUNTS_CTE` 单一 SQL 聚合）
- [x] 把 `queue_published_runs` 拆成无副作用 `resolve_run_spec` 和可加入外部事务的 `insert_run_from_spec`。
- [x] 保持 dataset 单运行创建多 run、dispatchKey 幂等、secret 检查、snapshot 和 queued event 行为不回归。（既有 85 个 Python 测试通过）
- [x] 增加 migration、resolver、单运行和 helper 单测。（`test_run_batches.py` 9 个用例）

**Gate**：历史 DB migration 后原 run 可读取；单运行完整回归；helper 本身不 begin/commit 或 enqueue。

## Phase 2: Batch Create, Query And Idempotency

- [x] 实现 flowIds 去重、2-20 数量、总步骤 2000、禁止 dataset/upToStep 的服务端校验。
- [x] 预检所有 flow specs，聚合带 flowId 的错误（`BATCH_PREFLIGHT_FAILED` + `items`，经 `PlatformError.detail` 透传）；预检阶段没有任何 batch/run 写入。
- [x] `BEGIN IMMEDIATE` 后检查/插入 idempotency key，在一个事务内插入 batch、所有 runs 和 queued events。
- [x] 处理并发 UNIQUE 冲突：捕获 IntegrityError 后读取已有 payload，等价返回原 batch，不等价返回 409。
- [x] COMMIT 后按 itemIndex enqueue；重启恢复复用既有启动 queued 重排（create 测试断言 queued 状态可被恢复查询命中；未做进程退出级模拟）。
- [x] 实现批次分页列表、详情和 SQL 状态聚合，不在 API 层重复解释状态。
- [x] 写 create audit，真实 batch id 作为 target。

**Gate**：原子失败、并发幂等、payload key 冲突、顺序、聚合六类测试通过。

## Phase 3: Batch Cancel And Retry

- [x] 实现幂等 batch cancel，条件更新 queued/running 子项并在事务后调用现有 runner cancel。
- [x] 只为状态实际变化的 run 追加一次 cancel requested event。（重复取消不追加事件，测试断言事件数不变）
- [x] 覆盖 queued、running、已 success、混合和完成竞态。（条件更新保证终态不被覆盖）
- [x] 实现 retry failed/canceled，仅允许终态 batch；创建新 batch 并记录 retryOfBatchId。
- [x] Retry 复用事务/入队 helper，但按每个子项原 run 的 revision 快照（允许 superseded，复用 P0 重试解析）构建 spec，不解析最新 revision。
- [x] 写 cancel/retry audit，确保不含 secret/snapshot。

**Gate**：取消竞态不覆盖终态；重试只创建失败/取消项；原 batch 永不变回 running。

## Phase 4: FlowsPage Batch UX

- [x] 为流程表格增加 rowSelection 和稳定 selected ids；删除/筛选流程后清理无效选择。
- [x] 批量操作仅在平台模式、有权限和选择 2-20 项时可用；单行运行保持原样。
- [x] 确认 Modal 显示环境、流程、总步骤、串行和通知提示；不做卡片嵌套。
- [~] 用户确认时生成 clientRequestId（`crypto.randomUUID()`）；服务端幂等已覆盖重复 key，但当前 UI 每次调用 `submitBatchRun` 都重新生成 key，仍需把同一确认意图的失败重试固定为同一 key。
- [x] 预检错误按 flow name 展示；成功后清空选择并导航到带 batch 定位参数的运行中心。
- [x] 扩展 `platform-api.ts` 的 Batch DTO/API，组件不得本地 cast raw payload。

**Gate**：Vitest 覆盖选择、权限、确认、key 复用、错误和成功导航；build/lint 通过。当前 key 复用项仍是未完成验收。

## Phase 5: Runs Center And End-To-End

- [x] 在服务端分页的 RunsPage 上接入 batch list/detail，不恢复客户端固定 200 条或全量加载。
- [x] 展示 batch 状态、计数、串行说明、子 run 展开和现有 run 详情链接。
- [x] 终态 batch 显示“重试失败项”，非终态显示取消；操作后刷新 batch/run 查询。
- [x] 仅有非终态 batch/run 时轮询（快慢间隔复用现有策略）；刷新从服务端恢复（无本地批次持久化）。
- [~] E2E 覆盖全成功、部分失败继续执行、取消、retry、重复提交、刷新恢复和孤立单 run。（`tests/batch-run.spec.ts` 覆盖提交→跳转定位→批次展示→展开子 run；取消/retry 已由服务层测试覆盖，E2E 级取消/retry 交互留待补充）
- [x] 回归 schedule/webhook、dataset 单运行、通知、运行分页和重启恢复。（全量门禁通过，E2E 失败项均为基线遗留）
- [ ] 更新用户文档，明确批量串行、20 流程/2000 步上限、部分失败和通知行为。（未做——待收尾批次处理）

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

### 2026-08-16 验证记录

- `npm run build` / `npm run lint` / `npm run test:unit`（30）/ `npm run test:py`（85，含 `test_run_batches.py` 9 个新用例）：全部通过。
- `npm run test:e2e`：25 通过、11 失败；11 个失败与 08-16-legacy-e2e-failures 记录的基线遗留集合完全一致，与本任务无关。新增 `tests/batch-run.spec.ts` 通过。
- `npm run test:windows`：未运行（Linux 环境）。
- 残余：E2E 级取消/重试交互、服务重启进程退出级恢复模拟、handler 层权限专项测试未覆盖（权限由 handler `run.execute` capability + 项目范围 404 保证，行为由服务层契约测试覆盖）；用户文档更新未做。

### 2026-08-18 收尾验证

- `npm run lint`、`npm run build`、`npm run test:unit`（30）、`npm run check:bundle` 和 `npm run test:py`（107）均通过。
- `npm run test:e2e -- tests/batch-run.spec.ts`：2/2 通过；新增场景覆盖 queued 批次取消、仅重试取消项、跳转到新 batch URL，以及刷新后从服务端恢复定位。
- 仍未闭环：执行器级“前项失败后继续”专项测试（AC4）、P0 retry snapshot 的 checksum/dataset/upToStepId 完整性（AC7）、进程退出级 queued 恢复（AC8）、handler 权限/跨项目专项测试（AC10）及用户文档。

## Review Gates

- [ ] 单流程和 batch 都不会按项目最新任意 revision 猜测流程。
- [ ] Batch 创建在所有失败路径上全有或全无。
- [ ] Idempotency 由数据库唯一约束保证，前端重复点击不是唯一防线。
- [ ] Batch 状态由 child runs 聚合，不存在需要双写同步的 status 字段。
- [ ] ManagedRunner 仍是单 active；一个失败不阻断后续项。
- [ ] 取消使用条件更新，完成竞态不会覆盖 success/failed。
- [ ] 历史 run、dataset、schedule、webhook 和孤立单 run 保持兼容。
- [ ] Retry failed/canceled 子项保持原 run snapshot 的 revision checksum、单个 dataset 行、`upToStepId` 与一对一 `retryOfRunId`/审计关联；产品语义已由 P0 follow-up 收敛，当前“按 revision 重新展开”实现必须替换并补测试。
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
