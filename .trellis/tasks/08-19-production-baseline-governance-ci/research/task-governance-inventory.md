# 活跃任务治理盘点

> 盘点日期：2026-08-20
> 分支快照：`python_3.1`，HEAD `9a5dd18`

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
| `08-19-production-baseline-governance-ci`            | `in_progress`; huangwf                                    | 本子任务的 PRD/design/implement 已审查；本次新增工作流、发布控制文档和本盘点。                                                  | **继续实施与验证**：需要本地质量记录、首个 Linux/Windows Actions 成功链接、外部保护证据和干净候选提交后才可建 tag 或关闭 CI-01。                                             | 关闭 GOV-01/CI-01 的仓库内部分；依赖 GitHub 管理员完成外部控制。                               |
| `08-19-artifact-backup-health-observability-fixes`   | `in_progress`; huangwf                                    | 已实现规范 `data/artifacts` 路径、备份/恢复 smoke、`/ready` 维护状态和脱敏日志回归；2026-08-20 本地完整质量矩阵与独立审查通过。 | **已实现并通过独立审查，待提交**：保持任务进行中，直至形成可定位的变更记录；不得把本地脚本验证扩展为 RPO/RTO 或异地备份证明。                                                | 是 Phase 0 操作退出门槛；关闭后仍不等同于完整产物恢复和长期健康声明。                          |

## Phase 0 基线证据登记

以下项目在本次盘点时均未满足，因此没有创建 tag，也没有把任何任务归档为发布基线的一部分。

| 证据                 | 当前值                                                                                                                                      | 责任人              | 需要补充                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| 候选 commit          | `9a5dd18` 仅为盘点快照，不是发布候选                                                                                                        | huangwf             | 在完成本子任务及 sibling Phase 0 修复后选择经审核 SHA。                            |
| 本地质量矩阵         | 2026-08-20：lint、build、unit（13 files / 51 tests）、startup、Python（122 tests）、bundle、Playwright 与 Windows deployment smoke 均通过。 | huangwf             | 保留命令输出；由 `quality-linux` 与 `deployment-windows` 首次 green 补充远端证据。 |
| `quality-linux`      | 未有远端运行链接                                                                                                                            | GitHub 管理员待指定 | 提交 PR 后记录首次 green URL。                                                     |
| `deployment-windows` | 未有远端运行链接                                                                                                                            | GitHub 管理员待指定 | 提交 PR 后记录首次 green URL。                                                     |
| 分支保护与审核       | 未验证                                                                                                                                      | GitHub 管理员待指定 | 在 `docs/生产基线发布与分支保护.md` 的表格填写实际证据。                           |
| Phase 0 tag          | 不存在                                                                                                                                      | 发布责任人待指定    | 仅在上述证据齐全且工作区干净后创建并推送带注释 tag。                               |

## 复盘触发条件

以下事件必须更新本盘点，而不是仅更新 task status：首次 CI 失败、任何任务的验收关闭、重试/批次范围变化、artifact/health 子任务完成、分支保护变更或 baseline tag 创建。这样任务状态、代码状态和发布证据能够保持同一事实来源。
