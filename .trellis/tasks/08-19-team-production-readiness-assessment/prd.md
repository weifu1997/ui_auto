# 团队生产可用性评估与改造路线图

## Goal

以可复核的仓库证据判断 AutoFlow Workbench 是否满足公司团队生产使用要求，形成当前能力基线、分级差距清单和带退出门槛的分阶段改造路线图，避免把“单机闭环跑通”误判为“团队生产可用”。

用户价值：团队负责人能明确知道当前系统适合何种使用范围、上线前必须消除哪些风险、哪些能力可以延后，以及每一阶段通过什么证据验收。

## Background And Confirmed Facts

- 当前产品明确按“一台内网电脑常驻、局域网网页访问、浏览器自动化只在部署机执行”的单机形态设计；多机 Agent 已裁剪（`docs/决策-内网部署形态与平台裁剪.md:11`、`:36`）。
- 2026-08-13 的部署自测覆盖网页编排、ManagedRunner、定时回归和飞书通知，共 29/29 项通过；这是功能闭环证据，不包含多人权限、灾备演练、长期稳定性或发布治理证明（`docs/自测报告-内网部署验证.md:32`）。
- 注册接口当前开放，任何能访问服务的人都可注册；每个注册用户会创建自己的 owner 工作区，产品已删除成员邀请和成员管理入口（`server-py/autoflow/handler.py:209`、`:258`；`docs/决策-内网部署形态与平台裁剪.md:66`）。
- 后端保留角色能力矩阵和项目级 capability 校验，但工作区 admin/capability 校验只验证成员身份，参数未生效；现有授权模型不完整且前后层语义不一致（`server-py/autoflow/workspaces.py:6`；`server-py/autoflow/services.py:631`、`:689`）。
- 项目资源具备版本号、乐观并发冲突和前端 outbox 草稿恢复；同资源并发编辑能提示冲突、刷新远端或重新提交（`.trellis/spec/frontend/state-management.md:67`；`tests/production-sync.spec.ts:151`）。
- 主要业务表以 `workspace_id` / `project_id` 建模，非成员访问和若干跨项目路径有测试；但目前没有覆盖全部 API 的统一授权矩阵。近期 run 删除曾出现跨项目 dependent-row 风险，现已修复并形成契约，说明隔离检查需要系统化（`server-py/autoflow/services.py:78`、`:84`；`.trellis/spec/backend/run-batch-recording-contracts.md:75`）。
- 审计表、事件命名、查询筛选、敏感字段规则和大量业务埋点已经存在；尚无不可篡改存储、外部归档/导出、审计保留期与审计运维流程（`.trellis/spec/backend/audit-governance.md:5`；`server-py/autoflow/audit.py:11`）。
- 生产入口会校验构建产物和 `PLATFORM_SECRET_KEY`，Windows WinSW 服务支持失败重启和日志滚动（`scripts/start-production.mjs:156`；`deployment/AutoFlow.xml:15`）。当前 LAN 文档使用 HTTP，session cookie 的 `Secure` 属性仅在显式环境变量开启时生效，仓库没有 TLS/反向代理部署方案（`docs/决策-内网部署形态与平台裁剪.md:14`；`server-py/autoflow/auth.py:58`）。
- SQLite 在线备份会执行 integrity check、WAL checkpoint 和复制后校验（`scripts/sqlite-backup.py:33`）；但运行时产物实际写入 `PLATFORM_DATA_DIRECTORY/artifacts`，而服务模板、备份和保留脚本处理 `%BASE%/artifacts`。`PLATFORM_ARTIFACT_DIRECTORY` 在当前服务构造中未使用，因此现有备份不能证明截图/Trace 可恢复（`server-py/autoflow/services.py:410`；`deployment/AutoFlow.xml:9`；`scripts/backup.ps1:13`）。
- 服务启动会把遗留 running run 标记失败并恢复 queued run；维护循环包含卡死运行 watchdog 和数据保留清理（`server-py/autoflow/services.py:438`；`server-py/autoflow/main.py:217`）。维护异常被静默吞掉，且 soak 脚本读取 `/ready` 的 `ok` 字段，而接口返回 `ready`，当前长期监测脚本会产生错误结果（`server-py/autoflow/main.py:158`、`:277`；`scripts/soak-test.ps1:8`）。
- 本地 `test:all` 已覆盖 build、lint、前端单测、启动测试、Python 测试、bundle、Playwright 和 Windows 脚本冒烟（`package.json:14`）。仓库没有 CI workflow、CODEOWNERS、覆盖率阈值、依赖/安全扫描或受保护分支配置的代码证据；Python 生产依赖仅以 `>=` 声明（`server-py/requirements.txt:1`）。
- 仓库有 README、部署决策、自测报告和 Trellis 规格，但没有独立的运维 runbook、故障响应、恢复演练、发布/回滚验收、贡献指南、安全响应或变更日志文档。
- 当前共有 8 个活跃 Trellis 任务；其中录制任务和遗留 E2E 任务的验收项已完成但仍为 `in_progress`，retry 规划任务的执行清单仍未同步最新实现。任务状态、代码提交和实际完成度已经漂移，应纳入研发治理整改。

