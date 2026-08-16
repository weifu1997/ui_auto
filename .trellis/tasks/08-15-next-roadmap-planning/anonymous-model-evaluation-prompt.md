# 匿名模型长任务能力评测 Prompt：流程批量执行 + 流程录制

你是一名在现有代码库中自主工作的高级全栈工程师。请在 AutoFlow Workbench 中完整实现两个已经批准的需求：

1. 流程批量执行 MVP。
2. 流程录制 MVP。

这是一项真实、长周期、跨前后端的编码任务，用于评测你持续理解代码库、制定实施顺序、完成跨层设计、调试失败、控制回归并最终交付可运行功能的能力。不要只输出分析或计划；你必须实际修改代码、迁移、API、前端和测试，并持续工作到验收闭环完成，或遇到只有外部环境/权限才能解除的真实阻塞。

## 权威规格

以下六份文档是已经批准且具有约束力的产品与技术规格：

- `.trellis/tasks/08-15-flow-batch-execution-mvp/prd.md`
- `.trellis/tasks/08-15-flow-batch-execution-mvp/design.md`
- `.trellis/tasks/08-15-flow-batch-execution-mvp/implement.md`
- `.trellis/tasks/08-15-flow-recording-mvp/prd.md`
- `.trellis/tasks/08-15-flow-recording-mvp/design.md`
- `.trellis/tasks/08-15-flow-recording-mvp/implement.md`

先阅读根目录 `AGENTS.md`、前后端 spec 索引、上述六份计划和实际代码。计划中的文件行号是调研时证据，不是静态真相；以当前仓库代码为准。如果计划与当前代码存在实现层面的偏差，在不改变用户结果、安全边界和验收标准的前提下采用最稳妥的兼容方案，并在最终报告说明。

本 Prompt 是明确的实施授权，不需要再次询问是否开始。评测模式覆盖常规 Trellis 状态流程：把 `.trellis` 中的计划作为只读规格，不运行 `task.py start/finish/archive`，不修改 `.trellis/**`、spec、journal 或任务状态。只修改产品代码、测试和必要的产品文档。

## 自主工作要求

- 自主检查代码、依赖、数据模型、API、状态管理、测试和运行环境，不等待人工逐步指导。
- 你可以自由使用评测环境提供的任何工具，包括搜索、终端、测试框架、浏览器自动化、调试器、静态分析、子代理或并行代理；根据任务需要自行决定。
- 不限制工作时长、Token、费用、工具种类、工具调用次数或代理数量。不要为了缩短任务而省略必要实现与验证。
- 可以并行处理相互独立的研究、实现或审查，但要由主任务统一合并、解决冲突并完成最终验证。
- 测试失败时阅读完整错误、定位根因、修复并重跑。不要在第一次失败后停止，也不要把尚可自行解决的问题交回用户。
- 不得删除、跳过、放宽或改写已有测试来掩盖失败，不得用 mock UI、硬编码响应或仅内存演示冒充完整功能。
- 不得回滚与本任务无关的已有修改。若工作区存在相关改动，先理解并在其基础上工作。
- 不提交或推送 Git commit，保留完整工作区 diff 供统一评测。
- 不提交真实账号、密码、token、本地 SQLite 数据、浏览器 profile、依赖缓存、运行产物或无关生成文件。
- 所有自动化验收使用仓库内可重复运行的本地 fixture，不依赖外部网站或真实账号。

## 实施顺序与阶段关卡

按以下顺序推进。每个阶段只有在代码完成、关联测试通过且没有已知正确性缺口后才能进入下一阶段。

### 阶段 1：基线与单流程正确性

1. 运行并记录当前 build、lint、前端单测和 Python 测试基线。
2. 修复当前单流程运行可能选择项目最新任意 revision 的问题。
3. 单流程列表和编辑器“运行到此步骤”必须运行用户选择的 flow revision。
4. 增加流程 A/B 回归：无论最后保存顺序如何，运行 A/B 都得到各自 snapshot。

### 阶段 2：批量执行后端闭环

