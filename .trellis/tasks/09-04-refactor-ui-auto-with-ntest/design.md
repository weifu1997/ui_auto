# 第一阶段技术设计：核心可用闭环

## 目标与边界

第一阶段只实现 PRD R7 的五个硬目标：启动可用、录制整理、定位器候选/启发式自愈、统一流程/断言契约、可解释执行反馈。保留 React + FastAPI + SQLite + Playwright + ManagedRunner，不迁移 Vue/Pinia，也不引入 Redis/Celery/MySQL/外部 AI/远程 Agent。

`ntest` 源码在当前环境无法从 GitHub 获取，因此设计吸收的是可验证的产品模式（智能录制、定位候选、异步状态、断言报告），不复制其实现。拿到参考源码后，只能补充差距矩阵和行为测试，不能绕过本项目契约。

## 现有边界

- 前端入口和页面路由位于 `src/`，HTTP 边界集中在 `src/api/platform-api.ts`，共享领域类型位于 `src/domain/` 和 `src/lib/`。
- 后端路由位于 `server-py/autoflow/handler/`，业务服务通过 `server-py/autoflow/services/` mixin 组合，运行核心为 `managed_runner.py`/`runner.py`，录制核心为 `recorder.py` 及其 normalizer。
- 运行快照由 `revision_snapshot.py` 规范化，断言字段由 `assertion_contract.py` 与 `src/domain/assertions.ts` 双端 parity 测试保护。
- 稳定契约区（认证、项目隔离、事件 kind/顺序、密钥、既有快照键）默认只读；新增能力通过兼容字段、增量迁移和新端点实现。

## 数据流

```text
启动检查/fixture
        ↓
登录 → 项目/流程草稿 → 录制会话
                         ↓
             事件规范化 + 候选定位器
                         ↓
                 可编辑流程 schema
                         ↓ 保存/发布
                 版本化执行快照
                         ↓ ManagedRunner
        主定位器 → 唯一性评分 → 备用定位器（必要时）
                         ↓
              step.started / asserted / completed|failed
                         ↓
           运行详情：步骤、断言、期望/实际、日志、截图/Trace
```

## 设计要点

### 1. 启动与可用性

- 保留 `npm run setup:py`、`npm run build`、`npm run start` 为受支持入口。
- 增加可测试的 preflight/health 检查：静态产物、配置密钥、SQLite 可写、Playwright Chromium 可用、fixture 路由可访问。
- 错误必须包含失败项、修复命令和是否可继续；不在前端静默降级到演示数据或旧 local fallback。

### 2. 录制结果

- 录制事件先进入后端/共享 normalizer，再转换为 `FlowStep`；转换必须保持稳定 ID、动作、元素引用、值和超时。
- 候选定位器采用结构化列表（策略、表达式、来源、评分、风险），主定位器仍兼容现有字段。
- 录制会话状态继续使用现有状态机；需要持久化的元数据采用增量迁移，浏览器 context/登录态仍只在进程内保存。

### 3. 定位器自愈

- 抽象 `LocatorScorer` 接口；第一阶段只实现基于 DOM 属性派生和 `count() === 1` 的确定性评分。
- 只对需要元素定位的动作启用候选回退；导航、等待和断言动作不隐式改变语义。
- 每次回退写入结构化运行事件和报告字段，包含原定位器、候选、选择原因和最终结果；所有候选有上限，避免执行时间失控。

### 4. 统一契约

- 以现有 `FlowStep`/revision snapshot 为兼容基础，明确必填字段、可选字段、默认值和 schema 版本。
- 断言动作、字段、默认值、事件载荷和报告类型继续由契约文档 + TS/Python 常量 + parity 测试共同约束。
- 新字段必须加入快照键白名单和兼容读取路径；旧快照缺字段时使用显式默认值而非 `undefined` 传播。

### 5. 执行反馈

- 运行状态由服务端作为唯一事实来源；前端轮询/事件刷新只更新缓存，不自行推断终态。
- 失败响应必须可关联到步骤 ID、事件序号和 artifact ID；重试/取消保持现有幂等键与权限边界。
- 报告先保证详情正确，再考虑图表/导出等第二阶段体验增强。

## 兼容、迁移与回滚

- 优先无数据库迁移；确需录制会话字段时只做向前兼容的增量 migration，并为旧数据库提供默认值。
- 不修改既有事件 kind/顺序、错误码、密钥明文边界和项目隔离规则。
- 每个工作流以独立提交落地；若某项导致门禁回归，可单独 revert，不需要回滚数据。

## 验证策略

- 单元：normalizer、schema 默认值、locator scorer、报告转换和启动 preflight。
- 后端：录制会话生命周期、候选回退、事件/报告契约、旧快照读取。
- 前端：录制导入、编辑保存、运行状态和失败详情。
- E2E：本地 fixture 完成登录后创建项目、录制/配置、保存、执行、失败诊断的闭环（真实网站验证范围待用户确认）。
