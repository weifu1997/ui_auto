import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "./router";
import {
  AppstoreOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleFilled,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  UploadOutlined,
  WarningFilled,
} from "@ant-design/icons";
import {
  App as AntdApp,
  Alert,
  Avatar,
  Badge,
  Button,
  ConfigProvider,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
} from "antd";
import type { TableColumnsType } from "antd";
import { useRunStore } from "./run-store";
import { useFlowStore } from "./flow-store";
import { useSecretStore } from "./secret-store";
import { useWorkspaceStore } from "./workspace-store";
import type { PlatformWorkspaceProject } from "./workspace-store";
import {
  artifactUrl,
  cancelRun,
  createRun,
  createValidation,
  getWorkerHealth,
  getRun,
  retryRun,
  subscribeToTask,
  WorkerApiError,
} from "./worker-api";
import type { WorkerTask } from "./worker-api";
import { localWorkerRunRequest } from "./local-worker-run";
import {
  bindAgent,
  addWorkspaceMember,
  confirmPickerCandidate,
  createDebugSession,
  createAgentRegistrationToken,
  createPlatformElementValidation,
  createPlatformRevision,
  createPlatformRun,
  cancelPlatformRun,
  createPlatformNotificationChannel,
  createPlatformSchedule,
  createPlatformWebhookTrigger,
  enableElementPicker,
  fetchDebugArtifact,
  getAgentBindings,
  getDebugSessions,
  getPlatformAgents,
  getPlatformAnalytics,
  getPlatformAuditEvents,
  getPlatformDatasetVersion,
  getPlatformDatasets,
  getPlatformDeliveries,
  getPlatformNotificationChannels,
  getPlatformNotificationSubscriptions,
  getPlatformRevisions,
  getPlatformRun,
  getPlatformRuns,
  getPlatformSchedules,
  getPlatformWebhookTriggers,
  getPlatformProjectDocument,
  getPlatformElementValidation,
  getWorkspaceProjects,
  getWorkspaceMembers,
  getPickerCaptures,
  importPlatformDataset,
  importPlatformDatasetVersion,
  importLocalWorkspace,
  loginPlatform,
  publishPlatformRevision,
  platformApiOrigin,
  PlatformApiError,
  previewPickerCandidate,
  registerPlatform,
  savePlatformNotificationSubscription,
  savePlatformProjectDocument,
  scheduleAction,
  sendDebugCommand,
  savePlatformSecret,
  updateWorkspaceMember,
  updatePlatformProject,
  webhookTriggerAction,
} from "./platform-api";
import {
  platformSessionStorageKey,
  platformContextChangedEvent,
  notifyPlatformContextChanged,
  readPlatformDocumentVersion,
  readPlatformProjectMap,
  readStoredPlatformSession,
  readStoredPlatformWorkspaceId,
  storePlatformProjectMap,
  storePlatformDocumentVersion,
  storePlatformWorkspaceId,
  platformProjectContext,
} from "./platform-context";
import type {
  PlatformAgent,
  PlatformAnalytics,
  PlatformAuditEvent,
  PlatformDataset,
  PlatformDatasetVersion,
  PlatformDebugSession,
  PlatformDelivery,
  PlatformNotificationChannel,
  PlatformNotificationSubscription,
  PlatformPickerCapture,
  PlatformRevision,
  PlatformRun,
  PlatformSchedule,
  PlatformSession,
  PlatformWebhookTrigger,
  PlatformMember,
} from "./platform-api";
import type {
  ElementAsset,
  Environment,
  Flow,
  FlowStep,
  Project,
  Run,
  Variable,
} from "./mock-data";
import "./App.css";
import "./responsive.css";
import { AntdFeedbackBridge, message, modal } from "./antd-feedback";

type ProjectSection =
  | "overview"
  | "flows"
  | "elements"
  | "variables"
  | "environments"
  | "data"
  | "agents"
  | "debug"
  | "automations"
  | "governance"
  | "runs"
  | "settings";

const LazyFlowEditor = lazy(() => import("./FlowEditorPage"));
const LazyRunDetail = lazy(() => import("./RunDetailPage"));

const sectionMeta: Record<
  ProjectSection,
  { label: string; icon: React.ReactNode }
> = {
  overview: { label: "概览", icon: <AppstoreOutlined /> },
  flows: { label: "流程", icon: <UnorderedListOutlined /> },
  elements: { label: "元素库", icon: <FileSearchOutlined /> },
  variables: { label: "变量", icon: <CodeOutlined /> },
  environments: { label: "环境", icon: <GlobalOutlined /> },
  data: { label: "数据集", icon: <DatabaseOutlined /> },
  agents: { label: "执行节点", icon: <CloudServerOutlined /> },
  debug: { label: "调试", icon: <ExperimentOutlined /> },
  automations: { label: "持续回归", icon: <ClockCircleOutlined /> },
  governance: { label: "治理分析", icon: <SafetyCertificateOutlined /> },
  runs: { label: "运行中心", icon: <PlayCircleFilled /> },
  settings: { label: "项目设置", icon: <SettingOutlined /> },
};

const statusMeta = {
  success: { label: "通过", color: "success" },
  failed: { label: "失败", color: "error" },
  running: { label: "运行中", color: "processing" },
  queued: { label: "排队中", color: "default" },
  canceled: { label: "已取消", color: "default" },
} as const;

const emptyRuns: Run[] = [];
const emptyFlows: Flow[] = [];
const emptyElements: ElementAsset[] = [];
const emptyVariables: Variable[] = [];
const emptyEnvironments: Environment[] = [];
const emptySecretValues: Record<string, string> = {};

type ProjectListRow = Project & {
  environmentCount: number;
  flowCount: number;
  lastRun: string;
  health?: number;
};

function statusTag(status: Run["status"]) {
  const meta = statusMeta[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

function projectById(projects: Project[], id?: string) {
  return projects.find((project) => project.id === id);
}

function App() {
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#147a73",
          colorInfo: "#147a73",
          colorSuccess: "#227a52",
          colorWarning: "#c68418",
          colorError: "#c44343",
          borderRadius: 6,
          fontFamily:
            'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        },
      }}
    >
      <AntdApp>
        <AntdFeedbackBridge />
        <PlatformWorkspaceSynchronizer />
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/project/:projectId/:section" element={<ProjectShell />} />
          <Route
            path="/project/:projectId/flows/:flowId/edit"
            element={
              <Suspense fallback={<div className="route-loading"><Spin size="large" /></div>}>
                <LazyFlowEditor />
              </Suspense>
            }
          />
          <Route
            path="/project/:projectId/runs/:runId"
            element={
              <Suspense fallback={<div className="route-loading"><Spin size="large" /></div>}>
                <LazyRunDetail
                  ProjectLayout={ProjectLayout}
                  PageHeading={PageHeading}
                  statusTag={statusTag}
                  statusMeta={statusMeta}
                />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </AntdApp>
    </ConfigProvider>
  );
}

type WorkspaceSnapshot = ReturnType<typeof useWorkspaceStore.getState>;
type RemoteProjectMetadata = { id: string; name: string; description: string };

function workspaceDocumentFor(state: WorkspaceSnapshot, projectId: string) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return undefined;
  return {
    sourceProjectId: projectId,
    flows: state.flowsByProject[projectId] ?? [],
    elements: state.elementsByProject[projectId] ?? [],
    variables: state.variablesByProject[projectId] ?? [],
    environments: state.environmentsByProject[projectId] ?? [],
    activeEnvironmentId: state.activeEnvironmentByProject[projectId] ?? "",
    members: state.membersByProject[projectId] ?? [],
  } satisfies Record<string, unknown>;
}

function hasUnsavedFlowDraft(projectId: string) {
  const editorPrefix = `/project/${encodeURIComponent(projectId)}/flows/`;
  return window.location.pathname.startsWith(editorPrefix)
    && window.location.pathname.endsWith("/edit")
    && useFlowStore.getState().isDirty;
}

function PlatformWorkspaceSynchronizer() {
  const [contextRevision, setContextRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setContextRevision((value) => value + 1);
    window.addEventListener(platformContextChangedEvent, refresh);
    return () => window.removeEventListener(platformContextChangedEvent, refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let ready = false;
    let hydrating = false;
    const timers = new Map<string, number>();
    const inFlight = new Set<string>();
    const dirty = new Set<string>();
    const lastDocuments = new Map<string, string>();
    const lastMetadata = new Map<string, string>();
    const remoteProjects = new Map<string, RemoteProjectMetadata>();
    const conflicts = new Set<string>();
    const draftBlocked = new Set<string>();

    const context = () => {
      const session = readStoredPlatformSession();
      const workspaceId = readStoredPlatformWorkspaceId(session);
      if (!session?.token || !workspaceId) return undefined;
      return { session, workspaceId, projectMap: readPlatformProjectMap(workspaceId) };
    };

    const applyRemoteDocument = (
      localId: string,
      remoteId: string,
      data: Record<string, unknown>,
      remoteName: string,
      remoteDescription: string,
      version?: number,
    ) => {
      if (hasUnsavedFlowDraft(localId)) {
        if (!draftBlocked.has(localId)) {
          draftBlocked.add(localId);
          message.warning("当前流程有未保存草稿，远端项目更新将在保存或放弃草稿后同步。");
        }
        return false;
      }
      const source = { platformProjectId: remoteId, sourceProjectId: localId, name: remoteName, description: remoteDescription, document: data };
      hydrating = true;
      useWorkspaceStore.getState().hydratePlatformProjects([source]);
      hydrating = false;
      if (version !== undefined) storePlatformDocumentVersion(remoteId, version, context()?.workspaceId);
      lastDocuments.set(localId, JSON.stringify(workspaceDocumentFor(useWorkspaceStore.getState(), localId)));
      const project = useWorkspaceStore.getState().projects.find((item) => item.id === localId);
      if (project) lastMetadata.set(localId, JSON.stringify({ name: project.name, description: project.description }));
      dirty.delete(localId);
      draftBlocked.delete(localId);
      return true;
    };

    const resolveDocumentConflict = (
      localId: string,
      remoteId: string,
      remote: { data: Record<string, unknown>; version: number },
      remoteName: string,
      remoteDescription: string,
    ) => {
      if (conflicts.has(localId)) return;
      conflicts.add(localId);
      modal.confirm({
        title: "项目文档发生冲突",
        content: "远端和当前浏览器都包含未合并的修改。选择覆盖远端版本，或加载远端版本并放弃当前本地修改。",
        okText: "覆盖远端版本",
        cancelText: "加载远端版本",
        onOk: async () => {
          try {
            const currentContext = context();
            const document = workspaceDocumentFor(useWorkspaceStore.getState(), localId);
            if (!currentContext || !document) return;
            const saved = await savePlatformProjectDocument(currentContext.session.token, remoteId, document, remote.version);
            storePlatformDocumentVersion(remoteId, saved.version, currentContext.workspaceId);
            lastDocuments.set(localId, JSON.stringify(saved.data));
            dirty.delete(localId);
          } catch {
            message.error("覆盖远端项目文档失败，请重新加载后再试");
          } finally {
            conflicts.delete(localId);
          }
        },
        onCancel: () => {
          applyRemoteDocument(localId, remoteId, remote.data, remoteName, remoteDescription, remote.version);
          conflicts.delete(localId);
        },
      });
    };

    const saveDocument = async (localId: string) => {
      if (cancelled || inFlight.has(localId)) return;
      const currentContext = context();
      const remoteId = currentContext?.projectMap[localId];
      const document = workspaceDocumentFor(useWorkspaceStore.getState(), localId);
      if (!currentContext || !remoteId || !document) return;
      inFlight.add(localId);
      const serialized = JSON.stringify(document);
      try {
        let version = readPlatformDocumentVersion(remoteId, currentContext.workspaceId);
        if (version === undefined) {
          const latest = await getPlatformProjectDocument(currentContext.session.token, remoteId);
          version = latest.version;
          storePlatformDocumentVersion(remoteId, version, currentContext.workspaceId);
        }
        const saved = await savePlatformProjectDocument(currentContext.session.token, remoteId, document, version);
        storePlatformDocumentVersion(remoteId, saved.version, currentContext.workspaceId);
        lastDocuments.set(localId, JSON.stringify(saved.data));
        const currentSerialized = JSON.stringify(workspaceDocumentFor(useWorkspaceStore.getState(), localId));
        if (currentSerialized === serialized) dirty.delete(localId);
        else scheduleDocument(localId);
      } catch (error) {
        if (error instanceof PlatformApiError && error.code === "DOCUMENT_VERSION_CONFLICT") {
          try {
            const latest = await getPlatformProjectDocument(currentContext.session.token, remoteId);
            const remote = remoteProjects.get(localId);
            resolveDocumentConflict(localId, remoteId, latest, remote?.name ?? localId, remote?.description ?? "");
          } catch {
            message.error("项目文档冲突，且无法读取远端版本");
            scheduleDocument(localId, 5_000);
          }
        } else {
          message.error("项目修改未能同步到平台，已保留在当前浏览器");
          scheduleDocument(localId, 5_000);
        }
      } finally {
        inFlight.delete(localId);
      }
    };

    function scheduleDocument(localId: string, delay = 500) {
      dirty.add(localId);
      const previous = timers.get(localId);
      if (previous !== undefined) window.clearTimeout(previous);
      timers.set(localId, window.setTimeout(() => {
        timers.delete(localId);
        void saveDocument(localId);
      }, delay));
    }

    const saveMetadata = async (localId: string, archived = false) => {
      const currentContext = context();
      const remoteId = currentContext?.projectMap[localId];
      const previous = lastMetadata.get(localId);
      const state = useWorkspaceStore.getState();
      const project = state.projects.find((item) => item.id === localId);
      if (!currentContext || !remoteId || !previous) return;
      const metadata = project ? { name: project.name, description: project.description } : JSON.parse(previous) as { name: string; description: string };
      try {
        await updatePlatformProject(currentContext.session.token, remoteId, { ...metadata, archived });
        if (project) lastMetadata.set(localId, JSON.stringify(metadata));
        else lastMetadata.delete(localId);
      } catch {
        message.error("项目基本信息未能同步到平台");
      }
    };

    const hydrate = async () => {
      const currentContext = context();
      if (!currentContext) {
        ready = true;
        return;
      }
      try {
        const response = await getWorkspaceProjects(currentContext.session.token, currentContext.workspaceId);
        const loaded = await Promise.all(response.projects.map(async (project) => {
          const document = await getPlatformProjectDocument(currentContext.session.token, project.id);
          const existingLocalId = Object.entries(currentContext.projectMap).find(([, remoteId]) => remoteId === project.id)?.[0];
          const sourceProjectId = project.sourceProjectId ?? (typeof document.data.sourceProjectId === "string" ? document.data.sourceProjectId : existingLocalId ?? `platform-${project.id}`);
          return { project, document, sourceProjectId };
        }));
        if (cancelled) return;
        const nextMap = { ...currentContext.projectMap };
        const state = useWorkspaceStore.getState();
        const remoteHydration: PlatformWorkspaceProject[] = [];
        for (const item of loaded) {
          nextMap[item.sourceProjectId] = item.project.id;
          remoteProjects.set(item.sourceProjectId, { id: item.project.id, name: item.project.name, description: item.project.description });
          const localDocument = workspaceDocumentFor(state, item.sourceProjectId);
          const localSerialized = localDocument ? JSON.stringify(localDocument) : undefined;
          const remoteSerialized = JSON.stringify(item.document.data);
          const knownVersion = readPlatformDocumentVersion(item.project.id, currentContext.workspaceId);

          if (!localDocument) {
            remoteHydration.push({
              platformProjectId: item.project.id,
              sourceProjectId: item.sourceProjectId,
              name: item.project.name,
              description: item.project.description,
              document: item.document.data,
            });
            storePlatformDocumentVersion(item.project.id, item.document.version, currentContext.workspaceId);
            continue;
          }

          if (hasUnsavedFlowDraft(item.sourceProjectId) && knownVersion !== item.document.version) {
            if (!draftBlocked.has(item.sourceProjectId)) {
              draftBlocked.add(item.sourceProjectId);
              message.warning("当前流程有未保存草稿，远端项目更新将在保存或放弃草稿后同步。");
            }
            continue;
          }

          if (knownVersion === undefined) {
            if (item.document.version > 0) {
              remoteHydration.push({
                platformProjectId: item.project.id,
                sourceProjectId: item.sourceProjectId,
                name: item.project.name,
                description: item.project.description,
                document: item.document.data,
              });
              storePlatformDocumentVersion(item.project.id, item.document.version, currentContext.workspaceId);
            } else if (localSerialized !== remoteSerialized) {
              storePlatformDocumentVersion(item.project.id, 0, currentContext.workspaceId);
              lastDocuments.set(item.sourceProjectId, remoteSerialized);
              scheduleDocument(item.sourceProjectId);
            } else {
              storePlatformDocumentVersion(item.project.id, 0, currentContext.workspaceId);
              lastDocuments.set(item.sourceProjectId, remoteSerialized);
            }
            continue;
          }

          if (knownVersion === item.document.version) {
            if (localSerialized !== remoteSerialized) {
              lastDocuments.set(item.sourceProjectId, remoteSerialized);
              scheduleDocument(item.sourceProjectId);
            } else {
              lastDocuments.set(item.sourceProjectId, remoteSerialized);
            }
            continue;
          }

          if (localSerialized === lastDocuments.get(item.sourceProjectId)) {
            remoteHydration.push({
              platformProjectId: item.project.id,
              sourceProjectId: item.sourceProjectId,
              name: item.project.name,
              description: item.project.description,
              document: item.document.data,
            });
            storePlatformDocumentVersion(item.project.id, item.document.version, currentContext.workspaceId);
          } else {
            resolveDocumentConflict(item.sourceProjectId, item.project.id, item.document, item.project.name, item.project.description);
          }
        }
        const remoteIds = new Set(loaded.map((item) => item.project.id));
        const archivedLocalIds = Object.entries(currentContext.projectMap)
          .filter(([, remoteId]) => !remoteIds.has(remoteId))
          .map(([localId]) => localId)
          .filter((localId) => !hasUnsavedFlowDraft(localId));
        for (const localId of archivedLocalIds) delete nextMap[localId];
        storePlatformProjectMap(nextMap, currentContext.workspaceId);
        hydrating = true;
        useWorkspaceStore.getState().hydratePlatformProjectMetadata(
          loaded.map((item) => ({
            sourceProjectId: item.sourceProjectId,
            name: item.project.name,
            description: item.project.description,
          })),
        );
        for (const item of loaded) {
          const project = useWorkspaceStore.getState().projects.find(
            (candidate) => candidate.id === item.sourceProjectId,
          );
          if (project) {
            lastMetadata.set(
              item.sourceProjectId,
              JSON.stringify({ name: project.name, description: project.description }),
            );
          }
        }
        for (const localId of archivedLocalIds) {
          useWorkspaceStore.getState().archiveProject(localId);
          lastDocuments.delete(localId);
          lastMetadata.delete(localId);
        }
        if (remoteHydration.length > 0) {
          useWorkspaceStore.getState().hydratePlatformProjects(remoteHydration);
          for (const item of remoteHydration) {
            lastDocuments.set(item.sourceProjectId, JSON.stringify(workspaceDocumentFor(useWorkspaceStore.getState(), item.sourceProjectId)));
            const project = useWorkspaceStore.getState().projects.find((candidate) => candidate.id === item.sourceProjectId);
            if (project) lastMetadata.set(item.sourceProjectId, JSON.stringify({ name: project.name, description: project.description }));
          }
        }
        hydrating = false;
      } catch {
        // A platform outage must not erase local data. Mapped edits can still retry with their stored version.
      } finally {
        ready = true;
      }
    };

    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (!ready || hydrating) return;
      const currentContext = context();
      if (!currentContext) return;
      for (const [localId] of Object.entries(currentContext.projectMap)) {
        const document = workspaceDocumentFor(state, localId);
        const project = state.projects.find((item) => item.id === localId);
        const serialized = document ? JSON.stringify(document) : undefined;
        const metadata = project ? JSON.stringify({ name: project.name, description: project.description }) : undefined;
        if (serialized && serialized !== lastDocuments.get(localId)) {
          lastDocuments.set(localId, serialized);
          scheduleDocument(localId);
        }
        if (metadata && metadata !== lastMetadata.get(localId)) {
          lastMetadata.set(localId, metadata);
          void saveMetadata(localId);
        }
        if (!project && lastMetadata.has(localId)) void saveMetadata(localId, true);
      }
    });

    void hydrate();
    const poll = window.setInterval(() => {
      if (!ready || dirty.size > 0 || inFlight.size > 0) return;
      void hydrate();
    }, 30_000);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(poll);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [contextRevision]);

  return null;
}

