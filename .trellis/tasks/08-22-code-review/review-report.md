# 全项目代码审查报告（2026-08-22）

分支 `v3.2_flow_assertion` @ b05c660。审查方式：Trellis 规范基线 + 风险导向分层抽样 + 四个并行审查边界（后端 / 前端 / 脚本部署 / 测试）+ 质量门禁。所有 CRITICAL 与关键 WARNING 均已由编排者对照实际代码逐条验证，非代理原始输出直接采信。

## 质量门禁结果

| 门禁 | 结果 |
| --- | --- |
| `npm run lint` (oxlint) | ✅ 0 warnings, 0 errors |
| `npm run build` (tsc -b && vite build) | ✅ 通过，产物正常 |
| `npm run test:unit` (vitest) | ✅ 17 文件 61 用例全过 |
| `npm run test:py` (pytest) | ✅ 168 用例全过（1 warning） |
| `npm run test:e2e` / `test:windows` | ⏭️ 未执行：E2E 需真实服务且本轮以静态审查为主；Windows smoke 需 PowerShell（见 T-W1 对其有效性的质疑） |

## CRITICAL（已验证）

### C-1【后端】单一 SQLite 连接跨线程共享且无任何锁
`server-py/autoflow/services.py:436-440`
```python
self.database = sqlite3.connect(
    self.data_directory / "platform.sqlite", check_same_thread=False
)
self.database.isolation_level = None
```
验证确认：`services.py` 全文件无任何 `Lock/RLock`；该连接被四类线程并发使用——事件循环线程（HTTP 路由的 `BEGIN IMMEDIATE` 块，如 `services.py:1154`、`services.py:2838`）、维护线程（`main.py:382` `await asyncio.to_thread(_maintenance_pass, ...)` → `services.py:2565` `BEGIN IMMEDIATE`）、ManagedRunner 工作线程（`managed_runner.py:32-37`，回调中自动提交写入 `services.py:3451-3522`）、录制执行器线程。
影响：SQLite 事务状态按连接持有。维护线程在 HTTP 事务开启时执行 `BEGIN IMMEDIATE` 会抛 "cannot start a transaction within a transaction"，其异常路径的 `ROLLBACK`（`services.py:2583-2584`）会静默回滚 HTTP 事务；runner 线程的自动提交写入会混入未提交事务、被无关回滚连带丢失。表现：调度负载下间歇性丢写、幽灵提交、500。
建议：用单个 `threading.RLock` 串行化所有 `BEGIN…COMMIT` 块；或改每线程连接；或把维护逻辑路由回事件循环。维护循环每 10 秒跑一次（`main.py`），碰撞概率真实存在。

### C-2【前端】30 秒远程轮询静默清空流程编辑器未保存草稿
证据链（全链路验证）：
- `src/ServerWorkspaceSynchronizer.tsx:158` `refetchInterval: REMOTE_CHANGE_POLL_MS`（30s，`:49`）；effect 依赖 `query.dataUpdatedAt`（`:525`），每次轮询成功必重跑。
- 编辑期间草稿只存在于非持久化的 flow-store（`setFlows` 仅在 `saveFlow` 调用，`FlowEditorPage.tsx:929`），workspace store 仍等于基线 → `serverWins` 判定为 true（`ServerWorkspaceSynchronizer.tsx:461-467`，outbox 草稿保护 `hasStoredDraft` 不覆盖此场景）。
- `workspace-store.ts:251-262` `replaceServerWorkspace` 无条件新建全部数组/对象引用；`FlowEditorPage.tsx:327` `flowDefinition` 随之变化。
- `FlowEditorPage.tsx:592-594`
```ts
useEffect(() => {
  if (flowId) loadSteps(flowDefinition ?? []);
}, [flowDefinition, flowId, loadSteps]);
```
无 `isDirty` 守卫；`flow-store.ts:66-71` `loadSteps` 重置 steps、选中回到第 1 步、`isDirty: false`。
影响：用户编辑超过 30 秒未保存，草稿被静默重置为上次保存版本，选中步骤跳回第 1 步；与 `ServerWorkspaceSynchronizer.tsx:47-49` 注释"本地未提交草稿始终不会被轮询覆盖"直接矛盾。
建议：(a) `FlowEditorPage` 在 `isDirty` 时跳过 `loadSteps`（或以内容哈希替代引用作依赖）；(b) 同步器在 `serverSerialized === lastApplied` 时跳过 `replaceServerWorkspace`。补一条"挂载编辑器 + dirty 草稿 + 触发 refetch"的回归测试。

