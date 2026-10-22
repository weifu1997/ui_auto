# 第一阶段执行计划：核心可用闭环

## 开工前检查

- [ ] 用户确认本文件及 `design.md` 的最终规划摘要。
- [ ] 执行 `python3 ./.trellis/scripts/task.py start refactor-ui-auto-with-ntest`，确认任务进入 `in_progress`。
- [ ] 运行基线：`npm run build`、`npm run lint`、`npm run test:unit`、`npm run test:py`；记录结果，不修改无关任务。
- [ ] 读取 `trellis-before-dev` 指定的 backend/frontend 规范和 architecture-boundaries guide。

## 实施顺序

### A. 基线与启动可用性

- [ ] 盘点当前启动失败路径，补充 preflight/health 可测试接口或 CLI 输出。
- [ ] 校验密钥、静态目录、SQLite、Chromium 和 fixture；错误包含可执行修复提示。
- [ ] 增加 clean-install/production smoke，证明从构建到登录页可达。

门禁：`npm run build && npm run lint && npm run test:startup && npm run test:unit`。

### B. 录制结果整理

- [ ] 在不改变现有录制事件 kind/顺序的前提下，收敛事件到稳定 `FlowStep` schema。
- [ ] 为候选定位器定义结构化类型、评分/风险字段和数量上限。
- [ ] 覆盖暂停/恢复/停止、空结果、重复事件、歧义元素和重启后中断状态。

门禁：前端 unit + `npm run test:py`；新增录制 E2E fixture。

### C. 定位器候选与启发式自愈

- [ ] 抽出 `LocatorScorer` 接口和确定性实现，复用既有 locator fallback 事件语义。
- [ ] 仅对元素动作尝试候选，候选必须通过唯一性检查和总尝试上限。
- [ ] 将选择原因、候选和最终定位器写入事件/报告，并覆盖主定位器成功、备用成功、全部失败三种场景。

门禁：`npm run test:py`、runner/locator unit、fixture E2E。

### D. 统一流程/断言契约

- [ ] 对齐前端类型、后端契约、快照白名单、录制导入和报告转换。
- [ ] 明确 schema 版本、默认值和旧快照兼容读取；禁止 transient 字段改变 revision checksum。
- [ ] 补齐 TS/Python parity 和旧快照回归测试。

门禁：`npm run build && npm run lint && npm run test:unit && npm run test:py`。

### E. 可解释执行反馈

- [ ] 统一运行状态刷新和终态判定，确保页面不显示过期或自相矛盾状态。
- [ ] 失败详情关联步骤、断言期望/实际、事件和 artifact；重试/取消继续使用幂等键。
- [ ] 完成成功和失败两条 fixture E2E，验证刷新、重试和证据查看。

门禁：`npm run test:e2e`，最后运行 `npm run test:all`（非 Windows 环境说明 `test:windows` 豁免）。

## 最终验收

- [ ] PRD R7 五项硬目标均有代码、测试和可复现证据。
- [ ] 相关 build/lint/unit/py/e2e 门禁全绿；所有跳过项有原因。
- [ ] 更新 README/部署文档和必要 `.trellis/spec`，说明新增能力、限制和回滚点。
- [ ] 运行 `python3 ./.trellis/scripts/task.py validate refactor-ui-auto-with-ntest`。
- [ ] 提交阶段性 commit，随后执行 Trellis finish-work 流程。

## 风险与回滚点

| 风险 | 预防 | 回滚 |
| --- | --- | --- |
| 新 schema 破坏旧流程 | 先补 parity/旧快照测试，新增字段可选并有默认值 | revert 契约提交 |
| 自愈误操作错误元素 | `count() === 1`、评分阈值、候选上限、事件留痕 | 关闭 scorer 回退，保留主定位器 |
| 录制重构丢事件 | 保持事件 kind/seq，normalizer 做纯函数回归 | revert normalizer 提交 |
| 启动检查误伤开发环境 | 生产门禁与 fixture smoke 分层，保留显式 dev 例外 | revert preflight 提交 |
| 报告与运行状态不一致 | 服务端唯一事实来源，E2E 覆盖刷新/重试/取消 | revert UI 状态提交 |
