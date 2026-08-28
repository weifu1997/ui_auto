# Design: 流程自动断言 MVP

## 架构与边界

断言是**流程步骤的一种**，不新增独立实体。整条链路复用现有 run 执行/事件/结果基础设施，只在四个挂载点扩展：

```
FlowStep schema (新增 4 字段 + 2 个断言动作标签)
        │
        ├─ revision_snapshot.STEP_KEYS (白名单放行新字段 → 进 revision checksum)
        │
Runner._execute_step (按 action 分发，断言分支产出结构化判定)
        │
        ├─ hooks.event("step.asserted")  (platform_run_events，可区分断言判定)
        └─ 结果载荷 result.assertions     (platform_runs.result，经 run_response 展开到 API)
                │
Frontend: 编辑器断言面板 + RunDetail 断言结果区块
```

不新增数据库表。断言判定随 run 的事件与结果载荷落地，与现有 `failedStep`/`events`/`flowOutputs` 同构。

## 数据契约

### 1. 步骤 schema（FlowStep）

保留现有两个断言动作标签，新增两个；不引入统一 `assertType` 字段（由 `action` 区分类型，向后兼容既有 `可见性断言`/`文本断言` 步骤）：

| 动作 | 状态 | 语义 |
|------|------|------|
| `可见性断言` | 已有 | 元素可见（默认）/不可见 |
| `文本断言` | 已有 | 元素文本匹配期望值 |
| `数量断言` | 新增 | 匹配元素个数与期望数的关系 |
| `属性断言` | 新增 | 元素某属性值匹配期望值 |

新增 4 个可选步骤字段，**每个字段只属于一种断言类型，枚举互斥**（避免同字段双枚举在编辑器校验、类型定义与回归测试中混淆）：

- `assertMatch?: "exact" | "contains"` — 仅文本/属性断言使用（默认 `contains`，保持既有 `value in actual` 行为）。
- `assertVisibility?: "visible" | "hidden"` — 仅可见性断言使用（默认 `visible`；**不**复用 assertMatch）。
- `assertOperator?: "=" | ">" | "<" | ">=" | "<="` — 仅数量断言使用（默认 `=`）。
- `assertAttribute?: string` — 仅属性断言使用的属性名（如 `value`/`disabled`/`href`）。

期望值沿用 `value`，元素沿用 `element`，超时沿用 `timeout`，失败策略沿用 `failurePolicy`。非断言步骤不产生这些字段。

**跨类型误值处理**：文本断言带 `assertVisibility`、可见性断言带 `assertMatch` 等属于非法数据——后端执行时忽略该字段（回落默认值）而非抛错（对旧/脏数据宽容）；编辑器按动作类型严格限制下拉可选值，从源头杜绝。

**数值转换**：数量断言期望数存 `value`（`FlowStep.value` 为 `string`，与所有动作共用）。编辑器存数字的字符串形式（输入框只允许非负整数）；后端执行前 `int(value)` 强转，转换失败视为该断言失败（`ASSERTION_FAILED: count expected=<原值> actual=invalid`），禁止字符串与数字直接比较。

### 2. 事件契约

新增事件 kind `step.asserted`，断言步骤成功/失败时都会发（携带判定结果），且恒在对应结论事件之前（顺序契约见下）：

```json
{
  "index": 3,
  "stepId": "step-3",
  "title": "断言：订单号可见",
  "type": "visibility",
  "passed": true,
  "expected": "visible",
  "actual": "visible",
  "durationMs": 120
}
```

`type` ∈ `visibility | text | count | attribute`；`expected`/`actual` 统一为字符串（数量断言为数字的字符串形式）。

**发送顺序是契约**：`执行断言 → 发 step.asserted → 按判定结果发 step.completed（成功）/ step.failed（失败）`，即 `step.asserted` 恒在对应结论事件之前（前端时间线渲染依赖此顺序）；「重试 1 次」每次尝试各发一组，最终结论事件在最后。断言失败时按 `failurePolicy` 决定：`立即失败`/`重试 1 次`（耗尽后）抛出 → 中止；`继续执行` → 仅记录判定，流程继续。

### 3. 结果载荷契约

`execute_browser_run` 的返回 dict 新增 `assertions` 数组（每个断言步骤一条，含失败后重试仍失败的情形）：

