# 流程录制 MVP

## Goal

让测试人员通过操作部署机上的有头 Chromium 自动生成可编辑、可保存、可重放的测试流程，减少手工创建元素和逐条配置步骤的时间。

目标不是录制所有浏览器行为，而是可靠覆盖高频基础路径：打开页面、点击、填写、清空、下拉选择、勾选和按键。录制结果必须先进入流程编辑器草稿，经用户确认后才进入现有资源同步和 revision 发布链路。

## Background And Evidence

- 流程步骤模型已经覆盖基础录制动作，见 `src/mock-data.ts:72`、`src/mock-data.ts:90`。
- 流程编辑器已有步骤草稿、编辑和保存链路，见 `src/flow-store.ts:3`、`src/FlowEditorPage.tsx:181`、`src/FlowEditorPage.tsx:572`。
- 元素库已支持按环境、页面路径和定位器保存元素，见 `src/mock-data.ts:19`、`src/pages/ElementsPage.tsx:369`。
- 本地 Picker 已有有头 Chromium 会话、页面脚本注入、Python binding、候选定位器、高亮预览、截图和会话回收，见 `server-py/autoflow/worker.py:645`、`:725`、`:760`、`:808` 和 `server-py/autoflow/picker.py:38`、`:97`、`:142`。
- 执行器已经能解析元素并执行目标基础动作，见 `server-py/autoflow/runner.py:137`、`:177`。
- 当前 Picker 只捕获一次 click，且旧 `/api/projects/*` Worker 路由按部署约定只适合 loopback；录制需要连续事件、导航后注入和带平台认证的远程控制边界，见 `README.md:74`、`server-py/autoflow/main.py:114`、`:124`。

### 规划刷新（2026-08-15；起点证据与当前剩余闭环）

- 本任务文档只表达需求边界，不构成继续实现授权。基础 P0 已归档；录制的“保存后运行/重放”最终验收依赖 [`08-16-flow-retry-reproduction-correctness`](../08-16-flow-retry-reproduction-correctness/prd.md) 的一对一快照契约实现和回归证据。
- 现有 local-picker API 的确是内存会话，但其 `/api/projects/{project}/local-picker/*` 路由只有项目字符串校验，不能直接当作平台录制 API；新增链路必须重新定义 session owner、项目隔离和 `flow.edit` 能力检查。
- `server-py/autoflow/picker.py` 当前 role locator 只传 role、不带 accessible name；注入脚本只捕获一次 click，不能直接满足连续事件、导航后重新注入和事件游标要求。
- `src/flow-store.ts` 只有逐项编辑 action；录制 review 需要新增“确认时一次性导入”的状态边界，但不能在停止前逐事件写入 flow/workspace store。
- `npm run build`、`npm run lint`、`npm run test:unit`（30 个）和 `npm run test:py`（68 个）在初始规划轮通过；后续并行 PoC 已增加真实 Chromium fixture 并验证录制内核，但认证 API、编辑器导入和保存/重放闭环仍未完成，不能把任务标记为通过。

## Product Decisions

- MVP 录制部署机启动的 Chromium，不连接测试人员电脑上已经打开的浏览器。
- 使用现有 Playwright Python 依赖，不引入 Chrome Extension、CDP 桥或新的浏览器自动化依赖。
- 录制会话通过带平台会话认证和项目能力检查的 API 暴露；不扩大旧 Worker API 的公网或内网暴露范围。
- 起始 URL 校验（2026-08-16 已确认）：`startUrl` 必须与所选环境 `baseUrl` 同源（scheme+host+port），拒绝 userinfo、非 HTTP(S) 与跨域地址；跨域起始地址拒绝创建会话，录制中导航到外部域只产生 warning。
- 录制登录态（2026-08-16 已确认）：录制始终新建独立 browser context；创建时若同项目+环境存在存活 Picker 会话，则按现有 `requiresLogin` 机制一次性注入其 `storage_state` 快照（只读、不回写）；无 Picker 会话或用户选择「从头录制」时以全新 context 启动并手动登录。
- URL 脱敏（2026-08-16 已确认）：录制产生的所有 URL（步骤、review、事件、日志、审计）一律只保留 scheme+host+path；query 和 fragment 完全剥离，不进入任何步骤或存储。依赖 query 的页面状态由用户事后手动编辑步骤补齐。
- 录制结果默认追加到流程末尾；MVP 不提供替换整个流程或任意插入位置。
- 原始浏览器事件和未确认草稿只保存在服务进程内存中；确认导入前不写平台数据库。
- 密码和疑似 secret/token 字段不回传实际值，必须在导入前绑定到现有 `secret: true` 变量。

### Dependency And Non-Goals For Planning

