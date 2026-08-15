# Implementation Plan: Python Migration Wrapup

## Order

1. 新增 `scripts/python-env.mjs`、`scripts/run-py.mjs`、`scripts/server-py.mjs`、`scripts/setup-py.mjs`。
2. 更新 `package.json` 的 `setup:py`、`server:py`、`test:py`。
3. 修正 `server-py/autoflow/main.py` 默认数据目录。
4. 更新 `.gitignore` 忽略 `server-py/server/.data` 与 `.artifacts`。
5. 更新 README 为单一 Python 初始化路径。
6. 运行验证命令并记录结果。
7. 对照迁移 PRD 回填验收；确认后归档迁移任务与已完成的 Sauce Demo 活动副本。

## Validation Commands

```bash
npm run setup:py
npm run build
npm run lint
npm run test:unit
npm run test:py
npm run test:e2e
python -m pytest server-py/tests/smoke
```

若 Windows 可用，补跑 `npm run test:windows`。

## Review Gates

- `server:py`、`test:py`、Playwright `webServer` 使用同一解析器。
- 从 `server-py/` 启动服务不会重新生成 `server-py/server/.data`。
- `git status` 不显示 `server-py/server/`。
- README 不保留依赖私有虚拟环境的启动说明。

## Rollback Points

- 每个文件提交前可单独回滚。
- 不删除任何 `server-py/server/.data` 或生产 SQLite 文件。
- 若 Playwright 或部署脚本异常，先回退 `package.json` 与 `main.py`，再排查环境。