function WorkspaceSide({ compact = false }: { compact?: boolean }) {
  const location = useLocation();
  const isProjects = location.pathname === "/projects";
  const isTemplates = location.pathname === "/templates";
  return (
    <aside className={`workspace-side ${compact ? "compact" : ""}`}>
      <Link className="brand" to="/projects" aria-label="AutoFlow 工作空间">
        <span className="brand-mark">
          <ThunderboltOutlined />
        </span>
        {!compact && <span>AutoFlow</span>}
      </Link>
      <nav className="workspace-nav" aria-label="工作空间导航">
        <Tooltip title={compact ? "项目列表" : undefined} placement="right">
          <Link
            className={isProjects ? "workspace-link active" : "workspace-link"}
            to="/projects"
          >
            <FolderOpenOutlined /> {!compact && <span>项目</span>}
          </Link>
        </Tooltip>
        <Tooltip title={compact ? "公共模板库" : undefined} placement="right">
          <Link
            className={isTemplates ? "workspace-link active" : "workspace-link"}
            to="/templates"
          >
            <DatabaseOutlined /> {!compact && <span>公共模板</span>}
          </Link>
        </Tooltip>
      </nav>
      <div className="side-spacer" />
      <div className="side-profile">
        <Avatar
          size={28}
          style={{ background: "#ddeeea", color: "#147a73", fontWeight: 700 }}
        >
          R
        </Avatar>
        {!compact && (
          <div>
            <strong>Rui Chen</strong>
            <span>工作空间管理员</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function ProjectsPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const projectList = useWorkspaceStore((state) => state.projects);
  const flowsByProject = useWorkspaceStore((state) => state.flowsByProject);
  const environmentsByProject = useWorkspaceStore((state) => state.environmentsByProject);
  const runRecords = useRunStore((state) => state.apiRuns);
  const createProject = useWorkspaceStore((state) => state.createProject);
  const archiveProject = useWorkspaceStore((state) => state.archiveProject);
  const [form] = Form.useForm();
  const projectRows: ProjectListRow[] = projectList.map((project) => {
    const projectRuns = runRecords[project.id] ?? emptyRuns;
    const completedProjectRuns = projectRuns.filter((run) => isTerminalStatus(run.status));
    return {
      ...project,
      environmentCount: environmentsByProject[project.id]?.length ?? 0,
      flowCount: flowsByProject[project.id]?.length ?? 0,
      lastRun: projectRuns[0]?.startedAt ?? "尚未运行",
      health: completedProjectRuns.length
        ? Math.round(
            (completedProjectRuns.filter((run) => run.status === "success").length /
              completedProjectRuns.length) *
              100,
          )
        : undefined,
    };
  });
  const visibleProjects = projectRows.filter((project) =>
    project.name.toLowerCase().includes(query.toLowerCase()),
  );
  const runs = Object.values(runRecords).flat();
  const completedRuns = runs.filter((run) => isTerminalStatus(run.status));
  const successRate = completedRuns.length
    ? `${Math.round((completedRuns.filter((run) => run.status === "success").length / completedRuns.length) * 100)}%`
    : "-";

  const columns: TableColumnsType<ProjectListRow> = [
    {
      title: "项目",
      dataIndex: "name",
      render: (_, project) => (
        <button
          className="project-cell"
          onClick={() => navigate(`/project/${project.id}/overview`)}
        >
          <span className="project-icon">{project.name.slice(0, 1)}</span>
          <span>
            <strong>{project.name}</strong>
            <small>{project.description}</small>
          </span>
        </button>
      ),
    },
    {
      title: "环境",
      dataIndex: "environmentCount",
      width: 104,
      render: (value) => `${value} 个`,
    },
    {
      title: "流程",
      dataIndex: "flowCount",
      width: 104,
      render: (value) => `${value} 条`,
    },
    { title: "最近运行", dataIndex: "lastRun", width: 176 },
    {
      title: "健康度",
      dataIndex: "health",
      width: 130,
      render: (value) => (
        value === undefined ? (
          <span>-</span>
        ) : (
          <div className="health-cell">
            <Progress
              percent={value}
              showInfo={false}
              size="small"
              strokeColor={value > 90 ? "#227a52" : "#c68418"}
            />
            <span>{value}%</span>
          </div>
        )
      ),
    },
    {
      title: "",
      key: "actions",
      width: 68,
      align: "right",
      render: (_, project) => (
        <Dropdown
          menu={{
            items: [
              {
                key: "open",
                label: "进入项目",
                onClick: () => navigate(`/project/${project.id}/overview`),
              },
              {
                key: "archive",
                label: "归档项目",
                danger: true,
                onClick: () =>
                  modal.confirm({
                    title: `归档“${project.name}”？`,
                    content: "归档后将从活动项目列表移除。",
                    okText: "归档项目",
                    cancelText: "取消",
                    okButtonProps: { danger: true },
                    onOk: () => {
                      archiveProject(project.id);
                      message.info(`“${project.name}”已归档`);
                    },
                  }),
              },
            ],
          }}
        >
          <Button
            type="text"
            icon={<MoreOutlined />}
            aria-label={`${project.name}更多操作`}
          />
        </Dropdown>
      ),
    },
  ];

  return (
    <div className="workspace-layout">
      <WorkspaceSide />
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">工作空间</span>
            <h1>测试项目</h1>
          </div>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            新建项目
          </Button>
        </header>
        <section className="workspace-summary">
          <div>
            <span>活跃项目</span>
            <strong>{projectList.length}</strong>
          </div>
          <div>
            <span>过去 7 天运行</span>
            <strong>{runs.length}</strong>
          </div>
          <div>
            <span>整体通过率</span>
            <strong className="success-number">{successRate}</strong>
          </div>
          <div>
            <span>运行中的任务</span>
            <strong className="running-number">{runs.filter((run) => run.status === "running").length}</strong>
          </div>
        </section>
        <div className="table-toolbar">
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索项目"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            allowClear
          />
          <span>{visibleProjects.length} 个项目</span>
        </div>
        <section className="surface project-table">
          <Table
            rowKey="id"
            columns={columns}
            dataSource={visibleProjects}
            pagination={false}
            locale={{ emptyText: <Empty description="尚未创建测试项目" /> }}
          />
        </section>
      </main>
      <Modal
        title="新建测试项目"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="创建项目"
        onOk={() =>
          form.validateFields().then((values) => {
            const project = createProject(values);
            setCreateOpen(false);
            form.resetFields();
            message.success("项目已创建");
            navigate(`/project/${project.id}/overview`);
          })
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="项目名称"
            name="name"
            rules={[{ required: true, message: "请输入项目名称" }]}
          >
            <Input placeholder="例如：支付中心 Web" autoFocus />
          </Form.Item>
          <Form.Item label="项目说明" name="description">
            <Input.TextArea rows={3} placeholder="简要说明被测系统和范围" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function ProjectShell() {
  const { projectId, section } = useParams();
  const projects = useWorkspaceStore((state) => state.projects);
  const project = projectById(projects, projectId);
  const activeSection = (
    section && section in sectionMeta ? section : "overview"
  ) as ProjectSection;
  if (!project) return <Navigate to="/projects" replace />;
  return (
    <ProjectLayout project={project} section={activeSection}>
      {renderSection(activeSection, project)}
    </ProjectLayout>
  );
}

function ProjectLayout({
  project,
  section,
  children,
}: {
  project: Project;
  section: ProjectSection;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const projectRuns = useRunStore(
    (state) => state.apiRuns[project.id] ?? emptyRuns,
  );
  const activeEnvironmentId = useWorkspaceStore(
    (state) => state.activeEnvironmentByProject[project.id],
  );
  const setActiveEnvironment = useWorkspaceStore(
    (state) => state.setActiveEnvironment,
  );
  const environments = storedEnvironments ?? emptyEnvironments;
  const environment =
    environments.find((item) => item.id === activeEnvironmentId) ?? environments[0];
  const runningRunCount = projectRuns.filter((run) => run.status === "running").length;
  const [workerStatus, setWorkerStatus] = useState<"checking" | "online" | "offline">("checking");
  const [agentStatus, setAgentStatus] = useState<"checking" | "online" | "offline" | "unbound" | "unimported" | "unknown">("checking");
  const [agentName, setAgentName] = useState<string>();
  const [platformContextVersion, setPlatformContextVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setPlatformContextVersion((value) => value + 1);
    window.addEventListener(platformContextChangedEvent, refresh);
    return () => window.removeEventListener(platformContextChangedEvent, refresh);
  }, []);

  useEffect(() => {
    let mounted = true;
    let request: AbortController | undefined;
    const refresh = async () => {
      request?.abort();
      request = new AbortController();
      try {
        const health = await getWorkerHealth(request.signal);
        if (mounted) setWorkerStatus(health.ok ? "online" : "offline");
      } catch {
        if (mounted) setWorkerStatus("offline");
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      mounted = false;
      request?.abort();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let request: AbortController | undefined;
    const refresh = async () => {
      const context = platformProjectContext(project.id);
      if (!context) {
        if (mounted) {
          setAgentStatus("unimported");
          setAgentName(undefined);
        }
        return;
      }
      if (!environment) {
        if (mounted) {
          setAgentStatus("unbound");
          setAgentName(undefined);
        }
        return;
      }
      request?.abort();
      request = new AbortController();
      try {
        const result = await getAgentBindings(context.session.token, context.projectId);
        const binding = result.bindings.find((item) => item.environmentId === environment.id);
        if (!mounted) return;
        setAgentName(binding?.agent.name);
        setAgentStatus(!binding ? "unbound" : binding.agent.status === "online" ? "online" : "offline");
      } catch {
        if (mounted) {
          setAgentStatus("unknown");
          setAgentName(undefined);
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      mounted = false;
      request?.abort();
      window.clearInterval(interval);
    };
  }, [environment?.id, platformContextVersion, project.id]);

  const workerLabel = workerStatus === "online"
    ? "Worker 在线"
    : workerStatus === "offline"
      ? "Worker 离线"
      : "正在检查 Worker";
  const agentLabel = agentStatus === "online"
    ? `Agent ${agentName ?? ""} 在线`
    : agentStatus === "offline"
      ? `Agent ${agentName ?? ""} 离线`
      : agentStatus === "unbound"
        ? "未绑定 Agent"
        : agentStatus === "unimported"
          ? "项目未导入 Platform"
          : agentStatus === "unknown"
            ? "Platform 状态未知"
            : "正在检查 Agent";
  return (
    <div className="app-shell">
      <WorkspaceSide compact />
      <aside className="project-side">
        <button
          className="project-switcher"
          onClick={() => navigate("/projects")}
        >
          <span className="project-initial">{project.name.slice(0, 1)}</span>
          <span>
            <strong>{project.name}</strong>
            <small>当前项目</small>
          </span>
          <DownOutlined />
        </button>
        <nav className="project-nav" aria-label="项目导航">
          {(Object.keys(sectionMeta) as ProjectSection[]).map((key) => (
            <Link
              key={key}
              className={
                section === key ? "project-nav-item active" : "project-nav-item"
              }
              to={`/project/${project.id}/${key}`}
            >
              {sectionMeta[key].icon}
              <span>{sectionMeta[key].label}</span>
              {key === "runs" && (
                <Badge count={runningRunCount} size="small" color="#147a73" />
              )}
            </Link>
          ))}
        </nav>
        <div className="project-side-footer">
          <SafetyCertificateOutlined />
          <span>项目数据已隔离</span>
        </div>
      </aside>
      <main className="project-main">
        <header className="project-topbar">
          <div className="breadcrumb">
            <Link to="/projects">项目</Link>
            <span>/</span>
            <strong>{sectionMeta[section].label}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`agent-status ${agentStatus}`} title={agentLabel}>
              <i /> {agentLabel}
            </span>
            <span className={`worker-status ${workerStatus}`} title={workerLabel}>
              <i /> {workerLabel}
            </span>
            <Select
              className="environment-select"
              value={environment?.id}
              onChange={(environmentId) =>
                setActiveEnvironment(project.id, environmentId)
              }
              options={environments.map(
                (item) => ({ value: item.id, label: item.name }),
              )}
              suffixIcon={<DownOutlined />}
            />
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}

function renderSection(section: ProjectSection, project: Project) {
  switch (section) {
    case "overview":
      return <OverviewPage project={project} />;
    case "flows":
      return <FlowsPage project={project} />;
    case "elements":
      return <ElementsPage project={project} />;
    case "variables":
      return <VariablesPage project={project} />;
    case "environments":
      return <EnvironmentsPage project={project} />;
    case "data":
      return <DatasetsPage project={project} />;
    case "agents":
      return <AgentsPage project={project} />;
    case "debug":
      return <DebugSessionsPage project={project} />;
    case "automations":
      return <AutomationsPage project={project} />;
    case "governance":
      return <GovernancePage project={project} />;
    case "runs":
      return <RunsPage project={project} />;
    case "settings":
      return <SettingsPage project={project} />;
  }
}

function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

function OverviewPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const storedRuns = useRunStore((state) => state.apiRuns[project.id]);
  const runs = storedRuns ?? emptyRuns;
  const storedFlows = useWorkspaceStore((state) => state.flowsByProject[project.id]);
  const storedElements = useWorkspaceStore((state) => state.elementsByProject[project.id]);
  const flows = storedFlows ?? emptyFlows;
  const elements = storedElements ?? emptyElements;
  const latest = runs.slice(0, 4);
  const completedRuns = runs.filter((run) => isTerminalStatus(run.status));
  const successfulRuns = completedRuns.filter((run) => run.status === "success");
  const successRate = completedRuns.length
    ? `${Math.round((successfulRuns.length / completedRuns.length) * 100)}%`
    : "-";
  const runningRuns = runs.filter((run) => run.status === "running").length;
  const unstableElements = elements.filter((element) => element.validation === "multiple");
  const failedRuns = runs.filter((run) => run.status === "failed");
  return (
    <>
      <PageHeading
        title="项目概览"
        description="聚焦当前项目的执行健康度与待处理问题。"
        actions={
          <>
            <Button
              icon={<PlusOutlined />}
              onClick={() => navigate(`/project/${project.id}/flows`)}
            >
              新建流程
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleFilled />}
              onClick={() => navigate(`/project/${project.id}/runs`)}
            >
              运行中心
            </Button>
          </>
        }
      />
      <section className="metric-grid">
        <Metric
          label="7 日通过率"
          value={successRate}
          detail={`${completedRuns.length} 次已完成的真实运行`}
          tone="success"
          icon={<CheckCircleFilled />}
        />
        <Metric
          label="流程总数"
          value={flows.length}
          detail="当前项目的已保存流程"
          icon={<UnorderedListOutlined />}
        />
        <Metric
          label="元素资产"
          value={elements.length}
          detail="当前项目的可复用元素"
          icon={<FileSearchOutlined />}
        />
        <Metric
          label="运行中"
          value={runningRuns}
          detail={`${runs.length} 次真实运行任务`}
          tone="info"
          icon={<PlayCircleFilled />}
        />
      </section>
      <section className="overview-grid">
        <div className="surface section-block recent-runs">
          <div className="section-title">
            <div>
              <h2>最近运行</h2>
              <span>来自当前项目</span>
            </div>
            <Button
              type="link"
              onClick={() => navigate(`/project/${project.id}/runs`)}
            >
              查看全部
            </Button>
          </div>
          {latest.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无真实运行记录" />
          ) : latest.map((run) => (
            <button
              className="run-summary-row"
              key={run.id}
              onClick={() => navigate(`/project/${project.id}/runs/${run.id}`)}
            >
              <span className={`run-status-dot ${run.status}`} />
              <span className="summary-flow">
                <strong>{run.flowName}</strong>
                <small>
                  {run.id} · {run.startedAt}
                </small>
              </span>
              <span>{statusTag(run.status)}</span>
              <span className="duration">
                <ClockCircleOutlined /> {run.duration}
              </span>
            </button>
          ))}
        </div>
        <div className="surface section-block attention-block">
          <div className="section-title">
            <div>
              <h2>需要关注</h2>
              <span>优先处理稳定性风险</span>
            </div>
          </div>
          {unstableElements.length === 0 && failedRuns.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无需要关注的真实结果" />
          ) : (
            <>
              {unstableElements.slice(0, 1).map((element) => (
                <div className="attention-item" key={element.id}>
                  <span className="attention-icon warning"><WarningFilled /></span>
                  <div>
                    <strong>{element.name} 存在多个定位匹配</strong>
                    <p>请在元素库中优化该元素的定位方式或定位值。</p>
                    <Link to={`/project/${project.id}/elements`}>查看元素</Link>
                  </div>
                </div>
              ))}
              {failedRuns.slice(0, 1).map((run) => (
                <div className="attention-item" key={run.id}>
                  <span className="attention-icon error"><StopOutlined /></span>
                  <div>
                    <strong>{run.flowName} 运行失败</strong>
                    <p>{run.id} 的失败详情已记录在运行报告中。</p>
                    <Link to={`/project/${project.id}/runs/${run.id}`}>查看报告</Link>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
      <section className="surface quick-start">
        <div>
          <span className="eyebrow">快速操作</span>
          <h2>构建下一个可靠的流程</h2>
        </div>
        <div className="quick-actions">
          <Button
            icon={<FileSearchOutlined />}
            onClick={() => navigate(`/project/${project.id}/elements`)}
          >
            添加元素
          </Button>
          <Button
            icon={<CodeOutlined />}
            onClick={() => navigate(`/project/${project.id}/variables`)}
          >
            管理变量
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate(`/project/${project.id}/flows`)}
          >
            新建流程
          </Button>
        </div>
      </section>
    </>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "default",
  icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "default" | "success" | "warning" | "info";
  icon: React.ReactNode;
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function FlowsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const storedFlows = useWorkspaceStore((state) => state.flowsByProject[project.id]);
  const storedVariables = useWorkspaceStore(
    (state) => state.variablesByProject[project.id],
  );
  const storedElements = useWorkspaceStore(
    (state) => state.elementsByProject[project.id],
  );
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const activeEnvironmentId = useWorkspaceStore(
    (state) => state.activeEnvironmentByProject[project.id],
  );
  const setFlows = useWorkspaceStore((state) => state.setFlows);
  const upsertRun = useRunStore((state) => state.upsertRun);
  const sessionSecretValues = useSecretStore(
    (state) => state.valuesByProject[project.id] ?? emptySecretValues,
  );
  const setSecretValues = useSecretStore((state) => state.setValues);
  const items = storedFlows ?? emptyFlows;
  const variables = storedVariables ?? emptyVariables;
  const elements = storedElements ?? emptyElements;
  const environments = storedEnvironments ?? emptyEnvironments;
  const activeEnvironment =
    environments.find((environment) => environment.id === activeEnvironmentId) ??
    environments[0];
  const updateItems = (updater: (flows: Flow[]) => Flow[]) =>
    setFlows(project.id, updater(items));
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [draftOpen, setDraftOpen] = useState(false);
  const filtered = items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()) &&
    (tagFilter === "all" || item.tags.includes(tagFilter)),
  );
  const runFlow = async (flow: Flow) => {
    const steps = flow.definition ?? [];
    if (steps.length === 0) {
      message.error("请先在编排器中添加并保存至少一个流程步骤。");
      return;
    }
    if (!activeEnvironment) {
      message.error("当前项目没有可用运行环境");
      return;
    }
    const platformContext = platformProjectContext(project.id);
    let revision: PlatformRevision | undefined;
    let platformReady = false;
    if (platformContext) {
      try {
        const [{ revisions }, { bindings }] = await Promise.all([
          getPlatformRevisions(platformContext.session.token, platformContext.projectId),
          getAgentBindings(platformContext.session.token, platformContext.projectId),
        ]);
        revision = revisions.find((item) => (
          item.status === "published" &&
          item.flowId === flow.id &&
          item.environmentId === activeEnvironment.id
        ));
        platformReady = Boolean(
          revision && bindings.some((binding) => (
            binding.environmentId === activeEnvironment.id && binding.agent.status === "online"
          )),
        );
      } catch {
        // Platform is optional for local development. The Worker path remains available.
      }
    }
    const secretValues = await requestRunSecrets(
      project.id,
      variables,
      steps,
      sessionSecretValues,
      setSecretValues,
    );
    if (!secretValues) return;
    const secretVariables = requiredSecretVariables(variables, steps);
    if (!platformContext || !platformReady || !revision) {
      try {
        const request = localWorkerRunRequest({
          environment: activeEnvironment,
          flow: { id: flow.id, name: flow.name },
          steps,
          elements,
          variables,
          secretValues,
          secretVariables,
        });
        const { runId } = await createRun(project.id, request);
        const run: Run = {
          id: runId,
          flowName: flow.name,
          status: "queued",
          environment: activeEnvironment.name,
          progress: 0,
          completedSteps: 0,
          totalSteps: steps.length,
          startedAt: "刚刚",
          duration: "排队中",
          screenshots: 0,
          retries: 0,
        };
        upsertRun(project.id, run);
        watchWorkerRun(project.id, run, upsertRun);
        message.info("平台没有可用的已绑定在线 Agent，已改用本机 Playwright Worker");
        navigate(`/project/${project.id}/runs`);
      } catch {
        message.error("创建本机 Worker 运行失败，请确认本机服务正在运行");
      }
      return;
    }
    try {
      await Promise.all(
        secretVariables.flatMap((variable) => {
          const value = secretValues[variable.id];
          return value
            ? [savePlatformSecret(platformContext.session.token, platformContext.projectId, { name: variableReference(variable), value })]
            : [];
        }),
      );
      const created = await createPlatformRun(platformContext.session.token, platformContext.projectId, {
        revisionId: revision.id,
        environmentId: activeEnvironment.id,
      });
      const runId = created.runIds[0];
      if (!runId) throw new Error("PLATFORM_RUN_NOT_CREATED");
      const run: Run = {
        id: runId,
        flowName: flow.name,
        status: "queued",
        environment: activeEnvironment.name,
        progress: 0,
        completedSteps: 0,
        totalSteps: revision.stepCount ?? steps.length,
        startedAt: "刚刚",
        duration: "排队中",
        screenshots: 0,
        retries: 0,
      };
      upsertRun(project.id, run);
      message.success("已创建已发布版本的 Agent 运行");
      navigate(`/project/${project.id}/runs`);
    } catch {
      message.error("创建 Agent 运行失败，请确认密钥、版本和环境绑定配置");
    }
  };
  const columns: TableColumnsType<Flow> = [
    {
      title: "流程",
      dataIndex: "name",
      render: (_, flow) => (
        <button
          className="name-link"
          onClick={() =>
            navigate(`/project/${project.id}/flows/${flow.id}/edit`)
          }
        >
          <span className="flow-glyph">
            <UnorderedListOutlined />
          </span>
          <span>
            <strong>{flow.name}</strong>
            <small>{flow.description}</small>
          </span>
        </button>
      ),
    },
    {
      title: "标签",
      dataIndex: "tags",
      width: 190,
      render: (tags: string[]) => (
        <>
          {tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </>
      ),
    },
    { title: "步骤", dataIndex: "steps", width: 82, align: "center" },
    {
      title: "最近结果",
      dataIndex: "lastStatus",
      width: 125,
      render: (status: Run["status"]) => statusTag(status),
    },
    { title: "更新于", dataIndex: "updatedAt", width: 150 },
    {
      title: "",
      key: "actions",
      width: 142,
      render: (_, flow) => (
        <Space size={0}>
          <Tooltip title="运行流程">
            <Button
              type="text"
              icon={<PlayCircleFilled />}
              aria-label={`运行流程 ${flow.name}`}
              onClick={() => void runFlow(flow)}
            />
          </Tooltip>
          <Tooltip title="复制流程">
            <Button
              type="text"
              icon={<CopyOutlined />}
              aria-label={`复制流程 ${flow.name}`}
              onClick={() => {
                updateItems((list) => [
                  {
                    ...flow,
                    id: `${flow.id}-copy-${Date.now()}`,
                    name: `${flow.name} - 副本`,
                    updatedAt: "刚刚",
                  },
                  ...list,
                ]);
                message.success("已创建流程副本");
              }}
            />
          </Tooltip>
          <Popconfirm
            title="删除此流程？"
            okText="删除"
            cancelText="取消"
            onConfirm={() =>
              updateItems((list) => list.filter((item) => item.id !== flow.id))
            }
          >
            <Tooltip title="删除流程">
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除流程 ${flow.name}`}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  return (
    <>
      <PageHeading
        title="流程"
        description="由元素、动作和参数组合而成的可执行自动化流程。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setDraftOpen(true)}
          >
            新建流程
          </Button>
        }
      />
      <div className="list-tools">
        <Input
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索流程"
          allowClear
        />
        <Select
          value={tagFilter}
          onChange={setTagFilter}
          options={[
            { value: "all", label: "全部标签" },
            { value: "冒烟", label: "冒烟" },
            { value: "回归", label: "回归" },
          ]}
        />
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: <Empty description="尚无流程" /> }}
        />
      </section>
      <NewFlowDrawer
        open={draftOpen}
        project={project}
        onClose={() => setDraftOpen(false)}
        onCreated={(flow) => {
          updateItems((list) => [flow, ...list]);
          setDraftOpen(false);
          navigate(`/project/${project.id}/flows/${flow.id}/edit`);
        }}
      />
    </>
  );
}

function NewFlowDrawer({
  open,
  project,
  onClose,
  onCreated,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
  onCreated: (flow: Flow) => void;
}) {
  const [form] = Form.useForm();
  void project;
  useEffect(() => {
    if (open) form.resetFields();
  }, [form, open]);
  return (
    <Drawer
      title="新建流程"
      open={open}
      size={480}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          onClick={() =>
            form
              .validateFields()
              .then((values) => {
                const createdAt = Date.now();
                onCreated({
                  id: `flow-${createdAt}`,
                  name: values.name,
                  description: values.description || "尚未添加说明",
                  tags: values.tags || [],
                  steps: 0,
                  definition: [],
                  lastStatus: "queued",
                  updatedAt: "刚刚",
                });
              })
          }
        >
          创建并编辑
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          label="流程名称"
          name="name"
          rules={[{ required: true, message: "请输入流程名称" }]}
        >
          <Input placeholder="例如：用户登录并提交订单" />
        </Form.Item>
        <Form.Item label="说明" name="description">
          <Input.TextArea rows={3} placeholder="描述流程覆盖的业务场景" />
        </Form.Item>
        <Form.Item label="标签" name="tags">
          <Select
            mode="tags"
            placeholder="输入后按回车创建标签"
            options={[{ value: "冒烟" }, { value: "回归" }, { value: "支付" }]}
          />
        </Form.Item>
        <div className="drawer-note">
          <ExperimentOutlined /> 创建后可按需从空白编排器添加步骤。
        </div>
      </Form>
    </Drawer>
  );
}

function ElementsPage({ project }: { project: Project }) {
  const storedElements = useWorkspaceStore((state) => state.elementsByProject[project.id]);
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const setElements = useWorkspaceStore((state) => state.setElements);
  const items = storedElements ?? emptyElements;
  const environments = storedEnvironments ?? emptyEnvironments;
  const updateItems = (updater: (elements: ElementAsset[]) => ElementAsset[]) =>
    setElements(project.id, updater(items));
  const [editor, setEditor] = useState<ElementAsset | null | "new">(null);
  const [validating, setValidating] = useState<ElementAsset | null>(null);
  const [validation, setValidation] = useState<{
    element: ElementAsset;
    count: number;
    environment: string;
    screenshotUrl?: string;
    elapsedMs?: number;
    firstMatch?: string;
    reason?: string;
  } | null>(null);
  const [validationTarget, setValidationTarget] =
    useState<ElementAsset | null>(null);
  const [validationEnvironment, setValidationEnvironment] = useState("");
  const [search, setSearch] = useState("");
  const [validationFilter, setValidationFilter] = useState("all");
  const filtered = items.filter((item) =>
    [item.name, item.path, item.value]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()) &&
    (validationFilter === "all" || item.validation === validationFilter),
  );
  const startValidation = (element: ElementAsset) => {
    setValidationTarget(element);
    setValidationEnvironment(element.environment);
  };
  const confirmValidation = async () => {
    if (!validationTarget) return;
    const target = validationTarget;
    const environment = environments.find(
      (item) => item.id === validationEnvironment,
    );
    if (!environment) return;
    setValidationTarget(null);
    setValidating(target);
    try {
      const platformContext = platformProjectContext(project.id);
      if (platformContext) {
        const created = await createPlatformElementValidation(
          platformContext.session.token,
          platformContext.projectId,
          { environmentId: environment.id, element: target },
        );
        const validationId = created.validation.id;
        let task = created.validation;
        for (let attempt = 0; attempt < 80 && (task.status === "queued" || task.status === "running"); attempt += 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
          const response = await getPlatformElementValidation(
            platformContext.session.token,
            platformContext.projectId,
            validationId,
          );
          task = response.validation;
        }
        if (task.status === "queued" || task.status === "running") throw new Error("VALIDATION_TIMEOUT");
        const count = Number(task.result?.count ?? 0);
        const validationStatus = count === 1 ? "valid" : count > 1 ? "multiple" : "unverified";
        updateItems((list) => list.map((item) => (
          item.id === target.id ? { ...item, validation: validationStatus, updatedAt: "刚刚" } : item
        )));
        setValidating(null);
        setValidation({
          element: target,
          count,
          environment: environment.name,
          elapsedMs: task.result?.elapsedMs,
          firstMatch: task.result?.firstMatch,
          reason: task.error,
        });
        return;
      }
      const { validationId } = await createValidation(project.id, environment, target);
      const unsubscribe = subscribeToTask(
        project.id,
        "validations",
        validationId,
        (event) => {
          if (event.kind !== "result") return;
          const count = Number(event.data.count ?? 0);
          const screenshotId = event.data.screenshotId;
          const validationStatus =
            count === 1 ? "valid" : count > 1 ? "multiple" : "unverified";
          updateItems((list) =>
            list.map((item) =>
              item.id === target.id
                ? { ...item, validation: validationStatus, updatedAt: "刚刚" }
                : item,
            ),
          );
          setValidating(null);
          setValidation({
            element: target,
            count,
            environment: environment.name,
            screenshotUrl:
              typeof screenshotId === "string"
                ? artifactUrl(project.id, screenshotId)
                : undefined,
            elapsedMs: Number(event.data.elapsedMs ?? 0),
            firstMatch:
              typeof event.data.firstMatch === "string" ? event.data.firstMatch : undefined,
            reason: typeof event.data.reason === "string" ? event.data.reason : undefined,
          });
          unsubscribe();
        },
        () => {
          setValidating(null);
          message.error("无法连接 Playwright Worker，元素验证未执行。");
        },
      );
    } catch {
      setValidating(null);
      message.error("创建元素验证任务失败，请检查 Playwright Worker。");
    }
  };
  const columns: TableColumnsType<ElementAsset> = [
    {
      title: "元素",
      dataIndex: "name",
      render: (_, item) => (
        <button className="name-link" onClick={() => setEditor(item)}>
          <span className="element-glyph">
            <FileSearchOutlined />
          </span>
          <span>
            <strong>{item.name}</strong>
            <small>{item.description}</small>
          </span>
        </button>
      ),
    },
    {
      title: "页面路径",
      dataIndex: "path",
      width: 185,
      render: (path) => <code className="inline-code">{path}</code>,
    },
    {
      title: "定位器",
      key: "locator",
      width: 265,
      render: (_, item) => (
        <div className="locator-cell">
          <Tag
            color={
              item.method === "CSS" || item.method === "XPath"
                ? "warning"
                : "cyan"
            }
          >
            {item.method}
          </Tag>
          <code>{item.value}</code>
        </div>
      ),
    },
    {
      title: "验证状态",
      dataIndex: "validation",
      width: 130,
      render: (value) => (
        <span className={`validation-status ${value}`}>
          <i />
          {value === "valid"
            ? "唯一匹配"
            : value === "multiple"
              ? "多个匹配"
              : "未验证"}
        </span>
      ),
    },
    { title: "更新于", dataIndex: "updatedAt", width: 135 },
    {
      title: "",
      key: "actions",
      width: 105,
      render: (_, item) => (
        <Space size={0}>
          <Tooltip title="验证元素">
            <Button
              type="text"
              icon={<ExperimentOutlined />}
              aria-label={`验证元素 ${item.name}`}
              onClick={() => startValidation(item)}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="text"
              icon={<EditOutlined />}
              aria-label={`编辑元素 ${item.name}`}
              onClick={() => setEditor(item)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];
  return (
    <>
      <PageHeading
        title="元素库"
        description="维护可复用的页面定位资产，并持续验证其稳定性。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setEditor("new")}
          >
            新建元素
          </Button>
        }
      />
      <div className="list-tools">
        <Input
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索名称、路径或定位值"
          allowClear
        />
        <Select
          value={validationFilter}
          onChange={setValidationFilter}
          options={[
            { value: "all", label: "全部验证状态" },
            { value: "valid", label: "唯一匹配" },
            { value: "multiple", label: "多个匹配" },
          ]}
        />
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 8, showSizeChanger: false }}
        />
      </section>
      <ElementDrawer
        open={editor !== null}
        element={editor === "new" ? undefined : editor}
        environments={environments}
        onClose={() => setEditor(null)}
        onSave={(element) => {
          updateItems((list) => {
            const exists = list.some((item) => item.id === element.id);
            return exists
              ? list.map((item) => (item.id === element.id ? element : item))
              : [element, ...list];
          });
          setEditor(null);
          message.success("元素已保存");
        }}
      />
      <Modal
        title="选择验证环境"
        open={validationTarget !== null}
        okText="开始验证"
        cancelText="取消"
        okButtonProps={{ disabled: environments.length === 0 }}
        onOk={confirmValidation}
        onCancel={() => setValidationTarget(null)}
      >
        <p className="validation-target">
          将验证元素「{validationTarget?.name}」的唯一性。
        </p>
        <Select
          className="validation-environment-select"
          value={validationEnvironment}
          onChange={setValidationEnvironment}
          options={environments.map((item) => ({
            value: item.id,
            label: `${item.name} · ${item.baseUrl}`,
          }))}
        />
      </Modal>
      <Modal
        open={validating !== null}
        footer={null}
        closable={false}
        centered
        width={380}
      >
        <div className="validation-progress">
          <Spin size="large" />
          <h3>正在验证元素</h3>
          <p>Playwright Worker 正在打开目标页面并检查定位器唯一性。</p>
        </div>
      </Modal>
      <ValidationModal
        result={validation}
        onClose={() => setValidation(null)}
      />
    </>
  );
}

function ElementDrawer({
  open,
  element,
  environments,
  onClose,
  onSave,
}: {
  open: boolean;
  element?: ElementAsset | null;
  environments: Environment[];
  onClose: () => void;
  onSave: (element: ElementAsset) => void;
}) {
  const [form] = Form.useForm();
  const method = Form.useWatch("method", form);
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue(
      element ?? {
        method: "testid",
        path: "/",
        environment: environments[0]?.id,
      },
    );
  }, [element, environments, form, open]);
  return (
    <Drawer
      title={element ? "编辑元素" : "新建元素"}
      open={open}
      size={520}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          aria-label="保存"
          onClick={() =>
            form
              .validateFields()
              .then((values) =>
                onSave({
                  id: element?.id ?? `element-${Date.now()}`,
                  name: values.name,
                  description: values.description || "尚未添加描述",
                  path: values.path,
                  method: values.method,
                  value: values.value,
                  environment: values.environment,
                  validation: element?.validation ?? "unverified",
                  updatedAt: "刚刚",
                }),
              )
          }
        >
          保存
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="元素名称"
          rules={[{ required: true, message: "请输入元素名称" }]}
        >
          <Input placeholder="例如：登录按钮" />
        </Form.Item>
        <Form.Item
          name="path"
          label="所属页面路径"
          rules={[{ required: true, message: "请输入页面路径" }]}
        >
          <Input placeholder="/login（拼接环境 baseUrl）" />
        </Form.Item>
        <div className="form-row">
          <Form.Item
            name="method"
            label="定位方式"
            rules={[{ required: true }]}
          >
            <Select
              options={["testid", "role", "label", "text", "CSS", "XPath"].map(
                (value) => ({ value, label: value }),
              )}
            />
          </Form.Item>
          <Form.Item name="environment" label="默认验证环境">
            <Select
              options={environments.map(
                (item) => ({ value: item.id, label: item.name }),
              )}
            />
          </Form.Item>
        </div>
        <Form.Item
          name="value"
          label="定位值"
          rules={[{ required: true, message: "请输入定位值" }]}
        >
          <Input
            placeholder={
              method === "testid"
                ? "login-submit"
                : method === "role"
                  ? 'button[name="登录"]'
                  : "输入定位值"
            }
          />
        </Form.Item>
        {(method === "CSS" || method === "XPath") && (
          <Alert
            showIcon
            type="warning"
            title="该定位方式稳定性较低"
            description="优先选择 testid、role 或 label。CSS/XPath 在页面结构变化后更容易失效。"
          />
        )}
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="说明元素用途及使用注意事项" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

function ValidationModal({
  result,
  onClose,
}: {
  result: {
    element: ElementAsset;
    count: number;
    environment: string;
    screenshotUrl?: string;
    elapsedMs?: number;
    firstMatch?: string;
    reason?: string;
  } | null;
  onClose: () => void;
}) {
  if (!result) return null;
  const notFound = result.count === 0;
  const multiple = result.count > 1;
  return (
    <Modal
      open
      footer={
        <Button type="primary" onClick={onClose}>
          完成
        </Button>
      }
      onCancel={onClose}
      title="元素验证结果"
      width={670}
    >
      <div
        className={`validation-result ${
          notFound ? "not-found" : multiple ? "multiple" : "success"
        }`}
      >
        <div className="result-icon">
          {notFound || multiple ? <WarningFilled /> : <CheckCircleFilled />}
        </div>
        <div>
          <h3>
            {notFound
              ? "未找到匹配元素"
              : multiple
                ? `发现 ${result.count} 个匹配元素`
                : "定位器唯一匹配"}
          </h3>
          <p>已在{result.environment}完成验证，耗时 {durationFromMilliseconds(result.elapsedMs)}。</p>
        </div>
      </div>
      {result.screenshotUrl && (
        <div className="browser-shot worker-shot">
          <img src={result.screenshotUrl} alt="Worker 验证截图" />
        </div>
      )}
      {result.firstMatch && (
        <div className="result-detail">
          <span>首个匹配元素</span>
          <code>{result.firstMatch}</code>
        </div>
      )}
      {notFound && (
        <Alert
          type="error"
          showIcon
          title="定位器没有匹配到页面元素"
          description={result.reason ?? "请确认基础地址、页面路径和前置流程；也可检查页面是否仍使用当前定位器。"}
        />
      )}
      {multiple && (
        <Alert
          type="warning"
          showIcon
            title="建议进一步缩小定位范围"
          description="候选项已定位到页面中的相同按钮。请改用 testid 或提供更具体的 role 与名称。"
        />
      )}
    </Modal>
  );
}

function VariablesPage({ project }: { project: Project }) {
  const storedVariables = useWorkspaceStore((state) => state.variablesByProject[project.id]);
  const setVariables = useWorkspaceStore((state) => state.setVariables);
  const items = storedVariables ?? emptyVariables;
  const updateItems = (updater: (variables: Variable[]) => Variable[]) =>
    setVariables(project.id, updater(items));
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const columns: TableColumnsType<Variable> = [
    {
      title: "变量",
      dataIndex: "name",
      render: (_, item) => (
        <div className="variable-name">
          <span className="var-glyph">
            {item.scope === "环境" ? "E" : item.scope === "内置" ? "R" : "P"}
          </span>
          <span>
            <strong>{item.name}</strong>
            <small>{item.description}</small>
          </span>
        </div>
      ),
    },
    {
      title: "作用域",
      dataIndex: "scope",
      width: 110,
      render: (scope) => <Tag>{scope}</Tag>,
    },
    {
      title: "值",
      dataIndex: "value",
      width: 260,
      render: (value, item) => (
        <code className="value-code">
          {item.secret ? "••••••••••••" : value}
        </code>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 145,
      render: (_, item) =>
        item.secret ? (
          <span className="configured">
            <CheckCircleFilled /> 已配置
          </span>
        ) : (
          <span className="configured">普通变量</span>
        ),
    },
    { title: "更新于", dataIndex: "updatedAt", width: 150 },
    {
      title: "",
      key: "actions",
      width: 66,
      render: (_, item) =>
        item.scope !== "内置" && (
          <Popconfirm
            title="删除变量？"
            okText="删除"
            cancelText="取消"
            onConfirm={() =>
              updateItems((list) =>
                list.filter((variable) => variable.id !== item.id),
              )
            }
          >
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={`删除变量 ${item.name}`}
            />
          </Popconfirm>
        ),
    },
  ];
  const filtered = items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()) &&
    (scopeFilter === "all" || item.scope === scopeFilter),
  );
  return (
    <>
      <PageHeading
        title="变量"
        description="在流程参数中使用 {{env.xxx}}、{{project.xxx}} 和 {{run.xxx}} 引用值。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setDrawer(true)}
          >
            新建变量
          </Button>
        }
      />
      <Alert
        className="scope-alert"
        showIcon
        type="info"
        title="密钥变量不会返回明文"
        description="接口只返回“已配置”和最后更新时间；运行时由 Worker 解析注入。"
      />
      <div className="list-tools">
        <Input
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索变量"
          allowClear
        />
        <Select
          value={scopeFilter}
          onChange={setScopeFilter}
          options={[
            { value: "all", label: "全部作用域" },
            { value: "环境", label: "环境变量" },
            { value: "项目", label: "项目变量" },
          ]}
        />
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={false}
        />
      </section>
      <VariableDrawer
        open={drawer}
        project={project}
        onClose={() => setDrawer(false)}
        onSave={(variable) => {
          updateItems((list) => [variable, ...list]);
          setDrawer(false);
          message.success("变量已创建");
        }}
      />
    </>
  );
}

function VariableDrawer({
  open,
  project,
  onClose,
  onSave,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
  onSave: (variable: Variable) => void;
}) {
  const [form] = Form.useForm();
  void project;
  const secret = Form.useWatch("secret", form);
  useEffect(() => {
    if (open) form.setFieldsValue({ scope: "项目", secret: false });
  }, [form, open]);
  return (
    <Drawer
      title="新建变量"
      open={open}
      size={480}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          onClick={() =>
            form
              .validateFields()
              .then((values) =>
                onSave({
                  id: `var-${Date.now()}`,
                  name: values.name,
                  description: values.description || "项目变量",
                  value: values.secret ? "" : values.value || "",
                  scope: values.scope,
                  secret: values.secret,
                  updatedAt: "刚刚",
                }),
              )
          }
        >
          保存变量
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="变量名"
          rules={[{ required: true, message: "请输入变量名" }]}
          extra="引用格式：{{project.变量名}}"
        >
          <Input placeholder="例如：username" />
        </Form.Item>
        <Form.Item name="scope" label="作用域">
          <Select
            options={[
              { value: "项目", label: "项目变量" },
              { value: "环境", label: "环境变量" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="value"
          label="值"
          rules={[{ required: !secret, message: "请输入变量值" }]}
        >
          <Input
            type={secret ? "password" : "text"}
            placeholder={secret ? "密钥只会在保存时提交" : "输入变量值"}
          />
        </Form.Item>
        <Form.Item name="secret" label="密钥变量" valuePropName="checked">
          <Switch checkedChildren="密钥" unCheckedChildren="普通" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="说明变量的业务用途" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

function EnvironmentsPage({ project }: { project: Project }) {
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const setEnvironments = useWorkspaceStore((state) => state.setEnvironments);
  const items = storedEnvironments ?? emptyEnvironments;
  const updateItems = (updater: (environments: Environment[]) => Environment[]) =>
    setEnvironments(project.id, updater(items));
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState<Environment | undefined>();
  return (
    <>
      <PageHeading
        title="环境"
        description="为同一流程维护独立的访问地址、浏览器与认证配置。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(undefined);
              setDrawer(true);
            }}
          >
            新建环境
          </Button>
        }
      />
      <section className="environment-grid">
        {items.map((environment) => (
          <article className="environment-card" key={environment.id}>
            <div className="environment-card-top">
              <span className={`environment-color ${environment.color}`} />
              <div>
                <h2>{environment.name}</h2>
                <p>{environment.description}</p>
              </div>
              <Dropdown
                menu={{
                  items: [
                    {
                      key: "edit",
                      label: "编辑环境",
                      onClick: () => {
                        setEditing(environment);
                        setDrawer(true);
                      },
                    },
                    {
                      key: "delete",
                      label: "删除环境",
                      danger: true,
                      onClick: () =>
                        updateItems((list) =>
                          list.filter((item) => item.id !== environment.id),
                        ),
                    },
                  ],
                }}
              >
                <Button
                  type="text"
                  icon={<MoreOutlined />}
                  aria-label={`${environment.name}更多操作`}
                />
              </Dropdown>
            </div>
            <div className="environment-url">
              <GlobalOutlined />
              <code>{environment.baseUrl}</code>
            </div>
            <dl>
              <div>
                <dt>浏览器</dt>
                <dd>{environment.browser}</dd>
              </div>
              <div>
                <dt>认证方式</dt>
                <dd>{environment.auth}</dd>
              </div>
              <div>
                <dt>超时</dt>
                <dd>{environment.timeout} 秒</dd>
              </div>
            </dl>
            <div className="environment-footer">
              <span>
                <i /> 可用
              </span>
              <small>更新于 {environment.updatedAt}</small>
            </div>
          </article>
        ))}
      </section>
      <EnvironmentDrawer
        open={drawer}
        environment={editing}
        onClose={() => setDrawer(false)}
        onSave={(environment) => {
          updateItems((list) =>
            list.some((item) => item.id === environment.id)
              ? list.map((item) =>
                  item.id === environment.id ? environment : item,
                )
              : [...list, environment],
          );
          setDrawer(false);
          message.success("环境配置已保存");
        }}
      />
    </>
  );
}

function EnvironmentDrawer({
  open,
  environment,
  onClose,
  onSave,
}: {
  open: boolean;
  environment?: Environment;
  onClose: () => void;
  onSave: (environment: Environment) => void;
}) {
  const [form] = Form.useForm();
  useEffect(() => {
    if (open)
      form.setFieldsValue(
        environment ?? {
          browser: "Chromium",
          auth: "无认证",
          timeout: 30,
          testIdAttribute: "data-testid",
          keepBrowserOpenOnFailure: false,
        },
      );
  }, [environment, form, open]);
  return (
    <Drawer
      title={environment ? "编辑环境" : "新建环境"}
      open={open}
      size={500}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          onClick={() =>
            form
              .validateFields()
              .then((values) =>
                onSave({
                  id: environment?.id ?? `env-${Date.now()}`,
                  name: values.name,
                  description: values.description || "运行环境",
                  baseUrl: values.baseUrl,
                  browser: values.browser,
                  auth: values.auth,
                  timeout: values.timeout,
                  testIdAttribute: values.testIdAttribute || "data-testid",
                  keepBrowserOpenOnFailure: Boolean(values.keepBrowserOpenOnFailure),
                  color: environment?.color ?? "teal",
                  updatedAt: "刚刚",
                }),
              )
          }
        >
          保存配置
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="环境名称"
          rules={[{ required: true, message: "请输入环境名称" }]}
        >
          <Input placeholder="例如：测试环境" />
        </Form.Item>
        <Form.Item
          name="baseUrl"
          label="基础地址"
          rules={[{ required: true, type: "url", message: "请输入有效 URL" }]}
        >
          <Input placeholder="https://staging.example.com" />
        </Form.Item>
        <div className="form-row">
          <Form.Item name="browser" label="浏览器">
            <Select
              options={[{ value: "Chromium", label: "Chromium" }]}
            />
          </Form.Item>
          <Form.Item name="timeout" label="默认超时（秒）">
            <Input type="number" />
          </Form.Item>
        </div>
        <Form.Item name="auth" label="认证配置">
          <Select
            options={["无认证", "账号密码", "Cookie", "HTTP Basic"].map(
              (value) => ({ value }),
            )}
          />
        </Form.Item>
        <Form.Item
          name="testIdAttribute"
          label="测试属性名"
          rules={[{ required: true, message: "请输入测试属性名" }]}
        >
          <Input placeholder="data-testid" />
        </Form.Item>
        <Form.Item name="description" label="说明">
          <Input.TextArea rows={3} />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

function isWorkerRunId(id?: string) {
  return Boolean(id?.startsWith("run_"));
}

function reportRetryError(error: unknown) {
  if (error instanceof WorkerApiError && error.code === "RUN_SECRETS_REQUIRED") {
    message.info("此运行包含会话密钥，请从流程重新运行并重新注入密钥。");
    return true;
  }
  return false;
}

function isTerminalStatus(status: Run["status"]) {
  return status === "success" || status === "failed" || status === "canceled";
}

function variableReference(variable: Variable) {
  return `${variable.scope === "环境" ? "env" : "project"}.${variable.name}`;
}

function requiredSecretVariables(variables: Variable[], steps: FlowStep[]) {
  return variables.filter((variable) => {
    if (!variable.secret || (variable.scope !== "环境" && variable.scope !== "项目")) return false;
    const reference = variableReference(variable).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = new RegExp(`{{\\s*${reference}\\s*}}`);
    return steps.some((step) => token.test(step.value));
  });
}

function requestRunSecrets(
  projectId: string,
  variables: Variable[],
  steps: FlowStep[],
  sessionValues: Record<string, string>,
  setValues: (projectId: string, values: Record<string, string>) => void,
) {
  const required = requiredSecretVariables(variables, steps);
  const missing = required.filter((variable) => !sessionValues[variable.id]);
  if (missing.length === 0) return Promise.resolve(sessionValues);
  return new Promise<Record<string, string> | null>((resolve) => {
    const submitted = { ...sessionValues };
    modal.confirm({
      title: "运行前注入密钥",
      content: (
        <div className="secret-run-fields">
          {missing.map((variable) => (
            <label key={variable.id}>
              <span>{variable.name}</span>
              <Input.Password
                aria-label={`运行密钥 ${variable.name}`}
                autoComplete="off"
                onChange={(event) => {
                  submitted[variable.id] = event.target.value;
                }}
              />
            </label>
          ))}
        </div>
      ),
      okText: "注入并运行",
      cancelText: "取消",
      onOk: () => {
        const unresolved = missing.find((variable) => !submitted[variable.id]);
        if (unresolved) {
          message.error(`请填写密钥变量“${unresolved.name}”`);
          return Promise.reject(new Error("SECRET_VALUE_REQUIRED"));
        }
        setValues(projectId, submitted);
        resolve(submitted);
      },
      onCancel: () => resolve(null),
    });
  });
}

function platformVariables(variables: Variable[]) {
  return Object.fromEntries(
    variables
      .filter((variable) => !variable.secret && (variable.scope === "项目" || variable.scope === "环境"))
      .map((variable) => [variableReference(variable), variable.value]),
  );
}

function durationFromMilliseconds(value: unknown) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "-";
  return milliseconds >= 1000
    ? `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`
    : `${milliseconds}ms`;
}

function workerTaskAsRun(task: WorkerTask, fallback?: Run): Run {
  const totalSteps = Number(task.result?.totalSteps ?? task.summary?.totalSteps ?? fallback?.totalSteps ?? 0);
  const completedSteps = Number(task.result?.completedSteps ?? fallback?.completedSteps ?? 0);
  const terminal = isTerminalStatus(task.status);
  return {
    id: task.id,
    flowName: task.summary?.flowName ?? fallback?.flowName ?? "运行任务",
    status: task.status,
    environment: task.summary?.environmentName ?? fallback?.environment ?? "-",
    progress: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
    completedSteps,
    totalSteps,
    startedAt: fallback?.startedAt ?? new Date(task.createdAt).toLocaleString(),
    duration: terminal
      ? durationFromMilliseconds(task.result?.elapsedMs) !== "-"
        ? durationFromMilliseconds(task.result?.elapsedMs)
        : fallback?.duration ?? "已完成"
      : "进行中",
    screenshots: task.artifacts.filter((artifact) => artifact.contentType.startsWith("image/")).length,
    retries: fallback?.retries ?? 0,
  };
}

function platformRunAsRun(run: PlatformRun): Run {
  const snapshot = run.snapshot;
  const flow = snapshot.flow && typeof snapshot.flow === "object" ? snapshot.flow as Record<string, unknown> : {};
  const environment = snapshot.environment && typeof snapshot.environment === "object" ? snapshot.environment as Record<string, unknown> : {};
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const completedSteps = run.events.filter((event) => event.kind === "step.completed").length;
  const status: Run["status"] = run.status === "dispatched" ? "running" : run.status;
  return {
    id: run.id,
    flowName: typeof flow.name === "string" ? flow.name : "平台运行",
    status,
    environment: typeof environment.name === "string" ? environment.name : run.environmentId,
    progress: steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : status === "success" ? 100 : 0,
    completedSteps: status === "success" ? steps.length : completedSteps,
    totalSteps: steps.length,
    startedAt: new Date(run.createdAt).toLocaleString(),
    duration: isTerminalStatus(status) ? "已完成" : "进行中",
    screenshots: run.artifacts.filter((artifact) => artifact.contentType.startsWith("image/")).length,
    retries: Math.max(0, (run.lease?.attempt ?? 1) - 1),
  };
}

function watchWorkerRun(
  projectId: string,
  run: Run,
  upsertRun: (projectId: string, run: Run) => void,
) {
  let current = run;
  const unsubscribe = subscribeToTask(projectId, "runs", run.id, (event) => {
    if (event.kind === "status") {
      const status = event.data.status as Run["status"];
      if (!Object.hasOwn(statusMeta, status)) return;
      current = {
        ...current,
        status,
        progress: status === "success" ? 100 : current.progress,
        completedSteps: status === "success" ? current.totalSteps : current.completedSteps,
        duration: isTerminalStatus(status) ? "已完成" : "进行中",
      };
    }
    if (event.kind === "step") {
      const completedSteps =
        event.data.status === "success"
          ? Math.max(current.completedSteps, Number(event.data.index ?? -1) + 1)
          : current.completedSteps;
      current = {
        ...current,
        status: event.data.status === "failed" ? "failed" : "running",
        completedSteps,
        progress:
          current.totalSteps > 0
            ? Math.round((completedSteps / current.totalSteps) * 100)
            : 0,
        screenshots:
          event.data.artifactId && event.data.status === "failed"
            ? current.screenshots + 1
            : current.screenshots,
      };
    }
    upsertRun(projectId, current);
    if (isTerminalStatus(current.status)) unsubscribe();
  });
  return unsubscribe;
}

function RunsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const platformProjectId = platformProjectMap[project.id];
  const storedApiRuns = useRunStore((state) => state.apiRuns[project.id]);
  const apiRuns = storedApiRuns ?? emptyRuns;
  const upsertRun = useRunStore((state) => state.upsertRun);
  const [filter, setFilter] = useState("all");
  const [updatingRunId, setUpdatingRunId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!platformSession || !platformProjectId) return;
    let active = true;
    const refreshPlatformRuns = async () => {
      try {
        const response = await getPlatformRuns(platformSession.token, platformProjectId);
        if (!active) return;
        response.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
      } catch {
        // The legacy Worker run center remains usable when Platform is offline.
      }
    };
    void refreshPlatformRuns();
    const timer = window.setInterval(() => void refreshPlatformRuns(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [platformProjectId, platformSession, project.id, upsertRun]);
  const filtered =
    filter === "all" ? apiRuns : apiRuns.filter((run) => run.status === filter);
  const cancel = async (run: Run) => {
    setUpdatingRunId(run.id);
    try {
      if (isWorkerRunId(run.id)) {
        const task = await cancelRun(project.id, run.id);
        upsertRun(project.id, workerTaskAsRun(task, run));
        message.info("运行已停止，浏览器窗口已关闭。");
      } else if (platformSession && platformProjectId) {
        const response = await cancelPlatformRun(platformSession.token, platformProjectId, run.id);
        upsertRun(project.id, platformRunAsRun(response.run));
        message.info("已向 Agent 发送取消请求。");
      } else {
        throw new Error("PLATFORM_SESSION_REQUIRED");
      }
    } catch {
      message.error("取消运行失败，请稍后重试");
    } finally {
      setUpdatingRunId(null);
    }
  };
  const retry = async (run: Run) => {
    setUpdatingRunId(run.id);
    try {
      if (!isWorkerRunId(run.id)) {
        if (!platformSession || !platformProjectId) throw new Error("PLATFORM_SESSION_REQUIRED");
        const prior = await getPlatformRun(platformSession.token, platformProjectId, run.id);
        const created = await createPlatformRun(platformSession.token, platformProjectId, {
          revisionId: prior.run.revisionId,
          environmentId: prior.run.environmentId,
        });
        created.runs.forEach((platformRun) => upsertRun(project.id, platformRunAsRun(platformRun)));
        if (created.runIds[0]) navigate(`/project/${project.id}/runs/${created.runIds[0]}`);
        message.success("已重新提交给指定 Agent");
        return;
      }
      const { runId } = await retryRun(project.id, run.id);
      const retriedRun: Run = {
        ...run,
        id: runId,
        status: "queued",
        progress: 0,
        completedSteps: 0,
        startedAt: "刚刚",
        duration: "排队中",
        screenshots: 0,
        retries: run.retries + 1,
      };
      upsertRun(project.id, retriedRun);
      watchWorkerRun(project.id, retriedRun, upsertRun);
      message.success("已重新提交给 Playwright Worker");
      navigate(`/project/${project.id}/runs/${runId}`);
    } catch (error) {
      if (!reportRetryError(error)) message.error("重新提交失败，请稍后重试");
    } finally {
      setUpdatingRunId(null);
    }
  };
  const refresh = async () => {
    const workerRuns = apiRuns.filter((run) => isWorkerRunId(run.id));
    if (workerRuns.length === 0 && !platformProjectId) {
      message.info("当前没有需要刷新的 Worker 运行任务");
      return;
    }
    setRefreshing(true);
    const results = await Promise.allSettled([
      ...workerRuns.map(async (run) => {
        const task = await getRun(project.id, run.id);
        upsertRun(project.id, workerTaskAsRun(task, run));
      }),
      ...(platformSession && platformProjectId ? [
        getPlatformRuns(platformSession.token, platformProjectId).then((response) => {
          response.runs.forEach((platformRun) => upsertRun(project.id, platformRunAsRun(platformRun)));
        }),
      ] : []),
    ]);
    setRefreshing(false);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed === 0) message.success("运行状态已刷新");
    else message.warning(`已刷新 ${results.length - failed} 条运行，${failed} 条暂不可用`);
  };
  const columns: TableColumnsType<Run> = [
    {
      title: "运行任务",
      dataIndex: "id",
      render: (_, run) => (
        <button
          className="run-link"
          onClick={() => navigate(`/project/${project.id}/runs/${run.id}`)}
        >
          <span className={`run-status-dot ${run.status}`} />
          <span>
            <strong>{run.flowName}</strong>
            <small>{run.id}</small>
          </span>
        </button>
      ),
    },
    { title: "状态", dataIndex: "status", width: 120, render: statusTag },
    { title: "环境", dataIndex: "environment", width: 120 },
    {
      title: "进度",
      dataIndex: "progress",
      width: 175,
      render: (progress, run) => (
        <div className="run-progress">
          <Progress
            percent={progress}
            showInfo={false}
            size="small"
            status={
              run.status === "failed"
                ? "exception"
                : run.status === "success"
                  ? "success"
                  : "active"
            }
          />
          <span>
            {run.completedSteps}/{run.totalSteps}
          </span>
        </div>
      ),
    },
    { title: "开始时间", dataIndex: "startedAt", width: 165 },
    { title: "耗时", dataIndex: "duration", width: 100 },
    {
      title: "",
      key: "actions",
      width: 96,
      render: (_, run) =>
        !isTerminalStatus(run.status) ? (
          <Tooltip title="取消运行">
            <Button
              type="text"
              danger
              icon={<StopOutlined />}
              aria-label={`取消运行 ${run.flowName}`}
              loading={updatingRunId === run.id}
              onClick={() => void cancel(run)}
            />
          </Tooltip>
        ) : (
          <Tooltip title="重新运行">
            <Button
              type="text"
              icon={<ReloadOutlined />}
              aria-label={`重新运行 ${run.flowName}`}
              loading={updatingRunId === run.id}
              onClick={() => void retry(run)}
            />
          </Tooltip>
        ),
    },
  ];
  return (
    <>
      <PageHeading
        title="运行中心"
        description="查看当前与历史执行任务。实时状态通过 Worker 事件持续刷新。"
        actions={
          <Button
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={() => void refresh()}
          >
            刷新状态
          </Button>
        }
      />
      <div className="run-filter">
        <Space>
          <span>状态</span>
          <Select
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部" },
              ...Object.entries(statusMeta).map(([value, meta]) => ({
                value,
                label: meta.label,
              })),
            ]}
          />
        </Space>
        <span className="live-note">
          <i /> 实时更新已开启
        </span>
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: <Empty description="尚无真实运行任务" /> }}
        />
      </section>
    </>
  );
}


function SettingsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const updateProject = useWorkspaceStore((state) => state.updateProject);
  const archiveProject = useWorkspaceStore((state) => state.archiveProject);
  const members = useWorkspaceStore(
    (state) => state.membersByProject[project.id] ?? [],
  );
  const addMember = useWorkspaceStore((state) => state.addMember);
  const [form] = Form.useForm();
  const [memberForm] = Form.useForm();
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  useEffect(() => {
    form.setFieldsValue({ name: project.name, description: project.description });
  }, [form, project.description, project.id, project.name]);
  return (
    <>
      <PageHeading
        title="项目设置"
        description="管理项目基础信息、成员权限和危险操作。"
      />
      <section className="settings-stack">
        <div className="surface settings-section">
          <div>
            <h2>基础信息</h2>
            <p>这些信息仅影响当前项目。</p>
          </div>
          <Form
            form={form}
            layout="vertical"
            onFinish={(values) => {
              updateProject(project.id, {
                name: values.name.trim(),
                description: values.description.trim(),
              });
              message.success("项目设置已保存");
            }}
          >
            <Form.Item
              name="name"
              label="项目名称"
              rules={[{ required: true, whitespace: true, message: "请输入项目名称" }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label="项目说明">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
            >
              保存修改
            </Button>
          </Form>
        </div>
        <div className="surface settings-section">
          <div>
            <h2>成员与权限</h2>
            <p>权限在项目边界内独立管理。</p>
          </div>
          <div className="member-row">
            <Avatar style={{ background: "#ddeeea", color: "#147a73" }}>
              R
            </Avatar>
            <span>
              <strong>Rui Chen</strong>
              <small>rui@example.com</small>
            </span>
            <Tag color="green">管理员</Tag>
          </div>
          {members.map((member) => (
            <div className="member-row" key={member.id}>
              <Avatar style={{ background: "#e8ecff", color: "#38529b" }}>
                {member.name.slice(0, 1).toUpperCase()}
              </Avatar>
              <span>
                <strong>{member.name}</strong>
                <small>{member.email}</small>
              </span>
              <Tag color={member.role === "管理员" ? "green" : "blue"}>
                {member.role}
              </Tag>
            </div>
          ))}
          <Button icon={<PlusOutlined />} onClick={() => setMemberDialogOpen(true)}>
            添加成员
          </Button>
        </div>
        <div className="surface settings-section danger-zone">
          <div>
            <h2>归档项目</h2>
            <p>项目将从活动列表移除，并清理当前浏览器中的项目资产与配置。</p>
          </div>
          <Popconfirm
            title={`归档“${project.name}”？`}
            description="归档后将从活动项目列表移除。"
            okText="归档项目"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => {
              archiveProject(project.id);
              message.info(`“${project.name}”已归档`);
              navigate("/projects");
            }}
          >
            <Button danger icon={<PauseCircleOutlined />}>
              归档项目
            </Button>
          </Popconfirm>
        </div>
      </section>
      <Modal
        title="添加项目成员"
        open={memberDialogOpen}
        onCancel={() => setMemberDialogOpen(false)}
        okText="添加成员"
        onOk={() =>
          memberForm.validateFields().then((values) => {
            addMember(project.id, {
              name: values.name.trim(),
              email: values.email.trim(),
              role: values.role,
            });
            memberForm.resetFields();
            setMemberDialogOpen(false);
            message.success("成员已添加");
          })
        }
      >
        <Form form={memberForm} layout="vertical" initialValues={{ role: "成员" }}>
          <Form.Item
            name="name"
            label="成员姓名"
            rules={[{ required: true, message: "请输入成员姓名" }]}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item
            name="email"
            label="成员邮箱"
            rules={[
              { required: true, message: "请输入成员邮箱" },
              { type: "email", message: "请输入有效邮箱" },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="role" label="项目角色">
            <Select options={["成员", "管理员"].map((value) => ({ value }))} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function DebugSessionsPage({ project }: { project: Project }) {
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? []);
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [sessions, setSessions] = useState<PlatformDebugSession[]>([]);
  const [captures, setCaptures] = useState<PlatformPickerCapture[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState<string>();
  const [startForm] = Form.useForm();
  const platformProjectId = platformProjectMap[project.id];
  const selectedSession = sessions.find((item) => item.id === selectedSessionId) ?? sessions[0];
  const publishedRevisions = revisions.filter((revision) => revision.status === "published");
  const selectedRevisionId = Form.useWatch("revisionId", startForm);
  const selectedRevision = publishedRevisions.find((revision) => revision.id === selectedRevisionId);
  const selectedRevisionEnvironment = environments.find((environment) => environment.id === selectedRevision?.environmentId);
  const latestScreenshot = selectedSession?.artifacts.find((artifact) => artifact.contentType.startsWith("image/"));
  const latestScreenshotId = latestScreenshot?.id;
  const latestCapture = captures[0];

  const loadSessions = useCallback(async () => {
    if (!platformSession || !platformProjectId) return;
    setLoading(true);
    try {
      const [revisionResponse, sessionResponse] = await Promise.all([
        getPlatformRevisions(platformSession.token, platformProjectId),
        getDebugSessions(platformSession.token, platformProjectId),
      ]);
      setRevisions(revisionResponse.revisions);
      setSessions(sessionResponse.sessions);
      setSelectedSessionId((current) => current ?? sessionResponse.sessions[0]?.id);
    } catch {
      message.error("无法读取调试会话，请检查平台连接");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, platformSession]);

  useEffect(() => {
    void loadSessions();
    const interval = setInterval(() => void loadSessions(), 4_000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const loadPickerCaptures = useCallback(async () => {
    if (!platformSession || !platformProjectId || !selectedSession) {
      setCaptures([]);
      return;
    }
    try {
      const response = await getPickerCaptures(platformSession.token, platformProjectId, selectedSession.id);
      setCaptures(response.captures);
    } catch {
      setCaptures([]);
    }
  }, [platformProjectId, platformSession, selectedSession]);

  useEffect(() => {
    void loadPickerCaptures();
    const interval = setInterval(() => void loadPickerCaptures(), 3_000);
    return () => clearInterval(interval);
  }, [loadPickerCaptures]);

  useEffect(() => {
    if (!platformSession || !latestScreenshotId) {
      setScreenshotUrl(undefined);
      return;
    }
    let currentUrl: string | undefined;
    let cancelled = false;
    void fetchDebugArtifact(platformSession.token, latestScreenshotId)
      .then((blob) => {
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setScreenshotUrl(currentUrl);
      })
      .catch(() => setScreenshotUrl(undefined));
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [latestScreenshotId, platformSession]);

  const command = async (value: "start" | "continue" | "runCurrent" | "skip" | "pause" | "retry" | "stop") => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    try {
      const response = await sendDebugCommand(platformSession.token, platformProjectId, selectedSession.id, value);
      setSessions((current) => current.map((item) => item.id === response.session.id ? response.session : item));
      await loadSessions();
    } catch {
      message.error("调试命令未送达 Agent");
    }
  };

  const enablePicker = async () => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    try {
      await enableElementPicker(platformSession.token, platformProjectId, selectedSession.id);
      message.info("请在调试浏览器中点击一个元素");
    } catch {
      message.error("无法启用元素选取");
    }
  };

  const previewCandidate = async (capture: PlatformPickerCapture, candidateIndex: number) => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    try {
      await previewPickerCandidate(platformSession.token, platformProjectId, selectedSession.id, capture.id, candidateIndex);
    } catch {
      message.error("无法在浏览器中预览该候选定位器");
    }
  };

  const confirmCandidate = async (capture: PlatformPickerCapture, candidateIndex: number) => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    const candidate = capture.candidates[candidateIndex];
    try {
      const confirmed = await confirmPickerCandidate(platformSession.token, platformProjectId, selectedSession.id, capture.id, {
        candidateIndex,
        target: "element",
        name: candidate.value,
      });
      const workspace = useWorkspaceStore.getState();
      if (!workspace.elementsByProject[project.id]?.some((element) => element.id === confirmed.element.id)) {
        const element: ElementAsset = {
          ...confirmed.element,
          validation: confirmed.element.validation === "verified" ? "valid" : "unverified",
        };
        workspace.setElements(project.id, [
          ...(workspace.elementsByProject[project.id] ?? []),
          element,
        ]);
      }
      storePlatformDocumentVersion(platformProjectId, confirmed.documentVersion);
      try {
        const document = await getPlatformProjectDocument(platformSession.token, platformProjectId);
        storePlatformDocumentVersion(platformProjectId, document.version);
        useWorkspaceStore.getState().hydratePlatformProjects([{
          platformProjectId,
          sourceProjectId: project.id,
          name: project.name,
          description: project.description,
          document: document.data,
        }]);
        notifyPlatformContextChanged();
      } catch {
        // The confirmed element is already durable on Platform. A later refresh reconciles the full document.
      }
      await loadPickerCaptures();
      message.success("元素已写入草稿元素库");
    } catch {
      message.error("无法确认该元素候选");
    }
  };

  if (!platformSession) {
    return (
      <>
        <PageHeading title="调试" description="在有头 Chromium 会话中保留页面状态并定位失败步骤。" />
        <Alert type="info" showIcon title="请先连接平台账户" action={<Link to={`/project/${project.id}/agents`}>前往执行节点</Link>} />
      </>
    );
  }

  if (!platformProjectId) {
    return (
      <>
        <PageHeading title="调试" description="在有头 Chromium 会话中保留页面状态并定位失败步骤。" />
        <Alert type="info" showIcon title="当前项目尚未导入平台" action={<Link to={`/project/${project.id}/agents`}>导入并绑定节点</Link>} />
      </>
    );
  }

  const activeSession = selectedSession && !["ended", "failed", "expired"].includes(selectedSession.status);
  const readySession = selectedSession && ["active", "paused"].includes(selectedSession.status);
  const sessionColumns: TableColumnsType<PlatformDebugSession> = [
    {
      title: "会话",
      dataIndex: "createdAt",
      render: (value: string, session) => (
        <span>
          <strong>#{session.id.slice(0, 8)}</strong>
          <small className="table-secondary">{new Date(value).toLocaleString()}</small>
        </span>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (status: PlatformDebugSession["status"]) => (
        <Tag color={status === "active" ? "processing" : status === "paused" ? "gold" : ["failed", "expired"].includes(status) ? "error" : status === "ended" ? "default" : "blue"}>
          {status === "requested" ? "等待连接" : status === "active" ? "运行中" : status === "paused" ? "已暂停" : status === "ending" ? "结束中" : status === "ended" ? "已结束" : status === "failed" ? "失败" : "已超时"}
        </Tag>
      ),
    },
    { title: "节点", dataIndex: ["agent", "name"], width: 130, render: (value: string | undefined) => value ?? "分配中" },
    { title: "步骤", dataIndex: "currentStep", width: 70, render: (value: number) => value + 1 },
  ];

  return (
    <>
      <PageHeading
        title="调试"
        description="调试浏览器保持页面、Cookie 与当前步骤状态；空闲 15 分钟或最长 2 小时后自动回收。"
        actions={<Button type="primary" icon={<PlusOutlined />} disabled={!publishedRevisions.some((revision) => revision.environmentId)} onClick={() => { const revision = publishedRevisions[0]; startForm.setFieldsValue({ revisionId: revision?.id, environmentId: revision?.environmentId }); setStartOpen(true); }}>新建调试会话</Button>}
      />
      {publishedRevisions.length === 0 && <Alert className="debug-alert" type="warning" showIcon title="没有已发布版本，无法创建调试会话。" />}
      <section className="surface debug-session-table">
        <Table
          rowKey="id"
          columns={sessionColumns}
          dataSource={sessions}
          loading={loading}
          pagination={false}
          rowClassName={(session) => session.id === selectedSession?.id ? "debug-session-selected" : ""}
          onRow={(session) => ({ onClick: () => setSelectedSessionId(session.id) })}
          locale={{ emptyText: <Empty description="尚无调试会话" /> }}
        />
      </section>
      {selectedSession && (
        <section className="debug-workbench">
          <div className="surface debug-control-panel">
            <div className="debug-session-heading">
              <div>
                <span className="eyebrow">当前会话</span>
                <h2>#{selectedSession.id.slice(0, 8)}</h2>
              </div>
              <Tag color={activeSession ? "processing" : "default"}>{selectedSession.status}</Tag>
            </div>
            <dl className="debug-session-meta">
              <div><dt>当前 URL</dt><dd>{selectedSession.currentUrl ?? "浏览器准备中"}</dd></div>
              <div><dt>执行节点</dt><dd>{selectedSession.agent?.name ?? selectedSession.agentId}</dd></div>
              <div><dt>当前步骤</dt><dd>{selectedSession.currentStep + 1}</dd></div>
              <div><dt>空闲回收</dt><dd>{new Date(selectedSession.idleExpiresAt).toLocaleTimeString()}</dd></div>
            </dl>
            <div className="debug-command-bar">
              <Tooltip title={readySession ? "从第一个步骤连续执行" : "等待 Agent 初始化浏览器"}><Button type="primary" icon={<PlayCircleFilled />} disabled={!readySession} onClick={() => void command("start")}>从头运行</Button></Tooltip>
              <Tooltip title={readySession ? "从当前步骤继续执行" : "等待 Agent 初始化浏览器"}><Button icon={<PlayCircleFilled />} disabled={!readySession} onClick={() => void command("continue")}>继续</Button></Tooltip>
              <Tooltip title={readySession ? "仅执行当前步骤" : "等待 Agent 初始化浏览器"}><Button icon={<PlayCircleFilled />} disabled={!readySession} onClick={() => void command("runCurrent")}>当前步骤</Button></Tooltip>
              <Tooltip title={readySession ? "跳过当前步骤" : "等待 Agent 初始化浏览器"}><Button icon={<ThunderboltOutlined />} disabled={!readySession} onClick={() => void command("skip")}>跳过</Button></Tooltip>
              <Tooltip title={readySession ? "在下一步骤边界暂停" : "等待 Agent 初始化浏览器"}><Button icon={<PauseCircleOutlined />} disabled={!readySession} onClick={() => void command("pause")}>暂停</Button></Tooltip>
              <Tooltip title={readySession ? "重试当前步骤" : "等待 Agent 初始化浏览器"}><Button icon={<ReloadOutlined />} disabled={!readySession} onClick={() => void command("retry")}>重试</Button></Tooltip>
              <Tooltip title="结束并回收浏览器"><Button danger icon={<StopOutlined />} disabled={!activeSession} onClick={() => void command("stop")}>结束</Button></Tooltip>
            </div>
          </div>
          <div className="surface debug-observation-panel">
            <div className="panel-heading"><div><h2>页面快照</h2><span>由 Agent 定时上传</span></div></div>
            {latestScreenshot ? (
              screenshotUrl ? <img className="debug-screenshot" src={screenshotUrl} alt={`调试截图 ${latestScreenshot.name}`} /> : <Spin size="small" />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待安全截图" />}
          </div>
          <div className="surface debug-picker-panel">
            <div className="panel-heading">
              <div><h2>元素选取</h2><span>在调试浏览器中点击元素后生成候选</span></div>
              <Tooltip title={readySession ? "在调试浏览器中启用一次选取" : "等待 Agent 初始化浏览器"}><Button icon={<FileSearchOutlined />} disabled={!readySession} onClick={() => void enablePicker()} /></Tooltip>
            </div>
            {!latestCapture ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待浏览器点击" /> : (
              <div className="picker-candidate-list">
                {latestCapture.candidates.map((candidate, index) => (
                  <div className="picker-candidate-row" key={`${candidate.method}-${candidate.value}`}>
                    <span className="picker-score">{candidate.score}</span>
                    <div>
                      <strong>{candidate.method}</strong>
                      <code>{candidate.value}</code>
                      <small>{candidate.count === 1 ? "唯一匹配" : `${candidate.count} 个匹配`}</small>
                    </div>
                    <Space size={2}>
                      <Tooltip title="在调试浏览器中高亮"><Button size="small" icon={<FileSearchOutlined />} onClick={() => void previewCandidate(latestCapture, index)} /></Tooltip>
                      <Tooltip title="确认写入草稿元素库"><Button size="small" type="primary" icon={<CheckCircleFilled />} disabled={latestCapture.status !== "pending"} onClick={() => void confirmCandidate(latestCapture, index)} /></Tooltip>
                    </Space>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="surface debug-event-panel">
            <div className="panel-heading"><div><h2>会话事件</h2><span>URL、步骤、控制台与网络失败</span></div><Button icon={<ReloadOutlined />} onClick={() => void loadSessions()} /></div>
            <div className="debug-event-list">
              {selectedSession.events.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待 Agent 事件" /> : selectedSession.events.map((event) => (
                <div className={`debug-event-row ${event.kind.includes("failed") || event.kind.includes("error") ? "error" : ""}`} key={event.id}>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                  <strong>{event.kind}</strong>
                  <span>{typeof event.data.message === "string" ? event.data.message : typeof event.data.currentUrl === "string" ? event.data.currentUrl : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
      <Modal
        title="新建调试会话"
        open={startOpen}
        confirmLoading={creating}
        onCancel={() => setStartOpen(false)}
        okText="创建会话"
        onOk={() => startForm.validateFields().then(async (values) => {
          if (!platformSession) return;
          setCreating(true);
          try {
            const result = await createDebugSession(platformSession.token, platformProjectId, values);
            setSelectedSessionId(result.session.id);
            setStartOpen(false);
            await loadSessions();
            message.success("调试浏览器正在准备");
          } catch {
            message.error("无法创建调试会话，请确认有在线绑定节点");
          } finally {
            setCreating(false);
          }
        })}
      >
        <Form form={startForm} layout="vertical">
          <Form.Item name="revisionId" label="已发布流程版本" rules={[{ required: true, message: "请选择已发布版本" }]}>
            <Select onChange={(revisionId) => startForm.setFieldsValue({ environmentId: publishedRevisions.find((revision) => revision.id === revisionId)?.environmentId })} options={publishedRevisions.map((revision) => ({ value: revision.id, label: `版本 ${revision.revisionNumber} · ${new Date(revision.publishedAt ?? revision.createdAt).toLocaleString()}` }))} />
          </Form.Item>
          <Form.Item name="environmentId" label="运行环境" rules={[{ required: true, message: "请选择运行环境" }]}>
            <Select disabled options={selectedRevisionEnvironment ? [{ value: selectedRevisionEnvironment.id, label: selectedRevisionEnvironment.name }] : []} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function DatasetsPage({ project }: { project: Project }) {
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [datasets, setDatasets] = useState<PlatformDataset[]>([]);
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [versionTarget, setVersionTarget] = useState<PlatformDataset>();
  const [preview, setPreview] = useState<{ version: PlatformDatasetVersion; rows: Array<{ rowNumber: number; data: Record<string, string> }>; truncated: boolean }>();
  const [importFile, setImportFile] = useState<File>();
  const [versionFile, setVersionFile] = useState<File>();
  const [submitting, setSubmitting] = useState(false);
  const [importForm] = Form.useForm();
  const platformProjectId = platformProjectMap[project.id];

  const loadDatasets = useCallback(async () => {
    if (!platformSession || !platformProjectId) return;
    setLoading(true);
    try {
      const response = await getPlatformDatasets(platformSession.token, platformProjectId);
      setDatasets(response.datasets);
    } catch {
      message.error("无法读取平台数据集");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, platformSession]);

  useEffect(() => { void loadDatasets(); }, [loadDatasets]);

  const previewVersion = async (dataset: PlatformDataset) => {
    if (!platformSession || !platformProjectId || !dataset.latestVersion) return;
    try {
      const response = await getPlatformDatasetVersion(platformSession.token, platformProjectId, dataset.latestVersion.id);
      setPreview(response);
    } catch {
      message.error("无法读取数据集版本");
    }
  };

  const upload = async (target?: PlatformDataset) => {
    if (!platformSession || !platformProjectId) return;
    const file = target ? versionFile : importFile;
    if (!file) {
      message.warning("请选择 CSV 或 Excel 文件");
      return;
    }
    setSubmitting(true);
    try {
      const contentBase64 = await readFileAsBase64(file);
      if (target) {
        await importPlatformDatasetVersion(platformSession.token, platformProjectId, target.id, { fileName: file.name, contentBase64 });
        setVersionTarget(undefined);
        setVersionFile(undefined);
        message.success("已创建新的数据集版本");
      } else {
        const values = await importForm.validateFields();
        await importPlatformDataset(platformSession.token, platformProjectId, { ...values, fileName: file.name, contentBase64 });
        importForm.resetFields();
        setImportFile(undefined);
        setImportOpen(false);
        message.success("数据集已导入并冻结为版本 1");
      }
      await loadDatasets();
    } catch {
      message.error("数据集导入失败，请检查表头、文件大小和平台连接");
    } finally {
      setSubmitting(false);
    }
  };

  if (!platformSession || !platformProjectId) {
    return <PlatformProjectRequired project={project} title="数据集" description="将 CSV 或 Excel 表格导入为可复现的数据集版本。" />;
  }

  const columns: TableColumnsType<PlatformDataset> = [
    { title: "数据集", dataIndex: "name", render: (name: string, item) => <span><strong>{name}</strong><small className="table-secondary">{item.description || "无说明"}</small></span> },
    { title: "最新版本", width: 120, render: (_, item) => item.latestVersion ? `v${item.latestVersion.versionNumber}` : "-" },
    { title: "行数", width: 90, render: (_, item) => item.latestVersion?.rowCount ?? 0 },
    { title: "列", width: 220, render: (_, item) => item.latestVersion?.columns.join(" · ") ?? "-" },
    { title: "更新于", dataIndex: "updatedAt", width: 180, render: (value: string) => new Date(value).toLocaleString() },
    {
      title: "",
      width: 110,
      render: (_, item) => <Space size={2}>
        <Tooltip title="预览冻结版本"><Button icon={<FileSearchOutlined />} onClick={() => void previewVersion(item)} disabled={!item.latestVersion} /></Tooltip>
        <Tooltip title="导入新版本"><Button icon={<ReloadOutlined />} onClick={() => { setVersionFile(undefined); setVersionTarget(item); }} /></Tooltip>
      </Space>,
    },
  ];

  return (
    <>
      <PageHeading title="数据集" description="导入后生成不可变版本；参数化执行时每行独立创建一个运行快照。" actions={<Space><Tooltip title="刷新数据集"><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadDatasets()} /></Tooltip><Button type="primary" icon={<PlusOutlined />} onClick={() => { importForm.resetFields(); setImportFile(undefined); setImportOpen(true); }}>导入数据集</Button></Space>} />
      <section className="surface project-table">
        <Table rowKey="id" columns={columns} dataSource={datasets} loading={loading} pagination={false} locale={{ emptyText: <Empty description="尚未导入数据集" /> }} />
      </section>
      <Modal title="导入数据集" open={importOpen} confirmLoading={submitting} okText="导入并创建版本" onCancel={() => setImportOpen(false)} onOk={() => void upload()}>
        <Form form={importForm} layout="vertical">
          <Form.Item name="name" label="数据集名称" rules={[{ required: true, message: "请输入数据集名称" }]}><Input autoFocus /></Form.Item>
          <Form.Item name="description" label="说明"><Input /></Form.Item>
          <Form.Item label="CSV 或 Excel" required extra="首行作为表头；最多 10,000 行。">
            <Input type="file" accept=".csv,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0])} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={`导入 ${versionTarget?.name ?? ""} 的新版本`} open={Boolean(versionTarget)} confirmLoading={submitting} okText="创建版本" onCancel={() => setVersionTarget(undefined)} onOk={() => versionTarget && void upload(versionTarget)}>
        <Form layout="vertical"><Form.Item label="CSV 或 Excel" required extra="既有版本不会被覆盖。"><Input type="file" accept=".csv,.xlsx" onChange={(event) => setVersionFile(event.target.files?.[0])} /></Form.Item></Form>
      </Modal>
      <Modal title={preview ? `版本 ${preview.version.versionNumber} 预览` : "数据预览"} open={Boolean(preview)} footer={<Button onClick={() => setPreview(undefined)}>关闭</Button>} onCancel={() => setPreview(undefined)} width={900}>
        {preview && <Table size="small" rowKey="rowNumber" pagination={false} scroll={{ x: true, y: 360 }} dataSource={preview.rows.map((row) => ({ key: row.rowNumber, ...row.data }))} columns={preview.version.columns.map((column) => ({ title: column, dataIndex: column, width: 180 }))} />}
        {preview?.truncated && <Alert className="dataset-preview-alert" type="info" showIcon title="预览仅显示前 100 行。" />}
      </Modal>
    </>
  );
}

function PlatformProjectRequired({ project, title, description }: { project: Project; title: string; description: string }) {
  const [session] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  return (
    <>
      <PageHeading title={title} description={description} />
      <Alert type="info" showIcon title={session ? "当前项目尚未导入平台" : "请先连接平台账户"} action={<Link to={`/project/${project.id}/agents`}>{session ? "导入并绑定节点" : "前往执行节点"}</Link>} />
    </>
  );
}

function AutomationsPage({ project }: { project: Project }) {
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

function GovernancePage({ project }: { project: Project }) {
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

function AgentsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? []);
  const activeEnvironmentId = useWorkspaceStore((state) => state.activeEnvironmentByProject[project.id]);
  const flows = useWorkspaceStore((state) => state.flowsByProject[project.id] ?? []);
  const elements = useWorkspaceStore((state) => state.elementsByProject[project.id] ?? []);
  const variables = useWorkspaceStore((state) => state.variablesByProject[project.id] ?? []);
  const upsertRun = useRunStore((state) => state.upsertRun);
  const [session, setSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [workspaceId, setWorkspaceId] = useState(() => readStoredPlatformWorkspaceId(readStoredPlatformSession()));
  const [projectMap, setProjectMap] = useState<Record<string, string>>(() => readPlatformProjectMap(readStoredPlatformWorkspaceId(readStoredPlatformSession())));
  const [agents, setAgents] = useState<PlatformAgent[]>([]);
  const [bindings, setBindings] = useState<Array<{ environmentId: string; agent: { id: string; name: string; status: string } }>>([]);
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [loginForm] = Form.useForm();
  const [bindingForm] = Form.useForm();
  const [releaseForm] = Form.useForm();
  const [registrationToken, setRegistrationToken] = useState<string>();
  const [bindingOpen, setBindingOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const platformProjectId = projectMap[project.id];
  const activeEnvironment = environments.find((environment) => environment.id === activeEnvironmentId) ?? environments[0];

  const loadNodes = useCallback(async () => {
    if (!session || !workspaceId) return;
    setLoading(true);
    try {
      const agentResponse = await getPlatformAgents(session.token, workspaceId);
      setAgents(agentResponse.agents);
      if (platformProjectId) {
        const [bindingResponse, revisionResponse] = await Promise.all([
          getAgentBindings(session.token, platformProjectId),
          getPlatformRevisions(session.token, platformProjectId),
        ]);
        setBindings(bindingResponse.bindings);
        setRevisions(revisionResponse.revisions);
      } else {
        setBindings([]);
        setRevisions([]);
      }
    } catch {
      message.error("无法读取平台节点，请检查登录状态和服务地址");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, session, workspaceId]);

  useEffect(() => {
    void loadNodes();
  }, [loadNodes]);

  const agentColumns: TableColumnsType<PlatformAgent> = [
    {
      title: "节点",
      dataIndex: "name",
      render: (name: string, agent) => (
        <Space size={10}>
          <Avatar shape="square" size={30} style={{ background: "#e4f1ee", color: "#147a73" }} icon={<CloudServerOutlined />} />
          <span>
            <strong>{name}</strong>
            <small className="table-secondary">{agent.os}</small>
          </span>
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (status: PlatformAgent["status"]) => (
        <Tag color={status === "online" ? "green" : status === "disabled" ? "default" : "orange"}>
          {status === "online" ? "在线" : status === "disabled" ? "已禁用" : "离线"}
        </Tag>
      ),
    },
    { title: "Chromium", dataIndex: "browserVersion", width: 160 },
    { title: "容量", dataIndex: "maxConcurrency", width: 90, render: (value: number) => `${value} 并发` },
    { title: "当前任务", dataIndex: "currentTask", render: (value: string | null) => value ?? "空闲" },
    { title: "最后心跳", dataIndex: "lastSeenAt", width: 180, render: (value: string | null) => value ? new Date(value).toLocaleString() : "尚未连接" },
  ];

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
      await loadNodes();
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
      const result = await createPlatformRun(session.token, platformProjectId, { revisionId: revision.id, environmentId });
      result.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
      message.success(`已创建 ${result.runIds.length} 个 Agent 运行`);
      if (result.runIds[0]) navigate(`/project/${project.id}/runs/${result.runIds[0]}`);
    } catch {
      message.error("创建 Agent 运行失败，请确认环境已绑定在线节点");
    }
  };

  const importCurrentWorkspace = async () => {
    if (!session || !workspaceId) return;
    try {
      const state = useWorkspaceStore.getState();
      const result = await importLocalWorkspace(session.token, workspaceId, "browser-local-storage-v1", {
        projects: state.projects,
        flowsByProject: state.flowsByProject,
        elementsByProject: state.elementsByProject,
        variablesByProject: state.variablesByProject,
        environmentsByProject: state.environmentsByProject,
        activeEnvironmentByProject: state.activeEnvironmentByProject,
        membersByProject: state.membersByProject,
      });
      const nextMap = { ...projectMap, ...Object.fromEntries(result.projects.map((item) => [item.sourceProjectId, item.projectId])) };
      storePlatformProjectMap(nextMap, workspaceId);
      setProjectMap(nextMap);
      notifyPlatformContextChanged();
      message.success(result.imported ? "本地项目已导入 Platform，请显式发布流程版本" : "本地项目已同步到 Platform，请显式发布流程版本");
    } catch {
      message.error("导入失败，请稍后重试");
    }
  };

  if (!session) {
    return (
      <>
        <PageHeading title="执行节点" description="使用平台账户管理内网 Chromium Agent。" />
        <section className="surface settings-section platform-login-panel">
          <div>
            <h2>登录平台</h2>
            <p>登录后可生成一次性注册令牌，并查看节点的连接状态。</p>
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

  return (
    <>
      <PageHeading title="执行节点" description="节点通过主动出站连接领取已发布流程的短时租约。" />
      {!platformProjectId && (
        <Alert
          className="platform-import-alert"
          type="info"
          showIcon
          title="当前项目尚未导入平台"
          action={<Button size="small" onClick={() => void importCurrentWorkspace()}>导入本地项目</Button>}
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
          <Tooltip title="刷新节点状态"><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadNodes()} /></Tooltip>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={async () => {
              try {
                const result = await createAgentRegistrationToken(session.token, workspaceId);
                setRegistrationToken(`${result.registrationToken}\n有效至 ${new Date(result.expiresAt).toLocaleString()}`);
              } catch {
                message.error("无法生成注册令牌");
              }
            }}
          >
            生成注册令牌
          </Button>
        </Space>
      </div>
      <section className="surface project-table">
        <Table rowKey="id" columns={agentColumns} dataSource={agents} loading={loading} pagination={false} locale={{ emptyText: <Empty description="暂无已注册的执行节点" /> }} />
      </section>
      <section className="surface settings-section agent-binding-section">
        <div>
          <h2>项目环境绑定</h2>
          <p>只会向当前项目、当前环境已绑定且在线的节点派发运行。</p>
        </div>
        <Table
          rowKey={(item) => `${item.environmentId}-${item.agent.id}`}
          size="small"
          pagination={false}
          dataSource={bindings}
          columns={[
            { title: "环境", dataIndex: "environmentId", render: (id: string) => environments.find((environment) => environment.id === id)?.name ?? id },
            { title: "节点", dataIndex: ["agent", "name"] },
            { title: "状态", dataIndex: ["agent", "status"], render: (status: string) => <Tag color={status === "online" ? "green" : "default"}>{status === "online" ? "在线" : status}</Tag> },
          ]}
          locale={{ emptyText: "尚未绑定节点" }}
        />
        <Button disabled={!platformProjectId || agents.length === 0 || environments.length === 0} icon={<PlusOutlined />} onClick={() => setBindingOpen(true)}>绑定节点</Button>
      </section>
      <section className="surface settings-section agent-binding-section">
        <div>
          <h2>流程版本</h2>
          <p>发布会固定当前流程、元素、环境和密钥引用；仅已发布版本可由 Agent 执行、调试或触发持续回归。</p>
        </div>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={revisions}
          columns={[
            { title: "版本", dataIndex: "revisionNumber", width: 90, render: (value: number) => `v${value}` },
            { title: "状态", dataIndex: "status", width: 110, render: (status: PlatformRevision["status"]) => <Tag color={status === "published" ? "green" : "default"}>{status === "published" ? "已发布" : status}</Tag> },
            { title: "创建时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
            { title: "", width: 72, render: (_, revision: PlatformRevision) => <Tooltip title="使用当前环境执行"><Button size="small" icon={<PlayCircleFilled />} disabled={revision.status !== "published" || !activeEnvironment} onClick={() => void runPublishedRevision(revision)} /></Tooltip> },
          ]}
          locale={{ emptyText: "发布当前流程后将显示可执行版本" }}
        />
        <Button type="primary" disabled={!platformProjectId || flows.length === 0 || environments.length === 0} icon={<UploadOutlined />} onClick={() => { releaseForm.setFieldsValue({ flowId: flows[0]?.id, environmentId: activeEnvironment?.id ?? environments[0]?.id }); setReleaseOpen(true); }}>发布流程版本</Button>
      </section>
      <Modal title="一次性注册令牌" open={Boolean(registrationToken)} footer={<Button onClick={() => setRegistrationToken(undefined)}>关闭</Button>} onCancel={() => setRegistrationToken(undefined)}>
        <Input.TextArea value={registrationToken} autoSize readOnly onFocus={(event) => event.currentTarget.select()} />
      </Modal>
      <Modal
        title="绑定执行节点"
        open={bindingOpen}
        onCancel={() => setBindingOpen(false)}
        okText="保存绑定"
        onOk={() => bindingForm.validateFields().then(async (values) => {
          if (!platformProjectId) return;
          try {
            await bindAgent(session.token, platformProjectId, values.environmentId, values.agentId);
            bindingForm.resetFields();
            setBindingOpen(false);
            await loadNodes();
            message.success("节点已绑定到环境");
          } catch {
            message.error("节点绑定失败");
          }
        })}
      >
        <Form form={bindingForm} layout="vertical">
          <Form.Item name="environmentId" label="环境" rules={[{ required: true, message: "请选择环境" }]}>
            <Select options={environments.map((environment) => ({ value: environment.id, label: environment.name }))} />
          </Form.Item>
          <Form.Item name="agentId" label="执行节点" rules={[{ required: true, message: "请选择执行节点" }]}>
            <Select options={agents.filter((agent) => agent.status === "online").map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.browserVersion})` }))} />
          </Form.Item>
        </Form>
      </Modal>
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

function TemplatesPage() {
  return (
    <div className="workspace-layout">
      <WorkspaceSide />
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">工作空间</span>
            <h1>公共模板</h1>
            <p>跨项目可复用的标准流程资产。</p>
          </div>
        </header>
        <section className="template-grid">
          <Empty description="暂无已发布的公共模板" />
        </section>
      </main>
    </div>
  );
}

export default App;