- 基础 revision 正确性已完成；录制不能绕过现有 revision/save 链路。P0 follow-up 的单 run retry 回归仍是录制“保存、发布、ManagedRunner 重放”最终闭环的硬门，不能把已完成的 PoC 当成保存后验收。
- 录制保存的敏感步骤仍只持久化 secret 名称引用；后续 retry 按 P0 follow-up 的契约处理变量/secret：请求只预检必需名称，enqueue/重启恢复物化 runner input 时读取当时当前值；预检当下缺失稳定拒绝且零写入，预检后删除则已创建 queued run 保留并在物化阶段稳定失败，任何层都不保留历史明文。
- MVP 继续只支持单项目、单环境、单用户活动会话；不把跨设备连接、会话持久恢复或新的浏览器自动化依赖作为隐含需求。
- 起始 URL 同源、登录态快照注入与 query/fragment 剥离已于 2026-08-16 确认，见 Product Decisions；录制实现不得在这些边界上自行放宽。

## Requirements

### R1 Recording Session

- 在流程编辑器提供“开始录制”入口，用户选择项目内环境和起始 URL 后启动有头 Chromium。
- 起始 URL 默认使用环境基础地址，必须与所选环境 `baseUrl` 同源（scheme+host+port），只允许 `http` / `https`，拒绝 userinfo 和跨域地址，并沿用环境和项目权限校验。
- 会话支持 `recording`、`paused`、`stopped`、`canceled`、`expired`、`failed` 状态，以及开始、暂停、继续、停止、取消操作。
- 会话沿用现有 Picker 的单线程 Playwright 访问、空闲 15 分钟和最长 2 小时回收约束。
- 同一用户、项目、环境同时最多一个活动录制会话；重复开始返回现有会话或明确冲突，不静默创建多个浏览器。
- 录制 context 与 Picker 会话生命周期完全隔离：创建时一次性读取 Picker `storage_state` 快照，录制停止/取消/超时不得关闭 Picker 会话，Picker 会话回收也不影响已启动的录制。

### R2 Event Capture And Normalization

- 捕获初始打开页面、直接地址导航、click、input/change、select、checkbox/radio 和有意义的 keydown。
- 连续输入必须归并为一个 `填写` 或 `清空填写` 步骤，不能为每个字符生成步骤。
- select、checkbox/radio 生成对应语义动作，不能同时重复生成一个普通点击步骤。
- 由前一点击触发的页面导航保留点击步骤，不额外生成重复“打开页面”；用户直接地址导航才生成新的打开页面步骤，且步骤 URL 只保留 scheme+host+path。
- 每个事件使用递增 `seq`，轮询可用 `afterSeq` 增量读取，并保证重试读取不会产生重复步骤。
- iframe、多标签页、弹窗、上传、拖拽、下载、Shadow DOM 和 contenteditable 等不支持行为必须产生 warning，不能静默伪造可执行步骤。
- 录制期间导航到与环境 `baseUrl` 不同源的页面时，该页面事件不生成可执行步骤，只产生 warning；MVP 不支持跨域认证域路径。

### R3 Locator And Element Assets

- 复用并增强 Picker 候选生成逻辑，优先级为项目配置的 test-id、带 accessible name 的 role、label、稳定 text、最后才是 CSS。
- 导入前确认定位器在当前页面唯一；不唯一时保留候选和 warning，用户必须修改或明确选择后才能导入。
- 按 `environmentId + path + method + value` 复用已有元素；没有匹配项时生成项目内唯一的建议名称和新元素草稿。
- 步骤使用现有执行器可解析的元素引用，不把 selector 直接塞入步骤字段，也不改变现有 FlowStep 持久化契约。
- 取消录制或关闭确认界面不得在元素库留下任何元素。

### R4 Sensitive Input Safety

- 对 `input[type=password]` 以及 name/id/label/autocomplete 命中 password、secret、token、api key 等规则的字段，页面脚本不得把真实值发送给服务端。
- 敏感事件只返回稳定字段标识和待绑定标记；服务端响应、日志、前端状态、浏览器存储、审计和 revision snapshot 中均不得出现明文。
- 停止录制后的确认界面要求每个敏感输入绑定项目内现有 secret 变量，生成 `{{scope.name}}` 引用；未完成绑定不能导入。
- 非敏感输入可保留录制值，但必须允许用户在确认导入前编辑。

### R5 Editor Import And UX

- 编辑器顶栏提供开始、暂停/继续、停止、取消控制，并明确显示当前环境、URL、状态和已录制步骤数。
- 开始表单选择环境和起始 URL，并提供「从头录制（不使用已有登录态）」选项，默认复用 Picker 登录态快照。
- 前端按增量接口轮询录制事件；短暂请求失败可重试，但不能重复追加步骤。
- 停止后展示步骤、元素、敏感绑定和 warning 汇总；用户确认后以一次原子 store 更新把步骤追加到流程末尾，并创建/复用元素草稿。
- 导入后流程保持 dirty，仍由用户点击现有“保存”进入 workspace 同步和 revision 发布链路。
- 取消确认不修改 flow-store、workspace-store 或服务端资源。

### R6 Compatibility And Observability

