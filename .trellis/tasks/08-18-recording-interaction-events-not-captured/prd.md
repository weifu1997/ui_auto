# 修复录制交互事件未捕获

## Goal

让部署机 Chromium 中的用户填写、点击、选择、勾选和键盘操作持续进入录制结果，而非只保留创建会话时的“打开页面”步骤。

## Background And Evidence

- `RecordingCoordinator.create_session` 仅把 `_start_browser` 提交到单线程 `ThreadPoolExecutor`，并在初始 `page.goto()` 返回后结束该任务，见 `server-py/autoflow/recorder.py:801`、`:820`、`:870`。
- 页面事件通过 `context.expose_binding("__autoflowRecorderEvent", ...)` 回调到 Python；Playwright sync API 需要其所属线程持续处理事件，空闲且已返回的录制线程无法派发后续 binding，见 `server-py/autoflow/recorder.py:826`。
- 初始导航同步发生在 `page.goto()` 内，`_on_navigation` 因而能生成“打开页面”；现有真实浏览器测试在同一线程主动执行 `page.type/click`，持续驱动同步 API，未覆盖用户在浏览器空闲期间操作的生产形态，见 `server-py/tests/unit/test_recording_sessions.py:513`。

## Requirements

### R1 Persistent Browser Event Pump

- 成功导航后，录制专用线程必须持续处理 Playwright sync 事件，直到会话停止、取消、过期、页面关闭、浏览器断连或服务关闭。
- 页面 binding 产生的交互事件必须保留现有 URL 同源、敏感输入脱敏、暂停边界、seq 和归并规则。
- 启动 API 仍在浏览器已创建并完成初始导航后返回 `recording`，不阻塞至会话结束。

### R2 Thread-Affine Shutdown

- stop/cancel/expire/close 必须通知长期运行的录制线程在其自身线程中收集结果并关闭 context、browser、Playwright。
- API 对 stop/cancel 的幂等结果、错误码、审计、storage state 保存和超时资源回收保持现有契约。
- 不从 FastAPI 请求线程直接驱动或关闭 Playwright sync 对象。

### R3 Production-Shaped Regression

- 增加真实 Chromium 回归：初始导航完成且创建调用返回后，页面在无后续 Playwright 命令的空闲期触发 input/click binding；会话状态和停止结果均包含相应步骤。
- 保留已有填写、点击、导航、暂停、敏感输入、iframe warning 和会话回收回归。

## Acceptance Criteria

- [x] AC1：在有头 Chromium 开始录制后，用户等待数秒再填写和点击，停止后结果至少包含“打开页面、填写、点击”且顺序正确。（真实 Chromium 空闲期 fixture 回归通过。）
- [x] AC2：浏览器在空闲期异步触发的 binding 事件会更新 `lastSeq` 和 `recordedStepCount`，无需向该页面发出服务端 Playwright 命令。（`test_coordinator_real_browser_pumps_idle_binding_events` 通过。）
- [x] AC3：stop、cancel、过期、页面关闭、浏览器断连和服务关闭均在录制线程释放资源，原有幂等与 audit/storage-state 契约不回归。（107 个 Python 测试通过。）
- [x] AC4：`npm run test:py` 与录制 Playwright 回归通过，且密码明文仍不会进入事件、结果或日志。（Python、lint/build、unit、bundle 门禁通过；敏感值回归保持通过。）

## Out Of Scope

- 不修改前端轮询、录制 DTO、元素定位、环境 URL 校验或流程导入逻辑。
- 不引入 CDP、浏览器扩展、异步 Playwright API 或第二套浏览器线程模型。

## Risks

- 长生命周期任务占用录制单线程执行器；所有会话关闭路径必须可靠唤醒并等待它退出，避免 Chromium 泄漏或 stop 请求超时。
- 不能用测试中主动调用 `page.click()` 代替空闲期 binding 测试，否则会再次掩盖事件泵缺失。
