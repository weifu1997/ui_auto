# 流程自动断言 MVP

## Goal

让流程自带「执行结果是否正确」的判定能力：在流程中声明可观察的预期（断言步骤），执行时自动判定通过/失败；run 结果与事件流能区分「断言失败」与「普通操作失败」，用户不必靠肉眼核对结果判断流程是否成功，失败时能定位到具体断言的期望值与实际值。

用户价值：流程跑完的含义从"动作都执行了"升级为"结果符合预期"；断言结果可审计、可展示、可被 retry/batch 完整复现。

## Background And Evidence

现状（2026-08-21 代码勘察）：

- 已有两个断言动作雏形：`可见性断言`（等待元素可见，失败即抛错）与 `文本断言`（文本包含检查，抛 `TEXT_ASSERTION_FAILED`），见 `server-py/autoflow/runner.py:216-223`；编辑器 `actionOptions` 已可选（`src/mock-data.ts:91`），步骤表单对断言类动作把 value 字段标为「期望值」（`src/FlowEditorPage.tsx:1778`）。
- 缺失（即本轮范围）：
  - 断言失败在事件流中与普通步骤失败无法区分（`runner.py:297-369` 只有 `step.started/completed/failed`）。
  - run 结果无断言判定汇总（`platform_runs.result` 只有 `error`/`flowOutputs`，`services.py:3820-3860`）。
  - 无断言类型枚举（仅 2 种）、无匹配方式、无数量/属性断言。
  - 断言字段未进 revision snapshot 白名单 `STEP_KEYS`（`server-py/autoflow/revision_snapshot.py:17`），新字段必须加入否则被剔出 revision checksum。
  - 前端无断言专属编辑体验；`RunDetailPage` 事件渲染（`src/RunDetailPage.tsx:97`）无断言判定展示。
- 依赖前提：`08-16-flow-retry-reproduction-correctness`（P0 retry 一对一克隆）已实现并具备 2026-08-18 门禁证据，断言字段进 snapshot 后 retry 即自动完整复现。

## Requirements

### REQ-1：断言类型（MVP 四件套）

- `可见性断言`：定位元素，断言可见（默认）或不可见。
- `文本断言`：定位元素，断言其文本按匹配方式命中期望值。
- `数量断言`：断言匹配元素个数与期望数的关系（`= > < >= <=`）。
- `属性断言`：定位元素，断言某属性（`value`/`disabled`/`href` 等）按匹配方式命中期望值。

匹配方式：文本/属性支持 `exact` 与 `contains`（默认 `contains`，兼容既有行为）；正则明确不进 MVP。

### REQ-2：判定语义（复用 failurePolicy）

- 断言复用步骤级 `failurePolicy`（`立即失败` / `继续执行` / `重试 1 次`）：
  - `立即失败`（默认）：断言失败 → run 判 `failed`；
  - `继续执行`：软断言，失败仅记录判定，流程继续，run 最终状态按其余步骤决定；
  - `重试 1 次`：先重试一次，仍失败按失败策略处理。
- 断言判定在事件流中可区分：新增 `step.asserted` 事件，携带 `type / passed / expected / actual`（无论成败都发）。**发送顺序是契约**：执行断言 → 发 `step.asserted` → 再按判定结果发 `step.completed`（成功）或 `step.failed`（失败）；即 `step.asserted` 恒在对应结论事件之前（前端时间线渲染依赖此顺序）。
- run 结果载荷 `result.assertions` 汇总每条断言的判定（`stepIndex / stepId / title / type / passed / expected / actual`），经 `run_response` 的 `**run` 展开自动出现在 `GET /runs/{id}` 与 batch detail。

### REQ-3：Schema 与快照放行

- `FlowStep` 新增 4 个可选字段，**每个字段只属于一种断言类型，枚举互斥**：`assertMatch`（仅文本/属性：`exact|contains`）、`assertVisibility`（仅可见性：`visible|hidden`，不复用 assertMatch，避免同字段双枚举在编辑器校验与回归测试中混淆）、`assertOperator`（仅数量：比较符）、`assertAttribute`（仅属性：属性名）。期望值沿用 `value`、元素沿用 `element`、超时/失败策略沿用 `timeout`/`failurePolicy`。跨类型误值后端视为缺省（回落默认值）而非报错；编辑器按动作类型限定下拉可选值。
- `revision_snapshot.py` 的 `STEP_KEYS` 白名单追加上述四个字段（`assertMatch`/`assertVisibility`/`assertOperator`/`assertAttribute`），确保断言变更产生新 revision 且 retry/batch 克隆完整。
- 数量断言期望数存 `value`（字符串形式），后端执行前 `int()` 强转，转换失败视为断言失败，不得字符串/数字直接比较。
- 向后兼容：旧流程（无新字段）行为不变——`可见性断言` 缺省=visible，`文本断言` 缺省=contains。