```json
{
  "status": "success",
  "completedSteps": 5,
  "totalSteps": 6,
  "assertions": [
    { "stepIndex": 2, "stepId": "step-3", "title": "订单号可见", "type": "visibility",
      "passed": true, "expected": "visible", "actual": "visible" }
  ],
  "flowOutputs": {}
}
```

`services.run_response` 通过 `**run` 展开 `result`，`assertions` 自动出现在 `GET /runs/{id}` 与 batch detail 的 run 投影中，无需改动 service/handler。`failedStep` 仍取最近一条 `*failed*` 事件，行为不变。

### 4. STEP_KEYS 白名单

`revision_snapshot.py:17` 的 `STEP_KEYS` 追加 `assertMatch`、`assertVisibility`、`assertOperator`、`assertAttribute` 四个字段。否则断言字段被剔出 revision 快照 → 改断言不产生新 revision、执行可能读到旧断言。这是**硬约束**（规范 `run-batch-recording-contracts` 同款机制）。

## 数据流

1. 编辑器保存流程 → `flow.steps[]` 含断言字段。
2. 发布/运行 → revision snapshot 用 `STEP_KEYS` 规范化，断言字段进 checksum。
3. `ManagedRunner` → `execute_browser_run`：
   - 逐步骤分发；断言分支计算 `actual` 并与 `expected` 比对，得到 `passed`。
   - 发 `step.asserted`（无论成败）；失败按 `failurePolicy` 走既有中止/继续/重试路径。
   - 累加 `assertions` 数组，随返回 dict 落 `platform_runs.result`。
4. 前端 `RunDetailPage` 读 `run.result.assertions` + `events` 中 `step.asserted`，渲染断言结果区块与时间线判定。

## 兼容性 / 迁移

- **向后兼容**：既有 `可见性断言`（无 `assertVisibility` → 视为 visible）、`文本断言`（无 `assertMatch` → 视为 contains）行为不变。新增 4 字段全部可选，旧流程零迁移。
- **无 schema 变更**：不新增/改列。`result`/`data` 均为 JSON 列，直接承载。
- **retry/batch**：断言字段进 revision snapshot，retry 克隆原快照即完整复现断言；batch 无特殊处理。
- **敏感 run**：断言不引入 secret 展示；`actual` 若命中敏感字段值，沿用现有 `redact_run_value` 路径（结果落库前已脱敏）。

## 关键取舍

- **不做统一 `assertType` 字段**，而沿用 action 区分：避免破坏既有断言步骤与 `actionOptions` 文案，编辑器按 action 渲染对应面板即可。代价：runner 用 action 字符串分发（与现状一致，`runner.py:188` 已是此模式）。
- **断言结果进 `result.assertions` 而非新表**：与 `flowOutputs` 同构，复用 `run_response` 展开，零 service 改动；代价是大断言量时 result JSON 变大（MVP 规模可接受）。
- **匹配方式 MVP 只做 `exact`/`contains`**，不做正则：正则引入注入/可读性风险，收益有限，列为后续。

## 扩展能力设计（REQ-6/7/8）

### 断言报告导出（REQ-6）

- 新增 `POST /api/platform/projects/{project_id}/runs/{run_id}/assertion-report?format=json|xlsx`（**format 走 query**，缺省 `json`），服务层生成报告文件：
  - 数据源：`run_response` 同款 `result.assertions` + `events` 中 `step.asserted` + 失败截图/trace 的 artifact 引用；
  - **截图/trace 关联**：失败截图由 runner 以 `failure-step-{步骤序号}.png`（序号=index+1，`runner.py:333`）、trace 以 `trace.zip`（`runner.py:371`）命名，经 `hooks["artifact"]` 登记进 `platform_artifacts`（按 `run_id`，`services.py:3463`）。报告按 `run_id` + name 前缀（`failure-step-` / `trace.zip`）匹配并引用其 `artifactId`/下载链接；**缺失（无失败截图、敏感 run 禁用截图/trace）则留空，不报错不阻塞**；
  - 写入 `managed_runner.artifact_directory` 下 `assertion-report-{run_id}.{ext}`，插 `platform_artifacts` 行（content_type `application/json` / `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`），复用 `services.py:3463` 的 artifact 登记模式；
  - 返回 `{"artifact": {...}}`，前端用现有 artifact 下载端点（`GET /api/platform/artifacts/{id}`，`handler.py:4334`）拉取；XLSX 用 `openpyxl`（已在依赖，当前仅用于导入）。
