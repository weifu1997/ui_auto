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

`npm run start` 是唯一受支持的应用入口，需要 Node.js `>=20.12`。它会自动设置 `NODE_ENV=production`，检查 `dist/index.html` 和非空的 `PLATFORM_SECRET_KEY`，默认监听 `127.0.0.1:8787`。未构建或未设置密钥时，服务会在监听前失败并给出修复提示。

在 WSL/Linux 中，首次在仓库根目录创建受保护的 `.env`，然后填写至少一个
`PLATFORM_SECRET_KEY`：

```bash
# 编辑 .env，至少填写 PLATFORM_SECRET_KEY
chmod 600 .env
```

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
```

Playwright 会使用构建后的 `dist/` 和 `npm run start`，不再启动 Vite dev 或 `VITE_AUTH_REQUIRED` 模拟服务。

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
