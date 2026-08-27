import { message } from "../lib/antd-feedback";
import type { Project } from "../lib/mock-data";
import {
  createPlatformRun,
  getPlatformRevisions,
  rollbackPlatformRevision,
} from "../api/platform-api";
import type { PlatformRevision } from "../api/platform-api";
import { platformProjectContext } from "../api/platform-context";
import { useNavigate } from "../router";
import { useRunStore } from "../stores/run-store";
import {
  PageHeading,
  describePlatformRunError,
  emptyEnvironments,
  emptyFlows,
  emptyVariables,
  ensurePlatformRunSecrets,
  createRunDispatchKeyStore,
  nextRunDispatchKey,
  platformRunAsRun,
  releaseRunDispatchKey,
  runIntentKey,
} from "./shared";
import { useWorkspaceStore } from "../stores/workspace-store";
import { HistoryOutlined, PlayCircleFilled, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Popconfirm, Space, Table, Tag, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

export function AgentsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? emptyEnvironments);
  const activeEnvironmentId = useWorkspaceStore((state) => state.activeEnvironmentByProject[project.id]);
  const flows = useWorkspaceStore((state) => state.flowsByProject[project.id] ?? emptyFlows);
  const variables = useWorkspaceStore((state) => state.variablesByProject[project.id] ?? emptyVariables);
  const syncStatus = useWorkspaceStore((state) => state.platformSyncStatusById?.[project.id]);
  const syncError = useWorkspaceStore((state) => state.platformSyncErrorById?.[project.id]);
  const upsertRun = useRunStore((state) => state.upsertRun);
  const platformContext = platformProjectContext(project.id);
  const session = platformContext?.session;
  const platformProjectId = platformContext?.projectId;
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningRevisionId, setRunningRevisionId] = useState<string | null>(null);
  const runDispatchKeysRef = useRef(createRunDispatchKeyStore());
  const activeEnvironment = environments.find((environment) => environment.id === activeEnvironmentId) ?? environments[0];

  const loadRevisions = useCallback(async () => {
    if (!session || !platformProjectId) return;
    setLoading(true);
    try {
      const response = await getPlatformRevisions(session.token, platformProjectId);
      setRevisions(response.revisions);
    } catch {
      message.error("无法读取平台版本，请检查登录状态和服务地址");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, session]);

  useEffect(() => {
    void loadRevisions();
  }, [loadRevisions]);

  const rollbackToRevision = async (revision: PlatformRevision) => {
    if (!session || !platformProjectId) return;
    try {
      await rollbackPlatformRevision(session.token, platformProjectId, revision.id, `回滚到 v${revision.revisionNumber}`);
      await loadRevisions();
      message.success(`已回滚到 v${revision.revisionNumber}，并生成新版本`);
    } catch {
      message.error("回滚失败，请稍后重试");
    }
  };

  const runPublishedRevision = async (revision: PlatformRevision) => {
    if (!session || !platformProjectId) return;
    const environmentId = revision.environmentId ?? activeEnvironment?.id;
    if (!environmentId) {
      message.error("版本没有可用的运行环境");
      return;
    }
    setRunningRevisionId(revision.id);
    const intent = runIntentKey({ projectId: platformProjectId, revisionId: revision.id });
    try {
      const flow = flows.find((item) => item.id === revision.flowId) ?? flows.find((item) => item.name === revision.flowName);
      if (!(await ensurePlatformRunSecrets(session.token, platformProjectId, variables, flow?.definition ?? []))) {
        return;
      }
      const dispatchKey = nextRunDispatchKey(runDispatchKeysRef.current, intent);
      const result = await createPlatformRun(session.token, platformProjectId, { revisionId: revision.id, environmentId, dispatchKey });
      releaseRunDispatchKey(runDispatchKeysRef.current, intent);
      result.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
      message.success(`已创建 ${result.runIds.length} 个运行（部署机执行）`);
      if (result.runIds[0]) navigate(`/project/${project.id}/runs/${result.runIds[0]}`);
    } catch (error) {
      releaseRunDispatchKey(runDispatchKeysRef.current, intent, error);
      message.error(describePlatformRunError(error));
    } finally {
      setRunningRevisionId(null);
    }
  };

  return (
    <>
      <PageHeading title="发布与运行" description="所有项目均由 Platform 保存版本并在部署机上执行。" />
      {syncError && <Alert type="error" showIcon title="平台同步失败" description={syncError} />}
      <div className="table-toolbar agent-toolbar">
        <Tag color={syncStatus === "synced" ? "success" : syncStatus === "conflict" || syncStatus === "failed" ? "error" : syncStatus === "queued" || syncStatus === "retrying" ? "warning" : "processing"}>
          {syncStatus === "synced" ? "已同步"
            : syncStatus === "queued" ? "等待同步"
            : syncStatus === "retrying" ? "重试中"
            : syncStatus === "conflict" ? "冲突"
            : syncStatus === "failed" ? "同步失败"
            : "同步中"}
        </Tag>
        <Tooltip title="刷新版本列表"><Button icon={<ReloadOutlined />} aria-label="刷新版本列表" loading={loading} onClick={() => void loadRevisions()} /></Tooltip>
      </div>
      <section className="surface settings-section agent-binding-section">
        <div>
          <h2>流程版本</h2>
          <p>保存流程后自动生成版本快照；仅已发布版本可运行或触发持续回归，可随时回滚到历史版本。</p>
        </div>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          loading={loading}
          dataSource={revisions}
          columns={[
            { title: "版本", dataIndex: "revisionNumber", width: 90, render: (value: number) => `v${value}` },
            { title: "状态", dataIndex: "status", width: 110, render: (status: PlatformRevision["status"]) => <Tag color={status === "published" ? "success" : "default"}>{status === "published" ? "已发布" : status === "superseded" ? "已覆盖" : status}</Tag> },
            { title: "创建时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
            { title: "", key: "actions", width: 88, align: "right", render: (_: unknown, revision: PlatformRevision) => (
              <Space size={4}>
                <Tooltip title="使用当前环境执行"><Button type="text" size="small" icon={<PlayCircleFilled />} aria-label={`执行版本 v${revision.revisionNumber}`} disabled={revision.status !== "published" || !activeEnvironment || runningRevisionId !== null} onClick={() => void runPublishedRevision(revision)} /></Tooltip>
                {revision.status === "published" && (
                  <Popconfirm title="回滚到此版本" description={`将回滚到 v${revision.revisionNumber} 并生成新版本`} okText="回滚" cancelText="取消" onConfirm={() => void rollbackToRevision(revision)}>
                    <Tooltip title="回滚到此版本"><Button type="text" size="small" icon={<HistoryOutlined />} aria-label={`回滚到版本 v${revision.revisionNumber}`} /></Tooltip>
                  </Popconfirm>
                )}
              </Space>
            ) },
          ]}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="保存流程后将自动生成版本快照" /> }}
        />
      </section>
    </>
  );
}
