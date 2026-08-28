# Implement: 流程自动断言 MVP

有序执行清单。每步标注可验证产物；`[gate]` 标记的验证命令必须全绿才能进入下一步。

## 阶段 A：Schema 与快照放行（后端基础）

- [ ] A1. `src/mock-data.ts` `FlowStep` 增加 4 个可选字段（每字段只属于一种断言类型，枚举互斥）：`assertMatch?`（仅文本/属性：`exact|contains`）、`assertVisibility?`（仅可见性：`visible|hidden`）、`assertOperator?`（仅数量：比较符）、`assertAttribute?`（仅属性：属性名）；`actionOptions` 追加 `数量断言`、`属性断言`。
- [ ] A2. `src/flow-normalize.ts` `normalizeStep` 透传新字段（`...step` 已展开，仅需类型正确 + 默认值兜底）。
- [ ] A3. [gate] `npm run lint && npm run build` 通过（类型不破坏）。

## 阶段 B：Runner 断言执行

- [ ] B1. `server-py/autoflow/runner.py`：
  - 新增 `_assert_visibility` / `_assert_text` / `_assert_count` / `_assert_attribute` 四个纯函数，入参 `(locator, page, step, timeout_ms, value)`，返回 `(passed, expected, actual)`；文本/属性按 `assertMatch`（exact/contains）判定，数量按 `assertOperator`（期望数对 `value` 做 `int()` 强转，转换失败即该断言失败，禁止字符串/数字直接比较），可见性按 `assertVisibility`（visible/hidden，默认 visible，复用既有 `wait_for` 语义：hidden 断言用 `wait_for(state="detached" or "hidden")` 并做存在性区分）。
  - `文本断言`/`可见性断言` 现有分支改为走对应纯函数（保持默认值语义，`assertMatch` 缺省=contains、`assertVisibility` 缺省=visible；跨类型误值忽略该字段回落默认、不报错）。
  - 断言步骤无论成败先发 `step.asserted`（含 `type/passed/expected/actual`），再按判定发 `step.completed`/`step.failed`（顺序是契约，前端时间线依赖）。
  - 新增 `数量断言`、`属性断言` 分支。
- [ ] B2. `revision_snapshot.py:17` `STEP_KEYS` 追加四个字段（`assertMatch`/`assertVisibility`/`assertOperator`/`assertAttribute`）——漏加会被剔出 revision 快照（硬约束）。
- [ ] B3. 断言失败时抛出带结构化上下文的异常（沿用 `TEXT_ASSERTION_FAILED` 风格扩展，如 `ASSERTION_FAILED: <type> expected=<...> actual=<...>`），由 `execute_browser_run` 捕获后写入 `assertions` 数组并继续既有 failurePolicy 逻辑。
- [ ] B4. `execute_browser_run` 返回 dict 增加 `assertions`（成功与失败路径都要带）。
- [ ] B5. 断言步骤成功/失败均发 `step.asserted` 事件（含 `type/passed/expected/actual`）。
- [ ] B6. [gate] `npm run test:py`：
  - 新增 `server-py/tests/unit/test_assertions.py`：四类型 ×（通过/失败/匹配方式）至少 8 例；断言失败+`继续执行`不中止；默认值兼容（旧流程无新字段仍可跑）。

## 阶段 C：结果与 API 透出

- [ ] C1. 确认 `services.run_response` 的 `**run` 展开已把 `result.assertions` 带到 `GET /runs/{id}` 与 batch detail（预计零改动；若 result 在 `run` dict 里被裁剪则补字段）。
- [ ] C2. 脱敏：`assertions` 内 `actual` 若含 secret 值，确认走 `redact_run_value` 同路径（加 1 个单测覆盖敏感断言值不落明文）。
- [ ] C3. [gate] `npm run test:py`（含 C2 新测）。

## 阶段 D：编辑器断言面板（前端）

