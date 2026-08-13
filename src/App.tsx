import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "./router";
import { App as AntdApp, ConfigProvider, Spin, theme as antdTheme } from "antd";
import { useFlowStore } from "./flow-store";
import { useWorkspaceStore } from "./workspace-store";
import { applyTheme, themePalettes, useThemeStore } from "./theme-mode";
import type { PlatformWorkspaceProject } from "./workspace-store";
import {
  PlatformApiError,
  getPlatformProjectDocument,
  getWorkspaceProjects,
  savePlatformProjectDocument,
  updatePlatformProject,
  restorePlatformSession,
} from "./platform-api";
import {
  platformContextChangedEvent,
  readPlatformDocumentVersion,
  readPlatformProjectMap,
  readStoredPlatformSession,
  readStoredPlatformWorkspaceId,
  storePlatformDocumentVersion,
  storePlatformProjectMap,
  storePlatformSession,
} from "./platform-context";
import type { PlatformSession } from "./platform-api";
import { LoginPage } from "./LoginPage";
import { ServerWorkspaceSynchronizer } from "./ServerWorkspaceSynchronizer";
import "./App.css";
import "./responsive.css";
import { AntdFeedbackBridge, modal } from "./antd-feedback";
import {
  PageHeading,
  ProjectLayout,
  statusMeta,
  statusTag,
} from "./pages/shared";

const LazyFlowEditor = lazy(() => import("./FlowEditorPage"));
const LazyRunDetail = lazy(() => import("./RunDetailPage"));
const LazyProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })),
);
const LazyTemplatesPage = lazy(() =>
  import("./pages/TemplatesPage").then((m) => ({ default: m.TemplatesPage })),
);
const LazyProjectShell = lazy(() =>
  import("./pages/ProjectShell").then((m) => ({ default: m.ProjectShell })),
);

const routeFallback = (
  <div className="route-loading"><Spin size="large" /></div>
);
const syncMessage = { warning: (_value: unknown) => undefined, error: (_value: unknown) => undefined };

