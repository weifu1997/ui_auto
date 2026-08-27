# Implement: 阶段2 录制/执行稳定性

有序执行清单。每步标注可验证产物；`[gate]` 标记的验证命令必须全绿才能进入下一步。
边界约束：全部改动落在 `.trellis/spec/guides/architecture-boundaries.md` 的②可重构区（保行为）与③可扩展区（纯增量 + 增量迁移），不触碰①稳定契约区。

---

## 阶段 A：recorder.py 行为保持拆分（R2-1）

唯一外部导入 `services/core.py:14 from ..recorder import RecordingCoordinator`；测试导入 `RecorderNormalizer`/`validate_recorder_event`/`recording_target_url` 等。`recorder.py` 保留 shim re-export，import 路径零变化。

- [x] A1. 拆出 `recorder_capture.py`：`RECORDER_INIT_SCRIPT_TEMPLATE` + `RECORDER_INIT_SCRIPT`（注入脚本常量，零 Python 逻辑）。
- [x] A2. 拆出 `recorder_normalizer.py`：`RecorderNormalizer` + `_element_key` + 归一化常量（纯状态机，无 Playwright 依赖；docstring 声明保持）。
- [x] A3. 拆出 `recorder_validation.py`：`sanitize_url`/`url_path`/`recording_target_url`/`recording_url_is_same_origin`/`_bounded_text`/`validate_recorder_event`/`is_sensitive_field`/`BROWSER_EVENT_KINDS`。
- [x] A4. `recorder.py` 收窄为 `RecordingCoordinator` + `_RecordingOperationError` + 协调器常量（1305→662 行）+ shim re-export 全部符号（`services/core.py` 与测试 import 路径零变化）。
- [x] A5. [gate] 通过：`npm run test:py` 262 全绿（含录制 34 用例）+ lint / build / test:unit 114 不回归。提交 `fa355c9`。

## 阶段 B：runner.py 抽公共启停（R2-2，先确认测试覆盖）

- [x] B1. 补测启停路径：新增 `tests/unit/test_runner_lifecycle.py`（6 用例，假 Playwright 栈，含 CM 协议），拆分前对原代码全绿（基线）。
- [x] B2. 抽 `_BrowserSession` context manager + `_is_canceled` + `_close_quietly`（`hooks["browser"]` 回调与 `storage_state` 为唯一差异参数；`tracing_started` 留在调用方 inner finally）：两入口改为使用，拆后 6 用例保持全绿。
- [x] B3. `ManagedRunner._close_browser` 复用 `_close_quietly`（行为等价：逐项 try/except 关闭）。
- [x] B4. [gate] 通过：`npm run test:py` 268 全绿（262 基线 + 6 启停用例；断言/取消/重试/并发不回归）。提交 `91dfecc`。

## 阶段 C：D6 后端 — 会话元数据落库 + 重启「已中断」+ 列表端点（R2-3 后端）

- [x] C1. 增量迁移 v15：`add_recording_sessions`（`migrations.py`）建 `recording_sessions` 表 + `recording_sessions_project_activity` 索引；`test_migration_v15_creates_recording_sessions_table`；`test_migrations.py` 版本清单补 `(15, "recording-sessions-metadata")`。
- [x] C2. `RecordingCoordinator(database=…)`：`_persist_session` UPSERT（尽力而为、失败静默）+ `_maybe_persist_events`（每会话 ≥1s 限频）在 创建/启动/pause/resume/stop/cancel/sweep/close_all/事件/导航 同步元数据；浏览器 context、登录快照（`RecordingSessionStateStore`）、事件流、录制结果保持进程内。`test_create_and_transitions_persist_metadata`、`test_events_persist_throttled_last_seq_and_counts`、`test_without_database_provider_persists_nothing`（无提供者=no-op）。
- [x] C3. `_TERMINAL_STATUSES` 增 `interrupted`；`recover_interrupted()` 启动时把遗留非终态标记 `interrupted` + `COALESCE(error_code,'SERVICE_RESTARTED')`（`services/core.py` 构造后立即调用）；`_require_session` 内存缺失时 `_load_session` DB 回退（非 404）；`session_result` 无归并器返回 `{"result": {}}`。`test_recover_interrupted_marks_leftover_and_keeps_terminal`、`test_require_session_falls_back_to_persisted_metadata`、重启后 reload 校验。
- [x] C4. 新端点 `GET /api/platform/projects/{project_id}/recording-sessions`（分页 page/pageSize，`PAGINATION_INVALID`，含已中断）→ `handler/recordings.py`，owner 经 `require_project_capability(project_id, user.id, "flow.edit")` 作用域（auth 矩阵 `POST GET` 行）；`test_get_recording_sessions_endpoint_returns_persisted` + `test_list_sessions_owner_scoped_paginated_newest_first`。
- [x] C5. [gate] `npm run test:py` 276 全绿（268 基线 + 8 持久化/端点用例；迁移/协调器持久化/恢复/列表端点）+ `npm run test:startup` 14 通过。

## 阶段 D：D6 前端 — interrupted 状态 + 列表端点消费（R2-3 前端）

- [x] D1. `RecordingSessionStatus` 增 `"interrupted"`（platform-api.ts）；`decodeRecordingSession` 白名单兼容；新增 `listRecordingSessions(token, projectId, page, pageSize)` 返回 `{sessions, total, page, pageSize}`（复用 `decodeRecordingSession`）。
- [x] D2. `terminalStatuses` 增 `interrupted`；`isTerminalRecordingStatus` 覆盖；FlowEditorPage 终态横幅改用 `terminalRecordingStatusLabel` 映射（含「已中断」）。
- [x] D3. 恢复挂载：sessionStorage 无 id 时 `listRecordingSessions(…,1,5)` 发现最近「已中断」会话并 `setRecordingSession` 显示终态横幅；不启动轮询、不自动重启录制。
- [x] D4. [gate] `npm run lint`（oxlint 0 警告）&& `npm run build`（✓ built）&& `npm run test:unit` 115 全绿（editor-state `interrupted` 终态 + platform-api list 解码/脱敏用例；MSW handler 补 GET 列表 mock）。