- [ ] D1. `src/FlowEditorPage.tsx`：选中断言类动作（`action.includes("断言")`）时，打开独立断言配置面板（Drawer 或步骤内折叠区），按类型渲染：
  - 可见性：元素 + 可见/不可见（`assertVisibility`；编辑器按动作类型严格限制下拉可选值，跨类型字段不出现）；
  - 文本：元素 + 匹配方式（exact/contains）+ 期望值；
  - 数量：元素 + 比较符 + 数字；
  - 属性：元素 + 属性名下拉 + 匹配方式 + 期望值；
  - 超时 + 失败策略（沿用现有控件）。
- [ ] D2. 非断言步骤表单保持不变（回归确认）。
- [ ] D3. 保存时新字段随 step 写入；加载旧流程（无新字段）面板正常显示默认值。
- [ ] D4. [gate] `npm run test:unit`：新增 FlowEditorPage 断言面板用例（打开/切换类型/保存字段）。

## 阶段 E：RunDetail 断言结果区块（前端）

- [ ] E1. `src/RunDetailPage.tsx`：顶部独立「断言结果」区块，读 `run.result?.assertions`：逐条 名称/类型/通过·失败/期望 vs 实际；无断言的 run 不显示该区块。
- [ ] E2. 步骤时间线：`step.asserted` 事件渲染判定（通过绿/失败红 + expected/actual 摘要）。
- [ ] E3. [gate] `npm run test:unit`：RunDetailPage 断言区块用例（有断言/无断言/失败展示 expected vs actual）。
- [ ] E4. [gate · 核心链路冒烟] 新增 `tests/assertion-contract.spec.ts`（最小 e2e，真实 Chromium）：打开页面 → 一条文本断言通过 → 断言 `GET /runs/{id}` 中 `run.result.assertions` 形状正确（`type/passed/expected/actual`）且 `step.asserted` 事件可见。验证 B/C 跨层契约真实流通；F/G/H 依赖该契约，此门不过不开工。

## 阶段 F：断言报告导出

- [ ] F1. `services.py` 新增 `build_assertion_report(run, format)`：装配 run 元信息 + `result.assertions` + 失败截图/trace artifact 引用（按 run_id 查 `platform_artifacts`，截图名 `failure-step-{index+1}.png`、trace 名 `trace.zip` 前缀匹配；缺失的留空不报错）；XLSX 用 `openpyxl` 写 sheet（列：序号/步骤/类型/判定/期望/实际/耗时），JSON 直接序列化；`actual` 走 `redact_run_value`。
- [ ] F2. 写入 `artifact_directory` + 插 `platform_artifacts` 行（同 `services.py:3463`），`handler.py` 新增 `POST /projects/{project_id}/runs/{run_id}/assertion-report`（`format=json|xlsx` 走 query，与既有 create-resource 约定一致：成功 201 + `{"artifact": {...}}`；run 不存在 404、无项目角色 403、run 无断言 409；权限对齐 `handler.py:4334` 的 artifact 下载）。
- [ ] F3. `RunDetailPage` 「导出断言报告」按钮（JSON/XLSX 二选一），走现有 artifact 下载 blob 逻辑。
- [ ] F4. [gate] 单测：JSON/XLSX 生成、脱敏、截图/trace 引用装配（含缺失留空）、201/404/403/409 状态码；`npm run test:py`。

## 阶段 G：断言聚合视图

- [ ] G1. 服务端聚合：**独立端点 `GET /projects/{project_id}/assertion-stats?windowDays=N`**，口径为**整个项目**（全量扫描含断言的 run 解析 `result.assertions`，应用层聚合，禁止按分页窗口聚合——分页口径会导致通过率随翻页漂移）；返回 `{runsWithAssertions, totalAssertions, passedAssertions, failedAssertions}`；batch detail 附加跨子 run 断言计数（建模 `_RUN_BATCH_COUNTS_CTE`，`services.py:2599`）。
- [ ] G2. `RunsPage` 计数列旁加断言通过率；batch detail 加「断言」汇总（通过/失败 + 失败明细列表）。
- [ ] G3. [gate] 单测：聚合查询（有/无断言 run、混合状态）+ **口径校验（断言端点结果与全量 run 一致，不随分页参数变化）+ batch 跨子 run 计数**；`npm run test:unit + test:py`。

