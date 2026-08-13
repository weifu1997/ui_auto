import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ElementAsset, Environment, Flow, Project, Variable } from "./mock-data";
import { createSauceDemoSeed } from "./saucedemo-seed";

type NewProjectInput = {
  name: string;
  description?: string;
};

export type PlatformWorkspaceProject = {
  platformProjectId: string;
  sourceProjectId: string;
  name: string;
  description: string;
  document: Record<string, unknown>;
};

export type ProjectMode = "local" | "platform-enabled";
export type PlatformSyncStatus = "synced" | "syncing" | "retrying" | "failed";

type WorkspaceStore = {
  projects: Project[];
  flowsByProject: Record<string, Flow[]>;
  elementsByProject: Record<string, ElementAsset[]>;
  variablesByProject: Record<string, Variable[]>;
  environmentsByProject: Record<string, Environment[]>;
  activeEnvironmentByProject: Record<string, string>;
  projectModesById: Record<string, ProjectMode>;
  platformProjectIdsById: Record<string, string>;
  platformSyncStatusById: Record<string, PlatformSyncStatus>;
  platformSyncErrorById: Record<string, string>;
  createProject: (input: NewProjectInput) => Project;
  persistWorkspace: () => void;
  archiveProject: (projectId: string) => void;
  updateProject: (projectId: string, patch: Pick<Project, "name" | "description">) => void;
  setFlows: (projectId: string, flows: Flow[]) => void;
  setElements: (projectId: string, elements: ElementAsset[]) => void;
  setVariables: (projectId: string, variables: Variable[]) => void;
  setEnvironments: (projectId: string, environments: Environment[]) => void;
  setActiveEnvironment: (projectId: string, environmentId: string) => void;
  enablePlatformProject: (projectId: string, platformProjectId: string) => void;
  disconnectPlatformProject: (projectId: string) => void;
  setPlatformSyncStatus: (projectId: string, status: PlatformSyncStatus) => void;
  setPlatformSyncError: (projectId: string, error?: string) => void;
  hydratePlatformProjects: (projects: PlatformWorkspaceProject[]) => void;
  replaceServerWorkspace: (projects: PlatformWorkspaceProject[]) => void;
  hydratePlatformProjectMetadata: (
    projects: Array<Pick<PlatformWorkspaceProject, "sourceProjectId" | "name" | "description">>,
  ) => void;
};

function withoutProject<T>(source: Record<string, T>, projectId: string) {
  const { [projectId]: _removed, ...remaining } = source;
  return remaining;
}

function removeRetiredDemoProjects(value: unknown) {
  const state = (value ?? {}) as Partial<WorkspaceStore>;
  const demoIds = new Set(["commerce", "admin", "member"]);
  const withoutDemoKeys = <T>(source: Record<string, T> | undefined) =>
    Object.fromEntries(
      Object.entries(source ?? {}).filter(([id]) => !demoIds.has(id)),
    ) as Record<string, T>;
  return {
    ...state,
    projects: (state.projects ?? [])
      .filter((project) => !demoIds.has(project.id))
      .map(({ id, name, description }) => ({ id, name, description })),
    flowsByProject: withoutDemoKeys(state.flowsByProject),
    elementsByProject: withoutDemoKeys(state.elementsByProject),
    variablesByProject: withoutDemoKeys(state.variablesByProject),
    environmentsByProject: withoutDemoKeys(state.environmentsByProject),
    activeEnvironmentByProject: withoutDemoKeys(state.activeEnvironmentByProject),
  };
}

function addSauceDemoSeed(value: unknown) {
  const state = removeRetiredDemoProjects(value);
  if ((state.projects ?? []).some((project) => project.id === "sauce-demo")) return state;
  const seed = createSauceDemoSeed();
  return {
    ...state,
    projects: [seed.project, ...(state.projects ?? [])],
    flowsByProject: { ...(state.flowsByProject ?? {}), [seed.project.id]: seed.flows },
    elementsByProject: { ...(state.elementsByProject ?? {}), [seed.project.id]: seed.elements },
    variablesByProject: { ...(state.variablesByProject ?? {}), [seed.project.id]: seed.variables },
    environmentsByProject: {
      ...(state.environmentsByProject ?? {}),
      [seed.project.id]: [seed.environment],
    },
    activeEnvironmentByProject: {
      ...(state.activeEnvironmentByProject ?? {}),
      [seed.project.id]: seed.environment.id,
    },
  };
}

