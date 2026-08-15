import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { ElementAsset, Environment, Flow, FlowStep, Variable } from "./mock-data";
import {
  PlatformApiError,
  archivePlatformResource,
  createPlatformResource,
  createPlatformRevision,
  getPlatformResources,
  getPlatformSettings,
  getWorkspaceProjects,
  updatePlatformProject,
  updatePlatformResource,
  updatePlatformSettings,
} from "./platform-api";
import type { PlatformProject, PlatformResource, PlatformResourceType, PlatformSession } from "./platform-api";
import type { PlatformWorkspaceProject } from "./workspace-store";
import { readStoredPlatformSession, readStoredPlatformWorkspaceId, storePlatformProjectMap } from "./platform-context";
import { revisionElements, revisionEnvironment, revisionFlow } from "./revision-snapshot";
import { useWorkspaceStore } from "./workspace-store";
import {
  allSyncDraftPending,
  applyProjectDraft,
  buildProjectDraft,
  readProjectDraft,
  readSyncOutbox,
  removeProjectDraft,
  updateProjectDraft,
  upsertProjectDraft,
} from "./sync-outbox";
import type { SyncDraftPending } from "./sync-outbox";
import { message } from "./antd-feedback";

type ResourceData = Flow | ElementAsset | Variable | Environment;
type LoadedProject = {
  project: PlatformProject;
  resources: Record<PlatformResourceType, Array<PlatformResource<ResourceData>>>;
  settings: { data: Record<string, unknown>; version: number };
};

// 快照构建辅助：与 src/pages/shared.tsx 中的实现保持一致。
// 内联在此处，避免同步器反向引用懒加载页面模块造成循环依赖。
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

function snapshotVariables(variables: Variable[]) {
  return Object.fromEntries(
    variables
      .filter((variable) => !variable.secret && (variable.scope === "项目" || variable.scope === "环境"))
      .map((variable) => [variableReference(variable), variable.value]),
  );
}

const resourceTypes: PlatformResourceType[] = ["flows", "elements", "variables", "environments"];
export const platformConflictActionEvent = "autoflow-platform-conflict-action";

type ConflictDraft = {
  savedAt: string;
  project: { name: string; description: string };
  flows: Flow[];
  elements: ElementAsset[];
  variables: Variable[];
  environments: Environment[];
  activeEnvironmentId: string;
};

function conflictDraft(projectId: string): ConflictDraft {
  const state = useWorkspaceStore.getState();
  const project = state.projects.find((item) => item.id === projectId);
  return {
    savedAt: new Date().toISOString(),
    project: { name: project?.name ?? projectId, description: project?.description ?? "" },
    flows: state.flowsByProject[projectId] ?? [],
    elements: state.elementsByProject[projectId] ?? [],
    variables: state.variablesByProject[projectId] ?? [],
    environments: state.environmentsByProject[projectId] ?? [],
    activeEnvironmentId: state.activeEnvironmentByProject[projectId] ?? "",
  };
}

function resourcesFromState(state: ReturnType<typeof useWorkspaceStore.getState>, projectId: string, type: PlatformResourceType) {
  if (type === "flows") return state.flowsByProject[projectId] ?? [];
  if (type === "elements") return state.elementsByProject[projectId] ?? [];
  if (type === "variables") return state.variablesByProject[projectId] ?? [];
  return state.environmentsByProject[projectId] ?? [];
}

function stableResource(value: ResourceData) {
  return JSON.stringify(value);
}

function serverDocumentSerialized(item: LoadedProject): string {
  return JSON.stringify({
    name: item.project.name,
    description: item.project.description,
    flows: item.resources.flows.map((resource) => resource.data),
    elements: item.resources.elements.map((resource) => resource.data),
    variables: item.resources.variables.map((resource) => resource.data),
    environments: item.resources.environments.map((resource) => resource.data),
    activeEnvironmentId: typeof item.settings.data.activeEnvironmentId === "string" ? item.settings.data.activeEnvironmentId : "",
  });
}

