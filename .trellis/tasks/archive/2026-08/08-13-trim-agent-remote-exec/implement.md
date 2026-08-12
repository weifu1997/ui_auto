# Implement: 裁剪 Agent 远程执行

## 执行顺序（每步保持可构建）

1. **服务端协议删除**
   - `server/platform.ts`：删除 `boundOnlineAgent`/`candidateAgent`/lease 分发与
     WS 装配；`managedExecutionEnabled` 置常量 true；`deliverElementValidations`
     等 agent 分发删除
   - `server/platform-handler.ts`：删 `/api/agents/*`、agent-tokens、agent-bindings、
     run_leases、debug_sessions 全部端点；删 `handleUpgrade`（1772-1789）与
     `/health` 的 onlineAgents
   - `server/index.ts`：删 1310 行 handleUpgrade 接线
   - 删除 `agent/` 目录、`package.json` 的 `agent` 脚本与 `test:agent`/`test:ui-agent`
2. **迁移 v9**：`server/platform-migrations.ts` 追加 version 9，drop
   debug_sessions/debug_session_events/debug_artifacts/picker_captures/run_leases/
   agent_bindings/agent_tokens；更新 `platform-migrations.test.ts`
3. **前端裁剪**
   - 删 `src/pages/ElementPickerPanel.tsx`、`src/pages/DebugSessionsPage.tsx` 及
     platform-api 中采集/debug/agent 函数
   - `src/pages/ElementsPage.tsx:454` 恒走本地通道
   - `src/pages/AgentsPage.tsx`：删 Agent 管理 UI 与 150-152 行检查；标签「发布与运行」
   - `src/pages/PlatformPage.tsx`：移除 debug Tab；`src/pages/ProjectShell.tsx`、
     `src/pages/shared.tsx`：移除 debug 分区/重定向
   - `src/RunDetailPage.tsx`/`RunsPage.tsx`：清理 lease/agent 字段
4. **测试收缩**
   - `platform-contract-smoke.ts` 删 Agent/调试/平台采集章节
   - `element-drawer-picker.test.tsx` 改本地通道用例；删 e2e `debug-center.spec`
   - `platform-nav.test.ts` 更新 Tab 断言
5. **文档**：README（Agent 章节/执行描述）、`docs/决策-内网部署形态与平台裁剪.md`
   状态更新、自测报告

## 验证命令

```bash
npm run build
npm run lint
npm run test:unit
npm run test:platform
npm run test:managed
npm run test:worker
npm run test:e2e
npm run test:production
npm run test:windows
```

## 人工闭环验证（部署形态）

1. 迁移验证：备份 → 用现有 `server/.data/platform.sqlite` 启动，确认 v9 生效且
   `agents` 表保留 ManagedRunner 行
2. 发布修订 → 运行 → SSE/工件 → 完成（managed 执行，本机 Chromium）
3. local 与 platform-enabled 两模式「从页面获取」采集闭环
4. 定时回归 + 通知（飞书/钉钉/Webhook）→ 平台运行
5. `/health` 与平台契约 smoke 全绿

## 风险点与回滚

- **风险**：agent 字段引用残留（grep `agents?`/`debug`/`lease`/`Agent` 全量确认
  后再删）；迁移 v9 在现有库上幂等执行（先备份三件套，遵循
  `.trellis/spec/guides/index.md` SQLite 备份清单）
- **回滚点**：每步独立提交；DB 回滚用 v9 前备份；代码回滚 revert 对应提交

## 提交计划

1. `裁剪: 服务端移除 Agent 协议与 WS，执行强制 ManagedRunner + 迁移 v9`
2. `裁剪: 前端移除远程调试/平台采集通道，采集统一本地通道，AgentsPage 收敛为发布与运行`
3. `裁剪: 测试收缩（platform smoke / picker 单测 / e2e / nav）+ 文档更新`
