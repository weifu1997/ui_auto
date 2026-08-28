# 审查 WARNING 修复 — 执行清单

顺序按风险隔离：先脚本/CI（无运行时行为），再 restore，再 runner 异常语义，再录制返回时机，最后 setup:py。

## Checklist

1. **P-W1** 改 `phase0-ci.yml` 触发分支；同步 `docs/生产基线发布与分支保护.md` 一句（集成分支仍是 `python_3.1`，CI 另覆盖 `master` / `v3.2_flow_assertion`）。
2. **P-W2** `restore.ps1` 预快照拷贝 `platform.sqlite` + 存在的 `-wal`/`-shm`。
3. **P-W4** 去掉 `started()` 异常吞成 `False`；补「抛错 → failed completed + 槽释放」单测。保留 False 跳过用例。
4. **P-W3** `create_session` 在 submit 后立即返回；补「launch 卡住仍快速返回 starting」单测；核对现有录制 API/会话单测是否仍假设 create 结束时已是 `recording`。
5. **P-W5** `setup-py.mjs` 安装时设置 `PLAYWRIGHT_BROWSERS_PATH`；空目录不跳过。
6. 跑 AC6 门禁。

## Validation

```bash
npm run lint
npm run test:unit
npm run test:startup
node scripts/run-py.mjs -m pytest \
  server-py/tests/unit/test_managed_runner_concurrency.py \
  server-py/tests/unit/test_recording_sessions.py \
  server-py/tests/unit/test_recording_api.py \
  -q
npm run test:py
```

P-W2 无本机 PowerShell 时：人工读脚本确认三文件拷贝，不把 `test:windows` 当本任务门禁。

## Rollback

- 每项独立提交更易回滚；至少保证录制 create 与 runner started 语义可单独还原。
- CI 触发改坏时把 `on:` 收回 `python_3.1` 即可。

## Do not

- 不要把前端 create 超时改成 120s。
- 不要在 restore 里对活库做 checkpoint（那是 backup 的职责）。
- 不要改 GitHub 分支保护。
