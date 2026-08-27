# 阶段1 整体架构（断言 schema 单源化 + 大文件拆分 + MSW 测试基建）

## Goal

子任务（父任务: `reference-ui-auto-new-architecture`，D3-D7 已确认）。在阶段0 固化的可改动边界内（`.trellis/spec/guides/architecture-boundaries.md`），完成：

1. **断言 schema 单源化**：收敛 4 处散落定义（`src/domain/model.ts` / `src/lib/flow-normalize.ts` / `revision_snapshot.py:STEP_KEYS` / `runner.py` 求值），以契约文档为权威、两端各收敛到单一模块，配跨层 parity 测试防漂移。
2. **大文件行为保持拆分**：`FlowEditorPage.tsx`（2233 行）→ `services/runs.py`（1409 行）→ `main.py`（436 行，移除模块级副作用），顺序执行、逐阶段验证。
3. **MSW 测试基建**：引入 `msw`（devDependency），先支撑 `ServerWorkspaceSynchronizer.tsx` 补测（当前零单测）。

**边界**：只做①/②/③区中已评审的动作——本阶段不改任何 schema/API/事件/错误码/安全面（稳定契约区）；所有拆分保留对外行为。

## Requirements

### R1-1 断言 schema 单源化

- 契约文档 `.trellis/spec/backend/assertion-field-contract.md` 已在阶段0固化并挂入 `backend/index.md`（权威来源：字段、归属断言类型、允许枚举、缺省值、`step.asserted` 载荷与顺序）。本阶段落地代码实现。
- 前端收敛到 `src/domain/assertions.ts`（常量 + 类型引用），`flow-normalize.ts` 不再内联字面量。
- 后端收敛到 `server-py/autoflow/assertion_contract.py`（枚举 + `_ASSERTION_TYPES` + 规范字段集），`runner.py` 与 `revision_snapshot.py` 改从此导入。
- 跨层 parity：TS/Python 各一份单测比对契约（两端枚举漂移即红）；e2e 校验 `_ASSERTION_TYPES` 键与前端 `actionOptions` 断言动作一致。
- **不引入 TS/Python 共享代码生成**（本阶段无构建期代码生成，跨语言单源 = 契约文档 + 两端单一模块 + parity 测试）。

### R1-2 FlowEditorPage 拆分（保留行为）

- 抽取断言配置面板、录制导入候选面板、批量编辑条、步骤列表渲染为独立组件/hook；页面保留编排职责。
- 拆分前后 `npm run test:unit`（含 FlowEditorPage 既有 e2e 风格用例）与 `npm run build && npm run lint` 全绿。

### R1-3 runs.py 拆 mixin（保留行为）

- `RunServices`（26 行起，单类 1409 行）拆为基类 + mixin（生命周期 / 事件 / batch / 报告 / 聚合），对外方法名与签名不变。
- 拆分后 `npm run test:py` 全绿。

### R1-4 main.py 移除模块级副作用

- `app = create_app()`（main.py:436）移入显式工厂/入口守卫，导入模块不再触发服务初始化。
- `npm run test:py` + `npm run test:startup`（生产启动契约）全绿。

### R1-5 MSW 测试基建

- 新增 `msw` devDependency；`src/test/server-handlers.ts` 映射 platform-api 端点；vitest setup 接入 `msw/node`。
- 先为 `ServerWorkspaceSynchronizer.tsx` 补单测（同步轮询、并发刷新、整体 PUT 不丢模板扩展字段），逐步替换 `vi.mock("../api/platform-api")` 的手写 mock。
- `msw` 仅测试依赖，不进入生产 bundle（`npm run check:bundle` 全绿）。

## Acceptance Criteria

- [ ] 契约文档存在且两端各自单一模块引用；parity 单测 + e2e 通过；`STEP_KEYS` 仍含全部断言字段。
- [ ] FlowEditorPage / runs.py / main.py 拆分按序完成，全程门禁全绿，无对外行为变化。
- [ ] MSW 接入，`ServerWorkspaceSynchronizer` 有单测覆盖，bundle 不超预算。
- [ ] `npm run test:all` 全绿（e2e 每阶段完整验收门禁）。

## Non-Goals

- 不改 schema / API / 事件契约 / 错误码 / 安全面（稳定契约区只读）。
- 不开始阶段2 录制/执行稳定性、阶段3 断言新能力、阶段4 UI 能力（各自子任务负责）。
- 不引入代码生成构建链。
