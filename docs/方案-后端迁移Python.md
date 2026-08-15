# 方案：后端 TypeScript → Python 全量迁移

> 状态：已批准，P3-P7 已完成
> 日期：2026-08-15
> 范围：`server/*.ts`（8.5k 行）→ `server-py/`（Python）；前端 `src/` 不动

## 1. 目标与边界

**迁移**：平台 API（`/api/platform/*`、auth、workspaces）+ ManagedRunner 执行引擎 + 本地 Worker/SSE + 本地元素采集通道 + 生产静态托管 + 部署链，全部迁到 Python。

**保持不动**：

- 前端 `src/`（React 19 + TS，9k 行）
- SQLite 数据文件（`platform.sqlite` / `autoflow.sqlite` 双库格式兼容，**数据零迁移**）
- API 契约与错误码（`{error: "<CODE>"}` 响应体）
- Playwright e2e（Node 侧保留，webServer 指向 Python 服务）
- `PLAYWRIGHT_BROWSERS_PATH` 浏览器缓存
- 采集注入脚本（纯 JS 字符串原样保留）

## 2. 技术选型（已确认）

| 项 | 选择 |
|---|---|
| 语言/运行时 | Python 3.12+（本机 3.13 验证通过） |
| Web 框架 | FastAPI + uvicorn |
| 执行模型 | **同步直译**：playwright sync API + sqlite3 同步 + FastAPI `def` 端点（自动线程池）+ threading 单并发队列（替代 AbortController） |
| 加密 | cryptography（AES-256-GCM）、hashlib.scrypt（密码） |
| xlsx | openpyxl |
| 依赖管理 | pip + requirements.txt（部署脚本友好） |
| 移除 | `ws` 死依赖 |

## 3. 目录结构

```
server-py/
  requirements.txt
  autoflow/
    main.py            # uvicorn 组合根（对应 index.ts：路由挂载 + 静态托管 + 维护循环）
    http.py            # http-utils 等价（PlatformError/CORS/限流/errorResponse 子串映射）
    core.py            # platform-core 等价（cron/CSV/failureCategory/IP/签名/脱敏/常量）
    auth.py            # scrypt 密码哈希 + 会话 + cookie（platform-auth）
    migrations.py      # 迁移引擎 + v1..v10 逐字移植
    services.py        # createPlatformServices 等价（40+ 服务闭包）
    handler.py         # 平台路由（FastAPI Router，~40 个端点分组）
    runner.py          # runner-core 等价（11 种动作分发/interpolate/captureOutput）
    managed_runner.py  # ManagedRunner 等价（threading 队列 + 取消）
    picker.py          # picker-core 等价（候选算法 + 原 JS 注入脚本）
    worker.py          # 本地 Worker API + SSE + local-picker 会话（index.ts 路由部分）
    audit.py / workspaces.py / projects.py / resources.py / revisions.py / templates.py
  tests/
    unit/              # pytest 单测（core/迁移/服务层）
    smoke/             # *-smoke.ts 的 pytest 版本（HTTP 黑盒 + 真实 Chromium）
scripts/sqlite-backup.py   # sqlite-backup.mjs 等价
```

迁移期 `server-py/` 与 `server/`（TS）并存做双跑对照；退役后 TS 移入 `archive/server-ts/` 并清理 package.json（tsx 依赖、test:* 脚本）。

## 4. 关键兼容实现（不允许走样的点）

