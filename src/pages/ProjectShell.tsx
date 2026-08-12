import { lazy, Suspense } from "react";
import type { ComponentType } from "react";
import type { Project } from "../mock-data";
import { Navigate, useParams } from "../router";
import { ProjectLayout, projectById, sectionMeta } from "./shared";
import type { ProjectSection } from "./shared";
import { useWorkspaceStore } from "../workspace-store";

const lazySection = (loader: () => Promise<{ default: ComponentType<{ project: Project }> }>) => lazy(loader);

const sectionPages: Record<ProjectSection, ComponentType<{ project: Project }>> = {
  platform: lazySection(() => import("./PlatformPage").then((m) => ({ default: m.PlatformPage }))),
  overview: lazySection(() => import("./OverviewPage").then((m) => ({ default: m.OverviewPage }))),
  flows: lazySection(() => import("./FlowsPage").then((m) => ({ default: m.FlowsPage }))),
  elements: lazySection(() => import("./ElementsPage").then((m) => ({ default: m.ElementsPage }))),
  variables: lazySection(() => import("./VariablesPage").then((m) => ({ default: m.VariablesPage }))),
  environments: lazySection(() => import("./EnvironmentsPage").then((m) => ({ default: m.EnvironmentsPage }))),
  data: lazySection(() => import("./DatasetsPage").then((m) => ({ default: m.DatasetsPage }))),
  agents: lazySection(() => import("./AgentsPage").then((m) => ({ default: m.AgentsPage }))),
  automations: lazySection(() => import("./AutomationsPage").then((m) => ({ default: m.AutomationsPage }))),
  governance: lazySection(() => import("./GovernancePage").then((m) => ({ default: m.GovernancePage }))),
  runs: lazySection(() => import("./RunsPage").then((m) => ({ default: m.RunsPage }))),
  settings: lazySection(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage }))),
};

export function ProjectShell() {
  const { projectId, section } = useParams();
  const projects = useWorkspaceStore((state) => state.projects);
  const projectMode = useWorkspaceStore((state) =>
    projectId ? state.projectModesById?.[projectId] : undefined,
  );
  const project = projectById(projects, projectId);
  const activeSection = (
    section && section in sectionMeta ? section : "overview"
  ) as ProjectSection;
  const production = import.meta.env.PROD || import.meta.env.VITE_AUTH_REQUIRED === "1";
  if (!project) return <Navigate to="/projects" replace />;
  if (production && ["agents"].includes(activeSection)) return <Navigate to={`/project/${project.id}/overview`} replace />;
  if (
    projectMode !== "platform-enabled"
    && ["data", "agents", "automations", "governance"].includes(activeSection)
  ) return <Navigate to={`/project/${project.id}/platform`} replace />;
  const SectionPage = sectionPages[activeSection];
  return (
    <ProjectLayout project={project} section={activeSection}>
      <Suspense fallback={<div className="route-loading" />}>
        <SectionPage project={project} />
      </Suspense>
    </ProjectLayout>
  );
}
