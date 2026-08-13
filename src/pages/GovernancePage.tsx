import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import { getPlatformAnalytics, getPlatformAuditEvents } from "../platform-api";
import type { PlatformAnalytics, PlatformAuditEvent, PlatformSession } from "../platform-api";
import { readPlatformProjectMap, readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../platform-context";
import { PageHeading, PlatformProjectRequired } from "./shared";
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Table, Tag, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

export function GovernancePage({ project }: { project: Project }) {
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [analytics, setAnalytics] = useState<PlatformAnalytics>();
  const [auditEvents, setAuditEvents] = useState<PlatformAuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const platformProjectId = platformProjectMap[project.id];
  const workspaceId = readStoredPlatformWorkspaceId(platformSession);

  const loadGovernance = useCallback(async () => {
    if (!platformSession || !platformProjectId || !workspaceId) return;
    setLoading(true);
    try {
      const [analyticsResponse, auditResponse] = await Promise.all([
        getPlatformAnalytics(platformSession.token, platformProjectId),
        getPlatformAuditEvents(platformSession.token, platformProjectId),
      ]);
      setAnalytics(analyticsResponse.analytics);
      setAuditEvents(auditResponse.events);
    } catch {
      message.error("无法读取治理与质量数据");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, platformSession, workspaceId]);

  useEffect(() => { void loadGovernance(); }, [loadGovernance]);
  if (!platformSession || !platformProjectId || !workspaceId) return <PlatformProjectRequired project={project} title="治理分析" description="查看质量趋势与发布审计。" />;

  const summary = analytics?.summary ?? { totalRuns: 0, successRate: 0, failedRuns: 0 };
  const releases = auditEvents.filter((event) => event.action.startsWith("flow_revision.")).slice(0, 12);

  return (
    <>
      <PageHeading title="治理分析" description="聚合已冻结运行快照、步骤事件和发布审计；质量指标不读取密钥或原始通知配置。" actions={<Tooltip title="刷新治理数据"><Button icon={<ReloadOutlined />} aria-label="刷新治理数据" loading={loading} onClick={() => void loadGovernance()} /></Tooltip>} />
      <section className="metric-grid governance-metrics">
        <div className="surface metric-card"><span>运行总数</span><strong>{summary.totalRuns}</strong><small>最近 500 次平台运行</small></div>
        <div className="surface metric-card"><span>成功率</span><strong>{summary.successRate}%</strong><small>已结束运行</small></div>
        <div className="surface metric-card"><span>失败运行</span><strong>{summary.failedRuns}</strong><small>按执行事件分类</small></div>
      </section>
      <div className="governance-grid">
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>执行趋势</h2><span>按日汇总的运行结果</span></div></div><Table size="small" loading={loading} rowKey="date" pagination={false} dataSource={analytics?.trend.slice(-10)} columns={[{ title: "日期", dataIndex: "date" }, { title: "总计", dataIndex: "total", width: 70 }, { title: "通过", dataIndex: "success", width: 70 }, { title: "失败", dataIndex: "failed", width: 70 }, { title: "取消", dataIndex: "canceled", width: 70 }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无已结束运行" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>失败归类</h2><span>从运行事件自动归并</span></div></div><Table size="small" loading={loading} rowKey="category" pagination={false} dataSource={analytics?.failureCategories} columns={[{ title: "类别", dataIndex: "category" }, { title: "次数", dataIndex: "count", width: 80 }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无失败归类" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>慢步骤</h2><span>按平均耗时排序</span></div></div><Table size="small" loading={loading} rowKey="stepId" pagination={false} dataSource={analytics?.slowSteps.slice(0, 8)} columns={[{ title: "步骤", render: (_, item) => <span><strong>{item.title}</strong><small className="table-secondary">{item.stepId}</small></span> }, { title: "平均", dataIndex: "averageMs", width: 90, render: (value: number) => `${value} ms` }, { title: "最大", dataIndex: "maxMs", width: 90, render: (value: number) => `${value} ms` }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待带耗时的步骤事件" /> }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>元素影响</h2><span>引用频率与失败关联</span></div></div><Table size="small" loading={loading} rowKey="elementId" pagination={false} dataSource={analytics?.elementImpact.slice(0, 8)} columns={[{ title: "元素", dataIndex: "name" }, { title: "运行", dataIndex: "runCount", width: 70 }, { title: "流程", dataIndex: "flowCount", width: 70 }, { title: "失败", dataIndex: "failedRuns", width: 70, render: (value: number) => <Tag color={value ? "error" : "success"}>{value}</Tag> }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无元素使用记录" /> }} /></section>
        <section className="surface governance-panel governance-audit"><div className="panel-heading"><div><h2>发布审计</h2><span>版本发布与回滚记录</span></div></div><Table size="small" loading={loading} tableLayout="fixed" rowKey="id" pagination={false} dataSource={releases} columns={[{ title: "操作", dataIndex: "action", width: 112 }, { title: "操作者", dataIndex: "actorId", width: 60 }, { title: "时间", dataIndex: "createdAt", width: 75, render: (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无发布审计记录" /> }} /></section>
      </div>
    </>
  );
}
