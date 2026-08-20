# 全路由工作区与项目隔离

## Goal

完成 Phase 1 的 ISO-01：把工作区和项目作为所有受保护 Platform API 的实际数据边界，而不是只在页面或少数路由中检查成员关系。交付一份可执行的路由/资源授权矩阵，并让两个工作区中的相同类型资源不能因猜到 ID 而被跨边界读取、变更、下载、运行、删除或作为外键引用。

## Confirmed Facts

- 父路线图将 ISO-01 定义为 Phase 1 的 P0 缺口；退出证据是“每个路由/资源对有未认证、非成员、错误工作区和权限不足测试；子 ID 通过已授权父资源解析”。来源：`08-19-team-production-readiness-assessment/research/gap-register.md` 的 ISO-01。
- `server-py/autoflow/handler.py` 当前包含认证、部署管理、工作区、项目、模板、资源、数据集、调度、Webhook、通知、运行、录制、验证、产物、修订、密钥、审计和分析路由。它们使用的 `require_workspace_role`、`require_project_role`、具名 capability 和子表查询并不统一。
- Phase 1 IAM 基线已在依赖分支 `a514f64` 中固定三个角色和服务端 capability 策略；本任务不得恢复八角色，也不得用前端隐藏按钮代替 API 拒绝。
- 现有 schema 已有 `workspace_id` / `project_id` 关系；历史上发生过 dependent-row 删除越过项目边界的问题。仅使用子资源 ID 或只依赖 SQLite 外键不足以证明请求所属项目已被授权。
- `POST /api/platform/webhooks/{trigger_id}` 是刻意的无交互登录入口；它必须继续由签名、时间戳、幂等/速率与触发器所属项目的服务端验证保护，而不被误改为普通浏览器会话路由。

## Requirements

### R1. Complete Executable Route Inventory

- 为 `create_platform_router` 暴露的每个 API 路由建立可审计、可执行的矩阵；每个条目至少描述：路径/方法、公开或认证边界、部署/工作区/项目作用域、最低 capability、子资源父级解析方式和负向测试家族。
- 明确列出健康、注册终端错误、登录、退出、会话、邀请/重置接受和签名 Webhook 等特殊路由及其例外原因，避免“未认证”测试误把它们当成普通受保护资源。
- 任何新增或改名的受保护路由都必须使矩阵测试失败，直到被分类并覆盖；不可只维护人工 Markdown 清单。

### R2. Server-Side Workspace And Project Enforcement

- 每个受保护路由都必须先从有效、启用的服务端 session 获取账户，再通过部署 super-admin 或工作区成员关系和具名 capability 作授权；成员、管理员、超级管理员的可为/不可为矩阵以 IAM 的服务器策略为唯一来源。
- 包含 `{workspace_id}` 的路由必须在读取或变更数据前验证该工作区的访问与 capability。
- 包含 `{project_id}` 的路由必须先解析项目并验证其工作区访问与 capability；任何下级查询、更新或删除都以该已授权 `project_id` 作为条件。
- 仅以子 ID 访问的产物、验证产物、触发器或其他间接资源，必须通过其真实 project/workspace 父级解析并授权，不能依据调用者传入的无关项目 ID 或裸 ID 直接返回数据。
- 对同一路由提交的交叉引用（例如 dataset/version、schedule/revision/environment、Webhook/revision/dataset、notification/project、template/apply 目标、run/revision/batch）必须验证全部资源属于同一授权项目或工作区。

### R3. Stable Isolation Outcomes

- 缺少或失效 session 返回既有认证错误；禁用账户不得继续访问任何受保护资源。
- 已知但不属于调用者工作区的父项目/工作区返回既有访问拒绝，不返回资源内容。已通过授权父级的子 ID 不存在或不属于该父级时按同类资源的稳定 `*_NOT_FOUND` 结果处理，不泄露另一个项目的字段、路径、artifact 名称或审计详情。
- member 对成员、邀请、项目管理、密钥、通知、工作区设置和删除/归档管理操作被服务端拒绝；admin 和 super-admin 只在正确作用域内可执行各自允许的操作。super-admin 的跨工作区支持访问保持显式审计。
- 保持公共签名 Webhook 的既有输入验证和失败语义；不得因隔离重构而开放新的匿名读取/写入路径。

