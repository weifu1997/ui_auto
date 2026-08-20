# 活跃任务治理盘点

> 盘点日期：2026-08-20
> 分支快照：`python_3.1`，候选提交 `24ee9d2af43df788f6df4c27370b1d2988a95e69`

## 方法与边界

本记录以 `python3 .trellis/scripts/task.py list`、每个活跃任务的 `task.json`、PRD/实施清单、检查上下文和当前 Git 状态为依据。`task.py list` 会把有活动子项的父节点显示为 `active`；表中“任务状态”保留 `task.json` 的原始值，以免隐藏状态漂移。

盘点时 `git diff --name-only` 只显示 Trellis/agent 支撑文件的既有改动；`git status --porcelain` 还显示三个未跟踪的 08-19 任务目录。没有发现可归属到本次盘点的未提交产品源代码改动，但工作区不是可用于归档或打 tag 的干净基线。所有任务的 `creator`/`assignee` 当前均为 `huangwf`；下表不臆造团队或外部系统的责任人。

归档条件是任务自身验收、可定位的代码/验证证据和干净的待归档范围三者同时成立。为了不通过减少任务数量来制造治理完成感，本次不归档或修改其他任务状态；每行给出下一步动作。

## 当前任务清单

| 任务                                                 | 任务状态 / owner                                          | 已记录证据                                                                                                                      | 结论与下一步                                                                                                                                                                 | 依赖与发布影响                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `08-15-next-roadmap-planning`                        | `planning`; `task.py list` 因子任务显示 `active`; huangwf | PRD AC0-AC9 已勾选，包含 2026-08-15 基线与后续 retry/batch/recording 依赖；`base_branch` 仍是 `master`。                        | **重新设定范围**：保留为历史功能路线图，明确其不是当前 Phase 0 发布来源；由 owner 把与 `08-19-team-production-readiness-assessment` 重叠的治理结论交叉链接后再决定是否关闭。 | 为 retry、batch、recording 提供旧依赖关系；不能替代当前团队生产路线图。                        |
| `08-15-flow-recording-mvp`                           | `in_progress`; huangwf                                    | PRD AC1-AC15 与实施 review gates 记录为通过，含 2026-08-18 的 Playwright/Python 证据；实施文件还保留未同步的 Phase 2 原始待办。 | **候选归档，暂不归档**：先由 owner 对照对应提交、最新全量门禁和未同步清单，收敛一份一致的完成记录。当前工作区不是归档基线。                                                  | 最终保存/重放回归引用 retry snapshot 契约；是 CI E2E 回归面。                                  |
| `08-15-flow-batch-execution-mvp`                     | `in_progress`; huangwf                                    | 实施清单仍有 client request key 复用、E2E cancel/retry、用户文档及 retry snapshot 相关未完成项；2026-08-18 记录了局部门禁。     | **继续实施**：不得关闭。先完成其明示的未勾选验收，并在 retry 任务的可复核完成证据后重跑集成门禁。                                                                            | 依赖 `08-16-flow-retry-reproduction-correctness`；影响运行正确性，不能作为团队发布的已完成项。 |
| `08-16-legacy-e2e-failures`                          | `in_progress`; huangwf                                    | PRD AC1-AC3 已勾选，记录 2026-08-18 `npm run test:e2e` 为 38/38 通过及根因。                                                    | **候选归档，暂不归档**：对当前候选 SHA 由新 CI 复验 E2E，再由 owner 记录关联提交和关闭证据。                                                                                 | 是 `quality-linux` 的基础可信度，不应在首次远端 green 前宣称 CI-01 关闭。                      |
| `08-16-flow-retry-reproduction-correctness`          | `planning`; huangwf                                       | PRD AC1-AC8 记录为完成并引用 5 项 Python 回归与 E2E fixture；实施清单和 review gates仍全部未勾选。                              | **重新核对并收口状态**：产品/验收记录与实施清单矛盾，先补齐可重放的命令输出、同步清单，再决定启动/完成状态；本次不更改。                                                     | 是 batch retry 与 recording 最终重放契约的共同前置。                                           |
| `08-19-frontend-visual-consistency-and-ui-alignment` | `in_progress`; huangwf                                    | PRD 和设计已定义 token、FilterBar、操作列及四项本地门禁；实施清单仍全未勾选。                                                   | **继续实施**：保持独立 UI 范围，完成后再运行其视觉与质量验收。                                                                                                               | 与后续 IAM/COL 前端改造协调，非 GOV-01/CI-01 的关闭证据。                                      |
| `08-19-refactor-templates`                           | `in_progress`; huangwf                                    | PRD/design 已定义模板预览、冲突、映射、re-publish 和密钥引用；实施前检查仍有资源字段/引用路径待确认。                           | **继续规划/实施前核对**：不得以文档存在视为产品功能完成。                                                                                                                    | 与模板路由授权及后续 IAM 改造有并发风险，非 Phase 0 关闭项。                                   |
| `08-19-team-production-readiness-assessment`         | `planning`; huangwf                                       | 已有 PRD、设计、路线图、现状审计和 23 项差距台账；父任务 AC 仍未标记完成。                                                      | **继续作为路线图父任务**：链接本子任务与 artifact/health 子任务的实际验证结果，然后进行独立规划验收，而非提前关闭。                                                          | 定义 Phase 0-3 顺序与生产适用边界。                                                            |
| `08-19-production-baseline-governance-ci`            | `in_progress`; huangwf                                    | 工作流、发布控制文档和盘点已提交；`32281832036` 首次运行在 Windows 解析阶段失败，修复后 `32283223072` 的两个 job 均成功。          | **继续外部控制验收**：仓库内 CI-01 证据已具备；仍需 GitHub 管理员提供分支保护与独立审核证据，且在干净候选工作区中创建正式 tag。       | 关闭 GOV-01/CI-01 的仓库内部分；依赖 GitHub 管理员完成外部控制。                               |
| `08-19-artifact-backup-health-observability-fixes`   | `in_progress`; huangwf                                    | `a25c235` 已实现规范 `data/artifacts` 路径、备份/恢复 smoke、`/ready` 维护状态和脱敏日志；`24ee9d2` 追加 Windows PowerShell 编码回归保护，`32283223072` 两个 job 均成功。 | **已提交并通过远端回归**：保持任务进行中，直至正式 baseline 与外部发布控制有可定位证据；不得把脚本验证扩展为 RPO/RTO 或异地备份证明。 | 是 Phase 0 操作退出门槛；关闭后仍不等同于完整产物恢复和长期健康声明。                          |