// 主题宿主：跟随系统或手动模式，同步 antd 算法与 <html data-theme>。
function ThemeHost({ children }: { children: React.ReactNode }) {
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    applyTheme(useThemeStore.getState().mode),
  );

  useEffect(() => {
    const sync = () => setResolved(applyTheme(useThemeStore.getState().mode));
    sync();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => useThemeStore.subscribe((state) => setResolved(applyTheme(state.mode))), []);

  const palette = themePalettes[resolved];
  return (
    <ConfigProvider
      theme={{
        algorithm: resolved === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: palette.colorPrimary,
          colorInfo: palette.colorInfo,
          colorSuccess: palette.colorSuccess,
          colorWarning: palette.colorWarning,
          colorError: palette.colorError,
          colorTextBase: palette.colorTextBase,
          colorBgBase: palette.colorBgBase,
          colorBgLayout: palette.colorBgLayout,
          colorBgContainer: palette.colorBgBase,
          colorBgElevated: palette.colorBgBase,
          borderRadius: 8,
          controlHeight: 36,
          fontFamily: "var(--font-sans)",
          // 0.2s：比 antd 默认 0.3s 更干脆；同时避免抽屉/弹层关闭动画与顶栏交互重叠（时序竞态）。
          motionDurationSlow: "0.2s",
        },
        components: {
          Table: {
            headerBg: palette.surface2,
            headerSplitColor: palette.separator,
            rowHoverBg: palette.surface2,
            cellPaddingBlock: 12,
          },
          Modal: { contentBg: palette.colorBgBase, headerBg: palette.colorBgBase },
          Drawer: { colorBgElevated: palette.colorBgBase },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

function App() {
  return (
    <ThemeHost>
      <AntdApp>
        <AntdFeedbackBridge />
        <ApplicationSessionGate>
          {authenticationRequired ? <ServerWorkspaceSynchronizer /> : <PlatformWorkspaceSynchronizer />}
          <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route
            path="/projects"
            element={<Suspense fallback={routeFallback}><LazyProjectsPage /></Suspense>}
          />
          <Route
            path="/templates"
            element={<Suspense fallback={routeFallback}><LazyTemplatesPage /></Suspense>}
          />
          <Route
            path="/project/:projectId/:section"
            element={<Suspense fallback={routeFallback}><LazyProjectShell /></Suspense>}
          />
          <Route
            path="/project/:projectId/flows/:flowId/edit"
            element={
              <Suspense fallback={routeFallback}>
                <LazyFlowEditor />
              </Suspense>
            }
          />
          <Route
            path="/project/:projectId/runs/:runId"
            element={
              <Suspense fallback={routeFallback}>
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
        </ApplicationSessionGate>
      </AntdApp>
    </ThemeHost>
  );
}

const authenticationRequired = import.meta.env.PROD || import.meta.env.VITE_AUTH_REQUIRED === "1";

function ApplicationSessionGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "authenticated" | "anonymous">(
    authenticationRequired ? "checking" : "authenticated",
  );

  useEffect(() => {
    if (!authenticationRequired) return;
    let active = true;
    const restore = () => {
      setState("checking");
      void restorePlatformSession()
        .then((session) => {
          if (!active) return;
          storePlatformSession(session);
          setState("authenticated");
        })
        .catch(() => {
          if (!active) return;
          storePlatformSession();
          setState("anonymous");
        });
    };
    const expire = () => {
      storePlatformSession();
      setState("anonymous");
    };
    restore();
    window.addEventListener("autoflow-auth-expired", expire);
    return () => {
      active = false;
      window.removeEventListener("autoflow-auth-expired", expire);
    };
  }, []);

  if (state === "checking") return <div className="route-loading"><Spin size="large" /></div>;
  if (state === "anonymous") return <LoginPage onAuthenticated={(session: PlatformSession) => {
    storePlatformSession(session);
    setState("authenticated");
  }} />;
  return children;
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
  // Synchronization is best-effort; failures are surfaced from the Platform workspace only.
  const message = syncMessage;
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
      const state = useWorkspaceStore.getState();
      const projectMap = readPlatformProjectMap(workspaceId);
      // Existing localStorage mappings predate project modes and remain opt-in mappings.
      for (const [localId, remoteId] of Object.entries(projectMap)) {
        if (
          state.projectModesById?.[localId] !== "platform-enabled"
          || state.platformProjectIdsById?.[localId] !== remoteId
        ) state.enablePlatformProject(localId, remoteId);
      }
      return { session, workspaceId, projectMap };
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
      if (!window.location.pathname.endsWith("/platform")) {
        scheduleDocument(localId, 5_000);
        return;
      }
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
      if (
        cancelled
        || inFlight.has(localId)
        || useWorkspaceStore.getState().projectModesById?.[localId] !== "platform-enabled"
      ) return;
      const currentContext = context();
      const remoteId = currentContext?.projectMap[localId];
      const document = workspaceDocumentFor(useWorkspaceStore.getState(), localId);
      if (!currentContext || !remoteId || !document) return;
      inFlight.add(localId);
      useWorkspaceStore.getState().setPlatformSyncStatus(localId, "syncing");
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
        useWorkspaceStore.getState().setPlatformSyncStatus(localId, "synced");
        useWorkspaceStore.getState().setPlatformSyncError(localId);
      } catch (error) {
        useWorkspaceStore.getState().setPlatformSyncStatus(localId, "failed");
        useWorkspaceStore.getState().setPlatformSyncError(
          localId,
          error instanceof Error ? error.message : "Unable to synchronize with Platform.",
        );
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
        const enabledRemoteIds = new Set(Object.values(currentContext.projectMap));
        const loaded = await Promise.all(response.projects
          .filter((project) => enabledRemoteIds.has(project.id))
          .map(async (project) => {
          const document = await getPlatformProjectDocument(currentContext.session.token, project.id);
          const existingLocalId = Object.entries(currentContext.projectMap).find(([, remoteId]) => remoteId === project.id)?.[0];
          const sourceProjectId = project.sourceProjectId ?? (typeof document.data.sourceProjectId === "string" ? document.data.sourceProjectId : existingLocalId ?? `platform-${project.id}`);
          return { project, document, sourceProjectId };
          }));
        if (cancelled) return;
        const nextMap = { ...currentContext.projectMap };
        const state = useWorkspaceStore.getState();
        for (const [localId, remoteId] of Object.entries(currentContext.projectMap)) {
          if (state.projects.some((project) => project.id === localId)) {
            state.enablePlatformProject(localId, remoteId);
          }
        }
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
        if (remoteHydration.length > 0) {
          useWorkspaceStore.getState().hydratePlatformProjects(remoteHydration);
          for (const item of remoteHydration) {
            lastDocuments.set(item.sourceProjectId, JSON.stringify(workspaceDocumentFor(useWorkspaceStore.getState(), item.sourceProjectId)));
            const project = useWorkspaceStore.getState().projects.find((candidate) => candidate.id === item.sourceProjectId);
            if (project) lastMetadata.set(item.sourceProjectId, JSON.stringify({ name: project.name, description: project.description }));
          }
        }
        hydrating = false;
      } catch (error) {
        // A platform outage must not erase local data. Mapped edits can still retry with their stored version.
        const detail = error instanceof PlatformApiError ? error.code : "PLATFORM_READ_FAILED";
        for (const localId of Object.keys(currentContext.projectMap)) {
          useWorkspaceStore.getState().setPlatformSyncStatus(localId, "failed");
          useWorkspaceStore.getState().setPlatformSyncError(localId, detail);
        }
      } finally {
        ready = true;
      }
    };

    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (!ready || hydrating) return;
      const currentContext = context();
      if (!currentContext) return;
      for (const [localId] of Object.entries(currentContext.projectMap)) {
        if (state.projectModesById?.[localId] !== "platform-enabled") continue;
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
  }, [contextRevision, message]);

  return null;
}

export default App;
