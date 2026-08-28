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

---

## 当前 HEAD 复审（2026-08-22，`81adc8e`）

本节是对上方历史报告和修复记录之后当前代码的复审。上方标记为已修复的 C-1/C-2/C-3、F-W1/F-W2、B-W4/B-W5、S-W1/S-W4/S-W5 在当前 HEAD 均未复现；本节中的编号是当前仍需处理的项目，历史报告不应被误读为全部仍未修复。

### CRITICAL（已验证）

#### R-C1【前端/跨层】浏览器持久化状态和同步草稿不按账号隔离

- `src/stores/workspace-store.ts:285-313` 与 `src/stores/run-store.ts:54-55` 使用全局 localStorage key；退出登录路径 `src/pages/shared.tsx:166` 及会话失效路径 `src/App.tsx:190-200` 只清除 session，不清工作区、运行记录或冲突快照。
- `src/lib/sync-outbox.ts:23-36,74-84` 的草稿身份仅含 `workspaceId + projectId`，不含用户 ID。新会话的同步器会在远端水合前恢复草稿（`src/ServerWorkspaceSynchronizer.tsx:420-430`），并在随后自动调度提交（`:403-414,523`）。
- `ProjectsPage` 直接渲染持久化 store（`src/pages/ProjectsPage.tsx:30-58`），因此后一位登录者可在远端授权响应前看到上一位用户的缓存；若两人同属一个 workspace，后一位成员还会以自己的 token 自动提交上一位留下的未提交草稿。

影响：这是跨账号数据泄露和错误归属写入，不只是同一用户的离线草稿恢复问题。建议把 workspace store、run store、outbox、sessionStorage conflict 都以稳定 user ID 分区，并在身份变化时原子清空内存和旧分区引用；补“用户 A 登出 -> 用户 B（同/不同 workspace）登录”的可见性、草稿不自动提交回归测试。

### WARNING（已验证）