### C-3【部署】生产入口门禁不认 `PLATFORM_SECRET_KEY_FILE`，Windows 服务无法启动
- `deployment/AutoFlow.xml:15` 只设置 `<env name="PLATFORM_SECRET_KEY_FILE" value="%BASE%\runtime\platform-secret.key" />`
- `scripts/start-production.mjs:166` 只检查 `environment.PLATFORM_SECRET_KEY`，缺失即 throw `PLATFORM_SECRET_KEY is required for production`
- 仅 Python 层支持文件变体（`services.py:462-471`），但 Node 门禁先于 Python 执行。
影响：WinSW 启动 `node scripts\start-production.mjs` 必抛错，进入 `<onfailure action="restart"/>` 崩溃重启循环。commit `a37b96c`（密钥脱离 XML 托管）改了 AutoFlow.xml / install.ps1 / services.py，漏改 start-production.mjs。CI 的 `test:startup` 只测 Linux 单元路径，`test:windows` 不真正拉起服务，故无门禁拦截。
建议：`validateProductionPrerequisites` 接受 `PLATFORM_SECRET_KEY_FILE`（校验存在、非空、可读），镜像 `services.py:462-471` 语义；补 key-file 路径的启动测试；同步更新 `production-startup.md` 规范（已落后于 `docs/密钥托管与恢复.md`）。

## WARNING（已验证或证据充分）

### 后端（server-py/autoflow）
| # | 问题 | 位置 | 影响 / 建议 |
| --- | --- | --- | --- |
| B-W1 | 取消运行时在 runner 锁内同步执行通知 HTTP 投递（阻塞 `http.client` POST，timeout=10，最多 20 条 ≈ 最长 200s），阻塞事件循环并冻结所有 runner 线程 | `managed_runner.py:67-75`、`services.py:3913, 405-416` | 慢/错误配置的通知端点可使整站不可用。回调只入队，实际投递交给维护循环（`main.py:341` 已有）；不要在持 `_condition` 时调用户回调 |
| B-W2 | 未设 `PLATFORM_SECRET_KEY` 且非 production NODE_ENV 时静默回退到公开已知默认密钥 | `crypto.py:13-17` | 直接跑 Python 层（绕过 Node 包装器）时所有项目 secret / webhook 签名密钥可被任何能读库文件的人解密。建议：默认密钥需显式 dev opt-in 环境变量才允许 |
| B-W3 | 内部异常文本进入 API 响应（模板应用 warnings、通道测试 error、投递 error） | `handler.py:1697-1722, 3406-3411`、`services.py:1998-2001` | 可能泄漏文件路径/主机名。映射为稳定错误码，原文只进服务端日志 |
| B-W4 | 宽泛 `except Exception` 把任意 DB 故障转成误导性 409 名称冲突 | `handler.py:588, 1808, 2208-2212, 3225-3226` | 磁盘满/损坏/C-1 事务错误被报成"名称已存在"，掩盖真实故障。改捕 `sqlite3.IntegrityError` |
| B-W5 | `with self.database:` 在 `isolation_level = None` 下无原子性（已验证：5 条 DELETE 各自独立事务） | `services.py:3151-3156`（同模式 `3177-3197`） | 崩溃中断留下孤儿行（事件/产物已删、run 仍在）。改显式 `BEGIN IMMEDIATE`/`COMMIT` |
| B-W6 | 登录限流按 socket peer IP 键控：反代后全员共享 10 次/分钟桶；`login_rate_windows` 键永不清理 | `handler.py:218-229, 4991-4994` | 反代场景可用性问题 + 缓慢内存增长。清理过期键；考虑在 `AUTOFLOW_TRUSTED_PROXY` 匹配时信任 XFF（机制已在 `transport.py:17-36` 存在） |

