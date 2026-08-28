# AutoFlow Workbench

面向多项目隔离的 Web UI 自动化工作台。用户通过元素、动作和参数编排流程；浏览器执行由部署机上的 Platform ManagedRunner 调度。

## 安装与生产启动

```bash
npm install
npm run setup:py
cp .env.example .env
# Edit .env and set PLATFORM_SECRET_KEY
chmod 600 .env
npm run build
npm run start
```

> `npm run setup:py` 需要 [uv](https://docs.astral.sh/uv/) 已安装（CI 通过
> `astral-sh/setup-uv` 自动提供）。首次安装：
> `curl -LsSf https://astral.sh/uv/install.sh | sh`
> （Windows PowerShell：`irm https://astral.sh/uv/install.ps1 | iex`）。
> Python 依赖在 `server-py/pyproject.toml` 声明，由跨平台 `server-py/uv.lock` 精确锁定，
> `uv sync` 按锁安装。

`npm run start` 是唯一受支持的应用入口，需要 Node.js `>=20.12`。它会自动设置 `NODE_ENV=production`，检查 `dist/index.html` 和非空的 `PLATFORM_SECRET_KEY`（或可读且非空的 `PLATFORM_SECRET_KEY_FILE` 密钥文件；两者同时设置时直接环境变量优先），默认监听 `127.0.0.1:8787`。未构建或未设置密钥时，服务会在监听前失败并给出修复提示。

在 WSL/Linux 中，首次在仓库根目录创建受保护的 `.env`，然后填写至少一个
`PLATFORM_SECRET_KEY`：

```bash
# 编辑 .env，至少填写 PLATFORM_SECRET_KEY
chmod 600 .env
```

密钥也可以通过文件托管：设置 `PLATFORM_SECRET_KEY_FILE` 指向一个当前用户可读、非空的密钥文件，启动门禁会校验文件存在且内容非空。Windows 生产安装（`scripts/ops/install.ps1`）即采用该方式，密钥文件由管理员 ACL 保护，不再内联进服务配置；托管边界与恢复流程见 `docs/密钥托管与恢复.md`。

也可以通过 `AUTOFLOW_CONFIG_FILE` 指定相对于仓库根目录或绝对路径的配置文件：

```bash
AUTOFLOW_CONFIG_FILE=/srv/autoflow/production.env npm run start
```

指定的文件必须是当前用户拥有的普通文件，并且不能包含 group/other 权限；权限错误会提示再次执行 `chmod 600 <file>`。默认 `.env` 不存在时会继续使用继承的进程环境，显式的进程环境变量始终优先于文件值（即使继承值为空，也不会回退到文件）。`.env`、`.env.*` 已加入 Git 忽略，`.env.example` 不包含真实密钥。

局域网访问时显式设置 `AUTOFLOW_LISTEN_HOST=0.0.0.0`；端口可通过 `PORT` 覆盖。CORS 需要跨源访问时再设置 `AUTOFLOW_CORS_ORIGINS`。`npm run server` 仅作为兼容别名，仍执行相同的生产检查；`server:py` 是内部 Python 启动器，不作为部署命令。

## 验证

```bash
npm run build
npm run lint
npm run test:unit
npm run test:e2e
npm run test:py
npm run test:windows
npm run test:all    # 串联上述全部与 test:startup / check:bundle
```

Playwright 会使用构建后的 `dist/` 和 `npm run start`，不再启动 Vite dev 或 `VITE_AUTH_REQUIRED` 模拟服务。

## 仓库结构

```text
src/            React 前端：pages/ 路由页、stores/ Zustand 状态、api/ HTTP 边界、
                lib/ 纯工具与领域类型；单测与源码同目录
e2e/            Playwright 端到端用例
server-py/      Python FastAPI 后端：autoflow/handler/ 域路由包、
                autoflow/services/ 域服务包、tests/ 为 pytest
scripts/        生产入口与环境链（start-production.mjs、setup-py.mjs 等）
scripts/ops/    Windows 运维脚本（安装、备份、恢复、升级、回滚）
deployment/     Windows 服务定义（AutoFlow.xml）
data/           本地运行时数据（默认 SQLite 与 artifacts，已忽略；
                生产环境对应 %BASE%\data）
docs/           运维与决策文档（archive/ 保存历史版本）
.trellis/       编码规范与任务流
```

## Platform

Platform 提供登录、工作空间、集中式项目文档、流程版本、服务端密钥、ManagedRunner 运行、元素验证、录制、数据集、定时回归、通知和治理分析。运行与验证均在部署机上的 Chromium 执行，并通过 Platform API 返回状态、事件和产物。

生产服务只提供 Platform 路由。旧的 `/api/projects/*` legacy Worker API、local picker、Worker SSE 和前端 local fallback 已彻底移除；历史 Worker 数据不迁移。

部署形态与裁剪决策见 `docs/决策-内网部署形态与平台裁剪.md`。

## 数据与持续回归

- CSV 和 `.xlsx` 导入产生不可变 Dataset Version，不覆盖历史版本。
- Platform 运行可以引用 Dataset Version，并在运行快照中冻结数据集元数据和行数据。
- 密钥值只在服务端内存执行载荷中出现，不写入运行快照、事件、产物或通知内容。
- 定时任务和 Webhook 触发器要求已发布版本，并支持失败通知和投递记录。

## 当前能力

- 工作空间项目列表、搜索、新建、归档和项目级数据隔离。
- 项目概览、流程、元素库、变量、环境、运行中心、运行详情、模板库和项目设置。
- 三栏流程编辑器，包含步骤增删、排序、变量插入、草稿状态、保存和运行至当前步骤。
- Platform 元素验证、ManagedRunner 流程运行、取消、重试、运行事件、失败截图和 Trace。
- Platform 浏览器录制会话，支持暂停、恢复、停止和录制结果导入。