| 编号 | 证据 | 影响与建议 |
| --- | --- | --- |
| R-W1 | 运行密钥弹窗承诺“不会保存至服务器存储”（`src/pages/FlowEditorPage.tsx:246-255`；共享实现也在 `src/pages/shared.tsx:549-614`），但编辑器、流程列表、版本页分别在 `FlowEditorPage.tsx:998-1002`、`FlowsPage.tsx:109-114`、`AgentsPage.tsx:94-98` 调用 `POST /secrets`。该路由实际加密持久化（`server-py/autoflow/handler/secrets.py:51-105`）且要求 `secret.manage`（`:20-25`）；member 只有 `run.execute`、没有 `secret.manage`（`server-py/autoflow/workspaces.py:52-66`）。 | UI 的留存承诺错误；普通成员即使项目管理员已配置密钥，也会在运行时被要求提交密钥并收到 403，无法执行流程。区分“服务端已配置、仅供执行”的密钥与“创建/轮换密钥”的管理权限；只允许管理员持久化，普通成员可使用已配置值运行；修正文案并补 member-run 覆盖。 |
| R-W2 | 单次运行 API 入参没有幂等键（`src/api/platform-api.ts:780-785`），路由也未读取/传递该字段（`server-py/autoflow/handler/runs.py:95-110`）。服务层仅在调用者提供 `dispatchKey` 时去重（`server-py/autoflow/services/runs.py:363-369,464-482`）。编辑器“运行至此步骤”按钮在请求期间未禁用（`src/pages/FlowEditorPage.tsx:1900-1905`），而其它单次运行入口也没有请求锁。 | 双击、网络重试或两处操作并发会创建多组浏览器自动化，可能重复点击/提交外部系统。为单次运行生成并传递 idempotency/dispatch key，服务端按项目和发起者持久化去重；派发期间禁用所有对应按钮，并加入双击回归。 |
| R-W3 | `scripts/ops/backup-manifest.py:42-53` 只校验 manifest 中列出的条目，允许空或遗漏 `platform.sqlite` 的 `files`；`scripts/ops/restore.ps1:13-17` 只另行确认该文件存在后复制。最小复现中，删除 manifest 的 `platform.sqlite` 条目、替换数据库后，`verify` 仍返回 `ok`（exit 0）。 | 损坏或被替换的主库可绕过宣称的恢复完整性门禁并覆盖生产数据库。验证 manifest schema/version 和预期 payload 集，至少强制存在并校验 `platform.sqlite` 条目；补“遗漏条目、未列出文件、空 files”回归。manifest 不是签名，不能将此修复表述为来源真实性保护。 |
| R-W4 | `scripts/ops/install.ps1:40` 的 robocopy 未排除 `.env`、`.env.*`、`venv`/`.venv*`。生产启动器默认读取 `$app/.env`（`scripts/start-production.mjs:11-22,137-148`），Python 优先采用直接 `PLATFORM_SECRET_KEY`（`server-py/autoflow/services/core.py:51-60`）而非 WinSW 的受 ACL 保护 key file；`scripts/python-env.mjs:21-56` 还在 installer 创建的 `app/venv` 之前选择被复制的 `server-py/.venv*`。 | 本地开发密钥可静默覆盖托管密钥，开发虚拟环境可在生产中执行。robocopy 排除环境文件、所有开发 venv、`.trellis`、构建/测试产物；只创建并选择 `app/venv`；为包含开发 `.env`/venv 的安装源加隔离 smoke。 |
| R-W5 | 恢复脚本调用 `AutoFlow.exe stop` 后既不检查 `$LASTEXITCODE`，也不等待服务确实停止（`scripts/ops/restore.ps1:10-17`）。PowerShell 的 `$ErrorActionPreference = "Stop"` 不会因 native command 返回非零而抛出，最小探针在 `cmd /c exit 7` 后仍继续。 | stop 失败或服务仍在写 SQLite 时可直接覆盖数据库。检查 stop/start 退出码并轮询已停止状态后才替换文件；失败时退出，补 WinSW stop-failure 和 timeout 负向测试。 |
| R-W6 | `timeout 20s npm run test:py` 在 `test_identity_membership_lifecycle.py::test_http_role_matrix...` 超时（exit 124；TestClient 上下文为 `server-py/tests/unit/test_identity_membership_lifecycle.py:64`）。无产品代码的 FastAPI/Starlette `TestClient.__enter__()` 和 AnyIO portal 最小复现同样超时。当前锁定环境包含 `anyio==4.14.2`（`requirements.lock:6`）、FastAPI 0.141.1（`:12`）、httpx 0.28.1（`:17`）、Starlette 1.6.0（`:33`）；`pip check` 通过。`setup-py.mjs:61-65` 和 CI 实际安装宽泛的 `requirements.txt:1-8`，不使用/校验锁。 | Python 质量门禁当前不可用，且解析结果不可复现。验证一组可跨平台运行的 constraints/lock，让本地和 CI 安装并校验它；给 `test:py` 添加超时和堆栈诊断。尚未断言应升级或降级哪一个具体版本。 |
| R-W7 | 唯一 CI 工作流只监听 `python_3.1`（`.github/workflows/phase0-ci.yml:3-9`）。这原本由 `docs/生产基线发布与分支保护.md:7` 明确，但当前审查分支已经合并进 `origin/master` 的 `c45fa48`，关联工作任务仍声明 `master` 为基线（`.trellis/tasks/08-21-flow-assertion-mvp/task.json:16`）。 | 对当前分支 push 或以 `master` 为目标的 PR 不会触发任何 repo 内工作流，质量门禁可被绕过。确定唯一集成分支，并同步 workflow trigger、任务基线和 GitHub 分支保护；或明确要求所有变更只以 `python_3.1` 为目标。未声称远端分支保护已经或未已经启用。 |
| R-W8 | run 完成回调直接投递通知（`server-py/autoflow/services/runs.py:786` -> `services/notifications.py:337,377`）；每次最多处理 20 条（`:97`），单次 HTTP timeout 为 10 秒（`services/_shared.py:370`）。 | 慢通知端点可占用一个 ManagedRunner worker 最长约 200 秒，默认两个 worker 都被占用时后续流程无法调度。完成回调只入队，由维护循环（`server-py/autoflow/main.py:339-342`）或独立 worker 投递；补慢端点不阻塞下一运行的测试。当前回调已在 condition lock 外执行，历史报告中“阻塞事件循环/持锁”的表述应收窄。 |
| R-W9 | `server-py/autoflow/crypto.py:13-17` 有公开默认密钥；`services/core.py:51-64` 仅在 `NODE_ENV=production` 时拒绝未配置密钥。直接启动 Python 服务会绕过 Node 生产入口。 | 获得 SQLite 文件的一方可推导非 production 服务的项目密钥和 webhook 签名密钥。默认拒绝，或仅在明确 `AUTOFLOW_ALLOW_INSECURE_DEV_KEY=1` 时开放开发回退；补直接 Python 启动测试。 |
| R-W10 | 通道测试将 `str(exc)` 返回客户端并写审计（`server-py/autoflow/handler/channels.py:299`）；后台投递持久化原始异常（`services/notifications.py:173`），项目查看者可从 deliveries API 读到它（`handler/channels.py:473`）；模板应用也把 `str(e)` 放入 warnings（`handler/templates.py:829`）。 | DNS、连接、SQLite 等内部错误可能泄漏路径、主机名或实现细节。对外、审计和数据库只记录稳定错误码，原始异常仅进入受控服务端日志。 |
| R-W11 | 登录限流的窗口字典按 socket peer IP 维护（`server-py/autoflow/handler/auth.py:21-32`；地址来源 `handler/_shared.py:176`），键从不回收。已有可信代理机制只用于 HTTPS 判定（`transport.py:17-36`）。 | 反代后所有用户共享同一个 10 次/分钟桶，同时大量来源会造成字典持续增长。仅在可信代理时解析经验证的转发地址，定期清理过期桶，并补代理和清理测试。 |

