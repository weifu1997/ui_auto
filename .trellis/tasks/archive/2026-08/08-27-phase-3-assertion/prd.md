# 阶段3 断言体系（统一语义 + 新断言类型 + 报告增强）

## Goal

子任务（父任务: `reference-ui-auto-new-architecture`，D3-D7 已确认）。在阶段0 固化的可改动边界内（`.trellis/spec/guides/architecture-boundaries.md`），完善断言体系：

1. **统一断言语义（R3）**：录制断言 / 编辑器断言 / 执行断言 / 报告语义走同一单源契约，端到端往返零漂移。
2. **新断言类型（③ 可扩展区）**：新增 **URL 匹配断言**（页面级，复用既有 `value`+`assertMatch` 字段，**零新增字段**）；需新基建的类型（网络响应/API 断言）**另起任务，不并入本阶段**。
3. **报告增强（③ 可扩展区可选）**：断言报告增 HTML 变体，与既有 XLSX/JSON 并存。

**边界**：本阶段**必然触碰 ① 稳定契约区**（动作清单 `actionOptions`、`ASSERTION_TYPES`/`ASSERTION_ACTIONS`、断言契约文档、前端 `AssertionRecord` union），见下方「① 稳定契约区触碰论证」；`STEP_KEYS`/`ASSERTION_KEYS`、`step.asserted` 载荷形状与顺序、事件 kind、错误码**均不变**。其余为 ② 可重构区（保行为）+ ③ 可扩展区（纯增量）。

## Requirements

### R3-1 新增「URL 断言」（新断言类型，纯 ③ 可扩展区 + 契约登记）

页面级断言：断言**当前页面 URL** 命中期望值。复用既有断言字段，**不新增任何断言字段**：

- 动作：`URL 断言`；判定 type：`url`。
- 字段：`value`（期望 URL，可含查询串）+ `assertMatch`（`exact`/`contains`，缺省 `contains`）。**复用** `value`（已在 `STEP_KEYS`）与 `assertMatch`（已在 `ASSERTION_KEYS`）→ `revision_snapshot.STEP_KEYS`/`ASSERTION_KEYS` **零改动**，旧快照 checksum 键序不变、可读；新 URL 步骤经既有字段产生新 checksum。
- **无元素**：URL 断言不引用 element（页面级），执行取 `page.url`；`_execute_step` 现有 `locator = … if element else None` 路径天然支持，`_assert_url` 不读 locator、不落 `STEP_ELEMENT_REQUIRED`。
- 语义：`exact` = `actual == expected`；`contains` = `expected in actual`。**不做**空白折叠归一化（URL 无 `trimCompare` 语义，不读该字段）。
- 稳定契约登记（① 触碰点，全部为**值域扩展**，兼容性见后）：
  - `src/domain/model.ts:actionOptions` 增 `"URL 断言"`（前端动作清单，第 109–123 行数组加一项）。
  - `server-py/autoflow/assertion_contract.py:ASSERTION_TYPES` 增 `"URL 断言": "url"`；`src/domain/assertions.ts:ASSERTION_ACTIONS` 增同一映射（两端 parity 同步）。
  - 契约文档 `assertion-field-contract.md` 第 2 节动作→type 映射表增 URL 行；第 1 节字段表 `assertMatch` 归属扩展为「文本 / 属性 / URL」（字段可被多类型共享，逐类型只读自己的字段，枚举互斥规则不变）。
  - 前端 `RunDetailPage.tsx`：`AssertionRecord.type` union 增 `"url"`（第 104 行）；`ASSERTION_TYPE_LABELS` 增 `url: "URL"`（第 110 行）。
  - parity 测试同步（见 Acceptance Criteria）。
- 执行：`runner.py` 新增 `_assert_url(page, step, value)` + `_run_assertion` 分发入口；`step.asserted` 载荷 `{type:"url", passed, expected, actual}`——**形状与顺序契约不变**（type 值域扩展）。
- 编辑器：`AssertionStepPanel.tsx` 增 URL 分支（期望值输入 + `assertMatch` 选择，复用现有匹配方式选择器；**不渲染元素选择**）；`FlowEditorPage.tsx:487` 批量「匹配方式」范围（现文本/属性）扩展含 URL。
- 录制候选：录制为元素级，**不自动生成** URL 断言候选（编辑期由用户添加，自然模式 = 「打开页面」步骤后接 URL 断言）。

### R3-2 断言语义统一收口（R3 统一目标）

- **端到端 parity 验证**：补一条「录制候选断言（可见性/文本含 `trimCompare`/属性）→ 导入 → 执行 `step.asserted` → `result.assertions` → 报告/前端渲染」的字段往返一致性用例（后端或 MSW 前端 spec），证明阶段1 单源契约在录制/编辑器/执行/报告四端零漂移。
- **动作集合一致性**：`AssertionBatchBar` 批量匹配的动作集合与 `actionOptions` 断言子集一致；URL 断言纳入批量匹配（与文本/属性同用 `assertMatch`）。

