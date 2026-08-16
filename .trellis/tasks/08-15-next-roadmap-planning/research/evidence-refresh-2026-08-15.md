# 需求规划证据刷新（2026-08-15）

## 本轮范围

本轮只刷新需求和依赖，不修改产品代码、不运行 `task.py start`，也不把匿名评测 Prompt 视为实现授权。三个活动任务仍保持 `planning`。

## 已确认的当前基线

- 当前 `HEAD` 为 `191e46d`；工作区只有三个活动任务草案和评测 Prompt 未跟踪，产品代码没有本轮改动。
- 稳定性路线图中的前置工作已经在历史提交中落地并归档：
  - Python 环境入口与迁移收尾：`a937e83`；
  - 生产同步 outbox 与重试：`ec311ab`；
  - canonical revision snapshot：`400bac0`；
  - 运行中心首次加载：`531cf03`；
  - 运行/投递服务端分页：`4d96115`；
  - 自动化配置编辑与 secret 轮换：`954b7d0`；
  - 前端 chunk/bundle 预算：`3249922`。
- 本轮只读验证结果：`npm run build`、`npm run lint`、`npm run test:unit`（9 个文件、30 个测试）和 `npm run test:py`（68 个测试）通过。E2E/Windows 门禁未在本轮运行，不把它们标记为通过。

## 仍然真实存在、且会影响新需求的缺口

### 单流程 revision 选择正确性

- `src/pages/FlowsPage.tsx` 的平台手工运行只发送 `environmentId`；`src/FlowEditorPage.tsx` 的运行到此步骤也只发送 `environmentId/upToStepId`。
- `src/platform-api.ts:createPlatformRun` 允许省略 `revisionId`；`server-py/autoflow/services.py:715` 的 `published_revision_for` 在省略时按项目最近 published revision 查询，没有 `flowId` 约束。
- 因此两个流程交替保存后，手工运行可能拿到另一个流程的 revision。这个缺口是批量执行的硬前置，也会污染录制后的保存/重放验收。
- 显式 `revisionId` 的计划任务、Webhook、AgentsPage 和 RunDetail retry 路径已有独立契约；修复时必须保持兼容并校验 flow/revision/environment 一致性。

### 批量执行尚未有持久边界

- 当前 schema 只有 `platform_runs`，没有 batch 表或 child-run 关联；ManagedRunner 仍是单 active、FIFO 队列。
- 当前 runs API 已有服务端分页，因此 batch 列表/详情应在此契约上增量扩展，不能回到一次加载固定上限。

### 录制尚未有平台认证链路

- 现有 `server-py/autoflow/worker.py` 的 local-picker 会话是内存对象，旧 `/api/projects/{project}/local-picker/*` 路由只做 project 字符串校验，适合 loopback Picker，不是带平台 session/能力检查的远程录制 API。
- `server-py/autoflow/picker.py` 当前只处理一次 click，role 候选不含 accessible name，注入脚本也不是跨完整导航的 recorder 事件流。
- `src/flow-store.ts` 只有逐项编辑 action，没有录制结果的原子导入 action；元素草稿需在确认后再进入 workspace 同步。

## 已确认依赖

```text
next-roadmap-planning
        |
        +--> flow-revision-selection-correctness (已锁定 P0 prerequisite)
        |          |
        |          +--> flow-batch-execution-mvp
        |          +--> flow-recording-mvp (save/replay gate)
        |
        +--> existing stability work (completed; regression only)
```

子任务之间的依赖必须写进各自 PRD/implement 文档；父任务不直接授权实现。

## 尚未替用户决定的产品问题

1. **已确认**：先单独锁定并验收 revision 选择正确性；已创建 `08-15-flow-revision-selection-correctness`，batch/recording 都以其完成为硬前置。
2. P0：单 run retry 在原 revision superseded 后按原快照还是最新 published revision 重试。
3. 批量：某个流程在所选环境没有 published revision 时，是否整批拒绝（当前草案推荐整批拒绝）以及是否允许用户改环境后重新预检。
4. 录制：是否复用同项目/环境已有 Picker 的登录态、是否强制同源起始 URL、记录 URL 时是否剥离 query/fragment（当前草案尚未形成最终产品口径）。