### 前端（src/）
| # | 问题 | 位置 | 影响 / 建议 |
| --- | --- | --- | --- |
| F-W1 | `saveFlow` 中 `createPlatformRevision` 失败被吞掉后仍 `setHasPublishedRevision(true)`（已验证） | `FlowEditorPage.tsx:937-947` | 后续 `run()` 因 `hasPublishedRevision === true` 跳过建版本，`createPlatformRun` 服务端报出误导错误。只在成功时置 true |
| F-W2 | 审计脱敏正则遗漏 `apiKey`/`api_key`/`authorization`/`accessKey`/`cookie` 等常见敏感键名 | `audit-mask.ts:1` | GovernancePage 审计面板明文渲染此类值。扩正则（宁可过度脱敏）并补测试 |
| F-W3 | 冲突快照写 sessionStorage 前未对变量做 secret 清空（outbox 路径有 `sanitizeVariable`，此处没有）；服务端水合的变量也未重新脱敏 | `ServerWorkspaceSynchronizer.tsx:69-73, 181, 469` vs `sync-outbox.ts:132` | 违反"secret 值不进浏览器存储"的 state-management 规范；当前无 UI 路径写入明文 secret，属纵深防御缺口。复用 `sanitizeVariable` |

### 脚本 / 部署（scripts/, deployment/）
| # | 问题 | 位置 | 影响 / 建议 |
| --- | --- | --- | --- |
| S-W1 | Windows smoke 渲染已不存在的 `__PLATFORM_SECRET_KEY__` 占位符，且未替换 `__AUTOFLOW_CORS_ORIGINS__` 就 `[xml]` 强转 | `windows-scripts-smoke.ps1:16-17` | smoke 校验的是没人部署的模板，正是它本该拦下 C-3 的地方。与 install.ps1 共享占位符清单并断言全部消费 |
| S-W2 | PS 5.1 下原生命令（npm ci/build、npx playwright）退出码未检查 | `install.ps1:44-49`、`upgrade.ps1:11-16` | 构建失败仍"成功"安装/启动陈旧 dist。封装 `$LASTEXITCODE` 检查（backup.ps1:10 已有先例） |
| S-W3 | robocopy 排除项不含 dev venv（`server-py\.venv` 等）、`.trellis`、`.env` | `install.ps1:40` | 拷贝数 GB 垃圾；带绝对路径的 dev venv 可能遮蔽正式 venv；dev `.env` 的密钥静默进服务。补 `/XD`、`/XF .env` |
| S-W4 | `autoflow.sqlite` 已不存在但备份脚本仍备份它；`sqlite-backup.py:35-36` 对缺失源静默 exit 0 | `backup.ps1:11`、`sqlite-backup.py:35-36` | 每次备份含幽灵条目；主库 `platform.sqlite` 缺失时产出"成功"的空备份。主库缺失应报错；删除幽灵腿；更新文档 |
| S-W5 | 备份复制非原子：先 `copyFileSync` 再校验，失败/中断留下部分文件在备份目录 | `sqlite-backup.mjs:21-28`、`sqlite-backup.py:56-69` | 部分文件可能被误当恢复候选。拷到 `.tmp` → 校验 → rename，失败清理 |
| S-W6 | `process.once(signal)` 转发：第二次 Ctrl+C 直接杀父进程留下孤儿 uvicorn 占端口；子进程拒不停时无 SIGKILL 升级 | `start-production.mjs:187-191`（同模式 `server-py.mjs:33-37`） | 裸 `npm run start` 下双击 Ctrl+C 搁浅服务。保持监听器常驻 + 10s 后 SIGKILL |
| S-W7 | retention/restore/rollback/upgrade 无 `-WhatIf`/`-Confirm`；restore 覆盖活库前无安全快照 | `retention.ps1:5,8`、`restore.ps1:14-21` 等 | 误传 `-Root` 即删错目录。加 `SupportsShouldProcess`；restore 前把当前库拷到 `pre-restore-<stamp>` |
| S-W8 | upgrade.ps1 的 `Move-Item`→`Expand-Archive`→构建 段在 try/catch 之外 | `upgrade.ps1:8-16` | 该段失败留下半部署状态且需手工回滚。整段包 try，失败走同一回滚 |