### 本轮质量门禁

| 命令 | 结果 |
| --- | --- |
| `npm run lint` | 通过（0 warnings / 0 errors） |
| `npm run build` | 通过 |
| `npm run test:unit` | 通过（17 文件 / 66 用例） |
| `npm run test:startup` | 通过 |
| `npm run check:bundle` | 通过 |
| `npm run test:windows` | 通过（本机 PowerShell smoke） |
| `npm run test:py` | 未通过：20 秒 timeout，见 R-W6 |
| `npm run test:e2e` | 未执行：Python 全量门禁无法完成，本轮未启动真实服务 |
| `npm run test:coverage` | 本机未安装 lockfile 已声明的 `@vitest/coverage-v8`；属于本地依赖漂移，未作为产品缺陷 |

### 误报排除和状态校正

- `put_document` 的 `expectedVersion` 在人工多线程直接调用时有 TOCTOU，但当前实际调用方都位于同一 uvicorn event loop 的同步段，维护线程和 runner 不调用它；不列为当前生产缺陷。
- SQLite 跨线程共享连接、30 秒轮询覆盖编辑器草稿、`PLATFORM_SECRET_KEY_FILE` 启动门禁、备份原子落盘等历史 CRITICAL 已有当前回归代码，未复现。
- outbox 和 workspace 持久化会清空 secret 变量值；R-C1 是账号归属缺失，不是本地存储保留明文密钥。
- backup manifest 缺陷是完整性检查覆盖不足，不等同于能抵抗拥有备份目录写权限的攻击者篡改 manifest 和数据。

---

## 修复记录（2026-08-22 第二轮，用户批准后执行）

「高危三件」R-C1、R-W1、R-W2 已修复。R-W3~R-W11 未动，仍待排期。

### R-C1 持久化状态与草稿按账号隔离

| 内容 | 文件 |
| --- | --- |
| 新增用户分区存储层：`userScopedStorageKey` / 一次性旧 key 迁移 `migrateUnscopedStorageKey` / zustand `StateStorage` 适配器 | `src/lib/user-scoped-storage.ts`（新增）、`platform-context.ts`（`currentPlatformUserId`） |
| workspace store、run store 的物理键改为 `<key>:u:<userId>`（导出 `workspaceStorageKey`/`runStorageKey` 常量） | `src/stores/workspace-store.ts`、`src/stores/run-store.ts` |
| outbox 物理键同样分区；冲突快照键改为 `autoflow-conflict:<userId>:<projectId>`，读写清理收口为 `read/write/clearConflictSnapshot` 等 helper | `src/lib/sync-outbox.ts`、`ServerWorkspaceSynchronizer.tsx`、`pages/shared.tsx` |
| 新增账号状态重置：监听 `platformContextChangedEvent`（登出/过期/登录/恢复统一经过 `storePlatformSession`）；任何身份变化清内存（workspace/run/flow/secret store + TanStack queryClient）；仅在两个具体账号间切换时删除旧分区与冲突快照；同账号过期重登保留磁盘分区（离线草稿不丢） | `src/lib/account-state-reset.ts`（新增）、`src/main.tsx` |
| 回归测试：分区写入、同用户刷新不清、跨账号清空+旧分区删除、过期保留、匿名切换不动磁盘、旧 key 一次性迁移 | `src/lib/account-state-reset.test.ts`（新增 5 用例）、`src/lib/sync-outbox.test.ts`（+2 用例） |
| e2e 适配分区后键位 | `e2e/production-sync.spec.ts`、`e2e/workbench.spec.ts` |

