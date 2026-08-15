# 裁剪 Agent 远程执行（内网单机部署形态）

## Goal

内网单机部署形态下（局域网网页访问 + 仅部署机执行 + 需要定时/通知/数据集），
移除分布式的 Agent 远程执行路径，保留 Platform 核心能力。决策依据：
`docs/决策-内网部署形态与平台裁剪.md`（方案 C）。

用户价值：砍掉约 2,000–3,000 行只服务多机分布式执行的代码（WS 协议、心跳、租约、
重连、远程调试会话），使代码面与「单机部署」实际形态一致，降低维护与测试成本；
Platform 的认证/修订/密钥/数据集/定时/通知/治理能力保持不变。

## Confirmed Facts

- 部署目标已确认：一台内网电脑跑服务（监听 0.0.0.0），用户从局域网浏览器访问，
  Chromium 仅在部署机执行；定时回归/通知/数据集是 platform-only 且为刚需。
- **单机执行路径已存在且为默认**：`server/platform.ts:445`
  `managedExecutionEnabled = process.env.AUTOFLOW_EXECUTOR_TYPE !== "agent"`。
  默认（不设该变量）时 `queuePublishedRuns` 走 `managedAgent()` → `ManagedRunner`
  在部署机本机执行（`server/platform.ts:653-660,736,807-870`）；元素验证同理
  （`server/platform.ts:901,870` 走 `enqueueManagedValidation`）。仅显式设置
  `AUTOFLOW_EXECUTOR_TYPE=agent` 时才走远端 Agent 分发。
- `managedAgent()` 会在 `agents` 表插入一个 `ManagedRunner` 伪代理行
  （`server/platform.ts:630-650`）——**agents 表本身不能整表删除**，只能移除
  真实 Agent 管理协议（注册/WS/令牌/绑定/租约）。
- 前端「远程运行」被一个多余的客户端检查挡住：`src/pages/AgentsPage.tsx:150-152`
  「远程运行需要已绑定且在线的 Agent」——managed 执行不需要 Agent，裁剪时必须移除。
- Agent 客户端（`agent/index.ts` 996 行）与服务端端点（`/api/agents/register`、
  `/api/agents`、agent-tokens、agent-bindings、run_leases、WS
  `handleUpgrade`，`server/platform-handler.ts:1231-1299,1772-1789`，
  `server/index.ts:1310`）只服务多机分布式执行。
- **已决策（用户确认）**：远程调试会话整体裁剪。调试链路
  （`server/platform-handler.ts:1329-1618` debug_sessions 端点、DebugSessionsPage、
  debug 工件）由 Agent 远端驱动 headed Chromium 实现，单机部署不需要；
  平台元素采集通道（`ElementPickerPanel`）依赖调试会话 + Agent，一并裁剪，
  元素采集统一走本地采集通道（`LocalElementPickerPanel` +
  `/api/projects/:id/local-picker/*`，部署机本机 headed Chromium + 截图反馈，
  confirm 只回填不落库）。通道分流点 `src/pages/ElementsPage.tsx:454`
  改为恒走本地通道。
- 元素**验证**（`createPlatformElementValidation`，managed 执行）与运行中心/运行详情
  的 platform 分支保留——它们走 ManagedRunner，不是裁剪对象。
- `deployment/AutoFlow.xml` 无 Agent 引用，部署资产无需改动。
- `platform-core.ts:safeArtifactName` 被 legacy worker 反向引用
  （`server/index.ts:16`），必须保留。
- 测试依赖：`test:agent`（debug-agent-smoke 436 行）与 `test:ui-agent`
  （ui-agent-e2e 240 行）100% 依赖 Agent 且不在 `test:all` 门禁内；
  `platform-contract-smoke.ts`（625 行）含 Agent/调试会话/平台采集章节需收缩；
  e2e `debug-center.spec` 依赖调试会话 UI；`element-drawer-picker.test.tsx`
  含平台通道用例需改为本地通道。
- 迁移框架版本 1–8（`server/platform-migrations.ts:286-293`），可平滑追加 v9。

## Requirements

- 移除 Agent 客户端与服务端 Agent 协议（注册、心跳、租约、WS、令牌、绑定），
  执行强制走 ManagedRunner（移除 `AUTOFLOW_EXECUTOR_TYPE=agent` 分支）。
- 移除远程调试会话链路（端点/页面/表）与平台采集通道；元素采集统一走本地通道，
  两种项目模式（local / platform-enabled）均可闭环。
- 移除 `AgentsPage` 的 Agent 管理 UI 与「需要在线 Agent」的前置检查；保留发布/
  回滚/已发布版本列表/运行（发布到 Platform 的能力不变）。
- 保留：认证/会话、工作空间/RBAC、项目文档、修订/发布/回滚、密钥加密、数据集、
  定时/Webhook、通知、治理、模板、ManagedRunner 执行、元素验证（managed）。
- 数据迁移：新增 v9 清理不再使用的表（debug_*、picker_captures、run_leases、
  agent_bindings、agent_tokens），保留 `agents` 表（ManagedRunner 伪代理行）。
- `test:all` 门禁裁剪后全绿；`test:agent`/`test:ui-agent` 从 package.json 移除；
  platform-contract-smoke 收缩到保留能力。
- README / docs / deployment 同步更新（移除 Agent/远程调试章节，更新执行描述）。

## Acceptance Criteria

- [ ] `agent/` 目录与 `npm run agent` 脚本移除；`AUTOFLOW_EXECUTOR_TYPE=agent`
      分支移除，执行恒为 ManagedRunner（部署机本机）
- [ ] 发布修订 → 运行 → SSE/工件 → 完成 闭环可用（managed 执行）
- [ ] 两种项目模式下「从页面获取」元素采集闭环可用（统一本地通道）
- [ ] 定时回归 + 通知 + 数据集参数化运行可用
- [ ] 数据库迁移 v9 生效：旧库升级后无 debug_*/picker_captures/run_leases/
      agent_bindings/agent_tokens 表，agents 表保留且含 ManagedRunner 行
- [ ] `npm run build && npm run lint && npm run test:all` 全绿
- [ ] README / docs / deployment 无 Agent 残留描述

## Out of Scope

- 认证/会话、工作空间/RBAC、修订、密钥、数据集、调度、通知、治理、模板、
  ManagedRunner 的功能改动（仅裁剪适配）
- local 模式与 legacy Worker API（`/api/projects/*`、local-picker）行为改动
- 多机分布式执行（如未来需要，从本任务归档与 git 历史恢复）
- Windows 服务部署资产（`deployment/AutoFlow.xml`）已无 Agent 引用，不改
