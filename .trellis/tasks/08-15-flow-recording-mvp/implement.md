# Implementation Plan: Flow Recording MVP

## Preconditions

- 保持任务为 `planning`，经人工批准后再执行 `task.py start`。
- 基础 P0 [`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md) 的 A/B flow 回归已通过；录制的 PoC、认证 API 和编辑器阶段可以独立取证。[`08-16-flow-retry-reproduction-correctness`](../08-16-flow-retry-reproduction-correctness/prd.md) 的原 revision checksum、单 run retry 重现单位和审计关联证据仍阻断最终保存/发布/ManagedRunner 重放闭环及 retry regression，不把它复制进录制任务。
- 开发前读取 `.trellis/spec/frontend/index.md`、`.trellis/spec/backend/index.md` 和 cross-layer 指南。
- 先运行基线测试并记录结果；不得把已有失败归因于本功能，也不得修改或删除既有断言来制造通过。
- 先完成 2-3 人日 PoC。PoC 未证明敏感值不泄漏和录制后可重放时，不进入完整 UI 开发。

## Phase 0: Technical Proof

- [x] 建立只服务于测试的本地页面 fixture，覆盖普通输入、password、button navigation、select、checkbox、SPA route 和 iframe。（`server-py/tests/fixtures/recorder/{page1,page2,child}.html`，经本地 HTTP 服务加载）
- [x] 扩展现有 Picker 注入思路，连续捕获 click、input/change 和 top-frame navigation。（`server-py/autoflow/recorder.py` 的 `RECORDER_INIT_SCRIPT`：context init script + `expose_binding`，完整导航后自动重注入）
- [x] 写纯 RecorderNormalizer 原型，证明连续输入归并、点击导航去重和 seq 稳定。（`RecorderNormalizer` 纯逻辑；`test_normalizer_pure_merge_causality_and_sensitive`、`test_normalizer_suppresses_select_click_and_flags_iframe`）
- [x] 用生成的定位器和步骤调用现有 runner，证明保存结构无需增加 FlowStep 字段即可重放。（`test_capture_normalize_replay_and_sensitive_never_leaves_page`：录制 10 步 → `execute_browser_run` 全部重放成功，元素用现有 method/value 契约）
- [x] 检查 API payload、日志和测试快照，证明 password 明文从未离开页面。（浏览器侧敏感判定不发送值；测试断言所有捕获 payload 的 JSON 序列化中不含密码明文，敏感步骤进入 requiredBindings）

**Gate**：click + fill + navigation 录制、编辑器可消费 DTO、runner 重放、敏感值四项全部通过。✅ 2026-08-16 PoC 通过，进入 Phase 1。

### PoC 结论（2026-08-16）

- 归并规则全部在真实 Chromium 上验证：逐字符输入归并为单条填写、checkbox 的 input(value=on) 与点击均被语义步骤吸收、点击触发导航不重复生成打开页面、直接导航生成打开页面并剥离 query/fragment、Enter/Escape/Tab 生成键盘按键、iframe 事件只产生 warning。
- 归并器是纯后端逻辑（无 Playwright 依赖），已具备直接进入 Phase 1 的形态；本 PoC 中发现并修复的规则：点击前先 flush 输入缓冲（保证填写先于点击的时序）。
- 敏感值双层判定（浏览器侧不发送 + 服务端 `is_sensitive_field` 复核）已在测试中固化。
- 残余技术点（Phase 1 处理）：role 候选在真实页面的唯一性计数、SPA route 的 UI 状态呈现（pushState 不产生导航事件，捕获连续性已验证）、会话生命周期与 API 层。

## Phase 1: Shared Session And Recorder Core

- [x] 从 `WorkerService` 抽取 Picker/Recorder 共用的 browser/context/page 创建、线程提交、截图和回收能力，保持现有 Picker API 不变。（新增 `server-py/autoflow/browser_session.py`：`launch_browser_session`/`close_browser_session`；worker.py 的 Picker 创建与回收改用它，既有 Picker/Worker 测试全过）
- [x] 新增 `server-py/autoflow/recorder.py`，集中定义注入脚本、输入 payload 校验、敏感判定和归并状态机。（`validate_recorder_event` 收敛 DTO 并做服务端敏感复核；`is_sensitive_field` 双层防线）
- [x] 为注入脚本使用 context init script，确保完整导航后的新 document 继续捕获。（PoC 已验证；Coordinator 在 goto 前 `add_init_script` + `expose_binding`）
- [x] 增强 role locator，包含 accessible name；增加稳定排序和唯一性测试。（候选优先级 testid → role[name=…] → label → text → css，见 `_candidate`；唯一性计数在 stop 阶段对当前页面核对，待 Phase 2 API 测试固化）
- [x] 实现 session/event 有界内存模型、seq、暂停/继续、stop flush、cancel/expire 和资源释放。（`RecordingCoordinator`：`deque(maxlen=5000)`、RLock 保护、`sweep_expired`/`close_all`、stop/cancel 幂等、登录态 storage_state 快照注入）

**Gate**：Recorder 纯单测、真实 Chromium fixture、全部既有 Picker 测试通过；浏览器关闭和超时无遗留进程。✅ 2026-08-16 通过（92 个 Python 测试，无遗留 chromium 进程）。

### Phase 1 实测发现（2026-08-16）

- 会话协调器必须用可重入锁：stop/cancel 的幂等分支会在持锁时调用 `session_response`（`threading.Lock` 死锁，改 `RLock`）。
- 首次加载导航发生在 `starting` 状态，若被协调器丢弃会导致归并器把第一次用户导航误判为初始加载；导航事件在 starting/recording 均喂给归并器（首导航逻辑幂等）。
- Playwright sync 对象线程绑定：所有页面驱动必须放在创建线程（`_SameThreadSubmitter` 模拟）；生产形态中服务器从不驱动页面，只有用户操作触发 binding 回调。

## Phase 2: Authenticated Platform API

- [ ] 定义 RecordingSession、RecordingEvent、RecordingResult 和错误响应的唯一后端 DTO owner。
- [ ] 新增带 session 认证、项目归属和 `flow.edit` 能力检查的 recording endpoints。
- [ ] 校验 flow/environment 属于当前项目、URL scheme 和会话 owner；跨用户或跨项目读取返回 404/403，不泄漏 session 存在性。
- [ ] 实现 create/get/events/pause/resume/stop/cancel，确保 stop/cancel 幂等。
- [ ] 审计 create/stop/cancel/fail，仅记录安全摘要；增加日志和值泄漏回归测试。
- [ ] 在 `src/platform-api.ts` 增加严格类型和 API 封装，不在组件内 cast 原始响应。

**Gate**：认证、权限、跨项目、状态转换、重复命令、URL 校验和脱敏测试通过。

## Phase 3: Editor State And Review UX

- [ ] 在 `flow-store` 增加单个原子 `importRecording` 或等价 action，同时更新步骤、选中项和 dirty 状态。
- [ ] 在 workspace store 增加可复用的元素草稿合并逻辑，按规范 key 去重并生成唯一名称。
- [ ] 流程编辑器顶栏增加录制控制；按钮使用现有 Ant Design 图标和 Tooltip，状态不会导致工具栏布局跳动。
- [ ] 开始表单选择环境、起始 URL 和「从头录制」选项（默认复用 Picker 登录态快照）；错误明确区分离线、无权限、浏览器不可用和冲突会话。
- [ ] 增量轮询 events，按 seq 去重；暂停时保持状态，停止后进入 review。
- [ ] review 展示步骤、元素处置、warning 和 secret variable binding；未绑定或定位器非唯一时禁止确认。
- [ ] 确认时一次性追加流程和元素；取消时清空临时状态且不触发 workspace 同步。

**Gate**：Vitest 覆盖状态机、轮询重试/去重、绑定阻断、原子导入和取消无副作用；build/lint 通过。

## Phase 4: End-To-End Closure

- [ ] Playwright E2E 使用本地 fixture 从开始录制走到停止、确认、保存和运行成功。
- [ ] 增加 password 泄漏检查：API 捕获、前端 storage、服务端日志测试 sink、资源 snapshot 均不含测试密码。
- [ ] 覆盖直接导航、点击导航、SPA route、暂停继续、重复轮询、浏览器手动关闭和 unsupported iframe。
- [ ] 回归本地 Picker、元素验证、手工流程编辑、资源同步、revision canonicalization 和单流程运行。
- [ ] 补充用户文档：MVP 支持动作、明确不支持项、敏感变量绑定和会话回收行为；不写入真实账号或 secret。

### 2026-08-18 收尾验证

- `npm run lint`、`npm run build`、`npm run test:unit`（30）、`npm run check:bundle` 和 `npm run test:py`（107）均通过。
- `npm run test:e2e -- tests/recording.spec.ts`：1/1 通过，覆盖创建录制会话、sessionStorage 恢复控制状态、暂停/继续、停止 review、定位器校验和原子导入草稿。
- 后端专项覆盖启动/导航稳定错误、页面关闭或浏览器断连后的失败终态与资源回收、暂停 seq、不支持 `contenteditable`/拖拽 warning，以及审计幂等。
- 尚未以专项闭环验证的部分保持未完成：导入后保存并由 ManagedRunner 重放（AC7）、真实页面的完整敏感变量绑定链路（AC5）、完整 handler 权限矩阵及用户文档；P0 retry snapshot follow-up 仍是最终发布 gate。

## Validation Commands

```bash
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
npm run test:windows
```

开发过程中先运行新增的精确测试；收尾必须运行 `npm run test:all`。若环境无法运行某项，报告完整命令、错误和未覆盖风险，不得宣称全量通过。

## Review Gates

- [ ] 未修改持久 FlowStep/ElementAsset 契约，或已同步更新前后端 snapshot 并证明兼容。
- [ ] 页面、服务端、API、前端 store、storage、日志和审计均无敏感输入明文。
- [ ] 录制 API 不依赖或扩大 legacy Worker API 的网络暴露。
- [ ] 事件归并、seq 去重和导航因果有纯单测及真实浏览器测试。
- [ ] 确认导入是原子的，取消路径无任何资源副作用。
- [ ] 现有 Picker 和手工编辑路径保持可用。
- [ ] P0 retry 回归通过：保存/发布后仍能按最终约定复用原 revision checksum、dataset 行/`upToStepId`（如适用），并为每条重试保留一对一 `retryOfRunId`/审计关联；产品语义已收敛，follow-up 实现/测试未通过前保持阻塞。

## Risky Files And Rollback Points

- `server-py/autoflow/worker.py`：Picker 与 Recorder 共用生命周期，改动 blast radius 最大；先以独立提交完成共享抽取并跑 Picker 回归。
- `server-py/autoflow/handler.py`：认证 API 改动必须独立提交，便于隐藏入口后单独回滚。
- `src/FlowEditorPage.tsx`：优先拆专用录制组件，避免扩大已有编辑器组件复杂度。
- `src/flow-store.ts` / `src/workspace-store.ts`：原子导入单独提交，出现问题可回滚而不影响手工保存。
- 回滚不得删除用户已经确认保存的流程/元素；只移除入口和临时 session 能力。

## Suggested Commit Sequence

1. `test(recording): add local browser recording fixtures`
2. `refactor(picker): share local browser session lifecycle`
3. `feat(recording): normalize browser events safely`
4. `feat(api): add authenticated recording sessions`
5. `feat(editor): review and import recorded steps`
6. `test(recording): cover record save and replay closure`