1. 增加向前兼容、可重复执行的 `run_batches` migration 和 child run 关联。
2. 抽取可在外部事务中复用的 run spec 解析与插入逻辑，保持单运行、dataset、schedule 和 webhook 兼容。
3. 实现同项目 2-20 个不同流程、同一环境、每 flow 一条 run 的批次创建。
4. 创建前完成所有 revision、环境、步骤、Chromium、secret、数量和总步骤预检；任一失败必须零写入。
5. Batch、所有 child runs 和 queued events 在同一个 `BEGIN IMMEDIATE` 事务内写入，提交后才 enqueue。
6. 使用 `(project_id, client_request_id)` 数据库唯一约束实现持久幂等；覆盖相同 key 相同 payload、不同 payload和并发重复请求。
7. Batch 状态从 child runs 聚合，支持 queued、running、success、partial_failed、failed、canceled 及完整 counts。
8. 保持 ManagedRunner 单并发 FIFO；一个 child 失败不能阻断后续 child。
9. 实现分页列表、详情、幂等取消和只重试 failed/canceled 项；重试创建新 batch 并使用当前最新 revision。
10. 覆盖取消与运行完成竞态、服务重启恢复 queued runs、历史孤立 run 兼容和审计安全。

### 阶段 3：批量执行前端与端到端

1. FlowsPage 增加表格多选和批量操作，保留单行运行。
2. 确认界面显示环境、流程、总步骤、串行执行和通知提示。
3. 用户一次操作使用稳定 clientRequestId；网络重试不得重复执行。
4. RunsPage 基于服务端分页展示 batch 汇总、子 run、取消和重试失败项，并保留孤立 run。
5. 刷新页面和重启服务后从服务端恢复，不依赖 localStorage 作为 batch 真相。
6. 完成全成功、部分失败后继续、取消、重试、重复提交和刷新恢复 E2E。

### 阶段 4：录制技术闭环

1. 建立本地浏览器 fixture，覆盖普通输入、password、点击导航、直接导航或 SPA route、select、checkbox 和 iframe warning。
2. 在现有 Python Playwright 与 Picker 基础上证明连续捕获 click、fill、navigation。
3. 实现后端 RecorderNormalizer：连续输入归并、select/check 语义映射、点击导航去重、直接导航、按键、pause/resume、stop flush、单调 seq 和 unsupported warning。
4. 完整导航后注入继续有效；相同 afterSeq 重读不会产生重复逻辑步骤。
5. role locator 包含 accessible name，候选验证唯一性；元素按环境、路径、方法和值复用，否则生成项目内唯一名称。
6. 生成的步骤与元素不改变现有执行契约，并能由 ManagedRunner 重放。
7. `input[type=password]` 和疑似 password/secret/token/API key/credential 字段的真实值在页面脚本层就不得发送，服务端再次判定。
8. 使用独特本地测试 canary 检查 API、日志、前端 state、storage、SQLite、审计、revision 和 diff，确认敏感明文没有泄漏。

录制技术闭环未证明真实浏览器连续捕获、敏感值不泄漏和保存后可重放时，不要用完整 UI 掩盖内核缺陷。

### 阶段 5：录制 API、编辑器与端到端

1. 实现带平台 session、项目归属和 `flow.edit` 能力检查的 recording API，不扩大 legacy `/api/projects/*` Worker 路由暴露。
2. 校验 flow、environment、HTTP/HTTPS URL 和会话 owner；API、日志和审计只暴露安全 URL。
3. 会话覆盖 recording、paused、stopped、canceled、expired、failed；stop/cancel 幂等。
4. 同一用户、项目、环境最多一个活动会话；事件和步骤有合理上限。
5. 取消、超时、浏览器关闭和服务停止释放 page/context/browser。
6. 流程编辑器实现开始、暂停/继续、停止、取消、状态和步骤计数。
7. Stop 后 review 步骤、元素处置、warning 和敏感变量绑定；未绑定 secret variable 或定位器不唯一时不能导入。
8. 确认后一次性追加步骤并创建/复用元素草稿，流程进入 dirty；取消录制或取消 review 必须零副作用。
9. 用户仍通过现有保存链路同步并发布 revision；完成录制、review、导入、保存、ManagedRunner 重放的真实本地 E2E。
10. iframe、多标签页、popup、上传、拖拽、下载、Shadow DOM 和 contenteditable 不在 MVP 中实现，但必须明确 warning，不能生成假成功步骤。

### 阶段 6：集成回归与收尾

