# RUN-01 实施清单

- [x] `managed_runner.py`：`global_concurrency`/`workspace_concurrency` 参数，
      多工作线程 + `_active` dict + `_next_eligible` 的 eligible FIFO 调度。
- [x] 取消按项隔离（`_complete_canceled` / `_close_browser` 只处理目标项）。
- [x] `services.py`：从环境变量读取并发上限，并在 enqueue run/validation 时传
      入 `workspace_id`（经 `project_for` 解析）。
- [x] 新增 `test_managed_runner_concurrency.py`（全局上限 + 工作区上限 + FIFO）。

## 验证

- `test_managed_runner_concurrency.py` 2 项通过。
- `test_runner.py` + `test_run_batches.py` 等 16 项通过。