function localDocumentSerialized(projectId: string): string {
  const state = useWorkspaceStore.getState();
  const project = state.projects.find((candidate) => candidate.id === projectId);
  return JSON.stringify({
    name: project?.name ?? "",
    description: project?.description ?? "",
    flows: state.flowsByProject[projectId] ?? [],
    elements: state.elementsByProject[projectId] ?? [],
    variables: state.variablesByProject[projectId] ?? [],
    environments: state.environmentsByProject[projectId] ?? [],
    activeEnvironmentId: state.activeEnvironmentByProject[projectId] ?? "",
  });
}

function replaceProject(projectId: string, name: string, description: string, document: Record<string, unknown>): PlatformWorkspaceProject {
  return { platformProjectId: projectId, sourceProjectId: projectId, name, description, document };
}

async function loadWorkspace(session: PlatformSession, workspaceId: string) {
  const projects = await getWorkspaceProjects(session.token, workspaceId);
  return Promise.all(projects.projects.map(async (project): Promise<LoadedProject> => {
    const [flows, elements, variables, environments, settings] = await Promise.all([
      getPlatformResources<Flow>(session.token, project.id, "flows"),
      getPlatformResources<ElementAsset>(session.token, project.id, "elements"),
      getPlatformResources<Variable>(session.token, project.id, "variables"),
      getPlatformResources<Environment>(session.token, project.id, "environments"),
      getPlatformSettings(session.token, project.id),
    ]);
    return {
      project,
      resources: { flows: flows.resources, elements: elements.resources, variables: variables.resources, environments: environments.resources } as LoadedProject["resources"],
      settings: settings.settings,
    };
  }));
}

