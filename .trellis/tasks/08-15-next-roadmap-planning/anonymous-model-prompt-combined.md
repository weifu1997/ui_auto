# 匿名模型联合实现评测 Prompt：流程录制 + 批量执行

> 联合评测适合考察长程执行。短时限会受到实施顺序影响；公平比较仍要求四个模型收到完全相同的 Prompt、仓库基线、时限和权限。

你是一名在现有代码库中自主工作的高级全栈工程师。请在 AutoFlow Workbench 中完整实现两个已经批准的需求：流程批量执行 MVP 和流程录制 MVP。你需要实际修改产品代码和测试并运行验证，不要只输出计划。

## 批准的规格

完整且具有约束力的规格位于：

- `.trellis/tasks/08-15-flow-batch-execution-mvp/prd.md`
- `.trellis/tasks/08-15-flow-batch-execution-mvp/design.md`
- `.trellis/tasks/08-15-flow-batch-execution-mvp/implement.md`
- `.trellis/tasks/08-15-flow-recording-mvp/prd.md`
- `.trellis/tasks/08-15-flow-recording-mvp/design.md`
- `.trellis/tasks/08-15-flow-recording-mvp/implement.md`

本 Prompt 是对上述最终计划的明确实施批准。先阅读 `AGENTS.md`、Trellis workflow、前后端 spec 和实际代码，然后依次启动并完成相应子任务，不需要再次询问是否开始。

## 固定实施顺序

1. 批量执行 Phase 0：修复单流程 revision 选择错误。
2. 完成批量执行的持久 batch、原子幂等创建、聚合、取消、失败项重试、FlowsPage、RunsPage 和 E2E。
3. 完成录制 PoC：本地 fixture、click/fill/navigation、敏感值不离开页面、生成步骤可重放。
4. 完成带认证录制 API、事件归并、定位器/元素复用、编辑器 review/原子导入和 E2E。
5. 运行全量回归并如实报告。

不得在批量实现中使用前端循环单运行 API，不得引入不受控并行；不得在录制实现中扩大 legacy Worker API 暴露，不得让敏感输入离开页面或进入持久状态。

## 工程纪律

- 四个模型会在相同独立仓库副本中接受盲测。不要依赖其他模型、共享目录或未提交的外部产物。
- 不删除、跳过或放宽测试，不回滚无关修改，不提交 secret、本地数据库、浏览器 profile 或运行产物。
- 使用本地 fixture，不依赖外部网站。
- 复用现有 FastAPI、SQLite、Python Playwright、React、Ant Design、Zustand 和测试体系。
- 不提交或推送 Git commit，保留 diff 供评测。
- 若时间不足，保持仓库可构建并优先完成可靠纵向闭环；最终明确列出未完成项，不得用 mock UI 声称功能完成。

## 必跑验证

```bash
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
npm run test:windows
```

收尾运行 `npm run test:all`。环境无法执行时保留失败证据并报告。

## 最终报告

报告实现摘要、关键设计、修改文件、两项需求各验收标准证据、命令与结果、未完成项和风险，以及 `git diff --stat`、`git status --short` 摘要。只报告实际完成和实际运行结果。
