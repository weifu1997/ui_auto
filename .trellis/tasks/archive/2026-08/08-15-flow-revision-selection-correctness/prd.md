# 流程 revision 选择正确性（P0）

## Goal

让用户从流程 A 的入口运行时，服务端必定选择流程 A 在所选环境的已发布 revision；禁止在缺少上下文时按项目最近发布的任意流程猜测。这个任务是流程批量执行和流程录制“保存后运行/重放”的共同硬前置。

## User Value And Boundary

- 用户选择的流程、环境和实际执行快照保持一致，可通过运行详情审计。
- 本任务只修复 revision 解析与手工平台运行入口，不实现 batch、recording、并发调度或新的保存流程。
- 本地 Worker 运行路径继续使用现有请求，不借此任务改变其数据模型。
- 计划任务、Webhook、AgentsPage 的显式 revision 路径和已有运行详情入口必须兼容；它们不应因为 resolver 重构而改成项目级猜测。

## Confirmed Evidence

- `src/pages/FlowsPage.tsx:94` 的平台列表运行只发送 `environmentId`。
- `src/FlowEditorPage.tsx:236` 的平台运行到此步骤只发送 `environmentId` 与可选 `upToStepId`。
- `src/platform-api.ts:473` 的 `createPlatformRun` 允许省略 `revisionId`，也尚未表达 `flowId`。
- `server-py/autoflow/services.py:715` 的 `published_revision_for(project_id, revision_id=None)` 在省略 revision 时按项目最近 `published_at` 查询；`queue_published_runs` 在 `services.py:1116` 直接使用该 resolver。
- `server-py/autoflow/handler.py:1946/2368/3071` 等计划、Webhook、单 run retry 路径传入显式 revision；它们的兼容行为不能被手工入口修复破坏。
- `server-py/autoflow/handler.py:3401` 发布新 revision 时会把同 `flow_id + environment_id` 的既有 published revision 置为 `superseded`；而显式 revision 查询（`services.py:726`）只接受 `published`。因此当前行为是：该流程发布更新版本后，重试旧 run 必然返回 409 `PUBLISHED_REVISION_REQUIRED`，旧快照今天不可重试。若采纳“按原 revision 重试”，P0 必须为 retry 路径扩展可接受的 revision 状态；若采纳“按最新 published 重试”，retry 入口需改为 flow-scoped 解析。
- `flow_revisions` 已有 `flow_id`、`flow_name`、`environment_id` 列；迁移会为旧快照回填这些字段。当前平台 schema migration 版本为 10。

## Product Decisions

- 手工列表运行和编辑器运行到此步骤必须携带 `flowId`，或携带与该流程一致的显式 `revisionId`。
- 省略 `revisionId` 时，服务端只允许使用 `projectId + flowId + environmentId` 查询该流程最新 published revision；不再回退到项目级最新任意 revision。
- 同时提供 `flowId` 与 `revisionId` 时，两者必须属于同一项目、同一流程；不一致返回可识别的 `REVISION_FLOW_MISMATCH`。
- 显式 `revisionId` 路径继续支持现有 schedule、Webhook、AgentsPage 和 run-detail 调用；服务端仍校验 project 与 environment。
- 单 run 重试语义（2026-08-16 已确认）：重试按原 run 的 revision 快照执行，即使该 revision 已被 superseded；重试的目的是复现原 run，不是获取最新版本。该例外只属于重试入口，普通手工运行仍只接受 published 状态。
- P0 通过前，batch/recording 子任务不得进入实现批准；它们的运行/重放验收引用本任务的回归结果。
- 无 published revision 流程的运行入口（2026-08-16 已确认）：UI 对无 published revision 的流程禁用运行按钮并提示“先保存发布”，API 层仍强校验返回 `PUBLISHED_REVISION_REQUIRED`（双保险，覆盖旧客户端与直接 API 调用）。

## Requirements

### R1 Resolver Contract

- 将服务层 resolver 收敛为等价于 `published_revision_for(project_id, revision_id=None, flow_id=None, environment_id=None)` 的单一 owner；单运行、batch、retry 不复制 SQL。
- 有 `revisionId`：查询该项目内可执行的 revision，并校验可提供的 `flowId/environmentId`；flow 不一致返回 `REVISION_FLOW_MISMATCH`，环境不一致返回现有 `REVISION_ENVIRONMENT_MISMATCH`。
- 重试路径按原 run 记录的 `revisionId` 加载快照，接受 `published` 或 `superseded` 状态；除此之外的任何入口不得放宽状态过滤。
- 无 `revisionId`：`flowId` 和 `environmentId` 必须足以唯一定位最新 published revision；缺少 flow 上下文返回 `FLOW_ID_REQUIRED`（或最终确认的等价错误码），不得按项目排序取一条。
- 查询不到该项目/流程/环境的 published revision 时返回可区分的错误，不能创建 queued run。
- 旧 revision 行的 `flow_id/environment_id` 缺失时沿用迁移回填或从快照安全解析；不通过模糊名称匹配流程。