### 测试 / CI
| # | 问题 | 位置 | 影响 / 建议 |
| --- | --- | --- | --- |
| T-W1 | Playwright "E2E" 除 1 个外全部 mock `/api/**`；真实黑盒 smoke（`server-py/tests/smoke/` 三个脚本）文件名不匹配 pytest 收集规则、无 package.json 脚本、无 CI 步骤引用 | `tests/platform-test.ts:55-107`、`server-py/pytest.ini`、`.github/workflows/phase0-ci.yml` | 前后端契约回归只靠进程内 TestClient，不过真实 HTTP/生产启动器。加 `test:smoke:py`：临时数据目录 `npm run start` + bootstrap + 跑三个 smoke |
| T-W2 | `runner.py`（20.8 KB 执行引擎）直接测试仅 31 行（只测 `interpolate`）；多步失败/重试计数/截图与 trace 失败路径/超时无单测 | `tests/unit/test_runner.py` | 执行引擎是核心风险面。按 `test_recorder_poc.py` 的 seam 补表驱动用例 |
| T-W3 | `test:all` 非 CI 超集（缺 `test:coverage`，覆盖率阈值只在 CI 强制）且以 `test:windows` 结尾在纯 Linux 必挂 | `package.json` scripts | 开发者用 `test:all` 作准入门禁会漏覆盖率回退。补 `test:coverage`；`test:windows` 在无 powershell.exe 时警告跳过 |
| T-W4 | Playwright 端口 8787 三处硬编码 | `playwright.config.ts:19,25`、`tests/full-user-journey.spec.ts:15` | 端口被占/并发跑冲突报错难懂。从 `process.env.PLATFORM_PORT ?? 8787` 派生 |

## INFO（不阻塞，按优先级择要）

- 后端：runs 列表 N+1（`handler.py:3679` + `run_response` 每行 4 查，pageSize=100 时可达数百查询含全量快照）；`/ready`、`/metrics` 每请求在事件循环跑 `PRAGMA quick_check`（`main.py:259,275`）；LIKE 过滤未转义 `%`/`_`（`handler.py:3646, 4902`）；数据集上传 base64 先解码后限长（`services.py:3972-3976`）；backup manifest 的 `rel` 未做越界校验（`backup.py:46,104`，仅 CLI 可达）。
- 前端：`request()` 的 `init.signal` 被 15s 超时控制器覆盖（`platform-api.ts:409-411`，当前无调用方传 signal）；`moveStep` 只校验 `to` 不校验 `from`（`flow-store.ts:58-64`，现有调用方已自守）；超时输入框清空被静默置 0（`FlowEditorPage.tsx:1838-1840`）；`normalizeFlow` 允许空字符串 step id（`flow-normalize.ts:16`）；录制轮询闭包持有旧 context（`FlowEditorPage.tsx:709`，token 为常量"cookie"暂无实际影响）。
- 脚本：install.ps1 接受明文命令行密钥参数（`install.ps1:6`，进程列表/历史可见）；`verify-lock.py` 把"锁定包未安装"当成功（`verify-lock.py:38-39`）；restore.ps1 不做 `PRAGMA integrity_check` 预检；CSP 允许 `unsafe-inline` script（`index.html:7`）；`vitest.config.ts:9` 含已退役 `server/**` 死 glob。
- 测试：`tsconfig.node.json` 仅含 `vite.config.ts` —— `vitest.config.ts`、`playwright.config.ts`、全部 `scripts/*.mjs`（含生产启动器）不在任何 tsc 检查范围；`docs/自测报告-苹果风格迭代.md:16-20` 引用已不存在的 `test:platform`/`test:managed`/`test:production`/`test:worker` 脚本。

## 误报排除与确认健壮的区域（重要）

以下曾被怀疑、经核实为规范内有意设计或实现正确，未计入问题：

1. **身份/RBAC/隔离层异常扎实**：scrypt 口令哈希 + `hmac.compare_digest`；会话仅存 SHA-256 摘要、禁用/改角色/重置全量吊销；Cookie `HttpOnly; SameSite=Strict; Secure`；邀请/重置令牌摘要存储 + `BEGIN IMMEDIATE` 一次性消费；全部路由 `session_user` + capability 校验，子资源一律父级限定查询；无字符串拼接 SQL（f-string 只拼固定片段与 `?` 占位列表）。
2. **Webhook/SSRF/路径/命令**：HMAC-SHA256 + 时间戳容差 + 重放防护；通知目标禁 userinfo、禁私网段、DNS 解析后钉住 IP；产物文件名服务端生成；retention 删除 `startswith(base + os.sep)` 限定；全包零 `subprocess`/`shell=True`。
3. **Secret 全链路**（前端）：secret-store 不持久化、workspace-store partialize 置空、outbox 落盘前 `sanitizeVariable`、revision 快照过滤 secret、录制解码脱敏 —— 均有真实断言测试背书（`sync-outbox.test.ts:43-49` 等）。
4. **sqlite-backup 只拷主文件不是 bug**：拷贝前 `PRAGMA wal_checkpoint(TRUNCATE)` 已把 WAL 清零（thinking guide 中的"WAL 三文件"教训在此路径已被正确处理）；且带源/副本行数与 `MAX(created_at)` 一致性校验。
5. **`.env` 加载安全**（start-production.mjs）：拒绝符号链接、owner + chmod 600 强制（POSIX）、`O_NOFOLLOW`、文件值不覆盖继承环境。
6. **Playwright 配置保守防抖**：0 retries、workers=1、`reuseExistingServer: false`、无 `waitForTimeout`。
7. **测试无空转**：全库无 `assert True`/`it.skip`/`pytest.mark.skip`/吞异常断言；近期修复（3732f61 录制登录态复用等）均有配套回归测试。
8. **规范内有意设计**（曾疑为问题）：`request<T>` 边界类型断言、`token: "cookie"` 字面量会话兼容、artifact 下载按所属项目鉴权、分页 clamp min(100)。

