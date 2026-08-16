# Design: Flow Revision Selection Correctness (P0)

## Boundary

统一服务层 revision 解析契约，并把手工平台运行入口补足 `flowId`。resolver 是唯一负责 SQL/一致性校验的边界；handler 只负责认证、输入映射和错误响应；前端只发送已知 flow/environment 上下文。

本设计不增加 revision 表，不修改 revision snapshot 内容，不引入 batch/recording 代码。

## Resolution Matrix

| 请求上下文 | 允许行为 | 失败行为 |
| --- | --- | --- |
| `revisionId + flowId + environmentId` | 查询项目内 published revision，校验三者一致 | `REVISION_FLOW_MISMATCH` 或 `REVISION_ENVIRONMENT_MISMATCH` |
| `revisionId + environmentId`（schedule/Webhook 等显式路径） | 保持现有显式 revision 兼容，校验环境 | revision 不存在/非可执行或环境不符 |
| `flowId + environmentId`、无 `revisionId` | 查询该项目/流程/环境最新 published revision | 无匹配时返回 flow-scoped published-revision 错误 |
| 仅 `environmentId`、无 `revisionId/flowId` | 不再猜测 | `FLOW_ID_REQUIRED` |
| 单 run 重试（携带原 run 的 `revisionId`） | 加载原 revision 快照，接受 `published` 或 `superseded` 状态（2026-08-16 已确认） | revision 行被删除等极端情况按现有不可重试错误处理 |

“最新”只在同一 `(project_id, flow_id, environment_id)` 内按 published 时间/稳定 tie-breaker 定义；不使用项目级排序兜底。

## Data Flow

```text
FlowsPage / FlowEditorPage
  -> createPlatformRun({ flowId, environmentId, upToStepId? })
  -> authenticated /runs handler
  -> resolve published revision (single service owner)
  -> validate flow/revision/environment + step boundary
  -> existing queue_published_runs snapshot/runner path
  -> run snapshot records resolved revision + flow id
```

Automation routes and explicit retry paths continue entering the same resolver with `revisionId`; they do not depend on the manual flow-scoped fallback.

## Compatibility Notes

- `flow_revisions.flow_id` and `environment_id` already exist；migration version 10 会回填 legacy rows。除非测试证明旧库空字段仍需安全修复，P0 不预期新增 migration。
- Existing API response shape (`run`, `runs`, `runIds`) remains unchanged.
- TypeScript input adds optional `flowId`; explicit `revisionId` remains optional at the shared function boundary so automation callers compile.
- Local Worker routes are untouched.
- Superseded revision retry semantics decided 2026-08-16：重试按原 revision 快照执行，resolver 对重试入口接受 `published`/`superseded`，其余入口仍只接受 `published`。

## Error And Security Contract

- Error codes must identify missing flow context, flow/revision mismatch, environment mismatch, and no matching published revision separately enough for UI and tests.
- Cross-project ids resolve as not found/forbidden without revealing another project’s revision metadata.
- Responses, audit details, and logs contain IDs/counts only; no snapshot or secret values are added.

## Rollout / Rollback

1. Ship resolver and API regression tests with the manual UI payload change.
2. Verify explicit revision automation paths before enabling the new manual flow-scoped path.
3. If rollback is needed, revert only the manual payload/UI gate while retaining resolver tests; do not rewrite historical revisions or runs.