详细证据矩阵见 `research/current-state-audit.md`。

## Requirements

### R1. 当前状态审计

评估以下八个维度，并对每个维度给出“已具备 / 部分具备 / 缺失 / 未验证”、证据文件、风险说明和可信度：

1. 多人协作；
2. 权限、身份与审计；
3. 工作区/项目数据隔离；
4. 部署、升级与日常运维；
5. 稳定性、容量、备份与恢复；
6. 测试、CI 与发布门禁；
7. 用户、开发和运维文档；
8. 分支、评审、任务和发布治理。

### R2. 生产可用性判定

- 目标部署模型已确定为单公司内部多个团队/工作区共享一套部署；各工作区成员、角色和项目数据必须受服务端授权边界保护。
- 第一阶段身份来源采用本地账户：关闭开放注册，由管理员邀请、停用成员；统一身份源延后。
- 第一阶段 RBAC 固定为三个角色：超级管理员、管理员、成员；不恢复现有代码中保留的八角色模型。
- 超级管理员是部署级全局角色，可治理全部账户、工作区和系统配置；管理员只治理所属工作区；成员只能使用所属工作区项目且不能管理成员。
- 成员可管理流程、元素、变量、环境、数据集、录制和运行，并查看运行结果；成员管理、项目归档/删除、密钥、通知通道和工作区设置仅管理员以上可操作。
- 首阶段接受单机故障恢复，目标为 `RPO <= 24h`、`RTO <= 4h`；路线图必须包含每日自动备份、独立故障域保存、恢复校验和定期演练。
- 共享 ManagedRunner 的全局并发可配置，默认 `2`；每个工作区默认最多 `1` 个运行任务。调度必须跳过已占满配额的工作区，并保持同一工作区内的队列顺序。
- 首阶段容量验收基线为：最多 `10` 个工作区、`100` 个账户、`20` 个并发网页用户、`500` 次运行/日；测试需同时覆盖编辑、查询、调度和双执行槽位。
- 管理员按邮箱生成一次性邀请链接，通过公司内部渠道线下发送；链接 24 小时失效。首次成功接受会原子消费 token；后续重放统一返回 `410 INVITE_ALREADY_USED`，不得泄露账户/工作区详情，也不得重复变更账户、成员关系、密码、会话或成功审计。新用户首次接受时自行设置密码；已有账户只新增 workspace membership，不重置密码。
- 目标默认保留策略可配置：审计日志 `180` 天、运行记录与事件 `90` 天、截图和 Trace 产物 `15` 天。Phase 1 只补齐审计覆盖和保留策略变更审计，不关闭 DATA-01，也不得宣称已执行这些期限；Phase 2 才实现并启用完整自动清理。清理必须保持项目隔离、写入安全摘要审计并提供 dry-run/容量预估。
- 给出当前版本的适用级别：个人开发、受信任小团队试点、公司内部生产或多部门平台。
- 任何“可用”判断必须列明前置条件、未验证风险和不得越过的使用边界。

### R3. 差距清单

- 每项差距包含唯一编号、所属维度、仓库证据、影响、优先级、阻断级别、建议责任边界和验证方式。
- P0 表示目标范围上线前必须完成；P1 表示试点后短期完成；P2 表示规模化或治理增强项。
- 将产品能力缺口、工程流程缺口、运维证据缺口和纯文档缺口分开，避免用文档掩盖实现问题。

