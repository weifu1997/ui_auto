# QA-01 实施清单

- [x] `vitest.config.ts`：启用 v8 覆盖率与基线阈值（lines/functions/statements 50%，
      branches 40%）。
- [x] `package.json`：新增 `test:coverage` 脚本与 `@vitest/coverage-v8` 依赖。
- [x] `.github/workflows/phase0-ci.yml`：quality-linux 增加覆盖率门禁；新增
      `security-scan` job（`npm audit --audit-level=high`、`pip-audit`、`bandit`）。

## 验证

- `package.json` / CI YAML 语法校验通过。
- 覆盖率阈值与安全扫描需在 CI（push/PR）上运行验证，未在本机伪造结果。
