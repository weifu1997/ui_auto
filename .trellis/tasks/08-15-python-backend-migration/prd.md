# 后端 TypeScript 到 Python 全量迁移

## Goal

按已批准方案将 `server/*.ts`（约 8.5k 行）迁移到 `server-py/`（Python），完成平台 API、ManagedRunner、本地 Worker/SSE、元素采集通道、静态托管与部署链的等价实现。

## Requirements

- 技术栈：Python 3.12+、FastAPI、uvicorn、playwright sync API、sqlite3、cryptography、openpyxl、pytest。
- 目录结构按方案落地到 `server-py/autoflow/*.py` 与 `server-py/tests/`，迁移期与 `server/` TS 并存双跑。
- 不修改前端 `src/`，不迁移 SQLite 数据，保持双库格式兼容。
- API 契约与错误码必须保持一致：成功响应、`{error: "<CODE>"}`、状态码、CORS、Cookie、限流、SSE 帧格式。
- 关键兼容点必须逐字或等价移植：v1-v10 迁移链、AES-256-GCM 密文、scrypt 密码哈希、Cron、CSV、SSRF 通知投递、JSON 序列化。
- Playwright e2e 保留 Node 侧，但 `playwright.config.ts` 的 `webServer` 最终指向 Python 服务。
- 部署链改为 Python：AutoFlow.xml、install/upgrade/backup 等脚本，以及 `scripts/sqlite-backup.py`。

## Acceptance Criteria

- [ ] `server-py/tests/unit` 覆盖 core、migrations、auth、services 等关键纯函数与兼容测试并全绿。
- [ ] `*smoke.ts` 有对应 Python HTTP 黑盒版本，可分别指向 TS/Python 服务并完成契约双跑。
- [ ] `test:managed`、`test:worker`、`test:platform`、`test:production` 的核心场景在 Python 服务上通过。
- [ ] `playwright.config.ts` 切换到 Python webServer 后 e2e 全绿。
- [ ] 部署脚本与备份脚本切换到 Python 后 `test:windows` 验证通过。
- [ ] TS 服务退役前，Python 服务保持与现有数据、密钥、密码、迁移记录兼容。

## Notes

- 详细技术选型、关键兼容实现和阶段计划见 `docs/方案-后端迁移Python.md`。
- 执行顺序：先完成当前未提交的 runner/headless 相关收尾，再推进 Python 迁移，不与未收尾任务混在一起。
