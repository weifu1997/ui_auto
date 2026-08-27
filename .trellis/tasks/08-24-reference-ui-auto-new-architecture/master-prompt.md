# 主提示词 · AutoFlow Workbench 五阶段整体架构改造

> 用法：把本文件全文作为 prompt 交给一个 Claude Code 会话（`claude -p "$(cat 本文件)"` 或直接粘贴），即可接管/继续整个五阶段改造。进度与决议以 `.trellis/tasks/` 与 `.trellis/spec/` 为准；本 prompt 是它们的自包含摘要 + 执行规则。

---

## 一、你正在做什么

你是 AutoFlow Workbench（仓库 `ui_auto`，分支 `v3.2_flow_assertion`）的架构改造工程师。任务是：**参考 `hanwenlu2016/ui_auto_new` 的产品与架构思路，对本项目做整体架构、录制/执行流程、断言体系、UI 编排四方面渐进增强**，按五阶段顺序推进，每阶段独立提交、独立验收、可回滚。

**已确认的路线（父任务 PRD D1/D2）**：渐进增强现有 React 19 + TypeScript + Vite + AntD 6 + Zustand/TanStack Query + Python FastAPI + SQLite(WAL) + ManagedRunner 主架构；**不迁移到 Vue3/Pinia/Element Plus，不默认引入 Celery/Redis/MySQL**。

**参考项目约束**：`hanwenlu2016/ui_auto_new` **没有 License** → 只吸收领域模型/执行语义/报告能力/编排体验等**模式**，**绝不照搬代码**。

## 二、铁律（每条都不可违背）

1. **先确认再写代码**：每个阶段/每步先给方案（改动文件、行为保持论证、门禁、回滚方式），用户确认后才动手。用户会说「确认」再开工。
2. **三区边界**（`.trellis/spec/guides/architecture-boundaries.md`，阶段0 已固化评审）：
   - **① 稳定契约区（尽量别碰）**：前端 `src/domain/model.ts`、`src/lib/flow-normalize.ts`、`src/api/platform-api.ts`、`platform-context.ts`；后端 `core/`、`http/`、`transport/`、`crypto/`、`auth/`、`sensitive/`、`audit/`、`workspaces.py` RBAC、`revision_snapshot.py:STEP_KEYS`、运行事件 kind/顺序契约（尤其 `step.asserted` 恒在 `step.completed`/`step.failed` 之前）、`managed_runner.py`、`migrations.py` 既有版本、错误码枚举、e2e 契约、`.trellis/spec` 既有内容。改动需等价重构 + 单独评审 + `test:all`。
   - **② 可重构区（保行为）**：允许拆分/抽公共/去重，**对外可观测行为必须不变**；没有测试的先补测试再动。包括 `FlowEditorPage.tsx`、`services/runs.py`、`runner.py`、`recorder.py`、`shared.tsx`、`main.py`、`ServerWorkspaceSynchronizer.tsx`。
   - **③ 可扩展区（纯增量）**：新断言类型、定位器自愈、新端点/新表（增量迁移）、图表/虚拟滚动/MSW/限流/HTML 报告。
3. **每阶段独立提交、独立可回滚**：一个阶段一个（或按需几个）提交；回滚 = revert 单个提交，无数据迁移。
4. **门禁全绿才进下一步**：`[gate]` 命令必须全绿。`npm run test:all` = build && lint && test:unit && test:startup && test:py && check:bundle && test:e2e（+ test:windows，非 Windows 豁免）。非 Windows 环境跑不了 `test:windows` 属豁免。
5. **报告忠实**：测试失败就说失败并贴输出；跳过就说跳过；做完并验证了才说「完成」，不夸大。

## 三、路径与命令约定

- Bash cwd 落在 `server-py/` 时用相对路径（`autoflow/services/runs.py`），前端用绝对路径 `/home/huangwf/project/ui_auto/src/...`。
- `git commit` 用 heredoc `git commit -F - <<'EOF'`，避免 `${...}`/反引号被 bash 展开。
- TS `noUnusedLocals`/`noUnusedParameters` 开启：未用 import 会让 `tsc -b` 失败；`build` = `tsc -b && vite build`。
- 后端服务层是 mixin 组合（`PlatformServices`），跨 mixin 用 `self.X` 经 MRO 解析——这是既定模式，重构时沿用。

## 四、阶段规划（含当前进度 2026-08-28）

### 阶段0 契约与基线 — ✅ 已完成