效果：后登录者不再看到前一账号的缓存项目/运行记录，同步器不会恢复更不会自动提交前一账号的草稿（`schedulePendingDrafts` 读取的 outbox 已按用户隔离）。

### R-W1 运行密钥：区分「使用已配置值」与「持久化管理」

| 内容 | 文件 |
| --- | --- |
| `requestRunSecrets` 重写为 `ensurePlatformRunSecrets`：先读 `GET /secrets`（角色级权限，member 可读名称清单）；已配置密钥直接放行（部署机用服务端值执行）；未配置时 member 明确提示「联系项目管理员」并终止（不再触发 403）；admin 弹窗如实声明「密钥将加密保存至服务器」，已配置项留空沿用已保存值（保留轮换入口） | `src/pages/shared.tsx`（含纯函数 `splitSecretRequirements`） |
| 删除 `FlowEditorPage` 内重复的弹窗实现；三个运行入口（编辑器、流程列表、版本页）统一走共享实现，`savePlatformSecret` 循环移入弹窗确认回调 | `FlowEditorPage.tsx`、`FlowsPage.tsx`、`AgentsPage.tsx`、`platform-api.ts`（新增 `getPlatformSecrets`） |
| 服务端零改动：member 用已配置密钥运行本就支持（`resolve_run_spec` 服务端校验），GET=角色级 / POST=`secret.manage` 已有矩阵测试背书（`test_route_authorization_matrix.py:185-186`） | — |
| 回归测试：已配置放行不弹窗、member 缺密钥报错不写入、admin 弹窗未填拒绝提交、split 纯函数 | `src/pages/run-secrets.test.tsx`（新增 6 用例） |

### R-W2 单次运行幂等键 + 派发期间禁用

| 内容 | 文件 |
| --- | --- |
| `createPlatformRun` 入参支持 `dispatchKey`；路由读取并透传（>128 字符返回 `RUN_DISPATCH_KEY_INVALID`），复用服务层既有 `dispatch_key` 去重 | `platform-api.ts`、`server-py/autoflow/handler/runs.py` |
| 五个单次运行入口（编辑器运行/运行至此步骤、流程列表、版本页、运行列表重试、运行详情重试）生成 `web-<uuid>` 幂等键；网络超时/5xx 后保留复用同一 key（超时重点不产生重复自动化），成功或 4xx 才释放；派发期间禁用对应按钮（编辑器步骤面板按钮补上 `disabled`） | `FlowEditorPage.tsx`、`FlowsPage.tsx`、`AgentsPage.tsx`、`RunsPage.tsx`、`RunDetailPage.tsx`、`shared.tsx`（`newRunDispatchKey`/`shouldReleaseRunDispatchKey`） |
| 回归测试：dispatchKey 形态、超时后重试沿用同一 key（前端）；同 key 去重/不同 key 独立/无 key 各建（服务层直连） | `flow-editor-save.test.tsx`（+2 用例）、`server-py/tests/unit/test_run_dispatch_idempotency.py`（新增 3 用例） |

### 本轮门禁

| 命令 | 结果 |
| --- | --- |
| `npm run lint` / `build` / `check:bundle` | 通过（0 warnings / 0 errors；bundle ≤500 kB） |
| `npm run test:unit` | 通过（19 文件 / 78 用例，较上轮 +12） |
| `npm run test:py` | 定向通过：全量排除 R-W6 已知卡死的 `test_identity_membership_lifecycle.py` 后 167 通过（含新增 3 用例）；全量门禁仍被 R-W6 阻塞 |
| `npm run test:startup` / `test:windows` | 通过（14/14；smoke ok） |
| `npm run test:e2e` | 未执行：需真实服务且 R-W6 未解；e2e 键位已适配待后续验证 |

---

## 当前 HEAD 复审（2026-08-28，`b2f2f7c`）

范围：整个产品代码库（`src/`、`server-py/`、`scripts/`、`deployment/`、测试配置），对照 `.trellis/spec` 与阶段 1–4 / uv 迁移后的增量。历史 CRITICAL（C-1/C-2/C-3、R-C1）与已修 WARNING（F-W1/F-W2、B-W4/B-W5、S-W1/S-W4/S-W5、R-W1/R-W2）在当前 HEAD **未复现**。本节只列仍存在或新引入的问题。审查不修改产品代码。

### 质量门禁

