# 下一阶段稳定性迭代

## Goal

按照 `.trellis/tasks/08-15-next-roadmap-planning/prd.md`，将 P0-P2 拆成可独立验证的交付，先收敛 Python 迁移、生产同步、版本快照和运行历史，再推进自动化编辑、服务端分页与前端包体优化。

## Requirements

- 父任务持有跨子任务的验收目标，不直接承担代码实现。
- 每个子任务必须有可观察的验收标准、验证命令和回滚点。
- 执行顺序遵循建议迭代：迁移收尾 -> 同步可靠性 -> 版本快照 -> 运行历史 -> P2 运营能力。
- 任何涉及敏感数据、现有数据库或生产数据的变更必须保留原数据，不静默覆盖或删除。

## Acceptance Criteria

- [ ] 所有 P0/P1 子任务按计划完成，P2 子任务按独立任务进入实施。
- [ ] AC0-AC6 归属到对应子任务并可被对应验证命令覆盖。
- [ ] 工作区最终不残留 `server-py/server/.data/`、旧 TS 启动路径或 Trellis 状态漂移。
- [ ] 每个子任务提交前都通过质量检查，并留下验证记录。

## Notes

- 子任务：`python-migration-wrapup`、`production-sync-outbox`、`canonical-version-snapshots`、`runs-history-loading`、`automation-edit-capabilities`、`history-pagination`、`frontend-bundle-optimization`。
- 不在父任务中一次性并行实施全部 P0-P2，不绕过子任务验收。