1. **迁移链 v1-v10 逐字移植**：schema_migrations 表语义一致（version/name/applied_at，已应用跳过、重复版本抛错、BEGIN IMMEDIATE 事务、noTransaction 逃生门、PRAGMA foreign_keys 开关）。生产库已有 v1-v10 记录 → Python 启动时零执行；新库走同一 DDL 链。v1 bootstrapSchema DDL 字符串原样搬入。
2. **AES-256-GCM 密文兼容**：keyMaterial = sha256(PLATFORM_SECRET_KEY 或开发默认值) 原样；iv=12B random、iv/tag/ciphertext base64 → cryptography AESGCM，**既有 secrets 必须可解密**。
3. **scrypt 密码哈希互验**：Node 默认参数 N=16384/r=8/p=1/dklen=64 与 hashlib.scrypt 默认一致；格式 `base64url(无padding)salt:hash`（Python 需 strip "="）+ hmac.compare_digest。已生成 Node 侧夹具哈希用于互验测试。
4. **Cron 逐字移植**：5000 分钟暴力扫描 + zoneinfo 替代 Intl.DateTimeFormat（周几英文名数组原样、hourCycle h23 → hour()、无效时区 → SCHEDULE_TIMEZONE_INVALID）。
5. **CSV 状态机逐字移植**（引号/转义/10001 行上限/413 错误码）。
6. **SSRF 通知投递**（全项目最高难度点）：子类化 http.client.HTTPSConnection/HTTPConnection 覆写 connect() → socket.create_connection((固定IP, port)) + SSL context wrap_socket(server_hostname=SNI) 保 SNI 与 Host 头；15s 总超时 + 10s 空闲超时；响应体 2048B 截断；socket.getaddrinfo 替代 node:dns lookup；ipaddress 替代 isIP。
7. **SSE 帧格式原样**：`id/event/data` 帧 + 先发 `: connected\n\n` + 250 条回放上限 + worker_events 持久化 + 重启时 queued/running → failed(WORKER_RESTARTED)。FastAPI StreamingResponse + queue.Queue。
8. **错误/状态契约**：`{error: "<CODE>"}` 响应体；PlatformError(status, code)；legacy Worker 路由 exposeMessage 子串映射（NOT_FOUND→404 / PAYLOAD_TOO_LARGE→413 / RUN_SECRETS_REQUIRED→409 / 其余→400）；限流 429 RATE_LIMITED；CORS 白名单 + loopback 正则。
9. **Cookie**：autoflow_session; Path=/api; HttpOnly; SameSite=Strict; Secure 仅在 TLS（uvicorn scope scheme 或 AUTOFLOW_COOKIE_SECURE=1，反向代理时读 X-Forwarded-Proto）。
10. **执行引擎直译**：playwright API 同名（launch/newContext/tracing.start|stop/goto/locator.*），重试/继续策略、敏感运行跳过 Trace 与截图、keepBrowserOpenOnFailure 等待、browserState 状态机、secretKeys 脱敏全链路（request/result/events）。
11. **xlsx 适配**：openpyxl read_only；日期单元格显式转字符串对齐 read-excel-file 的 Date→String 行为（契约 smoke 覆盖）。
12. **后台维护循环**：FastAPI lifespan 起 asyncio 任务（10s 调度扫描 / 30min 运行看门狗 / 每小时保留清理），daemon 语义对齐 .unref()。
13. **静态托管**：生产模式（NODE_ENV=production 或显式开关）serving dist/，SPA fallback 到 index.html（no-cache）+ 带 hash 资源 immutable。
14. **/health、/ready（PRAGMA quick_check）、/__fixture/* 页面**原样。
15. **JSON 序列化对齐**：`json()` 必须与 JSON.stringify 逐字节一致（compact 分隔符 + 不转义非 ASCII），因为 `flow_revisions.checksum = digest(json(snapshot))`（platform-handler.ts:641），跨语言不一致会导致既有 checksum 失效与去重逻辑破坏。

## 5. 测试策略

- **pytest 单测**：移植 platform.test.ts（cron/CSV/failureCategory/IP/签名/errorResponse）+ platform-migrations.test.ts（5 个验证点）→ test_core.py / test_migrations.py；新增「密码哈希互验」「TS 产库上跑 Python 迁移不追加、quick_check ok」「既有密文可解密」兼容测试。
- **smoke 双跑（契约 gate）**：*-smoke.ts 改写为 pytest HTTP 黑盒用例，通过环境变量指定目标服务地址 → 同一批用例分别打 TS（golden）与 Python，断言结果 diff 一致才放行。覆盖 worker/worker-persistence/worker-launch-failure/worker-secret/local-picker/managed-runner/platform-contract/auto-open/production-ui。
- **Playwright e2e（保留 Node）**：playwright.config.ts 的 webServer 从 `npm run server` 改为启动 Python 服务；mock fixture 不受影响。
- **windows-scripts-smoke**：backup 工具换成 sqlite-backup.py。

## 6. 部署链改造

- AutoFlow.xml：executable 改 `%BASE%\app\venv\Scripts\python.exe -m autoflow.main`（工作目录 app/server-py），环境变量全部保留（AUTOFLOW_LISTEN_HOST/PORT/WORKER_*/PLATFORM_*/PLAYWRIGHT_BROWSERS_PATH 等）。
- install.ps1：前端流程不变（npm ci + build），追加 `python -m venv venv` + `pip install -r requirements.txt` + `python -m playwright install chromium`（仍装到 %BASE%\browsers）。
- upgrade.ps1：追加 pip 安装步骤；rollback/restore/retention/soak 基本不变。
- backup.ps1：node 调用改为 venv python 调用 scripts/sqlite-backup.py（integrity_check + wal_checkpoint(TRUNCATE) 重试 + 行数/时间戳比对逻辑原样）。

## 7. 阶段计划（每阶段有验收 gate）

- **P0 契约冻结**：从 TS 路由表导出端点/错误码清单；搭 server-py 骨架 + 双跑 harness（smoke 可指向两端）。
- **P1 core 纯函数层**（cron/CSV/脱敏/IP/签名/错误映射）+ pytest 全绿。
- **P2 迁移链逐字移植** + 兼容测试（老库不追加/密文可解/哈希互验）。
- **P3 平台服务层 + 路由**（auth/workspaces/projects/resources/revisions/secrets/datasets/schedules/webhooks/notifications/runs/validations/audit/analytics/templates）→ platform-contract-smoke 双跑通过。
- **P4 执行引擎**（runner.py + managed_runner.py）→ managed-runner-smoke / auto-open-smoke 双跑通过。
- **P5 本地 Worker + SSE + 采集通道 + 静态托管** → worker-* / local-picker-smoke 双跑通过。
- **P6 部署链**（AutoFlow.xml / ps1 / sqlite-backup.py）+ windows-scripts-smoke + production-ui-smoke + Playwright e2e 全绿。
- **P7 灰度与退役**：内网一台机器切 Python 服务观察运行（定时回归 + 通知链路），通过后归档 server/ TS 源码、清理 package.json（tsx 依赖、test:* 脚本）与文档；当前 TS 已移入 `archive/server-ts/`。

**执行顺序注意**：先收尾当前未提交任务（audit-governance-enhance、webhook-migration-notifications），不与迁移混在一起。

## 8. 工作量

约 1.5-2 周（单人，含测试与部署链），P1/P2 可先独立启动。前端与数据零改动，风险集中在迁移链、密码/密文兼容、SSRF 投递三处，均已有专项验证点。
