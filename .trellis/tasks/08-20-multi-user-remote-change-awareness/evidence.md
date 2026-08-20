# COL-01 Evidence

## Implementation

- `src/ServerWorkspaceSynchronizer.tsx`：工作区查询增加 30s 轮询，并保留 dirty
  draft 不覆盖语义。
- `src/pages/shared.tsx`：冲突提示展示更新者与更新时间。
- `server-py/autoflow/handler.py`：资源/设置版本冲突响应携带
  `updatedBy`/`updatedAt`。

## Verification

Passed:

```text
test_col_remote_change_conflict.py                   1 passed
test_route_authorization_matrix.py                   1 passed
test_route_isolation_regressions.py                  3 passed
test_templates.py + test_automation_edit_api.py      4 passed
test_batch_delete_runs.py                            2 passed
npm run test:unit                                    57 passed
npx tsc -b --force                                   passed
oxlint                                                passed
```

## Known Limitations

- 全量 Python 单测仍受既有 `TestClient` 生命周期挂起影响（与本任务无关的既有
  环境限制），未记录为全量绿。
- Playwright E2E 未在本环境完成（既有 sandbox 无法连通 `127.0.0.1:8787`）。
- 尚未推送远端、未创建 PR、未取得 CI 证据。
