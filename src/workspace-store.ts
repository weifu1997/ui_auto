import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ElementAsset, Environment, Flow, Project, Variable } from "./mock-data";
import { createSauceDemoSeed } from "./saucedemo-seed";

type NewProjectInput = {
  name: string;
  description?: string;
};

export type ProjectMember = {
  id: string;
  name: string;
  email: string;
  role: "成员" | "管理员";
};

export type PlatformWorkspaceProject = {
  platformProjectId: string;
  sourceProjectId: string;
  name: string;
  description: string;
  document: Record<string, unknown>;
};

type WorkspaceStore = {
  projects: Project[];
  flowsByProject: Record<string, Flow[]>;
  elementsByProject: Record<string, ElementAsset[]>;
  variablesByProject: Record<string, Variable[]>;
  environmentsByProject: Record<string, Environment[]>;
  activeEnvironmentByProject: Record<string, string>;
  membersByProject: Record<string, ProjectMember[]>;
  createProject: (input: NewProjectInput) => Project;
  persistWorkspace: () => void;
  archiveProject: (projectId: string) => void;
  updateProject: (projectId: string, patch: Pick<Project, "name" | "description">) => void;
  setFlows: (projectId: string, flows: Flow[]) => void;
  setElements: (projectId: string, elements: ElementAsset[]) => void;
  setVariables: (projectId: string, variables: Variable[]) => void;
  setEnvironments: (projectId: string, environments: Environment[]) => void;
  setActiveEnvironment: (projectId: string, environmentId: string) => void;
  addMember: (projectId: string, member: Omit<ProjectMember, "id">) => void;
  hydratePlatformProjects: (projects: PlatformWorkspaceProject[]) => void;
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
    membersByProject: withoutDemoKeys(state.membersByProject),
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
    membersByProject: { ...(state.membersByProject ?? {}), [seed.project.id]: [] },
  };
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
      projects: [initialSauceDemoSeed.project],
      flowsByProject: { "sauce-demo": initialSauceDemoSeed.flows },
      elementsByProject: { "sauce-demo": initialSauceDemoSeed.elements },
      variablesByProject: { "sauce-demo": initialSauceDemoSeed.variables },
      environmentsByProject: { "sauce-demo": [initialSauceDemoSeed.environment] },
      activeEnvironmentByProject: { "sauce-demo": "sauce-demo-web" },
      membersByProject: { "sauce-demo": [] },
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
          membersByProject: { ...state.membersByProject, [project.id]: [] },
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
          membersByProject: withoutProject(state.membersByProject, projectId),
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
      addMember: (projectId, member) =>
        set((state) => ({
          membersByProject: {
            ...state.membersByProject,
            [projectId]: [
              ...(state.membersByProject[projectId] ?? []),
              { ...member, id: `member-${Date.now()}` },
            ],
          },
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
          const nextMembers = { ...state.membersByProject };
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
            nextMembers[sourceProjectId] = documentArray<ProjectMember>(
              document,
              "members",
              state.membersByProject[sourceProjectId] ?? [],
            );
          }
          return {
            projects: [...mappedProjects, ...retainedProjects],
            flowsByProject: nextFlows,
            elementsByProject: nextElements,
            variablesByProject: nextVariables,
            environmentsByProject: nextEnvironments,
            activeEnvironmentByProject: nextActiveEnvironments,
            membersByProject: nextMembers,
          };
        }),
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
      version: 6,
      migrate: (persistedState) => addSauceDemoSeed(persistedState),
      merge: (persistedState, currentState) =>
        addSauceDemoSeed({
          ...currentState,
          ...(persistedState && typeof persistedState === "object" ? persistedState : {}),
        }) as WorkspaceStore,
      onRehydrateStorage: () => (state) => {
        state?.persistWorkspace();
      },
      partialize: (state) => ({
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
        membersByProject: state.membersByProject,
      }),
    },
  ),
);
