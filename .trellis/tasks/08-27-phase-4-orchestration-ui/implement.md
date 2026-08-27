# Implement: 阶段4 编排体验 UI

有序执行清单。每步标注可验证产物；`[gate]` 标记的验证命令必须全绿才能进入下一步。
边界约束：本阶段**零触碰 ① 稳定契约区**——新增端点/前端区块均为 ③ 可扩展区纯增量；`STEP_KEYS`/事件 kind/错误码/既有端点响应形状不变。

---

## 阶段 D：编排看板数据（R4-1，纯增量端点，独立提交）

- [x] D1. `_aggregation.py` 增 `run_trend(project_id, window_days)`：逐日桶（近 N 天含无数据日），口径与 `assertion_stats` 一致（仅 success/failed 终态 run；无断言 run 不进断言分子分母）；只聚合计数不落 actual。
- [x] D2. `handler/runs.py` 增 `GET /runs/trend` 路由（项目角色校验 403/404 沿用既有）；`window_days` 缺省/<=0 全量；路由鉴权矩阵增 `project.view` 策略行。
- [x] D3. 单测 `test_run_trend.py` 5 用例：逐日聚合、窗口含空日、口径一致（无断言 run 不进分子分母、非终态不纳入）、空库、403/404、payload 无 actual/secret。
- [x] D4. [gate] `npm run test:py` 295 全绿（290 基线 + 5 趋势用例）。

## 阶段 E：引入 recharts（R4-4，独立提交）

- [ ] E1. `npm install recharts@^3.10.1`（MIT / React 19 peer 已核）。
- [ ] E2. [gate] `npm run build && npm run check:bundle`（recharts 独立 chunk ≤ 500KB）。

## 阶段 F：RunsPage 编排看板（R4-2，独立提交）

- [x] F1. `platform-api.ts` 增 `getPlatformRunTrend(token, pid, windowDays)`（`window_days` 参数）+ `RunTrendPoint`/`RunTrend` 类型。
- [x] F2. 新增 `OrchestrationDashboard.tsx`：断言通过率 AreaChart + 运行状态堆叠 BarChart；窗口 7/14/30/全部切换触发重拉；`points` 无数据整块不渲染；CSS 变量适配双主题；RunsPage 顶部接入（列表刷新自增 refreshKey 联动）。
- [x] F3. 前端单测 `orchestration-dashboard.test.tsx` +3：双图表渲染、空态不渲染、窗口切换传 `window_days=7`；既有 runs-page 断言测试 mock 趋势空数据防干扰。
- [x] F4. [gate] `npm run lint`（0 警告）&& `npm run build`（✓ built）&& `check:bundle`（recharts 独立 vendor chunk 136K ≤ 500KB）&& `npm run test:unit` 123 全绿。

## 阶段 G：RunDetail 断言摘要卡（R4-3，独立提交）

- [x] G1. `RunDetailPage` 断言区块增摘要卡：通过率 + 通过/失败计数 + 类型分布 chips（复用 `ASSERTION_TYPE_LABELS`）；CSS 适配双主题；断言行小直接计算不 memo。
- [x] G2. 前端单测：摘要卡渲染（通过率 50% + 通过 1/失败 1 + 文本 × 1/URL × 1 类型 chips）。
- [x] G3. [gate] `npm run lint`（0 警告）&& `npm run build`（✓ built）&& `npm run test:unit` 124 全绿。

## 阶段 H：验收与收尾

- [ ] H1. 全量门禁 `npm run test:all`（含 `check:bundle`；e2e 断言/录制/执行 spec 不回归）。
- [ ] H2. 回滚演练：五个提交各自独立可 revert；① 区零改动。
- [ ] H3. spec 同步：`architecture-boundaries.md` ③ 区标记 recharts 编排看板/摘要卡完成态；阶段4 PRD 验收清单勾选。

## 风险文件 / 回滚点

- 中风险：recharts 体积——RunsPage 已异步分包；若看板 chunk 超 500KB，将看板组件再 `React.lazy` 拆分。
- 低风险：`handler/runs.py`/`_aggregation.py` 纯增方法，不触碰既有执行路径。
- 启动前检查：阶段3 验收已全绿（`test:all` EXIT=0），本阶段每一 `[gate]` 相对该基线比对。
