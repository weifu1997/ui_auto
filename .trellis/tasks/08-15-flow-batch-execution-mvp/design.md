# Design: Flow Batch Execution MVP

## Boundary

批量执行在现有 `platform_runs` 和 ManagedRunner 上增加持久 batch 聚合层。每个子任务仍是完整、独立的 platform run，沿用现有执行快照、事件、产物、取消、通知和详情链路。Batch 负责用户意图、幂等、顺序、汇总、取消编排和失败项重试，不成为第二套执行器。

## Data Flow

```text
FlowsPage row selection
  -> POST run-batches with flowIds/environment/clientRequestId
  -> authenticate + run.execute
  -> resolve latest published revision for each flow/environment
  -> preflight all items and limits
  -> BEGIN IMMEDIATE
       insert run_batches
       insert one platform_run per flow with batch_id/item_index
       append run.queued events
     COMMIT
  -> enqueue each run in item_index order
  -> existing ManagedRunner executes one at a time
  -> existing run callbacks update child status
  -> batch query derives aggregate status/counts
  -> RunsPage polls non-terminal batches and opens existing run detail
```

## Schema Migration

### `run_batches`

```sql
CREATE TABLE IF NOT EXISTS run_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  retry_of_batch_id TEXT,
  requested_flow_ids TEXT NOT NULL,
  cancellation_requested INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(retry_of_batch_id) REFERENCES run_batches(id),
  UNIQUE(project_id, client_request_id)
);
```

### `platform_runs`

增加：

```sql
batch_id TEXT NULL
batch_item_index INTEGER NULL
retry_of_run_id TEXT NULL  -- 若现有迁移尚未提供则补齐
```

并建立：

```sql
CREATE UNIQUE INDEX ... ON platform_runs(batch_id, batch_item_index)
  WHERE batch_id IS NOT NULL;
CREATE INDEX ... ON platform_runs(batch_id, status);
```

SQLite migration 必须可重复执行，并在已有数据库上保留所有 run、event、output 和 artifact 关联。Batch 删除不级联删除 run；正常产品流程不提供 batch 删除接口。

## Revision Resolution Fix

扩展服务层 revision resolver：

```text
published_revision_for(project_id, revision_id=None, flow_id=None, environment_id=None)
```

规则：

1. 有 revisionId 时查询 project 内 published revision，并校验 flowId/environmentId（若提供）。
2. 无 revisionId 时 flowId 必填，查询 `project_id + flow_id + environment_id + published` 的最新 revision。
3. 不允许退回项目级“最新任意 revision”。
4. 单运行 API 兼容显式 revisionId；手工 UI 改为至少传 flowId。

Revision resolver 和 snapshot validation 只有一个服务层 owner，单运行、batch、重试、schedule/webhook 不各自复制 SQL。

## API Contracts

所有批次端点要求平台 session。GET 使用项目可见权限；创建、取消和重试要求 `run.execute`。

### Create Batch

`POST /api/platform/projects/{project_id}/run-batches`

```json
{
  "flowIds": ["flow-a", "flow-b"],
  "environmentId": "env-1",
  "clientRequestId": "uuid-v4"
}
```

成功 `202`：

```json
{
  "batch": {
    "id": "batch-...",
    "projectId": "...",
    "environmentId": "env-1",
    "status": "queued",
    "counts": {
      "total": 2,
      "completed": 0,
      "queued": 2,
      "running": 0,
      "success": 0,
      "failed": 0,
      "canceled": 0
    },
    "retryOfBatchId": null,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "runs": []
}
```

相同 project/clientRequestId 的请求：

- payload 等价时返回原批次，`200` 或 `202` 均可，但同一实现必须固定并测试。
- payload 不一致时返回 `409 IDEMPOTENCY_KEY_REUSED`。
- 并发请求由数据库 UNIQUE 约束收口，捕获冲突后重新读取并比较 payload。

预检错误返回结构应能定位到 flow：

```json
{
  "error": "BATCH_PREFLIGHT_FAILED",
  "items": [{ "flowId": "flow-b", "code": "PUBLISHED_REVISION_REQUIRED" }]
}
```

### List And Detail

- `GET /api/platform/projects/{project_id}/run-batches?page=1&pageSize=20&status=running`
- `GET /api/platform/projects/{project_id}/run-batches/{batch_id}`

列表返回 `{ batches, total, page, pageSize }`。详情返回 `{ batch, runs }`，runs 按 `batch_item_index ASC`。批次列表不把所有执行 snapshot 嵌入响应。

### Cancel

`POST /api/platform/projects/{project_id}/run-batches/{batch_id}/cancel`

事务中设置 batch cancellation flag，并对所有非终态子 run 设置取消；提交后逐项调用 `cancel_managed_run`。响应 `202 { batch, runs }`。重复调用返回当前状态，不追加重复 run event。

### Retry Failed Items

