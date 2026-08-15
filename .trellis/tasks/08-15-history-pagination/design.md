# Design: Run And Delivery Pagination

## Boundary

只改运行列表和通知投递列表的分页/筛选契约，不改变运行/投递数据模型。旧响应字段继续保留。

## Backend Contracts

### Runs

`GET /api/platform/projects/{project_id}/runs` 新增查询参数：

- `page`：1-based，默认 1
- `pageSize`：默认 20，上限 100
- `status`：精确匹配
- `flow`：按 `json_extract(snapshot, '$.flow.name') LIKE` 模糊匹配
- `source`：`manual` / `schedule` / `webhook`
- `from` / `to`：ISO 时间范围，按 `created_at` 过滤

响应：

```json
{ "runs": [], "total": 0, "page": 1, "pageSize": 20 }
```

`source` 通过 `created_by LIKE 'schedule:%'`、`created_by LIKE 'webhook:%'` 推导；其余为 manual。

### Deliveries

`GET /api/platform/projects/{project_id}/deliveries` 新增查询参数：

- `page`
- `pageSize`
- `status`
- `channel`：按 channel name 精确匹配
- `from` / `to`：按 `created_at` 过滤

响应：

```json
{ "deliveries": [], "total": 0, "page": 1, "pageSize": 20 }
```

## Frontend

### RunsPage

- 平台运行改为服务端分页，Worker 运行继续来自 `run-store` 并合并到当前页顶部。
- URL 保留 `page`、`status`、`flow`、`source`、`from`、`to`。
- 筛选或翻页时 `navigate` 更新 query；`useLocation` 初始化 query。
- 有非终态平台运行仍按现有 3s/15s 策略轮询当前页。

### AutomationsPage Delivery Section

- 投递记录改为服务端分页和筛选。
- URL 保留 `deliveryPage`、`deliveryStatus`、`deliveryChannel`、`deliveryFrom`、`deliveryTo`。
- 表格使用服务端 `total`，翻页/筛选只请求当前页。

## Compatibility

- API 继续返回 `runs` / `deliveries` 数组，旧调用方不破坏。
- 无参数时默认分页，不等同于旧 200 条全量。
- 本地 Worker 运行仍可在运行中心显示，不作为服务端分页计数。

## Rollback

- 服务端查询逻辑和前端 URL query 可独立回滚。
- 不删除运行/投递数据。
