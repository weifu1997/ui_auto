# Design: Flow Recording MVP

## Boundary

录制功能建立一条从部署机浏览器事件到编辑器草稿的临时链路，不改变 Flow、FlowStep、ElementAsset 的现有持久化结构。录制原始事件不进入 Platform SQLite；只有用户确认导入并点击现有保存后，流程和元素才通过 workspace 同步进入资源表和 published revision。

本设计依赖基础 P0 任务 [`08-15-flow-revision-selection-correctness`](../archive/2026-08/08-15-flow-revision-selection-correctness/prd.md) 及 [`08-16-flow-retry-reproduction-correctness`](../08-16-flow-retry-reproduction-correctness/prd.md)。录制不能用自建运行入口绕开 P0；保存后的 replay 必须走修复后的 flow-scoped/manual 或显式 revision 契约，并回归已收敛的原 revision checksum/retry 审计链路。

## Architecture

```text
FlowEditorPage
  -> authenticated platform recording API
  -> RecordingCoordinator
  -> shared Playwright browser-session owner
  -> headed Chromium page
  -> init script + expose_binding
  -> RecorderNormalizer
  -> in-memory ordered RecordingEvent log
  -> incremental polling by afterSeq
  -> stop result review
  -> atomic flow-store/workspace-store import
  -> existing save -> sync outbox -> canonical revision snapshot
```

### Module Ownership

- `server-py/autoflow/recorder.py`：注入脚本、事件 DTO 校验、归并状态机、敏感字段判定、warning 和 proposed steps。
- `server-py/autoflow/worker.py`：现有 Playwright 线程和浏览器生命周期。抽取最小共享 session owner 供 Picker 和 Recorder 使用，禁止复制一套 browser/context/page 回收逻辑。
- `server-py/autoflow/handler.py` 或独立 platform recorder router：会话认证、`flow.edit` 能力、项目/环境校验和 HTTP DTO。
- `src/platform-api.ts`：RecordingSession、RecordingEvent、RecordingResult 类型及 API 封装。
- `src/flow-store.ts` / `src/workspace-store.ts`：一次性导入步骤和元素，不逐事件写持久 store。
- `src/FlowEditorPage.tsx`：录制控制、轮询状态、停止确认和错误反馈；复杂确认视图可拆到 `src/pages/` 下的专用组件。

## API Contracts

所有端点要求现有平台 session，并校验项目 `flow.edit`。录制 API 不复用无平台认证的 legacy Worker 路由。

### Create Session

`POST /api/platform/projects/{project_id}/recording-sessions`

```json
{
  "flowId": "flow-1",
  "environmentId": "env-1",
  "startUrl": "https://example.test/login",
  "freshLogin": false
}
```

登录态策略：默认在创建 context 时一次性注入同项目+环境存活 Picker 会话的 `storage_state` 快照（与运行 `requiresLogin` 同机制，见 `server-py/autoflow/worker.py:572`）；`freshLogin: true` 或无存活 Picker 会话时使用全新 context。快照只读、不回写；录制与 Picker 会话生命周期互不影响。

返回 `201`；同一用户/项目/环境已有活动会话时返回 `409` 并携带现有 `sessionId`。

`startUrl` 校验：必须与所选环境 `baseUrl` 同源（scheme+host+port），拒绝 userinfo、非 HTTP(S) 与跨域地址；违规返回 `RECORDING_START_URL_INVALID`，不启动浏览器。

```json
{
  "session": {
    "id": "rec-...",
    "projectId": "...",
    "flowId": "...",
    "environmentId": "...",
    "status": "recording",
    "currentUrl": "https://example.test/login",
    "lastSeq": 0,
    "startedAt": "...",
    "lastActivityAt": "..."
  }
}
```

服务端可使用经校验的完整 `startUrl` 执行导航，但 API 响应、前端状态、错误、日志和审计中的 URL 一律使用去除 userinfo、query、fragment 的安全表示。前端只显示该安全 URL，不把完整导航 URL 写入任何浏览器存储。

### Read Session And Events

- `GET /api/platform/projects/{project_id}/recording-sessions/{session_id}`
- `GET /api/platform/projects/{project_id}/recording-sessions/{session_id}/events?afterSeq=42&limit=100`

```json
{
  "events": [
    {
      "seq": 43,
      "kind": "proposed_step",
      "step": { "id": "...", "action": "点击", "element": "登录按钮" },
      "element": {
        "disposition": "reuse",
        "existingElementId": "element-1",
        "suggested": null,
        "candidateCount": 1
      },
      "binding": null,
      "warnings": []
    }
  ],
  "lastSeq": 43,
  "hasMore": false
}
```

服务端以 `seq` 为唯一事件游标。相同 `afterSeq` 返回相同逻辑事件；前端按 seq 去重。

### Commands

- `POST .../{session_id}/pause`
- `POST .../{session_id}/resume`
- `POST .../{session_id}/stop`
- `DELETE .../{session_id}`：取消并释放资源。

`stop` flush 未完成的输入归并缓冲并返回最终结果：

```json
{
  "session": { "id": "rec-...", "status": "stopped", "lastSeq": 12 },
  "result": {
    "steps": [],
    "elements": [],
    "requiredBindings": [
      {
        "bindingId": "binding-1",
        "stepId": "step-2",
        "fieldHint": "password",
        "value": null
      }
    ],
    "warnings": []
  }
}
```

