# 下一阶段需求与缺陷规划

## Goal

在继续扩展 AutoFlow Workbench 的业务能力前，先把 Python 后端迁移、生产同步、版本快照和运行历史四条核心链路收敛到“可重复部署、数据不丢、历史可见、行为可验证”的状态，再按实际使用价值扩展持续回归配置与大数据量体验。

用户价值：编辑成果不会因导航、刷新或短暂网络故障丢失；保存不会制造无意义版本；计划任务和 Webhook 产生的运行会自动出现在运行中心；新环境可以按文档一次启动并完成全量验证。

## Background And Evidence

- 核心 MVP 已具备项目、流程、元素、变量、环境、运行、数据集、定时任务、Webhook、通知、模板、治理分析和部署机 ManagedRunner，不需要继续横向堆功能来证明闭环。
- Python 迁移代码、部署脚本和 TS 归档已落地，`docs/方案-后端迁移Python.md:3` 标记 P3-P7 完成；但 `.trellis/tasks/08-15-python-backend-migration/prd.md:17` 的验收项仍全部未勾选，任务仍为 `in_progress`，记录与代码状态不一致。
- 本轮验证：`npm run build`、`npm run lint`、前端 24 个单测通过；使用 `server-py/.venv-linux` 后 Python 63 个单测通过。
- 直接执行 `npm run test:py` 缺少 `pytest`，`npm run test:e2e` 缺少 `uvicorn`；仓库已有可用虚拟环境，但 npm 脚本固定使用系统 `python`。本轮 E2E 在沙箱中还受 localhost 隔离影响，不能据此判断产品回归。
- 构建产物 `shared-*.js` 为 732.18 kB（gzip 236.84 kB），超过 Vite 500 kB 警戒线；这是可测量的性能债务，不是当前数据完整性阻断项。

## Recommended Priority

### P0: 收尾 Python 迁移与验证入口

#### R0.1 统一 Python 环境启动方式

- 提供可重复的开发环境初始化命令，或让 npm 脚本优先使用项目虚拟环境并在缺失时给出明确安装指令。
- `server:py`、`test:py`、Playwright `webServer` 使用同一 Python 解释器选择规则。
- README 不再出现“照文档执行但因系统 Python 缺依赖失败”的路径。

#### R0.2 完成迁移任务验收与工作区清理

- 对照迁移 PRD 逐项回填真实结果，补跑可运行的 smoke、E2E 和 Windows 部署门禁。
- 处理 `server-py/server/.data/` 本地运行数据：确认产生路径，加入正确忽略规则或修正本地默认工作目录；不得误删现有生产或用户数据。
- 清理 Trellis 状态漂移：迁移任务通过后归档；`08-10-sauce-demo-platform-error` 已有归档副本且验收完成，确认活动副本不再代表未完成工作后再归档。

### P1: 生产同步可靠性

#### D1 快速导航或刷新会丢失刚保存的资源

- 证据：`src/ServerWorkspaceSynchronizer.tsx:352` 使用 450 ms 定时器；`src/ServerWorkspaceSynchronizer.tsx:386` 在 effect 清理时取消全部定时器。
- 证据：生产 store 不持久化完整资源，现有冲突草稿只在收到 `RESOURCE_VERSION_CONFLICT` 后写入 `sessionStorage`，普通待同步修改没有持久 outbox。
- 已有真实复现记录：`docs/自测报告-内网部署验证.md:75`。

#### D2 短暂网络或 5xx 失败后不会自动重试

- 证据：`src/ServerWorkspaceSynchronizer.tsx:250` 的失败分支只更新状态和提示；除版本冲突外没有退避重试或持久重放。
- 风险：页面仍在时修改只保留于内存，刷新后可能被服务端旧数据覆盖。

#### R1.1 建立持久同步 outbox

