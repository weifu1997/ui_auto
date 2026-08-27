# 阶段4 编排体验 UI

子任务（父任务: reference-ui-auto-new-architecture）。决策见父 PRD D3-D7；本阶段为五阶段顺序中的最后一阶段。

## Goal

对齐参考项目可视化编排体验，保留本项目 Ant Design 视觉与无障碍（R4）。落地为：
- **运行中心编排看板**（`recharts` 图表：断言通过率趋势 + 运行状态逐日分布）；
- **RunDetail 断言摘要卡**（执行状态/报告可读性提升）；
- 全程**零触碰 ① 稳定契约区**（新增端点与前端区块均为 ③ 可扩展区纯增量）。

## Requirements

### R4-1 运行趋势数据（③ 可扩展区：纯增量端点）

- 新端点 `GET /api/platform/projects/{project_id}/runs/trend?window_days=N`
  （`window_days` 缺省/<=0 为全量窗口，语义与 `assertion_stats` 一致）。
- 返回逐日桶：`{ "windowDays": N, "points": [{ "date": "YYYY-MM-DD", "runTotal", "runPassed", "runFailed", "assertionTotal", "assertionPassed" }] }`，
  按日期升序；近 `N` 天含无数据日（前端连续 x 轴）。
- **口径复用 `assertion_stats`**：仅 `status IN ('success','failed')` 的终态 run；
  无断言 run 不进断言分子分母。只聚合计数，**不含任何 actual/secret 值**（安全边界：无脱敏面）。
- 路由鉴权沿用既有项目级角色校验（403 无权限 / 404 项目不存在）。

### R4-2 运行中心编排看板（RunsPage，纯增量区块）

- 顶部「编排看板」区块（`assertion-stats-bar` 上方）：
  - 断言通过率趋势（AreaChart，近 N 天，缺省 14 天窗口，可切换 7/14/30/全部）；
  - 运行状态逐日堆叠（BarChart：通过/失败 per day）。
- **空态**：`points` 全零或无数据时不渲染看板（与现有 `assertion-stats-bar` 空态一致）。
- recharts 随 RunsPage 异步 chunk 分包（ProjectShell `lazySection` 已异步），`check:bundle` ≤ 500KB 保持绿。

### R4-3 RunDetail 断言摘要卡（纯前端可读性）

- 断言结果区块标题行下方增摘要卡：**断言通过率** + 通过/失败计数 + **类型分布 chips**（可见性/文本/数量/属性/URL，复用 `ASSERTION_TYPE_LABELS`）。
- 无断言 run 不渲染（沿用既有 `assertions.length > 0` 守卫）。

### R4-4 依赖引入：recharts

- `recharts@^3.10.1`（MIT，peer `react ^19` 满足 React 19.2.8）。
- 引入即评估许可证/兼容性/维护度（主提示词 Stage E 铁律）——MIT ✓、React 19 peer ✓、维护活跃 ✓。
- 前端仅看板区块消费 recharts；其余页面不引。

## Acceptance Criteria

- [x] 趋势端点单测绿：逐日聚合（含窗口/全量）、口径一致（无断言 run 不进分子分母）、空库返回空 points、403/404 鉴权、实际值不落 payload。
- [x] RunsPage 看板：有数据渲染双图表；空态不渲染；窗口切换触发重新拉取（含 `window_days` 参数）。
- [x] RunDetail 摘要卡：通过率/计数/类型分布渲染；无断言 run 不渲染。
- [x] `npm run test:all` 全绿（含 `check:bundle`，recharts 独立 chunk ≤ 500KB；e2e 断言/录制/执行 spec 不回归）。

## Non-Goals

- 不新增任何断言类型 / 执行语义改动。
- 不做编排画布拖拽（阶段4 仅「可视化读」体验，交互编排不在本阶段）。
- 不触碰 ① 稳定契约区：`STEP_KEYS`/事件 kind/错误码/既有端点响应形状/`AssertionRecord` 载荷**零改动**。

## ① 稳定契约区触碰论证

| 触碰点 | 论证 |
|---|---|
| 新增 `/runs/trend` 端点 | ③ 纯增量：新路由 + `services/runs/_aggregation.py` 新方法，不改既有路由/方法 |
| RunsPage 看板区块 | ③ 纯增量：顶部增区块，不改既有 Table/batch/统计逻辑 |
| RunDetail 摘要卡 | ③ 纯增量：断言区块内增卡片，只读 `result.assertions` |
| `package.json` 增 recharts | ③ 纯增量依赖，独立提交可 revert |

## 回滚策略

- 五个提交各自独立：recharts 依赖（可 `git revert` 单独撤销）、趋势端点、看板、摘要卡、验收/文档。
- 端点/区块均为纯增量，回滚任一不影响既有行为；`test:all` 全程为验收基线。
