import { lazy, Suspense } from "react";
import type { ComponentType } from "react";
import type { Project } from "../lib/mock-data";
import { Navigate, useParams } from "../router";
import { ProjectLayout, projectById, sectionMeta } from "./shared";
import type { ProjectSection } from "./shared";
import { useWorkspaceStore } from "../stores/workspace-store";

const lazySection = (loader: () => Promise<{ default: ComponentType<{ project: Project }> }>) => lazy(loader);

const sectionPages: Record<ProjectSection, ComponentType<{ project: Project }>> = {
  overview: lazySection(() => import("./OverviewPage").then((m) => ({ default: m.OverviewPage }))),
  flows: lazySection(() => import("./FlowsPage").then((m) => ({ default: m.FlowsPage }))),
  elements: lazySection(() => import("./ElementsPage").then((m) => ({ default: m.ElementsPage }))),
  variables: lazySection(() => import("./VariablesPage").then((m) => ({ default: m.VariablesPage }))),
  environments: lazySection(() => import("./EnvironmentsPage").then((m) => ({ default: m.EnvironmentsPage }))),
  data: lazySection(() => import("./DatasetsPage").then((m) => ({ default: m.DatasetsPage }))),
  automations: lazySection(() => import("./AutomationsPage").then((m) => ({ default: m.AutomationsPage }))),
  governance: lazySection(() => import("./GovernancePage").then((m) => ({ default: m.GovernancePage }))),
  runs: lazySection(() => import("./RunsPage").then((m) => ({ default: m.RunsPage }))),
};

export function ProjectShell() {
  const { projectId, section } = useParams();
  const projects = useWorkspaceStore((state) => state.projects);
  const project = projectById(projects, projectId);
  if (!project) return <Navigate to="/projects" replace />;
  if (!section || !(section in sectionMeta)) {
    return <Navigate to={`/project/${project.id}/overview`} replace />;
  }
  const activeSection = section as ProjectSection;
  const SectionPage = sectionPages[activeSection];
  return (
    <ProjectLayout project={project} section={activeSection}>
      <Suspense fallback={<div className="route-loading" />}>
        <SectionPage project={project} />
      </Suspense>
    </ProjectLayout>
  );
}
