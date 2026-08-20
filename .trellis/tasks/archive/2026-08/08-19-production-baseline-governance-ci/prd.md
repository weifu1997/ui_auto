# 生产基线治理与 CI 门禁

## Goal

建立可追溯的 Phase 0 发布基线：收敛活跃 Trellis 任务状态，加入仓库托管的 Linux 与 Windows CI 门禁，并把分支保护、发布证据和初始运维职责写成可执行的检查清单。

用户价值：团队不再依赖某个人本地运行测试或记忆任务状态来判断可发布性；每次变更都有一致的远端检查和可审计的基线证据。

## Confirmed Facts

- 父任务 `08-19-team-production-readiness-assessment` 的 GOV-01 与 CI-01 是 Phase 0 P0 缺口；当前有 10 个活跃 Trellis 任务，部分历史任务的验收项与状态不一致。
- `package.json` 已有 `build`、`lint`、单测、启动测试、Python 测试、bundle、Playwright 与 Windows 脚本冒烟的本地门禁；仓库尚无 tracked CI workflow、CODEOWNERS 或仓库内分支保护说明。
- 当前远程仓库为 GitHub；仓库内容可以定义 Actions 工作流，但不能以代码证明组织级分支保护、必需审批、备份目标、证书或告警路由已经配置。
- 父路线图已确认本子任务不实现 IAM、TLS、备份路径、运行并发、retention 或 Phase 2 的不可变制品能力。

## Requirements

### R1. 活跃任务治理与发布基线

- 以 `python_3.1` 为依据盘点每个活跃任务的状态、已完成证据、未完成范围、owner 和依赖，并把结论保存在仓库内的治理记录中。
- 只在验收、代码和 Git 状态共同证明完成时归档任务；仍有实现、验证、未提交改动或依赖的任务必须保留并重新描述剩余范围，不得为了降低计数而关闭。
- 在所有本地门禁和新 CI 首次成功后创建并记录一个可定位的 Phase 0 基线 tag；tag 不得被用作外部保护规则已启用的替代证据。

### R2. 远端 CI 门禁

- 新增 GitHub Actions 工作流，在 pull request 和目标分支推送时运行。
- Linux job 必须执行构建、lint、前端单测、生产启动测试、Python 测试、bundle 检查和 Playwright；Windows job 必须执行部署脚本 smoke。
- workflow 使用锁定的 Node/npm 依赖安装、受支持的 Python 版本和最小 GitHub token 权限；不得读取生产密钥、上传本地数据库或弱化现有 `test:all` 覆盖范围。
- 工作流名称与 job/check 名称必须稳定，以便分支保护规则可以引用；失败日志和测试报告应在 GitHub Actions 中可定位。

### R3. 发布与外部控制边界

- 新增贡献/发布基线说明，列出必需的 GitHub 分支保护、审批、CI 检查、tag、回滚证据和例外记录格式。
- 初始运维说明覆盖 Phase 0 已有的启动、健康检查、日志定位、备份和回滚入口，并明确 Phase 1/2 前尚未满足的生产声明。
- 外部配置项保留证据链接和责任人字段，但不得捏造已配置的组织设置或人名。

## Out Of Scope

- IAM、成员生命周期、TLS、服务账号、密钥轮换、备份路径修复、远端备份、retention、运行并发、容量压测和 HA。
- 在没有外部 GitHub 管理权限或证据时声称已启用分支保护、强制审批或 required checks。
- 生成 Phase 2 的依赖锁定、SBOM、签名或不可变部署制品。

## Acceptance Criteria

- [ ] AC1：仓库中有一份针对全部活跃任务的治理清单，逐项给出状态结论、证据、owner、下一步和归档/重设范围的理由。
- [ ] AC2：GitHub Actions 在 PR 与目标分支 push 上定义稳定的 Linux 与 Windows required-check 候选 job；Linux 覆盖既有本地质量矩阵，Windows 覆盖部署脚本 smoke。
- [ ] AC3：workflow 不要求生产 secret，使用 `npm ci`，初始化 Python/Playwright 环境，并以最小权限运行。
- [ ] AC4：发布/分支保护和初始运维文档明确区分已检查入仓的自动化与待外部确认的组织控制，包含证据链接和责任人占位字段。
- [ ] AC5：在本地门禁与首个远端 CI 运行有证据后，治理记录包含可复现的基线 tag；没有未经证实地归档活跃任务。
- [ ] AC6：本任务不改变产品 API、数据模型、认证、运行行为或 Phase 1/2 范围。

## Acceptance Traceability

| Acceptance | Primary Evidence |
| --- | --- |
| AC1、AC5 | 活跃任务治理清单、Trellis `task.py list` 输出、tag 与门禁记录 |
| AC2、AC3 | `.github/workflows/phase0-ci.yml` 和 GitHub Actions 运行链接 |
| AC4 | 发布/分支保护说明和 Phase 0 初始运维说明 |
| AC6 | Git diff、现有质量矩阵和父路线图范围检查 |
