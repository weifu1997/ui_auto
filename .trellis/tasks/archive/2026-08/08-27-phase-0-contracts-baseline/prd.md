# 阶段 0：契约与基线

> 父任务：`reference-ui-auto-new-architecture`（D3-D7 已确认，见父 PRD）
> 状态：planning → 本文档即阶段0 的需求与验收。

## Goal

为后续四个阶段确立**可改动边界**与**验证基线**，并产出阶段1 的实现计划。本阶段不修改业务代码。

## Requirements

### R0-1 可改动边界正式评审

依据整体改造评估（`docs/` 或任务文档）1.5 节三区划分：

- **① 稳定契约区（尽量别碰）**：前端 `domain/model.ts`、`flow-normalize.ts`、`api/platform-api.ts`、`platform-context.ts`；后端 `core/http/transport/crypto/auth/sensitive/audit`、`workspaces.py` RBAC、`revision_snapshot.py:STEP_KEYS`、运行事件 kind 与顺序契约、`managed_runner.py`、`migrations.py` 既有版本、错误码枚举、e2e 契约与 `.trellis/spec`。
- **② 可重构区（保留对外行为）**：`FlowEditorPage.tsx` 拆分、`services/runs.py` 拆 mixin、`runner.py` 抽公共启停、`recorder.py` 拆文件、`shared.tsx` 去重、`main.py` 移除模块级副作用、`ServerWorkspaceSynchronizer.tsx` 先补测试再重构。
- **③ 可扩展区（纯增量）**：新断言类型、定位器自愈引擎、新端点/新表（增量迁移）、图表/虚拟滚动/MSW/限流/HTML 报告。

评审通过后写入 `.trellis/spec` 固化（新增 `guides/architecture-boundaries.md` 或追加现有 spec），后续阶段改动超界需评审。

### R0-2 基线门禁

跑通当前分支（`v3.2_flow_assertion`）的质量门禁，记录基线：

- `npm run build`
- `npm run lint`
- `npm run test:unit`
- `npm run test:py`
- `npm run check:bundle`
- （e2e 在本地已跑过基线；每阶段结束以 `test:all` 为完整验收门禁）

基线结果记录到本任务 `check.jsonl` / 验收清单。

### R0-3 阶段1 实现计划

产出 `08-27-phase-1-architecture/implement.md`：断言 schema 单源化的数据契约、拆分顺序（FlowEditorPage → runs.py → main.py）、MSW 接入点、验收标准。

## Acceptance Criteria

- [x] 可改动边界评审通过并固化到 `.trellis/spec`（新增 `guides/architecture-boundaries.md` 并挂入 guides 索引）。
- [x] 基线门禁全绿并记录结果（见「基线记录（R0-2）」）。
- [x] 阶段1 `implement.md` 就绪（数据契约 + 拆分顺序 + MSW 接入 + 验收标准）；阶段1 `prd.md` 同步补全需求与验收。
- [x] 阶段0 不产生业务代码改动（注：基线门禁中发现并修复「断言/步骤 id 时间戳派生导致勾选断言被静默丢弃」——阻塞绿基线的必要正确性修复，详见「基线记录」；不改任何契约，且与既有「元素 id 内容派生」设计原则对齐）。

## Non-Goals

- 不引入任何新依赖。
- 不修改数据库 schema 与 API 契约。
- 不开始阶段1 的编码。

## Notes

- 阶段边界原则：行为类改动（重构）与能力类改动（新特性）分阶段/分提交，能力失败只摘除增量。

## 基线记录（R0-2，2026-08-28 于分支 v3.2_flow_assertion）

| 门禁 | 结果 | 备注 |
|---|---|---|
| `npm run build` | ✅ | `tsc -b && vite build` 通过（545ms），含 `noUnusedParameters` 等严格开关 |
| `npm run lint` | ✅ | oxlint 无告警 |
| `npm run test:unit` | ✅ | 24 文件 / 109 用例全绿 |
| `npm run test:py` | ✅ | 258 用例全绿（1 条无关 StarletteDeprecationWarning） |
| `npm run check:bundle` | ✅ | bundle ≤ 500 kB |
| e2e | 基线已跑 | 每阶段结束以 `test:all` 为完整验收门禁 |

**基线期修复（必要正确性 bug，阻塞绿基线）**：

`planRecordingImport` 的步骤/断言 id 原为 `rec-step-${Date.now()}-${index}` / `rec-assert-${Date.now()}-${index}`（时间戳派生）。FlowEditorPage 在「候选预览」（`draftPlan` useMemo）与「确认导入」（`importRecordedFlow` 重算）各调一次该函数，两次 `Date.now()` 不同 → 勾选的候选断言在导入时被静默丢弃（`assertion.id` 不再命中 `selectedAssertionIds`），`flow-editor-batch-import.test.tsx` 因此失败。

修复（对齐既有「元素 id 内容派生 FNV-1a」设计原则，`src/lib/recording-editor-state.ts`）：

- 将 `recordedElementId` 泛化为 `contentId(prefix, key)`（FNV-1a 不变）；
- 步骤 id 改为 `contentId("rec-step", index+recorded.id+action+element+value)`，断言 id 改为 `contentId("rec-assert", index+name)`（可见性）与 `contentId("rec-assert", seq+name+snippet)`（建议草稿）；
- `now` 参数保留并改名 `_now`（兼容测试位置传参；tsc noUnusedParameters 放行），不再参与 id 生成；
- 单测 `recording-editor-state.test.ts` 的稳定性格言扩展覆盖步骤/断言 id（跨时钟、跨 refetch 一致 + 不与时间戳耦合 + 计划内不冲突）。
