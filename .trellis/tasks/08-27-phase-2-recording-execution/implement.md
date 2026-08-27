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
- [x] B4. [gate] 通过：`npm run test:py` 268 全绿（262 基线 + 6 启停用例；断言/取消/重试/并发不回归）。提交 `081bfab`。

## 阶段 C：D6 后端 — 会话元数据落库 + 重启「已中断」+ 列表端点（R2-3 后端）

- [ ] C1. 增量迁移 v15：新增 `recording_sessions` 表（id/project_id/owner_id/flow_id/environment_id/status/current_url/last_seq/event_count/step_count/created_at/last_activity_at/expires_at/error_code）。
- [ ] C2. `RecordingCoordinator` 在会话创建/状态迁移时同步元数据到库（start/update/terminal）；浏览器 context、登录快照（`RecordingSessionStateStore`）、录制结果保持进程内（D6 折中）。
- [ ] C3. 重启恢复：启动时把遗留非终态会话标记 `interrupted`；`_require_session` 对已持久化会话返回元数据而非 404；`_TERMINAL_STATUSES` 增 `interrupted`。
- [ ] C4. 新端点 `GET /api/platform/projects/{project_id}/recording-sessions`（分页，含已中断）→ `handler/recordings.py`；owner/scope 走 `_recording_session_for_owner` 模式。
- [ ] C5. [gate] `npm run test:py` 全绿（迁移/协调器持久化/恢复/列表端点）+ `npm run test:startup`（重启恢复路径覆盖）。

## 阶段 D：D6 前端 — interrupted 状态 + 列表端点消费（R2-3 前端）

- [ ] D1. `RecordingSessionStatus` 增 `"interrupted"`（platform-api.ts:1061）；`decodeRecordingSession` 兼容；新增 `listRecordingSessions` API 函数。
- [ ] D2. `terminalStatuses`（recording-editor-state.ts:14）增 `interrupted`；`isTerminalRecordingStatus` 覆盖；FlowEditorPage 终态横幅加「已中断」文案（965 起）。
- [ ] D3. 恢复挂载（560–581）：sessionStorage 无 id 时查询最近会话发现已中断会话并显示终态横幅（不自动重启录制）。
- [ ] D4. [gate] `npm run lint && npm run build && npm run test:unit` 全绿（recording-editor-state 既有用例 + 新增）。

## 阶段 E：@tanstack/react-virtual 长列表虚拟化（R2-4）

- [ ] E1. 引入 `@tanstack/react-virtual`（评估许可证/维护度后入 dependencies）；不进入后端。
- [ ] E2. `RecordingImportPanel.tsx`：步骤列表（≤1000）/元素列表/候选断言列表虚拟化；滚动容器替换，视觉与无障碍不回归。
- [ ] E3. `RunDetailPage.tsx`：运行日志列表（≤500）虚拟化。
- [ ] E4. [gate] `npm run lint && npm run build && npm run test:unit`（虚拟列表相关用例）+ `npm run check:bundle`（bundle ≤ 500 kB）。

## 阶段 F：D5 定位器自愈 MVP（R2-5）

- [ ] F1. 新增 `server-py/autoflow/locator_score.py`：`LocatorScorer` 接口（`score(locator, page) -> float` 预留可选 LLM 实现）+ 纯启发式实现（dom-to-locator 风格评分 + `count()===1` 唯一性）。
- [ ] F2. `runner.py:_locator_for`（115–149）定位失败时：生成候选备用定位器 → 启发式评分 → 选唯一命中者回退；发射既有 `step.locatorFallback` 事件（载荷遵守现有契约，恒在 `step.failed`/`step.completed` 之前）。
- [ ] F3. 安全边界：自愈不绕过敏感字段脱敏/审计；仅作用于定位器重试。
- [ ] F4. [gate] `npm run test:py`（自愈单测）+ 既有取消/重试 e2e 不回归。

## 阶段 G：R2-6 候选断言有界化

- [ ] G1. `recording-editor-state.ts:planRecordingImport`（202–214）：可见性断言加生成上限（配合虚拟化保证 import 面板可读）；文本/属性断言既有 cap 保持。
- [ ] G2. [gate] `npm run lint && npm run build && npm run test:unit` + `npm run test:py` 全绿。

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
