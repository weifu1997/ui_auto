# 实现 Prompt：流程自动断言 MVP（含导出 / 聚合 / 编辑器增强）

> 自包含实现任务书。目标仓库：ui_auto（Python 3.12 + FastAPI 后端在 `server-py/`，React 19 + TS + Antd 6 前端在 `src/`，SQLite）。
> 按阶段顺序实现；每个 [gate] 必须全绿才能进入下一阶段；全部完成后跑总门禁。
>
> **任务目录与权威文件**：本任务目录为 `.trellis/tasks/08-21-flow-assertion-mvp/`，配套文件分工——`prd.md` 是**需求权威**（范围、验收标准 AC1-AC12 以它为准）；`design.md` 是设计依据（架构边界、契约取舍、回滚方案）；`implement.md` 是有序执行清单（阶段 A–I 与本 prompt §4 一一对应，逐步勾选进度）；`agent-prompt.md`（本文件）是它们的压缩执行版。若本文件与 prd/design 表述冲突，**以 prd.md / design.md 为准**并修正本文件对应段落；实现完成度以 prd.md 的 AC 为最终裁决。动手前先读这四份文件，再按 §1 复核代码锚点。

---

## 0. 任务目标

让流程自带「执行结果是否正确」的判定能力：

1. 流程中可声明 4 种断言步骤（可见性 / 文本 / 元素数量 / 属性值），执行时自动判定通过/失败；
2. run 结果与事件流能区分「断言失败」与「普通操作失败」，失败时能定位期望值 vs 实际值；
3. 断言结果可从 run 导出为报告（JSON/XLSX），可在运行列表与批量详情中聚合查看；
4. 编辑器支持断言的独立配置面板、批量编辑、录制导入时可选生成断言、单条断言试跑。

---

## 1. 现状（已勘察，勿重复调研，但动手前请复核锚点）

- 已有两个断言动作雏形，位于 `server-py/autoflow/runner.py:216-223`：
  - `可见性断言`：`locator.wait_for(state="visible", timeout)`，失败即抛错；
  - `文本断言`：`value not in text_content()` 时抛 `TEXT_ASSERTION_FAILED`。
  这两个动作名在 `src/mock-data.ts:91` 的 `actionOptions` 中可选，编辑器步骤表单（`src/FlowEditorPage.tsx` 的 StepForm，约 :1740-1810）对断言类动作把 value 字段标为「期望值」。
- 执行内核：`execute_browser_run`（`runner.py:247`），逐步骤分发，事件经 `hooks["event"]` 发出（`step.started` / `step.completed`+`step.succeeded` / `step.failed`，见 `runner.py:293-369`）；`failurePolicy`（`立即失败`/`继续执行`/`重试 1 次`）在 `runner.py:301,355` 控制中止/继续/重试。返回 dict 含 `status/completedSteps/totalSteps/elapsedMs/flowOutputs`（`runner.py:381-399`），由 `ManagedRunner`（`managed_runner.py:188`）消费并落 `platform_runs.result`。
- 事件持久化在 `platform_run_events`（run_id, kind, data），`services.run_response`（`services.py:3201`）把 events 与 `**run`（含 result）一并返回给 `GET /api/platform/projects/{project_id}/runs/{run_id}`（`handler.py:3772`）。
- **硬约束**：revision snapshot 只取白名单字段，`STEP_KEYS` 在 `server-py/autoflow/revision_snapshot.py:17`。新步骤字段不加进去会被剔出 revision checksum，导致「改断言不产生新 revision」且 retry/batch 克隆丢失断言。
- run 结果载荷构造在 `services.py`：`run_response`（:3201，`**run` 展开 result）、`notification_payload`（:3819，**本轮不改**）。
- 批量执行：`run_batches` 表（`migrations.py:543-569`），batch detail 端点 `handler.py:3930`，跨 run 聚合模型 `_RUN_BATCH_COUNTS_CTE`（`services.py:2599`）。
- 前端类型：`FlowStep` 在 `src/mock-data.ts:73`；`normalizeStep` 在 `src/flow-normalize.ts:8`（`...step` 展开，新字段会透传，需补类型与默认值）。RunDetail 事件渲染在 `src/RunDetailPage.tsx:97` 附近。
- 导出基建：`openpyxl` 已在依赖（当前仅用于 dataset 导入，`services.py:3969/4526`）；artifact 存储 `platform_artifacts`（`services.py:220`），登记模式见 `services.py:3463`，下载端点 `GET /api/platform/artifacts/{artifact_id}`（`handler.py:4334`，FileResponse + `require_project_role`）。
- 编辑器：StepForm（`FlowEditorPage.tsx` :1740 起）；批量选择模式参考 `src/pages/RunsPage.tsx:458/604`（rowSelection + Popconfirm）；录制导入 `planRecordingImport`（`src/recording-editor-state.ts:97`，返回 `RecordingImportPlan` 于 :170 附近）；「运行到此步骤」走 `run(upToStepId)`（`FlowEditorPage.tsx:917/962` → `createPlatformRun(..., { upToStepId })`），内核按 `upToStepId` 截断（`runner.py:258-270`）。

