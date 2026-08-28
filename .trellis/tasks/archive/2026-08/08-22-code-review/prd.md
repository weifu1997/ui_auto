# 代码审查

## Goal

审查整个项目代码库，输出可执行问题清单与验证建议。

## Background

- 当前工作区干净，当前分支为 `v3.2_flow_assertion`。
- 用户确认审查范围为整个项目代码库。
- 项目包含 React/TypeScript/Vite 前端（`src/`）、FastAPI/Python 平台服务（`server-py/`）、Node 启动与部署脚本（`scripts/`、`deployment/`）以及测试套件。

## Requirements

- 按项目规范审查代码质量、正确性、安全风险、测试覆盖和跨层一致性。
- 分层覆盖前端、Python 后端、脚本/部署配置和测试基础设施，不要求逐行审查生成物。
- 输出按严重程度分级的问题清单，每项包含文件锚点、证据、影响和建议修复方向。
- 对 CRITICAL/WARNING 结论先对照实际代码验证，降低 AI 审查误报率。
- 运行项目现有质量门禁，将结果作为审查证据；不因审查直接修复代码。

## Acceptance Criteria

- [x] PRD 明确记录最终审查范围与排除项。
- [x] 审查报告覆盖至少：正确性、安全性、可维护性、测试缺口和跨层一致性。
- [x] 审查报告覆盖 `src/`、`server-py/`、`scripts/`、`deployment/` 和测试配置。
- [x] 每个非信息级发现都有严重程度、文件/行号证据、影响说明和建议动作。
- [x] 报告区分确认问题、待验证风险和误报排除结论。
- [x] 记录已执行的质量门禁、结果摘要和未执行门禁的原因。

## Out of Scope

- 直接修改产品代码；除非用户在审查完成后另行批准。
- 审查 `dist/`、`node_modules/`、`.git/`、`.trellis/` 运行产物和本地数据库内容。
- 修复审查发现的问题、升级依赖或重构架构。

## Technical Notes

- 优先使用 `.trellis/spec/backend/index.md`、`.trellis/spec/frontend/index.md` 和 `.trellis/spec/guides/index.md` 作为项目规范基线。
- 建议质量门禁：`npm run lint`、`npm run build`、`npm run test:unit`、`npm run test:py`。E2E 和 Windows smoke 仅在需要验证具体风险时运行。

## Open Questions

- 无阻塞问题。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
