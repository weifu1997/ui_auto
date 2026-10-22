# 第一阶段实施 Prompt：让 ui_auto 核心闭环真正可用

你是 `ui_auto` 项目的资深全栈工程师。请在当前仓库内完成第一阶段重构，目标不是增加演示页面，而是让用户能够稳定完成一次真实的 Web UI 自动化闭环。

## 目标

第一阶段必须交付以下五项硬目标：

1. **可重复的一键可用闭环**：干净环境可安装、配置、构建、启动并打开登录页；缺少密钥、数据库、静态产物或 Chromium 时给出明确修复提示；不得静默使用演示数据或旧 local fallback。
2. **智能录制结果整理**：录制事件稳定转换为去重、可编辑、可保存的步骤，带候选定位器和风险提示；支持暂停/恢复/停止；服务重启后旧会话显示为“已中断”而非 404。
3. **定位器候选与启发式自愈**：元素保存主定位器和有限数量的备用候选；执行时仅对元素动作进行唯一性检查和确定性评分，必要时回退；报告必须说明选择原因和最终定位器；禁止外部 AI 依赖。
4. **统一流程和断言契约**：录制、编辑器、执行器、快照和报告使用一致、版本化、可兼容的 schema；旧快照继续可读；断言字段、默认值、事件载荷和报告语义不得漂移。
5. **可解释的执行反馈**：运行有明确排队/执行/成功/失败/取消/重试状态；失败详情关联步骤、断言期望/实际值、事件、日志和截图/Trace；刷新页面后状态仍一致。

本阶段的可重复硬验收基线是仓库内的本地 fixture；真实业务网站/内网站点不作为本阶段通过条件，除非任务负责人另行批准并提供可重复的站点、账号和网络条件。

## 执行前置条件

- 这份 Prompt 只在用户已批准 `prd.md`、`design.md`、`implement.md` 的最终规划摘要后执行。
- 收到 Prompt 时若 `task.py current` 仍显示任务状态为 `planning`，先停止并报告“等待规划批准”，不得修改产品代码。
- 已获批准时，先执行 `python3 ./.trellis/scripts/task.py start refactor-ui-auto-with-ntest`，再运行基线门禁；任务状态变为 `in_progress` 后才允许实现。

## 技术约束

- 保留 React 19 + TypeScript + Vite + Ant Design + Zustand/TanStack Query、FastAPI + SQLite(WAL)、Playwright、ManagedRunner。
- 不迁移 Vue/Pinia/Element Plus；不默认引入 Redis、Celery、MySQL、外部商业 AI 或远程 Agent。
- 认证、工作区/项目隔离、密钥不落盘、既有运行事件 kind/顺序、错误码和旧 revision snapshot 是稳定契约，除非先补兼容测试，不得破坏。
- 沿用 `server-py/autoflow/handler/` 路由包、`services/` mixin 服务层、`src/api/platform-api.ts` HTTP 边界和现有测试习惯。
- `ntest` GitHub地址：“https://github.com/rebort-hub/ntest.git” 源码在当前环境可能不可访问；不得臆造其代码。只吸收可验证的行为模式，并在差距矩阵中标注证据和不确定性。

## 预计改动范围

这是一次前后端协同重构，不能只修改单端页面：

- **前端（React/TypeScript）**：扩展 `src/domain`/`src/lib` 的流程、定位器、断言和运行结果类型；调整 `src/api/platform-api.ts` 的请求/响应边界；完善录制导入、步骤编辑、候选定位器提示、运行状态轮询和失败详情页面；补充 Zustand/TanStack Query 状态与 Vitest/Playwright 测试。
- **后端（FastAPI/Python）**：在 `server-py/autoflow/handler/` 和 `services/` 增补或收敛录制会话、定位器候选、自愈事件、运行详情和报告接口；在 `recorder*`/`runner.py` 中实现规范化与候选回退；必要时对 `migrations.py` 做向前兼容的增量迁移；补充启动 preflight、fixture、pytest 和 smoke 测试。
- **跨层契约**：同步更新 `revision_snapshot.py`、`assertion_contract.py`、前端断言常量和契约文档；保持既有事件 kind/顺序、错误码、项目隔离、密钥边界和旧快照兼容。
- **验证与文档**：更新 `README.md`、部署/启动说明和本地 fixture；运行前后端全套门禁并记录证据。
- **参考差距产物**：创建 `.trellis/tasks/09-04-refactor-ui-auto-with-ntest/research/ntest-gap-matrix.md`，记录每项参考能力的证据来源、当前实现、第一阶段缺口、处理结果和不确定性；无法访问源码时明确写“未验证”，不得凭空补齐。

