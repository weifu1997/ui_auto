# Current-State Audit Evidence

> Snapshot: 2026-08-19, branch `python_3.1`, commit `9a5dd18`.
> This is a repository evidence audit, not a completed production certification.

## Current Verdict

当前版本已经超过纯原型：核心自动化闭环、资源并发冲突、项目边界、审计事件、单机服务、在线 SQLite 备份工具和较完整的本地测试矩阵都已存在。

但它尚不满足公司团队生产使用门槛。已确认的目标是“单公司内部多个团队/工作区共享一套部署”。按当前产品入口，它更接近“单 owner/单工作区的受控内网试点”：成员无法通过产品加入同一工作区，授权模型部分失效；LAN 默认无 TLS；备份路径与实际产物路径不一致；维护故障不可观测；质量门禁没有 CI 强制；研发任务状态存在明显漂移。

## Dimension Matrix

| Dimension | Status | Confidence | Existing Capability | Material Gap |
| --- | --- | --- | --- | --- |
| Multi-user collaboration | Partial | High | 资源级 version、409 冲突、outbox、远端刷新/重新提交 | 没有成员邀请/移除/停用；开放注册只创建各自工作区；没有协作可见性、锁或变更通知 |
| Identity, permission, audit | Partial | High | scrypt 密码、12h session、HttpOnly/SameSite、角色矩阵、项目 capability、审计查询和脱敏 | workspace admin/capability 参数未执行；无 SSO/MFA/密码恢复/账号管理；Secure cookie 非默认；审计无外部归档与防篡改 |
| Data isolation | Partial | Medium | workspace/project 外键和大部分项目作用域查询；非成员与部分跨项目测试 | 没有全路由授权矩阵；跨项目 dependent-row 缺陷曾进入工作区；无不可信租户威胁模型和隔离测试套件 |
| Deployment and operations | Partial | High | 单一生产入口、启动前检查、WinSW 常驻/重启/日志滚动、升级/回滚脚本 | 无 TLS/反代方案、服务账号/ACL 基线、离线可复现制品、正式 runbook；生产主机现场 `npm ci`/`pip install` |
| Stability and recovery | Partial | High | WAL、busy timeout、queued 恢复、running 中断收口、watchdog、备份 integrity check | 产物备份路径错误；无 RPO/RTO 和定期恢复演练；维护异常静默；soak 字段错误；单机/单 SQLite/单 runner 无冗余 |
| Test and release gates | Partial | High | `test:all` 覆盖 build/lint/unit/startup/Python/bundle/E2E/Windows smoke；最近全绿 | 无 CI workflow/受保护分支/CODEOWNERS；无覆盖率阈值、安全/依赖扫描；Python 依赖不锁定；无签名版本制品 |
| Documentation | Partial | High | README、部署决策、自测报告、录制用户文档、Trellis specs | 无操作手册、恢复手册、故障响应、升级矩阵、账号/权限手册、贡献/安全/发布文档；历史报告有已修复项未回标 |
| Engineering governance | Partial | High | Trellis phase gate、PRD/design/implement、spec capture、全量检查约定 | 8 个活跃任务；已完成验收的任务未归档；planning 与代码现实漂移；无仓库级 PR/评审/发布强制证据 |

## High-Risk Evidence

### E1. Team membership is not a product capability

- `POST /api/auth/register` is open and always creates a new owner workspace (`server-py/autoflow/handler.py:209-280`).
- The decision record explicitly removed member endpoints and invite flows (`docs/决策-内网部署形态与平台裁剪.md:66-69`).
- The role matrix still exists (`server-py/autoflow/workspaces.py:6-68`), but `require_workspace_role(..., admin=True)` and `require_workspace_capability(...)` only check membership (`server-py/autoflow/services.py:631-639`).
- Project capability checks do evaluate the stored role (`server-py/autoflow/services.py:689-698`), leaving an inconsistent model that is not manageable from the product.

### E2. LAN authentication is documented over plaintext HTTP

- Target access is `http://<部署机IP>:8787` (`docs/决策-内网部署形态与平台裁剪.md:14`).
- The session is HttpOnly and SameSite=Strict, but `Secure` is added only when `AUTOFLOW_COOKIE_SECURE=1` (`server-py/autoflow/auth.py:58-78`).
- No checked-in TLS termination, certificate, proxy trust, or HTTPS deployment runbook was found.

### E3. Backup does not cover the runtime artifact location

- `PlatformServices` constructs `ManagedRunner(Path(data_directory) / "artifacts")` (`server-py/autoflow/services.py:410-422`).
- WinSW declares `PLATFORM_ARTIFACT_DIRECTORY=%BASE%\artifacts\platform`, but the service constructor does not use that constant (`deployment/AutoFlow.xml:9-11`; `server-py/autoflow/core.py:27-29`).
- `backup.ps1` and `retention.ps1` copy/prune `%BASE%\artifacts`, not `%BASE%\data\artifacts` (`scripts/backup.ps1:13`; `scripts/retention.ps1:3-5`).
- The Windows smoke creates an artificial root artifact and therefore cannot detect this production path mismatch (`scripts/windows-scripts-smoke.ps1:28-36`).