- 本地变更先写入可恢复 outbox，再执行防抖网络同步。
- 成功后按项目、资源类型和版本精确确认；刷新、导航、浏览器重启后可重放。
- 对网络错误和 5xx 使用有上限的指数退避；对 409 保留显式冲突处理，不盲目覆盖。
- 同步状态区分“等待同步、同步中、重试中、冲突、已同步”，离开页面前仍能判断数据是否安全。

#### R1.2 覆盖真实生产同步器

- 当前 `src/App.tsx:117` 在 production/auth-required 才使用 `ServerWorkspaceSynchronizer`；默认 Vite E2E 主要覆盖另一套 `PlatformWorkspaceSynchronizer`。
- 新增 production/auth-required 场景，覆盖保存后立即导航、立即刷新、请求 5xx 后恢复、409 冲突后重提和进程重启重放。
- 长期目标是收敛两套同步实现，避免开发模式与生产模式行为漂移。

### P1: 版本快照语义稳定

#### D3 非业务字段变化会制造新版本

- `src/mock-data.ts:17`、`:30`、`:56` 表明流程、元素和环境含 `updatedAt`，元素还含 `validation`，步骤含运行/展示状态。
- `src/ServerWorkspaceSynchronizer.tsx:321` 将环境和元素对象直接发送；`server-py/autoflow/handler.py:2917` 对完整快照计算 checksum。
- 结果是展示时间、验证状态等非执行语义变化也可能 supersede 当前 published 版本；已有真实记录见 `docs/自测报告-内网部署验证.md:82`。

#### R2.1 使用规范化执行快照

- 在单一共享边界构建 revision DTO，只保留影响执行结果的字段。
- 排除 `updatedAt`、`validation`、步骤 UI 状态等展示或瞬态字段，并对数组顺序、缺省值和 JSON 序列化给出明确契约。
- 相同执行语义重复保存返回同一 published revision；真实执行字段变化才创建新版本。
- 已绑定计划任务/Webhook 的 revision 不会因无关资源 round-trip 变为不可运行。

### P1: 运行中心历史加载正确性

#### D4 运行中心不会自动读取平台历史

- `src/pages/ProjectShell.tsx:22` 的运行中心路由为 `/project/:id/runs`。
- `src/pages/RunsPage.tsx:62` 却只在 pathname 以 `/platform` 结尾时加载和轮询平台运行，因此页面首次进入不会自动拉取服务端历史。
- 当前手动“刷新状态”会绕过该判断，所以问题容易被本地持久化的 `run-store` 掩盖；没有 `RunsPage` 专项测试。

#### R3.1 运行中心以服务端历史为准

- 进入 `/runs` 立即加载平台运行；计划任务、Webhook 和其他浏览器创建的运行无需手动刷新即可出现。
- 仅对非终态运行轮询或订阅，终态历史按需刷新。
- 保留本地 Worker 运行兼容，但明确合并去重规则和来源标识。
- 补充空缓存、跨浏览器、计划触发、Webhook 触发和手动刷新测试。

## Product Requirements After Stability

### P2: 持续回归配置可维护

#### R4.1 编辑而不是删除重建

- 计划任务支持修改名称、Cron、时区、版本、环境和数据集。
- Webhook 支持修改名称、版本、环境和数据集，并可显式轮换 signing secret。
- 通知通道支持修改名称、地址、类型和关键词，并提供“发送测试通知”。
- 所有修改保留审计事件；密钥和地址仍按现有加密、单次展示与脱敏规则处理。

现状证据：`src/pages/AutomationsPage.tsx:92` 至 `:100` 只有新建、启停和归档，服务端/客户端也没有相应更新接口。配置填错时只能删除重建，Webhook 单次展示的 secret 使这一操作成本更高。

### P2: 历史数据分页与查询

#### R5.1 运行和投递记录服务端分页

- 运行列表支持服务端分页、状态、流程、来源和时间范围筛选。
- 通知投递记录支持分页、状态、通道和时间范围筛选。
- URL 保留查询状态，页面刷新后筛选不丢。