终态命令应幂等：重复 stop 返回同一清洗后结果，重复 cancel 不产生新资源。

## Browser Event Contract

页面注入 payload 只包含归一化所需的最少字段：事件种类、时间、frame 是否 top、URL 的安全部分、元素 tag/type/name/id/label/role/accessible name/test-id/text 摘要、checked/selected 状态和非敏感输入值。

注入脚本在浏览器侧先执行敏感判定。敏感字段只发送 `sensitive: true`，不包含 value。服务端再次判定，形成双层防线。

### Normalization Rules

1. session 创建成功后生成一个初始“打开页面”。
2. 同一元素的 input 事件更新 pending buffer；在 change/blur、元素切换、暂停或停止时 flush 为一个填写/清空步骤。
3. select change 生成下拉动作；checkbox/radio change 生成勾选动作，并抑制相邻同目标 click。
4. Enter、Escape、Tab 等明确按键生成按键步骤；普通字符 keydown 由 input buffer 吸收。
5. 先对导航目标执行 environment-origin guard：目标 origin 与所选环境 `baseUrl` 不同的事件只追加外域 warning，不进入可执行步骤或 flow draft。通过 guard 后再记录最近一次用户事件与导航因果窗口；点击触发的 top-frame navigation 不新增打开页面，地址栏或没有用户事件因果的同源 navigation 才新增打开页面。所有导航 URL 一律记录为 scheme+host+path，query/fragment 完全剥离。
6. 非 top-frame、popup、file chooser 等事件生成 warning，且不生成可执行步骤。

归并状态机必须是后端纯逻辑，可用事件序列单测；真实 Chromium 测试验证浏览器事件实际符合假设。

## Locator And Element Resolution

复用 `picker_candidate_locator`、`picker_score` 和 preview 能力，但增强 role candidate 为 `role[name=accessibleName]`。候选输出必须稳定排序，并记录匹配数。

元素解析顺序：

1. 规范化当前 `path`，忽略 query/fragment。
2. 以 `environmentId + path + method + value` 查找现有 ElementAsset。
3. 唯一命中则返回 `reuse`；否则根据 accessible name、label、name/id 生成唯一建议名称。
4. 所有候选都不唯一时返回 warning，前端阻止确认导入，直到用户选择/编辑为唯一定位器。

Recorder 返回元素草稿，不直接调用资源写接口。最终 import 先合并元素，再让步骤引用合并后的唯一名称或现有可解析 ID。

## Sensitive Bindings

- 浏览器侧敏感规则覆盖 `type=password`，以及 name/id/label/autocomplete 中的 `password|passwd|secret|token|api[-_ ]?key|credential`。
- 服务端不得记录原始 binding payload；异常日志只记录 session、seq 和字段 hint。
- 前端确认界面只允许选择当前项目 `secret: true` 的变量，并将步骤 value 替换为现有 `{{env.x}}`、`{{project.x}}` 或 `{{flow.x}}` 语法。
- required binding 未绑定时确认按钮禁用。

## State And Concurrency

- RecordingCoordinator 用锁保护 session map 和 event append；所有 Playwright 操作仍提交到单独线程。
- 每个 session 保存 bounded event log、last seq、pending input、last user action、warnings 和终态清洗结果。
- 单 session 最多 1000 个逻辑步骤和有限事件缓冲；超过上限自动暂停并警告，防止内存失控。
- 前端轮询只保存在组件内存；页面刷新恢复策略仍是待决产品项。推荐只在 `sessionStorage` 保存 `sessionId` 并恢复控制视图，不保存事件值或最终结果；若选择刷新即取消，则必须在服务端可靠释放会话并向用户展示明确终态。

## Compatibility And Migration

- 无数据库迁移。
- 不修改 FlowStep 和 ElementAsset 持久字段。
- 现有 Picker API 和 session 生命周期保持兼容；共享 session owner 的重构必须由既有 Picker 测试保护。
- 如录制 UI 无法加载，手工编辑流程仍完整可用。

## Testing Strategy

- `test_recorder.py`：事件归并、导航因果、敏感判定、seq、warning、元素去重和名称唯一性。
- 纯逻辑/Chromium 测试：外域 top-frame 导航只产生 warning、不生成打开页面或步骤；同源直接导航仍按因果规则生成步骤。
- handler/service 测试：认证、跨项目、状态机、幂等 stop/cancel、资源回收和响应脱敏。
- 真实 Chromium fixture：本地静态测试页覆盖导航、输入、select、checkbox、SPA route、password 和 unsupported iframe。
- React/Vitest：控制按钮、轮询去重、敏感绑定阻断、确认原子导入和取消无副作用。
- Playwright E2E：录制本地 fixture、导入保存、发起运行并确认成功。
- Revision/retry regression：录制保存后的 flow-scoped run 使用正确 revision；并回归 P0 最终确定的原 revision checksum、dataset 行/`upToStepId`（如适用）和一对一 retry 审计关联，不能因保存/发布改变重现身份。

测试不得依赖外部网站或真实账号。

## Rollout And Rollback

- 前端入口可由功能常量或服务能力响应控制；后端 API 未部署时隐藏/禁用录制按钮，手工编辑不受影响。
- 首次发布限制单活动 session 和 1000 步上限，观察浏览器资源及失败原因后再放宽。
- 回滚顺序：先隐藏前端入口，再移除录制 API/Coordinator，最后决定是否回滚共享 session owner；不得因回滚删除已由用户确认保存的流程或元素。
