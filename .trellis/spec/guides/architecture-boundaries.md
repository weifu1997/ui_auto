# Architecture Boundaries

> **Purpose**: 明确哪些文件/模块可以动、哪些尽量别碰，作为「参考 ui_auto_new 整体架构改造」（五阶段渐进增强）的改动边界。
> **来源**: 任务 `08-24-reference-ui-auto-new-architecture` 整体架构评估 1.5 节三区划分，阶段0（`08-27-phase-0-contracts-baseline` R0-1）评审通过，2026-08-28 固化。

---

## 三区划分总则

| 区 | 含义 | 改动姿态 |
|---|---|---|
| **① 稳定契约区** | 对外契约与安全面，改动风险最高 | **尽量别碰**；如需修改必须单独评审 + 兼容性论证 + 完整门禁 |
| **② 可重构区** | 内部实现可重排，但**保留对外行为** | 允许重构，行为不变；先有测试覆盖再动 |
| **③ 可扩展区** | 纯增量能力 | 直接新增，禁止混入行为类改动 |

**阶段边界原则**：行为类改动（重构）与能力类改动（新特性）分阶段、分提交；能力失败只摘除增量，不连带回滚既有行为。

---

## ① 稳定契约区（尽量别碰）

改动必须满足：等价重构（可验证的对外行为零变化）、单独评审、过完整门禁（`test:all`）。任何 schema / API / 事件 kind / 错误码 / 校验规则 / 安全面的修改都属此处。

### 前端
- `src/domain/model.ts` — FlowStep/Flow 领域模型（含断言字段）
- `src/lib/flow-normalize.ts` — 流程规范化 / 断言字段透传
- `src/api/platform-api.ts` — 平台 API 客户端与请求/响应契约
- `src/api/platform-context.ts` — 平台会话/项目上下文

### 后端
- `server-py/autoflow/core/`、`http/`、`transport/`、`crypto/`、`auth/`、`sensitive/`、`audit/` — 核心纯函数 / HTTP / 传输 / 密钥 / 认证 / 脱敏 / 审计
- `workspaces.py` RBAC — 工作区-项目隔离与权限
- `revision_snapshot.py` 的 `STEP_KEYS` — 修订快照冻结字段（checksum 输入）；**新断言/步骤字段必须进 `STEP_KEYS`，否则改断言不产生新版本**
- 运行事件 `kind` 与顺序契约 — 尤其 `step.asserted` 恒在 `step.completed`/`step.failed` 之前；`step.locatorFallback` 事件已存在（自愈引擎预留）
- `managed_runner.py` — ManagedRunner 调度（全局并发2 / 工作区并发1、取消、重试、心跳）
- `migrations.py` 既有版本 — 只允许增量迁移
- 错误码枚举
- e2e 契约与 `.trellis/spec` 既有内容

---

## ② 可重构区（保留对外行为）

允许拆分/抽公共/去重，但**对外可观测行为必须不变**。动之前先确认有测试覆盖；没有的（如 `ServerWorkspaceSynchronizer.tsx` 零单测）**先补测试再重构**。

- `src/pages/FlowEditorPage.tsx`（2233 行）拆分（阶段1-B 完成：2233→1366 行，抽出 AssertionStepPanel/RecordingImportPanel/AssertionBatchBar/StepList）
- `server-py/autoflow/services/runs/` 包（阶段1-C 完成：原 `runs.py` 1409 行拆为 `RunServicesBase` + `_RunsLifecycleMixin`/`_RunEventsMixin`/`_BatchMixin`/`_ReportMixin`/`_AggregationMixin`；`from .runs import RunServices` 路径不变）
- `runner.py` 抽公共启停（阶段2-B 完成：`_BrowserSession` context manager + `_close_quietly`，两运行入口共用；阶段2-F 另增 D5 自愈辅助 `_fallback_candidates`/`_heal_locator`/`_run_element_action`）
- `recorder.py`（1305 行）拆文件（阶段2-A 完成：行为逻辑拆到 `recorder_capture.py`/`recorder_normalizer.py`/`recorder_validation.py`，`recorder.py` 收窄为 `RecordingCoordinator` + shim re-export，import 路径零变化）
- `shared.tsx` 去重
- `main.py` 移除模块级副作用（阶段1-D 完成：`create_platform_app()` 工厂 + 模块 `__getattr__` 惰性暴露 `app`）
- `ServerWorkspaceSynchronizer.tsx`（588 行）— 阶段1-E 已补 MSW 单测，可继续重构

---

## ③ 可扩展区（纯增量）

纯新增，不改既有行为。按阶段引入的新依赖也在此区（引入即需评估许可证/兼容性/维护度）。

- 新断言类型（URL 匹配、网络响应/API 断言等，需新基建的另起任务）
- 定位器自愈引擎（`LocatorScorer` 接口预留可选 LLM 实现）
- 新端点 / 新表（增量迁移）
- 图表（recharts）、虚拟滚动（@tanstack/react-virtual）、MSW 测试基建、限流、HTML 报告

---

## 超界评审流程

后续任一阶段若需改动 ① 稳定契约区，或对 ② 可重构区的改动可能改变对外行为：

1. 在任务 PRD 中显式列出将触碰的契约（schema / API / 事件 / 错误码 / 安全面）。
2. 给出兼容性论证：旧数据如何读取、旧调用方如何不破、回滚策略。
3. 注明验证方式：`test:all` + 针对性 e2e / 数据迁移回放。
4. 评审通过后方可实施。

## 评审结论（2026-08-28）

- 三区划分通过（D7）。
- 阶段0 定位：不产生业务代码改动。基线门禁中发现并修复的「断言/步骤 id 时间戳派生导致勾选断言被静默丢弃」为阻塞绿基线的必要正确性修复（`recording-editor-state.ts`），不改任何契约，已记录于阶段0 PRD 基线记录。
