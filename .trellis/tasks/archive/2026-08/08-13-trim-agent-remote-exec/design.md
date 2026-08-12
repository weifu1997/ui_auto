# Design: 裁剪 Agent 远程执行

## 1. 架构与边界

裁剪后保留的执行拓扑（单机部署）：

```
浏览器(局域网) ──HTTP──> server/index.ts ──> platform-handler（认证/RBAC/修订/数据/调度/通知）
                              │
                              └─> queuePublishedRuns → ManagedRunner（server/managed-runner.ts）
                                      └─> runner-core → 本机 Chromium（部署机）
```

移除的边：
- `agent/`（客户端）↔ platform WS（`/api/agents/connect`，`handleUpgrade`）
- `/api/agents/*`、agent-tokens、agent-bindings、run_leases HTTP 面
- debug_sessions 链路（端点 + 表 + 页面 + 工件）→ 平台采集通道随之移除
- `AUTOFLOW_EXECUTOR_TYPE=agent` 分支 → `managedExecutionEnabled` 恒为 true

保留的边：ManagedRunner（执行/验证/取消/工件）、legacy Worker（local 模式）、
local-picker（采集统一通道）、platform 其余全部能力。

## 2. 裁剪清单（按层）

### 服务端
| 对象 | 位置 | 动作 |
| --- | --- | --- |
| agent 客户端 | `agent/`（996 行）、`package.json` `agent` 脚本 | 删除 |
| WS upgrade | `server/platform-handler.ts:1772-1789` `handleUpgrade`、`server/index.ts:1310`、platform.ts 内 WS 服务装配与 `deliverElementValidations` 等分发（`server/platform.ts:1599,1725,1735` 附近） | 删除 |
| agents 端点 | `server/platform-handler.ts:1231-1299`（register/GET agents/agent-tokens/bindings/leases 等） | 删除 |
| agent 分发逻辑 | `server/platform.ts`：`boundOnlineAgent`、`candidateAgent`（901 行）、`deliverRun`/lease 相关、`AUTOFLOW_EXECUTOR_TYPE` 分支 | 删除；`managedExecutionEnabled` 改为常量 true（或直接内联 managed 路径） |
| debug 端点 | `server/platform-handler.ts:1329-1618` | 删除 |
| debug/agent 工件端点 | platform-artifacts 中 debug 相关、`/api/platform/debug-artifacts` | 删除 |
| `/health` onlineAgents | `server/platform-handler.ts:49-50` | 移除该字段或恒 0 |
| 迁移 v9 | `server/platform-migrations.ts` 追加 | DROP：debug_sessions、debug_session_events、debug_artifacts、picker_captures、run_leases、agent_bindings、agent_tokens。保留 `agents`（ManagedRunner 伪行） |

### 前端
| 对象 | 位置 | 动作 |
| --- | --- | --- |
| 平台采集面板 | `src/pages/ElementPickerPanel.tsx` + platform-api 采集函数（createDebugSession/enableElementPicker/getPickerCaptures/previewPickerCandidate/confirmPickerCandidate/fetchDebugArtifact） | 删除 |
| 采集分流 | `src/pages/ElementsPage.tsx:454` | 恒走 `local` 通道（删除 platform 分支与 `platformProjectContext` 判断） |
| 远程调试页 | `src/pages/DebugSessionsPage.tsx`、`platform-api.ts` debug 函数、debug-artifacts | 删除 |
| AgentsPage | `src/pages/AgentsPage.tsx` | 删 Agent 表格/绑定 UI 与「需要在线 Agent」检查（150-152 行）；保留发布/回滚/已发布版本/运行；标签改「发布与运行」 |
| 平台页 Tab | `src/pages/PlatformPage.tsx` `platformTabItems` | 移除 debug Tab；production 只剩「发布与运行」（考虑直接渲染 AgentsPage，保留 Tabs 结构以兼容测试） |
| 导航 | `src/pages/shared.tsx` `sectionMeta`（agents/debug 分区）、`ProjectShell.tsx:39-43` 重定向、`platform-nav.test.ts` | 移除 debug 分区与相关重定向 |
| 运行详情 | `src/RunDetailPage.tsx`、`RunsPage.tsx` platform 分支 | 保留（managed 运行），仅清理 lease/agent 字段展示 |