## 修复优先级建议

1. **立即**：C-3（Windows 服务无法启动，一处修复 + smoke 补漏 S-W1）、C-2（用户数据丢失，编辑器 isDirty 守卫）、F-W1（同文件顺手修）。
2. **本迭代**：C-1（数据库串行化，需谨慎回归）、S-W4/S-W5（备份正确性）、B-W4（错误分类）、F-W2（审计脱敏）。
3. **规划**：B-W1（通知异步化）、T-W1（真实后端 smoke 接线）、B-W2、S-W2/S-W3/S-W6/S-W7/S-W8、T-W2/T-W3、其余 INFO。

---

## 修复记录（2026-08-22，用户批准后执行）

「立即 + 本迭代」两档已全部修复并通过全部质量门禁（lint 0/0、build ✓、test:unit 66/66、test:py 169/169、test:startup 14/14、test:windows smoke ✓、check:bundle ✓）：

| 编号 | 修复内容 | 文件 |
| --- | --- | --- |
| C-1 | `PlatformServices.database` 改为每线程连接 property（WAL + 30s busy timeout），audit writer 惰性取连接；新增并发事务回归测试 | `services.py`、`audit.py`、`tests/unit/test_database_thread_isolation.py` |
| C-2 | 编辑器 effect 以「流程 ID + 内容序列化 + isDirty」判定是否重载，脏草稿不再被 30s 轮询覆盖，干净时内容不变也不重置选中步骤；新增 4 条谓词回归测试 | `FlowEditorPage.tsx`、`flow-store.ts`（`shouldReloadEditorSteps`）、`flow-store.test.ts` |
| C-3 | 生产门禁接受 `PLATFORM_SECRET_KEY_FILE`（存在/非空/可读校验，直接密钥优先），Windows 服务可启动；新增 3 条启动测试；规范同步 | `start-production.mjs`、`start-production.test.mjs`、`.trellis/spec/backend/production-startup.md` |
| F-W1 | `saveFlow` 仅在版本创建成功时置 `hasPublishedRevision`，失败置 false 由 `run()` 重试 | `FlowEditorPage.tsx` |
| F-W2 | 审计脱敏正则补齐 apiKey/accessKey/privateKey/authorization/cookie/session 等变体；新增测试 | `audit-mask.ts`、`audit-mask.test.ts` |
| B-W4 | 四处宽泛 `except Exception` 改捕 `sqlite3.IntegrityError`，真实故障不再伪装成 409 名称冲突 | `handler.py` |
| B-W5 | 两处 `with self.database:`（run 删除）改为显式 `BEGIN IMMEDIATE` 事务，删除原子 | `services.py` |
| S-W4 | 备份删除幽灵 `autoflow.sqlite` 腿；主库缺失 + `required` 即失败；restore 要求备份含 `platform.sqlite`；smoke 与文档同步 | `backup.ps1`、`restore.ps1`、`sqlite-backup.py`、`sqlite-backup.mjs`、`windows-scripts-smoke.ps1`、`docs/Phase0-初始运维说明.md` |
| S-W5 | 备份拷贝改为 `.tmp` → 校验 → 原子 rename，失败清理残留 | `sqlite-backup.py`、`sqlite-backup.mjs` |
| S-W1 | Windows smoke 渲染真实占位符集合，并断言模板无未消费占位符（防再次漂移） | `windows-scripts-smoke.ps1` |

「规划」档未动，需设计决策后另行排期：B-W1（通知投递异步化）、B-W2（默认密钥需显式 dev opt-in）、B-W3（异常文本映射错误码）、B-W6（限流键清理）、S-W2/S-W3/S-W6/S-W7/S-W8、T-W1～T-W4 及全部 INFO。