### E4. Operational failures can be silent

- `/ready` performs a SQLite quick check and returns `{ ready: true }` (`server-py/autoflow/main.py:158-161`).
- `soak-test.ps1` tests `$result.ok`, so a healthy server is recorded as not ready (`scripts/soak-test.ps1:7-12`).
- The maintenance loop catches every exception without logging or surfacing a metric (`server-py/autoflow/main.py:223-279`). Schedule, notification, retention or watchdog failures can recur without an operator signal.

### E5. Local quality scripts are not enforced release gates

- `package.json:14-23` defines a broad `test:all` pipeline.
- No tracked `.github/workflows`, GitLab CI, Jenkinsfile, CODEOWNERS, dependency bot or equivalent configuration was found.
- `vitest.config.ts:4-10` has no coverage collection/threshold, and `server-py/requirements.txt:1-8` uses lower bounds rather than a production lock.

### E6. Task state is not a reliable source of truth

- The Trellis context reports 8 active tasks.
- `08-15-flow-recording-mvp/implement.md:69-103` is fully checked but task status remains `in_progress`.
- `08-16-legacy-e2e-failures/prd.md:63-65` is fully accepted but task status remains `in_progress`.
- `08-16-flow-retry-reproduction-correctness` remains `planning` with unchecked implementation items while the current branch contains the corresponding retry tests and commits. Before new roadmap execution, active tasks must be reconciled against code and archived or re-scoped.

## Existing Strengths To Preserve

- Resource writes use versioned conflict detection and persistent draft recovery.
- Secrets use AES-GCM at rest and plaintext is constrained to runtime input paths.
- Run startup recovery distinguishes queued and interrupted running work.
- Audit detail conventions forbid secret values and the UI applies recursive masking.
- The supported production entry fails before listening when the build or platform secret is absent.
- Local tests exercise the built production SPA and real Chromium rather than only a dev server.

## Confirmed Gap Priority

优先级已按确认的产品边界冻结：单公司内部多团队共享部署、关闭开放注册并使用本地账户邀请/停用、超级管理员/管理员/成员三角色、单机 `RPO <= 24h` / `RTO <= 4h`、全局运行并发默认 2 / 单工作区默认 1，以及 `180/90/15` 天默认保留策略。

| Priority | Confirmed Gate |
| --- | --- |
| P0 | GOV-01 release baseline; CI-01 required CI; BKP-01 artifact-path recovery; OBS-01 readiness/maintenance visibility; IAM-01, IAM-02 and IAM-03 local identity, three-role RBAC and account lifecycle; SEC-01 HTTPS; ISO-01 route-wide isolation; COL-01 collaboration refresh; AUD-01 audit completeness; OPS-01 service account/key custody; BKP-02 RPO/RTO proof; RUN-01 workspace-fair concurrency; CAP-01 capacity evidence; DATA-01 complete retention; DOC-01 exercised runbooks |
| P1 | SEC-02 key rotation; REL-01 reproducible releases; OBS-02 centralized monitoring; QA-01 security/coverage gates; GOV-02 ownership and release governance |
| P2 | SCALE-01 only: external identity/audit, HA, higher scale and cross-company tenancy when future evidence requires them |

## Evidence Limits

- Repository evidence cannot prove GitHub branch protection or organization-level review rules; those require external verification.
- No real restore drill, long-duration soak result, penetration test, load test or disaster exercise was executed in this planning pass.
- Local accounts with administrator invitation/deactivation and a three-role model are confirmed for the first phase. Super-admin is deployment-global; admin is workspace-scoped; member owns normal authoring and run workflows but cannot manage membership, project deletion/archival, secrets, notification channels or workspace settings.
- Single-node recovery is accepted at RPO <= 24h and RTO <= 4h. Daily off-host backup and a successful timed restore drill are therefore release evidence; HA remains deferred.
- ManagedRunner must support configurable global concurrency (default 2) and a per-workspace default limit of 1. Queue selection must not let an ineligible workspace block other workspaces.
- Capacity evidence targets 10 workspaces, 100 accounts, 20 concurrent web users and 500 runs/day, with P95 latency, queue wait, host resources and disk growth recorded against a declared hardware profile.
- Local-account invitations use a one-time 24-hour link delivered by an administrator through an internal channel. After first success, replay returns `410 INVITE_ALREADY_USED` without account/workspace detail or duplicate state change. SMTP is outside the first phase.
- Configurable retention defaults are 180 days for audit logs, 90 days for run records/events and 15 days for screenshots/Trace artifacts. Phase 1 adds audit coverage only; DATA-01 in Phase 2 exclusively owns complete enforcement and production-readiness evidence.
- SSO/LDAP/MFA, detailed business roles and cross-company tenant isolation are deferred.
