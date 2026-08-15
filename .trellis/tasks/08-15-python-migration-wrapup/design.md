# Design: Python Migration Wrapup

## Boundary

本任务只改 Python 启动/测试入口、Python 默认数据路径、README 和 Trellis 任务状态，不修改前端业务行为，不删除任何 SQLite 数据。

## Python Interpreter Resolution

新增 `scripts/python-env.mjs` 作为唯一解析入口：

1. 若设置 `AUTOFLOW_PYTHON`，直接使用该可执行文件。
2. 否则优先使用项目虚拟环境 `server-py/.venv/bin/python`（POSIX）或 `server-py/.venv/Scripts/python.exe`（Windows），且要求对应 `pip` 存在。
3. 否则回退到已有 `server-py/.venv-linux/bin/python`，仅用于当前工作区平滑迁移。
4. 最后回退到系统 `python`。

`scripts/run-py.mjs` 调用同一解析器并转发参数；`scripts/server-py.mjs` 使用同一解析器启动 uvicorn。若模块缺失，输出明确提示：运行 `npm run setup:py`。

## Setup Entry

新增 `scripts/setup-py.mjs`：

- 使用系统 `python3`/`python` 创建 `server-py/.venv`（若不存在），Debian/Ubuntu 需先安装 `python3-venv`。
- 当前工作区已有可用 `.venv-linux` 时优先复用，避免重复安装。
- 使用虚拟环境 Python 安装 `server-py/requirements.txt`。
- 安装 Playwright Chromium，供 E2E 和 ManagedRunner 使用；已存在浏览器缓存时跳过下载。
- 命令可重复执行，不覆盖已有数据库。

## npm Scripts

将 `package.json` 改为：

```json
"server:py": "node scripts/server-py.mjs",
"test:py": "node scripts/run-py.mjs -m pytest server-py/tests"
```

Playwright `webServer` 继续使用 `npm run server:py`，因此自动获得同一解释器规则。

## Data Directory

`server-py/autoflow/main.py` 的默认数据目录改为相对仓库根解析，而不是相对进程 CWD：

- 默认 `WORKER_DATA_DIRECTORY`：`<repo>/server/.data`
- 默认 `WORKER_ARTIFACT_DIRECTORY`：`<repo>/server/.artifacts`

环境变量仍可覆盖，适配现有部署和 Playwright 临时目录。

## Ignore and Data Safety

- `.gitignore` 增加 `server-py/server/.data` 和 `server-py/server/.artifacts`。
- 不删除 `server-py/server/.data` 中已有文件。
- 验证时只确认不再被 git 跟踪，不触碰生产库。

## Rollback

- `package.json`、`scripts/`、`main.py` 和 `.gitignore` 均为小范围可回滚文件。
- 回滚后旧脚本仍可用系统 Python；不涉及数据迁移。