### R3-3 HTML 断言报告（③ 可扩展区可选）

- `_report.py:build_assertion_report` 增 HTML 变体（新 content type 与 XLSX/JSON 并存）；前端 RunDetailPage 报告导出菜单增「HTML」选项。
- 纯增量：既有 XLSX/JSON 导出契约与产物名规则不变；敏感 run 的脱敏/审计约束同样适用于 HTML 产物（不写明文 secret）。

## ① 稳定契约区触碰论证（超界评审）

| 触碰点 | 改动 | 兼容性论证 | 验证方式 |
|---|---|---|---|
| `src/domain/model.ts:actionOptions` | 数组尾部加 `"URL 断言"` | 纯新增字符串；既有动作/存量快照不受影响，`flow-normalize` 白名单不拒绝未知动作 | `npm run build` + e2e `assertion-contract.spec.ts` |
| `assertion_contract.py` / `assertions.ts` `ASSERTION_*` 映射 | 增 `"URL 断言": "url"` 键 | 新增键；既有 4 键不动 | parity 测试（两端）+ e2e 动作映射 |
| `assertion-field-contract.md` | 第 1/2 节增 URL 行；`assertMatch` 归属扩展 | 文档登记先行；两端模块同步后 parity 即绿 | parity 测试 + 契约文档 diff 评审 |
| `RunDetailPage.tsx` `AssertionRecord` union / labels | union 增 `"url"`、label 增键 | 值域扩展；旧运行 `result.assertions` 无 `url` type，不受影响 | `npm run test:unit` |
| `revision_snapshot.STEP_KEYS` / `ASSERTION_KEYS` | **零改动** | URL 复用既有 `value`+`assertMatch`；旧快照 checksum 键序不变 | 既有快照单测保持全绿 |
| `step.asserted` 载荷与顺序 | **形状/顺序不变**，type 值域扩展 | 前端时间线按载荷形状消费，扩展值域不破坏 | 执行单测 + e2e |

## Acceptance Criteria

- [x] URL 断言贯通录制/编辑器/执行/报告：编辑器可创建（C）、执行判定正确（B）、`step.asserted` 载荷 `{type:"url", passed, expected, actual}` 恒在 `step.completed`/`step.failed` 之前（e2e assertion-contract s3）、报告/统计按 type 渲染（D/E）。
- [x] `_assert_url` 判定矩阵单测：exact/contains、缺省 contains、期望值含查询串、`page.url` 异常（页面未打开）不抛非预期异常；无元素不落 `STEP_ELEMENT_REQUIRED`（`test_assertion_contract_hardening.py` 6 用例）。
- [x] parity 三件套绿：后端 `test_assertion_contract.py`、前端 `assertions-contract.test.ts`、e2e `assertion-contract.spec.ts`（动作映射含 URL）。
- [x] `STEP_KEYS`/`ASSERTION_KEYS` 零改动；既有修订快照 checksum 单测保持全绿（旧快照可读）。
- [x] R3-2 端到端往返一致性用例绿（录制候选 → 执行 → 报告字段零漂移）；批量匹配覆盖 URL（`run-detail-assertion.test.tsx` URL 往返用例 + `applyBatchMatch` 含 URL）。
- [x] R3-3（采纳）HTML 报告导出可用，敏感 run 不泄漏 secret；XLSX/JSON 行为不变（`test_assertion_report.py` HTML 脱敏转义 + 既有 JSON/XLSX 用例保持绿）。
- [x] `npm run test:all` 全绿（阶段完整验收门禁，e2e 断言/录制/执行 spec 不回归）。

## Non-Goals

- **网络响应 / API 断言**：需 Playwright response 捕获新基建，**另起任务**（master-prompt 阶段3 草案明确「需新基建的另起任务」）。
- 不改 `step.asserted` 载荷形状 / 顺序、事件 kind、错误码枚举、`STEP_KEYS`。
- 不改录制事件 kind / 顺序；不自动生成 URL 断言候选（录制是元素级）。
- 不引入外部 AI / 第三方服务；不引入新运行依赖（URL 断言仅用 `page.url`）。
- 阶段4（recharts / 编排体验 UI）不提前开工。

## 依赖 / 回滚

- 无新依赖。
- 触碰 ① 的提交**单独拆分**：契约登记（`actionOptions` + `ASSERTION_*` + 契约文档 + parity）一个提交，执行/编辑器/报告一个提交；任一可独立 revert，旧行为完好。
- 每步 gate：`npm run lint && npm run build && npm run test:unit`（前端步）/ `npm run test:py`（后端步）；阶段验收 `npm run test:all`。
