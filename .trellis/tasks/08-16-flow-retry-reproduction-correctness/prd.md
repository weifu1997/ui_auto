# 流程 retry 重现正确性（P0 follow-up）

## Goal

将单次 platform run retry 定义为原 run snapshot 的一对一克隆，让用户在 revision 已 `superseded`、流程后续发布或 dataset 配置变化后，仍能重现同一条失败输入并通过运行详情审计其来源。

本任务是基础 [`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md) 的 P0 follow-up，完成前不得批准 batch/recording 的最终保存后运行、失败项重试或重放验收。它只补 retry 的历史快照边界，不重新设计 revision resolver、batch 编排或录制会话。

## Confirmed Evidence

- 单 run retry 入口 `server-py/autoflow/handler.py:3095-3103` 当前只传原 `revisionId`、`environmentId`、actor/source 和 `allowSuperseded`，没有传原 dataset 行或 `upToStepId`。
- `server-py/autoflow/services.py:1182-1198` 在缺少 `datasetVersionId` 时从 revision 的 dataset snapshot 回读版本并加载该版本全部 rows；`services.py:1371-1390` 按 rows 循环创建 run。因此一条 dataset run 的 retry 当前可能扩张为多条。
- 创建时原 run 已把 revision checksum、environment/flow/elements、dataset 单行和 `upToStepId` 写入 snapshot，见 `services.py:1296-1320`；执行时 `managed_runner_input` 从 snapshot 读取行和步骤边界，见 `services.py:2103-2159`。
- 当前 handler 只把返回的第一条新 run 写入 `retry_of_run_id` 并追加 `run.retried` 事件，见 `handler.py:3105-3112`；现有测试只覆盖 superseded revision id/步骤级复用，不覆盖一对一基数、行数据、步骤边界、checksum 或全量审计链路。
- 执行时非 secret variables 从当前 `project_resources` 读取（`services.py:2107-2133`），secret 按当前 `project_secrets` 解密（`services.py:849-876`、`2103-2154`）；这些值没有进入 run snapshot。

## Product Decisions

- Retry 的重现单位是**一条原 run snapshot**，不是 revision 配置或 dataset version。
- 无论原 revision 当前为 `published` 还是 `superseded`，一次 retry 恰好创建一条新 run；不得按 revision 的 dataset 配置重新展开，也不得静默改用最新 published revision。
- 新 run 必须复用原 snapshot 的 revision ID、revision checksum、flow/environment/elements 快照、dataset version 元数据与单个 `datasetRow`、`upToStepId`。原 run 没有 dataset 行时，retry 也只能创建一条无行 run。
- 新 run 的 `retry_of_run_id` 必须指向原 run；`run.retried` 事件必须与该新 run 一对一对应。原 run、原 batch（若有）和原事件历史不可变。
- snapshot、API 响应、日志和审计不得包含 secret 明文；secret 名称可按既有安全契约保留，实际解密不进入持久化快照。
- 非 secret variables 与 secrets 不建立历史值版本库。retry 请求只预检原 snapshot 所需名称是否已配置，不在请求中物化或持久化值；新 run 入队、以及进程重启后的恢复物化 runner input 时，读取当时项目中的当前值。预检当下缺失时返回稳定错误并零写入（不新增 run、event 或 audit），预检通过后若配置被删除，已创建的 queued run 保留，并在后续 input 物化时稳定失败；与实际物化相关的审计只记录名称/错误状态，不记录值。
- “可复现”严格覆盖 revision、环境、元素、dataset 行和步骤边界等持久 snapshot 输入；明确不承诺普通变量/secret 值的字节级一致性。secret 轮换后的 retry 使用轮换后当前值。
- retry 是唯一允许读取 `published`/`superseded` 历史 revision 的入口；普通手工运行、batch 创建和 automation 仍只接受 `published`，除非已有显式兼容契约另有规定。
- API/服务层与 UI 都采用直接父 lineage：`failed/canceled` 平台“重新运行”必须调用 canonical retry endpoint，RunDetail 显示可跳转的直接父 run；连续 retry 每一跳指向本次来源。成功运行使用独立的“再次运行（新运行）”fresh-run 操作，完整 ancestry/root 展示不进入 MVP。
- 成功运行的 fresh-run 请求从 `source.snapshot.flow.id` 取得 `flowId`，沿用原 `environmentId` 并省略 `revisionId`，由普通 flow-scoped resolver 选择当前最新 published revision。缺少可信 flow id 或匹配 published 时稳定拒绝，不回退原 revision；fresh run 可按当前 revision 的 dataset snapshot/rows 创建多条 run，且全部 `retryOfRunId = null`。

## Requirements

### R1 Exact Snapshot Clone

- 抽取一个不重新解析 dataset 的 retry clone 路径，输入为原 run 的持久 snapshot 和必要的关联元数据。
- clone 必须保留原 `flowRevisionId`、`flowRevisionChecksum`、`environmentId`、flow/environment/elements、dataset 元数据、单个 `datasetRow` 和 `upToStepId`；不得从当前 revision 或当前 dataset rows 推导替代值。
- clone 结果必须通过现有 ManagedRunner 入队和 snapshot 校验，不复制第二套执行器或 secret 解密逻辑。

### R2 One-To-One Persistence And Audit

- 一个可重试原 run只生成一个新 run；事务失败时不留下部分 clone、孤立 batch item 或 queued event。
- 新 run 的 `retry_of_run_id`、revision ID/checksum、snapshot checksum（若字段存在）和原 run 可相互核对；`run.retried` 事件只写一次并指向正确新 run。
- 若原 run 已属于 batch，batch retry 仍按每个 failed/canceled child 一对一 clone，并同时维护 `retryOfBatchId` 与每条 `retryOfRunId`。

### R3 Compatibility And Safety

- 保持现有 retry 权限、终态限制、取消状态和响应结构；非 `failed`/`canceled` 原 run 继续返回 `RUN_NOT_RETRYABLE`。
- 历史 revision 被删除、snapshot 损坏或缺少必要 immutable 字段时，返回稳定的不可重试错误并零写入，不回退到最新 revision。
- 在 clone 事务前从当前项目资源解析原 snapshot/flow 所需的普通变量和 secret 名称；缺少必需普通变量返回稳定的 variable 错误，缺少 secret 沿用 `RUN_SECRET_NOT_CONFIGURED`，两者都不得留下 run、event 或 retry 关联。
- 保持既有项目授权下的 `PlatformRun.snapshot` read model，供运行详情和 fresh-run 安全读取 `flow.id`；不得把 snapshot 全文复制到 event、audit 或日志。snapshot/API 均不得含普通变量值或 secret 明文；现有 `secret.decrypted_for_run` 只记录名称的审计语义保持不变。

### R4 UI And Lineage Contract

- `PlatformRun` API/DTO 暴露 nullable `retryOfRunId`，服务端 read model 从持久列投影；历史/fresh run 为 `null`。
- RunsPage 与 RunDetailPage 对 `failed/canceled` 平台 run 调用 `/runs/{id}/retry`，成功后导航到唯一新 run；不得再通过 `createPlatformRun` 模拟 retry。
- RunDetail 对 retry run 显示“重试自”直接父 run 链接；跨项目/无权限父 run 仍按现有项目隔离处理，不在响应中泄漏 metadata。
- `success` run 使用明确区分的“再次运行（新运行）”操作并走普通 create 契约，请求只携带 `source.snapshot.flow.id` 对应的 `flowId` 与原 `environmentId`，不得携带原 `revisionId`。服务端解析当前最新 published revision；缺少 flow id 或匹配 published 时 fail closed，不回退到原 revision。fresh run 不写 `retryOfRunId`，并按当前 revision 的 dataset 规则决定 run 数量。
- `queued/dispatched/running` 等非终态 run 不显示“重新运行”或“再次运行（新运行）”；只有 failed/canceled 显示 canonical retry，只有 success 显示 fresh-run。
- MVP 不递归加载或展示完整祖先链、root attempt、批次 lineage 图；直接父信息足以满足本阶段来源审计。

## Acceptance Criteria

- [ ] AC1：failed/canceled 的无 dataset run retry 恰好创建一条新 run，原 revision ID/checksum、flow/environment/elements snapshot 和 `upToStepId`（若有）与原 run 完全一致。
- [ ] AC2：来自包含至少两行 dataset 的原 run 的单行 retry 只创建一条新 run，`datasetRow.number/data` 与原 run 相同，不读取或展开其它 rows。
- [ ] AC3：原 revision 变为 `superseded` 后 retry 仍成功排队；新 run 的 revision 状态、ID、checksum 和 snapshot checksum（若有）与原 run一致，普通手工运行仍拒绝该 superseded revision。
- [ ] AC4：每次 retry 都写一条且仅一条 `retry_of_run_id` 关联和 `run.retried` 事件；不存在未关联的额外 run/event，原 run 历史不变。
- [ ] AC5：batch failed/canceled child retry 继承 AC1-4，并同时保持 `retryOfBatchId`、child item 顺序和每个 child 的一对一关联。
- [ ] AC6：dataset version 当前被更新、归档或其余 rows 变化时，retry 仍使用原 snapshot 单行；缺少 immutable snapshot 字段时稳定拒绝且数据库零写入。
- [ ] AC7：retry 请求只对原 snapshot 所需普通变量/secret 名称做预检；预检当下缺失分别返回 `RUN_VARIABLE_NOT_CONFIGURED`/`RUN_SECRET_NOT_CONFIGURED` 且数据库、event、audit 零写入。成功创建的 queued run 在 enqueue 与重启恢复物化 runner input 时读取当时当前值，因此轮换后的值可生效；预检后删除配置时 queued run 保留并在物化阶段稳定失败。运行时明文只可短暂存在于内存 runner input，不进入 snapshot、数据库、API、event、audit 或日志，审计只记录名称/状态；不承诺变量/secret 字节级重现。
- [ ] AC8：RunsPage/RunDetailPage 对 failed/canceled 平台 run 调用 canonical retry，返回 run 的 `retryOfRunId` 指向直接父 run，详情可跳转；success 只提供清晰标记的 fresh-run 操作，请求带 `source.snapshot.flow.id + 原 environmentId`、省略 `revisionId`。确定性 fixture 发布 A 后再发布含至少两行 dataset 的 B：success(A) fresh 必须返回两条 B revision/checksum、当前 row、`retryOfRunId = null` 的 run；failed(A) retry 仍只返回一条 A snapshot clone。无 flow id/匹配 published 时稳定拒绝、零新 run 且不回退；非终态无 rerun 操作，完整 ancestry/root 不加载。多 run 后的 UI 去向见 Open Questions。

## Out Of Scope

- 改变 revision 发布/审批状态机、普通手工运行的 published-only 规则或 flow-scoped resolver。
- 为普通变量/secret 建立历史值版本库、把运行时值写入 snapshot，或改变现有 secret 加密/解密实现。
- batch 的选择、排序、取消、聚合 UI；录制会话、资源导入和浏览器生命周期。
- 完整 retry ancestry/root 面包屑、跨批次 lineage 图和历史趋势视图；MVP 只展示一跳直接父链接。
- 让用户在 retry 时选择“最新 revision”“全部 dataset rows”或新的 `upToStepId`；这些属于新建 run，不是 retry。

## Risks And Deferred Items

- 当前 clone 需要从 snapshot 直接构造可入队 spec；若复用 `resolve_run_spec` 不慎回读 dataset，原 bug 会以另一种形式保留。
- 旧 run snapshot 可能缺少 `datasetRow`、checksum 或历史字段；必须定义兼容回填与零写入错误，不得模糊猜测。
- 当前 snapshot 未显式列出所有非 secret variable 名称；实现需从原 flow snapshot 的模板引用安全推导必需名称并在写入前预检，不能因值未版本化而跳过缺失检查。
- retry 预检与 runner input 物化之间存在删除/轮换竞态：预检后的删除不回滚已创建 queued run，而是在 enqueue 或重启恢复物化时返回稳定缺失错误；实现必须保持零明文持久化和可恢复队列语义。

## Open Questions For Requirement Convergence

1. success fresh-run 因新版 dataset 返回多条 run 时，UI 应导航第一条还是回到运行中心展示全部结果？