- 现有元素 Picker、流程手工编辑、元素验证、单流程运行和 revision checksum 行为不得回归。
- MVP 不增加 FlowStep 持久字段；如果实现确需增加字段，必须同步更新前后端 revision snapshot 并提供兼容测试。
- 会话创建、停止、取消和失败写入不含 URL 查询参数、输入值、selector 明文的审计摘要；所有 URL 一律剥离 query/fragment 后记录。
- 录制错误必须区分浏览器启动失败、导航失败、权限失败、会话过期和不支持行为。

## Acceptance Criteria

- [ ] AC1：有 `flow.edit` 权限的登录用户可从流程编辑器选择本项目环境，启动部署机有头 Chromium；未登录、跨项目和无权限请求被拒绝。
- [ ] AC2：在本地测试页依次执行“打开页面 → 填写用户名 → 填写密码 → 点击登录 → 下拉选择 → 勾选 → 按键”，停止后生成顺序正确、无逐字符噪声和重复点击的步骤。
- [ ] AC3：刷新或 SPA 路由变化后录制仍继续；直接地址导航和点击触发导航按 R2 规则生成步骤。
- [ ] AC4：候选定位器按稳定性排序并验证匹配数；元素可按环境、路径、方法和值复用，新增元素名称在项目内唯一。
- [ ] AC5：密码值不会出现在录制 API 响应、服务端日志、前端 store、local/session storage、审计或保存后的 revision 中；绑定 secret 变量前无法导入。
- [ ] AC6：确认导入一次性追加步骤和元素，流程进入 dirty；取消录制或取消确认后流程和元素库均不变化。
- [ ] AC7：导入并保存的流程可以由现有 ManagedRunner 成功重放基础动作，运行结果与人工操作一致。
- [ ] AC8：暂停期间不产生业务步骤，继续后 seq 连续；重复轮询相同 `afterSeq` 不会让编辑器出现重复步骤。
- [ ] AC9：会话取消、浏览器关闭、空闲超时和服务关闭均释放 page/context/browser；用户看到明确终态。
- [ ] AC10：iframe、多标签页、上传等非 MVP 行为展示 warning，且不会被标记为已成功录制。
- [ ] AC11：现有 Picker、元素验证、手工流程编辑、运行、同步和 revision 测试继续通过。
- [ ] AC12：起始 URL 与环境 `baseUrl` 不同源、携带 userinfo 或非 HTTP(S) 时创建被拒绝且不启动浏览器；录制中跳转外部域展示 warning 且不生成步骤。
- [ ] AC13：同环境存在存活 Picker 会话时，录制以其登录态快照启动（登录后页面直接可达）；选择「从头录制」或无 Picker 会话时全新 context 启动；录制结束不影响 Picker 会话存活，登录态只读不回写。
- [ ] AC14：直接导航携带 query/fragment 时，生成的打开页面步骤、review、事件、日志与审计中的 URL 均只含 scheme+host+path。
- [ ] AC15：页面刷新恢复策略按最终决策验收：推荐仅在 `sessionStorage` 保存 `sessionId` 并恢复控制视图，不保存事件/结果；若选择刷新即取消，则服务端可靠释放会话并显示明确终态。外域 top-frame 导航只产生 warning，不生成可执行步骤。

## Out Of Scope

- Chrome Extension、连接用户现有浏览器、跨设备 CDP、浏览器 profile 同步。
- iframe、Shadow DOM、多标签页、popup、文件上传/下载、拖拽、悬停、双击和 contenteditable。
- 自动生成断言、视觉断言、智能修复定位器、AI 步骤命名。
- 多人协同录制、会话持久恢复、录制原始 DOM/网络/HAR。
- 自动保存或自动发布录制结果。

## Dependencies And Estimate

- 技术验证：2-3 人日，证明 click/fill/navigation、导入、重放和敏感值不泄漏。
- MVP：12-18 人日，包括录制内核、认证 API、编辑器接入和闭环测试。
- iframe、多页面及完整增强：在 MVP 上追加约 8-12 人日。
- 用户浏览器 Extension/CDP：独立阶段，追加约 15-25+ 人日。

## Risks And Deferred Items

- 页面事件归并是主要复杂度，必须优先用真实浏览器 fixture 验证，而不是只测字符串转换。
- role 候选当前缺少 accessible name，直接复用会产生多匹配；技术验证阶段必须补齐。
- 录制 API 同时接触浏览器和项目资源，权限、URL 校验和日志脱敏必须作为发布阻断项。
- 服务重启后内存录制会话丢失是 MVP 接受行为，但重启时必须关闭浏览器并让前端进入明确失败状态。

## Open Questions For Requirement Convergence

1. 编辑器页面刷新时，是否只在 `sessionStorage` 保存 `sessionId` 并恢复录制控制视图（推荐）；还是刷新即取消会话并释放浏览器？推荐前者，因为不持久化事件/结果即可保留用户操作连续性；代价是需要处理过期 session 的恢复错误。
