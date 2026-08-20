# Phase 2 运维与发布说明

本文记录 Phase 2 已实现（或已提供入口）的运维能力，以及它们的已知边界。它不证明
容量压测、异地备份调度、仪表盘告警或 Windows 服务账户 ACL 已在真实环境完成。

## 托管 Runner 并发（RUN-01）

`ManagedRunner` 默认启用全局并发 2、单工作区并发 1，并按 eligible FIFO 调度：
达到工作区上限的项会被跳过，不阻塞其他工作区。取消/恢复按项隔离。

- 覆盖环境变量：`AUTOFLOW_RUNNER_GLOBAL_CONCURRENCY`（默认 2）、
  `AUTOFLOW_RUNNER_WORKSPACE_CONCURRENCY`（默认 1）。
- 边界：仍为单进程内多线程，不实现跨进程/多机执行；共享 SQLite 连接模型未在此项
  改变。

## 保留策略（DATA-01）

维护循环每小时执行一次保留清理，分档如下：

| 数据 | 默认保留 | 环境变量 |
| --- | --- | --- |
| 审计事件 | 180 天 | `AUTOFLOW_RETENTION_AUDIT_DAYS` |
| 运行及其事件/输出/产物/通知 | 90 天 | `AUTOFLOW_RETENTION_RUN_DAYS` |
| 产物文件 + 记录 | 15 天 | `AUTOFLOW_RETENTION_ARTIFACT_DAYS` |

- 产物清理同步删除文件与数据库行，避免孤儿引用；运行清理级联删除 events、
  flow_outputs、artifacts、deliveries 后再删 run。
- 设置 `AUTOFLOW_RETENTION_DRY_RUN=1` 可只统计不删除，用于容量审查。
- 边界：清理通过结构化 `retention.pass` 日志记录；尚未实现长期仪表盘/告警（见
  OBS-02 边界）。

## 备份与恢复（BKP-02）

`scripts/backup.ps1` 会调用 `sqlite-backup.py` 复制并校验两个 SQLite 库、复制
产物目录，然后调用 `scripts/backup-manifest.py write` 生成 `manifest.json`
（每个文件 SHA-256 + 大小）。`scripts/restore.ps1` 在恢复前执行
`backup-manifest.py verify`，任何缺失/篡改都会中止。

- 手动校验：`python scripts/backup-manifest.py verify <备份目录>`。
- 字节级加密辅助：`server-py/autoflow/backup.py` 提供 `encrypt_bytes`/
  `decrypt_bytes` 与 `encrypt_directory`/`decrypt_directory`（AES-256-GCM）。
- 边界：离线异地拷贝的调度、失败告警、定时恢复的 RPO/RTO 演练尚未在真实环境完成，
  不在此文档中声明。

## 可观测性（OBS-02）

- `GET /metrics` 返回 JSON：`ready`（SQLite quick_check）、`maintenance`（降级
  状态与最后失败时间）、`runs`/`deliveries` 按状态计数、`disk`（总量/已用/空闲）
  与 `artifactBytes`。
- `GET /health` 为进程 liveness；`GET /ready` 返回 `ready` + `maintenance`。
- 边界：仪表盘与告警阈值（Grafana/Prometheus alert）属运维基础设施，尚未实现。

## 质量门禁与依赖（QA-01 / REL-01）

- 前端单测开启 v8 覆盖率基线：lines/functions/statements 50%、branches 40%
  （`npm run test:coverage`）。阈值是保守起点，应随覆盖增长上调。
- CI 的 `security-scan` job 运行 `npm audit --audit-level=high`、`pip-audit` 与
  `bandit`。
- Python 依赖使用 `server-py/requirements.lock` 锁定（`setup-py.mjs` 优先读取），
  用 `python scripts/verify-lock.py server-py/requirements.lock` 校验安装版本。
- 边界：不可变版本包、校验和/SBOM、staging 迁移检查与回滚证据需真实发布流水线。

## 升级与回滚

1. 记录目标提交 SHA、`/ready`、`/metrics` 基线。
2. 先运行 `scripts/backup.ps1`，确认 `manifest.json` 校验通过。
3. 替换应用包后运行 `npm run setup:py`（使用锁文件）并启动。
4. 验证 `/ready`、`/metrics` 与一次受控 run/流程录制。
5. 回滚：停止服务，用 `scripts/restore.ps1` 恢复匹配的旧数据库与旧应用包；数据库
   迁移不向后兼容时以恢复旧包 + 旧库为准。

## 事故响应（最小版）

- 服务不可达：先区分进程存活（`/health`）与就绪（`/ready`）。
- 维护降级：读取 `maintenance.lastFailureAt` / `failureCode`，检查结构化日志中的
  `maintenance.failed`；恢复需一次完整成功的维护循环。
- 队列积压：读取 `/metrics` 的 `runs.queued`/`runs.running`；确认全局/工作区并发
  上限与 watchdog 是否在清理卡住的 managed run。
- 磁盘：读取 `/metrics` 的 `disk` 与 `artifactBytes`；必要时先做 dry-run 保留
  审查再启用清理。
