# 重构公共模板

## Goal

重新梳理公共模板（内部模板库）的需求并对现有实现进行重构，使其从"能跑的 MVP"演进为"用户敢用、长期可维护"的流程复用中心。聚焦团队内复用场景，解决预览缺失、应用冲突、元素重映射、模板更新、密钥绑定五个核心短板。

## Background

### 现有实现盘点（证据）

**后端**
- 表：`internal_templates`（id, workspace_id, source_project_id, source_revision_id, name, description, category, snapshot, created_by, created_at, updated_at, deleted_at）+ `template_favorites`。见 [services.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/services.py)。
- 发布：从 `flow_revisions`（status='published'）冻结出 snapshot = `{flow, environments[], elements[], variables[]}`，variables 经 `public_resource_data` 脱敏。见 [handler.py:842-891](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py#L842-891)。
- 应用：为快照内每个资源生成新 UUID，`rewrite_template_references` 递归重写 ID 引用，单事务（BEGIN IMMEDIATE/COMMIT/ROLLBACK）插入 `project_resources`。见 [handler.py:1100-1140](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py#L1100-1140) 与 [templates.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/templates.py)。
- PATCH 只能改 name/description/category，snapshot 不可变。见 [handler.py:984-988](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py#L984-988)。
- 权限：`require_workspace_role`，应用时硬校验 workspace 匹配。见 [handler.py:1077-1078](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py#L1077-1078)。
- 审计：`template.published` / `template.updated` / `template.deleted` / `template.applied` 事件齐全。

**前端**
- 页面：[TemplatesPage.tsx](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx)（路由 `/templates`）。功能：列表 / 搜索（名称+描述模糊）/ 分类筛选 / 三种排序 / 收藏 / 编辑元信息 / 归档 / 应用 Drawer。
- 应用 Drawer 仅显示 name/category/description + 目标项目选择 + "应用模板"按钮，**不展示快照内容**。见 [TemplatesPage.tsx:124-125](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx#L124-125)。
- API 封装：[platform-api.ts:398-422](file:///home/huangwf/project/ui_auto/src/platform-api.ts#L398-422)。
- 权限前端已收敛为"登录即全权限"。见 [TemplatesPage.tsx:30-31](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx#L30-31)。
- 分类为自由文本输入，无枚举约束。见 [TemplatesPage.tsx:95](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx#L95)。

**可复用的现成能力**
- 元素校验能力（✓ 成功 / ⚠ 歧义 / ✗ 未找到 + 内联编辑 + 批量重新校验）已在 [FlowEditorPage.tsx](file:///home/huangwf/project/ui_auto/src/FlowEditorPage.tsx) 实现，可复用到"应用模板后校验新创建元素"。
- 项目存在 `project_secrets` 加密存储 + 会话级注入机制（[crypto.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/crypto.py)），模板变量脱敏后会与此机制产生耦合，需在重构中显式处理。

### 已识别短板（重构目标）

| # | 短板 | 重构目标 | MVP 优先级 |
|---|------|---------|-----------|
| 1 | 应用前无法预览快照内容 | 预览 + 部分应用 | P0 |
| 2 | 应用时不做同名冲突检测 | 自动重命名 + conflicts 报告 | P0 |
| 3 | 模板内容不可更新 | re-publish 覆盖 snapshot | P1 |
| 4 | 元素定位器不重映射 | 手动映射表 + 校验串联 | P1 |
| 5 | 密钥绑定关系丢失 | snapshot 保留引用 + 自动建空密钥 | P2 |
| 6 | 跨工作空间不可共享 | 不进 MVP | — |
| 7 | 无版本历史、无使用统计 | 不进 MVP | — |
| 8 | 分类为自由文本 | 不进 MVP | — |

## Key Decisions

- **D1 场景定位 = 团队内复用**：同一工作空间内跨项目复用流程。与现有"登录即全权限"产品定位一致。跨工作空间共享、版本化、使用统计均不进 MVP。
- **D2 重构边界 = 增量改进**：保留 `internal_templates` 表结构与现有 API 形态，在 snapshot 模型上扩展，不做破坏性数据迁移。
- **D3 应用冲突策略 = 重命名（自动加后缀）**：应用时检测目标项目同名资源，自动给新资源加后缀（如 `login_2`）创建，不打断流程。同名判定须按资源的去重维度进行（变量按 `scope+name`，元素按 `environment+name`），避免误判。同时收敛项目此前未决策的"变量名去重策略"（采用策略 1：自动加后缀）。后端返回 `conflicts` 报告供前端展示。变量重命名时须同步重写其派生的 `secretNames` 引用与流程内的 `{{...}}` 占位符（见 D7）。
- **D4 模板更新机制 = 重新发布覆盖 snapshot**：新增端点 `POST /api/platform/templates/{id}/re-publish`，选择新已发布版本覆盖 snapshot 字段。已应用资源是独立克隆，不跟随更新（克隆式语义）。表中已有 `source_revision_id` 字段，前端据此判断是否落后于源项目最新已发布版本并提示"有新版本可更新"。
- **D5 元素重映射形态 = 手动映射表**：应用模板前展示"元素映射表"，让用户把模板元素映射到目标项目已有元素（避免重复创建），未映射的模板元素再创建新元素并触发校验。需新 UI（映射表）+ 新 API（查询目标项目可映射元素 + 提交映射关系）。
- **D6 预览形态 = 部分应用（依赖闭包）**：预览同时可勾选要应用的资源子集，与 D5 元素映射表联动（仅对勾选的资源做映射）。后端 apply 端点接受 resource selection 参数，`rewrite_template_references` 需处理部分子集。为避免悬空引用，勾选 flow 时后端自动补入其引用的 elements/variables（依赖闭包），前端联动勾选；应用前校验闭包内依赖齐全，缺依赖直接报错，绝不生成悬空引用。
- **D7 密钥绑定 = 复用现有 secretNames 引用**：密钥引用在发布时已完整冻结进 `snapshot.flow.secretNames`（前端 `requiredSecretVariables` 按 `variable.secret` 标记 + step 占位符生成，格式 `project.<name>`/`env.<name>`），无需新增快照字段。应用后读取 `secretNames`，对每个引用名在目标项目 `project_secrets` 建空密钥记录（`encrypt("")` 值待填，`ON CONFLICT(project_id, name) DO NOTHING`），与加密机制联动。

## Requirements

- **R1 应用前预览（部分应用）**：在应用 Drawer 中展示快照内容（flow steps 列表 / elements 表 / variables 表），用户可勾选要应用的资源子集；勾选状态与 R3 元素映射表联动。
- **R2 应用冲突检测与处理**：应用时检测目标项目同名资源（流程/元素/变量），按 D3 策略自动重命名（加后缀），返回 `conflicts` 报告。
- **R3 元素重映射（手动映射表）**：应用模板前展示"元素映射表"，用户把模板元素映射到目标项目已有元素；未映射的模板元素创建新元素并触发定位校验，失效可内联编辑。新增"查询目标项目可映射元素"与"提交映射关系"两个 API。
- **R4 模板更新机制**：源流程迭代后可通过 re-publish 端点覆盖 snapshot，前端在模板卡片提示"有新版本可更新"。
- **R5 密钥引用关系保留**：复用 `snapshot.flow.secretNames`（发布时已包含脱敏后的密钥引用名），应用后自动在目标项目 `project_secrets` 创建空密钥记录（值待填，`ON CONFLICT` 跳过已有），与 `project_secrets` 加密机制联动。

## Acceptance Criteria

- [ ] AC1 在应用 Drawer 中可查看模板快照内的 flow steps、elements、variables 列表，并可勾选要应用的资源子集；勾选状态联动元素映射表。
- [ ] AC2 应用模板时检测到同名冲突，自动给新资源加后缀创建，不产生重复数据，前端展示 conflicts 报告。
- [ ] AC3 应用模板前展示元素映射表，用户可把模板元素映射到目标项目已有元素（避免重复创建）；未映射的模板元素创建新元素并自动触发定位校验，失效元素在 UI 上标红且可内联修复。
- [ ] AC4 模板可通过 re-publish 端点用新已发布版本覆盖 snapshot；当 sourceRevisionId 落后于源项目最新已发布版本时，前端在模板卡片提示"有新版本可更新"。
- [ ] AC5 应用模板时，`snapshot.flow.secretNames` 中的每个密钥引用名（不含值）自动在目标项目 `project_secrets` 创建空密钥记录（已存在则跳过），用户只需填值即可，无需重新绑定。

## Out of Scope

- 跨工作空间共享模板（受 D1 排除）。
- 模板版本历史与多版本回滚（受 D1 排除）。
- 模板使用统计（应用次数、最近应用时间等，受 D1 排除）。
- 对外模板市场、多租户、审核流程。
- 分类枚举约束（短板 #8，P3，不进 MVP）。

## Technical Notes（design.md 详述）

- 后端：扩展 apply 端点接受 `selection` 参数（含依赖闭包校验，缺依赖报错）；新增 `re-publish` 端点；新增"查询目标项目可映射元素"与"提交映射关系"端点；`rewrite_template_references` 需支持部分子集重写。
- 前端：重构 TemplatesPage 应用 Drawer，加入快照预览 + 资源勾选 + 元素映射表 + conflicts 报告展示；模板卡片加"有新版本可更新"提示。
- 数据：snapshot 结构无需扩展——密钥引用已存在于 `snapshot.flow.secretNames`（脱敏引用名，发布时冻结），应用时直接读取；不破坏现有 snapshot 兼容性。
- 与 `project_secrets` 联动：应用时读取 `snapshot.flow.secretNames`，调用 crypto.py 的 encrypt 逻辑创建空密钥记录（值为空字符串，`ON CONFLICT(project_id, name) DO NOTHING`）。

## Notes

- 本任务为复杂任务，已补 `design.md` 与 `implement.md`（见任务目录）。
- 数据迁移路径：不破坏现有 `internal_templates.snapshot` 结构，不新增字段；密钥引用复用已有 `snapshot.flow.secretNames`，历史数据无需迁移。