### R2 Manual Entry Contracts

- `FlowsPage` 平台列表运行发送当前 flow 的 `flowId` 和环境；`FlowEditorPage` 发送当前 flow 的 `flowId`、环境和可选 `upToStepId`。
- `createPlatformRun` 的 TypeScript DTO 表达 `flowId`，并保留显式 `revisionId` 的兼容选项；组件不在边界处 cast 原始 payload。
- `upToStepId` 只在解析出正确 flow revision 后校验，不能让步骤 ID 跨流程命中。
- 无 published revision、环境不匹配、非法 flowId 和跨项目 revision 的错误在 UI/API 中可定位且不泄漏 snapshot/secret。
- 流程列表和编辑器对无 published revision 的流程禁用运行入口并提示“先保存发布”；流程列表数据需能表达每个流程的已发布状态，API 仍独立强校验。

### R3 Compatibility And Audit

- schedule、Webhook、AgentsPage、RunDetail retry 现有显式 revision 请求继续通过；其行为变化必须有回归测试说明。
- 运行快照中的 `flowRevisionId`、`flow.id`、`environmentId` 必须互相一致；审计仍指向真实 run，不写入 secret 或完整 snapshot。
- 不修改历史 revision 的内容，不批量重写 checksum；已有运行的审计和详情可读。
- 重试创建的新 run 与原 run 使用同一 revision 快照；`retry_of_run_id`、`revisionId` 与快照 checksum 的一致性可审计。

## Acceptance Criteria

- [x] AC1：流程 A、B 各有不同 published revision 时，从列表分别运行 A/B，创建的 run snapshot.flow.id 与入口 flow 一致，不受最后保存顺序影响。（`test_revision_selection.py::test_flow_scoped_run_selects_entry_flow_revision`）
- [x] AC2：编辑器运行到指定步骤携带 flowId；步骤属于另一流程或不存在时被拒绝，不会创建 run。（`test_up_to_step_must_belong_to_resolved_flow`；编辑器 payload 与列表共用 `createPlatformRun` 契约）
- [x] AC3：无 `revisionId` 且缺少 flowId、无匹配 flow/environment revision、跨项目 flow/revision、flow/revision 不一致时，返回稳定错误码，数据库不新增 run。（`FLOW_ID_REQUIRED`/`REVISION_FLOW_MISMATCH`/`PUBLISHED_REVISION_REQUIRED` 用例）
- [x] AC4：显式 revision 的 schedule、Webhook、AgentsPage、RunDetail retry 和既有 smoke 测试继续通过；环境 mismatch 仍被拒绝。（既有 68 测试 + `test_explicit_revision_environment_mismatch_still_rejected`）
- [x] AC5：每个成功创建的 run 的 revision、snapshot.flow.id、snapshot.environmentId 与请求/解析结果一致，运行详情可审计。（flow-scoped 用例断言 snapshot.flowRevisionId/flow.id）
- [x] AC6：旧数据库迁移后 `flow_revisions.flow_id/environment_id` 可用于解析；重复启动 migration 不改写历史 run/revision。（`test_legacy_revision_flow_id_falls_back_to_snapshot` + 既有 migration 测试；本任务未新增 migration）
- [x] AC7：P0 回归测试在服务层、handler/API、FlowEditor/FlowsPage 调用契约层均可重复运行，并为 batch/recording 提供可引用的通过证据。（服务层 8 用例 + E2E fixture 按 flowId 解析、management-and-run/full-user-journey 断言 flowId）
- [x] AC8：重试 revision 已 superseded 的 failed run 时，新 run 使用原 revision 快照（revisionId/checksum 与原 run 一致）并成功排队执行；普通手工运行仍只能解析 published revision。（`test_retry_uses_original_superseded_revision_snapshot`）

## Out Of Scope

- 批次实体、批次状态/取消/重试和 RunsPage 批次 UI；
- 录制浏览器会话、事件归并、元素导入和敏感输入处理；
- 并行执行或新的 revision 发布/审批工作流；
- 改写旧 revision、删除历史 run 或改变本地 Worker API。

## Risks And Deferred Items

- `published_revision_for` 也被自动化配置创建/更新使用；实现必须区分“显式 revision 的兼容路径”和“手工无 revision 的 flow-scoped 路径，避免误伤 schedule/Webhook”。
- retry 接受 superseded 快照是唯一的状态过滤例外；实现必须保证手工运行、batch 创建等其它路径仍只接受 published，防止例外扩散为“任意旧版本可运行”。
- 旧客户端可能省略 flowId；若不再兼容，必须给出明确错误和迁移说明，而不是静默选择任意 revision。

## Open Questions For Requirement Convergence

（无——P0 相关产品决策已全部收敛，见 Product Decisions。）

