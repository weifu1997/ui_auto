# 收尾 Python 迁移与统一验证入口

## Goal

让新检出环境可以按 README 的单一路径初始化 Python 虚拟环境并运行 `server:py`、`test:py`、前端测试和 Playwright E2E；同时清理 Python 迁移任务记录、本地数据路径和 Trellis 状态漂移。

## Background

- `package.json:13`、`:14` 固定调用系统 `python`，与仓库已有的 `server-py/.venv-linux/`、`server-py/.venv/` 不一致。
- `playwright.config.ts` 的 `webServer` 通过 `npm run server:py` 启动，因此统一 `server:py` 可同时覆盖 Playwright。
- `server-py/autoflow/main.py:105` 默认数据目录依赖进程 CWD，从 `server-py/` 启动时会产生未跟踪的 `server-py/server/.data/`。

## Requirements

- R0.1 提供可重复的 Python 环境初始化命令，并让 `server:py`、`test:py`、Playwright `webServer` 使用同一解释器选择规则。
- R0.2 对照迁移 PRD 回填验收，运行可用的 smoke、E2E 和 Windows 部署门禁。
- R0.3 修正 Python 本地默认数据目录，并忽略已产生的 `server-py/server/.data/`、`server-py/server/.artifacts/`，不得删除现有生产或用户数据。
- R0.4 清理 Trellis 状态漂移：迁移任务验收完成后归档；`08-10-sauce-demo-platform-error` 确认不再代表未完成工作后归档。

## Acceptance Criteria

- [x] `npm run setup:py`、`npm run server:py`、`npm run test:py` 使用同一 Python 解析器；Playwright `webServer` 通过 `npm run server:py` 继承同一入口。
- [x] `npm run build`、`npm run lint`、`npm run test:unit`、`npm run test:py` 全绿（63 个 Python 单测通过）。
- [x] Python 默认数据目录以仓库根为锚点；从 `server-py/` 导入 `REPO_ROOT` 验证仍为仓库根。
- [x] `server-py/server/` 已加入忽略规则，git 不再显示该目录；原数据未被删除。
- [x] 迁移 PRD 验收项按真实结果回填，迁移任务已归档；Sauce Demo 活动副本已归档清理。

## Notes

- 不删除或改写现有 SQLite 数据。
- 不继续迁移尚未退役的 TS 服务代码。
- 本轮不修改前端业务行为。
- 沙箱限制：Playwright E2E 因 localhost 隔离在 webServer 等待阶段超时；Windows `test:windows` 需 Windows 运行器，未在本轮执行。
