# 审查 WARNING 修复 — 设计

## Boundaries

| 项 | 动 | 不动 |
| --- | --- | --- |
| P-W1 | `.github/workflows/phase0-ci.yml`、`docs/生产基线发布与分支保护.md` | GitHub 分支保护 UI/API |
| P-W2 | `scripts/ops/restore.ps1` | `sqlite-backup.py` 的 checkpoint 主备份路径 |
| P-W3 | `server-py/autoflow/recorder.py` create 返回时机；必要时录制 API 单测 | 错误码集合、槽位/同项目互斥、前端 15s abort |
| P-W4 | `server-py/autoflow/managed_runner.py` `_execute` 的 started 分支 | `mark_run_started` 的 queued→running 语义 |
| P-W5 | `scripts/setup-py.mjs` | 生产 WinSW 的 `PLAYWRIGHT_BROWSERS_PATH`（已指向 `%BASE%\browsers`） |

## P-W1 CI 触发

保留 `python_3.1` 为文档中的受保护集成分支。workflow `on.push` / `on.pull_request` 增加 `master` 与 `v3.2_flow_assertion`。不改 job 步骤、权限或 Windows smoke。

## P-W2 restore 预快照

在已确认服务停止之后、覆盖 `data/platform.sqlite` 之前：

1. 若活库主文件存在，创建 `data/pre-restore-<stamp>/`。
2. 拷贝 `platform.sqlite`；若同目录存在 `platform.sqlite-wal` / `platform.sqlite-shm`，一并拷入。
3. 不在 restore 路径上新开 SQLite 做 checkpoint（服务应已停；checkpoint 仍只属于 backup 脚本）。

失败时保持现有 `throw` 行为。`-WhatIf` 在 `ShouldProcess` 处直接 return，不建目录。

## P-W3 录制 create 立即返回

当前：HTTP 线程（`run_in_threadpool`）调用 `create_session`，内部 `submit(_run_browser_session)` 后再 `browserReady.wait(120)`，而 `set()` 发生在 `page.goto` 之后。

目标：

1. 占槽、写入 `starting`、`submit` 浏览器任务后立刻 `session_response` 并 201。
2. `_run_browser_session` 在 launch+goto 成功后把 status 置 `recording` 并 `browserReady.set()`（现有逻辑可保留 set，供内部/测试等待，但 HTTP 路径不等待）。
3. 启动失败仍把 session 置 `failed` + `errorCode`；前端轮询会看到终态。
4. `RECORDING_BUSY` / `RECORDING_SESSION_ACTIVE` 仍在 submit 之前同步抛出。

前端：`starting` 已在 `RecordingSessionStatus` 中；`startRecording` 在 201 后 `setRecordingSession` + `startRecordingPoll`。轮询读到 `recording` 或终态即可。不改 15s abort。

单测：用不会置 `browserReady` 的 launch 卡住泵线程，断言 `create_session` 快速返回且 status 为 `starting`。

## P-W4 started 异常 vs False

`_execute` 已在 `try/finally` 里释放 `_active`。调整 started 分支：

- `accepted is False`：return（取消/watchdog 已终态）。
- `started()` 抛错：在同一 `try` 中落入现有 `except Exception`，走 failed `completed()`。

实现上不要把 `started()` 的异常吞成 `accepted = False`。

## P-W5 setup:py 浏览器缓存

- `browserCache` 默认仍为 `server-py/.browsers`（或环境变量覆盖）。
- 调用 `uv run python -m playwright install chromium` 时把 `PLAYWRIGHT_BROWSERS_PATH` 设为该目录。
- 跳过条件改为「缓存目录下已有 Chromium 可执行文件」；空目录或不存在则安装。
- `finally` 恢复原环境变量，避免污染后续命令。

## Compatibility / rollback

- 录制 201 可能从「已 recording」变为「starting」：旧客户端若写死 `status === "recording"` 才会开始轮询，需要在实现时 grep 确认；当前编辑器不写死。
- CI 触发变多会增加 Actions 分钟数；失败只影响新触发的分支，可把 workflow 改回只听 `python_3.1`。
- restore 多拷 wal/shm 是超集，旧备份仍可 restore。

## Risks

- 录制 create 立即返回后，极短窗口内 GET session 仍为 `starting`、尚无 `currentUrl`。轮询必须容忍。
- 若浏览器启动失败，用户先看到「录制已开始」再看到失败横幅。这比 15s abort 更可诊断。