现状证据：运行接口固定 `LIMIT 200`（`server-py/autoflow/handler.py:2521`），前端只对已加载数据做 8 条客户端分页；投递接口固定 200 条，页面只展示前 8 条。

### P2: 首屏与共享依赖体积

#### R6.1 建立可执行的前端体积预算

- 拆分治理表格、编辑器和 Ant Design 重依赖，避免所有页面共享 chunk 持续增长。
- 为入口共享 chunk 设定预算并在 CI 记录变化；先以消除 Vite 500 kB 警告为目标，不为了数字牺牲缓存命中或交互稳定性。

### P3: 术语与历史文档收敛

- 清理 UI 中已退役的“Agent/指定 Agent”文案，例如 `src/pages/RunsPage.tsx:86`、`:108`，统一为“部署机执行器/ManagedRunner”。
- 将仍描述远程 Agent、远程调试、旧 TS 命令的历史方案标记为“已归档背景”，避免被当成当前操作指南。
- 保留历史决策证据，不直接删除可追溯材料。

## Suggested Iterations

1. **迭代 0：迁移收尾**：R0.1-R0.2，目标是全量门禁有唯一、可复现入口，任务状态与仓库一致。
2. **迭代 1：数据完整性**：R1.1-R1.2、R2.1，先解决同步丢数据和快照漂移。
3. **迭代 2：运行可见性**：R3.1，并同步清理相关过时文案。
4. **迭代 3：运营效率**：按真实使用反馈在 R4.1、R5.1、R6.1 中选一项，不建议一次并行铺开。

## Acceptance Criteria

- [ ] AC0：新检出环境按 README 的单一路径安装 Python 依赖并运行 `server:py`、`test:py`、前端测试和 Playwright E2E，不依赖开发者提前激活某个私有虚拟环境。
- [ ] AC1：保存任一资源后立即导航、刷新或关闭再打开，修改最终仍可在服务端恢复；断网/5xx 恢复后无需再次编辑即可自动同步。
- [ ] AC2：同一资源发生并发 409 时，本地草稿可恢复且不会静默覆盖远端；用户能明确选择刷新远端或重新提交。
- [ ] AC3：只改变 `updatedAt`、元素验证状态或步骤 UI 状态不会创建新 revision；改变定位器、步骤动作、变量值或环境执行配置会创建新 revision。
- [ ] AC4：清空浏览器 `autoflow-run-records` 后进入运行中心，仍能看到服务端历史；计划任务/Webhook 新运行在约定刷新周期内自动出现。
- [ ] AC5：每个进入开发的需求都拆为独立 Trellis 子任务，拥有可观察验收标准、验证命令和回滚点，不以本路线图直接启动大范围实现。

## Out Of Scope

- 恢复多机 Agent/租约/WebSocket 体系；现有单机内网部署决策明确暂不需要。
- 恢复成员/角色权限体系；当前产品决策是登录后全权限并保留工作空间隔离。
- 新一轮纯视觉改版、增加更多流程动作、云端多租户化。
- 本规划阶段直接修改产品代码或一次性启动全部 P0-P2 项目。

## Risks And Deferred Items

- 持久 outbox 涉及敏感变量时必须继续遵守“密钥明文不落盘”；只保存资源引用和非敏感草稿，密钥运行时再获取。
- revision 规范化会改变新 checksum，需保留旧 revision 可执行，不批量重写历史记录。
- 服务端分页会改变响应契约，应采用增量字段或版本兼容方案。
- Windows 服务、真实 Chromium 和 localhost 网络链路需要在非沙箱环境完成最终验收。

## Open Question

- 下一开发周期是否按建议锁定为“迭代 0 + 迭代 1”（迁移收尾、同步可靠性、版本稳定），并把持续回归配置编辑、分页和前端体积优化推迟到后续周期？
