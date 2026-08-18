# 整理并独立提交现有改动

## Goal

在不混入不同功能的前提下，复核工作区现有改动，将其按所属任务提交并推送到 `origin/master`。

## Confirmed Facts

- `src/FlowEditorPage.tsx` 已引用未跟踪的 `recording-editor-state.ts`；该模块负责录制事件游标、会话恢复和原子导入计划，不能作为孤立测试文件丢弃。
- `platform-api-recording.test.ts`、`recording-editor-state.test.ts` 与 `docs/流程录制-MVP.md` 共同覆盖和说明录制编辑器的脱敏、秘密绑定及导入边界。
- `tests/retry-reproduction.spec.ts` 验证 fresh-run 使用当前发布版本，而 retry 使用源运行的不可变快照；其验收证据位于 `08-16-flow-retry-reproduction-correctness`。
- 批量执行和遗留 E2E 改动均为已有验证结果及任务元数据的收尾记录，不包含新的产品代码。

## Requirements

### R1 Independent Commit Boundaries

- 录制编辑器状态、录制 API 脱敏测试、录制用户文档、敏感 revision 保存规范和录制 MVP 验收记录作为一个提交。
- 重试快照 UI 回归及 retry 任务验收记录作为一个提交。
- 批量执行 E2E 闭环记录单独提交。
- 遗留 E2E 失败闭环记录和其上下文清单单独提交。

### R2 Verification And Delivery

- 每组提交前运行与其风险相称的测试；所有提交前运行工作区格式检查。
- 不修改或暂存当前范围之外的文件。
- 所有提交成功后，将 `master` 推送至 `origin`；不强推、不改写历史。

## Acceptance Criteria

- [x] AC1：录制编辑器状态、API 脱敏和文档改动通过前端构建、相关 Vitest 与 Python 录制回归，且不会将敏感原值写入前端状态或 revision。（`npm run lint`、`npm run build`、`npm run test:unit` 33 passed、`npm run test:py` 108 passed。）
- [x] AC2：重试 UI 回归通过，fresh-run 与 retry 的版本/快照语义保持不同且可观测。（隔离端口 Playwright 场景通过。）
- [x] AC3：批量执行和遗留 E2E 任务记录仅包含已验证的结果，且独立提交不混入录制或重试代码。（四个提交分别复核暂存范围。）
- [x] AC4：四个逻辑提交均在本地成功创建，`git diff --check` 通过，并已推送到 `origin/master`。（`2f19954`、`e380be5`、`8cf0332`、`23efcae`。）

## Planned Commits

1. `feat(recording): complete editor recording state`
2. `test(retry): cover snapshot reproduction workflow`
3. `docs(batch): record full E2E verification`
4. `chore(tasks): record legacy E2E closure`

## Out Of Scope

- 不重写已存在的录制、重试、批量执行或遗留 E2E 产品实现。
- 不修改远端历史、不强推，也不归档仍在进行中的原始任务。

## Risks

- 现有工作区内容来自并行工作，提交前必须用文件路径和测试范围验证归属，避免误带入。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
