# 产物备份与运行健康可观测性修复

## Goal

关闭 Phase 0 的 BKP-01 与 OBS-01：让 ManagedRunner、备份、恢复和 retention 使用同一实际产物目录，并让就绪检查与维护失败对运维人员可见、可测试。

用户价值：一次成功备份可以恢复可下载的历史截图或 Trace；长期运行脚本不会把健康服务误报为失败；维护循环异常不再静默消失。

## Confirmed Facts

- `PlatformServices` 将 ManagedRunner 指向 `PLATFORM_DATA_DIRECTORY/artifacts`，但 `PLATFORM_ARTIFACT_DIRECTORY` 在代码中没有生效；Windows 服务模板及 PowerShell 备份/恢复/retention 脚本处理根目录 `artifacts`。
- `platform_artifacts` 与 `element_validation_artifacts` 都保存实际文件路径，下载 API 读取这些路径并先执行项目授权。
- `/ready` 返回 `{ "ready": true }`，而 `soak-test.ps1` 检查不存在的 `ok` 字段；维护循环捕获所有异常后不记录或暴露状态。
- Phase 2 才拥有 off-host 备份、哈希清单、RPO/RTO 演练、完整 retention 与集中监控。本任务不提前声称这些能力已完成。

## Requirements

### R1. 规范产物目录

- 运行时唯一目录为 `PLATFORM_DATA_DIRECTORY/artifacts`；ManagedRunner 的产物、数据库路径记录、备份、恢复和本地 retention 全部以此为源。
- 删除或收敛未被运行时使用的 `PLATFORM_ARTIFACT_DIRECTORY` 配置，避免服务模板表达与实际执行不一致的双目录契约。
- 不删除现有根目录 `artifacts` 或历史数据。路径修复必须保持既有数据库记录和实际 `data/artifacts` 文件可读。

### R2. 备份与恢复证明

- `backup.ps1` 从规范目录复制产物，`restore.ps1` 恢复到规范目录，`retention.ps1` 只清理规范目录。
- Windows smoke 必须在运行时真实目录中构造可恢复的 artifact fixture，验证备份布局和恢复后的路径，不再以根目录人工文件掩盖差异。
- 增加后端回归，证明 `PlatformServices` 将 ManagedRunner 指向规范目录，并验证一个带数据库记录的历史 artifact 在恢复后可被受授权的 API 路径读取。

### R3. Ready 与维护可观测性

- 保持 `/health` 的进程 liveness 语义；`/ready` 继续执行 SQLite 就绪检查，并稳定返回 `ready` 与不含敏感错误详情的维护健康状态。
- 每次维护失败必须输出可机器识别的错误事件，记录失败时间/类型并将 readiness 标为 degraded；后续完整成功周期应清除 degraded 状态。
- `soak-test.ps1` 按真实字段判断数据库和维护均健康，并在 CSV 中保留可用于告警的健康状态；不得把可用服务记录为未就绪。

## Out Of Scope

- 每日/off-host/加密备份、哈希 manifest、备份告警、季度恢复演练和 `RPO <= 24h` / `RTO <= 4h` 证明。
- Phase 2 的完整可配置 retention、审计/运行/截图保留期限、dry-run 与 orphan 修复。
- 中央指标平台、dashboard、通知路由、TLS、服务账号、IAM 和运行并发。

## Acceptance Criteria

- [ ] AC1：仓库中不再存在会影响运行行为的双产物目录配置；ManagedRunner、服务模板、备份、恢复和 retention 均可追溯到 `data/artifacts`。
- [ ] AC2：Windows smoke 从 `data/artifacts` 备份并恢复 artifact；后端回归证明运行时 artifact 记录与下载路径在恢复后仍可用。
- [ ] AC3：`/ready` 在正常时返回 `ready: true` 和健康维护状态；SQLite 失败仍使 ready 失败，维护失败则以明确的 degraded 状态暴露而不泄露敏感值。
- [ ] AC4：维护失败写入可机器识别的日志事件和失败时间/类型；成功维护周期会恢复健康状态；测试覆盖两条路径。
- [ ] AC5：soak 脚本检查真实 readiness 字段并正确记录正常、degraded 与请求失败三种状态。
- [ ] AC6：现有 artifact 授权、项目隔离、run/validation 行为和 `test:all` 门禁不被弱化。

## Acceptance Traceability

| Acceptance | Primary Evidence |
| --- | --- |
| AC1、AC2 | `PlatformServices`、WinSW 模板、backup/restore/retention 脚本、Windows smoke 与后端回归 |
| AC3、AC4、AC5 | `main.py` health contract、维护测试、soak 脚本与日志断言 |
| AC6 | 项目 artifact 下载授权路径、现有 Python/Playwright/Windows 门禁 |