| 命令 | 结果 |
| --- | --- |
| `npm run lint` | 通过（0 warnings / 0 errors，120 files） |
| `npm run build` | 通过 |
| `npm run test:unit` | 通过（27 文件 / 124 用例） |
| `npm run test:py` | 通过（**295 passed**，含 `test_identity_membership_lifecycle.py` 5 条；1 条 Starlette/httpx deprecation warning） |
| `npm run test:startup` | 通过（14/14） |
| `npm run check:bundle` | 通过（≤500 kB） |
| `npm run test:e2e` / `test:windows` | 未执行：本轮以静态审查 + 单元/集成门禁为主 |

R-W6（TestClient 卡死）在本机 **未复现**：身份生命周期测试已纳入全量 `test:py` 并在 58s 内通过。锁文件已切到 `uv.lock`。残留风险是 anyio 4.14.2 / Starlette 1.6.0 组合仍在 lock 中，且 `TestClient` 已标 deprecation；不把卡死列为当前缺陷。

### CRITICAL（已验证）

#### N-C1【后端】录制 create/stop/cancel 在 FastAPI 事件循环上同步阻塞

- `server-py/autoflow/handler/recordings.py:22-56`：`async def recording_session_create` 直接调用 `recording_coordinator.create_session`。
- `server-py/autoflow/recorder.py:182`：`session["browserReady"].wait(timeout=120)` 最长阻塞 120s。
- stop/cancel 路径同样同步：`handler/recordings.py:228` → `coordinator.stop` → `_release_browser` 的 `future.result(timeout=30)`。
- 同进程里唯一用 `run_in_threadpool` 的 Playwright 入口是 preview（`handler/runs.py:32`），录制未同等处理。

影响：一次「开始录制」可冻结该 worker 上全部 HTTP（登录、健康检查、运行轮询、其他录制）最长约 2 分钟。uvicorn 默认每进程一条事件循环。

建议：create/stop/cancel 走 `await run_in_threadpool(...)`（或 `asyncio.to_thread`）；浏览器未就绪时立即 `RECORDING_BUSY`，不要在事件循环上 `wait(120)`。

#### N-C2【部署】默认 WinSW HTTPS 使 `upgrade.ps1` 健康检查必失败并回滚

- `deployment/AutoFlow.xml:9`：`AUTOFLOW_REQUIRE_HTTPS=1`。
- `server-py/autoflow/transport.py:17-36`：loopback 明文 HTTP **不**算 HTTPS（需 `x-forwarded-proto: https` 且 peer 匹配可信代理）；`test_secure_transport.py` 覆盖此行为。
- `scripts/ops/upgrade.ps1:19`：`Invoke-RestMethod http://127.0.0.1:8787/ready` 会收到 426 `HTTPS_REQUIRED`，进入 catch，停服务、删新 `app`、还原 `app-previous-*`。

影响：按默认 XML 安装后，成功的包替换也会被健康检查判定失败并整包回滚。`soak-test.ps1` 使用同一 HTTP URL。

建议：loopback 探测豁免 HTTPS 中间件，或升级脚本走 TLS 代理 / 带转发头；不要对强制 HTTPS 的生产实例打明文 `/ready`。

### WARNING（已验证）

#### 后端 / 执行

