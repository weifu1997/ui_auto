import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Select } from "antd";
import type { PlatformSession, RunTrendPoint } from "../api/platform-api";
import { getPlatformRunTrend } from "../api/platform-api";

// 编排看板窗口选项：0 代表全量（与后端 window_days 语义一致）。
const WINDOW_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 14, label: "近 14 天" },
  { value: 30, label: "近 30 天" },
  { value: 0, label: "全部" },
];

const TICK_FILL = "var(--text-secondary)";
const ACCENT = "var(--accent)";
const SUCCESS = "var(--success)";
const ERROR = "var(--error)";

/**
 * 运行中心编排看板（R4-2）：断言通过率趋势 + 运行状态逐日分布。
 *
 * 纯增量区块：数据源为 GET /runs/trend（口径与 assertion_stats 一致）；
 * 窗口切换触发重新拉取；`points` 无数据时整块不渲染（与 assertion-stats-bar 空态一致）。
 * recharts 随 RunsPage 异步 chunk 分包，不进入主包。
 */
export function OrchestrationDashboard({
  platformSession,
  platformProjectId,
  refreshKey,
}: {
  platformSession: PlatformSession | undefined;
  platformProjectId: string | undefined;
  refreshKey: number;
}) {
  const [windowDays, setWindowDays] = useState(14);
  const [points, setPoints] = useState<RunTrendPoint[]>([]);

  useEffect(() => {
    if (!platformSession || !platformProjectId) return;
    let cancelled = false;
    getPlatformRunTrend(platformSession.token, platformProjectId, windowDays)
      .then((trend) => {
        if (!cancelled) setPoints(trend.points ?? []);
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [platformSession, platformProjectId, windowDays, refreshKey]);

  const hasData = points.some((point) => point.runTotal > 0 || point.assertionTotal > 0);
  // 断言通过率序列：无断言日以 null 断开（避免 0% 误读）；日期仅留 MM-DD。
  const rateData = useMemo(
    () =>
      points.map((point) => ({
        date: point.date.slice(5),
        rate:
          point.assertionTotal > 0
            ? Math.round((point.assertionPassed / point.assertionTotal) * 100)
            : null,
      })),
    [points],
  );
  const runData = useMemo(
    () =>
      points.map((point) => ({
        date: point.date.slice(5),
        通过: point.runPassed,
        失败: point.runFailed,
      })),
    [points],
  );

  if (!hasData) return null;

  return (
    <section className="surface orchestration-dashboard" aria-label="编排看板">
      <div className="dashboard-heading">
        <h3>编排看板</h3>
        <Select
          size="small"
          aria-label="趋势窗口"
          value={windowDays}
          options={WINDOW_OPTIONS}
          onChange={setWindowDays}
        />
      </div>
      <div className="dashboard-grid">
        <div className="chart-card">
          <h4>断言通过率趋势</h4>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={rateData}>
              <CartesianGrid stroke="var(--separator)" strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 12 }} />
              <YAxis domain={[0, 100]} unit="%" width={40} tick={{ fill: TICK_FILL, fontSize: 12 }} />
              <Tooltip
                formatter={(value) => (value == null ? "无数据" : `${value}%`)}
                contentStyle={{ fontSize: 12 }}
              />
              <Area
                type="monotone"
                dataKey="rate"
                name="通过率"
                stroke={ACCENT}
                fill={ACCENT}
                fillOpacity={0.15}
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h4>运行状态分布</h4>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={runData}>
              <CartesianGrid stroke="var(--separator)" strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 12 }} />
              <YAxis allowDecimals={false} width={40} tick={{ fill: TICK_FILL, fontSize: 12 }} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="通过" stackId="run" fill={SUCCESS} />
              <Bar dataKey="失败" stackId="run" fill={ERROR} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}