### REQ-4：编辑器（独立断言配置面板）

- 选中断言类步骤时打开独立断言配置面板，按类型渲染对应配置项（元素选择复用元素资产；类型/匹配/期望/比较符/属性名；超时与失败策略沿用现有控件）；非断言步骤表单不变。
- 保存时新字段随 step 持久化；加载无新字段的旧流程时面板显示默认值不报错。

### REQ-5：结果展示（独立断言结果区块）

- `RunDetailPage` 顶部独立「断言结果」区块：逐条展示 名称/类型/通过·失败/期望 vs 实际；run 无断言时不显示。
- 步骤时间线中 `step.asserted` 事件带判定着色与 expected/actual 摘要。

## Acceptance Criteria

- [ ] AC1：四种断言各有单测覆盖通过/失败路径（`server-py/tests/unit/test_assertions.py`），文本/属性 exact 与 contains 各至少 1 例，数量断言至少覆盖 `=` 与 `>=`，属性断言至少 1 例；断言失败+`继续执行` 时 run 不中止且 `step.asserted(passed:false)` 存在。
- [ ] AC2：断言失败+`立即失败` 时 run 状态 `failed`，`result.assertions` 含该条 `passed:false` 与 expected/actual；`step.asserted` 与 `step.failed` 事件均可查，且 `step.asserted` 恒在对应结论事件之前（顺序契约）。
- [ ] AC3：断言步骤字段改动的流程发布后产生新 revision（checksum 变化），旧 revision 不含该改动；无新字段的旧流程 revision checksum 不变（向后兼容回归）。
- [ ] AC4：retry 克隆的 run 完整携带断言步骤并以相同快照执行（复用既有 retry 一对一克隆路径，回归 `test_retry_snapshot.py` + `retry-reproduction.spec.ts` 不回归）。
- [ ] AC5：编辑器断言面板可配置全部四类断言并保存；非断言步骤表单无行为变化（`FlowEditorPage` 单测）。
- [ ] AC6：RunDetail 对有断言的 run 展示「断言结果」区块（含失败条目的 expected vs actual），无断言的 run 不显示（RunDetailPage 单测）。
- [ ] AC7：端到端（真实 Chromium）`tests/assertion.spec.ts`：打开页面 → 文本断言通过 → 数量断言失败（继续执行）→ 结果载荷与事件断言判定一致。
- [ ] AC8：断言 `actual` 命中 secret 值时不落明文（沿用 redact 路径，单测覆盖）。
- [ ] AC9：断言报告可导出 JSON 与 XLSX 两种格式，内容含逐条断言判定与 run 元信息；导出走 artifact 下载端点，权限校验与现有 artifact 下载一致；敏感 run 导出的 `actual` 为脱敏值（单测 + e2e 各覆盖）。
- [ ] AC10：断言通过率来自独立端点 `GET /projects/{id}/assertion-stats` 的**全项目口径**（非分页数据聚合），无断言 run 不进分子分母；batch detail 跨子 run 断言汇总口径一致（单测覆盖全项目 vs 分页口径区分）。
- [ ] AC11：编辑器支持多选中断言步骤批量改匹配方式/失败策略；录制导入可在 review 阶段勾选生成可见性断言步骤（默认不生成，用 `assertVisibility`）；单条断言可试跑（语义=首步执行到该步含，复用 `upToStepId`）并内联展示 expected/actual，试跑不产生 `platform_runs`/`platform_run_events` 记录、不进队列（单测 + FlowEditorPage 用例覆盖）。
- [ ] AC12：全量门禁 `npm run test:all`（= build / lint / test:unit / test:startup / test:py / check:bundle / test:e2e；非 Windows 环境 test:windows 豁免）通过；E4 核心链路冒烟门禁与 H4 的 `test:py` 内核门禁已在对应阶段通过。

### REQ-6：断言报告导出

