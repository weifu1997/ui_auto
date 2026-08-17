# 流程批量执行 MVP

## Goal

让测试人员在同一项目中一次选择多个流程，统一提交、查看进度、取消批次并重试失败项，减少逐个点击和逐个追踪运行的重复操作。

MVP 的“批量”是批量提交和批次级跟踪，继续使用现有 ManagedRunner 单并发 FIFO 串行执行，不承诺并行运行。

## Background And Evidence

以下实现缺口描述是 2026-08-15 建任务时的历史基线；当前完成度以本 PRD 的 Acceptance Criteria 和 implement.md 为准。

- 规划起点流程列表只有逐行运行入口，见 `src/pages/FlowsPage.tsx:69`、`:194`；后续并行工作已增加 batch 入口，仍需按本任务门禁收尾。
- 单运行 API 已支持持久快照、`queued/running/success/failed/canceled` 状态、取消、失败重试和服务重启后恢复排队任务，见 `server-py/autoflow/services.py:1112`、`:1191`、`:1298`，`server-py/autoflow/handler.py:3022`、`:3057`。
- ManagedRunner 是进程内单并发 FIFO，运行与元素验证共用队列，见 `server-py/autoflow/managed_runner.py:12`、`:22`。
- 规划起点数据集可让一次请求生成同一 revision 的多条 run，但没有跨流程 batch 实体，见 `server-py/autoflow/services.py:1145`；当前 batch schema/服务已存在，retry clone 仍由 P0 follow-up 负责。
- 规划起点曾发现单流程入口省略 `flowId`、服务端可能选择项目其它流程 revision 的 correctness 缺陷；该问题已由归档 P0 `08-15-flow-revision-selection-correctness` 修复，batch 必须消费并持续回归该 flow-scoped resolver。
- 运行历史已经进入服务端分页改造，批次 UI 应在该契约上增量建设，避免重新引入一次加载固定 200 条的限制。

### 规划刷新（2026-08-15）

