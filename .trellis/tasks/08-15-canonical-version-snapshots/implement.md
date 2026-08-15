# Implementation Plan: Canonical Version Snapshots

## Order

1. 新增 `server-py/autoflow/revision_snapshot.py`。
2. 修改 `server-py/autoflow/handler.py` 创建 revision 时使用 canonical checksum。
3. 新增 Python 单测：
   - 仅改 `updatedAt`、`validation`、步骤 `status` 不改变 checksum。
   - 改 locator、步骤 action、变量值、环境 `baseUrl` 改变 checksum。
   - 元素数组顺序变化不改变 checksum。
4. 新增 `src/revision-snapshot.ts` 并接入 `ServerWorkspaceSynchronizer.syncSnapshot`。
5. 新增前端单测覆盖 payload 字段排除与元素排序。
6. 在现有 revision API 测试中补“重复保存返回同一 published revision”断言。

## Validation Commands

```bash
npm run lint
npm run build
npm run test:unit
npm run test:py
npm run test:e2e
```

## Review Gates

- 相同执行语义重复 POST `/revisions` 返回已有 revision（200），不新增版本。
- 真实执行字段变化返回新 revision（201）。
- 旧 revision 运行、计划任务、Webhook 绑定不受影响。
- 前端 revision payload 不包含 `updatedAt`、`validation`、step `status`。

## Rollback Points

- `handler.py` checksum 一行可单独回滚。
- `src/revision-snapshot.ts` 可独立移除并恢复旧 payload。