| # | 问题 | 位置 | 影响 / 建议 |
| --- | --- | --- | --- |
| N-W1 | URL 断言忽略 `timeout_ms`，只读一次 `page.url` | `runner.py:415-436` | SPA/延迟跳转上一步「URL 断言」易误失败，超时字段无效。用 `wait_for_url` / `expect(page).to_have_url(..., timeout=timeout_ms)` |
| N-W2 | 定位自愈对元素动作的**任意**异常回退；role 回退丢掉 accessible name | `runner.py:186-191, 635-665` | 原定位已命中但被遮挡/禁用时，可能 click/fill 页面上另一个 `count()===1` 的控件。仅在 not-found / strict-mode 时自愈；role 回退保留 name |
| N-W3 | 心跳只在每步开始刷新；watchdog 按 `updated_at` 判死 | `runner.py:806-810`、`_lifecycle.py:881-896`、`main.py` 维护循环 | 单步 timeout 大于 watchdog 窗口（默认 20 分钟，下限 5）的 click/goto 会被 `MANAGED_RUN_WATCHDOG_TIMEOUT` 杀掉。步内定时心跳，或 staleness = max(watchdog, step timeout + slack) |
| N-W4 | `started()` 忽略 0 行 UPDATE，仍写 `run.started` 并继续执行 | `_lifecycle.py:657-665`；cancel 在 `handler/runs.py:328-330` | queued 已被置 canceled 时 worker 仍可能跑完整流程；`finalize_completed_run` 对 canceled 不 absorb 迟到 success。0 行则跳过执行或立即 set signal |
| N-W5 | `finalize_run_as_interrupted` 非事务，且 `flush=True` 同步投递 | `_lifecycle.py:969-985` | 崩溃可留下 `failed` 无事件/通知；watchdog 线程还会同步 HTTP 投递。对齐 `finalize_completed_run` 的 `BEGIN IMMEDIATE` + `flush=False` |
| N-W6 | 断言报告文件名按 `assertion-report-{run_id}.{ext}` 固定 | `_report.py:95-117` | 再次导出覆盖同一路径，两条 artifact 行共享文件；删一条会让另一条 404。文件名加 UUID/时间戳 |
| N-W7 | `redact_run_value` 失败时返回字符串 `"***"` | `_base.py:12-41` → `_lifecycle.py:907,932` | 解密/DB 异常时 `persist_flow_outputs` 对 str 调 `.get` 抛 AttributeError，事务回滚，run 卡在 running 直到 watchdog。失败应返回同类型空结构 |
| N-W8 | `run_trend` SQL 窗口（now−N×24h）与日历桶（今天往前 N 天）不一致 | `_aggregation.py:120-174` | 视时刻可能多出第 N+1 个点。按日历日截断，或忽略未预播种的日期 |
| N-W9 | 录制全局 `ThreadPoolExecutor(max_workers=1)` + 120s wait | `services/core.py:41-43`、`recorder.py:182` | 第二用户/项目的 create 会空等 120s 再 409，且（叠加 N-C1）堵事件循环。每会话一线程，或槽满立即 `RECORDING_BUSY` |
| N-W10 | 采集脚本写死 `data-testid`，忽略环境 `testIdAttribute` | `recorder_capture.py:69` vs `recorder.py:116-144` | `data-cy`/`data-test` 环境录不到最强定位，回放更易失败。按 `@@TOKEN@@` 注入属性名 |
| N-W11 | `ManagedRunner.cancel` 持 `_condition` 跨线程关 Playwright | `managed_runner.py:66-80,144-150` | Playwright sync 非线程安全；close 阻塞时 enqueue/其他 cancel 全部卡住。锁内只 set signal，由 worker 关浏览器 |
| R-W8 | run 完成仍在 ManagedRunner worker 上同步投递（最多 20×10s） | `_lifecycle.py:939-949`、`notifications.py:106` | 事务拆分已做，网络发送未移走。worker 路径一律 `flush=False`，交给维护循环 |
| R-W9 | 非 `NODE_ENV=production` 时静默使用公开默认密钥 | `crypto.py:13-17`、`services/core.py:65-68` | 直接起 Python 或误配环境时，能读库即可解密 secret。缺密钥默认拒绝，仅显式 dev opt-in |
| R-W10 | 通道测试 / 投递 / 模板应用把 `str(exc)` 返回客户端 | `handler/channels.py:299-315`、`notifications.py:173-178`、`handler/templates.py:830` | 泄漏主机名/TLS/SQLite 细节。对外稳定错误码，原文只进服务端日志 |
| R-W11 | 登录限流按 socket peer IP，键不回收；可信代理未用于 XFF | `handler/auth.py:21-43`、`handler/_shared.py:176-179` | 反代后全员共享 10 次/分钟桶。可信代理时解析转发地址并清理过期键 |

#### 前端

| # | 问题 | 位置 | 影响 / 建议 |
| --- | --- | --- | --- |
| N-W12 | 录制进入终态（关窗/超时/interrupted）只清存储，不取结果；Stop 在终态隐藏 | `FlowEditorPage.tsx:554-557, 595-597, 932` | 进程内仍有 `normalizer.result()`，UI 丢草稿。终态提供 GET result 或允许对 failed/expired 再 stop 一次导入 |
| N-W13 | `staleAssertionFields` / `ASSERTION_FIELDS` 不含 `trimCompare` | `assertion-step-draft.ts:6-41` | 从文本断言切走后 `trimCompare` 残留进 checksum（`STEP_KEYS` 含该字段）。切换动作时按契约清掉 |

#### 脚本 / CI / uv 迁移

