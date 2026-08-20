# DATA-01 实施清单

- [x] `services.py`：新增 `retention_cleanup(audit_days, run_days, artifact_days,
      dry_run)`，按 180d 审计 / 90d 运行 / 15d 产物分档清理。
- [x] 产物清理同步删除文件与 DB 行，避免孤儿；运行清理级联 events/outputs/
      artifacts/deliveries。
- [x] `main.py`：维护循环调用 `retention_cleanup`，环境变量可配置各档天数与
      dry-run（`AUTOFLOW_RETENTION_AUDIT_DAYS`/`_RUN_DAYS`/`_ARTIFACT_DAYS`/
      `_DRY_RUN`）。
- [x] 新增 `test_retention_cleanup.py`（dry-run 不删 + 真实清理）。

## 验证

- `test_retention_cleanup.py` 2 项通过。
- `test_managed_runner_concurrency.py` + `test_runner.py` + `test_run_batches.py`
  等 18 项通过（含 RUN-01 回归）。