### R4. 分阶段路线图

- 路线图至少包含：Phase 0 风险止血与研发收口、Phase 1 团队试点门槛、Phase 2 稳定生产门槛、Phase 3 规模化能力。
- 每阶段列出目标、任务包、依赖、退出标准、验证命令/演练和回滚点。
- 明确哪些改造应拆成独立 Trellis 子任务；本评估任务本身不直接修改产品代码。

## Scope

### In Scope

- 读取并核对当前仓库代码、测试、部署脚本、文档、Git/Trellis 状态；
- 形成审计报告、差距台账、风险排序和分阶段路线图；
- 为后续实施建议任务拆分、依赖顺序和验收门禁；
- 标记相互矛盾或已过期的文档/规格。

### Out Of Scope

- 在本规划任务内直接实现 RBAC、CI、TLS、备份修复或其他产品改造；
- 外部 SaaS 多租户、跨公司租户隔离、多机 Agent 或首轮高可用集群；
- 第一阶段接入 OIDC、SSO、LDAP 或 MFA；
- 第一阶段接入 SMTP 或平台主动邮件投递；
- 恢复 `publisher`、`product`、`tester`、`operations`、`editor`、`viewer` 等细分业务角色；
- 对公司现有 IdP、备份平台、监控平台和 GitHub 组织策略作无证据假设；
- 以一次本地测试通过替代恢复演练、容量测试或发布门禁证明。

## Acceptance Criteria

- [ ] AC1：八个维度均有状态、代码/文档证据、差距和可信度，不存在仅凭主观判断的结论。
- [ ] AC2：报告明确当前适用级别、目标适用级别、上线阻断项和残余风险。
- [ ] AC3：差距台账包含优先级、影响、建议 owner、验收方式和与现有 Trellis 任务的重复/依赖关系。
- [ ] AC4：路线图至少包含四个阶段，每阶段有可观察退出标准、验证/演练和回滚点。
- [ ] AC5：权限与隔离部分覆盖开放注册、成员生命周期、角色矩阵、workspace/project API 授权、审计脱敏与跨项目负面测试。
- [ ] AC6：运维与稳定性部分覆盖 TLS、密钥轮换、服务账号、日志/指标/告警、容量、备份内容、RPO/RTO、恢复演练、升级和数据库回滚。
- [ ] AC7：质量门禁部分区分“本地脚本存在”和“远端 CI 强制执行”，覆盖依赖锁定、安全扫描、覆盖率和发布产物可追溯性。
- [ ] AC8：研发治理部分核对并收口活跃任务、分支/PR/评审规则、任务状态漂移和版本发布责任。
- [ ] AC9：复杂规划所需 `prd.md`、`design.md`、`implement.md` 完整，通过 PRD convergence pass，并向用户提交最终规划摘要等待另行批准。

### Acceptance Traceability

| Acceptance | Primary Evidence |
| --- | --- |
| AC1-AC2 | `research/current-state-audit.md` 的八维矩阵、当前判定、高风险证据、当前适用范围与证据边界 |
| AC3 | `research/gap-register.md` 的差距台账、现有任务关系和当前/目标适用级别 |
| AC4 | `implement.md` 的 Phase 0-3 目标、任务包、退出门槛、回滚和验证演练 |
| AC5 | `design.md` 第 2-5 节；`research/gap-register.md` 的 IAM-01、IAM-02、IAM-03、ISO-01、COL-01、AUD-01 |
| AC6 | `design.md` 第 6-8、10-11 节；`research/gap-register.md` 的 SEC-01、SEC-02、OPS-01、BKP-01、BKP-02、OBS-01、OBS-02、CAP-01、RUN-01、DATA-01、REL-01 |
| AC7 | `design.md` 第 9 节；`research/gap-register.md` 的 CI-01、QA-01、REL-01 |
| AC8 | `research/current-state-audit.md` 的 E6；`research/gap-register.md` 的 GOV-01、GOV-02；`implement.md` Phase 0 与 Phase 2 |
| AC9 | 本 `prd.md`、`design.md`、`implement.md`、最终规划摘要及后续用户明确批准记录 |
