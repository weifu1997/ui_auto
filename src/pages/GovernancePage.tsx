import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import { addWorkspaceMember, getPlatformAnalytics, getPlatformAuditEvents, getWorkspaceMembers, updateWorkspaceMember } from "../platform-api";
import type { PlatformAnalytics, PlatformAuditEvent, PlatformMember, PlatformSession } from "../platform-api";
import { readPlatformProjectMap, readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../platform-context";
import { PageHeading, PlatformProjectRequired } from "./shared";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Select, Table, Tag, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

export function GovernancePage({ project }: { project: Project }) {
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [analytics, setAnalytics] = useState<PlatformAnalytics>();
  const [members, setMembers] = useState<PlatformMember[]>([]);
  const [auditEvents, setAuditEvents] = useState<PlatformAuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const [invitation, setInvitation] = useState<{ token: string; expiresAt?: string }>();
  const [memberForm] = Form.useForm();
  const platformProjectId = platformProjectMap[project.id];
  const workspaceId = readStoredPlatformWorkspaceId(platformSession);
  const currentRole = platformSession?.workspaces.find((workspace) => workspace.id === workspaceId)?.role;
  const canAdmin = currentRole === "owner" || currentRole === "admin";

  const loadGovernance = useCallback(async () => {
    if (!platformSession || !platformProjectId || !workspaceId) return;
    setLoading(true);
    try {
      const [analyticsResponse, memberResponse, auditResponse] = await Promise.all([
        getPlatformAnalytics(platformSession.token, platformProjectId),
        getWorkspaceMembers(platformSession.token, workspaceId),
        getPlatformAuditEvents(platformSession.token, platformProjectId),
      ]);
      setAnalytics(analyticsResponse.analytics);
      setMembers(memberResponse.members);
      setAuditEvents(auditResponse.events);
    } catch {
      message.error("无法读取治理与质量数据");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, platformSession, workspaceId]);

  useEffect(() => { void loadGovernance(); }, [loadGovernance]);
  if (!platformSession || !platformProjectId || !workspaceId) return <PlatformProjectRequired project={project} title="治理分析" description="查看质量趋势、发布审计与工作空间角色。" />;

  const summary = analytics?.summary ?? { totalRuns: 0, successRate: 0, failedRuns: 0 };
  const releases = auditEvents.filter((event) => event.action.startsWith("flow_revision.")).slice(0, 12);
  const updateRole = async (member: PlatformMember, role: PlatformMember["role"]) => {
    try {
      await updateWorkspaceMember(platformSession.token, workspaceId, member.id, role);
      await loadGovernance();
      message.success("成员角色已更新");
    } catch {
      message.error("成员角色更新失败");
    }
  };

  return (
    <>
      <PageHeading title="治理分析" description="聚合已冻结运行快照、步骤事件和发布审计；质量指标不读取密钥或原始通知配置。" actions={<Tooltip title="刷新治理数据"><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadGovernance()} /></Tooltip>} />
      <section className="metric-grid governance-metrics">
        <div className="surface metric-card"><span>运行总数</span><strong>{summary.totalRuns}</strong><small>最近 500 次平台运行</small></div>
        <div className="surface metric-card"><span>成功率</span><strong>{summary.successRate}%</strong><small>已结束运行</small></div>
        <div className="surface metric-card"><span>失败运行</span><strong>{summary.failedRuns}</strong><small>按 Agent 回传分类</small></div>
      </section>
      <div className="governance-grid">
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>执行趋势</h2><span>按日汇总的运行结果</span></div></div><Table size="small" rowKey="date" pagination={false} dataSource={analytics?.trend.slice(-10)} columns={[{ title: "日期", dataIndex: "date" }, { title: "总计", dataIndex: "total", width: 70 }, { title: "通过", dataIndex: "success", width: 70 }, { title: "失败", dataIndex: "failed", width: 70 }, { title: "取消", dataIndex: "canceled", width: 70 }]} locale={{ emptyText: "尚无已结束运行" }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>失败归类</h2><span>从运行事件自动归并</span></div></div><Table size="small" rowKey="category" pagination={false} dataSource={analytics?.failureCategories} columns={[{ title: "类别", dataIndex: "category" }, { title: "次数", dataIndex: "count", width: 80 }]} locale={{ emptyText: "尚无失败归类" }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>慢步骤</h2><span>按平均耗时排序</span></div></div><Table size="small" rowKey="stepId" pagination={false} dataSource={analytics?.slowSteps.slice(0, 8)} columns={[{ title: "步骤", render: (_, item) => <span><strong>{item.title}</strong><small className="table-secondary">{item.stepId}</small></span> }, { title: "平均", dataIndex: "averageMs", width: 90, render: (value: number) => `${value} ms` }, { title: "最大", dataIndex: "maxMs", width: 90, render: (value: number) => `${value} ms` }]} locale={{ emptyText: "等待带耗时的步骤事件" }} /></section>
        <section className="surface governance-panel"><div className="panel-heading"><div><h2>元素影响</h2><span>引用频率与失败关联</span></div></div><Table size="small" rowKey="elementId" pagination={false} dataSource={analytics?.elementImpact.slice(0, 8)} columns={[{ title: "元素", dataIndex: "name" }, { title: "运行", dataIndex: "runCount", width: 70 }, { title: "流程", dataIndex: "flowCount", width: 70 }, { title: "失败", dataIndex: "failedRuns", width: 70, render: (value: number) => <Tag color={value ? "error" : "success"}>{value}</Tag> }]} locale={{ emptyText: "尚无元素使用记录" }} /></section>
        <section className="surface governance-panel governance-members"><div className="panel-heading"><div><h2>工作空间成员</h2><span>角色决定发布与平台配置权限</span></div><Button icon={<PlusOutlined />} disabled={!canAdmin} onClick={() => { memberForm.resetFields(); memberForm.setFieldsValue({ role: "viewer" }); setMemberOpen(true); }}>添加成员</Button></div><Table size="small" rowKey="id" pagination={false} dataSource={members} columns={[{ title: "成员", render: (_, member) => <span><strong>{member.name}</strong><small className="table-secondary">{member.email}</small></span> }, { title: "角色", width: 130, render: (_, member) => <Select size="small" value={member.role} disabled={!canAdmin || (member.role === "owner" && currentRole !== "owner")} onChange={(role: PlatformMember["role"]) => void updateRole(member, role)} options={["owner", "admin", "editor", "viewer"].map((role) => ({ value: role, label: role }))} /> }]} /></section>
        <section className="surface governance-panel governance-audit"><div className="panel-heading"><div><h2>发布审计</h2><span>版本发布与回滚记录</span></div></div><Table size="small" tableLayout="fixed" rowKey="id" pagination={false} dataSource={releases} columns={[{ title: "操作", dataIndex: "action", width: 112 }, { title: "操作者", dataIndex: "actorId", width: 60 }, { title: "时间", dataIndex: "createdAt", width: 75, render: (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) }]} locale={{ emptyText: "尚无发布审计记录" }} /></section>
      </div>
      <Modal title="添加工作空间成员" open={memberOpen} okText="添加成员" onCancel={() => setMemberOpen(false)} onOk={() => memberForm.validateFields().then(async (values) => { try { const result = await addWorkspaceMember(platformSession.token, workspaceId, values); setMemberOpen(false); if (result.invitationToken) setInvitation({ token: result.invitationToken, expiresAt: result.invitationExpiresAt }); await loadGovernance(); message.success(result.invitationToken ? "成员已添加，请交付邀请令牌" : "成员已添加"); } catch { message.error("成员添加失败"); } })}><Form form={memberForm} layout="vertical"><Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}><Input autoFocus /></Form.Item><Form.Item name="name" label="姓名"><Input /></Form.Item><Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={["admin", "editor", "viewer"].map((role) => ({ value: role, label: role }))} /></Form.Item></Form></Modal>
      <Modal title="成员邀请令牌" open={Boolean(invitation)} footer={<Button onClick={() => setInvitation(undefined)}>关闭</Button>} onCancel={() => setInvitation(undefined)}>
        <Input.TextArea value={invitation ? `${invitation.token}${invitation.expiresAt ? `\n有效至 ${new Date(invitation.expiresAt).toLocaleString()}` : ""}` : ""} readOnly autoSize onFocus={(event) => event.currentTarget.select()} />
      </Modal>
    </>
  );
}
