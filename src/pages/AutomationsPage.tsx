import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import { createPlatformNotificationChannel, createPlatformSchedule, createPlatformWebhookTrigger, getPlatformDatasets, getPlatformDeliveries, getPlatformNotificationChannels, getPlatformNotificationSubscriptions, getPlatformRevisions, getPlatformSchedules, getPlatformWebhookTriggers, platformApiOrigin, savePlatformNotificationSubscription, scheduleAction, webhookTriggerAction } from "../platform-api";
import type { PlatformDataset, PlatformDelivery, PlatformNotificationChannel, PlatformNotificationSubscription, PlatformRevision, PlatformSchedule, PlatformSession, PlatformWebhookTrigger } from "../platform-api";
import { readPlatformProjectMap, readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../platform-context";
import { PageHeading, PlatformProjectRequired } from "./shared";
import { useWorkspaceStore } from "../workspace-store";
import { PlayCircleFilled, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Modal, Select, Switch, Table, Tag, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

export function AutomationsPage({ project }: { project: Project }) {
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? []);
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [datasets, setDatasets] = useState<PlatformDataset[]>([]);
  const [schedules, setSchedules] = useState<PlatformSchedule[]>([]);
  const [triggers, setTriggers] = useState<PlatformWebhookTrigger[]>([]);
  const [channels, setChannels] = useState<PlatformNotificationChannel[]>([]);
  const [subscriptions, setSubscriptions] = useState<PlatformNotificationSubscription[]>([]);
  const [deliveries, setDeliveries] = useState<PlatformDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [createdWebhookUrl, setCreatedWebhookUrl] = useState<string>();
  const [scheduleForm] = Form.useForm();
  const [triggerForm] = Form.useForm();
  const [channelForm] = Form.useForm();
  const platformProjectId = platformProjectMap[project.id];
  const workspaceId = readStoredPlatformWorkspaceId(platformSession);
  const publishedRevisions = revisions.filter((revision) => revision.status === "published");
  const datasetOptions = datasets.flatMap((dataset) => dataset.latestVersion ? [{ value: dataset.latestVersion.id, label: `${dataset.name} v${dataset.latestVersion.versionNumber} (${dataset.latestVersion.rowCount} 行)` }] : []);
  const scheduleRevisionId = Form.useWatch("revisionId", scheduleForm);
  const triggerRevisionId = Form.useWatch("revisionId", triggerForm);
  const selectedAutomationEnvironmentIds = new Set(
    [scheduleRevisionId, triggerRevisionId]
      .map((revisionId) => publishedRevisions.find((revision) => revision.id === revisionId)?.environmentId)
      .filter((environmentId): environmentId is string => Boolean(environmentId)),
  );
  const environmentOptions = environments
    .filter((environment) => selectedAutomationEnvironmentIds.size === 0 || selectedAutomationEnvironmentIds.has(environment.id))
    .map((environment) => ({ value: environment.id, label: environment.name }));

  useEffect(() => {
    const environmentId = publishedRevisions.find((revision) => revision.id === scheduleRevisionId)?.environmentId;
    if (environmentId && scheduleForm.getFieldValue("environmentId") !== environmentId) {
      scheduleForm.setFieldsValue({ environmentId });
    }
  }, [publishedRevisions, scheduleForm, scheduleRevisionId]);

  useEffect(() => {
    const environmentId = publishedRevisions.find((revision) => revision.id === triggerRevisionId)?.environmentId;
    if (environmentId && triggerForm.getFieldValue("environmentId") !== environmentId) {
      triggerForm.setFieldsValue({ environmentId });
    }
  }, [publishedRevisions, triggerForm, triggerRevisionId]);

  const loadAutomations = useCallback(async () => {
    if (!platformSession || !platformProjectId || !workspaceId) return;
    setLoading(true);
    try {
      const [revisionResponse, datasetResponse, scheduleResponse, triggerResponse, channelResponse, subscriptionResponse, deliveryResponse] = await Promise.all([
        getPlatformRevisions(platformSession.token, platformProjectId), getPlatformDatasets(platformSession.token, platformProjectId), getPlatformSchedules(platformSession.token, platformProjectId), getPlatformWebhookTriggers(platformSession.token, platformProjectId), getPlatformNotificationChannels(platformSession.token, workspaceId), getPlatformNotificationSubscriptions(platformSession.token, platformProjectId), getPlatformDeliveries(platformSession.token, platformProjectId),
      ]);
      setRevisions(revisionResponse.revisions); setDatasets(datasetResponse.datasets); setSchedules(scheduleResponse.schedules); setTriggers(triggerResponse.triggers); setChannels(channelResponse.channels); setSubscriptions(subscriptionResponse.subscriptions); setDeliveries(deliveryResponse.deliveries);
    } catch {
      message.error("无法读取持续回归配置");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, platformSession, workspaceId]);

  useEffect(() => { void loadAutomations(); }, [loadAutomations]);
  if (!platformSession || !platformProjectId || !workspaceId) return <PlatformProjectRequired project={project} title="持续回归" description="使用已发布流程配置计划任务、Webhook 和通知。" />;

  const revisionOptions = publishedRevisions.map((revision) => ({ value: revision.id, label: `版本 ${revision.revisionNumber}` }));
  const subscriptionRows = channels.map((channel) => ({ channel, subscription: subscriptions.find((item) => item.channelId === channel.id) }));
  const saveSubscription = async (channelId: string, next: Partial<Pick<PlatformNotificationSubscription, "onSuccess" | "onFailure">>) => {
    const current = subscriptions.find((item) => item.channelId === channelId);
    try {
      await savePlatformNotificationSubscription(platformSession.token, platformProjectId, { channelId, onSuccess: next.onSuccess ?? current?.onSuccess ?? false, onFailure: next.onFailure ?? current?.onFailure ?? true });
      await loadAutomations();
    } catch { message.error("通知订阅保存失败"); }
  };

  return (
    <>
      <PageHeading title="持续回归" description="计划任务与 Webhook 只能引用已发布流程；每次执行固定版本、环境、数据集和节点快照。" actions={<Tooltip title="刷新自动化状态"><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadAutomations()} /></Tooltip>} />
      <div className="automation-grid">
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>计划任务</h2><span>Cron 在指定时区创建参数化运行</span></div><Button type="primary" icon={<PlusOutlined />} disabled={!publishedRevisions.some((revision) => revision.environmentId)} onClick={() => { const revision = publishedRevisions[0]; scheduleForm.setFieldsValue({ revisionId: revision?.id, environmentId: revision?.environmentId, timezone: "Asia/Shanghai", cron: "0 9 * * 1-5" }); setScheduleOpen(true); }}>新建</Button></div><Table size="small" rowKey="id" pagination={false} dataSource={schedules} columns={[{ title: "名称", dataIndex: "name" }, { title: "Cron", dataIndex: "cron", width: 130 }, { title: "下次", dataIndex: "nextRunAt", width: 160, render: (value: string) => new Date(value).toLocaleString() }, { title: "启用", width: 75, render: (_, item) => <Switch size="small" checked={item.enabled} onChange={(checked) => void scheduleAction(platformSession.token, platformProjectId, item.id, checked ? "enable" : "disable").then(loadAutomations).catch(() => message.error("计划任务更新失败"))} /> }, { title: "", width: 42, render: (_, item) => <Tooltip title="立即执行"><Button size="small" icon={<PlayCircleFilled />} onClick={() => void scheduleAction(platformSession.token, platformProjectId, item.id, "run").then(() => { message.success("已创建运行"); return loadAutomations(); }).catch(() => message.error("无法创建计划运行"))} /></Tooltip> }]} locale={{ emptyText: "尚无计划任务" }} /></section>
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>Webhook</h2><span>用于 CI 与外部质量门禁</span></div><Button icon={<PlusOutlined />} disabled={!publishedRevisions.some((revision) => revision.environmentId)} onClick={() => { const revision = publishedRevisions[0]; triggerForm.setFieldsValue({ revisionId: revision?.id, environmentId: revision?.environmentId }); setTriggerOpen(true); }}>新建</Button></div><Table size="small" rowKey="id" pagination={false} dataSource={triggers} columns={[{ title: "名称", dataIndex: "name" }, { title: "最近触发", dataIndex: "lastTriggeredAt", render: (value: string | null) => value ? new Date(value).toLocaleString() : "从未" }, { title: "启用", width: 75, render: (_, item) => <Switch size="small" checked={item.enabled} onChange={(checked) => void webhookTriggerAction(platformSession.token, platformProjectId, item.id, checked ? "enable" : "disable").then(loadAutomations).catch(() => message.error("Webhook 更新失败"))} /> }]} locale={{ emptyText: "尚无 Webhook" }} /></section>
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>通知通道</h2><span>Webhook、飞书、钉钉、企业微信或邮件中继</span></div><Button icon={<PlusOutlined />} onClick={() => { channelForm.resetFields(); channelForm.setFieldsValue({ type: "webhook" }); setChannelOpen(true); }}>添加</Button></div><Table size="small" rowKey={({ channel }) => channel.id} pagination={false} dataSource={subscriptionRows} columns={[{ title: "通道", render: (_, row) => <span><strong>{row.channel.name}</strong><small className="table-secondary">{row.channel.type}</small></span> }, { title: "成功", width: 72, render: (_, row) => <Switch size="small" checked={row.subscription?.onSuccess ?? false} disabled={!row.channel.enabled} onChange={(onSuccess) => void saveSubscription(row.channel.id, { onSuccess })} /> }, { title: "失败", width: 72, render: (_, row) => <Switch size="small" checked={row.subscription?.onFailure ?? false} disabled={!row.channel.enabled} onChange={(onFailure) => void saveSubscription(row.channel.id, { onFailure })} /> }]} locale={{ emptyText: "尚无通知通道" }} /></section>
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>投递记录</h2><span>不包含密钥和运行参数</span></div></div><Table size="small" rowKey="id" pagination={false} dataSource={deliveries.slice(0, 8)} columns={[{ title: "通道", dataIndex: ["channel", "name"] }, { title: "状态", dataIndex: "status", width: 95, render: (status: PlatformDelivery["status"]) => <Tag color={status === "delivered" ? "success" : status === "failed" ? "error" : "processing"}>{status}</Tag> }, { title: "时间", dataIndex: "createdAt", width: 160, render: (value: string) => new Date(value).toLocaleString() }]} locale={{ emptyText: "尚无投递记录" }} /></section>
      </div>
      <Modal title="新建计划任务" open={scheduleOpen} okText="创建计划" onCancel={() => setScheduleOpen(false)} onOk={() => scheduleForm.validateFields().then(async (values) => { try { await createPlatformSchedule(platformSession.token, platformProjectId, values); setScheduleOpen(false); await loadAutomations(); message.success("计划任务已创建"); } catch { message.error("计划任务创建失败，请检查 Cron 和版本状态"); } })}><Form form={scheduleForm} layout="vertical"><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="revisionId" label="已发布版本" rules={[{ required: true }]}><Select options={revisionOptions} /></Form.Item><Form.Item name="environmentId" label="环境" rules={[{ required: true }]}><Select options={environmentOptions} /></Form.Item><Form.Item name="datasetVersionId" label="数据集版本"><Select allowClear options={datasetOptions} /></Form.Item><Form.Item name="cron" label="Cron" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="timezone" label="时区" rules={[{ required: true }]}><Input /></Form.Item></Form></Modal>
      <Modal title="新建 Webhook" open={triggerOpen} okText="创建 Webhook" onCancel={() => setTriggerOpen(false)} onOk={() => triggerForm.validateFields().then(async (values) => { try { const result = await createPlatformWebhookTrigger(platformSession.token, platformProjectId, values); setTriggerOpen(false); setCreatedWebhookUrl(`${platformApiOrigin()}${result.triggerUrl}\n\nSigning secret:\n${result.signingSecret}`); await loadAutomations(); } catch { message.error("Webhook 创建失败"); } })}><Form form={triggerForm} layout="vertical"><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="revisionId" label="已发布版本" rules={[{ required: true }]}><Select options={revisionOptions} /></Form.Item><Form.Item name="environmentId" label="环境" rules={[{ required: true }]}><Select options={environmentOptions} /></Form.Item><Form.Item name="datasetVersionId" label="数据集版本"><Select allowClear options={datasetOptions} /></Form.Item></Form></Modal>
      <Modal title="Webhook 地址" open={Boolean(createdWebhookUrl)} footer={<Button onClick={() => setCreatedWebhookUrl(undefined)}>关闭</Button>} onCancel={() => setCreatedWebhookUrl(undefined)}><Alert type="warning" showIcon title="地址仅在创建时展示，请写入 CI 密钥配置。" /><Input.TextArea className="webhook-url" value={createdWebhookUrl} readOnly autoSize onFocus={(event) => event.currentTarget.select()} /></Modal>
      <Modal title="添加通知通道" open={channelOpen} okText="保存通道" onCancel={() => setChannelOpen(false)} onOk={() => channelForm.validateFields().then(async (values) => { try { await createPlatformNotificationChannel(platformSession.token, workspaceId, values); setChannelOpen(false); await loadAutomations(); message.success("通知通道已加密保存"); } catch { message.error("通知通道保存失败"); } })}><Form form={channelForm} layout="vertical"><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="type" label="类型" rules={[{ required: true }]}><Select options={["webhook", "feishu", "dingtalk", "wecom", "email"].map((type) => ({ value: type, label: type }))} /></Form.Item><Form.Item name="url" label="投递地址" rules={[{ required: true, type: "url" }]}><Input /></Form.Item></Form></Modal>
    </>
  );
}