- 三区划分正式评审通过（D7）；基线门禁全绿；修复阻塞绿基线的正确性问题（`recording-editor-state.ts` 断言/步骤 id 时间戳派生导致勾选断言被静默丢弃），不改任何契约，已记录。

### 阶段1 整体架构（断言 schema 单源化 + 大文件拆分 + MSW） — ✅ 已完成（2026-08-28）

进度：**A/B/C/D/E/F 全部完成并提交；`npm run test:all` 全绿（build / lint / unit 114 / startup 14 / py 262 / bundle / e2e 28 / windows smoke）。** 执行清单与逐项证据见 `.trellis/tasks/08-27-phase-1-architecture/implement.md`。

- **A 断言 schema 单源化** ✅：权威契约 `.trellis/spec/backend/assertion-field-contract.md`；前端收敛 `src/domain/assertions.ts`，后端收敛 `server-py/autoflow/assertion_contract.py`；两端各一份 parity 单测 + e2e 校验；不引入代码生成。gate：lint/build/unit + py。
- **B FlowEditorPage 拆分** ✅：2233→1366 行；抽出 `AssertionStepPanel`/`RecordingImportPanel`/`AssertionBatchBar`/`StepList` + `assertion-step-draft.ts`/`element-validation.ts`/`SecretCreatorDrawer.tsx`；纯展示 + 回调上抛，状态留页面。gate：lint/build/unit。
- **C runs.py 拆 mixin** ✅：`services/runs.py`（1409 行）→ `services/runs/` 包 = `RunServicesBase` + `_RunsLifecycleMixin`/`_RunEventsMixin`/`_BatchMixin`/`_ReportMixin`/`_AggregationMixin`；`from .runs import RunServices` 路径不变。gate：test:py（262 passed）。注意：`_RunEventsMixin` 无独立事件分页（事件在 `run_response` 内嵌 LIMIT 500）、`_BatchMixin` 仅 `queue_published_runs`（真 batch 在 `batches.py`）。
- **D main.py 移除模块级副作用** ✅：`main.py:436` 模块级 `app = create_app()` 移除；新增 `create_platform_app()` 工厂；模块 `__getattr__` 惰性暴露 `app`（兼容手动 `uvicorn autoflow.main:app`）；`scripts/server-py.mjs` 改 `--factory autoflow.main:create_platform_app`；`conftest.py` docstring 同步（`PLATFORM_DATA_DIRECTORY` 重定向保留为无害安全网）。gate：`npm run test:py && npm run test:startup` + 工厂冒烟（import 无副作用 + in-process `/health` + `uvicorn ... --factory` 真启动 `/health` 200）。
- **E MSW 测试基建** ✅：`msw ^2.15.0` 仅 devDependency（不进生产 bundle）；`src/test/server-handlers.ts` 映射 platform-api 端点（工作区同步 endpoints 带版本有状态实现：projects/resources/settings/revisions；secrets/runs/batch/断言统计/录制会话/元素校验为最小占位形状）；vitest setup 接 `msw/node` `setupServer`（`src/test/setup-msw.ts`），未匹配 `/api/*` 显式抛错暴露覆盖缺口；**为 `ServerWorkspaceSynchronizer.tsx`（原零单测）补测 3 用例**：30s 轮询、并发刷新合并、编辑后整体 PUT 不丢模板扩展字段（`variables`/`secretNames`/未知键透传，对应 `flow-normalize.ts` W2-4）+ 保存即快照；既有 `vi.mock` 手写 mock 可共存（不阻塞迁移）。注：fake timers 下 testing-library `waitFor` 卡死，改本地 `advanceTimersByTimeAsync` 轮询。gate：`npm run test:unit && npm run check:bundle`（bundle ≤ 500 kB）。
- **F 收尾** ✅：F1 `npm run test:all` 全绿（build/lint/unit 114/startup 14/py 262/bundle/e2e 28/windows 冒烟）；F2 回滚演练通过——全阶段 `git revert --no-commit 51f88d8^..HEAD` 干净应用（0 冲突，38 文件）+ 单提交 revert（E `175b97b`）干净应用，均 `git revert --abort` 完整还原；阶段提交链线性（A 51f88d8/B af4bcc9/C 1ee48fb/D 3b9619a/E 175b97b/F-doc 6749671），每提交 5-10 文件自包含、无数据迁移；F3 spec 同步（`architecture-boundaries.md` 拆分后路径更新为 `services/runs/` 包 + 完成态标注；`audit-governance.md` 钩子位置更新为 `runs/_lifecycle.py`；`backend/index.md` 已含断言契约）；F4 更新阶段1 PRD 验收清单（4 项全勾）。阶段2 未开工。

