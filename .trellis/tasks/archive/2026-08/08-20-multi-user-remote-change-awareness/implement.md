# COL-01 实施清单

- [x] `ServerWorkspaceSynchronizer` 的 `useQuery` 增加 30s 轮询
      （`refetchInterval`/`refetchIntervalInBackground`），并导出常量
      `REMOTE_CHANGE_POLL_MS` 作为文档化间隔。
- [x] 轮询 refetch 复用现有 serverWins/draft 判定：存在本地 draft 时绝不覆盖脏草稿。
- [x] 后端资源/设置版本冲突响应携带 `updatedBy`/`updatedAt`（`handler.py`）。
- [x] 冲突提示展示更新者与更新时间（`pages/shared.tsx`）。

## 验证

- 后端：`tests/unit/test_col_remote_change_conflict.py` 断言冲突错误包含
  `updatedBy`/`updatedAt`。
- 前端：`npm run test:unit` 全量通过（57 项）。
