import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import { createPlatformRevision, createPlatformRun, getPlatformProjectDocument, getPlatformRevisions, importLocalWorkspace, loginPlatform, PlatformApiError, publishPlatformRevision, registerPlatform, savePlatformSecret } from "../platform-api";
import type { PlatformRevision, PlatformSession } from "../platform-api";
import { disconnectPlatformProject as clearPlatformProjectMap, notifyPlatformContextChanged, platformSessionStorageKey, readPlatformProjectMap, readStoredPlatformSession, readStoredPlatformWorkspaceId, storePlatformDocumentVersion, storePlatformProjectMap, storePlatformWorkspaceId } from "../platform-context";
import { useNavigate } from "../router";
import { useRunStore } from "../run-store";
import { PageHeading, platformRunAsRun, platformVariables, requestRunSecrets, requiredSecretVariables, variableReference } from "./shared";
import { useSecretStore } from "../secret-store";
import { useWorkspaceStore } from "../workspace-store";
import { PlayCircleFilled, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Select, Space, Table, Tag, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

const emptySecretValues: Record<string, string> = {};

export function AgentsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? []);
  const activeEnvironmentId = useWorkspaceStore((state) => state.activeEnvironmentByProject[project.id]);
  const flows = useWorkspaceStore((state) => state.flowsByProject[project.id] ?? []);
  const elements = useWorkspaceStore((state) => state.elementsByProject[project.id] ?? []);
  const variables = useWorkspaceStore((state) => state.variablesByProject[project.id] ?? []);
  const upsertRun = useRunStore((state) => state.upsertRun);
  const enablePlatformProject = useWorkspaceStore((state) => state.enablePlatformProject);
  const disconnectPlatformProject = useWorkspaceStore((state) => state.disconnectPlatformProject);
  const syncStatus = useWorkspaceStore((state) => state.platformSyncStatusById?.[project.id]);
  const syncError = useWorkspaceStore((state) => state.platformSyncErrorById?.[project.id]);
  const sessionSecretValues = useSecretStore((state) => state.valuesByProject[project.id] ?? emptySecretValues);
  const setSecretValues = useSecretStore((state) => state.setValues);
  const [session, setSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [workspaceId, setWorkspaceId] = useState(() => readStoredPlatformWorkspaceId(readStoredPlatformSession()));
  const [projectMap, setProjectMap] = useState<Record<string, string>>(() => readPlatformProjectMap(readStoredPlatformWorkspaceId(readStoredPlatformSession())));
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [loginForm] = Form.useForm();
  const [releaseForm] = Form.useForm();
  const [releaseOpen, setReleaseOpen] = useState(false);
  const platformProjectId = projectMap[project.id];
  const activeEnvironment = environments.find((environment) => environment.id === activeEnvironmentId) ?? environments[0];

  const loadRevisions = useCallback(async () => {
    if (!session || !workspaceId || !platformProjectId) return;
    setLoading(true);
    try {
      const { revisions } = await getPlatformRevisions(session.token, platformProjectId);
      setRevisions(revisions);
    } catch {
      message.error("无法读取平台版本，请检查登录状态和服务地址");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, session, workspaceId]);

  useEffect(() => {
    void loadRevisions();
  }, [loadRevisions]);

  const publishFlow = async (targetProjectId: string, flowId?: string, environmentId?: string) => {
    if (!session) return;
    const flow = flows.find((item) => item.id === (flowId ?? flows[0]?.id));
    const environment = environments.find((item) => item.id === (environmentId ?? activeEnvironment?.id)) ?? activeEnvironment;
    if (!flow?.definition?.length || !environment) {
      message.error("请选择包含步骤的流程和运行环境");
      return;
    }
    setPublishing(true);
    try {
      const requiredSecrets = requiredSecretVariables(variables, flow.definition);
      const revision = await createPlatformRevision(session.token, targetProjectId, {
        flow: {
          id: flow.id,
          name: flow.name,
          description: flow.description,
          steps: flow.definition,
          variables: platformVariables(variables),
        },
        environment,
        elements: elements.filter((item) => !item.environment || item.environment === environment.id),
        secretNames: requiredSecrets.map(variableReference),
      });
      await publishPlatformRevision(session.token, targetProjectId, revision.revision.id);
      setReleaseOpen(false);
      await loadRevisions();
      message.success(`已发布 ${flow.name} 的新版本`);
    } catch {
      message.error("流程版本发布失败");
    } finally {
      setPublishing(false);
    }
  };

  const runPublishedRevision = async (revision: PlatformRevision) => {
    if (!session || !platformProjectId) return;
    const environmentId = revision.environmentId ?? activeEnvironment?.id;
    if (!environmentId) {
      message.error("版本没有可用的运行环境");
      return;
    }
    try {
      const flow = flows.find((item) => item.id === revision.flowId) ?? flows.find((item) => item.name === revision.flowName);
      const revisionSteps = flow?.definition ?? [];
      const secretValues = await requestRunSecrets(
        project.id,
        variables,
        revisionSteps,
        sessionSecretValues,
        setSecretValues,
      );
      if (!secretValues) return;
      for (const variable of requiredSecretVariables(variables, revisionSteps)) {
        const value = secretValues[variable.id];
        if (value) await savePlatformSecret(session.token, platformProjectId, { name: variableReference(variable), value });
      }
      const result = await createPlatformRun(session.token, platformProjectId, { revisionId: revision.id, environmentId });
      result.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
      message.success(`已创建 ${result.runIds.length} 个运行（部署机执行）`);
      if (result.runIds[0]) navigate(`/project/${project.id}/runs/${result.runIds[0]}`);
    } catch {
      message.error("创建运行失败，请确认版本与环境配置");
    }
  };

  const importCurrentWorkspace = async () => {
    if (!session || !workspaceId) return;
    setPublishError(undefined);
    setPublishing(true);
    try {
      const state = useWorkspaceStore.getState();
      const result = await importLocalWorkspace(session.token, workspaceId, `project-${project.id}`, {
        projects: [project],
        flowsByProject: { [project.id]: state.flowsByProject[project.id] ?? [] },
        elementsByProject: { [project.id]: state.elementsByProject[project.id] ?? [] },
        variablesByProject: { [project.id]: state.variablesByProject[project.id] ?? [] },
        environmentsByProject: { [project.id]: state.environmentsByProject[project.id] ?? [] },
        activeEnvironmentByProject: { [project.id]: state.activeEnvironmentByProject[project.id] ?? "" },
        membersByProject: { [project.id]: state.membersByProject[project.id] ?? [] },
      });
      const nextMap = { ...projectMap, ...Object.fromEntries(result.projects.map((item) => [item.sourceProjectId, item.projectId])) };
      storePlatformProjectMap(nextMap, workspaceId);
      setProjectMap(nextMap);
      const publishedProjectId = nextMap[project.id];
      if (publishedProjectId) {
        enablePlatformProject(project.id, publishedProjectId);
        const document = await getPlatformProjectDocument(session.token, publishedProjectId);
        storePlatformDocumentVersion(publishedProjectId, document.version, workspaceId);
      }
      notifyPlatformContextChanged();
      message.success(result.imported ? "本地项目已导入 Platform，请显式发布流程版本" : "本地项目已同步到 Platform，请显式发布流程版本");
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) {
        localStorage.removeItem(platformSessionStorageKey);
        setSession(undefined);
        setPublishError("Platform 登录凭证已失效，请重新登录后重试发布。");
        notifyPlatformContextChanged();
        return;
      }
      setPublishError(
        error instanceof PlatformApiError
          ? `发布失败：${error.code}`
          : "发布失败，请稍后重试。",
      );
    } finally {
      setPublishing(false);
    }
  };

  const stopSync = () => {
    clearPlatformProjectMap(project.id, workspaceId);
    disconnectPlatformProject(project.id);
    setProjectMap((current) => {
      const { [project.id]: _removed, ...remaining } = current;
      return remaining;
    });
    notifyPlatformContextChanged();
    message.info("已停止同步。本地项目和 Platform 远程项目均被保留。");
  };
  if (!session) {
    return (
      <>
        <PageHeading title="发布与运行" description="连接 Platform 后，可发布当前项目并运行已发布版本。" />
        {publishError && <Alert type="error" showIcon title={publishError} />}
        <section className="surface settings-section platform-login-panel">
          <div>
            <h2>发布当前项目</h2>
            <p>登录 Platform 后即可发布当前项目，并按需启用同步与运行。</p>
          </div>
          <Form
            form={loginForm}
            layout="vertical"
            onFinish={async (values) => {
              try {
                const nextSession = await loginPlatform(values);
                localStorage.setItem(platformSessionStorageKey, JSON.stringify(nextSession));
                setSession(nextSession);
                const nextWorkspaceId = readStoredPlatformWorkspaceId(nextSession);
                storePlatformWorkspaceId(nextWorkspaceId);
                setWorkspaceId(nextWorkspaceId);
                setProjectMap(readPlatformProjectMap(nextWorkspaceId));
                notifyPlatformContextChanged();
                message.success("已连接到平台");
              } catch {
                message.error("登录失败，请检查邮箱和密码");
              }
            }}
          >
            <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}>
              <Input autoFocus autoComplete="email" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item name="invitationToken" label="邀请令牌">
              <Input autoComplete="off" />
            </Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">登录</Button>
              <Button onClick={() => loginForm.validateFields().then(async (values) => {
                try {
                  const nextSession = await registerPlatform(values);
                  localStorage.setItem(platformSessionStorageKey, JSON.stringify(nextSession));
                  setSession(nextSession);
                  const nextWorkspaceId = readStoredPlatformWorkspaceId(nextSession);
                  storePlatformWorkspaceId(nextWorkspaceId);
                  setWorkspaceId(nextWorkspaceId);
                  setProjectMap(readPlatformProjectMap(nextWorkspaceId));
                  notifyPlatformContextChanged();
                  message.success("账户已注册并连接到平台");
                } catch {
                  message.error("注册失败：邮箱可能已被注册，或密码少于 8 位");
                }
              })}>注册账户</Button>
            </Space>
          </Form>
        </section>
      </>
    );
  }

  if (!platformProjectId) {
    return (
      <>
        <PageHeading title="发布与运行" description="发布当前项目后，才会启用同步、版本与运行。" />
        <section className="surface settings-section">
          <h2>发布当前项目</h2>
          <p>发布会包含当前项目的流程、元素、变量、环境和成员。本地编辑与本机运行保持独立。</p>
          <Button type="primary" icon={<UploadOutlined />} onClick={() => void importCurrentWorkspace()}>
            发布到 Platform
          </Button>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading title="发布与运行" description="已发布版本由部署机本机执行（ManagedRunner）。" />
      {syncError && (
        <Alert
          type="error"
          showIcon
          title="Platform synchronization failed"
          description={syncError}
        />
      )}
      <div className="table-toolbar agent-toolbar">
        <Select
          value={workspaceId}
          onChange={(nextWorkspaceId) => {
            storePlatformWorkspaceId(nextWorkspaceId);
            setWorkspaceId(nextWorkspaceId);
            setProjectMap(readPlatformProjectMap(nextWorkspaceId));
            notifyPlatformContextChanged();
          }}
          options={session.workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
        />
        <Space>
          <Tooltip title="刷新版本列表"><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadRevisions()} /></Tooltip>
        </Space>
      </div>
      <Space>
        <Tag color={syncStatus === "synced" ? "green" : syncStatus === "failed" ? "red" : "blue"}>
          {syncStatus === "synced" ? "已同步" : syncStatus === "retrying" ? "待重试" : syncStatus === "failed" ? "同步失败" : "同步中"}
        </Tag>
        <Button danger onClick={stopSync}>停止同步</Button>
      </Space>
      <section className="surface settings-section agent-binding-section">
        <div>
          <h2>流程版本</h2>
          <p>发布会固定当前流程、元素、环境和密钥引用；仅已发布版本可运行或触发持续回归。</p>
        </div>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          loading={loading}
          dataSource={revisions}
          columns={[
            { title: "版本", dataIndex: "revisionNumber", width: 90, render: (value: number) => `v${value}` },
            { title: "状态", dataIndex: "status", width: 110, render: (status: PlatformRevision["status"]) => <Tag color={status === "published" ? "green" : "default"}>{status === "published" ? "已发布" : status}</Tag> },
            { title: "创建时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
            { title: "", width: 72, render: (_, revision: PlatformRevision) => <Tooltip title="使用当前环境执行"><Button size="small" icon={<PlayCircleFilled />} disabled={revision.status !== "published" || !activeEnvironment} onClick={() => void runPublishedRevision(revision)} /></Tooltip> },
          ]}
          locale={{ emptyText: <Empty description="发布当前流程后将显示可执行版本" /> }}
        />
        <Button type="primary" disabled={!platformProjectId || flows.length === 0 || environments.length === 0} icon={<UploadOutlined />} onClick={() => { releaseForm.setFieldsValue({ flowId: flows[0]?.id, environmentId: activeEnvironment?.id ?? environments[0]?.id }); setReleaseOpen(true); }}>发布流程版本</Button>
      </section>
      <Modal
        title="发布流程版本"
        open={releaseOpen}
        confirmLoading={publishing}
        onCancel={() => setReleaseOpen(false)}
        okText="发布"
        onOk={() => releaseForm.validateFields().then((values) => platformProjectId ? publishFlow(platformProjectId, values.flowId, values.environmentId) : undefined)}
      >
        <Form form={releaseForm} layout="vertical">
          <Form.Item name="flowId" label="流程" rules={[{ required: true, message: "请选择流程" }]}>
            <Select options={flows.filter((flow) => flow.definition?.length).map((flow) => ({ value: flow.id, label: flow.name }))} />
          </Form.Item>
          <Form.Item name="environmentId" label="运行环境" rules={[{ required: true, message: "请选择环境" }]}>
            <Select options={environments.map((environment) => ({ value: environment.id, label: environment.name }))} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