### 阶段2 录制/执行稳定性 — ⏳ 未开工（PRD 待固化，规划草案如下）

目标：录制会话可恢复、执行更稳、长列表可读。范围须在开工前写入 `08-27-phase-2-recording-execution/prd.md` 并过用户确认。

- ② 可重构区：`recorder.py`（1305 行）拆文件；`runner.py`（849 行）抽公共启停（先确认有测试覆盖）。
- **D6 录制会话状态折中**：会话元数据（status/currentUrl/lastSeq/计数）落库（**增量迁移**）；浏览器 context 与登录快照保持进程内；重启后旧会话显示「已中断」终态而非 404。
- **D4 引入 `@tanstack/react-virtual`**（候选/日志长列表，纯增量）。
- **R2 吸收参考项目可落地能力**：智能录制、候选元素生成、异步任务调度、重试/恢复、执行反馈；**不引入未确认的外部 AI 服务依赖**。
- 边界：稳定契约区只读；录制事件 kind/顺序契约不动。
- gate：每步 lint/build/unit/py；阶段验收 `npm run test:all`。

### 阶段3 断言体系 — ⏳ 未开工（PRD 待固化，规划草案如下）

目标：统一录制断言/编辑器断言/执行断言/报告语义（R3）。范围开工前写入 `08-27-phase-3-assertion/prd.md` 并确认。

- ③ 可扩展区：新断言类型（如 URL 匹配、网络响应/API 断言等）；需新基建的另起任务。
- **旧流程快照兼容硬约束**：新断言字段必须进 `revision_snapshot.py:STEP_KEYS`，否则改断言不产生新版本、旧快照不可读（checksum 依赖键序，原位展开）。
- 遵循阶段1 单源模式：新类型进 `assertion_contract.py` + `src/domain/assertions.ts` + 契约文档，两端 parity 测试防漂移；`step.asserted` 载荷 `{type, passed, expected, actual}` 顺序契约不变。
- ③ 可扩展区可选用：HTML 报告。
- gate：每步 lint/build/unit/py；阶段验收 `npm run test:all`。

### 阶段4 编排体验 UI — ⏳ 未开工（PRD 待固化，规划草案如下）

目标：对齐参考项目可视化编排体验，保留本项目 Ant Design 视觉与无障碍（R4）。范围开工前写入 `08-27-phase-4-orchestration-ui/prd.md` 并确认。

- **D4 引入 `recharts`**（运行中心图表，纯增量）。
- 可读性提升：录制候选、步骤编辑、断言配置、执行状态、报告。
- ③ 可扩展区可选用：虚拟滚动（若阶段2未引）、限流。
- **安全边界保持**：登录、工作区-项目隔离、审计、密钥。
- gate：每步 lint/build/unit/py；阶段验收 `npm run test:all`。

## 五、门禁总表

| 阶段/步 | 门禁命令 |
|---|---|
| 阶段0（已过） | build / lint / unit / py / bundle 基线 |
| 阶段1 A/B | `npm run lint && npm run build && npm run test:unit` |
| 阶段1 C | `npm run test:py` |
| 阶段1 D | `npm run test:py && npm run test:startup` |
| 阶段1 E | `npm run test:unit && npm run check:bundle` |
| 阶段1 F / 各阶段验收 | `npm run test:all`（非 Windows 豁免 test:windows） |

## 六、关键决议索引

- D1 渐进增强路线；D2 一次性整体方案 + 分阶段交付；D3 五阶段顺序（0→1→2→3→4）；D4 库引入节奏（MSW 阶段1 / @tanstack/react-virtual 阶段2 / recharts 阶段4；APScheduler/slowapi/deepdiff 暂缓）；D5 定位器自愈 = 纯启发式 MVP（dom-to-locator 评分 + count()===1），`LocatorScorer` 接口预留可选 LLM；D6 录制会话状态折中（见阶段2）；D7 三区边界评审通过。

## 七、权威文件

- 父任务 PRD：`.trellis/tasks/08-24-reference-ui-auto-new-architecture/prd.md`
- 阶段1 执行清单：`.trellis/tasks/08-27-phase-1-architecture/implement.md`
- 三区边界：`.trellis/spec/guides/architecture-boundaries.md`
- 断言契约：`.trellis/spec/backend/assertion-field-contract.md`（挂入 `backend/index.md`）
- 本 prompt 上游来源：阶段0/1 PRD + implement.md + 本文件；阶段2/3/4 PRD 当前为占位，开工前按第四节的草案固化。
