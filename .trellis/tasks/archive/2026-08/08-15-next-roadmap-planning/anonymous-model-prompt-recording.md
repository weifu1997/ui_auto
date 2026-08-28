# 匿名模型实现评测 Prompt：流程录制 MVP

> 将本文件从标题下一行开始，原样发送给每个参评模型。四个模型必须收到完全相同的内容。

你是一名在现有代码库中自主工作的高级全栈工程师。请在当前 AutoFlow Workbench 仓库中完整实现“流程录制 MVP”。这是一项真实编码任务，不是方案讨论；你需要阅读仓库、修改代码、增加迁移或 API（若设计要求）、实现 UI、编写测试并实际运行验证。

本 Prompt 代表产品方已经明确批准以下现有计划，可以直接进入实现，不需要再询问是否开始：

- `.trellis/tasks/08-15-flow-recording-mvp/prd.md`
- `.trellis/tasks/08-15-flow-recording-mvp/design.md`
- `.trellis/tasks/08-15-flow-recording-mvp/implement.md`

## 工作规则

1. 先阅读根目录 `AGENTS.md`、前后端 spec 索引和上述三份计划，再检查实际代码。计划中的行号只是调查时证据，必须以当前代码为准。
2. 本评测模式覆盖常规 Trellis 状态流程：把三份计划作为只读、已批准规格，但不要运行 `task.py start/finish/archive`，不要修改 `.trellis/**`、spec、journal 或任务状态；只修改产品代码、测试和必要的产品文档。
3. 自主完成工作，不等待人工确认。遇到实现细节不明确时，选择与计划、既有代码和最小可靠 MVP 最一致的方案，并在最终报告中说明。
4. 不得删除、跳过、放宽或改写已有测试来掩盖失败。不得回滚与本任务无关的已有工作区修改。
5. 不得提交真实账号、密码、token、浏览器 profile、本地 SQLite 数据、截图产物或依赖缓存。
6. 不依赖外部网站完成验收。浏览器闭环必须使用仓库内可重复启动的本地 fixture。
7. 不引入 Chrome Extension、跨设备 CDP 或新的浏览器自动化框架；复用现有 Python Playwright 和 Picker 基础。
8. 不提交或推送 Git commit，除非评测环境另有明确要求。保留完整工作区 diff 供评测。

## 必须实现的用户结果

测试人员在流程编辑器中可以：

1. 选择环境和起始 URL，启动部署机上的有头 Chromium。
2. 录制打开页面、点击、填写、清空、下拉选择、勾选和有意义的按键。
3. 暂停、继续、停止或取消录制，并看到状态和已录制步骤数。
4. 停止后检查步骤、元素定位器、warning 和敏感变量绑定。
5. 确认后把步骤一次性追加到流程末尾，创建或复用元素草稿；流程进入 dirty，仍由用户执行现有保存。
6. 保存后的流程可以由现有执行器成功重放。

## 不可妥协的技术契约

### 录制与事件

- 连续字符输入必须归并为一个填写步骤，不能逐字符生成步骤。
- select、checkbox/radio 必须生成对应动作，不能再重复生成普通点击。
- 点击触发的导航保留点击，不额外生成重复打开页面；直接地址导航生成打开页面。
- 事件使用单调递增 `seq`，增量读取和请求重试不得让前端重复追加步骤。
- 完整导航后注入脚本继续有效。
- iframe、多标签页、popup、上传、拖拽、下载、Shadow DOM 和 contenteditable 在 MVP 中不实现，但必须产生明确 warning，不能静默伪造成功步骤。

### 定位器与元素

- 复用现有 Picker 候选和执行器契约；role 候选必须包含 accessible name。
- 导入前验证候选唯一性。
- 按 `environmentId + path + method + value` 复用现有元素，否则生成项目内唯一名称的新元素草稿。
- 步骤引用现有 ElementAsset，不在步骤里私自保存 selector。
- 取消录制或取消确认不能留下元素或步骤。

### 安全

- `input[type=password]` 和 name/id/label/autocomplete 命中 password、secret、token、API key、credential 的字段，在页面脚本层就不得发送真实值。
- 服务端再次执行敏感判定。API、异常日志、审计、前端 state、localStorage/sessionStorage 和 revision 中都不能出现敏感明文。
- 敏感填写必须在确认导入前绑定项目现有 `secret: true` 变量，生成既有 `{{scope.name}}` 引用；未绑定时不能导入。
- 录制 API 必须使用现有平台 session、项目归属和 `flow.edit` 能力检查；不得通过扩大 legacy `/api/projects/*` Worker 路由的网络暴露来实现。
- 起始 URL 只允许 HTTP/HTTPS，并拒绝 userinfo 等不安全输入。

### 生命周期与兼容

- 状态至少覆盖 recording、paused、stopped、canceled、expired、failed。
- stop/cancel 必须幂等；浏览器关闭、取消、超时和服务停止要释放 page/context/browser。
- 同一用户、项目、环境最多一个活动会话；事件/步骤有合理上限。
- 原始事件和未确认结果只保存在内存；不要增加录制事件数据库表。
- MVP 尽量不修改持久 FlowStep/ElementAsset 契约。若确有必要，必须同步前后端 canonical revision snapshot 并证明兼容。
- 现有 Picker、元素验证、手工流程编辑、同步、revision 和单流程运行必须保持可用。

## 最低测试要求

至少新增并实际运行：

1. Recorder 纯单测：输入归并、点击导航去重、select/check、seq、pause/resume、敏感判定和 unsupported warning。
2. API 测试：认证、权限、跨项目、URL、状态机、幂等 stop/cancel、资源释放和响应脱敏。
3. 真实 Chromium 本地 fixture：普通输入、password、点击导航、直接导航或 SPA route、select、checkbox、iframe warning。
4. 前端测试：轮询 seq 去重、敏感绑定阻断、确认原子导入、取消无副作用和错误状态。
5. 端到端闭环：录制本地页面 → review → 导入 → 保存 → 现有 ManagedRunner 重放成功。
6. 回归命令：

```bash
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
npm run test:windows
```

收尾应运行 `npm run test:all`。如果环境客观无法运行某项，保留失败输出并准确说明，不得声称通过。

## 实施顺序

严格按计划中的阶段关卡推进：

1. 本地 fixture 和技术验证。
2. 共享 Picker/Recorder 浏览器生命周期与 RecorderNormalizer。
3. 带平台认证的 recording API。
4. 编辑器录制控制、review 和原子导入。
5. 端到端重放、安全检查和全量回归。

优先交付正确、可测试的纵向闭环。不要先堆完整 UI，再用假的录制数据或未接通的接口模拟完成。

## 最终交付格式

完成后只基于实际结果提交报告，包含：

- 实现摘要及关键设计选择。
- 修改文件清单。
- 逐条对应验收标准的证据。
- 实际运行的命令及通过/失败数量。
- 未完成项、已知限制和残余风险。
- `git diff --stat` 和 `git status --short` 摘要。

不要在功能未闭环或测试未运行时宣称“完成”。