---

## 2. 数据契约（实现必须遵守）

### 2.1 步骤 schema

保留现有动作名，新增 2 个；**不引入统一 assertType 字段**，由 `action` 区分类型（向后兼容既有步骤）：

| 动作 | 语义 | 使用的字段 |
|---|---|---|
| `可见性断言`（已有） | 元素可见/不可见 | `element`, `assertVisibility` |
| `文本断言`（已有） | 元素文本命中期望值 | `element`, `value`, `assertMatch` |
| `数量断言`（新增） | 匹配元素个数与期望数的关系 | `element`, `value`, `assertOperator` |
| `属性断言`（新增） | 元素属性值命中期望值 | `element`, `value`, `assertAttribute`, `assertMatch` |

新增 4 个**可选** `FlowStep` 字段（**每个字段只属于一种断言类型，枚举互斥，不得跨类型取值**）：

- `assertMatch?: "exact" | "contains"` —— 仅文本/属性断言使用
- `assertVisibility?: "visible" | "hidden"` —— 仅可见性断言使用（**不**复用 assertMatch，避免同字段双枚举在编辑器校验与回归测试中混淆）
- `assertOperator?: "=" | ">" | "<" | ">=" | "<="` —— 仅数量断言使用
- `assertAttribute?: string` —— 仅属性断言使用（属性名，如 `value` / `disabled` / `href`）

默认值语义（向后兼容，旧流程行为不得变化）：文本断言缺省 `contains`；可见性断言缺省 `visible`。
**严格校验**：文本/属性断言出现 `assertMatch: "visible"`、可见性断言出现 `assertVisibility: "exact"` 等跨类型值属于非法数据——后端执行时视为该字段缺省（回落默认值）而非抛错（旧数据宽容），编辑器按动作类型限定下拉可选值，从源头杜绝。

数值转换：数量断言的期望数存在 `value` 里，而 `FlowStep.value` 类型是 `string`（与所有其他动作共用）。编辑器保存数量断言时写入数字的字符串形式（如 `"5"`，输入框只允许非负整数）；**后端执行前必须 `int(value)` 强转**，转换失败（非数字）视为该断言失败（`ASSERTION_FAILED: count expected=<原值> actual=invalid`），不得让字符串与数字直接比较（`"5" != 5`）。单测须覆盖 value 为数字字符串的正常路径与非法字符串的失败路径。

### 2.2 revision snapshot

`revision_snapshot.py` 的 `STEP_KEYS` 追加 `assertMatch`、`assertVisibility`、`assertOperator`、`assertAttribute` 四个字段。必须加回归测试：改断言字段产生新 revision checksum；无新字段的旧流程 checksum 不变。

### 2.3 事件契约

新增事件 kind `step.asserted`，断言步骤**无论成败**都发。**发送顺序是契约的一部分，必须固定**：

```
执行断言 → 发 step.asserted → 按判定结果发 step.completed（成功）或 step.failed（失败）
```

即 `step.asserted` 恒在对应的 `step.completed`/`step.failed` **之前**发出。前端时间线渲染依赖此顺序（断言判定先于步骤结论出现）；「重试 1 次」时每次尝试各发一组（asserted 在前），最终结论事件在最后。

```json
{"index": 3, "stepId": "step-3", "title": "断言：订单号可见",
 "type": "visibility", "passed": true, "expected": "visible", "actual": "visible",
 "durationMs": 120}
```

