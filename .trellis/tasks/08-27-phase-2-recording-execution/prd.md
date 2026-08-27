# 阶段2 录制/执行稳定性（recorder/runner 拆分 + 会话落库中断终态 + 长列表虚拟化 + 自愈 MVP）

## Goal

子任务（父任务: `reference-ui-auto-new-architecture`，D3-D7 已确认）。在阶段0 固化的可改动边界内（`.trellis/spec/guides/architecture-boundaries.md`），完成录制/执行链路的稳定性增强：

1. **行为保持拆分**：`recorder.py`（1305 行）拆文件；`runner.py`（849 行）抽公共启停（先确认测试覆盖）。
2. **D6 录制会话状态折中落地**：会话元数据（status/currentUrl/lastSeq/计数）落库（增量迁移），浏览器 context 与登录快照保持进程内；重启后旧会话显示「已中断」终态而非 404。
3. **D4 引入 `@tanstack/react-virtual`**（候选/日志长列表虚拟化，纯增量）。
4. **R2 吸收参考项目可落地能力**：智能录制/候选元素/重试恢复/执行反馈的缺口收敛；**不引入未确认的外部 AI 服务依赖**。

**边界**：稳定契约区只读——事件 kind/顺序契约（含 `step.locatorFallback` 预留 kind，本阶段仅复用不新增）、错误码枚举、schema、安全面不动；全部为 ② 可重构区（保行为）+ ③ 可扩展区（纯增量，含一条增量迁移）。

## Requirements

### R2-1 recorder.py 行为保持拆分（1305 → 多文件）

唯一外部导入为 `services/core.py:14 from ..recorder import RecordingCoordinator`；测试导入 `RecorderNormalizer` / `validate_recorder_event` / `recording_target_url` 等。按内聚组拆文件，`recorder.py` 保留 shim re-export `RecordingCoordinator` 使 import 路径稳定：

- `recorder_capture.py`：`RECORDER_INIT_SCRIPT_TEMPLATE` / `RECORDER_INIT_SCRIPT`（现 38–247，浏览器注入脚本常量，零 Python 逻辑）。
- `recorder_normalizer.py`：`RecorderNormalizer` + `_element_key` + 归一化常量（现 269–566，纯事件→草稿状态机，无 Playwright 依赖）。
- `recorder_validation.py`：`sanitize_url` / `url_path` / `recording_target_url` / `recording_url_is_same_origin` / `_bounded_text` / `validate_recorder_event`（现 250–709，事件 DTO 校验与 URL 同源守卫）。
- `recorder.py`（或 `recorder_coordinator.py`）：`RecordingCoordinator` + `_RecordingOperationError` + 协调器常量（现 585–1305）。

对外行为零变化：事件 kind/顺序、状态机语义、候选生成优先序（testid→role→label→text→css）、敏感值脱敏、URL 同源守卫均不变。

### R2-2 runner.py 抽公共启停（先确认测试覆盖）

现状：`execute_browser_run`（514–716）与 `execute_element_validation`（742–843）重复三段——启动（`sync_playwright()` + `chromium.launch` + `new_context(locale="zh-CN")` + headless 缺省 + `hooks["browser"]` 注册）、teardown（`hooks["browser"](None,None)` + tracing 停止 + `context.close()` + `browser.close()`）、取消判定（`signal.is_set() or error == "RUN_CANCELED"`）；`ManagedRunner._close_browser`（managed_runner.py:144–156）第三处重复 close。

- 抽 `RunBrowserSession` context manager（或 finally-safe 等价辅助）统一启停；`hooks["browser"]` 回调与 `tracing_started` 为唯一差异参数。
- **先确认测试覆盖**：拆分前为两个入口的启停路径补单测（当前覆盖集中在断言求值），再重构；对外行为零变化。

### R2-3 D6 录制会话元数据落库 + 重启「已中断」终态

- 新增 `recording_sessions` 表（增量迁移 v15）：id / project_id / owner_id / flow_id / environment_id / status / current_url / last_seq / event_count / step_count / created_at / last_activity_at / expires_at / error_code。
- `RecordingCoordinator` 在会话创建与状态迁移（starting/recording/paused/terminal）时同步元数据到库；浏览器 context、登录快照（`RecordingSessionStateStore`，进程内）、录制结果（events/steps/elements）保持进程内（D6 折中）。
- 重启恢复：启动时把遗留非终态会话（starting/recording/paused）标记为「已中断」终态（新增 `interrupted` 状态，两端枚举同步）；`_require_session` 对已持久化会话返回元数据而非 404。
- 前端：`RecordingSessionStatus` 增 `"interrupted"`（platform-api.ts:1061）；`terminalStatuses`（recording-editor-state.ts:14）与后端 `_TERMINAL_STATUSES`（recorder.py:582）同步；FlowEditorPage 终态横幅（965 起）加「已中断」文案；恢复挂载（560–581）对已中断会话显示终态横幅而非继续轮询。
- **列表端点（已确认纳入）**：`GET /api/platform/projects/{project_id}/recording-sessions` 返回最近会话（含已中断，分页），供中断可见性；前端最小消费——恢复挂载时若 `sessionStorage` 无 id，查询该项目最近会话以发现已中断会话并显示终态横幅（不自动重启录制）。