`POST /api/platform/projects/{project_id}/run-batches/{batch_id}/retry-failed`

```json
{ "clientRequestId": "new-uuid-v4" }
```

服务端要求原 batch 终态，提取 failed/canceled 项的 flow id，使用原 environmentId 和当前最新 published revision，走与 create 完全相同的 preflight/transaction helper，设置 `retry_of_batch_id`。

## Batch Aggregation

批次状态不作为可漂移的第二事实源。查询时使用单个 GROUP BY/条件聚合，从 `platform_runs.status` 得出 counts 和 status。需要筛选批次状态时，可使用 CTE 或汇总子查询，不在 Python 拉全量后过滤。

`completed = success + failed + canceled`。状态优先级：

1. 所有 queued -> queued。
2. 存在 running，或存在 queued 且已有终态 -> running。
3. 全 success -> success。
4. 全 canceled -> canceled。
5. 全终态且 success > 0 且 failed + canceled > 0 -> partial_failed。
6. 全终态且 success = 0 且 failed > 0 -> failed。

理论上出现未知状态时返回服务端错误并记录，不把它默认为 success。

## Atomic Creation And Preflight

服务层拆分为：

- `resolve_run_spec(...)`：解析 revision、environment、steps、required secrets 和执行 snapshot，不写数据库、不解密 secret。
- `insert_run_from_spec(...)`：在调用者已有事务内插入一条 run 和 queued event，不自行 begin/commit/enqueue。
- `queue_published_runs(...)`：现有单运行薄封装，兼容 dataset 多行。
- `create_run_batch(...)`：验证 flowIds/limits，解析全部 spec，单事务插入 batch/runs，提交后按 index enqueue。

Preflight 只检查 secret 是否存在，不读取 secret 值。执行时仍沿用现有按 run 解密链路。Batch 和 audit 中不保存 secret 名单以外的敏感信息。

## Cancellation Races

数据库状态是权威：

- queued run 使用条件 UPDATE `WHERE status = 'queued'` 进入 canceled。
- running run 只设置 `cancellation_requested = 1`，由 runner callback 写最终 canceled/failed；若已在竞态中 success，条件更新不得覆盖 success。
- enqueue/cancel 都已具备 item id 去重；批次代码不可直接操作 ManagedRunner 私有 `_items`。
- 每个 run 只写一次 `run.cancel_requested` 事件，可通过条件更新结果决定是否追加。

## Frontend Design

### FlowsPage

- Ant Design Table 增加 `rowSelection`，只选择过滤后可见不是限制，跨分页选择是否保留按现有 8 条客户端分页处理；MVP flow 数量仍来自项目 store。
- 批量操作区显示已选数量，按钮使用播放图标和“批量运行”文本命令。
- 确认 Modal 显示环境、流程清单、总步骤、串行提示和通知提示。
- 用户点击确认时才生成 clientRequestId；请求失败可用同一 key 重试，用户关闭后重新发起才生成新 key。

### RunsPage

- 基于服务端历史分页任务的 query/轮询模式增加 batches query。
- 批次使用可展开行或独立 batch section，不把 batch 做成嵌套卡片。
- 展开项链接到既有 `/runs/{runId}` 详情。
- 只有 batch/run 非终态时轮询；取消和 retry 成功后失效对应 query。

## Audit And Notification

- Batch audit target_type 固定 `run_batch`，target_id 使用真实 batch id，不再借用第一条 run id。
- `run_batch.created` detail：flowIds、runIds、environmentId、counts、retryOfBatchId。
- `run_batch.cancel_requested`：受影响的 queued/running 数量。
- `run_batch.retried`：sourceBatchId/newBatchId/retriedFlowIds。
- 现有每 run 终态通知保持不变；不为 batch 重复发送额外通知。

## Compatibility And Rollout

- 单 run POST 响应继续提供 `run`、`runs` 和 `runIds`。
- platform_runs 新字段可空，历史 run 自动视为 unbatched。
- 前端先部署后端 migration/API，再显示批量入口；旧前端不受新表和 nullable 字段影响。
- Rollback 前先隐藏批量入口。可以停止写新 batch，但保留表和关联列，避免丢失审计关系；不要通过 down migration 删除历史 batch/run。

## Testing Strategy

- Migration：空库、已有 run 库、重复启动 migration、索引唯一性和历史 run 可读。
- Revision regression：A/B 两流程各自运行正确 revision，flow/revision/environment mismatch。
- Service：全量 preflight、事务回滚、幂等并发、顺序、limits、聚合状态、取消竞态、retry latest revision。
- Recovery：提交后未 enqueue 的 queued runs 在服务启动时全部恢复，batch aggregate 正确。
- React/Vitest：选择、确认、稳定 idempotency key、错误定位、取消/retry 和刷新恢复。
- Playwright：选择多个流程、串行执行、一个失败后继续、部分失败、retry failed、刷新后 batch 仍可见。