### R4. Coverage And Regression Safety

- 以两个工作区、各自项目、admin/member/non-member/disabled/super-admin 和可区分的子资源建立服务端矩阵测试。每个资源家族至少覆盖：未认证、非成员或错误工作区、member 权限不足（如适用）、管理员正向以及项目/工作区错配 ID。
- 覆盖所有会读取、下载、变更、执行、取消、重试、删除、归档或以另一个资源作为输入的子资源路由；测试必须断言没有跨项目副作用，不能只断言 HTTP 状态。
- 保留 IAM 邀请重放 `410 INVITE_ALREADY_USED`、会话撤销、secret 脱敏、revision/run 可重复性、现有 `test:all` 和 Windows 部署 smoke 行为。
- 当 UI 因服务器 capability 投影而展示错误命令时，只做使其与服务器矩阵一致的最小修复；本任务不做视觉重构。

## Out Of Scope

- 新身份提供方、角色模型、SSO/MFA、SMTP、外部租户或外部不可篡改审计。
- HTTPS、反向代理、服务账号 ACL、密钥托管/轮换（SEC-01/OPS-01）。
- 远程变更感知（COL-01）、runner 并发（RUN-01）、retention/备份恢复（DATA-01/BKP-02）和容量证明。
- 新增业务资源类别或改变公开 Webhook 的产品语义。
- 将完整路由矩阵的前端展示作为产品功能；矩阵是代码/测试/规范交付物。

## Acceptance Criteria

- [ ] AC1: 所有 `create_platform_router` API 路由在可执行矩阵中有且仅有一个分类；受保护路由遗漏、未声明 capability 或未声明父级解析方式会导致自动化测试失败。
- [ ] AC2: 对每个工作区/项目/子资源家族，未认证、禁用、非成员、错误工作区/项目和权限不足调用均不能返回或变更另一工作区的数据；正确 admin/super-admin 正向路径继续可用。
- [ ] AC3: 所有 child-ID、artifact-ID 和请求体交叉引用都由授权的父 workspace/project 约束；错配 ID 返回稳定安全错误，且数据库、artifact 文件和审计没有跨边界副作用。
- [ ] AC4: member/admin/super-admin 的服务器行为与 IAM capability 表一致；直接 HTTP/API 调用不能绕过隐藏 UI。
- [ ] AC5: 签名 Webhook、邀请/重置、session 撤销、审计脱敏、版本/运行语义和现有浏览器流程回归通过。
- [ ] AC6: 后端隔离规范、路由矩阵/测试说明和运维边界更新；完成独立审查、完整本地门禁、提交、真实 PR/CI 记录，并且不将外部审核或未合并 PR 伪装为完成。

## Decisions And Risks

- 采用“已授权父级 + 作用域子查询”作为每个资源路由的安全基元：先授权 workspace/project，再以该父 ID 查询下级对象。裸子 ID 只能用于通过服务端 join 找出真实父级后再授权的路由。
- 对已授权父级下不存在/不属于该父级的子 ID 使用同类 `*_NOT_FOUND`，避免在已授权项目上下文中枚举另一个项目的子资源；跨工作区父级访问沿用 `WORKSPACE_ACCESS_DENIED` / capability 错误。
- 矩阵应由集中、类型化的测试/策略清单驱动，而非靠手工审阅 route 函数；生产代码不接受来自 HTTP 的表名或 SQL 片段。
- 该分支依赖 IAM PR #7 的提交 `a514f64`。在 IAM 未合并时可作为可追溯依赖分支推进，但不能声称已经进入 `python_3.1`。

## Open Questions

无。父路线图和已确认的 IAM capability/错误契约已足以确定本任务的最小范围；不扩展到 Phase 1 的其他缺口。