## 阶段 E：@tanstack/react-virtual 长列表虚拟化（R2-4）

- [x] E1. 引入 `@tanstack/react-virtual@^3.14.10`（MIT 许可证经 `npm view` 核实后入 dependencies，评估记录见阶段 PRD）；不进入后端（仅 `src/`）。
- [x] E2. 新增 `src/components/VirtualList.tsx` 通用虚拟列表（绝对定位行 + `measureElement` 动态测量 + `role="list"`/`role="listitem"` 保无障碍）；`RecordingImportPanel.tsx` 步骤/元素/候选断言三处列表改用 `<VirtualList>`（maxHeight 320/200/200），滚动容器 `.virtual-list-scroll` + 行间距 CSS 补齐，视觉与无障碍不回归。
- [x] E3. `RunDetailPage.tsx` 运行日志列表改用 `<VirtualList>`（estimateSize 58、maxHeight 420、`log-row ${level}` 行类保留样式）。
- [x] E4. [gate] 通过：`npm run lint`（oxlint 0 警告）&& `npm run build`（✓ built）&& `npm run test:unit` 115 全绿（含虚拟列表相关用例；jsdom 无布局引擎致 virtual-core `outerSize===0` 不渲染，`test-setup.ts` 为 `.virtual-list-scroll` 容器补桩 offsetHeight/offsetWidth）+ `npm run check:bundle`（≤ 500 kB）通过。

## 阶段 F：D5 定位器自愈 MVP（R2-5）

- [x] F1. 新增 `server-py/autoflow/locator_score.py`：`LocatorScorer` Protocol（`score(locator, page) -> float`，预留可选 LLM 实现，**不引入外部 AI 依赖**）+ `HeuristicLocatorScorer`（dom-to-locator 风格稳定性权重 testid>role>label>text>css/XPath，`count()===1` 唯一性把关，count!=1 返回负无穷）。
- [x] F2. `runner.py`：`_fallback_candidates`（text→常见 role 可访问名、testid→属性子串 `[*=]`、label→`exact=False`、role→去 name）+ `_locator_from_spec`（候选构建并标注来源技术供评分取权重）+ `_heal_locator`（评分取最佳唯一命中者）；`_execute_step` 元素动作（点击/填写/清空填写/选择下拉项/勾选，抽 `_run_element_action`）定位失败时自愈重试一次，发射既有 `step.locatorFallback`（载荷 method/value/reason，恒在 step.completed/step.failed 之前）；主定位正常路径零额外开销（count 校验仅在失败后）。
- [x] F3. 安全边界：自愈仅作用于元素定位重试，不触达 secrets/敏感字段；敏感 run 仍禁 Trace/截图（`run.security` 事件、无 trace 产物），自愈照常生效。
- [x] F4. [gate] 通过：`npm run test:py` 282 全绿（276 基线 + 6 自愈单测：评分唯一性/稳定性、testidPartial 回退与事件顺序、label 子串回退、无唯一命中保持失败、敏感 run 边界）+ 既有取消/重试 e2e 不回归（e2e 为 MSW mock 前端 spec，不触达 Python runner）。

## 阶段 G：R2-6 候选断言有界化

- [x] G1. `recording-editor-state.ts:planRecordingImport`（202–214）：可见性断言加生成上限（配合虚拟化保证 import 面板可读）；文本/属性断言既有 cap 保持。`VISIBILITY_ASSERTION_CAP = 20` 按步骤引用顺序去重取前 20 个元素，达上限即停。
- [x] G2. [gate] 通过：`npm run lint`（oxlint 0 警告）&& `npm run build`（✓ built）&& `npm run test:unit` 116 全绿（115 基线 + 1 可见性 cap 用例）+ `npm run test:py` 282 全绿。

## 阶段 H：验收与收尾

- [ ] H1. 全量门禁 `npm run test:all`（build/lint/unit/startup/py/bundle/e2e/windows；e2e 录制/执行/断言 spec 不回归）。
- [ ] H2. 回滚演练：每个阶段独立提交、独立可回滚；迁移 v15 为增量（回滚时表留无害冗余，无数据迁移）。
- [ ] H3. spec 同步：`.trellis/spec` 更新（录制会话状态契约、`recording_sessions` 表、列表端点、`interrupted` 状态、自愈 LocatorScorer 接口预留）；`architecture-boundaries.md` 拆分后路径更新（recorder.py → recorder 包文件）。
- [ ] H4. 收尾：更新阶段2 PRD 验收清单；阶段3（断言体系）不提前开工。

## 风险文件 / 回滚点

- 高风险：`runner.py`（执行内核）——阶段 B 只抽启停不碰求值；阶段 F 只在 `_locator_for` 失败路径加回退，`step.locatorFallback` 为既有预留 kind（契约不新增）。B 先于 F，避免同文件并发编辑。
- 中风险：`recorder.py` 拆分（最大、录制行为多）——A1-A3 按内聚组拆、shim 保 import，A5 全量录制用例把关。
- 中风险：D6 落库——迁移纯增量新表，协调器状态迁移同步点需逐一覆盖（创建/启动/pause/resume/terminal/sweep）。
- 启动前检查：阶段1 基线已绿（test:all 全过），本阶段每一 `[gate]` 相对该基线比对。
