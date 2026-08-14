# 审计与治理增强 — 实施计划

## 有序清单

### Step 1: 审计埋点（R1，server）

1. `server/platform-handler.ts` 认证埋点：
   - register（:83）成功后 `auth.registered`；login（:109）成功 `auth.login_succeeded`、失败分支（401 返回处）`auth.login_failed`（含 `ip`、`reason`）；logout（:123）`auth.logout`。
   - 复用 services.audit；登录失败时 actor 未知，用 `{ type: "user", id: body.username ?? "unknown" }`。
2. `server/platform.ts` 通知投递埋点（投递循环 ~:924-947）：
   - 每通道投递结束按判定结果写 `notification.delivered` / `notification.rejected` / `notification.failed`，detail 含 `channelType`、`channelName`、`code`、`error`（截断 200 字符），不含 URL/keyword/密钥。
3. `server/platform.ts` 运行结束埋点：
   - :769 requestedStatus 收敛处写 `run.completed` / `run.failed`（failed 取最近错误事件 data 的 `code`/`stepId` 附入 detail）；:851 canceled 路径写 `run.canceled`。actor 为 system，target `run_batch`。
4. `server/platform.ts` 敏感操作埋点：
   - :688 运行 payload 密钥解密后写 `secret.decrypted_for_run`（detail 仅 secret 名称数组）；:924 通知配置解密处写 `notification_channel.config_read`（仅 name/type）。
5. 契约冒烟或单元测试：4 类新事件各至少 1 条断言（`platform.test.ts` 或 `platform-migrations.test.ts` 同风格）。

### Step 2: 审计查询 API + 前端面板（R2）

6. `server/platform-handler.ts:718` audit-events 扩展：解析 `page/pageSize/action/actorId/actorType/from/to/q`，动态 WHERE + `COUNT(*)` + `LIMIT/OFFSET`；响应 `{ events, total, page, pageSize }`（无参时保持旧行为，total 兜底）。
7. `src/platform-api.ts:637` `getPlatformAuditEvents` 签名扩展 + `PlatformAuditEvent` 类型补充；`src/pages/GovernancePage.tsx` 新增「审计日志」面板：服务端分页 Table、筛选区（类型 Select / 操作者 Input / RangePicker / 搜索 Input）、`expandable` 行展开渲染 detail（脱敏函数：键匹配 `/secret|url|token|password|keyword|signature|credential/i` → `******`）。
8. 单元测试：脱敏函数（新增纯函数文件便于测试）+ GovernancePage 审计面板渲染（参考 `element-drawer-picker.test.tsx` 风格，mock platform-api）。

### Step 3: 指标扩展（R3，server + 前端）

9. `server/platform.ts` `projectAnalytics`（:990）扩展参数 `window/from/to/period/limit/categoryBy`；窗口过滤 created_at；`period=week` 按 ISO 周分组；`previous` 计算上一同长区间 summary。
10. 新增聚合：`runDurations`（事件时间差）、`scheduleHealth`（审计 schedule.triggered/skipped 同窗口聚合）。
11. `failureCategory()` 增加 code 优先分支（data.code 存在则按其前缀归类），`categoryBy=code|step` 时按 code/stepId 维度输出。
12. 前端：指标卡窗口 Select（7/14/30/自定义）+ 环比徽标；趋势面板日/周切换；失败归类维度切换；新增「运行时长」「调度健康度」面板。
13. 测试：analytics 参数化用例（窗口/周/环比/时长/健康度各 1 条）+ 前端面板渲染。

### Step 4: 验证与收尾

14. `npm run lint`、`npm run build`、`npm run test:unit`、`npm run test:platform` 全绿。
15. 手动冒烟：`npx tsx server/platform-contract-smoke.ts` 或 production-ui-smoke 覆盖审计分页/筛选 + 新面板展示；确认通知拒绝（errcode）能落到审计。
16. `task.py validate` 通过后提交（遵循 Phase 3.4 分批提交：埋点 → API → 前端 → 测试），最后 `/trellis:finish-work`。

## 验证命令

```bash
npm run lint
npm run build
npm run test:unit
npm run test:platform
npx tsx server/platform-contract-smoke.ts
```

## 高风险文件 / 回滚点

- `server/platform.ts`（:688/:769/:851/:924-947/:990）：运行结束与通知投递是既有热路径，埋点必须 try/catch 不抛异常影响主流程；`projectAnalytics` 改动保持原响应字段不变。
- `server/platform-handler.ts`（:83-131/:718）：登录失败分支需确认现有返回路径；audit-events 无参行为保持兼容。
- `src/pages/GovernancePage.tsx`：新增面板不影响现有 5 面板；生产模式 Tab 收敛（PlatformPage）不改动。
- 回滚：每 Step 独立提交可独立 revert；Step 3 前端先行回滚不影响服务端。

## `task.py start` 前检查

- [ ] prd.md / design.md / implement.md 均存在且经评审
- [ ] implement.jsonl / check.jsonl 有真实条目（非 seed）
- [ ] `python .trellis/scripts/task.py validate 08-14-audit-governance-enhance` 通过
