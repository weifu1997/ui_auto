# AutoFlow Windows 部署与运维手册

## 安装

以管理员 PowerShell 执行 `scripts/install.ps1`，传入固定版本的 Node.js、WinSW 可执行文件和至少 32 字符的随机 `PlatformSecretKey`。如需投递到内网通知地址，同时传入逗号分隔的 `NotificationHostAllowlist`，支持精确主机和 `*.corp.example` 子域通配。安装后通过 `http://127.0.0.1:8787/ready` 检查数据库与服务状态，再由 Caddy 或 IIS 终止 HTTPS 并反向代理到本机端口。

生产环境必须设置随机的 `PLATFORM_SECRET_KEY`，限制 Windows 服务账号对 `D:\AutoFlow` 的访问权限，并只在防火墙开放 HTTPS 入口。服务不需要交互式桌面登录。

通知地址默认只允许 HTTPS 公网主机。配置 `PLATFORM_NOTIFICATION_HOST_ALLOWLIST` 后，只允许列表中的主机；内网地址还必须同时启用 `PLATFORM_ALLOW_PRIVATE_NOTIFICATION_URLS=1`。安装脚本在提供允许列表时自动完成这两项服务配置。HTTP 地址仅用于明确授权的隔离环境，并需另设 `PLATFORM_ALLOW_INSECURE_NOTIFICATION_URLS=1`。

## 日常操作

- 一致性备份：`scripts/backup.ps1`。脚本执行完整性检查和 WAL checkpoint，并再次校验备份副本。
- 恢复演练：在隔离目录执行 `scripts/restore.ps1`，确认登录、项目、Revision 和运行产物可读。
- 升级：`scripts/upgrade.ps1`。readiness 失败时自动恢复上一应用目录。
- 手工回滚：`scripts/rollback.ps1`。
- 保留与磁盘水位：计划任务每日执行 `scripts/retention.ps1`。
- 七天耐久：`scripts/soak-test.ps1 -Hours 168`，检查 CSV 中 readiness、磁盘和 Chromium 进程趋势。
- 脚本自检：`npm run test:windows`，执行全部 PowerShell 语法检查，并在临时目录完成 SQLite/产物备份、恢复和保留策略冒烟。

## 故障判断

1. `/health` 失败：检查 WinSW 日志和端口占用。
2. `/ready` 返回 503：停止写入，执行备份并检查 SQLite 完整性，不要直接复制 WAL 中的数据库。
3. 磁盘低水位：暂停新运行，执行保留脚本并扩容；不要删除数据库文件。
4. 服务重启后，queued ManagedRunner 任务会恢复；原 running 任务明确记为 `SERVICE_RESTARTED`，可从运行详情重试。
5. 密钥疑似泄露：管理员立即轮换对应项目密钥和 `PLATFORM_SECRET_KEY`，保留审计记录并使现有会话失效。