### 测试与文档
| 对象 | 动作 |
| --- | --- |
| `test:agent`、`test:ui-agent` | 脚本与文件删除（不在门禁内） |
| `platform-contract-smoke.ts` | 删 Agent/调试会话/平台采集章节；保留认证/工作空间/修订/密钥/数据集/调度/通知/治理/managed 运行章节 |
| `element-drawer-picker.test.tsx` | 平台通道用例改为本地通道；`local-element-picker-panel.test.tsx` 保留 |
| e2e `debug-center.spec` | 删除；`data-automations`/`governance`/`platform-sync` 等保留（不依赖 agent） |
| README/docs | Platform milestone 中 Agent 段落、执行节点说明删除；执行描述改为「平台运行在部署机本机执行」 |

## 3. 关键设计决策

### D1 执行强制 managed，不保留 agent 分支
`managedExecutionEnabled` 默认已是 true。删除 `AUTOFLOW_EXECUTOR_TYPE=agent` 分支后，
`queuePublishedRuns`/`createElementValidation` 直接走 managedAgent + ManagedRunner。
**权衡**：放弃未来多机扩展（可从 git 历史恢复）；收益是删掉 lease/心跳/WS 全套状态机。

### D2 保留 `agents` 表与 ManagedRunner 伪行
managed 路径在 `agents` 表写 `ManagedRunner` 行（幂等 INSERT OR IGNORE）用于运行
快照引用。**整表删除需重构 run 快照与 executorType 语义，收益低**，因此保留表、
移除协议。运行/验证事件中 `executorType: "managed"` 不变。

### D3 调试会话与平台采集通道一并裁掉，采集统一本地通道
本地通道（已在里程碑完成）在部署机本机开 headed Chromium、截图回传、confirm 只
回填不落库，两种项目模式均适用（不依赖平台上下文，grep 已验证）。平台项目保存
元素仍走抽屉正常保存 → 平台文档同步，闭环不受影响。
**权衡**：失去逐步执行/暂停/跳过的调试体验；换取删掉整条 debug + agent-picker 链路。

### D4 迁移 v9 用 DROP TABLE（非 archive）
这些表的数据（调试会话、采集记录、租约）无审计价值且已决定能力下线；
`audit_events` 中历史事件保留不清理（只读历史）。旧库升级时 v9 幂等执行。
**回滚**：迁移只 drop 空壳能力表；如误删可从 v9 之前的备份恢复
（`server/.data/platform-reset-backups/` 已有先例）。

### D5 AgentsPage 改名「发布与运行」，保留平台页聚合结构
production 下平台页只剩一个 Tab 时保留 Tabs 结构（避免 platform-nav.test 与
导航语义大改），仅移除 debug Tab；local 模式行为不变。

## 4. 数据流与契约（裁剪后不变的部分）

- `POST /api/platform/projects/:id/runs` → 202 `{run, runs, runIds}`（`leaseOffered`
  字段移除或恒 false，客户端不再依赖）
- 运行事件 `executorType: "managed"`、SSE 日志、工件端点不变
- `POST .../element-validations` → managed 验证不变
- local-picker 契约不变（`/api/projects/:id/local-picker/*`）

## 5. 兼容与回滚

- 迁移 v9 单向（drop 表）；回滚 = 从 v9 前备份恢复 DB + 回退代码提交。
- 实施按「先服务端协议删除 → 迁移 → 前端删除 → 测试收缩 → 文档」顺序提交，
  每步保持可构建；最终一次性验证 `test:all`。
- 风险点：`AgentsPage`/`RunDetailPage`/`platform-contract-smoke` 对 agent 字段的
  引用清理需 grep 全量确认，避免残留导致 lint/TS 错误。
