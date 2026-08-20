# 本地账户、成员与三角色 RBAC

## Goal

完成 Phase 1 的身份和成员治理基础：关闭公开注册，以本地账户和受控邀请加入工作区，并在服务端和前端统一执行部署级 `super_admin`、工作区 `admin`、工作区 `member` 三角色策略。结果应让两个工作区能够在不信任 UI 的情况下安全协作。

## Confirmed Facts

- 当前 `/api/auth/register` 可为任意请求创建账户及私有 owner 工作区；`workspace_members` 仍保存八种旧角色。
- `require_workspace_role` 和 `require_workspace_capability` 仅检查成员存在，未执行角色/能力；前端 `canUseCapability` 恒返回 `true`。
- SQLite 迁移由 `server-py/autoflow/migrations.py` 的顺序版本管理；会话表只保存 token digest，服务端每次请求都会查询账户状态。
- Phase 0 checkpoint 为 `4354426` (`phase0-ci-checkpoint-20260820`)；本任务的父规划和已确认的邀请重放合同位于 `08-19-team-production-readiness-assessment`。

## Requirements

### R1. Bootstrap And Registration Boundary

- 生产 API 不再提供公开注册；`POST /api/auth/register` 必须返回稳定的 `REGISTRATION_DISABLED` 错误且不写入账户、工作区、会话或审计记录。
- 提供受控 CLI bootstrap：在尚无 super-admin 时创建或提升指定本地账户；不得提供默认密码、不得将密码放入命令行或审计记录。
- 只有 super-admin 能创建工作区、管理部署级账户状态和授予/撤销 super-admin；已有数据库升级后必须显式 bootstrap，不能静默把任意旧 owner 提升为全局管理员。

### R2. Three-Role Server Policy

- 唯一角色模型为部署级 `super_admin` 及工作区 `admin` / `member`。所有遗留角色在迁移中确定性映射：`owner`、`admin` -> `admin`；其余遗留角色 -> `member`。
- 服务端是授权唯一权威。所有工作区/项目校验必须先验证账户启用状态、成员关系或 super-admin，然后验证所需能力；禁止以 UI 隐藏替代 API 拒绝。
- `admin` 可管理成员、邀请、项目、密钥、通知和工作区设置；`member` 只能进行项目编辑和运行所需动作；super-admin 对所有工作区有显式、可审计的支持访问。
- 会话响应返回服务器计算的全局角色、工作区角色和能力；前端从该契约判断导航和命令可见性，不复制一套角色矩阵。

### R3. Invitation Lifecycle

- 工作区 admin 或 super-admin 可为规范化邮箱创建 `admin` 或 `member` 的邀请；数据库仅持久化随机 token 的 digest，默认有效期 24 小时，原始 token 只在创建响应中出现一次。
- 邀请可列出、撤销、自然过期和接受。新账户在接受时设置密码；已有启用账户必须以其已登录会话接受且保留既有密码。
- 首次成功接受必须在一个 SQLite 事务中创建账户（如需要）、建立成员关系并消费 token。其后任意重放统一返回 HTTP `410` / `INVITE_ALREADY_USED`，不泄露账户或工作区细节，也不产生账户、成员、密码、会话或成功审计副作用。
- 无效、撤销、过期、邮箱不匹配和禁用账户使用稳定错误码，错误体不返回邀请目标、账户状态或工作区信息；审计不记录 token、密码或完整邮箱。

### R4. Account And Membership Lifecycle

- super-admin 可启用/停用账户、生成一次性密码重置链接、管理 super-admin 资格；工作区 admin 可修改本工作区成员为 admin/member、移除成员、撤销邀请。
- 停用、移除成员、角色变更和密码重置必须立即撤销受影响账户会话。移除一个工作区成员不得删除其其他工作区成员关系或历史审计。
- 不能移除、降级或停用最后一个工作区 admin，也不能撤销、停用或降级最后一个 super-admin。
- 所有邀请、成员、角色、账户状态、密码重置和会话撤销动作均写入安全、脱敏的审计事件。

### R5. Administration UI And Compatibility

- 提供工作区成员与邀请管理界面，支持角色选择、邀请链接一次性展示、撤销、成员角色修改和移除；super-admin 可管理账户状态和全局角色。
- 现有登录、项目编辑和工作区选择流程必须继续工作。公开注册入口不在 UI 暴露；旧 session 在 RBAC 迁移后失效。
- fresh install、已有八角色数据库升级、回滚前备份、两工作区正反向授权、邀请重放与会话撤销都有自动化测试。

## Out Of Scope

- OIDC/SSO/LDAP/MFA、SMTP 邮件投递、外部不可篡改审计、完整 retention 执行、HA、多机 Agent、容量和灾备证明。
- Phase 1 后续的全路由资源矩阵将由 `route-wide-workspace-project-isolation` 深入覆盖；本任务提供统一策略和 IAM API 的直接负向测试，不宣称该后续任务已完成。

## Acceptance Criteria

- [ ] AC1: fresh install 没有公开注册路径；CLI 可安全建立首个 super-admin，非 super-admin 不能创建工作区或管理全局账户。
- [ ] AC2: 升级迁移后仅存在 `admin` / `member` 工作区角色，旧 session 无效，未配置的 super-admin 不会自动产生。
- [ ] AC3: admin 和 member 的服务端负向用例覆盖成员管理、密钥、项目编辑和运行；前端能力可见性与服务器会话契约一致。
- [ ] AC4: 邀请创建、撤销、到期、新账户接受和已登录既有账户接受可用；数据库不保存原始 token。
- [ ] AC5: 首次邀请接受成功后，所有重放返回 `410 INVITE_ALREADY_USED`，且验证账户/成员/密码/session/成功审计均没有重复副作用或数据泄露。
- [ ] AC6: 停用、重置、成员移除和角色变更立即使旧 cookie/Bearer 会话失效，并保留其他工作区成员关系。
- [ ] AC7: 最后 admin 和最后 super-admin 防锁死规则由 API 及 UI 执行；所有管理动作产生脱敏审计。
- [ ] AC8: 相关 Python、TypeScript、Playwright/接口测试和全量质量门禁通过；升级/回滚步骤与外部人工证据边界已记录。

## Decisions And Risks

- 既有账户接受邀请必须证明其已登录会话且邮箱匹配，避免仅持有链接的人获得已有账户的成员关系。
- password-reset token 与 invitation token 同样只存 digest，首次成功使用后消费并撤销该账户所有会话。
- TLS、ACL、密钥托管和外部交付由后续 `https-service-account-secret-operations` 任务负责；本任务不会伪造此类环境证据。