## 阶段 H：断言编辑器增强

- [ ] H1. 批量编辑：FlowEditorPage 断言步骤 rowSelection + 批量操作条（匹配方式/失败策略），复用 `RunsPage.tsx:458/604` 模式。
- [ ] H2. 录制导入生成断言：`planRecordingImport`（`recording-editor-state.ts:97`，返回前约 :170）追加候选可见性断言至 `generatedAssertions`；导入弹窗默认不勾选，勾选并入 `importedSteps`，review 可删改。
- [ ] H3. 断言试跑：语义为「**从流程首步执行到该断言步骤（含）**」——**复用现成 `upToStepId` 切片（`runner.py:258-270` 的 `steps[:index+1]`），不新增 `fromStepId`、不改执行内核**；禁止实现成"只执行该断言步骤"（中部断言依赖前面步骤建立的页面上下文）。新增临时执行通道（如 `POST /runs/preview`，body 传与正式 run 同构的执行输入 + `upToStepId`）：组装最小 hooks 直调 `execute_browser_run`（对照 `managed_runner.py:175-185`，runner 内部自行启停浏览器 `runner.py:282`）——`signal` 新建 Event、`artifact_path`/`artifact` 空操作、`event` 写内存收集器、`browser` 空操作；**不落 `platform_runs`/`platform_run_events`、不入队、不产生 artifact**，返回 result（含 `assertions`）内联展示 expected/actual；脱敏规则生效。先在 `server-py/tests/unit/` 补临时通道单测：传 `upToStepId` 执行到该步（含）、不产生 `platform_runs`/`platform_run_events` 记录、返回含 `assertions`、`upToStepId` 不存在时沿用既有 `RUN_STEP_NOT_FOUND`。
- [ ] H4. [gate] `npm run test:py`（临时执行通道必须 Python 级自测把门）+ `npm run test:unit`：批量编辑、导入生成（默认关/勾选，生成步骤用 `assertVisibility`）、试跑（经 `upToStepId` 执行到该步含）不落 `platform_runs`/`platform_run_events`、不入队。

## 阶段 I：端到端与收尾

- [ ] I1. `tests/assertion.spec.ts`：打开页面→文本断言通过→数量断言失败(继续执行)→结果载荷/事件一致；另加断言报告导出 + RunDetail 断言区块断言。
- [ ] I2. [gate] 全量门禁对齐仓库 CI（`test:all`）：
  ```bash
  npm run test:all   # build && lint && test:unit && test:startup && test:py && check:bundle && test:e2e && test:windows
  ```
  其中 `test:startup` 覆盖生产启动契约（F 新端点 / G 聚合可能触碰），`check:bundle` 为包体积预算（D/H 新增前端代码可能超限，超限时按既有拆分策略处理而非放宽预算）；非 Windows 环境 `test:windows` 豁免，其余必须全绿。
- [ ] I3. 回归：`test:e2e` 中 retry/batch 既有 spec 不回归（断言字段进 snapshot 后 retry 克隆仍正确；试跑通道不影响正式 run 计数）；`FlowEditorPage` 被 D/E/H 改动过，录制、workbench 等走该页面的既有 e2e 必须一并通过。
- [ ] I4. 收尾：确认 4 个既有脏状态任务（retry/batch/recording/legacy-e2e）不在本任务范围，仅记录到 PRD 备注。

## 风险文件 / 回滚点

- 高风险：`server-py/autoflow/runner.py`（执行内核，改动影响全部 run）、`revision_snapshot.py`（revision 语义）。
- 回滚顺序：E → D → B（C 多为只读确认）→ A。无数据迁移，回滚不涉及存量数据。
- 启动前检查：确认 `08-16-flow-retry-reproduction-correctness` 已归档（P0 门禁），避免在脏 P0 上叠加断言验收。
