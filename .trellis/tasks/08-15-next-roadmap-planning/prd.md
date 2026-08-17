# 下一阶段需求与缺陷规划

## Goal

在稳定性路线图已经落地的基础上，固定会影响执行正确性的共同前置，以及“流程批量执行 MVP”和“流程录制 MVP”的边界、顺序与验收口径。这个父任务只负责需求、证据、依赖和跨任务质量门；不直接实现任何产品功能。

用户价值：用户选择哪个流程，就执行哪个流程的已发布版本；后续批量执行和录制结果不会建立在错误 revision、未认证浏览器会话或不可审计的临时状态上。

## Background And Evidence

### 已完成的稳定性基线

以下事项已经由历史提交实现并归档，本规划不再把它们列为待开发需求，只保留回归验证责任：

- Python 环境入口与迁移收尾：`a937e83`；
- 生产同步 outbox 与网络重试：`ec311ab`；
- canonical revision snapshot：`400bac0`；
- 运行中心首次加载平台历史：`531cf03`；
- 运行与投递服务端分页：`4d96115`；
- 自动化配置编辑与 Webhook secret 轮换：`954b7d0`；
- 前端 chunk/bundle 拆分与预算：`3249922`。

本轮只读验证：

- `npm run build`：通过；
- `npm run lint`：通过；
- `npm run test:unit`：9 个文件、30 个测试通过；
- `npm run test:py`：68 个测试通过；
- E2E 与 Windows 门禁本轮未运行，不能标记为通过。

证据与命令记录见 [`research/evidence-refresh-2026-08-15.md`](research/evidence-refresh-2026-08-15.md)。

### 规划起点与当前共同缺口

- 规划起点曾确认：`FlowsPage`/`FlowEditorPage` 省略 `flowId` 时，服务端可能按项目最新任意 published revision 运行错误流程。该缺口已由归档基础 P0 `08-15-flow-revision-selection-correctness` 修复并覆盖 A/B flow 回归；本规划只保留它作为 batch/recording 的已完成基础门禁。
- 当前真正未闭环的是 retry reproduction：单 run retry 虽复用原 revision，却可能重新展开 dataset、丢失 `upToStepId` 且只关联第一条新 run。独立 P0 follow-up `08-16-flow-retry-reproduction-correctness` 负责该实现和回归门禁。
- 规划起点时数据库只有 `platform_runs`、没有 batch 聚合实体，local-picker 也只是内存/loopback click 采集。并行工作已留下 batch schema/服务和 recorder fixture/PoC，但 batch 的 retry closure、recording 的认证 API/编辑器导入和最终保存/重放仍未通过各自验收；本父任务不把这些工作树状态标成完成。

## Product Intent And Task Boundaries

- 本父任务与新增 `08-16-flow-retry-reproduction-correctness` 保持 `planning`；工作区中 batch/recording 的 `task.json` 已由既有并行工作置为 `in_progress`，但该现状不构成本轮继续修改产品代码的授权。匿名模型评测 Prompt 仍只是未来实验材料。
- 父任务拥有共同目标、依赖图和跨任务验收；各功能子任务拥有独立、可观察的产品验收标准。
- 子任务之间的依赖写入子任务自身的 PRD/implement 文档，不以目录层级暗示依赖。
- 任何子任务在进入实现前，都需要用户对该子任务最新 planning summary 另行明确批准；本轮不运行 `task.py start`。

## Prioritized Roadmap

### P0：流程 revision 选择正确性（已锁定共同前置）

先把手工运行的输入契约收敛为“显式 revision，或由 `projectId + flowId + environmentId` 唯一解析该流程最新 published revision”。显式 revision 与 flow/environment 不一致时必须拒绝，不能静默纠正。