`type` ∈ `visibility | text | count | attribute`。`expected`/`actual` 统一为字符串（数量断言为数字的字符串形式），前端无需按类型做异构处理。

### 2.4 结果载荷

`execute_browser_run` 返回 dict 新增 `assertions` 数组（成功与失败路径都要带）：

```json
{"stepIndex": 2, "stepId": "step-3", "title": "订单号可见",
 "type": "visibility", "passed": true, "expected": "visible", "actual": "visible", "durationMs": 120}
```

`services.run_response` 经 `**run` 展开自动透出，**预计零改动**；若 result 在别处被裁剪字段则补。

### 2.5 判定语义（复用 failurePolicy，已确认）

- `立即失败`（默认）：断言失败 → 走现有中止路径，run 判 `failed`；
- `继续执行`：软断言，仅记录 `step.asserted(passed:false)`，流程继续，run 最终状态按其余步骤；
- `重试 1 次`：先重试一次，仍失败按失败策略。
- 断言失败抛出的异常信息保持结构化：`ASSERTION_FAILED: <type> expected=<...> actual=<...>`（沿用 `TEXT_ASSERTION_FAILED` 风格）。

---

## 3. 需求清单（以 `prd.md` REQ-1–REQ-8 为权威）

各需求的完整验收口径在 `prd.md`，执行细节与门禁在 §4；下表仅给定位，**不重复需求正文**：

| # | 需求 | 权威文本 | 执行落点（本文件） |
|---|------|---------|------------------|
| REQ-1 | 断言类型（四件套） | prd REQ-1 + §2.1 | 补充唯一细节：属性断言的属性名在编辑器给常用下拉（value/disabled/href/checked/text）+ 允许自定义；正则匹配明确不做 |
| REQ-2 | 判定语义（复用 failurePolicy） | prd REQ-2 + §2.5/2.3 | §4 B |
| REQ-3 | Schema 与快照放行 | prd REQ-3 + §2.1/2.2 | §4 A/B |
| REQ-4 | 编辑器独立断言配置面板 | prd REQ-4 | §4 D |
| REQ-5 | 结果展示（独立断言结果区块） | prd REQ-5 | §4 E |
| REQ-6 | 断言报告导出（端点/状态码/截图关联） | prd REQ-6 | §4 F |
| REQ-7 | 断言聚合视图（全项目口径独立端点） | prd REQ-7 | §4 G |
| REQ-8 | 编辑器增强（批量编辑/导入生成/试跑） | prd REQ-8 + §2.3 | §4 H |

---

## 4. 分阶段实现清单

**A. Schema 与快照放行（后端基础）**
1. `mock-data.ts`：`FlowStep` 加 4 可选字段；`actionOptions` 加 `数量断言`、`属性断言`。
2. `flow-normalize.ts`：`normalizeStep` 补 4 字段默认值/透传。
3. [gate] `npm run lint && npm run build`。

**B. Runner 断言执行**
1. `runner.py`：抽 4 个纯函数 `_assert_visibility/_assert_text/_assert_count/_assert_attribute`，返回 `(passed, expected, actual)`；既有 `可见性断言`/`文本断言` 分支改为调用对应函数（缺省值语义不变）；新增 `数量断言`/`属性断言` 分支。hidden 断言注意区分「不存在」与「存在但隐藏」。
2. `revision_snapshot.py` `STEP_KEYS` 追加 4 字段。
3. 断言失败抛 `ASSERTION_FAILED: <type> expected=... actual=...`；`execute_browser_run` 捕获后写 `assertions` 数组 + 发 `step.asserted`，再走既有 failurePolicy 逻辑；返回 dict（成功/失败两路）带 `assertions`。
4. [gate] `npm run test:py`：新增 `server-py/tests/unit/test_assertions.py` —— 四类型 ×（通过/失败）≥8 例；文本/属性 exact 与 contains 各 ≥1；数量断言覆盖 `=` 与 `>=`；断言失败+`继续执行`不中止且有 `step.asserted(passed:false)`；旧流程无新字段仍正常执行。

**C. 结果与 API 透出**
1. 确认 `run_response` 的 `**run` 展开已透出 `result.assertions`（预计零改动）。
2. 脱敏单测：断言 `actual` 命中 secret 值时落库/返回为脱敏值。
3. [gate] `npm run test:py`。