- 端点 `POST /api/platform/projects/{project_id}/runs/{run_id}/assertion-report?format=json|xlsx`（**format 走 query**，缺省 json）；状态码：成功 201 + `{"artifact": {...}}`、run 不存在 404、无权限 403、无断言 409；权限同 run detail。
- 报告含 run 元信息、逐条断言（名称/类型/通过·失败/期望/实际/耗时）、失败步骤截图与 trace 的 artifact 引用。截图/trace 关联方式：失败截图按 `failure-step-{步骤序号}.png` 命名、trace 按 `trace.zip`（`runner.py:333/371`），经 `hooks["artifact"]` 登记进 `platform_artifacts`（按 `run_id`，`services.py:3463`）；报告按 `run_id` + name 前缀匹配引用其下载链接，**缺失则留空、不报错不阻塞**。
- 复用 artifact 基建：报告写入 `managed_runner.artifact_directory`，插 `platform_artifacts` 行（同 `services.py:3463` 模式），经现有 artifact 下载端点（`GET /api/platform/artifacts/{id}`，`handler.py:4334`）下发；前端 RunDetail「导出断言报告」按钮（JSON/XLSX 二选一）。
- 敏感 run 导出时 `actual` 走脱敏值，不落明文。

### REQ-7：断言聚合视图

- **项目级（RunsPage）——独立端点、全项目口径**：`GET /api/platform/projects/{project_id}/assertion-stats` 返回全项目（**非当前分页**）含断言 run 的汇总 `{runsWithAssertions, totalAssertions, passedAssertions}`（带统计窗口 `windowDays` 并随响应返回）。**口径写死**：分子=所有含断言 run 中 `passed=true` 的断言总数，分母=所有含断言 run 的断言总数；无断言 run 不进分子分母。**禁止用 run 列表当前页数据聚合**（那是当页通过率，展示会误导）。
- 批量详情：跨子 run 断言汇总（通过/失败计数 + 失败断言明细列表），建模现有 `_RUN_BATCH_COUNTS_CTE`（`services.py:2599`）的跨 run 聚合，口径同全项目（只统计含断言的子 run）。
- 数据源统一为 `platform_runs.result.assertions`，不新增表；服务端应用层解析（SQLite 对 JSON 聚合不友好）。

### REQ-8：断言编辑器增强

- **批量编辑**：FlowEditorPage 支持选中多个断言步骤后批量改匹配方式/失败策略（复用 RunsPage「先选后批量操作」的 rowSelection + Popconfirm 模式）。
- **录制导入可选生成断言**：`planRecordingImport`（`recording-editor-state.ts:97`）导入时可选把「打开页面/点击」步骤之后生成对应「可见性断言」（默认元素可见），生成结果并入 `RecordingImportPlan.importedSteps` 供用户在 review 阶段删改；默认关闭，用户显式勾选。
- **断言预览试跑**：单条断言步骤可"试跑"，语义为**从流程首步执行到该断言步骤（含）**——复用现成的 `upToStepId` 切片（`runner.py:258-270`，`steps[:index+1]` 含该步），**不新增 `fromStepId`、不改执行内核**。禁止实现成"只执行该断言步骤"：中部断言依赖前面步骤建立的页面上下文（已打开的 URL、登录态、点击后的 DOM），单独执行必然因上下文缺失而失败，结果无意义。试跑走临时执行通道（新端点组装最小 hooks 直调 runner，runner 自行启停浏览器）：不落 `platform_runs`/`platform_run_events`、不进队列、不产生 artifact，结果内联展示 expected/actual，脱敏规则生效。

## Out Of Scope

- URL 匹配断言、网络响应/API 断言（需浏览器路由拦截基础设施，另起任务）。
- 正则匹配方式。
- 录制器捕获断言（断言为编辑器声明式，不进录制事件流；录制只捕获用户交互；REQ-8 的"导入时可选生成"是编辑器侧的声明式补全，不是录制捕获）。
- 断言结果的 webhook/渠道投递载荷扩展（`notification_payload` 本轮不改，外部可达性另起任务）。
- 断言库跨流程引用/复用模板；HTML 报告格式（仅 JSON/XLSX）；断言的定时/告警联动。
- 本任务不处理既有脏状态任务（`08-16-flow-retry-reproduction-correctness`、`08-15-flow-batch-execution-mvp`、`08-15-flow-recording-mvp`、`08-16-legacy-e2e-failures`）的归档收尾。

## Technical Notes

- 技术设计与挂载点边界见 `design.md`；执行清单与验证命令见 `implement.md`。
- 无数据库 schema 变更：断言判定经 `platform_run_events`（`step.asserted`）与 `platform_runs.result`（`assertions` 数组）落地。
- 关键约束：新字段必须进 `STEP_KEYS`，否则不进 revision checksum，导致"改断言不产生新版本"。
- 敏感 run：断言不引入新的 secret 暴露面；`actual` 走既有脱敏路径。
