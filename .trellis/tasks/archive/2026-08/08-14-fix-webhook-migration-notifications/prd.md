# 修复 webhook 迁移与通知拒绝校验

## Goal

修复 v10 数据库迁移对 webhook_triggers 重建导致的升级阻断与列丢失，并补齐钉钉/企微 webhook 业务拒绝的识别。

## Requirements

- `dropAgentAndDebugTables`（v9）和 `dropDeadTablesAndColumns`（v10）需要像 v8 一样以 `noTransaction: true` 运行，确保 `PRAGMA foreign_keys = OFF` 在 DROP/重建表之前真正生效。
- v10 重建 `webhook_triggers` 时必须保留迁移 5 添加的 `archived_at TEXT` 列，并在 `INSERT ... SELECT` 中复制该列，避免升级后 webhook 查询报 `no such column: archived_at`。
- 通知投递的业务拒绝检测需要同时识别 JSON 中非零的 `code` 和非零的 `errcode`，覆盖飞书、钉钉和企微机器人 webhook。

## Acceptance Criteria

- [ ] v9/v10 migration 配置为 `noTransaction: true`。
- [ ] `webhook_triggers_new` 包含 `archived_at TEXT`，数据复制包含 `archived_at`。
- [ ] `platform.ts` 在 HTTP 200 时也会把非零 `errcode` 判为 `failed` 并记录 `NOTIFICATION_REJECTED_<errcode>`。
- [ ] 项目 lint、type-check 和现有测试通过；迁移相关回归测试覆盖 `archived_at` 保留与带外键数据升级场景。
