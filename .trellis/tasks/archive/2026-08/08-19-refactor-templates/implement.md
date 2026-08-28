# 重构公共模板 — 执行计划

## 实现顺序（按依赖关系排序）

### Phase 1: 后端基础设施（无 UI 依赖，可独立验证）

1. **确认密钥引用在快照中的可用性（D7，无需新增字段）**
   - 文件：[handler.py:3864](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py#L3864)
   - 行为：确认 `snapshot.flow.secretNames` 已在发布时冻结（`flow_snapshot = {**flow, "secretNames": secret_names}`），密钥引用名为 `project.<name>`/`env.<name>`；apply 时直接读取，无需扫描占位符或新增快照字段
   - 验证：单元测试覆盖从 `snapshot.flow.secretNames` 读取引用名的逻辑

2. **扩展 rewrite_template_references 支持部分子集**
   - 文件：[templates.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/templates.py)
   - 行为：函数签名加 `selection: dict | None = None`，仅重写 selection 内资源的 ID 引用；缺省退化为全量重写
   - 验证：单元测试覆盖部分子集重写

3. **实现冲突检测与自动重命名（D3）**
   - 文件：[handler.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py) apply 端点内
   - 行为：应用前查 project_resources 同名资源（变量按 `scope+name`、元素按 `environment+name` 判定），给新资源 name 加后缀（`_2`、`_3`...）；变量重命名须同步重写其派生的 `secretNames` 引用与流程内 `{{...}}` 占位符；返回 conflicts 报告
   - 验证：单元测试覆盖冲突检测、后缀生成、secretNames 联动重写

4. **实现密钥空记录创建（D7）**
   - 文件：[handler.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py) apply 端点内
   - 行为：读取 `snapshot.flow.secretNames`，对每个引用名调 `services.encrypt("")` 在目标项目 `project_secrets` 创建空密钥记录（`ON CONFLICT(project_id, name) DO NOTHING`，避免覆盖已有）
   - 验证：单元测试覆盖空密钥创建与已存在跳过

### Phase 2: 后端新端点

5. **实现 re-publish 端点（R4 / D4）**
   - 文件：[handler.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py)
   - 行为：`POST /api/platform/templates/{id}/re-publish`，入参 `{revisionId}`，覆盖 snapshot + source_revision_id + updated_at
   - 权限：require_workspace_role(workspace_id, user.id, True)
   - 审计：`template.republished`
   - 验证：单元测试覆盖 re-publish 流程

6. **实现 apply-candidates 端点（R3 / D5）**
   - 文件：[handler.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py)
   - 行为：`GET /api/platform/templates/{id}/apply-candidates?projectId=...`，返回目标项目可映射 elements 列表
   - 验证：单元测试覆盖候选元素查询

7. **扩展 apply 端点（R1/R2/R3/R5 / D3/D5/D6/D7）**
   - 文件：[handler.py:1057-1151](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py#L1057-1151)
   - 行为：接受 `selection` + `elementMappings`，整合 Phase 1 的依赖闭包/冲突检测/部分重写/空密钥创建，返回 conflicts 报告；勾选 flow 时补入其引用的 elements/variables，缺依赖直接 400 报错
   - 验证：单元测试覆盖 selection 子集应用 + elementMappings 映射跳过创建 + 依赖闭包缺依赖报错

### Phase 3: 前端 API 封装

8. **platform-api.ts 新增封装**
   - 文件：[platform-api.ts:398-422](file:///home/huangwf/project/ui_auto/src/platform-api.ts#L398-422)
   - 新增：`rePublishPlatformTemplate`、`getTemplateApplyCandidates`
   - 扩展：`applyPlatformTemplate` 入参支持 `selection` + `elementMappings`
   - 验证：手动调用确认请求/响应

### Phase 4: 前端 UI 重构

9. **重构应用 Drawer（R1 / D6）**
   - 文件：[TemplatesPage.tsx:124-128](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx#L124-128)
   - 行为：Drawer 分三段（快照预览 + 资源勾选 / 元素映射表 / 应用段），读 template.snapshot 展示；勾选 flow 时前端联动勾选其引用的 elements/variables（依赖闭包）
   - 验证：手动点击模板卡片，确认预览展示与勾选交互、依赖联动

10. **实现元素映射表（R3 / D5）**
    - 文件：[TemplatesPage.tsx](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx)
    - 行为：勾选的 elements 行展示映射下拉，选项来自 apply-candidates 端点
    - 验证：手动配置映射，确认提交后映射生效

11. **实现 conflicts 报告展示（R2）**
    - 文件：[TemplatesPage.tsx](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx)
    - 行为：应用后用 Alert 展示 conflicts 报告，提供"前往校验"跳转
    - 验证：手动制造同名冲突，确认报告展示

12. **实现模板卡片"有新版本"提示（R4）**
    - 文件：[TemplatesPage.tsx:99-122](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx#L99-122)
    - 行为：列表加载后比对 sourceRevisionId 与源项目最新已发布版本，落后显示角标，点击触发 re-publish Modal
    - 验证：手动 re-publish 后角标消失

### Phase 5: 串联与端到端验证

13. **串联应用后元素校验（R3）**
    - 文件：[TemplatesPage.tsx](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx) + [FlowEditorPage.tsx](file:///home/huangwf/project/ui_auto/src/FlowEditorPage.tsx)
    - 行为：应用后"前往校验"跳转 FlowEditorPage，自动触发新创建元素的定位校验（复用 ✓/⚠/✗ + 内联编辑）
    - 验证：端到端跑通，确认失效元素标红可修复

14. **App.css 样式补全**
    - 文件：[App.css](file:///home/huangwf/project/ui_auto/src/App.css)
    - 行为：映射表、conflicts 报告、新版本角标样式
    - 验证：视觉走查

## 验证命令

```bash
# 后端单测
cd server-py && python -m pytest tests/unit/test_templates*.py -v

# 前端构建
npm run build

# 前端单测（如有）
npm test -- TemplatesPage

# 端到端手动验证
# 1. 发布一个含密钥变量的流程为模板
# 2. 在另一项目应用，验证预览/勾选/映射/conflicts/空密钥创建
# 3. re-publish 源流程，验证模板卡片显示"有新版本"
```

## 风险文件与回滚点

| 文件 | 风险 | 回滚策略 |
|------|------|---------|
| [handler.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py) apply 端点 | 入参扩展破坏旧调用方 | selection/elementMappings 设为可选，缺省退化 |
| [templates.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/templates.py) rewrite_template_references | 部分子集重写可能漏改引用，产生悬空引用 | 加 selection 参数缺省退化；依赖闭包在重写前校验依赖齐全；单测覆盖全量+子集两种模式 |
| [handler.py](file:///home/huangwf/project/ui_auto/server-py/autoflow/handler.py) apply 密钥建空记录 | 读取 `secretNames` 时引用名与 `project_secrets` 键不一致 | 直接复用发布时冻结的 `secretNames`，不重写解析逻辑；单测覆盖引用名→建空记录 |
| [TemplatesPage.tsx](file:///home/huangwf/project/ui_auto/src/pages/TemplatesPage.tsx) Drawer 重构 | 大改 UI 可能影响现有应用流程 | Drawer 重构独立提交，与后端端点解耦，可独立回滚 |

## task.py start 前的后续检查

- [x] 占位符格式已确认：`{{ ... }}`，支持 `{{project.<name>}}`/`{{env.<name>}}` 前缀（services.py:1292-1296、shared.tsx:493）
- [ ] 确认 `project_resources` 表内各资源类型的 name 字段路径（json_extract 路径是否为 `$.name`），以及变量的 `$.scope`、元素的 `$.environment` 字段路径（同名判定需带上这些维度）
- [x] 密钥引用已确认：`snapshot.flow.secretNames` 在发布时冻结（handler.py:3864），密钥值存于 `project_secrets` 表按引用名键控（services.py:126-137）；无需新增快照字段
- [ ] 确认 flow_snapshot 内 step 引用元素存的是 id 还是 name（services.py:3159-3162 显示两者皆可能），据此决定元素重映射与 `rewrite_template_references` 的策略
- [ ] 确认 FlowEditorPage 元素校验入口可被外部跳转触发（URL 参数或 store 机制）
