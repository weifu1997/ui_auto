# 代码审查执行计划

## Checklist

1. 加载前后端规范和跨层思考指南。
2. 盘点源码结构、测试矩阵、配置和部署入口。
3. 审查前端：API 类型边界、状态同步、hooks、组件行为和无障碍/反馈。
4. 审查后端：认证、RBAC、workspace/project 隔离、持久化事务、输入校验、secret 和审计。
5. 审查脚本/部署：启动环境、进程生命周期、路径处理、平台差异和失败恢复。
6. 审查测试与 CI：覆盖缺口、断言强度、脆弱依赖和生产门禁。
7. 运行 lint、build、unit 和 Python 测试。
8. 验证所有 CRITICAL/WARNING 发现并排除误报。
9. 输出分级审查报告与修复优先级。

## Commands

```bash
npm run lint
npm run build
npm run test:unit
npm run test:py
```

## Risk Points

- 安全敏感区域集中在认证、成员邀请、secret 操作、runner 调度和 workspace/project 解析。
- SQLite WAL 文件和本地 `.env` 不应纳入公开审查摘录；只记录模式级结论，不复制真实值。
- E2E 可能受本机服务状态影响，先以静态审查和单元/集成测试为主。

## Rollback

审查任务只新增 `.trellis/tasks/08-22-code-review/` 内的规划与报告产物。若中止，删除该任务目录即可，不影响产品代码。