这项工作已经创建并完成为独立基础 P0 子任务：[`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md)。它覆盖流程列表运行、编辑器运行到此步骤、显式 revision 的兼容路径，以及 A/B 流程回归。本轮又把 retry 的完整重现单位锁定为 P0 的 follow-up 硬门；在该门禁的实现和回归证据完成前，batch 和 recording 的“保存后运行”验收均不成立。

本轮在代码证据基础上已确认“单次重试继续执行原 revision，确保可复现和审计”的完整语义：retry 必须是原 run snapshot 的一对一克隆，即使 revision 已 `superseded` 也只创建一条新 run，复用原 revision ID/checksum、环境与元素快照、原 dataset version 的单行数据和 `upToStepId`；每条新 run 都有对应 `retryOfRunId` 与 `run.retried` 审计关联，secret 明文仍不得进入 snapshot。当前入口 `server-py/autoflow/handler.py:3095-3103` 及服务层 `services.py:1182-1198/1371-1390` 尚未满足该契约：会重新展开全部 dataset 行并丢失步骤边界，且 `handler.py:3105-3112` 只关联第一条；这属于已收敛需求、待实现/回归的 P0 follow-up，而不是新的产品选择。

平台 UI 的 retry 语义也已锁定为同一条可审计契约：`failed/canceled` 的“重新运行”调用 canonical `/runs/{id}/retry`，RunDetail 只展示可跳转的直接父 run；`success` 保留明确区分的“再次运行（新运行）” fresh-run 操作。success fresh-run 发送 `flowId + 原 environmentId` 而省略 `revisionId`，由 flow-scoped resolver 选择当前最新 published revision；没有 flow id 或匹配 published 时 fail closed，不回退到原 revision。fresh run 可以按当前 revision 的 dataset 配置产生多条 run，这与只复现原 snapshot 的 retry 有意区分。完整 ancestry/root、批次父链和递归 lineage 展示不进入 MVP。

### P1：流程批量执行 MVP

沿用现有 ManagedRunner 的单并发 FIFO，只增加持久 batch 聚合、原子预检/创建、批次查询、取消和失败项重试。2–20 流程、单环境、每流程一条 run、禁止 dataset/`upToStepId`、部分失败继续执行等边界已于 2026-08-16 产品复核确认；失败项重试必须继承 `08-16-flow-retry-reproduction-correctness` 的原 run snapshot 一对一克隆契约。

### P2：流程录制 MVP

复用 Python Playwright/Pick­er 的部署机浏览器能力，新增认证的临时录制会话、事件归并、敏感输入保护、review 和原子草稿导入。起始 URL 同源、登录态快照注入（含「从头录制」选项）与 query/fragment 完全剥离已于 2026-08-16 确认并写入子任务 PRD/design。

### 暂缓项

并行执行/可配置并发、跨项目批次、浏览器 Extension/CDP、多页面录制、自动断言、报告导出和多租户能力不进入本轮 MVP。

## Dependency And Risk Contract

```text
revision-selection-correctness (基础 P0)
        └──> retry-reproduction-correctness (P0 follow-up)
                    ├──> batch-execution-mvp
                    └──> recording-mvp (保存/重放验收)
```

- Batch 必须基于已完成的 runs 服务端分页契约；不得重新引入固定 200 条或客户端全量加载。
- Batch 与 recording 必须等待 [`08-16-flow-retry-reproduction-correctness`](../08-16-flow-retry-reproduction-correctness/prd.md) 的实现/回归门禁；不得各自复制或弱化 retry clone 语义。
- Recording 必须沿用现有资源同步和 canonical revision snapshot；确认导入前不能写平台资源。
- 两个子任务都要保持项目隔离、现有单 run/dataset/schedule/webhook/Picker 兼容，并提供回滚点。
- 批量会放大运行产物、事件和通知容量；录制会接触浏览器页面和敏感输入，容量与脱敏是发布阻断风险。

## Planning Acceptance Criteria

- [x] AC0：父任务文档准确区分已完成基线、当前缺口和已排序需求；不把已归档工作重复列为待开发。
- [x] AC1：revision 选择正确性被拆成独立 P0 子任务，列出入口、API 契约、兼容路径、可观察回归和完成门槛。
- [x] AC2：batch 子任务写明对 P0、分页契约和 ManagedRunner 的依赖，并有原子性、幂等、状态聚合、取消竞态和审计安全的验收标准。
- [x] AC3：recording 子任务写明对 P0、平台认证、浏览器生命周期、敏感数据和现有保存/重放链路的依赖，并有真实本地 fixture 验收标准。
- [x] AC4：每个进入实现的子任务都有独立 `prd.md`、复杂任务所需的 `design.md`/`implement.md`，以及真实的 `implement.jsonl`/`check.jsonl` 上下文条目。
- [x] AC5：本次需求细化未修改产品代码、未调用 `task.py start`；任何后续实现仍需用户批准对应任务的最新 planning summary。
- [x] AC6：单 run retry 的“重现单位”已明确为原 run snapshot 的一对一克隆，覆盖原 revision ID/checksum、环境/元素快照、单个 dataset 行、`upToStepId`、逐条 `retryOfRunId` 和审计事件；实现与回归证据仍是 batch/recording 的最终硬门。
- [x] AC7：retry 请求只预检原 snapshot 所需普通变量/secret 名称；预检当下缺失时稳定拒绝且数据库、event、audit 零写入，分别使用 `RUN_VARIABLE_NOT_CONFIGURED`/`RUN_SECRET_NOT_CONFIGURED`。成功创建的 queued run 在 enqueue 与重启恢复物化 runner input 时读取当时当前值，轮换后的值可生效；预检后删除配置时 queued run 保留并在物化阶段稳定失败。明文只允许短暂存在于内存 runner input，不进入 snapshot、数据库、API、event、audit 或日志；重现声明不涵盖这些值的字节级一致性。
- [x] AC8：平台 UI 的 failed/canceled “重新运行”语义已锁定为 canonical retry；RunDetail 展示一跳直接父 run 链接；success 使用独立的“再次运行（新运行）”操作；完整 ancestry/root 与批次 lineage 不进入 MVP。
- [x] AC9：success fresh-run 省略 `revisionId`，使用原 `environmentId` 与 `snapshot.flow.id` 对应的 `flowId` 解析当前最新 published revision；发布新版后可执行新版，缺少 flow id 或匹配 published 时稳定拒绝且不静默回退旧 revision；fresh run 的 dataset 基数可与历史不同，且 `retryOfRunId` 为空。

## Out Of Scope

- 本规划阶段直接实现 batch 或 recording；
- 恢复多机 Agent、租约、WebSocket、成员角色体系或云端多租户；
- 以匿名评测 Prompt 代替产品需求确认；
- 为了通过门禁删除、放宽或改写既有测试。

## Decisions Log

- 2026-08-16：单 run retry 按原 revision 快照执行，即使已 superseded；重试入口是唯一允许加载 superseded 快照的路径，普通手工运行仍只接受 published。batch「重试失败项」继承同一语义（每项按原 run 的 revision 快照重试）。已写入 P0 与 batch 子任务 PRD/design。
- 2026-08-16：batch 预检失败整批拒绝，错误按 flowId 逐项定位，用户修正（换环境/先发布）后重新提交；不提供移除失败项后提交剩余项、也不自动跳过。已写入 batch 子任务 PRD。
- 2026-08-16：录制起始 URL 强制与所选环境 baseUrl 同源（scheme+host+port），拒绝 userinfo、非 HTTP(S) 与跨域地址；跨域认证域路径 MVP 不支持，录制中导航外部域只产生 warning。已写入 recording 子任务 PRD/design。
- 2026-08-16：录制登录态采用快照注入——创建独立 context 时若同项目+环境有存活 Picker 会话则一次性注入其 storage_state（只读、不回写），提供「从头录制」选项；无 Picker 会话时手动登录。已写入 recording 子任务 PRD/design。
- 2026-08-16：录制 URL 一律脱敏为 scheme+host+path，query/fragment 在步骤、review、事件、日志、审计中完全剥离。已写入 recording 子任务 PRD/design；其余会话刷新恢复行为仍需单独收敛。
- 2026-08-16：批次取消的对外表达复用现有单 run 状态机——不新增“取消中”状态，running 子项由 UI 依据现有 `cancellation_requested` 标志呈现提示。已写入 batch 子任务 PRD。
- 2026-08-16：批次列表默认按创建时间倒序，运行中的批次在分页跨页时位置稳定，不按最近子 run 更新时间重排。已写入 batch 子任务 PRD。batch 子任务的产品决策已全部收敛。
- 2026-08-16：无 published revision 的流程在 UI 禁用运行入口并提示“先保存发布”，API 仍强校验 `PUBLISHED_REVISION_REQUIRED`。已写入 P0 子任务 PRD。P0 子任务的产品决策已全部收敛。
- 2026-08-16：单 run retry 的重现单位确定为原 run snapshot 的一对一克隆：只创建一条新 run，复用原 revision ID/checksum、环境/元素快照、dataset 单行和 `upToStepId`，每条新 run 都有 `retryOfRunId` 与 `run.retried` 审计关联；secret 明文不进入 snapshot。该决定扩展为 P0 follow-up 实现/回归硬门，batch/recording 不得自行改变语义。
- 2026-08-17：retry 不为普通 variables/secrets 建立历史值版本库。请求内只预检原 snapshot 所需名称；预检当下缺失时返回稳定错误且数据库、event、audit 零写入，审计只记录名称/状态、不记录明文。成功创建的 queued run 在 enqueue 与重启恢复物化 runner input 时读取当时当前值，因此轮换后的值可生效；预检后删除配置不回滚已创建 queued run，而在后续物化阶段稳定失败。持久 snapshot 的可复现声明不涵盖运行时值字节级一致性。
- 2026-08-17：平台 UI failed/canceled 的“重新运行”改按 canonical `/runs/{id}/retry`，RunDetail 仅显示直接父 run 链接；success 保留明确区分的“再次运行（新运行）” fresh-run 操作；完整 ancestry/root 与批次父链暂不进入 MVP。该决定消除 UI 生成无 `retryOfRunId` fresh run 的审计歧义。
- 2026-08-17：success 的“再次运行（新运行）”采用 flow-scoped fresh 语义：请求从 `snapshot.flow.id` 取得 `flowId`，携带原 `environmentId`、省略 `revisionId`，由服务端解析当前最新 published revision；无 flow id 或无匹配 published 时稳定拒绝，不回退旧 revision。该 fresh run 可按当前 revision 的 dataset 配置产生不同数量的 run，`retryOfRunId` 保持为空；只有 failed/canceled canonical retry 承诺原 snapshot 一对一复现。

## Open Questions

1. **success fresh 多 run 的 UI 去向**：当前 create 语义会返回多条 run，UI 是否继续导航第一条并把全部 run 写入运行中心，还是直接回到运行中心展示结果集合？
2. **recording 页面刷新恢复**：是否只在 `sessionStorage` 保存 `sessionId` 并恢复控制视图（推荐），还是刷新即取消会话并释放浏览器？
