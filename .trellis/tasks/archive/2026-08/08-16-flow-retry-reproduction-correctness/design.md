# Design: Flow Retry Reproduction Correctness (P0 Follow-up)

## Boundary

本任务只收敛 platform run 的 retry 重现边界。重试的 immutable 输入是已经持久化的原 run 记录及其 `snapshot`，而不是当前 flow revision 或当前 dataset version；retry 请求只预检普通 variables/secrets 的必需名称，enqueue 与重启恢复物化 runner input 时读取当时当前项目值。单 run retry 与 batch failed/canceled retry 必须共用同一个 snapshot clone owner，避免两条路径再次产生不同语义。

本任务依赖已归档的基础 P0 [`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md)，消费其“普通入口只接受 published、retry 可读取 published/superseded”边界，但不重新实现 revision resolver。它也被 batch/recording 任务依赖；batch 不得在自己的 retry 代码中重新解析 revision 或展开 dataset。

不在本任务内改变 revision 发布/审批状态机、dataset schema、ManagedRunner 执行器、secret 加密格式、batch 选择/取消 UI、录制会话或 governance `audit_events` schema。现有的 `platform_run_events` 是 run 详情里的追加式事件流；本任务继续用其中的 `run.retried` 表达逐 run retry 关联。

## Invariants And Clone Contract

### One-to-one rule

对一个状态为 `failed` 或 `canceled` 的源 run，一次成功 retry 必须产生且只产生一条新 run。源 run、源 batch、源事件和源 snapshot 永不更新。源 run 有 dataset 时只复制它的一个 `datasetRow`；没有 dataset 行时仍创建一条 `datasetRow = null` 的新 run，不得因为 revision 的 dataset 配置有多行而扩张基数。

### Snapshot projection

新 snapshot 在去除 retry 运输元数据后，必须与源 snapshot 结构相同。下表是不可变执行投影；实现应深拷贝 JSON，不能重新从资源表拼装：

| 字段 | retry 规则 |
| --- | --- |
| `flowRevisionId` / `flowRevisionChecksum` | 原值原样保留，不重新计算或选择最新 revision |
| `environmentId`、`flow`、`environment`、`elements` | 原快照原样保留；不读取当前环境/元素资源 |
| `dataset` | 原 dataset version 元数据原样保留，可对应已归档版本；不读取 `dataset_versions` 来替换 |
| `datasetRow` | 原来的单行 `{number, data}` 原样保留，或原来的 `null`；不查询/展开其它 `dataset_rows` |
| `upToStepId` | 原值原样保留，包括 `null`；只按源 snapshot 的 flow steps 做完整性校验 |
| `secretNames` | 仅保留既有名称列表；绝不增加解密后的值或变量值 |
| `executor`、`trigger` 及其它执行字段 | 默认原样保留；retry 关系由列和事件表达，不用改写执行语义 |

`batchId`/`batchItemIndex` 是 retry 运输元数据，不属于不可变投影：单 run retry 必须移除源 batch 归属，batch retry 必须覆盖为新 batch 的 id/index。新数据库行的 `id`、`createdBy`、时间、状态、`result`、取消标志和 `dispatch_key` 使用新值；这些变化不改变执行输入。

数据库和 API 关系应满足：

```text
new.revision_id == source.revision_id
new.snapshot.flowRevisionId == source.snapshot.flowRevisionId
new.snapshot.flowRevisionChecksum == source.snapshot.flowRevisionChecksum
new.retry_of_run_id == source.id
count(new runs for source in one successful retry invocation/transaction) == 1
```

`run_by_id`/`run_response` 需要把已有的 `retry_of_run_id` 投影为 nullable `retryOfRunId`，保持响应外层结构和既有授权 snapshot 字段不变，并让运行详情可以直接显示来源；batch summary 已有同名字段，继续复用同一数据库列。一个 source 可以被用户分别 retry 多次，每次成功调用各自产生一条直接 child，不设置全局唯一约束。

### Validation and fail-closed behavior

在任何写入前，服务层 clone validator 应检查：

1. 源 run 属于请求项目，状态为 `failed`/`canceled`，并通过既有 `run.execute` 权限；跨项目仍按 `RUN_NOT_FOUND` 处理。
2. 源 `revision_id` 在同一项目仍存在且状态为 `published` 或 `superseded`。revision 行只用于确认身份和 checksum，不读取其 dataset snapshot；已删除、其它状态或项目不符返回稳定的不可重试错误（推荐 `RUN_SNAPSHOT_NOT_RETRYABLE`），不回退到最新 revision。
3. snapshot 是合法、有限深度的对象；`flowRevisionId`、`flowRevisionChecksum`、`environmentId` 与数据库列及 revision checksum 一致；environment snapshot id 与 `environmentId` 一致；`elements`/flow steps 结构可被现有 runner 使用；`upToStepId` 若非空必须存在于源 snapshot 的 steps。
4. `datasetRow` 只能是 `null` 或包含原 row number 与 object data；不因 dataset version 当前缺失、归档或其余 rows 变化而改写它。
5. `secretNames` 只允许字符串名称；普通变量的必需名称从源 flow snapshot 的模板引用推导。retry 请求在 clone 写入前只使用当前项目资源做名称/配置存在性预检，不解密或物化运行时值，也不在 clone 事务或 snapshot 中持久化 `secret_values`/variable values；预检当下缺少 secret 返回 `RUN_SECRET_NOT_CONFIGURED`，缺少普通变量返回 `RUN_VARIABLE_NOT_CONFIGURED`，均零写入。

必要字段缺失、checksum 不一致或 snapshot 损坏都必须零写入、零 enqueue。对历史 malformed run 不提供“按 revision 猜测”的兼容回退；该 run 可继续查询/取消，但 retry 返回稳定错误。

## Ownership And Data Flow

### Shared service owner

`server-py/autoflow/services.py` 保持一个插入原语，避免 fresh run、single retry 和 batch retry 各自复制 SQL：

- `build_run_snapshot(spec, row, ...)`：现有新建 run 路径把已解析的 published spec 转为 snapshot；普通 dataset 多行行为保持不变。
- `validate_retry_snapshot(source_run)`：只读校验源 revision 身份、snapshot 完整性，并从 immutable flow snapshot 推导、预检普通变量与 secret 的必需名称，返回深拷贝及 retry 元数据；不得调用 `resolve_run_spec`、`dataset_version_for`、`dataset_rows_for`、`secret_values` 或其它运行时取值/解密 API。
- `insert_managed_run(snapshot, ...)`：在调用者已有事务内插入一条 `platform_runs`、一条 `run.queued`，并在 `retry_of_run_id` 非空时再插入一条 `run.retried`。该 helper 不自行 `BEGIN/COMMIT`，也不 enqueue。
- `retry_run_snapshot(...)`：单 run 薄编排，验证源状态后调用 clone + insert，提交后只 enqueue 新 id。
- `retry_run_batch(...)`：筛选终态 failed/canceled child，按原 `batch_item_index` 顺序调用同一 clone helper，在一个 batch 事务内一源一新地插入；不调用 `resolve_run_spec`。

`retry_of_run_id` 必须在 INSERT 时写入，而不是 commit 后再 UPDATE。这样 `platform_runs`、`run.queued` 和 `run.retried` 要么一起提交，要么全部回滚；当前 handler 只给第一条 run 做 post-hoc 关联的缺口由此消失。

### Single retry flow

```text
POST /projects/{project}/runs/{run}/retry
  -> session + run.execute + project/status checks
  -> services.retry_run_snapshot(source_run, actor)
       -> validate source revision/snapshot/variable + secret names
       -> clone immutable snapshot (strip batch metadata)
       -> BEGIN IMMEDIATE
            INSERT platform_runs(retry_of_run_id = source.id)
            append run.queued (IDs/counts only)
            append run.retried { priorRunId, actorId }
          COMMIT
       -> enqueue exactly once after commit
  -> 202 { runIds: [newId], runs: [newRun] }
```

`run.retried` 继续使用 `platform_run_events`，挂在新 run 上，且 `data.priorRunId` 必须等于 `retry_of_run_id`。每个新 run 恰好一条该事件；本任务不新增 governance `audit_events` action。事件、日志和 audit 只记录 id/count/status 等安全摘要，不写 dataset data、snapshot 全文或 secret 明文；既有经项目授权的 run API snapshot 响应保持兼容。

### Batch retry flow

```text
POST /run-batches/{batch}/retry-failed
  -> require terminal source batch; select failed/canceled children
  -> validate every source snapshot before writes
  -> BEGIN IMMEDIATE
       insert new batch(retryOfBatchId = source batch)
       for each source in original item order:
         clone one snapshot with new batchId/itemIndex
         INSERT one child(retry_of_run_id = source.id)
         append run.queued + run.retried for that child
     COMMIT
  -> enqueue each new child in index order
```

The new batch may use dense indexes for the selected children, but their relative source order must remain stable. An idempotency replay returns the already-created batch/runs and must not append duplicate retry events. The original batch aggregate and all original runs remain immutable.

### Runner and runtime values

`managed_runner_input` continues reading flow/environment/elements, dataset row and `upToStepId` from the new snapshot, so no second execution path is introduced. The retry request only preflights the required variable/secret names and writes no runtime values. When the run is enqueued, and again when queued work is materialized during startup recovery, the runner reads the then-current project values. Plaintext is allowed only in that transient in-memory input and must never enter snapshot/DB/API/event/audit/log. A value rotation after preflight is therefore observed by the next materialization. If a required configuration is deleted after preflight, the already-created queued run is retained and materialization fails deterministically with `RUN_VARIABLE_NOT_CONFIGURED` or `RUN_SECRET_NOT_CONFIGURED`; this post-preflight race does not claim transaction-level zero-write rollback. Audit records safe names/status only.

## Compatibility And Migration

- `platform_runs.retry_of_run_id` already exists through the managed-execution migration; verify it on empty and legacy databases with the idempotent migration test. No new table or destructive migration is required.
- Ordinary manual runs, schedules, Webhooks, AgentsPage, dataset multi-row creation and published-only resolver behavior remain unchanged. Only the retry service bypasses revision status filtering, and it accepts a source snapshot only after identity checks.
- Single retry keeps the existing endpoint, capability, terminal-state error and outer response keys (`runIds`, `runs`). The additive `retryOfRunId` field is nullable for historical/fresh runs. Failed/canceled platform UI actions call this endpoint and RunDetail renders one direct-parent link. Success uses a separately labelled fresh-run action whose create payload is `{ flowId: source.snapshot.flow.id, environmentId: source.environmentId }` with no `revisionId`; the ordinary resolver selects the current latest published revision and may expand its current dataset rows. Missing `snapshot.flow.id` or a matching published revision fails closed without falling back to the source revision. Full ancestry UI remains out of scope.
- Existing runs with valid snapshots remain readable. Malformed legacy snapshots fail closed for retry rather than silently changing the executed flow or dataset; this is an explicit compatibility trade-off documented in the error contract. A legacy success run whose snapshot lacks `flow.id` is also not eligible for the latest-revision fresh action and must fail closed rather than pinning its old revision.
- Dataset version updates/archival do not affect a clone because no live dataset rows are read. Variable/secret rotation is intentionally observed at enqueue/restart materialization. A missing required name at request preflight fails before insertion; deletion after preflight leaves the queued row intact and fails during materialization. No runtime value/plaintext is persisted.
- The batch task must consume this helper before exposing batch retry as complete. It must not retain its current `resolve_run_spec`-based retry implementation.

## Security And Observability

- Snapshot cloning copies only data already authorized for the project; project and source-run scope are checked before reading it.
- Secret plaintext is never present in the cloned JSON, database, queued/retried event payload, API response, log, or audit detail. It may exist transiently only inside the in-memory runner input consumed by the execution core. `secret.decrypted_for_run` records names only and remains tied to actual input materialization.
- Emit metrics/logs using source/new ids, revision id, row number and error code only. Do not log `datasetRow.data` or full snapshots.
- A post-commit enqueue failure leaves a recoverable queued run, consistent with existing startup recovery; it must not trigger a second clone or duplicate `run.retried` event.

## Testing Strategy

### Service and persistence

- A failed/canceled no-dataset run creates exactly one clone with equal revision id/checksum, flow/environment/elements and `upToStepId`.
- A source whose dataset version has at least two rows retries only the original row number/data; changing, archiving or deleting the live version/other rows does not change the clone.
- Publishing a newer revision and marking the source revision `superseded` still permits clone; ordinary `queue_published_runs` with that revision remains rejected.
- `retry_of_run_id` is set at INSERT, source row/snapshot/event counts are unchanged, and exactly one `run.retried` event on the new run has matching `priorRunId`.
- Batch retry maps each failed/canceled child one-to-one, preserves relative item order and `retryOfBatchId`, and writes one event per child; success children are not cloned.
- Missing required variables/secrets at request preflight, malformed snapshots, checksum mismatch, deleted revision, invalid status and non-terminal source all produce stable errors with zero new rows/events. A variable/secret deleted after preflight is the explicit exception: the queued run remains and fails at enqueue/restart materialization without writing plaintext.
- Publishing A and then a B with exactly two dataset rows for the same flow/environment makes success(A) fresh create exactly two B-based runs with B checksum/current rows/null lineage, while failed(A) canonical retry still creates exactly one A-based clone with direct-parent lineage. Missing source `snapshot.flow.id` or matching published revision creates zero runs and fails without falling back to A.

### API and cross-layer regression

- Handler tests retain authentication, project isolation, terminal-state checks and response shape; `runs[0].retryOfRunId` exposes the persisted relation.
- Existing schedule/Webhook/AgentsPage/manual/dataset tests remain green; fresh dataset creation still creates one run per row.
- Assert that a rotation after retry preflight is read into the transient runner input at enqueue and after restart recovery; assert that a deletion after preflight leaves the queued row and produces the stable missing-value failure. Snapshots, database rows, event/audit payloads, API bodies and logs must not contain the test value.
- Run a local E2E retry interaction only if the existing fixture can deterministically produce a failed/canceled platform run; no external site or account dependency.

## Rollout And Rollback

1. Land the shared insert/read-model refactor with characterization tests while retry UI remains unchanged.
2. Enable single-run clone endpoint and verify one-to-one lineage, superseded revision behavior and secret redaction in a local database.
3. Switch failed/canceled platform UI actions to canonical retry and expose a direct-parent link; make success fresh-run visibly separate and resolve its current latest published revision from `snapshot.flow.id + environmentId` without pinning the source revision.
4. Switch batch retry to the same helper only after its service tests pass; then enable the existing batch action.

If a defect is found, hide/disable retry actions or return the stable non-retryable error while preserving historical rows. Do not roll back to the old revision/dataset re-expansion path, do not delete clone rows, and do not remove `retry_of_run_id` or event history. Schema rollback is unnecessary; the existing nullable column remains forward-compatible.

## Risky Files And Rollback Points

- `server-py/autoflow/services.py`: snapshot validation, shared INSERT/event primitive and batch integration; isolate commits and protect with service tests first.
- `server-py/autoflow/handler.py`: replace the post-hoc first-run update/event loop with the service call; retain auth/error mapping.
- `server-py/autoflow/migrations.py`: verification only unless an old database proves the existing column is absent; any change must be idempotent and additive.
- `src/platform-api.ts`, `src/RunDetailPage.tsx`, `src/pages/RunsPage.tsx`: add nullable lineage DTO/API support, canonical failed/canceled retry, success fresh-run separation and one direct-parent link; no component-local casts or full ancestry redesign.
- `server-py/tests/unit/` and `tests/`: new lineage/security fixtures; never weaken existing assertions or baseline failures.