function ensureProjectModes(value: unknown) {
  const state = addSauceDemoSeed(value) as Partial<WorkspaceStore>;
  const projects = state.projects ?? [];
  const platformProjectIdsById = state.platformProjectIdsById ?? legacyPlatformProjectIds();
  return {
    ...state,
    projectModesById: Object.fromEntries(projects.map((project) => [
      project.id,
      state.projectModesById?.[project.id] ?? (platformProjectIdsById[project.id] ? "platform-enabled" : "local"),
    ])),
    platformProjectIdsById,
    platformSyncErrorById: state.platformSyncErrorById ?? {},
  };
}

function legacyPlatformProjectIds() {
  try {
    const raw = JSON.parse(localStorage.getItem("autoflow-platform-project-map") ?? "{}") as Record<string, unknown>;
    const directMap = Object.values(raw).every((value) => typeof value === "string")
      ? raw
      : Object.values(raw).find((value) => value && typeof value === "object" && !Array.isArray(value));
    return Object.fromEntries(Object.entries(directMap ?? {}).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

function projectIdFrom(name: string, existing: Project[]) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  let id = base;
  let suffix = 2;
  while (existing.some((project) => project.id === id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function documentArray<T>(document: Record<string, unknown>, key: string, fallback: T[]) {
  return Array.isArray(document[key]) ? document[key] as T[] : fallback;
}

const initialSauceDemoSeed = createSauceDemoSeed();

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      projects: import.meta.env.PROD ? [] as Project[] : [initialSauceDemoSeed.project],
      flowsByProject: import.meta.env.PROD ? {} as Record<string, Flow[]> : { "sauce-demo": initialSauceDemoSeed.flows },
      elementsByProject: import.meta.env.PROD ? {} as Record<string, ElementAsset[]> : { "sauce-demo": initialSauceDemoSeed.elements },
      variablesByProject: import.meta.env.PROD ? {} as Record<string, Variable[]> : { "sauce-demo": initialSauceDemoSeed.variables },
      environmentsByProject: import.meta.env.PROD ? {} as Record<string, Environment[]> : { "sauce-demo": [initialSauceDemoSeed.environment] },
      activeEnvironmentByProject: import.meta.env.PROD ? {} as Record<string, string> : { "sauce-demo": "sauce-demo-web" },
      projectModesById: import.meta.env.PROD ? {} as Record<string, ProjectMode> : { "sauce-demo": "local" },
      platformProjectIdsById: {},
      platformSyncStatusById: {},
      platformSyncErrorById: {},
      createProject: ({ name, description }) => {
        const project: Project = {
          id: projectIdFrom(name, get().projects),
          name: name.trim(),
          description: description?.trim() || "尚未添加项目说明",
        };
        set((state) => ({
          projects: [project, ...state.projects],
          flowsByProject: { ...state.flowsByProject, [project.id]: [] },
          elementsByProject: { ...state.elementsByProject, [project.id]: [] },
          variablesByProject: { ...state.variablesByProject, [project.id]: [] },
          environmentsByProject: { ...state.environmentsByProject, [project.id]: [] },
          activeEnvironmentByProject: {
            ...state.activeEnvironmentByProject,
            [project.id]: "",
          },
          projectModesById: { ...state.projectModesById, [project.id]: "local" },
        }));
        return project;
      },
      persistWorkspace: () => {
        set((state) => ({ projects: state.projects }));
      },
      archiveProject: (projectId) =>
        set((state) => ({
          projects: state.projects.filter((project) => project.id !== projectId),
          flowsByProject: withoutProject(state.flowsByProject, projectId),
          elementsByProject: withoutProject(state.elementsByProject, projectId),
          variablesByProject: withoutProject(state.variablesByProject, projectId),
          environmentsByProject: withoutProject(state.environmentsByProject, projectId),
          activeEnvironmentByProject: withoutProject(
            state.activeEnvironmentByProject,
            projectId,
          ),
          projectModesById: withoutProject(state.projectModesById, projectId),
          platformProjectIdsById: withoutProject(state.platformProjectIdsById, projectId),
          platformSyncStatusById: withoutProject(state.platformSyncStatusById, projectId),
          platformSyncErrorById: withoutProject(state.platformSyncErrorById, projectId),
        })),
      updateProject: (projectId, patch) =>
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId ? { ...project, ...patch } : project,
          ),
        })),
      setFlows: (projectId, flows) =>
        set((state) => ({
          flowsByProject: { ...state.flowsByProject, [projectId]: flows },
        })),
      setElements: (projectId, elements) =>
        set((state) => ({
          elementsByProject: { ...state.elementsByProject, [projectId]: elements },
        })),
      setVariables: (projectId, variables) =>
        set((state) => ({
          variablesByProject: { ...state.variablesByProject, [projectId]: variables },
        })),
      setEnvironments: (projectId, environments) =>
        set((state) => {
          const activeEnvironmentId = state.activeEnvironmentByProject[projectId];
          const activeEnvironment = environments.some(
            (environment) => environment.id === activeEnvironmentId,
          )
            ? activeEnvironmentId
            : environments[0]?.id ?? "";
          return {
            environmentsByProject: { ...state.environmentsByProject, [projectId]: environments },
            activeEnvironmentByProject: {
              ...state.activeEnvironmentByProject,
              [projectId]: activeEnvironment,
            },
          };
        }),
      setActiveEnvironment: (projectId, environmentId) =>
        set((state) => ({
          activeEnvironmentByProject: {
            ...state.activeEnvironmentByProject,
            [projectId]: environmentId,
          },
        })),
      enablePlatformProject: (projectId, platformProjectId) =>
        set((state) => ({
          projectModesById: { ...state.projectModesById, [projectId]: "platform-enabled" },
          platformProjectIdsById: { ...state.platformProjectIdsById, [projectId]: platformProjectId },
          platformSyncStatusById: { ...state.platformSyncStatusById, [projectId]: "syncing" },
          platformSyncErrorById: withoutProject(state.platformSyncErrorById, projectId),
        })),
      disconnectPlatformProject: (projectId) =>
        set((state) => ({
          projectModesById: { ...state.projectModesById, [projectId]: "local" },
          platformProjectIdsById: withoutProject(state.platformProjectIdsById, projectId),
          platformSyncStatusById: withoutProject(state.platformSyncStatusById, projectId),
          platformSyncErrorById: withoutProject(state.platformSyncErrorById, projectId),
        })),
      setPlatformSyncStatus: (projectId, status) =>
        set((state) => ({
          platformSyncStatusById: { ...state.platformSyncStatusById, [projectId]: status },
        })),
      setPlatformSyncError: (projectId, error) =>
        set((state) => ({
          platformSyncErrorById: error
            ? { ...state.platformSyncErrorById, [projectId]: error }
            : withoutProject(state.platformSyncErrorById, projectId),
        })),
      hydratePlatformProjects: (platformProjects) =>
        set((state) => {
          if (platformProjects.length === 0) return state;
          const sourceIds = new Set(platformProjects.map((project) => project.sourceProjectId));
          const mappedProjects = platformProjects.map((platformProject) => ({
            id: platformProject.sourceProjectId,
            name: platformProject.name,
            description: platformProject.description,
          }));
          const retainedProjects = state.projects.filter((project) => !sourceIds.has(project.id));
          const nextFlows = { ...state.flowsByProject };
          const nextElements = { ...state.elementsByProject };
          const nextVariables = { ...state.variablesByProject };
          const nextEnvironments = { ...state.environmentsByProject };
          const nextActiveEnvironments = { ...state.activeEnvironmentByProject };
          for (const platformProject of platformProjects) {
            const { sourceProjectId, document } = platformProject;
            nextFlows[sourceProjectId] = documentArray<Flow>(
              document,
              "flows",
              state.flowsByProject[sourceProjectId] ?? [],
            );
            nextElements[sourceProjectId] = documentArray<ElementAsset>(
              document,
              "elements",
              state.elementsByProject[sourceProjectId] ?? [],
            );
            nextVariables[sourceProjectId] = documentArray<Variable>(
              document,
              "variables",
              state.variablesByProject[sourceProjectId] ?? [],
            );
            nextEnvironments[sourceProjectId] = documentArray<Environment>(
              document,
              "environments",
              state.environmentsByProject[sourceProjectId] ?? [],
            );
            const activeEnvironmentId = typeof document.activeEnvironmentId === "string"
              ? document.activeEnvironmentId
              : state.activeEnvironmentByProject[sourceProjectId] ?? "";
            nextActiveEnvironments[sourceProjectId] = nextEnvironments[sourceProjectId].some(
              (environment) => environment.id === activeEnvironmentId,
            )
              ? activeEnvironmentId
              : nextEnvironments[sourceProjectId][0]?.id ?? "";
          }
          return {
            projects: [...mappedProjects, ...retainedProjects],
            flowsByProject: nextFlows,
            elementsByProject: nextElements,
            variablesByProject: nextVariables,
            environmentsByProject: nextEnvironments,
            activeEnvironmentByProject: nextActiveEnvironments,
            projectModesById: {
              ...state.projectModesById,
              ...Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, "platform-enabled"])),
            },
            platformProjectIdsById: {
              ...state.platformProjectIdsById,
              ...Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, item.platformProjectId])),
            },
            platformSyncStatusById: {
              ...state.platformSyncStatusById,
              ...Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, "synced"])),
            },
            platformSyncErrorById: state.platformSyncErrorById,
          };
        }),
      replaceServerWorkspace: (platformProjects) =>
        set(() => ({
          projects: platformProjects.map((item) => ({ id: item.sourceProjectId, name: item.name, description: item.description })),
          flowsByProject: Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, documentArray<Flow>(item.document, "flows", [])])),
          elementsByProject: Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, documentArray<ElementAsset>(item.document, "elements", [])])),
          variablesByProject: Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, documentArray<Variable>(item.document, "variables", [])])),
          environmentsByProject: Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, documentArray<Environment>(item.document, "environments", [])])),
          activeEnvironmentByProject: Object.fromEntries(platformProjects.map((item) => {
            const environments = documentArray<Environment>(item.document, "environments", []);
            const selected = typeof item.document.activeEnvironmentId === "string" ? item.document.activeEnvironmentId : "";
            return [item.sourceProjectId, environments.some((environment) => environment.id === selected) ? selected : environments[0]?.id ?? ""];
          })),
          projectModesById: Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, "platform-enabled" as const])),
          platformProjectIdsById: Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, item.platformProjectId])),
          platformSyncStatusById: Object.fromEntries(platformProjects.map((item) => [item.sourceProjectId, "synced" as const])),
          platformSyncErrorById: {},
        })),
      hydratePlatformProjectMetadata: (platformProjects) =>
        set((state) => {
          if (platformProjects.length === 0) return state;
          const metadataByProject = new Map(
            platformProjects.map((project) => [
              project.sourceProjectId,
              { name: project.name, description: project.description },
            ]),
          );
          return {
            projects: state.projects.map((project) => {
              const metadata = metadataByProject.get(project.id);
              return metadata ? { ...project, ...metadata } : project;
            }),
          };
        }),
    }),
    {
      name: "autoflow-workspace-projects",
      version: 7,
      migrate: (persistedState) => ensureProjectModes(persistedState) as WorkspaceStore,
      merge: (persistedState, currentState) =>
        ensureProjectModes({
          ...currentState,
          ...(persistedState && typeof persistedState === "object" ? persistedState : {}),
        }) as WorkspaceStore,
      onRehydrateStorage: () => (state) => {
        state?.persistWorkspace();
      },
      partialize: (state) => import.meta.env.PROD ? ({
        activeEnvironmentByProject: state.activeEnvironmentByProject,
      }) : ({
        projects: state.projects,
        flowsByProject: state.flowsByProject,
        elementsByProject: state.elementsByProject,
        variablesByProject: Object.fromEntries(
          Object.entries(state.variablesByProject).map(([projectId, variables]) => [
            projectId,
            variables.map((variable) =>
              variable.secret ? { ...variable, value: "" } : variable,
            ),
          ]),
        ),
        environmentsByProject: state.environmentsByProject,
        activeEnvironmentByProject: state.activeEnvironmentByProject,
        projectModesById: state.projectModesById,
        platformProjectIdsById: state.platformProjectIdsById,
        platformSyncStatusById: state.platformSyncStatusById,
        platformSyncErrorById: state.platformSyncErrorById,
      }),
    },
  ),
);
