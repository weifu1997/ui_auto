# 仅生产模式与统一生产启动入口

## Goal

让 AutoFlow 只以 Platform 产品形态运行，并以 `npm run build`、`npm run start` 提供可重复、跨 shell 的生产启动路径。用户不应再需要手动设置 `NODE_ENV`，也不应因 Vite dev 与生产构建采用不同的产品分支而看到不同页面。

## Background

- 当前 `package.json` 的 `start` 与 `server` 都只是 `server:py` 的别名；`scripts/server-py.mjs` 直接继承环境，不能保证生产配置。
- Python 服务仅在 `NODE_ENV=production` 或 `AUTOFLOW_ENABLE_STATIC=1` 时托管 `dist/`，并且仅在 `NODE_ENV=production` 时拒绝缺少 `PLATFORM_SECRET_KEY` 的启动（`server-py/autoflow/main.py:183`、`server-py/autoflow/services.py:426`）。
- 前端把 Vite 构建模式 `import.meta.env.PROD` 当作产品模式，并用 `VITE_AUTH_REQUIRED=1` 在 Vite dev 下模拟部分生产 UI。这会造成认证和导航为生产形态、种子数据和持久化仍为开发形态的混合状态（例如 `src/App.tsx:161`、`src/workspace-store.ts:156`）。
- `README.md:74` 和部署决策文档宣称 legacy Worker API (`/api/projects/*`) 仅对 loopback 启用；当前 Python `create_app` 却无条件挂载 legacy Worker router（`server-py/autoflow/main.py:116`），与该安全边界不一致。

## Requirements

### R1. 统一生产启动入口

- `npm run build` 继续产出前端 `dist/`。
- `npm run start` 必须成为唯一受支持的应用启动入口，并在同一 Node 进程内自动设置 `NODE_ENV=production` 后启动 Python 服务，避免要求 Windows、PowerShell 或 POSIX 用户手动设置该变量。
- `npm run start` 必须在监听前检查可用的生产构建产物（至少 `dist/index.html`）和非空的 `PLATFORM_SECRET_KEY`；失败时给出明确的修复命令，不启动服务。
- 默认监听 `127.0.0.1:8787`。只有显式设置 `AUTOFLOW_LISTEN_HOST=0.0.0.0` 或其他地址时才暴露到网络；`PORT` 仍可覆盖默认端口。
- 保留的脚本别名和安装/部署脚本不得绕过上述生产启动检查。

### R2. 单一 Platform 产品形态

- 生产构建和本地运行的应用 UI 都固定使用 Platform 功能集：登录与服务端 workspace、Platform 导航、平台运行与远程调试均不再依赖 Vite 的 `PROD` 或 `VITE_AUTH_REQUIRED` 条件。
- 删除只为 Local Worker 产品形态存在的前端可达路径、localStorage 种子数据和 fallback 行为；前端 API 失败必须显示或传播 Platform 错误，不能回退到本地 Worker。
- 不再支持 `VITE_AUTH_REQUIRED` 作为产品模式切换开关。

### R3. Legacy Worker API 隔离

- `/api/projects/*` legacy Worker API 从生产运行时彻底移除，不保留兼容开关，且其路由不得被生产 UI 使用。
- Local Worker 的任务、SSE、artifact、validation、local picker 和前端 fallback 分支一并删除；仍属于 Platform 产品的录制能力必须迁移到独立的 Platform 服务边界，而不能继续通过 Worker router 暴露。
- README、部署文档和测试必须明确 legacy Worker 不再是受支持的运行路径；历史 Worker 数据不迁移，Platform 数据与 API 合同保持不变。

### R4. 测试与文档收敛

- 前端单测、Python 单测和 Playwright 生产场景必须只验证统一 Platform 产品行为。
- Playwright 的生产认证场景必须使用构建后的 `dist/` 和 `npm run start`，不再通过 Vite dev + `VITE_AUTH_REQUIRED=1` 模拟生产。
- 移除或迁移只覆盖 Local Worker 产品分支的测试；保留有价值的协议兼容测试时，应明确其不属于受支持的产品运行路径。
- 更新 README、部署决策与安装/服务脚本，使最短生产流程为 `npm run build` 后设置一次 `PLATFORM_SECRET_KEY` 再执行 `npm run start`。

## Out of Scope

- 改变 Platform 数据模型、认证协议、ManagedRunner 的运行语义或现有部署数据库。
- 引入新的进程管理器、容器化方案或多机 Agent 执行模式。
- 自动生成、持久化或轮换 `PLATFORM_SECRET_KEY`；启动入口只校验由部署者提供的密钥。

## Acceptance Criteria

- [x] 未构建时执行 `npm run start` 会失败，并指出先执行 `npm run build`。
- [x] 未设置 `PLATFORM_SECRET_KEY` 时执行 `npm run start` 会失败，不会启动 HTTP 监听。
- [x] 设置密钥后，`npm run start` 无需额外环境变量即可在 `127.0.0.1:8787` 提供构建后的 SPA、`/health` 和 Platform API。
- [x] 仅在显式设置 `AUTOFLOW_LISTEN_HOST` 时，服务监听地址才改变；`PORT` 覆盖仍有效。
- [x] 用相同的持久化状态分别访问开发服务和构建后服务时，认证、导航、workspace 和运行操作均走相同的 Platform 产品路径，不再因 `PROD`、`VITE_AUTH_REQUIRED` 或 Local Worker fallback 改变。
- [x] 默认生产服务访问 legacy Worker URL 不会执行 legacy Worker 行为；行为与确定后的兼容策略及文档一致。
- [x] 生产 E2E 通过 `npm run build` + `npm run start` 执行；相关单测、Python 测试、Playwright 测试和脚本文档验证通过。

## Key Decisions

- 采用“仅生产 Platform 产品”作为唯一产品行为；Vite dev 只保留为可选的构建/HMR 工具，不再模拟另一套产品模式。
- `npm run start` 是唯一受支持的应用启动入口，默认 loopback，密钥由部署者提供。
- 彻底删除 legacy Worker 运行时及其前端 fallback，不保留兼容开关；旧 Worker 数据不迁移。