- 本任务文档只表达需求边界，不构成继续实现授权；共同 flow revision 前置已由独立 P0 [`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md) 完成并归档。
- 基础 P0 已让 `FlowsPage`/`FlowEditorPage` 携带 `flowId`，服务端按 `project + flow + environment` 解析 published revision，并覆盖 mismatch/A-B flow 回归。batch 仍以这些回归持续通过为硬门；另一个 P0 follow-up [`08-16-flow-retry-reproduction-correctness`](../08-16-flow-retry-reproduction-correctness/prd.md) 负责 retry snapshot 一对一克隆，完成前 AC7 不得视为通过。
- runs 接口的服务端分页、生产同步 outbox、canonical revision snapshot 和 Python 运行入口已经在历史任务中落地；batch 规划只需声明兼容/回归约束，不应重新规划这些稳定性工作。
- 规划起点 `server-py/autoflow/migrations.py` 的平台 schema 版本为 10；并行实现已推进到 migration v11，仍须覆盖旧库/重复启动/历史 run 可读性。

## Product Decisions

- MVP 仅支持同一项目一次选择 2-20 个不同流程，并共用一个环境。
- 每个流程只生成一条 run；MVP 不允许 dataset、`upToStepId` 或跨项目批次，避免流程数与数据行数相乘。
- 创建阶段全有或全无（2026-08-16 已确认）：任何流程无法解析已发布 revision、环境不匹配、步骤为空、浏览器不可用或缺少 secret 时，整批拒绝且不产生 run/batch；预检错误按 flowId 逐项列出，用户修正（换环境/先发布）后重新提交，不提供移除失败项后提交剩余项或自动跳过。
- 创建成功后各 run 独立执行；一个失败不阻止后续流程，批次允许部分失败。
- 首版维持单并发 FIFO；批次上限 20，总步骤上限 2000。并发调度和更复杂公平队列另立任务。
- 单 run API、计划任务和 Webhook 行为保持兼容；孤立 run 继续在运行中心显示。

### Dependency And Non-Goals For Planning

- R0 已独立验收：列表运行、编辑器运行到此步骤、显式 `revisionId` 兼容和 flow/revision/environment mismatch 回归必须持续通过。批次重试还需等待 retry P0 follow-up 的 snapshot clone 实现/回归门禁，不得以现有 revision 级复用代替。
- 本任务只规划“同项目批量提交 + 串行编排 + 批次观测”；不把并发调度、跨项目编排或新的执行器作为隐含后续。

## Requirements

### P0 Dependency: Correct Flow Revision Selection

- 本节由独立 P0 子任务拥有，本任务不得重复实现或另建 resolver。
- Batch 只消费 P0 已验收的 `projectId + flowId + environmentId` resolver，并复用其 mismatch/error 契约。
- P0 的 A/B 流程回归、显式 revision 兼容和运行到此步骤测试是本任务持续回归 gate；retry P0 follow-up 是失败项重试完成验收的外部 gate。

### R1 Batch Creation

- 流程列表支持多选；只有有 `run.execute` 权限、处于平台模式且选择 2-20 个流程时可发起批量运行。
- 用户选择一个项目内环境，在确认弹窗查看流程数、总步骤数、环境和串行执行提示。
- 客户端每次用户意图生成 UUID `clientRequestId`；同一项目重复提交相同 key 必须返回原批次，不能重复创建 run。
- 服务端在创建前解析每个 `flowId + environmentId` 最新 published revision，验证步骤、Chromium、secret 和总量限制。
- 所有 batch 和 run 记录在同一 `BEGIN IMMEDIATE` 事务内创建，随后才入 ManagedRunner 队列。
- 创建结果按用户选择顺序保存 `itemIndex`，每个流程恰好对应一条 run。

### R2 Batch State And Query

- 批次状态为 `queued`、`running`、`success`、`partial_failed`、`failed`、`canceled`，由子 run 状态确定。
- 批次摘要至少返回 `total`、`queued`、`running`、`success`、`failed`、`canceled` 和 `completed` 计数。
- `queued`：全部子项 queued；`running`：任一子项 running，或已有终态且仍有 queued；`success`：全部 success；`canceled`：全部 canceled；`partial_failed`：全部终态且成功与失败/取消并存；`failed`：全部终态、没有成功且至少一个 failed。
- 提供项目批次分页列表和批次详情；详情按 itemIndex 返回子 run 摘要，并可进入现有单 run 详情。批次列表默认按创建时间倒序（2026-08-16 已确认），保证运行中的批次在分页跨页时位置稳定，不按最近子 run 更新时间重排。
- 服务重启后批次无需单独恢复队列；既有 run 恢复逻辑重排 queued 子项，批次状态由数据库中的子状态重新计算。

### R3 Cancel Batch

- 只有 `run.execute` 权限可取消批次。
- 取消操作幂等：所有 queued 子项立即进入 canceled；当前 running 子项设置取消请求并关闭浏览器；已终态子项保持不变。
- 取消请求与子 run 标记先在数据库事务内提交，再调用 ManagedRunner cancel；运行完成竞态以 run 的最终条件更新为准，不能把 success 回写成 queued。
- 取消的对外表达复用现有单 run 语义（2026-08-16 已确认）：不新增“取消中”对外状态；queued 子项直接显示 canceled，running 子项保持 running，UI 依据现有 `cancellation_requested` 标志呈现“取消中”提示，runner 写入终态后切换。批次状态聚合规则不受影响。
- 已成功或失败的外部副作用不回滚。

### R4 Retry Failed Items

- 只有原批次全部进入终态后才能“重试失败项”。
- 重试集合为 failed 和 canceled 子项；若为空返回 `BATCH_NOT_RETRYABLE`。
- 重试创建一个新 batch，记录 `retryOfBatchId`，使用新的 `clientRequestId`，不修改原批次和原 run 历史。
- 重试语义与单 run 重试一致（2026-08-16 已收敛）：每个重试子项必须是原 run snapshot 的一对一克隆，即使原 revision 已 superseded 也只创建一条新 run，复用原 revision ID/checksum、环境/元素快照、原 dataset 单行和 `upToStepId`；新 run 的 `retryOfRunId` 与 `run.retried` 审计逐条指向原 run，secret 明文不进入 snapshot。不得解析最新 published revision，也不得按 revision dataset 配置重新展开。
- Retry 请求只预检每个原 snapshot 所需的普通变量和 secret 名称，不在请求中物化或持久化值；预检当下缺失时整次 retry 零写入并返回稳定错误，batch 不建立部分 child。已创建的 queued child 在 enqueue 与重启恢复物化 runner input 时读取当时当前值；预检后配置被删除时 child 保留并在物化阶段稳定失败。该值语义不改变 snapshot clone 的一对一边界。

### R5 Runs Center UX

- 流程列表使用表格 rowSelection 和批量操作区；单行运行入口继续保留。
- 提交成功后跳转运行中心并定位到新 batch。
- 运行中心按批次显示汇总行或可展开分组，同时保留不属于 batch 的单运行。
- 批次详情显示每个流程的排队/运行/终态、运行详情入口、取消和重试失败项操作。
- 轮询仅在页面中存在非终态 batch/run 时使用现有快慢间隔策略；刷新页面后批次从服务端恢复，不依赖本地 Zustand 记录。
- UI 明确显示“串行执行”，不使用“并行”“同时运行”等误导文案。

### R6 Audit, Notification And Limits

- 创建、取消和重试分别写 `run_batch.created`、`run_batch.cancel_requested`、`run_batch.retried` 审计，target 指向真实 batch id。
- 子 run 保留现有运行事件和终态审计；审计 detail 只含 ID、数量、环境和状态，不含 secret 值或完整执行快照。
- MVP 保留每个子 run 现有通知行为，UI 确认弹窗提示可能产生多条通知；批次汇总通知不在本期。
- 超过 20 个流程、总步骤超过 2000、重复 flowId、dataset 或 `upToStepId` 请求由服务端拒绝，不能只依赖前端校验。

## Acceptance Criteria

- [x] AC0：单流程列表和编辑器入口运行指定流程的 revision；两个流程连续保存后运行流程 A 不会执行流程 B。（P0 已归档，`test_revision_selection.py` A/B 用例）
- [x] AC1：登录用户可在同一项目选择 2-20 个有步骤的流程和一个环境，确认后一次创建一个 batch 及每流程一条 queued run。（`test_batch_create_orders_runs_and_sets_batch_context`）
- [x] AC2：任一流程没有匹配 published revision、环境不匹配、缺少 secret 或总量超限时，响应包含可定位到 flowId 的校验错误，数据库中不产生 batch/run。（`test_batch_preflight_failure_rejects_whole_batch` + `test_batch_total_steps_limit`；错误经 `PlatformError.detail` 携带 `items` 透传前端）
- [x] AC3：相同 `(projectId, clientRequestId)` 重复或并发提交只存在一个 batch 和一组 run，响应返回相同 batch id。（`test_batch_idempotency_replay_and_key_conflict`；并发由 UNIQUE 约束收口）
- [~] AC4：ManagedRunner 保持最多一个 active run，子项按 itemIndex 串行执行；一个子项失败后后续子项仍执行。（按 itemIndex 顺序入既有单并发 FIFO，执行器行为未改动、由既有套件保护；“一个失败不阻断后续”依赖该不变量，未做专项执行级测试）
- [x] AC5：批次状态和计数在全成功、全失败、全取消、部分成功、执行中混合状态下符合 R2 定义。（`test_batch_status_aggregation_matrix`）
- [x] AC6：取消批次后 queued 子项被取消、running 子项收到取消请求、终态子项不变；重复取消无副作用。（`test_batch_cancel_idempotent_and_scoped`，含事件幂等断言）
- [~] AC7：终态批次可以只重试 failed/canceled 项，新 batch 记录 `retryOfBatchId`，每个子项按原 run snapshot 一对一克隆（含已 superseded revision），原批次历史不变；当前实现/测试仍需补原 revision checksum、单行输入、`upToStepId` 和逐条 `retryOfRunId`/审计断言。（现有 `test_batch_retry_uses_original_revision_snapshots` 只证明 revision/步骤级复用）
- [~] AC8：服务重启后 queued 子项恢复排队，批次页面刷新后从服务端显示正确进度，不依赖 localStorage。（启动恢复复用既有 queued 重排逻辑、create 测试断言 queued 可恢复；进程退出级重启模拟未做；页面刷新从服务端加载由 E2E 覆盖）
- [~] AC9：运行中心能分页查看批次并展开子 run，孤立单 run 仍可见，单 run 详情/取消/重试保持可用。（批次列表/展开/子 run 链接由 `tests/batch-run.spec.ts` 覆盖；单 run 路径由既有 spec 回归；E2E 级批次取消/重试按钮交互未覆盖）
- [~] AC10：无权限、跨项目 batch/run、非法 flowId 和批次上限请求被拒绝；API 和审计不泄漏 secret 或 snapshot 明文。（上限/非法输入由服务层测试覆盖；权限/跨项目由 handler capability + `run_batch_by_id` 项目范围 404 保证，未加 handler 专项测试；批次详情响应只含摘要不含 snapshot）
- [x] AC11：既有手工运行、dataset 单流程运行、schedule、webhook、通知、运行历史分页和 ManagedRunner 测试继续通过。（85 Python + 30 前端单测 + E2E 除基线遗留失败外全部通过）

## Out Of Scope

- 并行执行、可配置并发、多执行节点和分布式任务领取。
- 跨项目批次、超过 20 个流程的大规模测试套件。
- 批量流程与 dataset 笛卡尔积、批量 `upToStepId`。
- 批次级断点续跑、优先级、拖拽排序和公平调度策略。
- 批次汇总通知、批次报告导出和跨批次趋势分析。
- 回滚已经执行的业务操作或外部副作用。

## Dependencies And Estimate

- P0 单流程 revision 正确性已由独立任务完成，不计入本任务 8-12 人日实现量；retry reproduction follow-up 也独立估算和验收。
- 数据库、服务和 API：3-4 人日。
- 流程多选、批次确认和运行中心分组：2-3 人日。
- 重启、幂等、取消、历史分页和 E2E：2-3 人日。
- 生产可用 MVP 合计：8-12 人日。
- 可配置并发、公平调度、汇总通知和大规模查询：另加约 5-8+ 人日。

## Risks And Deferred Items

- 当前分页任务正在修改 runs API 和 RunsPage；批次开发应基于该任务合并后的契约，避免并行修改造成冲突。
- 单个 20 项批次会连续占用 FIFO，MVP 通过硬上限控制；真实使用仍出现饥饿时再建设来源公平调度。
- 当前运行产物缺少完整保留策略，批量会放大截图、事件和通知数量；上线前至少记录容量指标和运维清理建议。
- 事务提交后入内存队列若进程崩溃，现有启动恢复必须能重新入队所有 queued run，这是发布阻断测试。
