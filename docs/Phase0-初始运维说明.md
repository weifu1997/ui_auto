# Phase 0 初始运维说明

本文只描述当前仓库已有的启动、检查、日志、备份和回滚入口，以及它们的已知边界。它不证明系统已经达到多团队生产可用性。

## 适用范围

当前服务是单机 Platform 部署：Web UI、FastAPI 服务和 ManagedRunner 在同一主机运行。默认监听 `127.0.0.1:8787`，只有显式配置 `AUTOFLOW_LISTEN_HOST` 才会暴露到局域网。

Phase 0 结束前仍不能作出以下声明：已完成 TLS、受保护分支、远端备份、RPO/RTO 恢复演练、长期监测或团队身份权限。特别是局域网 HTTP 和非 Secure cookie 的风险仍由 Phase 1 的 TLS 工作关闭。

## 启动前检查

- 使用 Node.js `>=20.12`。Windows CI 使用 Node 22 是因为部署 smoke 的 `node:sqlite` 依赖，不改变产品启动最低版本。
- `npm run setup:py` 依赖 [uv](https://docs.astral.sh/uv/)，CI 通过 `astral-sh/setup-uv` 自动提供；本地首次运行前需安装 uv。Windows 生产部署 `scripts/ops/install.ps1` 会在脚本内用 `pip install uv` 自行引导，无需预装。Python 依赖在 `server-py/pyproject.toml` 声明，由 `server-py/uv.lock` 跨平台锁定。
- 设置非空的 `PLATFORM_SECRET_KEY`；在 Linux/WSL 中，若使用配置文件，文件必须由当前用户拥有且权限为 `0600`。
- 运行 `npm run build`，确认 `dist/index.html` 存在。
- 使用 `npm run start` 作为唯一支持的服务入口。`npm run server` 是兼容别名；`npm run server:py` 不是部署入口。

Linux/WSL 的最小启动顺序：

```bash
npm ci
npm run setup:py
cp .env.example .env
chmod 600 .env
# 在 .env 中设置 PLATFORM_SECRET_KEY
npm run build
npm run start
```

需要从局域网访问时，另行设置 `AUTOFLOW_LISTEN_HOST=0.0.0.0`，并按既有部署决策设置受限的 `AUTOFLOW_CORS_ORIGINS`。在 TLS 方案完成前，局域网 HTTP 只能用于当前受控试点，不能作为团队生产发布条件。

Windows 部署入口是 `scripts/ops/install.ps1`，它会准备 `D:\AutoFlow` 下的 `app`、`data`（包括 `data\artifacts`）、`logs`、`backups`、`browsers` 和 `runtime` 目录，渲染 WinSW 配置并启动服务。运行前应由主机管理员确认服务账号、目录 ACL 和密钥保存方式；这些安全控制尚未在仓库内实现或验证。

## 健康检查与日志

- `GET /health` 是进程 liveness 检查，当前响应包含 `ok: true` 和 `queue: "online"`。
- `GET /ready` 执行 SQLite `PRAGMA quick_check`，正常响应包含 `ready: true` 及 `maintenance.healthy: true`。SQLite 不可用时响应为 `ready: false`（HTTP 503）；维护循环异常时保留 SQLite 的 `ready` 结果，同时通过 `maintenance.healthy: false`、失败时间和固定失败码表示降级。
- Windows WinSW 的进程日志位于 `%BASE%\logs`；服务配置会按大小和日期滚动。直接运行时，应从实际进程管理器的 stdout/stderr 采集日志。

维护失败会记录不含异常文本的结构化 `maintenance.failed` 事件；下一次完整成功维护会将 `healthy` 恢复为 `true`、清除固定失败码，并保留 `lastFailureAt` 作为最近一次失败的历史时间。`scripts/soak-test.ps1` 记录 `normal`、`degraded`、`not_ready` 或 `request_error`，但该脚本和单次 `/ready` 成功都不能作为长期运行健康证明。

## 备份、恢复与回滚入口

当前 Windows 脚本入口如下：

```powershell
.\scripts\backup.ps1 -Root D:\AutoFlow -Destination D:\AutoFlow\backups\<timestamp>
.\scripts\restore.ps1 -Backup D:\AutoFlow\backups\<timestamp> -Root D:\AutoFlow
.\scripts\rollback.ps1 -Root D:\AutoFlow
```

`backup.ps1` 使用 SQLite 在线备份辅助程序保存 `platform.sqlite`（缺失即失败；旧版 `autoflow.sqlite` 已退役，仅在旧备份中存在时随恢复兼容处理）；`restore.ps1` 会在服务存在时先停止再恢复数据库并重启服务；`rollback.ps1` 交换最近的 `app-previous-*` 目录。升级入口 `scripts/ops/upgrade.ps1` 会在替换应用前调用备份，并在启动或 `/ready` 检查失败时恢复上一版应用目录。

这些是当前脚本入口，不是完整恢复证明。ManagedRunner、WinSW 和 PowerShell 脚本均以 `PLATFORM_DATA_DIRECTORY/artifacts` 为运行时产物目录；备份容器中的产物保持在 `<backup>\artifacts`，恢复时回写到该运行时目录。备份中存在 `artifacts` 目录时，恢复会先替换目标目录，以免保留不属于该备份的旧文件；空目录也能正常恢复。Windows smoke 会从 `data\artifacts` 构造 fixture、验证备份布局并恢复到同一路径。不得删除或自动迁移旧根目录 `artifacts` 中的历史文件；离机备份、哈希清单、完整 retention 和 RPO/RTO 证明仍属于后续阶段。

## 事件处置顺序

1. 记录当前 SHA、服务状态、`/health` 和 `/ready` 响应，以及相关日志时间范围。
2. 停止扩大影响：暂停发布或在需要时停止服务；不要删除数据库、WAL/SHM 文件或产物目录。
3. 对应用回归使用 `scripts/ops/rollback.ps1`；对数据问题只在已验证备份下使用 `scripts/ops/restore.ps1`。
4. 重启后重新检查启动日志、`/health`、`/ready` 和受影响的授权路径。
5. 记录实际恢复点、耗时和遗留问题。RPO `<= 24h` 与 RTO `<= 4h` 的演练和异地备份仍属于 Phase 2，当前未验证。

## 发布前交接

发布负责人还必须完成 `docs/生产基线发布与分支保护.md` 中的 CI、审核、tag 和例外记录要求。主机管理员应分别保存证书、备份目的地、告警路由和服务账号的外部配置证据；仓库不会替这些外部控制生成虚假的完成状态。
