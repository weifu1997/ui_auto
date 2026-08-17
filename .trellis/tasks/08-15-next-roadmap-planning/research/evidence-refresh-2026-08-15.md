# 需求规划证据刷新（2026-08-15）

## 2026-08-15 初始范围

本节保留 2026-08-15 的初始只读快照：当时只刷新需求和依赖，不修改产品代码、不运行 `task.py start`，也不把匿名评测 Prompt 视为实现授权。后续任务状态与新增 P0 follow-up 以父 PRD 的 Product Intent And Task Boundaries 为准。

## 已确认的当前基线

- 2026-08-15 初始 `HEAD` 为 `191e46d`；当时工作区只有三个活动任务草案和评测 Prompt 未跟踪，产品代码没有该轮改动。
- 稳定性路线图中的前置工作已经在历史提交中落地并归档：
  - Python 环境入口与迁移收尾：`a937e83`；
  - 生产同步 outbox 与重试：`ec311ab`；
  - canonical revision snapshot：`400bac0`；
  - 运行中心首次加载：`531cf03`；
  - 运行/投递服务端分页：`4d96115`；
  - 自动化配置编辑与 secret 轮换：`954b7d0`；
  - 前端 chunk/bundle 预算：`3249922`。
- 本轮只读验证结果：`npm run build`、`npm run lint`、`npm run test:unit`（9 个文件、30 个测试）和 `npm run test:py`（68 个测试）通过。E2E/Windows 门禁未在本轮运行，不把它们标记为通过。

## 2026-08-15 规划起点的缺口证据

### 单流程 revision 选择正确性（规划起点；基础 P0 已归档修复）

- `src/pages/FlowsPage.tsx` 的平台手工运行只发送 `environmentId`；`src/FlowEditorPage.tsx` 的运行到此步骤也只发送 `environmentId/upToStepId`。
- `src/platform-api.ts:createPlatformRun` 允许省略 `revisionId`；`server-py/autoflow/services.py:715` 的 `published_revision_for` 在省略时按项目最近 published revision 查询，没有 `flowId` 约束。
- 因此在规划起点两个流程交替保存后，手工运行可能拿到另一个流程的 revision。该缺口曾是批量执行硬前置，也会污染录制后的保存/重放验收；基础 P0 已修复并由 A/B 回归锁定。
- 显式 `revisionId` 的计划任务、Webhook、AgentsPage 和 RunDetail retry 路径已有独立契约；修复时必须保持兼容并校验 flow/revision/environment 一致性。

### 批量执行（规划起点）尚未有持久边界

- 当时 schema 只有 `platform_runs`，没有 batch 表或 child-run 关联；ManagedRunner 是单 active、FIFO 队列。后续 batch 并行工作已添加 schema/服务，但其 retry closure 仍待 P0 follow-up 验收。
- 当前 runs API 已有服务端分页，因此 batch 列表/详情应在此契约上增量扩展，不能回到一次加载固定上限。

### 录制（规划起点）尚未有平台认证链路

- 当时 `server-py/autoflow/worker.py` 的 local-picker 会话是内存对象，旧 `/api/projects/{project}/local-picker/*` 路由只做 project 字符串校验，适合 loopback Picker，不是带平台 session/能力检查的远程录制 API。后续 recorder PoC/fixture 已验证内核，认证 API、编辑器导入和保存/重放闭环仍待完成。
- `server-py/autoflow/picker.py` 当前只处理一次 click，role 候选不含 accessible name，注入脚本也不是跨完整导航的 recorder 事件流。
- `src/flow-store.ts` 只有逐项编辑 action，没有录制结果的原子导入 action；元素草稿需在确认后再进入 workspace 同步。

## 已确认依赖

```text
next-roadmap-planning
        |
        +--> flow-revision-selection-correctness (已锁定 P0 prerequisite)
        |          |
        |          +--> flow-retry-reproduction-correctness (P0 follow-up)
        |                       |
        |                       +--> flow-batch-execution-mvp
        |                       +--> flow-recording-mvp (save/replay gate)
        |
        +--> existing stability work (completed; regression only)
```

子任务之间的依赖必须写进各自 PRD/implement 文档；父任务不直接授权实现。

## 2026-08-15 规划时的待决问题（历史记录）

本节保留当日证据刷新时的决策库存，不代表当前仍未收敛。revision 前置、retry 使用原快照、batch 预检原子性以及 recording 的登录态/同源/URL 脱敏口径，均已在后续 PRD 决策日志中收敛；当前仅保留实现/回归门禁。

- 当日已确认先单独锁定并验收 revision 选择正确性，并将其作为 batch/recording 硬前置。
- 当日尚未决定 retry 采用原快照还是最新 published；该分支已于 2026-08-16 选择原快照并记录。
- 当日尚未决定 batch 无 published revision 时的整批拒绝；该分支已于 2026-08-16 选择整批拒绝并记录。
- 当日尚未决定 recording 登录态、同源起始 URL和 query/fragment 脱敏；这些分支已于 2026-08-16 记录。