1. 联合检查两项需求对 `handler.py`、`services.py`、`platform-api.ts`、FlowsPage、RunsPage、FlowEditorPage、运行历史分页和 revision snapshot 的交叉影响。
2. 回归现有 Picker、元素验证、手工流程编辑、单运行、dataset、schedule、webhook、通知、运行详情、同步 outbox 和 canonical revision。
3. 扫描敏感信息、测试篡改、临时文件、数据库、浏览器 profile 和无关产物。
4. 完成必要的产品文档，说明批量串行语义、上限、部分失败、录制支持动作、非支持动作、敏感变量绑定和会话回收。
5. 运行全部质量门禁，直到通过或确认存在无法由代码解决的外部环境阻塞。

## 不可妥协的正确性与安全契约

### 批量执行

- 不得用前端 `Promise.all` 循环单运行 API，也不得只在前端或内存中保存 batch。
- 不得按项目最新任意 revision 猜测流程。
- 任一预检失败不得留下部分 batch/run。
- 幂等必须由数据库约束兜底，不能只靠禁用按钮。
- 首版是批量提交和串行执行，不是不受控并行。
- Batch 状态不能成为与 child runs 双写、可能漂移的第二真相。
- 取消竞态不能覆盖已完成 child 状态。
- API 必须执行认证、项目隔离和 `run.execute` 检查，响应和审计不得泄漏执行 snapshot 或 secret。

### 流程录制

- 密码或 secret 的真实值不得离开页面，不得进入 API、日志、store、storage、SQLite、审计、revision 或 diff。
- 录制 API 必须认证并隔离项目，不能扩大 legacy Worker API 的网络暴露。
- 连续字符不能生成逐字符步骤；select/check 不能重复生成 click；点击导航不能重复生成 open。
- 取消录制和取消 review 不得写入流程或元素。
- 录制产物必须通过现有保存和执行链路真实重放。
- 不支持行为必须警告，不能静默生成错误步骤。

## 测试与验证要求

根据改动持续运行精确测试；最终必须实际运行：

```bash
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
npm run test:windows
npm run test:all
```

测试至少覆盖六份权威规格中的所有 Acceptance Criteria，尤其包括：

- revision A/B 正确性。
- migration 升级与重复执行。
- Batch 原子回滚、并发幂等、状态聚合、取消竞态、最新 revision 重试和重启恢复。
- Batch UI、分页、刷新恢复和孤立 run。
- Recorder 输入归并、导航因果、seq 去重、暂停继续、定位器唯一性和 unsupported warning。
- 录制认证、跨项目、URL、生命周期、资源释放和 stop/cancel 幂等。
- 密码 canary 全链路零泄漏。
- 真实 Chromium 录制、导入、保存和 ManagedRunner 重放闭环。
- 两项功能与所有既有关键路径的联合回归。

如果某条命令因操作系统、浏览器安装、网络隔离或权限等外部条件无法运行，保留完整错误，验证能验证的其余部分，并在最终报告准确区分“代码失败”和“环境未验证”。不得把未运行写成通过。

## 完成标准

只有同时满足以下条件才可以宣称任务完成：

1. 两个需求的 PRD Acceptance Criteria 均有可运行实现和测试证据。
2. 前后端、数据库、浏览器和 UI 形成真实纵向闭环，不存在 mock 替代路径。
3. 所有可运行质量门禁通过，没有通过删除测试或降低断言制造绿色。
4. 没有已知权限、跨项目、敏感数据、事务、幂等或竞态缺陷。
5. 没有回归现有核心功能，没有遗留临时数据或无关改动。
6. 对任何无法验证项提供真实阻塞证据和残余风险，而不是笼统说明。

不要因为任务耗时长、上下文多或测试失败次数多而提前结束。持续使用可用工具定位和解决问题，直到上述完成标准满足或出现只有外部输入才能解除的真实阻塞。

## 最终交付报告

最终回复必须简明但可审计，包含：

1. 两项需求的实现摘要和关键设计选择。
2. 数据库 migration、API、状态机和安全边界说明。
3. 修改文件清单或按模块归类的 diff 摘要。
4. 两份 PRD 每条 Acceptance Criteria 的实现与测试证据。
5. 实际运行的每条命令、通过/失败数量和失败原因。
6. 遇到的重要缺陷、调试过程和最终处理。
7. 未完成项、无法验证项、已知限制和残余风险。
8. `git diff --stat` 与 `git status --short` 摘要。

只报告实际完成、实际运行和实际观察到的结果。不要在任一需求仍是半成品时声称整体完成。
