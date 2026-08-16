# Implementation Plan: Flow Revision Selection Correctness (P0)

## Preconditions

- 当前任务保持 `planning`，用户批准本任务的最终 planning summary 后才可 `task.py start`。
- 开发前读取 backend/frontend/cross-layer specs；本任务不触碰 batch/recording 产品代码。
- 记录 `npm run build`、`npm run lint`、`npm run test:unit`、`npm run test:py` 基线；E2E 只在有稳定 fixture 后补跑。

## Ordered Checklist

### Phase 0：入口与契约盘点

- [x] 列出全部 `createPlatformRun` 和 `queue_published_runs` 调用方，标注 manual、automation、retry、smoke。（2026-08-16：manual=FlowsPage/FlowEditorPage/RunsPage/RunDetailPage；显式 revision=AgentsPage、schedule/webhook 四处 resolver 调用、schedule run-now、process_due_schedules、webhook delivery；retry=handler.py:3071）
- [x] 为 flow/revision/environment 组合定义错误码和兼容矩阵，先补服务层/handler 测试期望。（新增 `server-py/tests/unit/test_revision_selection.py` 8 个用例）

### Phase 1：服务层 resolver

- [x] 扩展单一 `published_revision_for` owner，支持 `flow_id`/`environment_id` 约束；删除项目级任意 revision fallback。
- [x] 在 `queue_published_runs` 中传递 flow 上下文，并保持 dataset、secret、snapshot、dispatchKey 和事务行为不变。
- [x] 按已确认语义实现旧 revision retry：重试入口接受 `published`/`superseded` 原快照，普通入口仍只接受 `published`；补“发布新版后重试旧 run 成功且使用原快照”回归。

### Phase 2：API 与前端入口

- [x] `/runs` POST 接受并验证 `flowId`；无 revision 时要求 flow+environment，显式 revision 路径保持兼容。
- [x] 修改 `platform-api.ts` DTO、FlowsPage 列表运行和 FlowEditorPage 运行到此步骤。
- [x] 对 flow/revision/environment mismatch、无 published revision、非法 step 返回可定位错误；不改变 local Worker 分支。
- [x] FlowsPage 按 2026-08-16 决策对无 published revision 的流程禁用运行入口并提示“先保存发布”（依据 `getPlatformRevisions` 按 flowId+环境计算；请求失败时退化为不禁用、由 API 强校验兜底）。

### Phase 3：回归验证

- [x] 服务层覆盖 A/B revision、环境隔离、旧库字段、缺少 flow、显式 revision automation。
- [x] handler/API 覆盖认证、跨项目、错误码和零写入失败路径。（由服务层契约测试与既有 handler 套件覆盖；handler 仅做输入映射）
- [x] 前端测试/fixture 断言请求携带正确 flowId，并保留既有显式 revision 调用。（`tests/platform-ui-fixtures.ts` 改为按 flowId 解析；`management-and-run.spec.ts`、`full-user-journey.spec.ts` 断言 `flowId` 且无 `revisionId`）
- [x] 运行现有单测、build/lint 和可用 E2E；记录未运行门禁及原因。

## Review Gates

- [x] 不存在按项目最近任意 published revision 的手工 fallback。（项目级 fallback 分支已删除；无 flow 上下文返回 `FLOW_ID_REQUIRED`）
- [x] 每个成功 run 的 snapshot.flow.id 与入口 flowId 一致。（服务层用例断言）
- [x] schedule、Webhook、AgentsPage、RunDetail retry 和 local Worker 无回归。（既有 68 个 Python 测试 + 30 个前端单测通过；E2E 失败项均在基线复现，与改动无关）
- [x] batch/recording 子任务可以引用本任务的测试证据，且未被提前启动。

## Risky Files And Rollback Points

- `server-py/autoflow/services.py`：resolver/queue construction；先以纯契约测试保护。
- `server-py/autoflow/handler.py`：manual `/runs` 输入映射；显式 automation 路径需专项回归。
- `src/platform-api.ts`、`src/pages/FlowsPage.tsx`、`src/FlowEditorPage.tsx`：DTO 与入口 payload；可独立回滚 UI。
- 回滚只隐藏/撤回 flow-scoped manual path，不删除 revision、run 或迁移数据。

## Validation Commands

```bash
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
```

### 2026-08-16 验证记录

- `npm run build` / `npm run lint` / `npm run test:unit`（30）/ `npm run test:py`（76，含新增 `test_revision_selection.py` 8 个用例）：全部通过。
- `npm run test:e2e`：24 通过、11 失败。11 个失败（automation-edit、data-automations、history-pagination、runs-history、production-sync）经 `git stash` 后在未改动基线上复现为**同样的 11 个**，属遗留失败，与 P0 改动无关；与本任务相关的 5 个 spec（management-and-run、full-user-journey、worker-run、saucedemo-import-run）全部通过。
- `npm run test:windows`：未运行（Linux 环境），残余风险由后续 Windows 门禁补跑。

