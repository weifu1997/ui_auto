# 运行中心自动加载平台历史

## Goal

修复运行中心首次进入不自动加载服务端历史的问题，让计划任务、Webhook 和其他浏览器创建的运行无需手动刷新即可出现。

## Background

- `src/pages/ProjectShell.tsx:22` 的运行中心路由为 `/project/:id/runs`。
- `src/pages/RunsPage.tsx:62` 只在 pathname 以 `/platform` 结尾时加载和轮询平台运行。
- 手动“刷新状态”会绕过该判断，导致问题容易被本地持久化的 `run-store` 掩盖。

## Requirements

- R3.1 进入 `/runs` 立即加载平台运行；计划任务、Webhook 和其他浏览器创建的运行无需手动刷新即可出现。
- R3.2 仅对非终态运行轮询或订阅，终态历史按需刷新。
- R3.3 保留本地 Worker 运行兼容，明确合并去重规则和来源标识。
- R3.4 补充空缓存、跨浏览器、计划触发、Webhook 触发和手动刷新测试。

## Acceptance Criteria

- [x] 清空浏览器 `autoflow-run-records` 后进入运行中心，仍能看到服务端历史。
- [x] 计划任务/Webhook 新运行在约定刷新周期内自动出现。
- [x] 本地 Worker 运行与平台历史通过 `run.id` 合并，来源沿用 `isWorkerRunId` 标识。
- [x] 非终态平台运行使用 3s 轮询，终态历史使用 15s 慢刷新，页面隐藏时暂停。

## Notes

- 不新增运行中心视觉设计或复杂状态机。
- 不重建 Agent/租约/WebSocket 体系。
