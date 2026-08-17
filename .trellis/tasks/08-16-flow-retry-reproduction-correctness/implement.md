# Implementation Plan: Flow Retry Reproduction Correctness (P0 Follow-up)

## Preconditions

- 保持任务为 `planning`；平台 UI direct-parent lineage、success fresh-run 最新 published revision，以及 retry 运行时 variables/secret 的读取时序均已收敛；fresh 多 run 后 UI 去向仍须确认。必须在用户批准本任务最新 planning summary 后才可运行 `task.py start`。
- 基础 P0 [`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md) 已归档；batch/recording 只能在本任务的 retry clone gate 通过后进入最终实现评审。
- 开发前读取 `implement.jsonl`/`check.jsonl` 指定的 backend、audit、frontend type-safety 和 cross-layer specs；不得修改匿名 Prompt、其它任务 PRD 或无关产品代码。
- 先记录 `npm run build`、`npm run lint`、`npm run test:unit`、`npm run test:py` 基线；既有 E2E 遗留失败须单独记录，不得通过删改断言隐藏。

## Phase 0: Contract And Characterization

- [ ] 盘点 single retry、batch retry、run detail/list、ManagedRunner input 和现有 `platform_run_events` 的调用/响应边界，确认没有第二个 retry owner。
- [ ] 新增可复用测试 fixture：同一 dataset version 至少两行、source 使用第二行、含 `upToStepId`、非空 elements 和仅名称形式的 secret 引用；同时准备 superseded revision 与 revision checksum 变化场景。
- [ ] 固定 immutable snapshot projection、`RUN_SNAPSHOT_NOT_RETRYABLE`、`RUN_VARIABLE_NOT_CONFIGURED` 和 API `retryOfRunId` nullable DTO；把 PRD AC1–AC8 映射到测试名称。
- [ ] 按已收敛契约实现运行时 variables/secret：请求只预检必需名称；enqueue 与重启恢复物化 runner input 时读取当时当前值；预检当下缺失零写入，预检后删除保留 queued run 并在物化阶段稳定失败；明文只存在于短暂内存，不建设历史值版本库。

## Phase 1: Shared Persistence Primitive

- [ ] 扩展 `run_by_id`/`run_response` 读取 `platform_runs.retry_of_run_id`，并在 `src/platform-api.ts` 的 `PlatformRun` 暴露 nullable `retryOfRunId`；保持旧响应外层结构和历史 null 行为。
- [ ] 在 `platform-api.ts` 增加 typed single retry API；RunsPage/RunDetailPage 的 failed/canceled 平台操作调用该 API，RunDetail 显示直接父 run 链接。success 使用明确区分的 fresh-run 操作，请求传 `source.snapshot.flow.id + 原 environmentId` 并省略 `revisionId`；缺少 flow id 时前端稳定拒绝，不 pin 旧 revision。
- [ ] 将现有 fresh-run snapshot 构造与 INSERT/event 写入拆为“构造 snapshot + 共享 `insert_managed_run`”两层；helper 不自行开启事务、不 enqueue，先证明 dataset 多行普通创建行为不变。
- [ ] 实现 `validate_retry_snapshot`：只读源 run 与其项目内 revision 的状态/id/checksum，深拷贝并校验 immutable 字段、step boundary、datasetRow 形状，并从 flow snapshot 推导、预检普通变量与 secret 的必需名称；禁止调用 `resolve_run_spec`、`dataset_version_for`、`dataset_rows_for`、`secret_values` 或其它运行时取值/解密 API。
- [ ] 让共享插入原语在同一事务中写 `retry_of_run_id`、`run.queued` 和（retry 时）单条 `run.retried`；queued event 只含 IDs/counts，不含 row data 或 snapshot。

**Gate:** fresh run、dataset multi-row、schedule/Webhook/AgentsPage 和 migration 回归通过；helper 本身无事务/入队副作用，且 malformed source 零写入。既有授权 snapshot 响应保持兼容，但 runtime values 不新增到响应。

## Phase 2: Single Run Retry

- [ ] 在 services 层增加单 run retry 薄编排：检查 project/status、调用 clone validator、`BEGIN IMMEDIATE` 插入恰好一条新 run，COMMIT 后 enqueue 一次；不得再调用 `queue_published_runs` 以重新展开 revision dataset。
- [ ] 在 handler 中保留 session/capability/project/terminal-state错误映射，删除 commit 后只更新第一条 run 的 `retry_of_run_id` 和事件的逻辑，响应仍返回 `runIds`/`runs` 且长度恰为 1。
- [ ] 单 run 从 batch child 重试时移除旧 batch 元数据，避免新独立 run 误挂原 batch；原 batch 与源 run 不变。
- [ ] 覆盖 superseded revision、较新 published revision、dataset 行变化、`upToStepId`、checksum/environment/elements equality 和 `retryOfRunId`/`run.retried` 一对一断言。

**Gate:** PRD AC1–AC4、AC6 通过；普通手工 superseded revision 仍被拒绝；secret 只允许短暂出现在内存 runner input，不出现在 snapshot、数据库、event、response、audit 或日志。

## Phase 3: Batch Retry Integration

- [ ] 改造 `retry_run_batch` 从每个 failed/canceled child 的 snapshot 构造 clone item，不再调用 `resolve_run_spec(... allowSuperseded=True)`；保留原 child 相对顺序、new `retryOfBatchId` 和 dense item index。
- [ ] 让 `_insert_run_batch`/共享 insert helper 在单个事务中为每个 source 写一条 child、`retry_of_run_id`、queued/retried event；任一 clone 失败全量 rollback，COMMIT 后按 index enqueue。
- [ ] 修复 retry batch 的 idempotency replay，确保重复 key 返回既有 batch/runs 且不重复插入 run 或 `run.retried` event；原 batch aggregate 永不改变。
- [ ] 更新 batch service/handler tests，断言每个新 child 的 revision checksum、environment/elements、datasetRow、`upToStepId`（若存在）和逐条事件关联；不要把 batch-level audit 当作 child lineage 的替代。

**Gate:** PRD AC5 与 batch task 的 retry gate 通过；批次 UI 可继续消费现有摘要 DTO，不需要 snapshot 全文。

## Phase 4: Security, Compatibility And Closure

- [ ] 增加请求预检缺少必需普通变量/secret 的零写入测试；增加预检后轮换、预检后删除、enqueue 与重启恢复读取当前值的测试；同时覆盖损坏 snapshot、删除/错误状态 revision、checksum mismatch、跨项目和非终态源，确认稳定 variable error、`RUN_SECRET_NOT_CONFIGURED` 与 `RUN_NOT_RETRYABLE` 语义不回归。
- [ ] 运行 handler/API 权限、run detail/list、schedule/Webhook/AgentsPage、普通 dataset 多行、ManagedRunner restart/recovery 和通知回归。
- [ ] 使用现有确定性 platform fixture 补 service/API/UI 回归：发布 A 后再发布含两行 dataset 的 B，success(A) fresh 返回两条 B run 且 lineage 为空，failed(A) retry 返回一条 A clone；缺 flow id/无匹配 published 时零写入、不回退。Playwright 交互不依赖外部网站或真实账号。
- [ ] 在 design/implement 中记录实际测试命令、未运行门禁和残余风险；通过 `trellis-check` 后才提交给主代理做 planning review。

## Review Gates

- [ ] 一个 source run 一次 retry 只创建一个 new run；任何 dataset rows 数量变化都不影响基数。
- [ ] new `revision_id`/checksum、environment/flow/elements、datasetRow 和 `upToStepId` 与 source snapshot 相等；superseded source 可重试，普通入口仍 published-only。
- [ ] `retry_of_run_id` 在 INSERT 时写入；每个新 run 恰有一条 `run.retried` event，`priorRunId` 与该列相等；源历史无变化。
- [ ] single 与 batch retry 共用 clone/insert owner，不存在按 revision 重新解析或复制 SQL 的旁路。
- [ ] transaction、idempotency、post-commit enqueue/recovery 和 batch order 均有测试；clone 事务提交前的失败不留下部分 run/event/batch item，预检后 input 物化失败按已确认例外保留 queued run。
- [ ] retry 请求只预检普通变量/secret 名称；运行时值仅在 enqueue/重启恢复物化时进入短暂内存 runner input，不进入 snapshot、数据库、API、event、日志或审计；预检后删除导致 queued run 在物化阶段稳定失败，审计只记录安全名称/状态。
- [ ] UI failed/canceled retry 不再调用 fresh create；`retryOfRunId` 可在详情跳转到直接父 run。success fresh-run 不传 `revisionId`，按原 flow/environment 取当前最新 published、lineage 为 null；无可信 flow id/匹配 published 时不回退，页面不递归加载 ancestry。
- [ ] `npm run build`、`npm run lint`、`npm run test:unit`、`npm run test:py` 通过；E2E/Windows 若无法运行需记录原因和残余风险。

## Validation Commands

```bash
# 精确后端回归（使用仓库 Python runner）
node scripts/run-py.mjs -m pytest server-py/tests/unit/test_retry_reproduction.py -q
node scripts/run-py.mjs -m pytest server-py/tests/unit/test_revision_selection.py server-py/tests/unit/test_run_batches.py server-py/tests/unit/test_handler_audit_analytics.py -q

# 跨层门禁
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
npm run test:windows
```

开发中先跑精确测试，收尾使用 `npm run test:all`；无法运行的命令须记录完整错误、未覆盖范围和是否为已知基线失败。

## Risky Files And Rollback Points

- `server-py/autoflow/services.py`：先提交共享 snapshot/INSERT 原语和单测，再提交 single retry，再接 batch；每步都能独立回滚。
- `server-py/autoflow/handler.py`：只保留认证/错误/响应映射，移除 post-hoc 第一条关联；若 handler 回归失败可单独隐藏 retry 入口。
- `server-py/autoflow/migrations.py`：优先不改；若旧库验证发现缺列，只允许可重复的 additive `ensure_column`，不删除历史数据。
- `src/platform-api.ts`：nullable DTO 是 additive 变更；不修改无关页面或本地 Worker 类型。
- `server-py/tests/unit/`、`tests/`：新增 fixture/断言不得放宽现有回归；不要覆盖用户未提交的并行改动。

## Suggested Commit Sequence

1. `refactor(runs): centralize snapshot insertion and lineage projection`
2. `fix(runs): clone single retry snapshot one-to-one`
3. `fix(batch): reuse retry snapshot clone for failed children`
4. `test(runs): cover retry lineage, dataset row and secret redaction`
