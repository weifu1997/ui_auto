# Implement: 阶段4 编排体验 UI

有序执行清单。每步标注可验证产物；`[gate]` 标记的验证命令必须全绿才能进入下一步。
边界约束：本阶段**零触碰 ① 稳定契约区**——新增端点/前端区块均为 ③ 可扩展区纯增量；`STEP_KEYS`/事件 kind/错误码/既有端点响应形状不变。

---

## 阶段 D：编排看板数据（R4-1，纯增量端点，独立提交）

- [ ] D1. `_aggregation.py` 增 `run_trend(project_id, window_days)`：逐日桶（近 N 天含无数据日），口径与 `assertion_stats` 一致（仅 success/failed 终态 run；无断言 run 不进断言分子分母）；只聚合计数不落 actual。
- [ ] D2. `handler/runs.py` 增 `GET /runs/trend` 路由（项目角色校验 403/404 沿用既有）；`window_days` 缺省/<=0 全量。
- [ ] D3. 单测 `test_run_trend.py`：逐日聚合、窗口/全量、口径一致、空库、403/404、payload 无 actual/secret。
- [ ] D4. [gate] `npm run test:py` 全绿。

## 阶段 E：引入 recharts（R4-4，独立提交）

- [ ] E1. `npm install recharts@^3.10.1`（MIT / React 19 peer 已核）。
- [ ] E2. [gate] `npm run build && npm run check:bundle`（recharts 独立 chunk ≤ 500KB）。

## 阶段 F：RunsPage 编排看板（R4-2，独立提交）

- [ ] F1. `platform-api.ts` 增 `getPlatformRunTrend(token, pid, windowDays)`。
- [ ] F2. `RunsPage` 顶部「编排看板」区块：断言通过率 AreaChart + 运行状态堆叠 BarChart；窗口切换 7/14/30/全部触发重新拉取；`points` 全零/空不渲染。
- [ ] F3. 前端单测：有数据渲染双图表、空态不渲染、窗口切换传 `window_days`。
- [ ] F4. [gate] `npm run lint && npm run build && npm run test:unit` 全绿。

## 阶段 G：RunDetail 断言摘要卡（R4-3，独立提交）

- [ ] G1. `RunDetailPage` 断言区块增摘要卡：通过率 + 通过/失败计数 + 类型分布 chips（复用 `ASSERTION_TYPE_LABELS`）。
- [ ] G2. 前端单测：摘要卡渲染、无断言不渲染。
- [ ] G3. [gate] `npm run test:unit` 全绿。

## 阶段 H：验收与收尾

- [ ] H1. 全量门禁 `npm run test:all`（含 `check:bundle`；e2e 断言/录制/执行 spec 不回归）。
- [ ] H2. 回滚演练：五个提交各自独立可 revert；① 区零改动。
- [ ] H3. spec 同步：`architecture-boundaries.md` ③ 区标记 recharts 编排看板/摘要卡完成态；阶段4 PRD 验收清单勾选。

## 风险文件 / 回滚点

- 中风险：recharts 体积——RunsPage 已异步分包；若看板 chunk 超 500KB，将看板组件再 `React.lazy` 拆分。
- 低风险：`handler/runs.py`/`_aggregation.py` 纯增方法，不触碰既有执行路径。
- 启动前检查：阶段3 验收已全绿（`test:all` EXIT=0），本阶段每一 `[gate]` 相对该基线比对。
