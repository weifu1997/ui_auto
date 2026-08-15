# Implementation Plan

## Execution Order

1. P0 契约冻结：导出 TS 路由/错误码清单，搭建 `server-py` 包骨架和 pytest/HTTP harness。
2. P1 core 纯函数层：移植 cron、CSV、脱敏、IP、签名、错误映射、JSON/常量，并移植 `platform.test.ts` 相关单测。
3. P2 迁移链：移植 `platform-migrations.ts` v1-v10，并补老库兼容、密文可解、哈希互验测试。
4. P3 平台服务与路由：auth/workspaces/projects/resources/revisions/secrets/datasets/schedules/webhooks/notifications/runs/validations/audit/analytics/templates。
5. P4 执行引擎：`runner.py` + `managed_runner.py`，通过 managed/auto-open smoke。
6. P5 本地 Worker/SSE/采集通道/静态托管：通过 worker/picker/production-ui smoke。
7. P6 部署链：AutoFlow.xml、ps1、`sqlite-backup.py`、`test:windows`。
8. P7 灰度与退役：切换 Playwright webServer、生产验证、归档 TS、清理 package.json 后由用户决策。

## Validation Gates

- Each phase: `pytest` relevant tests pass.
- Smoke phase: same HTTP cases pass against TS golden and Python target.
- Final gate: `npm run build`, `npm run lint`, `npm run test:unit`, Python smoke suite, e2e, windows scripts.

## Rollback Points

- TS service remains runnable until P7; deployment can switch back by reverting AutoFlow.xml and scripts.
- SQLite data is never migrated or rewritten by Python startup.