**D. 编辑器断言面板**
1. `FlowEditorPage.tsx`：断言步骤 → 独立配置面板（按类型渲染）；非断言步骤不变。
2. [gate] `npm run test:unit`：面板打开/切换类型/保存字段/旧流程默认值 用例。

**E. RunDetail 断言结果区块**
1. `RunDetailPage.tsx`：独立「断言结果」区块 + 时间线 `step.asserted` 判定着色。
2. [gate] `npm run test:unit`：有/无断言、失败展示 expected vs actual。
3. [gate · 核心链路冒烟] 新增 `tests/assertion-contract.spec.ts`（最小 e2e，真实 Chromium）：打开页面 → 一条文本断言通过 → 断言 `GET /runs/{id}` 响应中 `run.result.assertions` 形状正确（`type/passed/expected/actual` 齐全）且 `step.asserted` 事件可见。此门验证 B/C 确立的跨层契约**真实流通**；F/G/H 全部依赖该契约，只有它通过后才允许开工，避免在错误契约上叠加导出/聚合/编辑器增强。

**F. 断言报告导出**
1. `services.py` `build_assertion_report(run, format)`：JSON 序列化 / openpyxl 写 sheet（列：序号/步骤/类型/判定/期望/实际/耗时）；按 `run_id` + name 前缀（`failure-step-` / `trace.zip`）关联失败截图与 trace 的 artifact 引用（缺失留空）；`actual` 走 `redact_run_value`。
2. 写 artifact_directory + 插 `platform_artifacts`（模式同 `services.py:3463`）；`handler.py` 加 `POST .../assertion-report?format=json|xlsx`（权限建模 `handler.py:4334`）；状态码：成功 201 + `{"artifact": {...}}`、run 不存在 404、无权限 403、无断言 409。
3. `RunDetailPage` 导出按钮，走现有 artifact 下载。
4. [gate] 单测（两种格式、脱敏、截图/trace 引用存在与缺失、409/404）+ `npm run test:py`。

**G. 断言聚合视图**
1. 服务端：新增独立端点 `GET /projects/{project_id}/assertion-stats`（**全项目口径**，禁止用分页数据聚合；按 `project_id` 扫描 `platform_runs` 应用层累加，带统计窗口 `windowDays` 并随响应返回）；batch detail 附加跨子 run 断言计数 + 失败明细（建模 `services.py:2599`，口径同全项目：只统计含断言的子 run）。
2. `RunsPage` 计数列旁加断言通过率（读独立端点，带窗口说明）；batch detail 加「断言」汇总。
3. [gate] 单测（全项目口径 vs 分页口径的区分、有/无断言 run、混合状态、窗口边界）+ `npm run test:unit && npm run test:py`。

**H. 编辑器增强**
1. 断言步骤 rowSelection + 批量操作条（匹配方式/失败策略）。
2. `planRecordingImport` 追加 `generatedAssertions` 候选；导入弹窗默认不勾选，勾选并入 `importedSteps`。
3. 临时执行通道（新端点 `POST /runs/preview`）：组装最小 hooks（对照 `managed_runner.py:175-185`：signal/artifact_path/artifact/event/browser，其中 artifact 与 browser 为空操作）直接调 `execute_browser_run`，**复用现成 `upToStepId` 切片，不改执行内核**；不落库不入队，返回 result（含 `assertions`）内联；脱敏规则生效。UI 断言「试跑」传 `upToStepId=该断言步骤 id`。**Python 级自测必须先行**：在 `server-py/tests/unit/` 覆盖临时通道——传 `upToStepId` 只执行到该步（含）、不产生 `platform_runs`/`platform_run_events` 记录、返回含 `assertions`、`upToStepId` 不存在时沿用既有 `RUN_STEP_NOT_FOUND` 报错。
4. [gate] `npm run test:py`（覆盖第 3 步临时通道，执行内核相关路径必须 Python 级自测把门，不能只靠前端单测）+ `npm run test:unit`：批量编辑、导入生成（默认关/勾选，生成步骤用 `assertVisibility`）、试跑 UI 不产生正式 run。

