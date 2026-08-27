# Implement: 阶段1 整体架构（断言 schema 单源化 + 大文件拆分 + MSW）

有序执行清单。每步标注可验证产物；`[gate]` 标记的验证命令必须全绿才能进入下一步。
边界约束：全部改动落在 `.trellis/spec/guides/architecture-boundaries.md` 的②可重构区（保行为）与③可扩展区（纯增量），不触碰①稳定契约区。

---

## 阶段 A：断言 schema 单源化（数据契约）

### A1. 契约文档（权威来源，阶段0 已固化）

`.trellis/spec/backend/assertion-field-contract.md` 已在阶段0固化并挂入 `backend/index.md`，内容：

| 字段 | 归属断言类型 | 允许值 | 缺省 | 语义 |
|---|---|---|---|---|
| `assertMatch` | 文本/属性 | `exact` \| `contains` | `contains` | 匹配方式；跨类型误值回落缺省 |
| `assertVisibility` | 可见性 | `visible` \| `hidden` | `visible` | 可见/不可见；`hidden` 区分 not-found 与存在但隐藏 |
| `assertOperator` | 数量 | `=` `>` `<` `>=` `<=` | `=` | 匹配元素个数与期望数关系；期望数 `int()` 强转，失败即断言失败 |
| `assertAttribute` | 属性 | 非空字符串 | `value` | 属性名 |
| `trimCompare` | 文本 | boolean | `true`（显式 `false` 关闭） | 比较前空白归一化（首尾 + 连续空白折叠） |

动作 → 判定 type 映射：`可见性断言→visibility`、`文本断言→text`、`数量断言→count`、`属性断言→attribute`。
事件契约：`step.asserted` 载荷 `{type, passed, expected, actual}`，**恒在** `step.completed`/`step.failed` 之前（前端时间线依赖）。
规范字段集（进 revision checksum 的断言部分）：`assertMatch/assertVisibility/assertOperator/assertAttribute/trimCompare`（对应 `revision_snapshot.py:STEP_KEYS` 行 24-28，漏加会被剔出快照——硬约束）。

### A2. 前端收敛到单一模块

- [x] A2.1 新增 `src/domain/assertions.ts`：导出 `ASSERT_MATCHES` / `ASSERT_VISIBILITIES` / `ASSERT_OPERATORS` / `ASSERT_ATTRIBUTE_DEFAULT` / `ASSERTION_ACTIONS`（动作→判定 type 映射）与类型别名（引用 `model.ts` 的 `FlowStep` 断言字段）。
- [x] A2.2 `src/lib/flow-normalize.ts`：把行 33-46 的内联枚举判断改为引用 `assertions.ts` 常量（非法值回落 `undefined` 的语义不变）。
- [x] A2.3 `src/domain/model.ts`：断言字段类型改为从 `assertions.ts` 的类型别名引用（对外类型形状不变）。
- [x] A2.4 [gate] `npm run lint && npm run build && npm run test:unit` 全绿。

### A3. 后端收敛到单一模块

- [x] A3.1 新增 `server-py/autoflow/assertion_contract.py`：迁移 `runner.py:151-161` 的 `_ASSERT_OPERATORS` / `_ASSERT_MATCHES` / `_ASSERT_VISIBILITIES` / `_ASSERTION_TYPES`，并导出规范字段集 `ASSERTION_KEYS`。
- [x] A3.2 `runner.py` 四个 `_assert_*` 与 `_run_assertion` 改为从 `assertion_contract` 导入（`step.get(...)` 缺省回落逻辑原样保留，行 176-178/212-214/247-249/279-284 的兜底不变）。
- [x] A3.3 `revision_snapshot.py:STEP_KEYS` 改由 `assertion_contract.ASSERTION_KEYS` 参与组装（STEP_KEYS 内容不变，键序原位展开——checksum 依赖键序）。
- [x] A3.4 [gate] `npm run test:py` 全绿（含既有断言单测）。

### A4. 跨层 parity（单源的机械校验）

- [x] A4.1 新增 `src/lib/assertions-contract.test.ts`：`assertions.ts` 各枚举与契约文档一致；`ASSERTION_ACTIONS` 键覆盖 `actionOptions` 全部断言动作。
- [x] A4.2 新增 `server-py/tests/unit/test_assertion_contract.py`：`assertion_contract` 枚举与契约文档一致；`STEP_KEYS` 原位内嵌规范断言字段（与契约比对）。
- [x] A4.3 既有 e2e（`assertion-contract.spec.ts`）增补断言：后端 `step.asserted` / `result.assertions` 的 `type` 与前端 `ASSERTION_ACTIONS` 映射一致（跨层校验，引用单源常量而非字面量）。
- [x] A4.4 [gate] `npm run test:unit && npm run test:py` 全绿。

## 阶段 B：FlowEditorPage 拆分（保留行为）

拆分顺序按依赖从纯函数到组件；每步保持页面可观测行为不变。

