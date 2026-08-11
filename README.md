# AutoFlow Workbench

面向多项目隔离的 Web UI 自动化工作台 MVP。用户通过元素、动作和参数编排流程；浏览器执行始终由 Playwright Worker 调度。

## 本地运行

安装依赖：

```bash
npm install
```

在两个终端分别启动 Worker 和前端：

```bash
npm run server
```

```bash
npm run dev -- --host 127.0.0.1 --port 4173
```

打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。前端默认访问 `http://127.0.0.1:8787/api`；可通过 `VITE_WORKER_API_URL` 覆盖 API 地址。

只启动前端时，界面会保留本地演示数据和元素验证降级，便于浏览完整工作流。

## 验证

```bash
npm run build
npm run lint
npm run test:unit
npm run test:e2e
npm run test:worker
npm run test:platform
npm run test:agent  # 已知红：agent 原型 smoke，不纳入 test:all 门禁
```

## Platform milestone

The existing SQLite Worker remains the local development executor. The same service now also exposes a centralized Platform API at `/api` and stores its state separately in `server/.data/platform.sqlite` by default.

The first Platform milestone includes:

- Login, workspaces, centralized project documents, and idempotent one-time browser `localStorage` imports.
- Immutable draft/published flow revisions with publish/rollback audit events. Platform runs require a published revision and record the flow, environment, element, dataset, and Agent snapshots.
- AES-256-GCM encrypted server-side secrets. Secret plaintext is only attached to the in-memory Agent lease payload, never stored in a run snapshot, event, or artifact metadata.
- Outbound Agent WebSocket registration, 15-second heartbeats, Chromium-only single-concurrency capability, project/environment bindings, short leases, renewal, reconnect recovery, cancellation, and artifact upload.
- Persistent headed Chromium debug sessions. A session keeps its BrowserContext, cookies, page state, and current step while it is paused; it supports start from the first step, continue, run current step, skip, pause, retry, and end.
- Debug session events capture the current URL, step transitions, console errors, network failures, and periodic screenshots. Sessions are reclaimed after 15 minutes of inactivity or two hours total, and can always be ended manually.

Start the local platform service with the existing command:

```bash
npm run server
```

For an internal Platform that Agents access from other machines, configure the listener, browser origins, and encryption key before starting it:

```bash
set AUTOFLOW_LISTEN_HOST=0.0.0.0
set AUTOFLOW_CORS_ORIGINS=https://autoflow-console.example.internal
set PLATFORM_SECRET_KEY=replace-with-a-long-random-secret
set NODE_ENV=production
npm run server
```

The legacy local Worker endpoints under `/api/projects/*` stay enabled only when the service listens on loopback. They are disabled by default for an internal listener; production UI execution should use a bound Agent instead. Set `AUTOFLOW_ENABLE_LEGACY_WORKER_API=1` only when that legacy executor is intentionally isolated and protected.

Create a registration token from the **执行节点** page, then start an Agent on an internal machine:

```bash
set AUTOFLOW_PLATFORM_URL=https://platform-host.example.internal
set AUTOFLOW_AGENT_REGISTRATION_TOKEN=agt_...
npm run agent
```

The first registration persists an Agent identity credential at `agent/.identity.json`. This file is ignored by Git. Agents require HTTPS/WSS for a non-loopback Platform URL; use `AUTOFLOW_ALLOW_INSECURE_PLATFORM_TRANSPORT=1` only for an isolated development network. The Agent creates one headed Chromium profile per lease and skips trace/screenshot artifacts whenever the leased run contains secrets.

Debug sessions use the same outbound Agent connection and keep a separate temporary Chromium profile until the session ends or expires. The Agent uploads screenshots only for sessions without secrets. `AUTOFLOW_AGENT_HEADLESS=1` exists solely for the automated `test:agent` smoke test; the default is headed Chromium.

## Data and Continuous Regression

- CSV and `.xlsx` imports create immutable Dataset Versions. The importer validates unique headers, limits imports to 10,000 rows, and never overwrites a prior version.
- A platform run can reference a Dataset Version. The platform creates one independent Run per row and freezes the dataset metadata and row data in each run snapshot.
- Agent steps may read `{{data.column}}` and previous `{{flow.output}}` values. A confirmed step can store text, a DOM attribute, a URL parameter, or a matching JSON response path as a flow output. Secret values are redacted before a result, event, output, trace, screenshot, or notification payload is persisted.
- Schedules accept five-field Cron expressions with an explicit IANA timezone. Schedules and webhook triggers require a revision that is currently published; drafts cannot be dispatched through either path.
- Notification channels support generic Webhook, Feishu, DingTalk, WeCom, and an email-relay Webhook. Endpoint configuration is encrypted at rest. Run delivery payloads contain only the environment, revision, Agent, failure context, artifact metadata, and retry state.

The **Data Sets** page imports and previews frozen versions. The **Continuous Regression** page manages schedules, CI Webhooks, notification subscriptions, and delivery records. A Webhook URL is shown once when it is created and should be stored in the CI secret manager.

## Governance and Analysis

- The **Governance** page aggregates daily run trends, normalized failure categories, slow-step duration, and element reuse/failure impact from immutable run snapshots and redacted events.
- Workspace owners and administrators manage members. Viewers are read-only; editors can create draft assets; publication, secret rotation, Agent binding, schedules, Webhooks, and notification subscriptions require an owner or administrator.
- Every member change and publish/rollback action is audited. The project release-audit view shows the published revision history without exposing secret values.

`test:e2e` 会启动独立的 Vite 和 Worker 实例，覆盖项目隔离、元素验证、流程拖拽，以及浏览器中真实的“创建运行 -> SSE 日志 -> Trace 产物”链路。`test:worker` 会直接运行 Chromium，并验证任务执行和产物项目隔离。

## 当前能力

- 工作空间项目列表、搜索、新建和项目级数据隔离。
- 项目概览、流程、元素库、变量、环境、运行中心、运行详情、模板库和项目设置。
- 三栏流程编辑器，包含步骤增删、排序、变量插入、草稿状态、保存和运行至当前步骤。
- 元素编辑抽屉与验证体验：环境选择、唯一/多个/零匹配反馈、截图和定位稳定性提示。
- Playwright Worker 队列、完整流程运行、运行至指定步骤、元素验证、取消和重新提交。
- SSE 实时状态、逐步日志、失败截图和 Trace；SSE 不可用时运行详情会轮询任务状态。

## Worker 接口边界

所有资源均在项目作用域内读取，路径必须携带 `projectId`：

```text
POST /api/projects/:projectId/runs                       -> { runId }
GET  /api/projects/:projectId/runs/:runId                -> 任务状态、摘要、产物元信息
POST /api/projects/:projectId/runs/:runId/cancel         -> 取消请求
POST /api/projects/:projectId/runs/:runId/retry          -> { runId }
GET  /api/projects/:projectId/runs/:runId/events         -> SSE

POST /api/projects/:projectId/validations                -> { validationId }
GET  /api/projects/:projectId/validations/:validationId/events -> SSE

GET  /api/projects/:projectId/artifacts/:artifactId      -> 产物访问地址
```

创建任务仅返回任务标识。前端通过 SSE 接收状态、日志、步骤结果；运行详情在需要时以轮询兼容。接口只返回 `artifactId`、文件名和内容类型，不暴露 Worker 本地目录或对象存储实现。

密钥变量不进入任务响应、SSE 日志或页面明文；Worker 只在服务端内存中保存重新提交所需的原始任务参数。