### R2-4 D4 @tanstack/react-virtual 长列表虚拟化（纯增量）

- 引入 `@tanstack/react-virtual`（仅前端运行时依赖，评估许可证/维护度后引入）。
- 虚拟化目标：
  - `RecordingImportPanel.tsx` 步骤列表（≤1000 行，`MAX_LOGICAL_STEPS=1000`）、元素列表、候选断言列表。
  - `RunDetailPage.tsx` 运行日志列表（≤500 行，事件 `LIMIT 500`）。
- 滚动容器替换保持视觉与无障碍（键盘可达、aria 标注不回归）；`check:bundle` 不超预算。
- 非目标：FlowEditorPage 的 `StepList.tsx`（DnD 拖拽列表）不虚拟化（避免 DnD×virtual 复杂度）。

### R2-5 D5 定位器自愈 MVP（执行稳定性，纯启发式）

- `LocatorScorer` 接口抽象（预留可选 LLM 实现，**不引入外部 AI 依赖**）。
- 纯启发式 MVP：dom-to-locator 风格评分 + `count()===1` 唯一性验证，用于 `runner.py:_locator_for`（115–149）定位失败时的候选备用定位器生成与回退。
- 复用既有 `step.locatorFallback` 事件 kind（事件契约已预留，不新增 kind），载荷与顺序遵守现有契约（回退事件恒在 `step.failed`/`step.completed` 之前）。
- 安全边界：自愈只作用于定位器重试，不绕过敏感字段脱敏/审计。
- **（2026-08-28 用户确认纳入阶段2）**。

### R2-6 R2 能力差吸收（可落地项，不引入未确认外部 AI 服务）

- 现状已具备：候选元素生成（`RecorderNormalizer` 优先序 + `planRecordingImport`）、异步调度（recording `ThreadPoolExecutor` + ManagedRunner）、运行重试/恢复（managed_runner + watchdog）、执行反馈（事件/截图/trace）。
- 本阶段落地缺口：
  - **候选断言生成有界**：可见性断言当前无上限（每个引用元素一条，~1000 步场景可近千条）——加生成上限，配合 R2-4 虚拟化保证 import 面板可读。
  - **会话恢复可见性**：R2-3 的「已中断」终态 + 可选列表端点。
- 显式非目标：不引入 AI 自愈模型、不引入外部 AI 服务；智能录制保持在既有启发式范围内增强。

## Acceptance Criteria

- [x] recorder.py 拆分后对外 import/行为零变化；`npm run test:py` 录制相关用例全绿。
- [x] runner.py 公共启停抽出，启停测试覆盖先行；`npm run test:py` + 既有取消/重试用例不回归。
- [x] 迁移 v15 上线；重启后遗留录制会话显示「已中断」终态而非 404；两端枚举同步；`test:startup` 覆盖重启恢复路径。
- [x] react-virtual 接入候选/日志长列表；`check:bundle` 不超预算。
- [x] 自愈 MVP：`LocatorScorer` 接口 + 启发式评分 + `step.locatorFallback` 复用，无外部 AI 依赖。
- [x] R2-6 候选断言有界化：可见性断言 `VISIBILITY_ASSERTION_CAP=20`，文本/属性既有 10 条 cap 保持；配合虚拟化保证 import 面板可读。
- [x] `npm run test:all` 全绿（阶段完整验收门禁，e2e 录制/执行/断言 spec 不回归）。

## Non-Goals

- 稳定契约区只读：不改事件 kind/顺序契约、错误码枚举、schema、安全面；`step.locatorFallback` 为既有预留 kind 的复用。
- 浏览器 context / 登录快照 / 录制结果不落库（D6 折中，仅元数据落库）。
- 不引入外部 AI 服务 / 模型；智能录制不超出既有启发式范围。
- 不虚拟化 DnD 步骤列表（`StepList.tsx`）。
- 阶段3 断言新类型、阶段4 编排体验 UI 不提前开工。

## 依赖 / 回滚

- 新依赖：`@tanstack/react-virtual`（R2-4），评估许可证/维护度后引入；仅前端运行时。
- 迁移 v15 为纯增量（新表，只写会话元数据）；回滚 = revert 阶段提交，`recording_sessions` 表为无害冗余（不含业务关键数据），可留待后续迁移清理，无需数据迁移。
- 每步 gate：`npm run lint && npm run build && npm run test:unit`（前端步）/ `npm run test:py`（后端步）；阶段验收 `npm run test:all`。
