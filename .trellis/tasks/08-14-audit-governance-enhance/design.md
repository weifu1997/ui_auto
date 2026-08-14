# 审计与治理增强 — 设计

## 架构与边界

改动横跨 server 审计/通知/运行三条链路与治理 API，以及前端治理页。**无数据库 schema 变更**（audit_events 与 platform_runs 表结构不变），全部为新增埋点、接口参数与前端面板，向后兼容、可独立回滚。

```
[埋点] platform-handler.ts (auth) ─┐
[埋点] platform.ts (通知投递/运行结束/密钥解密) ─┤→ audit_events（既有表）
                                                 ↓
GET /audit-events?page&pageSize&action&actor&from&to&q → 治理页「审计日志」面板
GET /analytics?window&from&to&period → 治理页指标卡/趋势/环比
```

## 数据流与契约

### R1 审计埋点（写侧）

| 需求 | 位置 | 事件 action | detail 要点 |
|---|---|---|---|
| R1.1 认证 | `platform-handler.ts:83/109/123`（register/login/logout） | `auth.registered` / `auth.login_succeeded` / `auth.logout` / `auth.login_failed` | 登录相关含 `ip: request.socket.remoteAddress`（复用 :1188 已有采集方式）；失败事件 detail 含 reason，不记密码任何形态 |
| R1.2 通知投递 | `platform.ts` postNotification 投递循环（~:924-947，含当前任务新增的 `NOTIFICATION_REJECTED_<code>` 判定点） | `notification.delivered` / `notification.rejected` / `notification.failed` | `channelType`、`channelName`、`code`、`error`；**不含** URL、keyword、密钥明文 |
| R1.3 运行结束 | `platform.ts:769`（requestedStatus 收敛点）与 `:851`（canceled 路径） | `run.completed` / `run.failed` / `run.canceled` | failed 时附 `errorCode`（取事件 data.code）与 `stepId`；actor 为 system |
| R1.4 敏感操作 | `platform.ts:688`（运行 payload 密钥解密） | `secret.decrypted_for_run` | 仅记 secret **名称列表**，绝不记明文；通知配置查看（`platform.ts:924` 解密处）记 `notification_channel.config_read`（仅通道名与类型） |

审计写入统一复用 `createAuditWriter`（`server/platform-audit.ts`），不新建表。

### R2 审计查询（读侧契约）

`GET /api/platform/projects/:id/audit-events`（现 `platform-handler.ts:718`）扩展查询参数，全部可选、缺省行为不变（无参 = 现有逻辑兜底）：

- `page` / `pageSize`（默认 1/20，pageSize 上限 100）
- `action`（前缀匹配，如 `auth.`、`run.`、`notification.`）
- `actorId` / `actorType`
- `from` / `to`（ISO 时间，作用 `created_at`）
- `q`（关键字，LIKE 匹配 `action` / `target_type` / `target_id` / `detail` 任一）

响应改为 `{ events, total, page, pageSize }`（total 为过滤后总数，供分页）。前端 `getPlatformAuditEvents`（`src/platform-api.ts:637`）签名同步扩展，`PlatformAuditEvent` 类型加可选 `detail` 结构化解析。

治理页新增「审计日志」面板（独立于现有「发布审计」）：AntD Table + 服务端分页 + 筛选区（事件类型 Select、操作者 Input、时间 RangePicker、搜索 Input）+ `expandable` 行展开渲染 detail，脱敏规则：键名匹配 `/secret|url|token|password|keyword|signature|credential/i` 的值一律显示 `******`。

### R3 指标（读侧契约）

`GET /api/platform/projects/:id/analytics`（`projectAnalytics`，`platform.ts:990`）扩展：

- `window`：`7|14|30`（默认 30，作用于 created_at 过滤）或 `limit`（最近 N 次运行，替代固定 500）
- `from` / `to`：自定义日期范围（优先级高于 window）
- `period`：`day|week`（默认 day；week 按 ISO 周分组）

响应新增（原字段保持）：
- `previous`：上一窗口的 `summary`（环比数据源），计算方式：时间窗口取同长度前一区间；`limit` 模式取其后一段 N 条
- `runDurations`：每日/周平均运行时长（`platform_run_events` 首事件到 `run.completed`/`run.failed` 时间差，无事件则跳过）
- `scheduleHealth`：`{ triggered, skipped, successRate }`，聚合审计 `schedule.triggered` / `schedule.skipped`（同项目、同窗口）
- `failureCategories` 扩展为 `{ category, count, dimension }`：维度 `message|code|step`，`failureCategory()`（~:1012 使用处）优先取事件 data 中的 `code`（如 `NOTIFICATION_*`、`TIMEOUT`），其次 message 现有逻辑；按维度聚合由查询参数 `categoryBy=message|code|step` 控制，默认 message 兼容现状

前端治理页：指标卡加窗口 Select（7/14/30/自定义）+ 环比徽标（`+12%` / `-3%`，对比 `previous.summary.successRate`）；趋势面板加日/周切换；失败归类面板加维度切换；新增「运行时长」「调度健康度」面板。

## 兼容性与迁移

- 无表结构变更、无迁移；`audit_events` 仅新增行。
- 查询参数与响应字段均为增量：老前端不带参仍可用（服务端缺省兜底）；新前端在旧服务端上只会缺失新面板（部署时前后端同发，风险可控）。
- 认证失败审计注意：`login` 失败路径（`platform-handler.ts:109` 分支）当前无埋点，需在 401 返回处补；不记录任何凭据信息。
- 通知投递审计依赖当前任务 `08-14-fix-webhook-migration-notifications` 的 `NOTIFICATION_REJECTED_<code>` 判定（`platform.ts:943`）；若该任务未合入，投递审计按现有 `NOTIFICATION_DELIVERY_FAILED` 兜底记录，不阻塞。

## 重要取舍

- **敏感字段只记名称不记值**：审计是"谁在何时做了什么"，不是数据仓库；密钥/URL/凭据明文不进 audit_events。
- **失败归类兼容优先**：`failureCategory` 增加 code 优先分支，message 逻辑保留，避免历史数据归类跳变。
- **调度健康度用审计聚合而非新表**：复用 schedule.triggered/skipped 事件，零 schema 成本；代价是审计被清理时指标会随之衰减（当前无清理策略，可接受）。
- **运行时长用事件时间差**：不新增 ended_at 列，避免迁移；无 step/结束事件的运行不计入时长。

## 回滚

- 每项均为独立提交：埋点（R1）→ API 参数（R2/R3 查询）→ 前端面板（R2/R3 UI）。
- 回滚顺序：前端面板 → 查询参数 → 埋点；任一阶段回滚不影响其余功能。
- 埋点回滚仅停止写新事件，历史数据与现有界面不受影响。
