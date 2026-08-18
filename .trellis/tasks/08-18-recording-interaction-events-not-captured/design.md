# Design: Persistent Recording Event Pump

## Boundary

`RecordingCoordinator` 保持唯一的 Playwright 所有者。FastAPI 请求线程只调用 coordinator 的线程安全控制方法；所有页面驱动、binding 派发和 browser/context/Playwright 关闭仍在 PlatformServices 的单线程 `_recording_executor` 中完成。

不修改 HTTP DTO、`RecordingEvent`、normalizer、前端轮询或 SQLite。修复只改变录制 session 内部的 executor 生命周期。

## Data Flow

```text
create_session (request thread)
  -> submit _run_browser_session (recording thread)
  -> create browser/context/page, inject binding, goto
  -> signal ready; request returns recording session
  -> wait_for_timeout loop pumps browser binding callbacks
  -> _on_browser_event -> normalizer -> in-memory events / seq

stop/cancel/expiry (request or sweeper thread)
  -> set terminal state under lock
  -> await browser task completion
  -> recording thread flushes normalizer, snapshots storage, closes resources
  -> session_result returns stable result
```

## Session Contract

- Session stores a readiness primitive and its long-lived browser future.
- `_run_browser_session` owns setup, periodic `page.wait_for_timeout` pumping and teardown in one `try/finally`.
- `create_session` waits only for readiness or startup failure, then changes `starting` to `recording` and returns. It never waits for browser-task completion.
- `stop` and `cancel` set their existing terminal states then await the stored browser future; the event loop observes the state within its bounded pump interval and performs `_stop_browser` itself.
- Browser close/disconnect callbacks run on the recording thread; they set `failed`, then use the same teardown path without resubmission.
- Startup failure records the existing stable error code, signals readiness and releases resources. Stop/cancel remain idempotent.

## Test Strategy

- Extend the local recorder fixture with a query-controlled delayed script that dispatches input and click after `goto` returns.
- In a real Chromium coordinator test, call `create_session`, avoid any subsequent page command, wait only on ordinary synchronization, and assert `lastSeq`, preview count and stopped result contain the delayed interactions.
- Keep existing direct browser, lifecycle, sensitive-data and API tests as compatibility coverage.

## Rollback

The change is isolated to in-memory coordinator state. Reverting the commit restores the previous short-lived executor task; no database, API or frontend migration is involved.
