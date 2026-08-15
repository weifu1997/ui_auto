# Design: Canonical Version Snapshots

## Boundary

revision 的展示/瞬态字段变化不得改变 checksum；真实执行字段变化必须生成新 revision。不改写历史 revision，不删除旧快照。

## Canonical Snapshot Contract

### Flow

执行语义字段：

- `id`
- `steps`：保持用户定义的执行顺序
- `variables`：非 secret 项目/环境变量引用到值的映射
- `secretNames`：按名称排序

排除 `updatedAt`、`lastStatus`、`tags`、`steps` 计数等展示/派生字段。

每个 step 保留：

- `id`
- `action`
- `element`
- `value`
- `timeout`
- `failurePolicy`
- `output` / `outputSource` / `outputAttribute` / `outputParameter`
- `responseUrl` / `outputPath` / `outputPublic`

排除 `status` 等运行展示状态。
`title` 也按展示字段处理，不参与 checksum。

### Environment

保留执行与运行所需字段：

- `id`
- `baseUrl`
- `browser`
- `auth`
- `timeout`
- `testIdAttribute`
- `keepBrowserOpenOnFailure`
- `headless`

排除 `updatedAt`、`color`、`description`。

### Elements

保留执行定位所需字段：

- `id`
- `name`
- `path`
- `method`
- `value`
- `environment`

排除 `validation`、`updatedAt`、`description`、`requiresLogin`。数组按 `id + name` 排序，避免列表顺序变化制造 checksum 差异。

### Dataset

保留执行引用的 `datasetId`、`versionId`、`versionNumber`、`checksum`、`columns`、`rowCount`。columns 排序后参与 checksum。

## Backend Canonicalizer

新增 `server-py/autoflow/revision_snapshot.py`：

- `canonical_flow` / `canonical_step` / `canonical_environment` / `canonical_elements` / `canonical_dataset`
- `canonical_checksum(...)` 使用 `sha256(canonical_json(snapshot))`
- `canonical_json` 使用 `json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))`

`handler.py` 创建 revision 时改用 canonical checksum，同时保留原有 full snapshot 用于运行详情展示和历史兼容。

## Frontend Payload Builder

新增 `src/revision-snapshot.ts`，让 `ServerWorkspaceSynchronizer` 发送的 flow/environment/elements 不再携带 `updatedAt`、`validation`、步骤 `status` 等字段。

- flow 保留 `name`、`description` 作为展示元数据，但由后端 canonicalizer 排除在 checksum 外。
- environment 保留 `name` 作为展示元数据。
- elements 按稳定顺序发送。

## Compatibility

- 旧 revision 继续可执行，不批量重写。
- 新 checksum 只影响后续创建/去重。
- 计划任务/Webhook 绑定的是 revision id，不因资源 round-trip 变化而失效。

## Rollback

- 回滚 `handler.py` 的 checksum 计算即可恢复旧行为。
- 新 canonical 模块可独立移除，不涉及数据迁移。
