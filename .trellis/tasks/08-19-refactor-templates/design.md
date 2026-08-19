# 重构公共模板 — 技术设计

## 架构与边界

### 后端（server-py/autoflow）

**新增端点（handler.py）**

1. `POST /api/platform/templates/{template_id}/re-publish`（R4）
   - 入参：`{ revisionId }`（必须为 source_project 的已发布版本）
   - 行为：从 `flow_revisions` 重新冻结 snapshot，覆盖 `internal_templates.snapshot` 与 `source_revision_id`，更新 `updated_at`
   - 权限：`require_workspace_role(workspace_id, user.id, True)`（创建者或 admin）
   - 审计：`template.republished`

2. `GET /api/platform/templates/{template_id}/apply-candidates?projectId={projectId}`（R3）
   - 返回目标项目可映射的 elements 列表（id, name, selector, method）
   - 权限：`require_project_capability(projectId, user.id, "flow.edit")`
   - 用途：前端元素映射表展示"目标项目已有元素"下拉

3. `POST /api/platform/templates/{template_id}/apply`（扩展，R1/R2/R3/R5）
   - 入参扩展：
     ```json
     {
       "projectId": "...",
       "selection": {
         "flow": true,
         "elements": ["elem-id-1", "elem-id-2"],
         "variables": ["var-id-1"],
         "environments": false
       },
       "elementMappings": {
         "template-elem-id-1": "target-project-elem-id-1",
         "template-elem-id-2": null
       }
     }
     ```
   - 行为扩展：
     - 仅对 `selection` 内勾选的资源做克隆（勾选 flow 会触发依赖闭包，见下）
     - `selection` 只表达"要引入哪些资源"；`elementMappings` 表达其中哪些元素复用目标项目已有元素——被映射的元素从"待创建集合"中剔除，跳过创建；未映射（或值为 null）的元素按 D3 冲突策略创建新元素
     - 检测同名资源，按 D3 自动加后缀（`_2`、`_3`...直到唯一）；同名判定按资源的去重维度进行（变量 `scope+name`，元素 `environment+name`）
     - `snapshot.flow.secretNames` 中的密钥引用名，自动在目标项目 `project_secrets` 创建空密钥记录（value="" 占位，待用户填值；`ON CONFLICT(project_id, name) DO NOTHING`）
     - 返回 `conflicts` 报告：`{ resourceType, originalName, newName }[]`；空密钥创建失败记入 `conflicts.warnings`
   - `rewrite_template_references` 需扩展支持部分子集：只重写 `selection` 内资源的 ID 引用
   - **依赖闭包（D6）**：勾选 flow 时，后端自动补入该 flow 引用的 elements/variables（`step.element`/`step.elementId` 引用的元素、`{{project.x}}`/`{{env.x}}` 引用的变量）；apply 前校验闭包内依赖齐全，缺失直接 400 报错，绝不生成悬空引用
   - 权限：`require_project_capability(projectId, user.id, "flow.edit")`
   - 审计：`template.applied`（含 `selection`、`elementMappings`、`conflicts`）

**密钥引用（无需扩展 snapshot，D7）**

密钥引用在发布时已完整冻结进快照，**不新增任何字段**：

- `flow_revisions.flow_snapshot` 已含 `secretNames`（见 handler.py:3864 `flow_snapshot = {**flow, "secretNames": secret_names}`），由前端 `requiredSecretVariables`（shared.tsx:489-496）按 `variable.secret` 标记 + step 内 `{{project.<name>}}`/`{{env.<name>}}` 占位符生成。
- 密钥实际存储于 `project_secrets` 表，按引用名 `project.<name>`/`env.<name>` 键控（services.py:126-137 `UNIQUE(project_id, name)`、services.py:890-933）。
- 应用时读取 `snapshot.flow.secretNames`，对每个引用名调 `services.encrypt("")` 在目标项目 `project_secrets` 建空记录（`ON CONFLICT(project_id, name) DO NOTHING`），值待用户填。
- 历史 snapshot 无 `secretNames`（或为空）时，跳过空密钥创建（缺省即兼容）。

**冲突检测查询（R2）**

应用前对 `selection` 内每类资源查询目标项目 `project_resources` 表中同名记录（SQLite 用 `json_extract`，不支持 `->>'...'` 语法）：

```sql
SELECT resource_id,
       json_extract(data, '$.name') AS name,
       json_extract(data, '$.scope') AS scope,
       json_extract(data, '$.environment') AS environment
FROM project_resources
WHERE project_id = ? AND resource_type = ? AND archived_at IS NULL
  AND json_extract(data, '$.name') IN (?, ?, ...)
```

- 同名判定须带上资源的去重维度：变量按 `scope+name`（`uniqueVariableNameValidator` 允许不同 scope 同名，见 shared.tsx:434-448），元素按 `environment+name`（元素按 environment 区分，见 ServerWorkspaceSynchronizer.tsx:394-396）。
- 检测同名后，按 D3 给新资源 name 加后缀（`_2`、`_3`...），同时记录到 `conflicts` 报告；变量重命名须同步重写其派生的 `secretNames` 引用与流程内的 `{{...}}` 占位符（见 D7）。