**I. 端到端与收尾**
1. 新增 `tests/assertion.spec.ts`（真实 Chromium）：打开页面 → 文本断言通过 → 数量断言失败（继续执行）→ 结果载荷/事件断言一致；另断言报告导出与 RunDetail 区块。
2. [gate 总门禁] `npm run test:all`（= `build && lint && test:unit && test:startup && test:py && check:bundle && test:e2e && test:windows`）。注意：
   - `test:startup` 覆盖生产启动契约——F 新增的导出端点与 G 的聚合改动都可能触碰启动/环境契约，不能跳过；
   - `check:bundle` 是包体积预算——D/H 新增前端代码可能超限，超限时按既有拆分策略处理而不是放宽预算；
   - 非 Windows 环境 `test:windows` 豁免（仓库 CI 仅在 Windows 执行该项），其余子项必须全绿。
3. 回归：retry/batch 既有 spec 不回归（断言字段进 snapshot 后 retry 一对一克隆仍正确；试跑通道不影响正式 run 计数；D/E/H 改过 `FlowEditorPage`，录制、workbench 等走该页面的既有 e2e 必须一并通过）。

---

## 5. 验收标准

- AC1：四类型断言单测覆盖通过/失败；文本/属性 `assertMatch` exact+contains 各 ≥1；数量断言覆盖 `=` 与 `>=`（含 value 为数字字符串 `"5"` 与非法字符串两条路径）；可见性断言 `assertVisibility` visible/hidden；跨类型误值（如文本断言带 `assertVisibility`）回落默认不报错；断言失败+继续执行不中止。
- AC2：断言失败+立即失败 → run `failed`，`result.assertions` 含 `passed:false` + expected/actual，`step.asserted` 与 `step.failed` 事件均可查，且 **`step.asserted` 恒在对应 `step.completed`/`step.failed` 之前**（顺序契约）。
- AC3：改断言字段产生新 revision checksum；旧流程 checksum 不变。
- AC4：retry 克隆的 run 完整携带并执行断言（回归 `test_retry_snapshot.py` + `retry-reproduction.spec.ts`）。
- AC5：编辑器断言面板可配置全部四类并保存；非断言步骤表单无行为变化。
- AC6：RunDetail 断言区块正确展示（含失败 expected vs actual），无断言不显示。
- AC7：e2e 真实 Chromium 断言判定与载荷/事件一致。
- AC8：断言 `actual` 命中 secret 不落明文。
- AC9：报告可导出 JSON 与 XLSX，权限与现有 artifact 下载一致，脱敏生效，无断言 409。
- AC10：断言通过率来自独立端点 `GET /projects/{id}/assertion-stats` 的**全项目口径**（非分页数据聚合），无断言 run 不进分子分母；batch detail 跨子 run 断言汇总口径一致。
- AC11：批量编辑生效；录制导入默认不生成、勾选后生成可删改（生成步骤用 `assertVisibility`）；试跑内联展示且**不落 `platform_runs`/`platform_run_events`、不进队列**（临时通道）。
- AC12：总门禁 `npm run test:all` 全绿（build / lint / test:unit / test:startup / test:py / check:bundle / test:e2e；非 Windows 环境 test:windows 豁免），且 E3 核心链路冒烟与 H 的 `test:py` 内核门禁均已在对应阶段通过。

---

## 6. 范围外（明确不做）

- URL 匹配断言、网络响应/API 断言；正则匹配。
- 录制器捕获断言（REQ-8 的导入生成是编辑器侧声明式补全，不是录制捕获）。
- `notification_payload`（webhook/渠道投递载荷）扩展——外部可达性另起任务。
- 断言库跨流程复用、HTML 报告格式、断言定时/告警联动。
- 本任务不处理仓库内既有脏状态任务（retry P0 / batch / recording / legacy-e2e）的归档。

## 7. 约束与风险提示

- `server-py/autoflow/runner.py` 是执行内核，改动影响**所有** run；`revision_snapshot.py` 是 revision 语义核心。这两处改完必须跑全量 e2e。
- 向后兼容是硬要求：既有 `可见性断言`/`文本断言` 步骤（无新字段）执行行为不得变化。
- 无数据库 schema 变更；`result`/事件 `data` 均为 JSON 列直接承载。
- 敏感 run（含 secret）：tracing/截图禁用的现有逻辑不得被破坏；断言展示值一律走脱敏路径。
- 提交按仓库惯例 `type(scope): message`（如 `feat(platform): ...` / `feat(frontend): ...` / `test(e2e): ...`），分阶段独立提交，避免一笔巨型 commit。
