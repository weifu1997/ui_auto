# Phase 1 账户、成员与邀请运维说明

本文记录仓库内已实现的本地账户、工作区成员与三角色 RBAC 操作步骤。它只覆盖受控的内部多团队试点，不证明 TLS、服务账号 ACL、异地备份、RPO/RTO、SMTP、SSO/MFA 或高可用已经完成。

## 升级前

1. 记录候选提交 SHA、目标 `PLATFORM_DATA_DIRECTORY`、当前 `/health` 和 `/ready` 响应。
2. 在替换应用前运行 Phase 0 备份流程，并确认备份位置可访问。Windows 使用 `scripts/ops/backup.ps1`；不要只复制正在使用的 SQLite 主文件。
3. 保留上一版应用包和对应的升级前数据库备份。此版本没有安全的 down migration；回退的正确方式是恢复匹配的旧包和旧数据库备份。
4. 预先指定首位部署级超级管理员的企业邮箱与受控密码传递方式。密码、邀请 token 和密码重置 token 不得出现在工单、shell 历史、截图或日志中。

## 升级与首位超级管理员

服务启动时会执行迁移 12 和 13。迁移 12 会把旧工作区角色 `owner`/`admin` 归一为 `admin`，其他旧角色归一为 `member`，并撤销全部既有会话；它**不会**自动把旧 owner 提升为超级管理员。迁移 13 增加部署级安全审计账本，用于记录尚未存在工作区时的 bootstrap 操作。

完成启动和健康检查后，在受控终端执行：

```bash
npm run bootstrap:super-admin -- --email admin@example.test --name "Deployment administrator"
```

默认通过 TTY 两次隐藏输入密码。非交互式部署只能通过受控 secret provider 的标准输入传入单行密码，例如将该 provider 的输出管道连接到命令并添加 `--password-stdin`；不得使用 `--password`、命令行参数或普通文本文件。

首次成功后，再次 bootstrap 会返回 `SUPER_ADMIN_ALREADY_CONFIGURED`。这不是故障恢复入口；如需变更账户状态或部署级角色，请使用已登录超级管理员的“成员与账户”页面，并保留审计记录。

## 角色与日常操作

| 角色 | 范围 | 可执行操作 |
| --- | --- | --- |
| `super_admin` | 整个部署 | 创建工作区、查看/管理部署级账户、授予或撤销超级管理员、跨工作区支持访问 |
| `admin` | 所在工作区 | 管理成员/邀请、项目、密钥、通知和工作区设置 |
| `member` | 所在工作区 | 正常项目编辑与运行；不能管理成员、邀请、项目、密钥或工作区设置 |

- 在“成员与账户”页面选择工作区后，管理员可创建 `admin` 或 `member` 邀请、撤销未使用邀请、变更角色或移除成员。
- 邀请链接默认有效 24 小时，仅在创建后的弹窗显示一次。通过获批准的内部安全渠道发送；关闭弹窗后不能从系统重新取得原始 token。
- 新账户以邀请邮箱创建密码后接受邀请；已有账户必须先用匹配邮箱登录后接受，且其原有密码不会被改写。
- 首次成功接受后链接立即消费。之后任何重放都只返回 `410 INVITE_ALREADY_USED`，不返回账户、工作区或成员信息，也不会产生新的用户、成员、会话或成功审计事件。
- 超级管理员可停用/启用账户、变更部署级角色和创建一次性密码重置链接。重置链接同样只显示一次，应通过受控渠道发送。

停用账户、移除工作区成员、改变工作区/部署级角色和完成密码重置，都会立即撤销该账户所有会话。移除一个工作区成员不会删除其在其他工作区的成员关系。系统拒绝移除、降级或停用最后一个启用的工作区管理员，也拒绝撤销、降级或停用最后一个启用的超级管理员。

## 升级后验证

在不记录原始 secret 的前提下，至少完成并留存以下结果：

1. `POST /api/auth/register` 返回 `410 REGISTRATION_DISABLED`，且账户、工作区、会话和审计数量无新增。
2. 使用 bootstrap 账户登录；`GET /api/auth/session` 显示 `globalRole: "super_admin"`，工作区返回服务端计算的角色和 capabilities。
3. 创建一个测试工作区和一份 member 邀请，完成一次接受；验证第二次接受只返回 `410 INVITE_ALREADY_USED`，不记录 token 本身。
4. 验证 member 能编辑 flow/执行 run，但成员、邀请、密钥和项目管理 API 均返回 `403 CAPABILITY_REQUIRED`。
5. 验证移除成员或停用账户后，其旧 cookie/Bearer 会话返回 `401 SESSION_INVALID`；并验证其他工作区成员关系仍存在。
6. 检查审计事件含 `workspace.invitation_*`、`workspace.member_*`、`account.*` 或 `super_admin.workspace_accessed`（按实际操作），且 detail 不含完整邮箱、token、密码或密码哈希。首次 bootstrap 还应在内部 `deployment_audit_events` 账本中留下 `account.super_admin_bootstrapped`；该记录使用稳定 ID、布尔值和计数，不记录邮箱或密码。

## 故障与回退

- 迁移或启动失败时，停止服务扩大影响，保留日志和数据库文件，不要手工编辑 `schema_migrations`、角色列或 token 表。
- 应用回归使用 `scripts/ops/rollback.ps1`；数据回退只使用升级前验证过的备份和匹配的旧应用包。恢复后重新检查 `/health`、`/ready`、登录和受影响的工作区授权路径。
- 若首位超级管理员配置错误，先按受控变更流程使用另一位已配置超级管理员修正；若没有可用超级管理员，按已验证备份恢复，而不是手工写入数据库角色。

## 仍需外部/后续阶段证据

本说明不替代 `https-service-account-secret-operations` 的 TLS、Secure cookie、反向代理、服务账号、目录 ACL、密钥托管与 key-loss 演练；不替代 `route-wide-workspace-project-isolation` 的全路由矩阵；也不替代 Phase 2 的自动异地备份、恢复演练、完整 retention、容量和监控告警证据。