### 前端（src）

**TemplatesPage.tsx 应用 Drawer 重构**

Drawer 分三段：
1. **快照预览段（R1 + D6）**：折叠面板，分别展示 flow steps / elements / variables 列表。每行带 Checkbox（默认全选），勾选状态驱动后段映射表。
2. **元素映射表段（R3 + D5）**：仅展示勾选的 elements，每行一个映射下拉，选项来自 `GET /apply-candidates`。默认值为"创建新元素"，用户可选目标项目已有元素映射。
3. **应用段**：目标项目选择 + "应用模板"按钮。应用后展示 `conflicts` 报告（Alert 组件），并提供"前往流程编辑器校验元素"跳转。

**模板卡片"有新版本可更新"提示（R4）**

列表加载时，对每个模板，前端调用 `GET /api/platform/projects/{sourceProjectId}/revisions?status=published` 取最新已发布版本 ID，与 `template.sourceRevisionId` 比对。落后则在卡片角标显示"有新版本"，点击触发 re-publish Modal（选择新已发布版本）。

> 注：为避免列表 N+1 查询，可加批量端点 `GET /api/platform/templates/refresh-status?ids=...` 返回每个模板的 latest revisionId。MVP 可先做 N+1，性能优化放后续。

**platform-api.ts 新增封装**

- `rePublishPlatformTemplate(token, templateId, revisionId)`
- `getTemplateApplyCandidates(token, templateId, projectId)`
- `applyPlatformTemplate` 扩展入参支持 `selection` + `elementMappings`
- `getPlatformTemplate` 返回的 `snapshot` 字段前端可直接读取展示（已有）

## 数据流与契约

```
发布流程（已有，无需改动）
  flow_revisions(published) → 冻结 snapshot{flow(含 secretNames),environments,elements,variables} → internal_templates.snapshot

应用流程（重构后）
  1. 用户打开模板 Drawer → 前端读 template.snapshot 展示预览
  2. 用户勾选资源子集 → 前端调 GET /apply-candidates 拉目标项目可映射元素
  3. 用户配置元素映射 → 前端收集 selection + elementMappings
  4. 前端 POST /apply {projectId, selection, elementMappings}
  5. 后端：依赖闭包校验 → 冲突检测 → 部分克隆（含 ID 重写）→ 密钥空记录创建 → 返回 conflicts 报告
  6. 前端展示 conflicts，用户点击"前往校验" → 跳转 FlowEditorPage 触发元素校验

重新发布流程（新增）
  用户在模板卡片点"有新版本" → 选新已发布版本 → POST /re-publish → snapshot 覆盖
```

## 兼容性与迁移

- `internal_templates` 表结构不变，`snapshot` 字段为 JSON，不新增字段；密钥引用复用已有 `snapshot.flow.secretNames`，向后兼容。
- 历史 snapshot 无 `secretNames`（或为空）时，应用流程跳过空密钥创建（缺省即兼容）。
- `apply` 端点入参 `selection` 与 `elementMappings` 为可选，缺省时退化为现有"全量克隆无映射"行为，保证旧前端兼容（如有）。
- `rewrite_template_references` 扩展为接受 `selection` 参数，缺省时退化为全量重写。

## 重要 Trade-off

1. **D5 手动映射表 vs 自动校验**：选了更复杂方案，需新 UI + 新 API，但避免重复元素创建，体验更好。
2. **D6 部分应用 vs 只读预览**：选了更复杂方案，`rewrite_template_references` 需处理部分子集，但用户可灵活选择资源；代价是需要依赖闭包校验来避免悬空引用。
3. **D7 密钥绑定保留**：复用 `snapshot.flow.secretNames`（发布时已冻结），与 `project_secrets` 加密机制联动，应用时按引用名创建空密钥记录。trade-off：用户填值前密钥不可用，但避免重新绑定。
4. **re-publish 覆盖 vs 版本化**：选了最简方案，已应用资源不跟随更新（克隆式语义），但实现成本低。
5. **模板列表"有新版本"检测**：MVP 接受 N+1 查询，性能优化延后。

## 运维与回滚

- 所有变更在 `internal_templates` 与 `project_resources` 表，单事务回滚（已有 BEGIN IMMEDIATE/COMMIT/ROLLBACK）。
- re-publish 覆盖 snapshot 是不可逆操作，需在 UI 加确认对话框（"将覆盖现有快照，已应用项目不受影响"）。
- 空密钥创建失败不应阻断应用流程，记入 conflicts 报告的 `warnings` 段，用户可手动补建。
- 回滚点：每个端点独立，可分批合并；前端 Drawer 重构与后端端点解耦，可独立部署。