先审计现有实现再改动：当前仓库已经有录制 normalizer、录制会话元数据、自愈 scorer、断言契约和运行报告的部分实现，本阶段只补真实缺口和回归测试，不重复创建同名模块。若某项只需单端改动，必须在实现说明中写明为什么不需要修改另一端；凡是新增跨层字段，都必须两端同时落地并有 parity 测试。

## 工作方式

1. 先读取任务目录中的 `prd.md`、`design.md`、`implement.md` 以及相关 `.trellis/spec`，确认当前任务仍是 planning；未获用户批准前不要运行 `task.py start` 或修改产品代码。
2. 开工后先运行基线门禁并记录结果。每个工作流独立提交、独立测试、可通过 revert 回滚。
3. 先修复核心闭环阻断，再做结构重构；发现现有行为没有测试时，先补测试再改实现。
4. 每新增一个跨层字段，都同步更新 TS 类型、Python 契约、快照白名单、API 边界和 parity 测试。
5. 所有录制/运行失败都必须能从 UI 找到下一步修复动作；不要吞掉异常或返回空成功。

## 必须明确并保持的契约

- **定位器自愈**：沿用现有 `LocatorScorer`/`HeuristicLocatorScorer` 语义：候选 `count() !== 1` 直接不可用；稳定性权重为 testid=100、role=90、label=80、text=60、css=40、XPath=20；只在原定位器未命中或 strict-mode 歧义时回退；一次动作最多执行一轮候选回退；候选生成必须有界。若发现现有实现与此不符，先补回归测试并在差距矩阵说明，不得静默改变事件语义。
- **候选可观测性**：继续使用既有 `step.locatorFallback` 事件，不新增同义事件；事件至少关联 `stepId`、原失败原因、候选 method/value 和最终结果，敏感值必须截断或脱敏。
- **流程 schema**：以现有 `FlowStep` 和 revision snapshot 为兼容基础，引入整数根字段 `schemaVersion`（当前为 `1`）；读取缺失字段的旧快照按 v1 默认值迁移，写入时统一输出 v1。迁移必须是纯函数并有旧快照 fixture；transient 字段不能影响 revision checksum。
- **断言契约**：断言动作、字段、默认值、`step.asserted` 载荷和报告类型继续由契约文档、TS/Python 常量及 parity 测试共同约束，事件顺序不得改变。
- **运行状态**：服务端是唯一事实来源；终态只能由服务端返回，前端刷新/轮询不得自行把运行标记为成功或失败。失败必须能关联步骤、事件序号和 artifact ID。

## 推荐实施顺序

- A：启动 preflight、health、生产 smoke 和本地 fixture。
- B：录制事件到稳定步骤的 normalizer、候选定位器结构和会话恢复可见性。
- C：`LocatorScorer` 纯启发式实现、候选上限、唯一性检查、回退事件与报告。
- D：流程/断言 schema 版本化、旧快照默认值和 TS/Python parity。
- E：运行状态唯一事实来源、失败详情证据关联、成功/失败/刷新/重试/取消 E2E。

每个阶段完成后先运行对应门禁并记录输出，再进入下一阶段；发现契约、数据库或 fixture 设计需要改变时，暂停实现并更新任务设计文件。

## 验收标准

- `npm run build`、`npm run lint`、`npm run test:unit`、`npm run test:py` 通过。
- 按仓库支持的命令完成可重复启动：`npm install` → `npm run setup:py` → 配置 `.env` 中的非空 `PLATFORM_SECRET_KEY` → `npm run build` → `npm run start`，并通过 `/health` 或 `/ready` 检查；Windows 使用项目提供的 PowerShell 脚本，不得假设 Bash 命令可用。
- 本地 fixture 的 Playwright 流程证明：隔离测试账号登录 → 创建项目 → 创建或录制流程 → 保存/刷新 → 执行成功 → 查看结果；另有一个可控失败用例显示步骤、断言期望/实际和证据。测试必须可重复运行并清理临时数据。
- 旧流程快照回归通过；录制暂停/恢复/中断、自愈主定位成功/备用成功/全部失败、运行重试/取消均有测试。
- `.trellis/tasks/09-04-refactor-ui-auto-with-ntest/research/ntest-gap-matrix.md` 已生成，所有无法验证的参考项均有明确标记。
- 最终运行 `npm run test:all`；非 Windows 环境只能明确说明 `test:windows` 豁免，不得假报通过。
- 更新文档和必要规范，提交阶段性 commit，并在交付说明中列出已实现、未实现、已知限制、测试结果和回滚点。

## 明确不做

第一阶段不把数据驱动增强、环境切换增强、图表/HTML 导出、全量视觉重做、真实业务账号接入和外部 AI 自愈作为完成条件；这些内容另行规划。
