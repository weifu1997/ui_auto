# Implementation Plan: Flow Recording MVP

## Preconditions

- 保持任务为 `planning`，经人工批准后再执行 `task.py start`。
- 开发前读取 `.trellis/spec/frontend/index.md`、`.trellis/spec/backend/index.md` 和 cross-layer 指南。
- 先运行基线测试并记录结果；不得把已有失败归因于本功能，也不得修改或删除既有断言来制造通过。
- 先完成 2-3 人日 PoC。PoC 未证明敏感值不泄漏和录制后可重放时，不进入完整 UI 开发。

## Phase 0: Technical Proof

- [ ] 建立只服务于测试的本地页面 fixture，覆盖普通输入、password、button navigation、select、checkbox、SPA route 和 iframe。
- [ ] 扩展现有 Picker 注入思路，连续捕获 click、input/change 和 top-frame navigation。
- [ ] 写纯 RecorderNormalizer 原型，证明连续输入归并、点击导航去重和 seq 稳定。
- [ ] 用生成的定位器和步骤调用现有 runner，证明保存结构无需增加 FlowStep 字段即可重放。
- [ ] 检查 API payload、日志和测试快照，证明 password 明文从未离开页面。

**Gate**：click + fill + navigation 录制、编辑器可消费 DTO、runner 重放、敏感值四项全部通过。失败则记录技术结论并停止，不用 UI 掩盖内核缺陷。

## Phase 1: Shared Session And Recorder Core

- [ ] 从 `WorkerService` 抽取 Picker/Recorder 共用的 browser/context/page 创建、线程提交、截图和回收能力，保持现有 Picker API 不变。
- [ ] 新增 `server-py/autoflow/recorder.py`，集中定义注入脚本、输入 payload 校验、敏感判定和归并状态机。
- [ ] 为注入脚本使用 context init script，确保完整导航后的新 document 继续捕获。
- [ ] 增强 role locator，包含 accessible name；增加稳定排序和唯一性测试。
- [ ] 实现 session/event 有界内存模型、seq、暂停/继续、stop flush、cancel/expire 和资源释放。

**Gate**：Recorder 纯单测、真实 Chromium fixture、全部既有 Picker 测试通过；浏览器关闭和超时无遗留进程。

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
- [ ] 开始表单选择环境和起始 URL；错误明确区分离线、无权限、浏览器不可用和冲突会话。
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
