import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ElementAsset, Environment, Flow, Variable } from "./mock-data";
import {
  PlatformApiError,
  archivePlatformResource,
  createPlatformResource,
  getPlatformResources,
  getPlatformSettings,
  getWorkspaceProjects,
  updatePlatformProject,
  updatePlatformResource,
  updatePlatformSettings,
} from "./platform-api";
import type { PlatformProject, PlatformResource, PlatformResourceType, PlatformSession } from "./platform-api";
import { readStoredPlatformSession, readStoredPlatformWorkspaceId } from "./platform-context";
import { useWorkspaceStore } from "./workspace-store";
import { message } from "./antd-feedback";

type ResourceData = Flow | ElementAsset | Variable | Environment;
type LoadedProject = {
  project: PlatformProject;
  resources: Record<PlatformResourceType, Array<PlatformResource<ResourceData>>>;
  settings: { data: Record<string, unknown>; version: number };
};

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

function conflictDraft(projectId: string): ConflictDraft | undefined {
  const state = useWorkspaceStore.getState();
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return undefined;
  return {
    savedAt: new Date().toISOString(),
    project: { name: project.name, description: project.description },
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
  const versions = useRef(new Map<string, { version: number; serialized: string }>());
  const settingVersions = useRef(new Map<string, { version: number; activeEnvironmentId: string }>());
  const projectMetadata = useRef(new Map<string, string>());
  const hydrated = useRef(false);
  const timers = useRef(new Map<string, number>());
  const retryDrafts = useRef(new Map<string, ConflictDraft>());
  const resolvingConflicts = useRef(new Set<string>());
  const query = useQuery({
    queryKey: ["server-workspace", workspaceId],
    queryFn: () => loadWorkspace(session!, workspaceId),
    enabled: Boolean(session && workspaceId),
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!query.data) return;
    hydrated.current = false;
    versions.current.clear();
    settingVersions.current.clear();
    projectMetadata.current.clear();
    for (const item of query.data) {
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
    useWorkspaceStore.getState().replaceServerWorkspace(query.data.map((item) => ({
      platformProjectId: item.project.id,
      sourceProjectId: item.project.id,
      name: item.project.name,
      description: item.project.description,
      document: {
        flows: item.resources.flows.map((resource) => resource.data),
        elements: item.resources.elements.map((resource) => resource.data),
        variables: item.resources.variables.map((resource) => resource.data),
        environments: item.resources.environments.map((resource) => resource.data),
        activeEnvironmentId: item.settings.data.activeEnvironmentId,
      },
    })));
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
        store.setPlatformSyncStatus(projectId, "retrying");
        store.setPlatformSyncError(projectId);
        sessionStorage.removeItem(`autoflow-conflict-${projectId}`);
        retryDrafts.current.delete(projectId);
        resolvingConflicts.current.delete(projectId);
      }
      for (const projectId of resolvingConflicts.current) {
        useWorkspaceStore.getState().setPlatformSyncError(projectId);
        useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "synced");
        sessionStorage.removeItem(`autoflow-conflict-${projectId}`);
        resolvingConflicts.current.delete(projectId);
      }
    });
  }, [query.data]);

  useEffect(() => {
    if (!session || !workspaceId) return;
    const scheduledTimers = timers.current;
    const failSync = (projectId: string, error: unknown) => {
      const code = error instanceof PlatformApiError ? error.code : "RESOURCE_SYNC_FAILED";
      useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "failed");
      useWorkspaceStore.getState().setPlatformSyncError(projectId, code);
      if (code === "RESOURCE_VERSION_CONFLICT") {
        const draft = conflictDraft(projectId);
        if (draft) sessionStorage.setItem(`autoflow-conflict-${projectId}`, JSON.stringify(draft));
        message.error("资源已被其他用户修改；本地修改已保留，可刷新远端后重新提交");
      } else {
        message.error("项目修改保存失败，系统将保留当前草稿");
      }
    };

    const syncResources = async (projectId: string, type: PlatformResourceType) => {
      const current = resourcesFromState(useWorkspaceStore.getState(), projectId, type);
      const currentIds = new Set(current.map((resource) => resource.id));
      useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "syncing");
      try {
        for (const resource of current) {
          const key = `${projectId}:${type}:${resource.id}`;
          const known = versions.current.get(key);
          const serialized = stableResource(resource);
          if (!known) {
            const created = await createPlatformResource(session.token, projectId, type, resource as ResourceData & Record<string, unknown>);
            versions.current.set(key, { version: created.resource.version, serialized: stableResource(created.resource.data) });
          } else if (known.serialized !== serialized) {
            const updated = await updatePlatformResource(session.token, projectId, type, resource.id, resource as ResourceData & Record<string, unknown>, known.version);
            versions.current.set(key, { version: updated.resource.version, serialized: stableResource(updated.resource.data) });
          }
        }
        for (const [key, known] of [...versions.current]) {
          const [knownProject, knownType, ...idParts] = key.split(":");
          const id = idParts.join(":");
          if (knownProject !== projectId || knownType !== type || currentIds.has(id)) continue;
          await archivePlatformResource(session.token, projectId, type, id, known.version);
          versions.current.delete(key);
        }
        useWorkspaceStore.getState().setPlatformSyncStatus(projectId, "synced");
        useWorkspaceStore.getState().setPlatformSyncError(projectId);
      } catch (error) {
        failSync(projectId, error);
      }
    };

    const syncSettings = async (projectId: string) => {
      const known = settingVersions.current.get(projectId);
      if (!known) return;
      const activeEnvironmentId = useWorkspaceStore.getState().activeEnvironmentByProject[projectId] ?? "";
      if (known.activeEnvironmentId === activeEnvironmentId) return;
      try {
        const updated = await updatePlatformSettings(session.token, projectId, { activeEnvironmentId }, known.version);
        settingVersions.current.set(projectId, { version: updated.settings.version, activeEnvironmentId });
      } catch (error) {
        failSync(projectId, error);
      }
    };

    const schedule = (key: string, action: () => Promise<void>) => {
      const previous = scheduledTimers.get(key);
      if (previous !== undefined) window.clearTimeout(previous);
      scheduledTimers.set(key, window.setTimeout(() => {
        scheduledTimers.delete(key);
        void action();
      }, 450));
    };

    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      if (!hydrated.current) return;
      for (const project of state.projects) {
        if (!projectMetadata.current.has(project.id)) continue;
        for (const type of resourceTypes) {
          if (resourcesFromState(state, project.id, type) !== resourcesFromState(previous, project.id, type)) {
            schedule(`${project.id}:${type}`, () => syncResources(project.id, type));
          }
        }
        if (state.activeEnvironmentByProject[project.id] !== previous.activeEnvironmentByProject[project.id]) {
          schedule(`${project.id}:settings`, () => syncSettings(project.id));
        }
        const metadata = JSON.stringify({ name: project.name, description: project.description });
        if (metadata !== projectMetadata.current.get(project.id)) {
          schedule(`${project.id}:metadata`, async () => {
            try {
              await updatePlatformProject(session.token, project.id, { name: project.name, description: project.description });
              projectMetadata.current.set(project.id, metadata);
            } catch (error) {
              failSync(project.id, error);
            }
          });
        }
      }
    });
    return () => {
      unsubscribe();
      for (const timer of scheduledTimers.values()) window.clearTimeout(timer);
      scheduledTimers.clear();
    };
  }, [session, workspaceId]);

  useEffect(() => {
    const handleConflictAction = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; action?: "refresh" | "resubmit" }>).detail;
      if (!detail?.projectId || !detail.action) return;
      if (detail.action === "resubmit") {
        try {
          const draft = JSON.parse(sessionStorage.getItem(`autoflow-conflict-${detail.projectId}`) ?? "") as ConflictDraft;
          if (draft?.project) retryDrafts.current.set(detail.projectId, draft);
        } catch { return; }
      }
      resolvingConflicts.current.add(detail.projectId);
      void query.refetch();
    };
    window.addEventListener(platformConflictActionEvent, handleConflictAction);
    return () => window.removeEventListener(platformConflictActionEvent, handleConflictAction);
  }, [query]);

  useEffect(() => {
    if (query.error) message.error("无法读取工作空间数据，请检查服务连接");
  }, [query.error]);

  return null;
}