## 2026-08-16 需求收敛增量

- 产品决策已确认：单 run retry 必须继续执行原 run 的 revision 快照，即使该 revision 已变为 `superseded`；普通手工运行和 batch 创建仍只接受 `published`。该决定已写入归档 P0 与 batch PRD/design，旧的“原快照或最新 published”二选一记录不再有效。
- 代码核对发现，revision 复用并不等于原 run 一对一复现：`handler.py:3095-3103` 的 retry 请求没有传 `datasetVersionId`、原 dataset 行或 `upToStepId`；`services.py:1182-1198` 会从 revision 回读 dataset 版本并加载全部行，`services.py:1371-1390` 为每行创建新 run。原 run snapshot 虽在 `services.py:1296-1320` 保存行数据和 `upToStepId`，当前 retry 没有读取它。
- 当上述回读产生多条新 run 时，`handler.py:3105-3112` 只给第一条写 `retry_of_run_id` 和 `run.retried` 事件，其余新 run 没有明确的 retry 关联。现有测试只验证 superseded revision id/步骤仍被接受，未覆盖 dataset 行基数、行数据、`upToStepId`、checksum 或一对一审计链路。
- 产品决策已确认“retry 的重现单位”就是原 run snapshot 的一条不可拆分记录：原 revision id+checksum、environment/element snapshot、单个 dataset 行、`upToStepId` 和完整 retry 关联均一对一复用；不得重新按 revision 的 dataset 配置展开，secret 明文仍不进入 snapshot，按既有安全契约在执行时解析。当前代码尚未满足，已创建独立 P0 follow-up `08-16-flow-retry-reproduction-correctness`，batch/recording 以其实现和回归为硬依赖。
- 当日先确认了运行时值的安全边界：不建设普通 variable/secret 历史值版本库，明文不进入 snapshot，审计只记录安全名称/状态，且“字节级重现”不涵盖这些值。请求预检、enqueue/restart 物化与预检后删除的最终时序已于 2026-08-17 收敛，以下节条款为准。
- UI lineage 证据已完成并形成产品决策：平台 `/runs/{run_id}/retry` 仅接受 `failed/canceled`（`handler.py:3082-3103`），但 `RunDetailPage.tsx:389-406` 与 `RunsPage.tsx:226-239` 的平台“重新运行”当前调用 `createPlatformRun`，因此会生成没有 `retryOfRunId` 的 fresh run；`PlatformRun` DTO（`src/platform-api.ts:56-73`）及 `run_by_id`（`services.py:1897-1924`）也尚未投影该关联。已确认 failed/canceled UI 必须接 canonical retry，RunDetail 只展示直接父 run，success 保留单独的 fresh-run 操作，完整 ancestry/root 不进 MVP。当时尚未收敛 success fresh-run 的 revision 选择，已于 2026-08-17 选择 flow-scoped 当前最新 published 并记录如下。

## 2026-08-17 需求收敛增量

- 产品决策已确认：success 的“再次运行（新运行）”从源 snapshot 的 `flow.id` 取得 `flowId`、沿用原 `environmentId` 并省略 `revisionId`，由普通 resolver 按 `project + flow + environment` 选择当前最新 published revision（`src/platform-api.ts:482-487`、`services.py:765-786`）。缺少可信 `snapshot.flow.id` 或匹配 published 时稳定拒绝，不回退旧 revision。
- 该决定与 retry 刻意分离：发布 A 后再发布 B，success(A) fresh 使用 B 的 revision/checksum，并按 B 的当前 dataset snapshot/rows 产生一条或多条 lineage-null run；failed/canceled(A) canonical retry 仍创建一条 A snapshot clone 并记录直接父链。当前 UI 显式 pin A（`RunDetailPage.tsx:399-406`、`RunsPage.tsx:231-239`），所以实现必须替换 payload 并补 A→B、dataset 基数及 fail-closed 回归。
- 代码证据还显示 `managed_runner_input` 在 enqueue 时读取当前 variables/secrets，进程重启恢复时会再次读取（`services.py:2103-2166`）。产品已确认 retry 请求只预检必需名称，成功创建的 queued run 在 enqueue/重启恢复物化 input 时读取当时当前值；预检当下缺失才承诺零写入，预检后删除则保留 queued run 并在物化阶段稳定失败。明文只允许存在于短暂内存 runner input，不进入 snapshot、数据库、API、event、audit 或日志；不建设历史值版本库，也不承诺运行时值字节级重现。剩余未决产品项为 success 多 run 的 UI 去向和 recording 刷新恢复。