export function ServerWorkspaceSynchronizer() {
  const session = readStoredPlatformSession();
  const workspaceId = readStoredPlatformWorkspaceId(session);
  const apiToken = session?.token ?? "";
  const versions = useRef(new Map<string, { version: number; serialized: string }>());
  const lastApplied = useRef(new Map<string, string>());
  const settingVersions = useRef(new Map<string, { version: number; activeEnvironmentId: string }>());
  const projectMetadata = useRef(new Map<string, string>());
  const hydrated = useRef(false);
  const timers = useRef(new Map<string, number>());
  const retryDrafts = useRef(new Map<string, ConflictDraft>());
  const resolvingConflicts = useRef(new Set<string>());
  const forceServerWins = useRef(new Set<string>());
  const inFlightProjects = useRef(new Set<string>());
  const pendingProjects = useRef(new Set<string>());
  const retryAttempts = useRef(new Map<string, number>());
  const retryNotified = useRef(new Set<string>());
  const query = useQuery({
    queryKey: ["server-workspace", workspaceId],
    queryFn: () => loadWorkspace(session!, workspaceId),
    enabled: Boolean(session && workspaceId),
    staleTime: 15_000,
  });

  const syncApi = useMemo(() => {
    function schedule(key: string, action: () => void | Promise<void>, delay = 450) {
    const previous = timers.current.get(key);
    if (previous !== undefined) window.clearTimeout(previous);
    timers.current.set(key, window.setTimeout(() => {
      timers.current.delete(key);
      void action();
    }, delay));
    }

    function markConflict(projectId: string, error: unknown) {
    upsertProjectDraft(buildProjectDraft(workspaceId, projectId, allSyncDraftPending, true));
    sessionStorage.setItem(`autoflow-conflict-${projectId}`, JSON.stringify(conflictDraft(projectId)));
    const code = error instanceof PlatformApiError ? error.code : "RESOURCE_VERSION_CONFLICT";
    useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "conflict");
    useWorkspaceStore.getState().setPlatformSyncError(projectId, code);
    message.error("资源已被其他用户修改；本地修改已保留，可刷新远端后重新提交");
    }

    function markRetry(projectId: string, error: unknown) {
    const code = error instanceof PlatformApiError ? error.code : "RESOURCE_SYNC_FAILED";
    useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "retrying");
    useWorkspaceStore.getState().setPlatformSyncError(projectId, code);
    const attempts = retryAttempts.current.get(projectId) ?? 0;
    retryAttempts.current.set(projectId, attempts + 1);
    schedule(`project:${projectId}`, () => syncProject(projectId), Math.min(30_000, 1_000 * 2 ** attempts));
    if (!retryNotified.current.has(projectId)) {
      retryNotified.current.add(projectId);
      message.warning("网络异常，项目修改已保留并进入自动重试");
    }
    }

    function markFailed(projectId: string, error: unknown) {
    const code = error instanceof PlatformApiError ? error.code : "RESOURCE_SYNC_FAILED";
    useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "failed");
    useWorkspaceStore.getState().setPlatformSyncError(projectId, code);
    message.error("项目修改保存失败，系统将保留当前草稿");
    }

    function isTransientError(error: unknown) {
    if (error instanceof PlatformApiError) {
      return error.status === 0 || error.status === 429 || error.status >= 500;
    }
    return true;
    }

    async function handleSyncFailure(
    projectId: string,
    error: unknown,
    resolveConflict?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (error instanceof PlatformApiError && error.code === "RESOURCE_VERSION_CONFLICT") {
      if (resolveConflict && await resolveConflict()) return true;
      markConflict(projectId, error);
      return false;
    }
    if (isTransientError(error)) {
      markRetry(projectId, error);
      return false;
    }
    markFailed(projectId, error);
    return false;
    }

    async function syncResources(projectId: string, type: PlatformResourceType): Promise<boolean> {
    const current = resourcesFromState(useWorkspaceStore.getState(), projectId, type);
    const currentIds = new Set(current.map((resource) => resource.id));
    useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "syncing");
    for (const resource of current) {
      const key = `${projectId}:${type}:${resource.id}`;
      const known = versions.current.get(key);
      const serialized = stableResource(resource);
      if (!known) {
        try {
          const created = await createPlatformResource(apiToken, projectId, type, resource as ResourceData & Record<string, unknown>);
          versions.current.set(key, { version: created.resource.version, serialized: stableResource(created.resource.data) });
        } catch (error) {
          if (error instanceof PlatformApiError && error.code === "RESOURCE_ALREADY_EXISTS") {
            try {
              const resources = await getPlatformResources<ResourceData>(apiToken, projectId, type);
              const remote = resources.resources.find((item) => item.id === resource.id);
              if (remote) {
                const remoteSerialized = stableResource(remote.data);
                versions.current.set(key, { version: remote.version, serialized: remoteSerialized });
                if (remoteSerialized !== serialized) {
                  try {
                    const updated = await updatePlatformResource(apiToken, projectId, type, resource.id, resource as ResourceData & Record<string, unknown>, remote.version);
                    versions.current.set(key, { version: updated.resource.version, serialized: stableResource(updated.resource.data) });
                  } catch (updateError) {
                    return handleSyncFailure(projectId, updateError);
                  }
                }
                continue;
              }
            } catch {
              // 继续走通用失败处理。
            }
          }
          return handleSyncFailure(projectId, error);
        }
      } else if (known.serialized !== serialized) {
        try {
          const updated = await updatePlatformResource(apiToken, projectId, type, resource.id, resource as ResourceData & Record<string, unknown>, known.version);
          versions.current.set(key, { version: updated.resource.version, serialized: stableResource(updated.resource.data) });
        } catch (error) {
          return handleSyncFailure(projectId, error, async () => {
            const resources = await getPlatformResources<ResourceData>(apiToken, projectId, type);
            const remote = resources.resources.find((item) => item.id === resource.id);
            if (!remote) return false;
            const remoteMatches = stableResource(remote.data) === serialized;
            if (!remoteMatches) return false;
            versions.current.set(key, { version: remote.version, serialized: stableResource(remote.data) });
            return true;
          });
        }
      }
    }
    for (const [key, known] of [...versions.current]) {
      const [knownProject, knownType, ...idParts] = key.split(":");
      const id = idParts.join(":");
      if (knownProject !== projectId || knownType !== type || currentIds.has(id)) continue;
      try {
        await archivePlatformResource(apiToken, projectId, type, id, known.version);
        versions.current.delete(key);
      } catch (error) {
        return handleSyncFailure(projectId, error);
      }
    }
    return true;
    }

    async function syncSettings(projectId: string): Promise<boolean> {
    const known = settingVersions.current.get(projectId);
    if (!known) return true;
    const activeEnvironmentId = useWorkspaceStore.getState().activeEnvironmentByProject[projectId] ?? "";
    if (known.activeEnvironmentId === activeEnvironmentId) return true;
    try {
      const updated = await updatePlatformSettings(apiToken, projectId, { activeEnvironmentId }, known.version);
      settingVersions.current.set(projectId, { version: updated.settings.version, activeEnvironmentId });
      return true;
    } catch (error) {
      return handleSyncFailure(projectId, error);
    }
    }

    async function syncMetadata(projectId: string): Promise<boolean> {
    const state = useWorkspaceStore.getState();
    const project = state.projects.find((item) => item.id === projectId);
    const metadata = project ? { name: project.name, description: project.description } : undefined;
    if (!metadata) return true;
    const serialized = JSON.stringify(metadata);
    if (serialized === projectMetadata.current.get(projectId)) return true;
    try {
      await updatePlatformProject(apiToken, projectId, metadata);
      projectMetadata.current.set(projectId, serialized);
      return true;
    } catch (error) {
      return handleSyncFailure(projectId, error);
    }
    }

    function removePending(projectId: string, pending: SyncDraftPending) {
    const draft = readProjectDraft(workspaceId, projectId);
    if (draft) {
      updateProjectDraft(workspaceId, projectId, {
        pending: draft.pending.filter((item) => item !== pending),
      });
    }
    }

    async function syncProject(projectId: string) {
    if (inFlightProjects.current.has(projectId)) {
      pendingProjects.current.add(projectId);
      return;
    }
    const draft = readProjectDraft(workspaceId, projectId);
    if (!draft || draft.conflict) return;
    inFlightProjects.current.add(projectId);
    try {
      for (const pending of [...draft.pending]) {
        let ok = true;
        if (pending === "settings") ok = await syncSettings(projectId);
        else if (pending === "metadata") ok = await syncMetadata(projectId);
        else ok = await syncResources(projectId, pending);
        if (!ok) return;
        removePending(projectId, pending);
      }
      const remaining = readProjectDraft(workspaceId, projectId);
      if (!remaining || remaining.pending.length > 0) return;
      removeProjectDraft(workspaceId, projectId);
      useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "synced");
      useWorkspaceStore.getState().setPlatformSyncError(projectId);
      retryAttempts.current.delete(projectId);
      retryNotified.current.delete(projectId);
      schedule(`${projectId}:snapshot`, () => syncSnapshot(projectId));
    } finally {
      inFlightProjects.current.delete(projectId);
      if (pendingProjects.current.delete(projectId)) {
        syncApi.schedule(`project:${projectId}`, () => syncProject(projectId));
      }
    }
    }

  // 保存即快照：资源同步完成后，为每个有步骤的流程自动创建 published 版本。
  // 服务端按 checksum 幂等去重（无变化不产生新版本），失败静默由下次保存重试。
    async function syncSnapshot(projectId: string) {
    const state = useWorkspaceStore.getState();
    const flows = state.flowsByProject[projectId] ?? [];
    const variables = state.variablesByProject[projectId] ?? [];
    const elements = state.elementsByProject[projectId] ?? [];
    const environments = state.environmentsByProject[projectId] ?? [];
    const environment = environments.find((item) => item.id === state.activeEnvironmentByProject[projectId]) ?? environments[0];
    if (!environment) return;
    for (const flow of flows) {
      if (!flow.definition?.length) continue;
      try {
        await createPlatformRevision(apiToken, projectId, {
          flow: revisionFlow(flow, snapshotVariables(variables)),
          environment: revisionEnvironment(environment),
          elements: revisionElements(
            elements.filter((item) => !item.environment || item.environment === environment.id),
          ),
          secretNames: requiredSecretVariables(variables, flow.definition).map(variableReference),
        });
      } catch {
        // 快照失败不阻断保存，下次同步成功后自动重试。
      }
    }
    }

    function queueProject(projectId: string) {
    const previous = readProjectDraft(workspaceId, projectId);
    upsertProjectDraft(buildProjectDraft(workspaceId, projectId, allSyncDraftPending, Boolean(previous?.conflict)));
    useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "queued");
    schedule(`project:${projectId}`, () => syncProject(projectId));
    }

    function schedulePendingDrafts() {
    for (const draft of readSyncOutbox()) {
      if (draft.workspaceId !== workspaceId) continue;
      if (draft.conflict) {
        sessionStorage.setItem(`autoflow-conflict-${draft.projectId}`, JSON.stringify(conflictDraft(draft.projectId)));
        useWorkspaceStore.getState().setPlatformSyncStatus(draft.projectId, "conflict");
        useWorkspaceStore.getState().setPlatformSyncError(draft.projectId, "RESOURCE_VERSION_CONFLICT");
        continue;
      }
      useWorkspaceStore.getState().setPlatformSyncStatus(draft.projectId, "queued");
      schedule(`project:${draft.projectId}`, () => syncProject(draft.projectId));
    }
    }

    return { schedule, syncProject, queueProject, schedulePendingDrafts };
  }, [apiToken, workspaceId]);

  useEffect(() => {
    if (!session || !workspaceId) return;
    for (const draft of readSyncOutbox()) {
      if (draft.workspaceId !== workspaceId) continue;
      applyProjectDraft(draft);
      if (draft.conflict) {
        sessionStorage.setItem(`autoflow-conflict-${draft.projectId}`, JSON.stringify(conflictDraft(draft.projectId)));
        useWorkspaceStore.getState().setPlatformSyncStatus(draft.projectId, "conflict");
        useWorkspaceStore.getState().setPlatformSyncError(draft.projectId, "RESOURCE_VERSION_CONFLICT");
      }
    }
  }, [session, workspaceId]);

  useEffect(() => {
    if (!query.data) return;
    hydrated.current = false;
    versions.current.clear();
    settingVersions.current.clear();
    projectMetadata.current.clear();
    for (const item of query.data) {
      const draft = readProjectDraft(workspaceId, item.project.id);
      if (draft) applyProjectDraft(draft);
      projectMetadata.current.set(item.project.id, JSON.stringify({ name: item.project.name, description: item.project.description }));
      settingVersions.current.set(item.project.id, {
        version: item.settings.version,
        activeEnvironmentId: typeof item.settings.data.activeEnvironmentId === "string" ? item.settings.data.activeEnvironmentId : "",
      });
      for (const type of resourceTypes) {
        for (const resource of item.resources[type]) {
          versions.current.set(`${item.project.id}:${type}:${resource.id}`, { version: resource.version, serialized: stableResource(resource.data) });
        }
      }
    }
    const replaceItems: PlatformWorkspaceProject[] = [];
    const keepLocalProjectIds: string[] = [];
    for (const item of query.data) {
      const projectId = item.project.id;
      const serverSerialized = serverDocumentSerialized(item);
      const localSerialized = localDocumentSerialized(projectId);
      const baseline = lastApplied.current.get(projectId);
      const forcedServerWins = forceServerWins.current.delete(projectId);
      const serverWins = forcedServerWins || baseline === undefined || localSerialized === serverSerialized || localSerialized === baseline;
      if (serverWins) {
        replaceItems.push(replaceProject(projectId, item.project.name, item.project.description, {
          flows: item.resources.flows.map((resource) => resource.data),
          elements: item.resources.elements.map((resource) => resource.data),
          variables: item.resources.variables.map((resource) => resource.data),
          environments: item.resources.environments.map((resource) => resource.data),
          activeEnvironmentId: item.settings.data.activeEnvironmentId,
        }));
        lastApplied.current.set(projectId, serverSerialized);
      } else {
        const state = useWorkspaceStore.getState();
        const project = state.projects.find((candidate) => candidate.id === projectId);
        replaceItems.push(replaceProject(projectId, project?.name ?? item.project.name, project?.description ?? item.project.description, {
          flows: state.flowsByProject[projectId] ?? [],
          elements: state.elementsByProject[projectId] ?? [],
          variables: state.variablesByProject[projectId] ?? [],
          environments: state.environmentsByProject[projectId] ?? [],
          activeEnvironmentId: state.activeEnvironmentByProject[projectId] ?? "",
        }));
        keepLocalProjectIds.push(projectId);
      }
    }
    useWorkspaceStore.getState().replaceServerWorkspace(replaceItems);
    if (workspaceId) {
      storePlatformProjectMap(
        Object.fromEntries(query.data.map((item) => [item.project.id, item.project.id])),
        workspaceId,
      );
    }
    queueMicrotask(() => {
      for (const projectId of keepLocalProjectIds) {
        useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "queued");
      }
    });
    queueMicrotask(() => {
      hydrated.current = true;
      for (const [projectId, draft] of retryDrafts.current) {
        const store = useWorkspaceStore.getState();
        store.updateProject(projectId, draft.project);
        store.setFlows(projectId, draft.flows);
        store.setElements(projectId, draft.elements);
        store.setVariables(projectId, draft.variables);
        store.setEnvironments(projectId, draft.environments);
        store.setActiveEnvironment(projectId, draft.activeEnvironmentId);
        upsertProjectDraft(buildProjectDraft(workspaceId, projectId, allSyncDraftPending));
        store.setPlatformSyncStatus(projectId, "queued");
        store.setPlatformSyncError(projectId);
        sessionStorage.removeItem(`autoflow-conflict-${projectId}`);
        retryDrafts.current.delete(projectId);
        resolvingConflicts.current.delete(projectId);
        syncApi.schedule(`project:${projectId}`, () => syncApi.syncProject(projectId));
      }
      for (const projectId of resolvingConflicts.current) {
        useWorkspaceStore.getState().setPlatformSyncError(projectId);
        useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "synced");
        sessionStorage.removeItem(`autoflow-conflict-${projectId}`);
        resolvingConflicts.current.delete(projectId);
      }
      syncApi.schedulePendingDrafts();
    });
  }, [query.data, workspaceId, syncApi]);

  useEffect(() => {
    if (!session || !workspaceId) return;
    const timersRef = timers.current;
    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      if (!hydrated.current) return;
      for (const project of state.projects) {
        if (!projectMetadata.current.has(project.id)) continue;
        let changed = false;
        for (const type of resourceTypes) {
          if (resourcesFromState(state, project.id, type) !== resourcesFromState(previous, project.id, type)) {
            changed = true;
          }
        }
        if (state.activeEnvironmentByProject[project.id] !== previous.activeEnvironmentByProject[project.id]) {
          changed = true;
        }
        const metadata = JSON.stringify({ name: project.name, description: project.description });
        if (metadata !== projectMetadata.current.get(project.id)) {
          changed = true;
        }
        if (state.projectModesById[project.id] === "local" && previous.projectModesById[project.id] === "platform-enabled") {
          removeProjectDraft(workspaceId, project.id);
        }
        if (changed) syncApi.queueProject(project.id);
      }
    });
    return () => {
      unsubscribe();
      for (const timer of timersRef.values()) window.clearTimeout(timer);
      timersRef.clear();
    };
  }, [session, workspaceId, syncApi]);

  useEffect(() => {
    const handleConflictAction = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; action?: "refresh" | "resubmit" }>).detail;
      if (!detail?.projectId || !detail.action) return;
      if (detail.action === "resubmit") {
        try {
          const draft = JSON.parse(sessionStorage.getItem(`autoflow-conflict-${detail.projectId}`) ?? "") as ConflictDraft;
          if (draft?.project) retryDrafts.current.set(detail.projectId, draft);
          updateProjectDraft(workspaceId, detail.projectId, { conflict: false });
          sessionStorage.removeItem(`autoflow-conflict-${detail.projectId}`);
        } catch { return; }
      } else {
        removeProjectDraft(workspaceId, detail.projectId);
        sessionStorage.removeItem(`autoflow-conflict-${detail.projectId}`);
        forceServerWins.current.add(detail.projectId);
      }
      resolvingConflicts.current.add(detail.projectId);
      void query.refetch();
    };
    window.addEventListener(platformConflictActionEvent, handleConflictAction);
    return () => window.removeEventListener(platformConflictActionEvent, handleConflictAction);
  }, [query, workspaceId]);

  useEffect(() => {
    if (query.error) message.error("无法读取工作空间数据，请检查服务连接");
  }, [query.error]);

  return null;
}