| # | 问题 | 位置 | 影响 / 建议 |
| --- | --- | --- | --- |
| N-W14 | Python Chromium 安装时未带 `PLAYWRIGHT_BROWSERS_PATH` | `install.ps1:42-50`、`upgrade.ps1:16` vs `AutoFlow.xml:14` | 运行时看 `%BASE%\browsers`，uv 的 `playwright install` 打到用户缓存。upgrade 甚至不跑 Node 安装。安装步骤必须带同一环境变量 |
| N-W15 | 生产不钉 `app\venv`；`resolvePython()` 优先 `server-py/.venv` | `python-env.mjs:21-61`、`install.ps1:40,47-49`、`AutoFlow.xml` 无 `AUTOFLOW_PYTHON` | 叠加 R-W4：robocopy 拷入的开发 venv 会盖过 `app\venv`。XML 设 `AUTOFLOW_PYTHON=%BASE%\app\venv\Scripts\python.exe` 并排除 `.venv*` |
| N-W16 | CI `uv lock --check` 在未冻结的 `uv sync` **之后** | `phase0-ci.yml:48-52`、`setup-py.mjs:48-52` | sync 可改写 lock，随后 check 必绿。check 放在 setup 前，或 CI 用 `uv sync --frozen` |
| R-W3 | manifest verify 不要求 `platform.sqlite` 条目 | `backup-manifest.py:37-53`、`restore.ps1:8-13` | 删掉 manifest 中该条目后 verify 仍 ok，可覆盖生产库。强制 schema + 必有主库条目 |
| R-W4 / S-W3 | robocopy 不排除 `.env`、venv、`.trellis` | `install.ps1:40` | 开发密钥可覆盖 WinSW key file（`start-production.mjs` 缺进程环境时读 `$app/.env`，且直接 `PLATFORM_SECRET_KEY` 优先于 FILE） |
| R-W5 | restore 不检查 `AutoFlow.exe stop` 退出码 | `restore.ps1:11` | 服务仍在写库时覆盖 SQLite。检查 `$LASTEXITCODE` 并等待已停止 |
| S-W2 | install/upgrade 的 npm/uv/WinSW 原生命令不查退出码 | `install.ps1:44-54`、`upgrade.ps1:11-16` | 构建失败仍启动陈旧/半安装服务 |
| S-W6 | `process.once(signal)` 二次 Ctrl+C 可留下孤儿 uvicorn | `start-production.mjs:216-220`、`server-py.mjs:34-38` | 改 `process.on` + 超时 SIGKILL |
| S-W7 | retention/restore/rollback/upgrade 无 `-WhatIf`；restore 无预快照 | 各 `scripts/ops/*.ps1` | 误传 `-Root` 即删错目录 |
| S-W8 | `upgrade.ps1` 的 move/expand/npm/uv 在 try 外 | `upgrade.ps1:3-18` | npm/uv 失败留下半部署且服务已停 |

### INFO（不阻塞，择要）

- 契约文档仍写「断言动作 4 个 / `_ASSERTION_TYPES`」（`assertion-field-contract.md:51`），代码与 parity 测试已是 5 个（含 URL）；`src/domain/model.ts:44` 注释仍写 assertMatch「仅文本/属性」。
- 统计端点 `?windowDays=`，趋势端点 `?window_days=`（前端已分别对齐）；调错参数会静默变成全量窗口。
- HTML 报告 `@@TOKEN@@` 顺序替换：流程名若为 `@@ROWS@@` 会把表格 HTML 打进 `<h1>`（单元格已 escape，非脚本 XSS）。
- `/metrics` 无鉴权（默认绑 127.0.0.1）；LIKE 过滤未转义 `%`/`_`；数据集 base64 先解码后限长。
- `setup-py.mjs` 用 `server-py/.browsers` 判断是否跳过安装，实际 `playwright install` 未传入该 `PLAYWRIGHT_BROWSERS_PATH`。
- `project.edit` 能力未在任何 handler 使用。
- 录制 login snapshot 与 normalizer warnings 无上限。
- CI 仍只监听 `python_3.1`（文档已写明为集成分支）；对 `master`/`v3.2_flow_assertion` 的 push 不跑工作流。属流程风险，不是逻辑 bug。
- `test:all` 在无 PowerShell 的 Linux 上以 `test:windows` 结尾会失败。

### 误报排除与确认仍健壮的区域

