# Implement: 阶段3 断言体系（URL 断言 + 语义统一 + 报告增强）

有序执行清单。每步标注可验证产物；`[gate]` 标记的验证命令必须全绿才能进入下一步。
边界约束：① 触碰点（`actionOptions`/`ASSERTION_*`/契约文档/`AssertionRecord` union）只做**值域扩展**，独立提交可 revert；`STEP_KEYS`、`step.asserted` 载荷形状与顺序、事件 kind、错误码不变。

---

## 阶段 A：URL 断言契约登记（R3-1 ① 触碰点，独立提交）

- [x] A1. `assertion_contract.py:ASSERTION_TYPES` 增 `"URL 断言": "url"`；`src/domain/assertions.ts:ASSERTION_ACTIONS` 增同一映射（两端同步）。
- [x] A2. `src/domain/model.ts:actionOptions` 增 `"URL 断言"`（前端动作清单）。
- [x] A3. 契约文档 `assertion-field-contract.md`：第 2 节动作→type 映射表增 URL 行；第 1 节字段表 `assertMatch` 归属扩展「文本 / 属性 / URL」。
- [x] A4. parity 三件套同步：后端 `test_assertion_contract.py` 映射断言、前端 `assertions-contract.test.ts` 映射 + actionOptions 覆盖断言、e2e `assertion-contract.spec.ts` 增 URL 断言步骤（s3，无元素）走真实链路。
- [x] A5. [gate] 通过：`npm run lint`（0 警告）&& `npm run build`（✓ built）&& `npm run test:unit` 116 全绿 && `npm run test:py` 282 全绿（parity 已含 URL 映射）。

## 阶段 B：URL 断言执行（R3-1 执行）

- [x] B1. `runner.py` 新增 `_assert_url(page, step, timeout_ms, value)`：取 `page.url`，`assertMatch` exact/contains（缺省 contains）；不读 locator、无 `trimCompare` 语义、无 `STEP_ELEMENT_REQUIRED`；页面取 URL 异常按「不可用」判定不抛。
- [x] B2. `_run_assertion` 分发入口增 URL 断言分支（locator=None 走通，type 严格来自映射）。
- [x] B3. 单测 `test_assertion_contract_hardening.py` 增 6 用例：contains 缺省/子串未命中/exact/查询串/页面异常不抛/分发无 locator。
- [x] B4. [gate] 通过：`npm run test:py` 288 全绿（282 基线 + 6 URL 用例）。

## 阶段 C：URL 断言编辑器（R3-1 编辑器）

- [x] C1. `AssertionStepPanel.tsx`：URL 断言分支——期望值输入 + `assertMatch` 选择（复用现有匹配方式选择器）；**不渲染元素选择**（元素选择器 51-67 对 URL 断言隐藏）。
- [x] C2. `FlowEditorPage.tsx:489` 批量「匹配方式」范围（现文本/属性）扩展含 URL；`消息.info("匹配方式仅对文本/属性/URL 断言步骤生效")` 文案同步；`assertion-step-draft.ts:staleAssertionFields` 增 URL 断言分支（保留 assertMatch，不落「全部清除」）。
- [x] C3. 前端单测：断言面板 URL 分支渲染（值输入 + 匹配方式 + 无元素/无跨类型字段）、匹配方式跨动作保留回归、批量匹配覆盖 URL。
- [x] C4. [gate] `npm run lint`（0 警告）&& `npm run build`（✓ built）&& `npm run test:unit` 118 全绿（116 基线 + 2 URL）。

## 阶段 D：断言语义统一收口（R3-2）

- [x] D1. `RunDetailPage.tsx`：`AssertionRecord.type` union 增 `"url"`；`ASSERTION_TYPE_LABELS` 增 `url: "URL"`。
- [x] D2. 端到端往返 parity：run-detail 断言 spec 增 URL 用例——`step.asserted`（type=url）与 `result.assertions` 同源载荷 → 前端渲染「URL断言」标签 + 期望/实际 code + 时间线判定行，字段零漂移（配合 e2e `assertion-contract.spec.ts` URL 步骤 s3）。
- [x] D3. `AssertionBatchBar` 批量匹配动作集与 `actionOptions` 断言子集一致（含 URL）：`applyBatchMatch` 目标已扩至文本/属性/URL，匹配选项复用 contains/exact。
- [x] D4. [gate] `npm run test:unit` 119 全绿 + `npm run test:py` 288 全绿。

## 阶段 E：HTML 断言报告（R3-3 可选）

- [x] E1. `_report.py:build_assertion_report` 增 HTML 变体（新 `text/html` content type，与 XLSX/JSON 并存；产物名复用 `assertion-report-{run_id}.html`）；`handler/runs.py` format 白名单增 `html`。
- [x] E2. 敏感 run 约束：HTML 产物不写明文 secret——actual 沿用 `redact_run_value` 脱敏结果，且字段 `html.escape` 转义（注入值不成形）。
- [x] E3. `RunDetailPage` 报告导出菜单增「导出 HTML」按钮；`createPlatformAssertionReport` format 类型扩 `"html"`。
- [x] E4. [gate] `npm run test:py` 290 全绿（含 HTML 布局 + 脱敏转义用例）+ `npm run test:unit` 120 全绿（含 HTML 导出用例）。

## 阶段 F：验收与收尾

- [x] F1. 全量门禁 `npm run test:all`（build/lint/unit/startup/py/bundle/e2e/windows；e2e 断言/录制/执行 spec 不回归，含 URL 断言新步骤）——EXIT=0，28 e2e + windows smoke 通过。
- [x] F2. 回滚演练：契约登记独立提交 `88a9bba` 可单独 revert；`STEP_KEYS`/`ASSERTION_KEYS` 零改动（阶段3 五个提交均未触碰 `revision_snapshot.py`，快照 checksum 单测保持绿）。
- [x] F3. spec 同步：`assertion-field-contract.md` 更新（阶段 A 已登记）；`architecture-boundaries.md` ③ 区标记 URL 断言/HTML 报告/自愈 MVP 完成态；阶段3 PRD 验收清单全勾。
- [x] F4. 收尾：阶段4（编排体验 UI）按主提示词顺序开工前先固化其 PRD。

## 风险文件 / 回滚点

- 高风险：`src/domain/model.ts:actionOptions` 与 `assertion_contract.py:ASSERTION_TYPES`（① 触碰）——值域扩展 + parity 三件套把关；独立提交 A 可整体 revert。
- 中风险：`runner.py`（执行内核）——`_assert_url` 纯新增函数 + `_run_assertion` 加一个分支，不触碰既有求值路径。
- 启动前检查：阶段2 验收已全绿（`test:all` exit 0），本阶段每一 `[gate]` 相对该基线比对。
