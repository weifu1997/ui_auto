import { message } from "../antd-feedback";
import { maskAuditDetail } from "../audit-mask";
import type { Project } from "../mock-data";
import { getPlatformAnalytics, getPlatformAuditEvents } from "../platform-api";
import type { PlatformAnalytics, PlatformAnalyticsQuery, PlatformAuditEvent, PlatformAuditQuery, PlatformSession } from "../platform-api";
import { readPlatformProjectMap, readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../platform-context";
import { PageHeading, PlatformProjectRequired } from "./shared";
import { ReloadOutlined } from "@ant-design/icons";
import { Button, DatePicker, Empty, Input, Select, Table, Tag, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

const AUDIT_ACTION_GROUPS = [
  { value: "auth.", label: "认证" },
  { value: "notification.", label: "通知投递" },
  { value: "run.", label: "运行" },
  { value: "secret.", label: "密钥" },
  { value: "flow_revision.", label: "发布/回滚" },
  { value: "schedule.", label: "定时任务" },
  { value: "webhook", label: "Webhook" },
  { value: "template.", label: "模板" },
  { value: "dataset.", label: "数据集" },
  { value: "project.", label: "项目" },
  { value: "workspace.", label: "工作区" },
  { value: "element.", label: "元素" },
];

const AUDIT_COLUMNS = [
  { title: "操作", dataIndex: "action", width: 190, render: (value: string) => <Tag>{value}</Tag> },
  { title: "操作者", dataIndex: "actorId", width: 150, render: (value: string, item: PlatformAuditEvent) => <span><strong>{value}</strong><small className="table-secondary">{item.actorType}</small></span> },
  { title: "目标", width: 210, render: (_: unknown, item: PlatformAuditEvent) => <span><strong>{item.targetType}</strong><small className="table-secondary">{item.targetId}</small></span> },
  { title: "时间", dataIndex: "createdAt", width: 130, render: (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) },
];

export function GovernancePage({ project }: { project: Project }) {
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [analytics, setAnalytics] = useState<PlatformAnalytics>();
  const [releaseEvents, setReleaseEvents] = useState<PlatformAuditEvent[]>([]);
  const [auditEvents, setAuditEvents] = useState<PlatformAuditEvent[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditQuery, setAuditQuery] = useState<PlatformAuditQuery>({ page: 1, pageSize: 20 });
  const [analyticsQuery, setAnalyticsQuery] = useState<PlatformAnalyticsQuery>({ window: 30, period: "day", categoryBy: "message" });
  const [analyticsRangeKey, setAnalyticsRangeKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const platformProjectId = platformProjectMap[project.id];
  const workspaceId = readStoredPlatformWorkspaceId(platformSession);

  const loadGovernance = useCallback(async () => {
    if (!platformSession || !platformProjectId || !workspaceId) return;
    setLoading(true);
    try {
      const [analyticsResponse, releaseResponse] = await Promise.all([
        getPlatformAnalytics(platformSession.token, platformProjectId, analyticsQuery),
        getPlatformAuditEvents(platformSession.token, platformProjectId, { action: "flow_revision.", page: 1, pageSize: 12 }),
      ]);
      setAnalytics(analyticsResponse.analytics);
      setReleaseEvents(releaseResponse.events);
    } catch {
      message.error("无法读取治理与质量数据");
    } finally {
      setLoading(false);
    }
  }, [analyticsQuery, platformProjectId, platformSession, workspaceId]);

  const loadAudit = useCallback(async () => {
    if (!platformSession || !platformProjectId) return;
    setAuditLoading(true);
    try {
      const response = await getPlatformAuditEvents(platformSession.token, platformProjectId, auditQuery);
      setAuditEvents(response.events);
      setAuditTotal(response.total);
    } catch {
      message.error("无法读取审计日志");
    } finally {
      setAuditLoading(false);
    }
  }, [auditQuery, platformProjectId, platformSession]);

  useEffect(() => { void loadGovernance(); }, [loadGovernance]);
  useEffect(() => { void loadAudit(); }, [loadAudit]);
  if (!platformSession || !platformProjectId || !workspaceId) return <PlatformProjectRequired project={project} title="治理分析" description="查看质量趋势与发布审计。" />;

  const summary = analytics?.summary ?? { totalRuns: 0, successRate: 0, failedRuns: 0, canceledRuns: 0, failedRate: 0, canceledRate: 0 };
  const previous = analytics?.previous;
  const trend = analytics?.trend ?? [];
  const failureCategories = analytics?.failureCategories ?? [];
  const slowSteps = analytics?.slowSteps ?? [];
  const elementImpact = analytics?.elementImpact ?? [];
  const runDurations = analytics?.runDurations ?? [];
  const scheduleHealth = analytics?.scheduleHealth ?? { triggered: 0, skipped: 0, successRate: 0 };
  const windowText = analyticsQuery.window ? `近 ${analyticsQuery.window} 天` : analyticsQuery.from ? "自定义区间" : "全部历史";
  const deltaTag = (current: number, baseline: number | undefined, goodWhenUp: boolean) => {
    if (baseline === undefined) return null;
    const diff = current - baseline;
    if (diff === 0) return <Tag>持平</Tag>;
    const good = diff > 0 === goodWhenUp;
    return <Tag color={good ? "success" : "error"}>{diff > 0 ? "↑" : "↓"}{Math.abs(diff)}</Tag>;
  };

  return (
    <>
      <PageHeading title="治理分析" description="聚合已冻结运行快照、步骤事件和发布审计；质量指标不读取密钥或原始通知配置。" actions={<Tooltip title="刷新治理数据"><Button icon={<ReloadOutlined />} aria-label="刷新治理数据" loading={loading} onClick={() => void loadGovernance()} /></Tooltip>} />
      <div className="audit-filters">
        <Select aria-label="时间窗口" value={analyticsQuery.window ?? 0} onChange={(value) => { setAnalyticsQuery((query) => ({ ...query, window: value || undefined, from: undefined, to: undefined })); setAnalyticsRangeKey((key) => key + 1); }} options={[{ value: 7, label: "近 7 天" }, { value: 14, label: "近 14 天" }, { value: 30, label: "近 30 天" }, { value: 0, label: "全部" }]} style={{ width: 110 }} />
        <DatePicker.RangePicker key={analyticsRangeKey} showTime format="YYYY-MM-DD HH:mm" onChange={(dates) => setAnalyticsQuery((query) => ({ ...query, window: undefined, from: dates?.[0]?.toISOString(), to: dates?.[1]?.toISOString() }))} />
        <Select aria-label="趋势周期" value={analyticsQuery.period ?? "day"} onChange={(value) => setAnalyticsQuery((query) => ({ ...query, period: value as "day" | "week" }))} options={[{ value: "day", label: "按日" }, { value: "week", label: "按周" }]} style={{ width: 90 }} />
        <Select aria-label="失败归类维度" value={analyticsQuery.categoryBy ?? "message"} onChange={(value) => setAnalyticsQuery((query) => ({ ...query, categoryBy: value as "message" | "code" | "step" }))} options={[{ value: "message", label: "归类:消息" }, { value: "code", label: "归类:错误码" }, { value: "step", label: "归类:步骤" }]} style={{ width: 130 }} />
      </div>
      <section className="metric-grid governance-metrics">
        <div className="surface metric-card"><span>运行总数</span><strong>{summary.totalRuns}</strong><small>{windowText}{deltaTag(summary.totalRuns, previous?.totalRuns, true)}</small></div>
        <div className="surface metric-card"><span>成功率</span><strong>{summary.successRate}%</strong><small>已结束运行{deltaTag(summary.successRate, previous?.successRate, true)}</small></div>
        <div className="surface metric-card"><span>失败率</span><strong>{summary.failedRate}%</strong><small>占总运行比例{deltaTag(summary.failedRate, previous?.failedRate, false)}</small></div>
        <div className="surface metric-card"><span>取消率</span><strong>{summary.canceledRate}%</strong><small>占总运行比例{deltaTag(summary.canceledRate, previous?.canceledRate, false)}</small></div>
      </section>
      <div className="governance-grid">
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>执行趋势</h2><span>按{analyticsQuery.period === "week" ? "周" : "日"}汇总的运行结果</span></div></div><Table size="small" loading={loading} rowKey="date" pagination={false} dataSource={trend.slice(-10)} columns={[{ title: analyticsQuery.period === "week" ? "周" : "日期", dataIndex: "date" }, { title: "总计", dataIndex: "total", width: 70 }, { title: "通过", dataIndex: "success", width: 70 }, { title: "失败", dataIndex: "failed", width: 70 }, { title: "取消", dataIndex: "canceled", width: 70 }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无已结束运行" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>失败归类</h2><span>维度：{analyticsQuery.categoryBy === "code" ? "错误码" : analyticsQuery.categoryBy === "step" ? "步骤" : "消息"}</span></div></div><Table size="small" loading={loading} rowKey="category" pagination={false} dataSource={failureCategories} columns={[{ title: "类别", dataIndex: "category" }, { title: "次数", dataIndex: "count", width: 80 }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无失败归类" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>慢步骤</h2><span>按平均耗时排序</span></div></div><Table size="small" loading={loading} rowKey="stepId" pagination={false} dataSource={slowSteps.slice(0, 8)} columns={[{ title: "步骤", render: (_, item) => <span><strong>{item.title}</strong><small className="table-secondary">{item.stepId}</small></span> }, { title: "平均", dataIndex: "averageMs", width: 90, render: (value: number) => `${value} ms` }, { title: "最大", dataIndex: "maxMs", width: 90, render: (value: number) => `${value} ms` }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待带耗时的步骤事件" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>元素影响</h2><span>引用频率与失败关联</span></div></div><Table size="small" loading={loading} rowKey="elementId" pagination={false} dataSource={elementImpact.slice(0, 8)} columns={[{ title: "元素", dataIndex: "name" }, { title: "运行", dataIndex: "runCount", width: 70 }, { title: "流程", dataIndex: "flowCount", width: 70 }, { title: "失败", dataIndex: "failedRuns", width: 70, render: (value: number) => <Tag color={value ? "error" : "success"}>{value}</Tag> }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无元素使用记录" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>运行时长</h2><span>按{analyticsQuery.period === "week" ? "周" : "日"}平均耗时</span></div></div><Table size="small" loading={loading} rowKey="date" pagination={false} dataSource={runDurations.slice(-10)} columns={[{ title: analyticsQuery.period === "week" ? "周" : "日期", dataIndex: "date" }, { title: "平均", dataIndex: "averageMs", width: 100, render: (value: number) => `${value} ms` }, { title: "运行", dataIndex: "count", width: 70 }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待带事件的运行" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>调度健康度</h2><span>定时任务触发/跳过统计</span></div></div><Table size="small" loading={loading} rowKey="name" pagination={false} dataSource={[{ name: "调度触发", value: scheduleHealth.triggered }, { name: "调度跳过", value: scheduleHealth.skipped }, { name: "调度成功率", value: `${scheduleHealth.successRate}%` }]} columns={[{ title: "指标", dataIndex: "name" }, { title: "值", dataIndex: "value", width: 90 }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无调度记录" /> }} /></section>
        <section className="surface governance-panel governance-audit"><div className="panel-heading"><div><h2>发布审计</h2><span>版本发布与回滚记录</span></div></div><Table size="small" loading={loading} tableLayout="fixed" rowKey="id" pagination={false} dataSource={releaseEvents} columns={[{ title: "操作", dataIndex: "action", width: 112 }, { title: "操作者", dataIndex: "actorId", width: 60 }, { title: "时间", dataIndex: "createdAt", width: 75, render: (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无发布审计记录" /> }} /></section>
        <section className="surface governance-panel governance-audit">
          <div className="panel-heading"><div><h2>审计日志</h2><span>全量事件，支持筛选与搜索</span></div></div>
          <div className="audit-filters">
            <Select allowClear placeholder="事件类型" style={{ width: 140 }} value={auditQuery.action} onChange={(value) => setAuditQuery((query) => ({ ...query, action: value, page: 1 }))} options={AUDIT_ACTION_GROUPS} />
            <Input allowClear placeholder="操作者" style={{ width: 140 }} value={auditQuery.actorId} onChange={(event) => setAuditQuery((query) => ({ ...query, actorId: event.target.value || undefined, page: 1 }))} />
            <DatePicker.RangePicker showTime format="YYYY-MM-DD HH:mm" onChange={(dates) => setAuditQuery((query) => ({ ...query, from: dates?.[0]?.toISOString(), to: dates?.[1]?.toISOString(), page: 1 }))} />
            <Input.Search allowClear placeholder="搜索关键字" style={{ width: 200 }} onSearch={(value) => setAuditQuery((query) => ({ ...query, q: value || undefined, page: 1 }))} />
          </div>
          <Table size="small" tableLayout="fixed" rowKey="id" loading={auditLoading} dataSource={auditEvents} columns={AUDIT_COLUMNS}
            pagination={{ current: auditQuery.page, pageSize: auditQuery.pageSize, total: auditTotal, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => setAuditQuery((query) => ({ ...query, page, pageSize })) }}
            expandable={{ expandedRowRender: (record) => <pre className="audit-detail">{JSON.stringify(maskAuditDetail(record.detail), null, 2)}</pre> }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无审计事件" /> }} />
        </section>
      </div>
    </>
  );
}
