# Design: Automation Edit Capabilities

## Boundary

为计划任务、Webhook 和通知通道增加编辑、Webhook secret 轮换、通知测试，并保留现有加密、单次展示、脱敏和审计规则。

## Backend API

### Schedule

`PUT /api/platform/projects/{project_id}/schedules/{schedule_id}`

- 更新 `name`、`revisionId`、`environmentId`、`datasetVersionId`、`cron`、`timezone`。
- 使用与创建相同的 published revision、environment、dataset、Cron 校验。
- 更新后重算 `next_run_at`，保留 `enabled` 状态。
- 审计 `schedule.updated`，detail 只含引用 ID、Cron、时区。

### Webhook

`PUT /api/platform/projects/{project_id}/webhook-triggers/{trigger_id}`

- 更新 `name`、`revisionId`、`environmentId`、`datasetVersionId`。
- 不暴露现有 signing secret。

`POST /api/platform/projects/{project_id}/webhook-triggers/{trigger_id}/rotate-secret`

- 生成新 `whsec_*`，加密保存，仅在响应中展示一次。
- 审计 `webhook_trigger.secret_rotated`，detail 不含 secret。

### Notification Channel

`PUT /api/platform/workspaces/{workspace_id}/notification-channels/{channel_id}`

- 更新 `name`、`type`、`enabled`。
- `url` 留空表示保留原加密地址；提供新 URL 时重新校验并加密。
- `keyword` 留空表示保留原关键词。
- 审计 `notification_channel.updated`，detail 只含 `name`、`type`、`enabled`。

`POST /api/platform/workspaces/{workspace_id}/notification-channels/{channel_id}/test`

- 使用已保存配置发送测试通知，不写入投递记录。
- 返回 `{ tested: true, status, error }`。
- 审计 `notification_channel.test_sent`，detail 只含状态/错误码。

## Frontend

- `src/platform-api.ts` 增加 update/rotate/test 函数。
- `AutomationsPage` 增加编辑状态与表单复用：
  - 计划任务：编辑按钮、动态 Modal 标题。
  - Webhook：编辑按钮、密钥轮换按钮，新 secret 单次展示。
  - 通知通道：编辑按钮、测试通知按钮，URL 输入框 placeholder“留空保持不变”。
- 创建和编辑共用现有 Form，保存成功统一刷新列表。

## Secret And Audit Safety

- 所有 secret/URL/keyword 继续加密存储。
- API 响应不返回已有 secret；只有创建/轮换时返回一次新 secret。
- 审计 detail 不写入 URL、keyword 或 signing secret。
- 测试通知使用现有通知投递链路，SSRF 与主机白名单规则不变。

## Rollback

- 后端新增端点与方法均可独立回滚。
- 前端保留 create/archive 路径，移除 edit 不影响既有功能。
