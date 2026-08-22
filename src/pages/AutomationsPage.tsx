import { message } from "../lib/antd-feedback";
import type { Project } from "../lib/mock-data";
import { archivePlatformNotificationChannel, archivePlatformSchedule, archivePlatformWebhookTrigger, createPlatformNotificationChannel, createPlatformSchedule, createPlatformWebhookTrigger, getPlatformDatasets, getPlatformDeliveries, getPlatformNotificationChannels, getPlatformNotificationSubscriptions, getPlatformRevisions, getPlatformSchedules, getPlatformWebhookTriggers, platformApiOrigin, rotatePlatformWebhookSecret, savePlatformNotificationSubscription, scheduleAction, testPlatformNotificationChannel, updatePlatformNotificationChannel, updatePlatformSchedule, updatePlatformWebhookTrigger, webhookTriggerAction } from "../api/platform-api";
import type { PlatformDataset, PlatformDelivery, PlatformNotificationChannel, PlatformNotificationSubscription, PlatformRevision, PlatformSchedule, PlatformSession, PlatformWebhookTrigger } from "../api/platform-api";
import { readPlatformProjectMap, readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../api/platform-context";
import { useLocation, useNavigate } from "../router";
import { FilterBar, FilterItem, PageHeading, PlatformProjectRequired, emptyEnvironments } from "./shared";
import { useWorkspaceStore } from "../stores/workspace-store";
import { DeleteOutlined, EditOutlined, ExperimentOutlined, PlayCircleFilled, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, Empty } from "antd";
import { useCallback, useEffect, useState } from "react";

export function AutomationsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const location = useLocation();
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? emptyEnvironments);
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [datasets, setDatasets] = useState<PlatformDataset[]>([]);
  const [schedules, setSchedules] = useState<PlatformSchedule[]>([]);
  const [triggers, setTriggers] = useState<PlatformWebhookTrigger[]>([]);
  const [channels, setChannels] = useState<PlatformNotificationChannel[]>([]);
  const [subscriptions, setSubscriptions] = useState<PlatformNotificationSubscription[]>([]);
  const [deliveries, setDeliveries] = useState<PlatformDelivery[]>([]);
  const [deliveryPage, setDeliveryPage] = useState(() => Math.max(1, Number(new URLSearchParams(location.search).get("deliveryPage") ?? "1") || 1));
  const [deliveryStatus, setDeliveryStatus] = useState(() => new URLSearchParams(location.search).get("deliveryStatus") ?? "");
  const [deliveryChannel, setDeliveryChannel] = useState(() => new URLSearchParams(location.search).get("deliveryChannel") ?? "");
  const [deliveryFrom, setDeliveryFrom] = useState(() => new URLSearchParams(location.search).get("deliveryFrom") ?? "");
  const [deliveryTo, setDeliveryTo] = useState(() => new URLSearchParams(location.search).get("deliveryTo") ?? "");
  const [deliveryTotal, setDeliveryTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<PlatformSchedule | null>(null);
  const [editingTrigger, setEditingTrigger] = useState<PlatformWebhookTrigger | null>(null);
  const [editingChannel, setEditingChannel] = useState<PlatformNotificationChannel | null>(null);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [rotatingTriggerId, setRotatingTriggerId] = useState<string | null>(null);
  const [createdWebhookUrl, setCreatedWebhookUrl] = useState<string>();
  const [scheduleForm] = Form.useForm();
  const [triggerForm] = Form.useForm();
  const [channelForm] = Form.useForm();
  const platformProjectId = platformProjectMap[project.id] ?? project.id;
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
        getPlatformRevisions(platformSession.token, platformProjectId), getPlatformDatasets(platformSession.token, platformProjectId), getPlatformSchedules(platformSession.token, platformProjectId), getPlatformWebhookTriggers(platformSession.token, platformProjectId), getPlatformNotificationChannels(platformSession.token, workspaceId), getPlatformNotificationSubscriptions(platformSession.token, platformProjectId), getPlatformDeliveries(platformSession.token, platformProjectId, {
          page: deliveryPage,
          pageSize: 8,
          status: deliveryStatus || undefined,
          channel: deliveryChannel || undefined,
          from: deliveryFrom || undefined,
          to: deliveryTo || undefined,
        }),
      ]);
      setRevisions(revisionResponse.revisions); setDatasets(datasetResponse.datasets); setSchedules(scheduleResponse.schedules); setTriggers(triggerResponse.triggers); setChannels(channelResponse.channels); setSubscriptions(subscriptionResponse.subscriptions); setDeliveries(deliveryResponse.deliveries); setDeliveryTotal(deliveryResponse.total);
    } catch {
      message.error("无法读取持续回归配置");
    } finally {
      setLoading(false);
    }
  }, [deliveryChannel, deliveryFrom, deliveryPage, deliveryStatus, deliveryTo, platformProjectId, platformSession, workspaceId]);

  useEffect(() => { void loadAutomations(); }, [loadAutomations]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (deliveryPage > 1) params.set("deliveryPage", String(deliveryPage));
    if (deliveryStatus) params.set("deliveryStatus", deliveryStatus);
    if (deliveryChannel) params.set("deliveryChannel", deliveryChannel);
    if (deliveryFrom) params.set("deliveryFrom", deliveryFrom);
    if (deliveryTo) params.set("deliveryTo", deliveryTo);
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, { replace: true });
  }, [deliveryChannel, deliveryFrom, deliveryPage, deliveryStatus, deliveryTo, location.pathname, navigate]);
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
      <PageHeading title="持续回归" description="计划任务与 Webhook 只能引用已发布流程；每次执行固定版本、环境、数据集和节点快照。" actions={<Tooltip title="刷新自动化状态"><Button icon={<ReloadOutlined />} aria-label="刷新自动化状态" loading={loading} onClick={() => void loadAutomations()} /></Tooltip>} />
      <div className="automation-grid">
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>计划任务</h2><span>Cron 在指定时区创建参数化运行</span></div><Button icon={<PlusOutlined />} disabled={!publishedRevisions.some((revision) => revision.environmentId)} onClick={() => { const revision = publishedRevisions[0]; setEditingSchedule(null); scheduleForm.setFieldsValue({ revisionId: revision?.id, environmentId: revision?.environmentId, timezone: "Asia/Shanghai", cron: "0 9 * * 1-5" }); setScheduleOpen(true); }}>新建</Button></div><Table size="small" loading={loading} rowKey="id" pagination={false} dataSource={schedules} columns={[{ title: "名称", dataIndex: "name" }, { title: "Cron", dataIndex: "cron", width: 130 }, { title: "下次", dataIndex: "nextRunAt", width: 160, render: (value: string) => new Date(value).toLocaleString() }, { title: "启用", width: 75, render: (_, item) => <Switch size="small" checked={item.enabled} onChange={(checked) => void scheduleAction(platformSession.token, platformProjectId, item.id, checked ? "enable" : "disable").then(loadAutomations).catch(() => message.error("计划任务更新失败"))} /> }, { title: "", width: 132, render: (_, item) => <Space size={2}><Tooltip title="编辑计划任务"><Button size="small" icon={<EditOutlined />} aria-label={`编辑计划 ${item.name}`} onClick={() => { setEditingSchedule(item); scheduleForm.setFieldsValue({ name: item.name, revisionId: item.revisionId, environmentId: item.environmentId, datasetVersionId: item.datasetVersionId, cron: item.cron, timezone: item.timezone }); setScheduleOpen(true); }} /></Tooltip><Tooltip title="立即执行"><Button size="small" icon={<PlayCircleFilled />} aria-label={`立即执行 ${item.name}`} onClick={() => void scheduleAction(platformSession.token, platformProjectId, item.id, "run").then(() => { message.success("已创建运行"); return loadAutomations(); }).catch(() => message.error("无法创建计划运行"))} /></Tooltip><Popconfirm title="归档该计划任务？" onConfirm={() => archivePlatformSchedule(platformSession.token, platformProjectId, item.id).then(loadAutomations).then(() => message.success("计划任务已归档")).catch(() => message.error("归档失败"))}><Button size="small" danger aria-label={`归档计划 ${item.name}`} icon={<DeleteOutlined />} /></Popconfirm></Space> }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无计划任务" /> }} /></section>
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>Webhook</h2><span>用于 CI 与外部质量门禁</span></div><Button icon={<PlusOutlined />} disabled={!publishedRevisions.some((revision) => revision.environmentId)} onClick={() => { const revision = publishedRevisions[0]; setEditingTrigger(null); triggerForm.setFieldsValue({ revisionId: revision?.id, environmentId: revision?.environmentId }); setTriggerOpen(true); }}>新建</Button></div><Table size="small" loading={loading} rowKey="id" pagination={false} dataSource={triggers} columns={[{ title: "名称", dataIndex: "name" }, { title: "最近触发", dataIndex: "lastTriggeredAt", render: (value: string | null) => value ? new Date(value).toLocaleString() : "从未" }, { title: "启用", width: 75, render: (_, item) => <Switch size="small" checked={item.enabled} onChange={(checked) => void webhookTriggerAction(platformSession.token, platformProjectId, item.id, checked ? "enable" : "disable").then(loadAutomations).catch(() => message.error("Webhook 更新失败"))} /> }, { title: "", width: 132, render: (_, item) => <Space size={2}><Tooltip title="编辑 Webhook"><Button size="small" icon={<EditOutlined />} aria-label={`编辑 Webhook ${item.name}`} onClick={() => { setEditingTrigger(item); triggerForm.setFieldsValue({ name: item.name, revisionId: item.revisionId, environmentId: item.environmentId, datasetVersionId: item.datasetVersionId }); setTriggerOpen(true); }} /></Tooltip><Tooltip title="轮换 Signing Secret"><Button size="small" loading={rotatingTriggerId === item.id} icon={<ReloadOutlined />} aria-label={`轮换 Webhook ${item.name}`} onClick={() => { setRotatingTriggerId(item.id); void rotatePlatformWebhookSecret(platformSession.token, platformProjectId, item.id).then((result) => { setCreatedWebhookUrl(`Signing secret:\n${result.signingSecret}`); message.success("Signing secret 已轮换"); return loadAutomations(); }).catch(() => message.error("密钥轮换失败")).finally(() => setRotatingTriggerId(null)); }} /></Tooltip><Popconfirm title="归档该 Webhook？" onConfirm={() => archivePlatformWebhookTrigger(platformSession.token, platformProjectId, item.id).then(loadAutomations).then(() => message.success("Webhook 已归档")).catch(() => message.error("归档失败"))}><Button size="small" danger aria-label={`归档 Webhook ${item.name}`} icon={<DeleteOutlined />} /></Popconfirm></Space> }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无 Webhook" /> }} /></section>
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>通知通道</h2><span>Webhook、飞书、钉钉、企业微信或邮件中继</span></div><Button icon={<PlusOutlined />} onClick={() => { setEditingChannel(null); channelForm.resetFields(); channelForm.setFieldsValue({ type: "webhook" }); setChannelOpen(true); }}>添加</Button></div><Table size="small" loading={loading} rowKey={({ channel }) => channel.id} pagination={false} dataSource={subscriptionRows} columns={[{ title: "通道", render: (_, row) => <span><strong>{row.channel.name}</strong><small className="table-secondary">{row.channel.type}</small></span> }, { title: "成功", width: 72, render: (_, row) => <Switch size="small" checked={row.subscription?.onSuccess ?? false} disabled={!row.channel.enabled} onChange={(onSuccess) => void saveSubscription(row.channel.id, { onSuccess })} /> }, { title: "失败", width: 72, render: (_, row) => <Switch size="small" checked={row.subscription?.onFailure ?? false} disabled={!row.channel.enabled} onChange={(onFailure) => void saveSubscription(row.channel.id, { onFailure })} /> }, { title: "", width: 132, render: (_, row) => <Space size={2}><Tooltip title="编辑通知通道"><Button size="small" icon={<EditOutlined />} aria-label={`编辑通知 ${row.channel.name}`} onClick={() => { setEditingChannel(row.channel); channelForm.setFieldsValue({ name: row.channel.name, type: row.channel.type, enabled: row.channel.enabled, url: "", keyword: "" }); setChannelOpen(true); }} /></Tooltip><Tooltip title="发送测试通知"><Button size="small" loading={testingChannelId === row.channel.id} icon={<ExperimentOutlined />} aria-label={`测试通知 ${row.channel.name}`} onClick={() => { setTestingChannelId(row.channel.id); void testPlatformNotificationChannel(platformSession.token, workspaceId, row.channel.id).then((result) => { if (result.error) message.error(`测试通知失败：${result.error}`); else message.success("测试通知已发送"); }).catch(() => message.error("测试通知失败")).finally(() => setTestingChannelId(null)); }} /></Tooltip><Popconfirm title="归档该通知通道？" onConfirm={() => archivePlatformNotificationChannel(platformSession.token, workspaceId, row.channel.id).then(loadAutomations).then(() => message.success("通知通道已归档")).catch(() => message.error("归档失败"))}><Button size="small" danger aria-label={`归档通知 ${row.channel.name}`} icon={<DeleteOutlined />} /></Popconfirm></Space> }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无通知通道" /> }} /></section>
        <section className="surface automation-panel"><div className="panel-heading"><div><h2>投递记录</h2><span>不包含密钥和运行参数</span></div></div><FilterBar>
  <FilterItem label="状态">
    <Select aria-label="投递状态" value={deliveryStatus} style={{ width: 110 }} onChange={(value) => { setDeliveryPage(1); setDeliveryStatus(value); }} options={[{ value: "", label: "全部" }, { value: "pending", label: "pending" }, { value: "retrying", label: "retrying" }, { value: "delivering", label: "delivering" }, { value: "delivered", label: "delivered" }, { value: "failed", label: "failed" }]} />
  </FilterItem>
  <FilterItem label="通道">
    <Input aria-label="投递通道" value={deliveryChannel} style={{ width: 150 }} placeholder="通道名称" allowClear onChange={(event) => { setDeliveryPage(1); setDeliveryChannel(event.target.value); }} />
  </FilterItem>
  <FilterItem label="开始">
    <Input type="date" aria-label="投递开始日期" value={deliveryFrom} onChange={(event) => { setDeliveryPage(1); setDeliveryFrom(event.target.value); }} />
  </FilterItem>
  <FilterItem label="结束">
    <Input type="date" aria-label="投递结束日期" value={deliveryTo} onChange={(event) => { setDeliveryPage(1); setDeliveryTo(event.target.value); }} />
  </FilterItem>
</FilterBar><Table size="small" loading={loading} rowKey="id" dataSource={deliveries} pagination={{ current: deliveryPage, pageSize: 8, total: deliveryTotal, showSizeChanger: false, onChange: (nextPage) => setDeliveryPage(nextPage) }} columns={[{ title: "通道", dataIndex: ["channel", "name"] }, { title: "状态", dataIndex: "status", width: 95, render: (status: PlatformDelivery["status"]) => <Tag color={status === "delivered" ? "success" : status === "failed" ? "error" : "processing"}>{status}</Tag> }, { title: "时间", dataIndex: "createdAt", width: 160, render: (value: string) => new Date(value).toLocaleString() }]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无投递记录" /> }} /></section>
      </div>
      <Modal title={editingSchedule ? "编辑计划任务" : "新建计划任务"} open={scheduleOpen} okText={editingSchedule ? "保存计划" : "创建计划"} onCancel={() => { setScheduleOpen(false); setEditingSchedule(null); }} onOk={() => scheduleForm.validateFields().then(async (values) => { try { if (editingSchedule) await updatePlatformSchedule(platformSession.token, platformProjectId, editingSchedule.id, values); else await createPlatformSchedule(platformSession.token, platformProjectId, values); setScheduleOpen(false); setEditingSchedule(null); await loadAutomations(); message.success(editingSchedule ? "计划任务已更新" : "计划任务已创建"); } catch { message.error("计划任务保存失败，请检查 Cron 和版本状态"); } })}><Form form={scheduleForm} layout="vertical"><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="revisionId" label="已发布版本" rules={[{ required: true }]}><Select options={revisionOptions} /></Form.Item><Form.Item name="environmentId" label="环境" rules={[{ required: true }]}><Select options={environmentOptions} /></Form.Item><Form.Item name="datasetVersionId" label="数据集版本"><Select allowClear options={datasetOptions} /></Form.Item><Form.Item name="cron" label="Cron" rules={[{ required: true }, { pattern: /^(\S+\s+){4}\S+$/, message: "Cron 需为 5 段空格分隔的表达式，如 0 9 * * 1-5" }]}><Input placeholder="分 时 日 月 周，如 0 9 * * 1-5" /></Form.Item><Form.Item name="timezone" label="时区" rules={[{ required: true }]}><Input /></Form.Item></Form></Modal>
      <Modal title={editingTrigger ? "编辑 Webhook" : "新建 Webhook"} open={triggerOpen} okText={editingTrigger ? "保存 Webhook" : "创建 Webhook"} onCancel={() => { setTriggerOpen(false); setEditingTrigger(null); }} onOk={() => triggerForm.validateFields().then(async (values) => { try { if (editingTrigger) await updatePlatformWebhookTrigger(platformSession.token, platformProjectId, editingTrigger.id, values); else { const result = await createPlatformWebhookTrigger(platformSession.token, platformProjectId, values); setCreatedWebhookUrl(`${platformApiOrigin()}${result.triggerUrl}\n\nSigning secret:\n${result.signingSecret}`); } setTriggerOpen(false); setEditingTrigger(null); await loadAutomations(); message.success(editingTrigger ? "Webhook 已更新" : "Webhook 已创建"); } catch { message.error("Webhook 保存失败"); } })}><Form form={triggerForm} layout="vertical"><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="revisionId" label="已发布版本" rules={[{ required: true }]}><Select options={revisionOptions} /></Form.Item><Form.Item name="environmentId" label="环境" rules={[{ required: true }]}><Select options={environmentOptions} /></Form.Item><Form.Item name="datasetVersionId" label="数据集版本"><Select allowClear options={datasetOptions} /></Form.Item></Form></Modal>
      <Modal title="Webhook 地址" open={Boolean(createdWebhookUrl)} footer={<Button onClick={() => setCreatedWebhookUrl(undefined)}>关闭</Button>} onCancel={() => setCreatedWebhookUrl(undefined)}><Alert type="warning" showIcon title="地址仅在创建时展示，请写入 CI 密钥配置。" /><Input.TextArea className="webhook-url" value={createdWebhookUrl} readOnly autoSize onFocus={(event) => event.currentTarget.select()} /></Modal>
      <Modal title={editingChannel ? "编辑通知通道" : "添加通知通道"} open={channelOpen} okText="保存通道" onCancel={() => { setChannelOpen(false); setEditingChannel(null); }} onOk={() => channelForm.validateFields().then(async (values) => { try { if (editingChannel) await updatePlatformNotificationChannel(platformSession.token, workspaceId, editingChannel.id, { name: values.name, type: values.type, enabled: values.enabled ?? true, url: values.url, keyword: values.keyword }); else await createPlatformNotificationChannel(platformSession.token, workspaceId, values); setChannelOpen(false); setEditingChannel(null); await loadAutomations(); message.success("通知通道已加密保存"); } catch { message.error("通知通道保存失败"); } })}><Form form={channelForm} layout="vertical"><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="type" label="类型" rules={[{ required: true }]}><Select options={["webhook", "feishu", "dingtalk", "wecom", "email"].map((type) => ({ value: type, label: type }))} /></Form.Item>{editingChannel ? <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item> : null}<Form.Item name="url" label="投递地址" rules={editingChannel ? [] : [{ required: true, type: "url" }]}><Input placeholder={editingChannel ? "留空保持不变" : "https://example.com/hook"} /></Form.Item><Form.Item name="keyword" label="自定义关键词（可选）"><Input placeholder={editingChannel ? "留空保持不变" : "飞书/钉钉/企微机器人安全设置的关键词，如：股票日报"} /></Form.Item></Form></Modal>
    </>
  );
}