## Phase 0 基线证据登记

以下项目在本次盘点时均未满足，因此没有创建 tag，也没有把任何任务归档为发布基线的一部分。

| 证据                 | 当前值                                                                                                                                      | 责任人              | 需要补充                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| 候选 commit          | `24ee9d2af43df788f6df4c27370b1d2988a95e69`，包含 Phase 0 artifact/health、治理/CI 与 Windows 编码修复的连续提交。                          | huangwf             | 外部保护和审核完成后，在干净候选工作区中选择最终经审核 SHA。                       |
| 本地质量矩阵         | 2026-08-20：完整矩阵已通过；编码修复后再次通过 `npm run build`、`npm run lint` 与 `npm run test:windows`。                                 | huangwf             | 保留命令输出；远端运行已补充受支持宿主的证据。                                      |
| `quality-linux`      | [`32283223072`](https://github.com/weifu1997/ui_auto/actions/runs/32283223072/job/96166572743) 对 `24ee9d2` 成功。                         | huangwf             | 配置分支保护后，把该稳定 job 设为 required check。                                 |
| `deployment-windows` | [`32283223072`](https://github.com/weifu1997/ui_auto/actions/runs/32283223072/job/96166573060) 对 `24ee9d2` 成功。                        | huangwf             | 配置分支保护后，把该稳定 job 设为 required check。                                 |
| 分支保护与审核       | `GET /repos/weifu1997/ui_auto/branches/python_3.1/protection` 于 2026-08-20 返回 `404 Branch not protected`；没有独立审核记录。             | GitHub 管理员待指定 | 在 `docs/生产基线发布与分支保护.md` 的表格填写实际配置、审核者和证据。             |
| Phase 0 tag          | 不存在；不得将仅有的 CI 成功误称为经审核的正式 baseline。                                                                                  | 发布责任人待指定    | 仅在上述证据齐全且干净候选工作区可复核后创建并推送带注释 tag。                      |

## 首次 CI 失败与收敛记录

- `32281832036`：`quality-linux` 成功，`deployment-windows` 在
  `install.ps1` 的 PowerShell 解析阶段失败，日志为缺少字符串终止符和闭合块。
- 根因：无 BOM UTF-8 的 `.ps1` 源码含非 ASCII 字符，在 GitHub Windows
  PowerShell 5.1 的旧代码页解析路径中可能产生解析歧义。
- 收敛：`24ee9d2` 将全部 `scripts/*.ps1` 源码收敛为 ASCII，并在 Windows
  smoke 中增加字节级检查。详细复盘见
  `08-19-artifact-backup-health-observability-fixes/research/windows-powershell-source-encoding-retrospective.md`。
- 验证：重试 `32283223072` 的 `quality-linux` 与 `deployment-windows` 均成功。

## 复盘触发条件

以下事件必须更新本盘点，而不是仅更新 task status：首次 CI 失败、任何任务的验收关闭、重试/批次范围变化、artifact/health 子任务完成、分支保护变更或 baseline tag 创建。这样任务状态、代码状态和发布证据能够保持同一事实来源。
