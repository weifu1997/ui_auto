# 下一阶段需求与缺陷规划

## Goal

在稳定性路线图已经落地的基础上，先收敛一个会影响执行正确性的共同前置，再决定“流程批量执行 MVP”和“流程录制 MVP”的边界、顺序与验收口径。这个父任务只负责需求、证据、依赖和跨任务质量门；不直接实现任何产品功能。

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

### 当前共同缺口

- `src/pages/FlowsPage.tsx` 的平台手工运行只发送 `environmentId`；`src/FlowEditorPage.tsx` 的运行到此步骤只发送 `environmentId/upToStepId`。
- `src/platform-api.ts:createPlatformRun` 允许省略 `revisionId`；`server-py/autoflow/services.py:715` 在省略时按项目最近 published revision 查询，没有 `flowId` 约束。
- 因此流程 A/B 交替保存后，手工运行可能执行另一个流程的 revision。这是已由代码路径确认的 correctness 缺口，不是批量功能的假设。
- 当前数据库只有 `platform_runs`，没有 batch 聚合实体；当前 local-picker 是内存、loopback 取向的 click 采集，也没有带平台 session 与 `flow.edit` 能力检查的录制 API。

## Product Intent And Task Boundaries

- 本阶段保持三个任务为 `planning`；匿名模型评测 Prompt 是未来实验材料，不是本轮实现授权。
- 父任务拥有共同目标、依赖图和跨任务验收；两个子任务各自拥有独立、可观察的产品验收标准。
- 子任务之间的依赖写入子任务自身的 PRD/implement 文档，不以目录层级暗示依赖。
- 任何子任务在进入实现前，都需要用户对该子任务最新 planning summary 另行明确批准；本轮不运行 `task.py start`。

## Candidate Roadmap

### P0：流程 revision 选择正确性（已锁定共同前置）

先把手工运行的输入契约收敛为“显式 revision，或由 `projectId + flowId + environmentId` 唯一解析该流程最新 published revision”。显式 revision 与 flow/environment 不一致时必须拒绝，不能静默纠正。

这项工作已经创建为独立 P0 子任务：[`08-15-flow-revision-selection-correctness`](../08-15-flow-revision-selection-correctness/prd.md)。它至少覆盖流程列表运行、编辑器运行到此步骤、显式 revision 的兼容路径，以及 A/B 流程回归。未通过前，batch 和 recording 的“保存后运行”验收均不成立。

### P1：流程批量执行 MVP（候选子任务）

沿用现有 ManagedRunner 的单并发 FIFO，只增加持久 batch 聚合、原子预检/创建、批次查询、取消和失败项重试。2–20 流程、单环境、每流程一条 run、禁止 dataset/`upToStepId`、部分失败继续执行等边界已于 2026-08-16 产品复核确认：预检失败整批拒绝、失败项重试按原 revision 快照、批次列表按创建时间倒序、取消复用现有状态机。

### P1：流程录制 MVP（候选子任务）

复用 Python Playwright/Pick­er 的部署机浏览器能力，新增认证的临时录制会话、事件归并、敏感输入保护、review 和原子草稿导入。起始 URL 同源、登录态快照注入（含「从头录制」选项）与 query/fragment 完全剥离已于 2026-08-16 确认并写入子任务 PRD/design。

### 暂缓项

并行执行/可配置并发、跨项目批次、浏览器 Extension/CDP、多页面录制、自动断言、报告导出和多租户能力不进入本轮候选 MVP。

## Dependency And Risk Contract

```text
revision-selection-correctness (P0)
        ├──> batch-execution-mvp
        └──> recording-mvp (保存/重放验收)
```

- Batch 必须基于已完成的 runs 服务端分页契约；不得重新引入固定 200 条或客户端全量加载。
- Recording 必须沿用现有资源同步和 canonical revision snapshot；确认导入前不能写平台资源。
- 两个子任务都要保持项目隔离、现有单 run/dataset/schedule/webhook/Picker 兼容，并提供回滚点。
- 批量会放大运行产物、事件和通知容量；录制会接触浏览器页面和敏感输入，容量与脱敏是发布阻断风险。

## Planning Acceptance Criteria

- [ ] AC0：父任务文档准确区分已完成基线、当前缺口和候选需求；不把已归档工作重复列为待开发。
- [x] AC1：revision 选择正确性被拆成独立 P0 子任务，列出入口、API 契约、兼容路径、可观察回归和完成门槛。
- [ ] AC2：batch 子任务写明对 P0、分页契约和 ManagedRunner 的依赖，并有原子性、幂等、状态聚合、取消竞态和审计安全的验收标准。
- [ ] AC3：recording 子任务写明对 P0、平台认证、浏览器生命周期、敏感数据和现有保存/重放链路的依赖，并有真实本地 fixture 验收标准。
- [ ] AC4：每个进入实现的子任务都有独立 `prd.md`、复杂任务所需的 `design.md`/`implement.md`，以及真实的 `implement.jsonl`/`check.jsonl` 上下文条目。
- [ ] AC5：在用户批准最新 planning summary 之前，不修改产品代码、不启动任何子任务。

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
- 2026-08-16：录制 URL 一律脱敏为 scheme+host+path，query/fragment 在步骤、review、事件、日志、审计中完全剥离。已写入 recording 子任务 PRD/design。recording 子任务的产品决策已全部收敛。
- 2026-08-16：批次取消的对外表达复用现有单 run 状态机——不新增“取消中”状态，running 子项由 UI 依据现有 `cancellation_requested` 标志呈现提示。已写入 batch 子任务 PRD。
- 2026-08-16：批次列表默认按创建时间倒序，运行中的批次在分页跨页时位置稳定，不按最近子 run 更新时间重排。已写入 batch 子任务 PRD。batch 子任务的产品决策已全部收敛。
- 2026-08-16：无 published revision 的流程在 UI 禁用运行入口并提示“先保存发布”，API 仍强校验 `PUBLISHED_REVISION_REQUIRED`。已写入 P0 子任务 PRD。P0 子任务的产品决策已全部收敛。

## Open Questions

（无——P0、batch、recording 三个子任务的产品决策已于 2026-08-16 全部收敛，见 Decisions Log；进入任一子任务实现前仍需用户单独批准其最终 planning summary。）