- [x] B1. 抽取「断言配置面板」：选中断言动作步骤（`action.includes("断言")`）时渲染的配置区（元素/匹配方式/期望值/超时/失败策略）→ `src/pages/flow-editor/AssertionStepPanel.tsx` + `useAssertionStepDraft` hook（`assertion-step-draft.ts`，集中跨类型字段互斥）。校验规则与跨类型字段互斥保持。
- [x] B2. 抽取「录制导入候选面板」：候选断言勾选、新元素编辑 → `src/pages/flow-editor/RecordingImportPanel.tsx`（纯展示 + 回调，状态仍归页面/既有 `recording-editor-state.ts`）。同时将 `ElementEditForm`、`SecretCreatorDrawer`（`SecretCreatorDrawer.tsx`）与校验共享类型/辅助（`element-validation.ts`）一并迁出。
- [x] B3. 抽取「批量编辑条」：断言步骤 rowSelection + 批量匹配方式/失败策略 → `src/pages/flow-editor/AssertionBatchBar.tsx`。
- [x] B4. 抽取「步骤列表渲染」：拖拽排序、步骤卡片 → `src/pages/flow-editor/StepList.tsx`（DragEnd 回调上抛为 `onMove`）。
- [x] B5. `FlowEditorPage.tsx` 收窄为编排：2233 → 1366 行，状态、数据加载、回调接线、模块装配。
- [x] B6. [gate] `npm run lint && npm run build && npm run test:unit` 全绿：lint ✓ / build ✓ / unit 111（25 files）✓，FlowEditorPage 既有用例（`flow-editor-batch-import.test.tsx`、`flow-editor-assertion.test.tsx`、`flow-editor-save.test.tsx`）不回归。

## 阶段 C：runs.py 拆 mixin（保留行为）

- [ ] C1. `RunServices`（`services/runs.py:26`）拆为 `RunServicesBase` + mixin：
  - `_RunsLifecycleMixin`（run 创建/取消/重试/终态）
  - `_RunEventsMixin`（事件分页/游标）
  - `_BatchMixin`（batch 执行/聚合）
  - `_ReportMixin`（断言报告导出）
  - `_AggregationMixin`（断言统计）
- [ ] C2. 对外方法名、签名、返回结构零变化；路由层 import 的类路径若变化，同步更新 `handler.py` 引用。
- [ ] C3. [gate] `npm run test:py` 全绿（runs/batch/retry/report/aggregation 全部覆盖）。

## 阶段 D：main.py 移除模块级副作用

- [ ] D1. `app = create_app()`（`main.py:436`）移除模块级执行：
  - 提供显式 `create_platform_app()` 工厂（内部调 `create_app`）；
  - 生产/开发入口（uvicorn `--factory` 或入口脚本）改为调用工厂；
  - 保留 `main.py` 作为 uvicorn 目标时通过工厂暴露 `app`（入口显式构造，不随 import 触发副作用）。
- [ ] D2. 确认所有测试 import `main` 不再触发服务初始化（检查现有 test fixture 的导入方式）。
- [ ] D3. [gate] `npm run test:py && npm run test:startup`（生产启动契约覆盖 `POST /api/auth/register` → session → `/health` 全链路）。

## 阶段 E：MSW 测试基建

- [ ] E1. 新增 `msw`（devDependency，仅测试）。确认不进入生产 bundle：应用入口无 import。
- [ ] E2. 新增 `src/test/server-handlers.ts`：映射 `platform-api.ts` 端点（revisions / secrets / runs / batch / 断言统计 / 录制会话 / 元素校验 / 工作区同步），按真实响应形状返回。
- [ ] E3. vitest setup 接入 `msw/node` `setupServer`（`src/test/setup-msw.ts`），默认无未匹配 handler 时显式 404（暴露 mock 覆盖缺口）。
- [ ] E4. 为 `ServerWorkspaceSynchronizer.tsx`（当前零单测）补测：30s 轮询拉取、并发刷新合并、编辑后整体 PUT 不丢模板扩展字段（`variables`/`secretNames`/未知键透传，对应 `flow-normalize.ts` W2-4 语义）。
- [ ] E5. 渐进替换 `vi.mock("../api/platform-api")` 手写 mock：新组件测试优先走 MSW handler；既有用例迁移不阻塞（可共存）。
- [ ] E6. [gate] `npm run test:unit && npm run check:bundle`（bundle ≤ 500 kB）。

## 阶段 F：验收与收尾

- [ ] F1. 全量门禁：
  ```bash
  npm run test:all   # build && lint && test:unit && test:startup && test:py && check:bundle && test:e2e && test:windows
  ```
  非 Windows 环境 `test:windows` 豁免；e2e 为阶段完整验收门禁（断言契约、录制、workbench、retry/batch 既有 spec 不回归）。
- [ ] F2. 回滚：每个拆分独立提交、独立可回滚（行为保持，回滚即 revert 单个提交，无数据迁移）。
- [ ] F3. spec 同步：契约文档挂入 `.trellis/spec/backend/index.md`；`architecture-boundaries.md` 若涉及拆分后文件路径变化则更新。
- [ ] F4. 收尾：更新阶段1 PRD 验收清单；阶段2（录制/执行稳定性）不提前开工。

## 风险文件 / 回滚点

- 高风险：`runner.py`（执行内核）——但本阶段只迁移常量导入，求值逻辑零改动；`revision_snapshot.py` STEP_KEYS 组装方式变但内容不变（契约校验兜底）。
- 中风险：`FlowEditorPage.tsx` 拆分（页面最大、无细分测试的既有交互多）——按 B1-B4 分步、每步跑既有 FlowEditorPage 用例。
- 低风险：`main.py` 入口改造（改 uvicorn 工厂目标，`test:startup` 把关）。
- 启动前检查：阶段0 基线已绿（build/lint/unit/py/bundle），本阶段每一 `[gate]` 相对该基线比对。
