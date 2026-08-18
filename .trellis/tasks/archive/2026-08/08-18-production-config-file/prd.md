# 生产配置文件启动支持

## Goal

让 npm run start 从受保护的 dotenv 风格配置文件加载生产环境变量，主要面向 WSL Ubuntu。

## Confirmed Facts

- `scripts/start-production.mjs` 当前只从继承的进程环境读取
  `PLATFORM_SECRET_KEY`，然后强制 `NODE_ENV=production` 并启动 Python
  服务。
- 仓库尚无 dotenv 依赖、`.env` 文件约定或配置文件加载器；`.gitignore`
  也尚未排除 `.env`。
- `PLATFORM_SECRET_KEY` 是稳定的 AES-256-GCM 根密钥。缺失时生产启动器
  必须在监听前失败，且不能自动生成或轮换密钥。
- Windows 服务通过 `deployment/AutoFlow.xml` 的环境变量持久化密钥；本
  任务面向 WSL Ubuntu 的命令行/服务运行。

## Requirements

- R1. `npm run start` 支持从 dotenv 风格的文本配置读取
  `PLATFORM_SECRET_KEY` 和现有运行时环境变量，无需每次手动 `export`。
- R2. 启动器必须在读取密钥文件前执行明确的路径和文件权限检查，失败时
  不启动监听，并给出可操作的修复信息。
- R3. 外部环境变量与配置文件的优先级、默认文件位置、指定文件方式和
  dotenv 语法范围必须固定并测试。
- R4. 更新 `.gitignore`、README、启动器测试和后端生产启动契约；不得
  把真实密钥提交到仓库。
- R5. 正式启动运行时要求 Node `>=20.12`，使用原生 `node:util`
  `parseEnv` 解析 dotenv 语法，不新增第三方 dotenv 依赖。

## Acceptance Criteria

- [x] 在 WSL Ubuntu 的受保护配置文件中写入 `PLATFORM_SECRET_KEY` 后，
  不设置 shell 环境变量也能执行 `npm run start`。
- [x] 缺失、空白、路径非法或权限不符合要求的配置文件会在监听前失败，
  且不会回退到自动生成密钥。
- [x] 配置文件、显式环境变量以及指定配置路径的优先级可通过启动器单测
  验证。
- [x] 现有 `npm run build`、`npm run start`、Windows 服务模板和生产 E2E
  契约保持可用。

## Confirmed Configuration Contract

- 默认读取仓库根目录 `.env`；默认文件不存在不是错误，启动器继续从继承
  环境读取配置。
- `AUTOFLOW_CONFIG_FILE` 可指定相对于仓库根目录或绝对路径的替代文件。
  一旦显式指定，文件不存在、不是普通文件或不可读取都必须失败。
- 继承的 shell/服务环境变量优先于文件值，文件只补齐缺失的值。
- 在 WSL/Linux，读取的配置文件必须由当前用户拥有、是普通文件，且
  `mode & 0o077 == 0`（如 `chmod 600 .env`）；否则生产启动器拒绝启动。
- 未从任意来源得到非空 `PLATFORM_SECRET_KEY` 时，保留当前的启动前拒绝
  行为。

## Out of Scope

- 自动生成、持久化或轮换 `PLATFORM_SECRET_KEY`。
- 将真实密钥纳入 Git、前端构建产物或浏览器可见配置。
- 修改 Windows 服务 XML 已有的环境变量注入方式。

## Technical Notes

- 当前 WSL Ubuntu 使用 Node `v24.19.0`；`parseEnv` 已验证支持带引号值和
  行内注释的 dotenv 文件。
- 对低于 `20.12` 的 Node，启动器必须在读取或启动服务前给出明确版本错误，
  而不是因缺少原生导出而显示内部异常。
