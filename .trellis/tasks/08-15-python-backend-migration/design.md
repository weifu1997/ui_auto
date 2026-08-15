# Design: TypeScript to Python Backend Migration

## Source of Truth

- `docs/方案-后端迁移Python.md`（已批准方案）
- `server/*.ts` 为等价实现的 golden source
- `server/*smoke.ts`、`server/platform.test.ts`、`server/platform-migrations.test.ts` 为契约基准

## Architecture

Python 服务按同一进程组合平台 API、ManagedRunner、本地 Worker 和静态托管，保持现有 Node 服务的行为边界：

```text
server-py/
  autoflow/
    main.py            # uvicorn 组合根、静态托管、维护循环
    http.py            # PlatformError、CORS、限流、错误响应
    core.py            # cron/CSV/failureCategory/IP/签名/脱敏/常量
    auth.py            # scrypt、会话、cookie
    migrations.py      # 迁移引擎 + v1..v10
    services.py        # createPlatformServices 等价
    handler.py         # FastAPI Router 平台端点
    runner.py          # 执行动作、interpolate、captureOutput
    managed_runner.py  # threading 单并发队列
    picker.py          # 候选算法与注入脚本
    worker.py          # 本地 Worker API/SSE/local-picker
    audit.py / workspaces.py / projects.py / resources.py / revisions.py / templates.py
```

## Key Decisions

- FastAPI `def` 端点使用线程池承载同步 playwright/sqlite 调用。
- SQLite 保持 WAL、FK 约束、迁移语义和 JSON 文本格式。
- 双跑阶段保持 `server/` 与 `server-py/` 并存；部署和 e2e 切换前先通过 smoke 双跑。
- 测试分两层：pytest 单测覆盖纯函数和迁移兼容；pytest HTTP smoke 覆盖端到端契约。
- Python JSON 输出使用 compact JSON 且不转义非 ASCII，保证 revision checksum 与 TS 一致。