- **HTTP 状态码契约**（对齐仓库创建类资源惯例）：成功 `201` + `{"artifact": {...}}`；run 不存在/不属于该项目 `404`；无权限 `403`；run 无断言步骤 `409`。
- 权限：`require_project_role`（与 run detail 一致）。脱敏：`actual` 复用 `redact_run_value`。

### 断言聚合视图（REQ-7）

- 不新增表，数据源统一为 `platform_runs.result.assertions`（JSON 列）。
- **项目级（RunsPage）——独立端点、全项目口径**：`GET /api/platform/projects/{project_id}/assertion-stats`，服务端按 `project_id` 扫描 `platform_runs` 应用层累加（SQLite 对 JSON 聚合不友好），返回全项目（**非当前分页**）含断言 run 的汇总 `{runsWithAssertions, totalAssertions, passedAssertions}`，带统计窗口 `windowDays` 并随响应返回。**口径写死**：分子=所有含断言 run 中 `passed=true` 的断言总数，分母=所有含断言 run 的断言总数，无断言 run 不进分子分母。**禁止用 run 列表当前页数据聚合**——那得到的是当页通过率，展示会误导。
- **批量级**：在 `_run_batch_select` 旁增加断言计数（解析各子 run `result.assertions`），附加到 batch detail 的响应（建模 `_RUN_BATCH_COUNTS_CTE` 的跨 run 聚合形态，`services.py:2599`），口径同全项目（只统计含断言的子 run）。
- 展示：RunsPage 现有计数列旁加断言通过率（读独立端点，带窗口说明）；batch detail 加「断言」汇总行（通过/失败 + 失败明细列表）。

### 断言编辑器增强（REQ-8）

- 批量编辑：FlowEditorPage 断言步骤列表加 rowSelection；选中 ≥1 条后浮现批量操作条（改匹配方式 / 改失败策略），复用 RunsPage rowSelection + Popconfirm 模式（`RunsPage.tsx:458/604`）。
- 录制导入生成断言：`planRecordingImport`（`recording-editor-state.ts:97`）返回前（约 :170）按"每个 打开页面/点击 步骤后追加一条 可见性断言（元素=该步骤元素，`assertVisibility` 缺省 visible）"生成候选，置入 `RecordingImportPlan.generatedAssertions`；导入弹窗默认不勾选，勾选后并入 `importedSteps`，review 阶段可删改。
- 断言试跑：语义为「**从流程首步执行到该断言步骤（含）**」，**复用现成 `upToStepId` 切片（`runner.py:258-270` 的 `steps[:index+1]`，含该步），不新增 `fromStepId`、不改执行内核**。禁止实现成"只执行该断言步骤"——中部断言依赖前面步骤建立的页面上下文（已打开 URL、登录态、点击后 DOM），单独执行必然因上下文缺失而失败，结果无意义。试跑走**临时执行通道**（新端点，body 传与正式 run 同构的执行输入 + `upToStepId`）：组装最小 hooks 直接调 `execute_browser_run`——runner 内部自行启动/关闭浏览器（`runner.py:282`），hooks 只需 5 个键（对照 `managed_runner.py:175-185`）：`signal`（新建 Event）、`artifact_path`/`artifact`（空操作，不落盘不登记）、`event`（写内存收集器供响应回传）、`browser`（空操作）；**不落 `platform_runs`、不写 `platform_run_events`、不进队列、不产生 artifact**，返回 result（含 `assertions`）内联展示 expected/actual；脱敏规则生效。

## 回滚

- 前端：回退 `FlowEditorPage` 断言面板/批量条/试跑、`RunDetailPage` 区块、RunsPage 计数列即可，旧步骤表单仍可用。
- 后端：`STEP_KEYS` 移除新字段 + runner 不读新字段即回到原行为（旧 `可见性/文本断言` 不受影响）；导出/聚合/试跑端点删除即下线，均无 schema 变更。
- 数据：无迁移，回滚不触及存量数据；已导出的报告文件随 artifact 清理策略自然回收。