- 历史 C-1（每线程 SQLite）、C-2（脏草稿不被 30s 轮询覆盖）、C-3（`PLATFORM_SECRET_KEY_FILE` 启动门禁）、R-C1（按账号隔离存储）、R-W1（密钥使用 vs 管理）、R-W2（dispatchKey）均仍在。
- URL 断言契约形状正确：复用 `value`+`assertMatch`，无新 `STEP_KEYS`，无 `STEP_ELEMENT_REQUIRED`，未知动作 `UNSUPPORTED_ACTION`，`step.asserted` 在 completed/failed 之前。
- HTML 报告字段 `html.escape` + `redact_run_value`；前端无 `dangerouslySetInnerHTML`。
- 自愈评分 `count()!=1` → `-inf`，CSS/XPath 不生成候选；`_heal_locator` 不会采纳全员 `-inf`。
- 身份/RBAC/隔离、webhook SSRF 钉 IP、secret 前端不落盘、备份 WAL checkpoint 后只拷主文件：仍成立。
- uv 迁移本身：`pyproject.toml` runtime/dev 分组、生产 `--no-dev --locked`、CI `setup-uv`、Windows `python -m uv` 引导，方向正确；问题在安装路径/锁检查顺序/venv 选择，不在锁格式。
- R-W6 卡死本机未复现（295 pytest 全绿）。不声称所有环境都不会再挂。

### 修复优先级建议

1. **立即（生产可用性）**：N-C2（Windows 升级必回滚）、N-C1（录制堵死事件循环）、N-W14/N-W15 + R-W4（错误 venv / 浏览器路径 / `.env` 覆盖密钥）。
2. **本迭代**：N-W1（URL 等待）、N-W2（自愈误点）、N-W6（报告文件名）、N-W7（redact 类型）、N-W12（录制终态草稿）、N-W16（CI lock 门禁）、R-W8（通知离 worker）、R-W5/R-W3（恢复完整性）。
3. **规划**：R-W9/R-W10/R-W11、N-W3/N-W4/N-W5/N-W8/N-W9/N-W10/N-W11、S-W2/S-W6/S-W7/S-W8、契约文档「4 个」漂移、其余 INFO。

审查任务按 PRD **不直接改产品代码**。批准后可按上述优先级开修复任务。

---

## 修复记录（2026-08-28，用户批准「立即」+ 旧 WARNING）

| 编号 | 修复 |
| --- | --- |
| N-C1 | 录制 create/stop/cancel/cancel-active 走 `run_in_threadpool` |
| N-C2 | HTTPS 中间件豁免 `/ready`、`/health`；upgrade.ps1 明文探测可成功 |
| N-W14 | install/upgrade 在 `PLAYWRIGHT_BROWSERS_PATH` 下安装 Python Chromium |
| N-W15 | WinSW 设置 `AUTOFLOW_PYTHON=%BASE%\app\venv\Scripts\python.exe` |
| R-W4 | robocopy 排除 `.env` / `.venv*` / `venv` / `.trellis` |
| R-W8 | `queue_run_deliveries` 默认 `flush=False`；worker 终态不再同步投递 |
| R-W9 | 缺密钥失败；仅 `AUTOFLOW_ALLOW_INSECURE_DEV_KEY=1` 且非 production 允许开发默认密钥 |
| R-W10 | 通道测试/投递/模板占位符改为稳定错误码 |
| R-W11 | 可信代理时用 X-Forwarded-For；过期限流桶清理 |
| R-W3 | manifest verify 要求 version=1 且含 `platform.sqlite` |
| R-W5 | restore 检查 stop/start 退出码并等待进程退出 |
| N-W1 | URL 断言有 `wait_for_url` 时等到命中或超时 |
| N-W2 | 自愈仅在原定位未命中/strict mode 时触发；role 回退保留 accessible name |
| N-W6 | 断言报告文件名带 UUID，避免覆盖 |
| N-W7 | `redact_run_value` 失败保持原类型；单行解密失败跳过该 secret |
| N-W12 | 终态录制 GET `/result`；编辑器自动/手动导入有步骤的草稿 |
| N-W16 | CI 先 `uv lock --check` 再 `uv sync --frozen` |
| N-W3 | 步内心跳线程按 `RUN_HEARTBEAT_INTERVAL_S` 续命 |
| N-W4 | `mark_run_started` 0 行则 worker 跳过执行 |
| N-W5 | `finalize_run_as_interrupted` 使用 `BEGIN IMMEDIATE` |
| N-W8 | 趋势窗口按日历日起点截断，不追加窗口外日期 |
| N-W9 | 录制全局槽满立即 `RECORDING_BUSY`（默认 4） |
| N-W10 | 采集脚本注入环境 `testIdAttribute` |
| N-W11 | cancel 只 set signal，不在锁内跨线程关浏览器 |
| N-W13 | 切换动作时清掉 `trimCompare` |
| S-W2/S-W6/S-W7/S-W8 | 安装/升级检查退出码；信号常驻+SIGKILL；WhatIf；upgrade 整段 try 回滚 |
