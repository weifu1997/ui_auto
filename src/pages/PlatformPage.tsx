/* oxlint-disable react/only-export-components */
import { Tabs } from "antd";
import type { Project } from "../mock-data";
import { AgentsPage } from "./AgentsPage";
import { AutomationsPage } from "./AutomationsPage";
import { DatasetsPage } from "./DatasetsPage";
import { GovernancePage } from "./GovernancePage";
import { useWorkspaceStore } from "../workspace-store";

export type PlatformTabItem = { key: string; label: string; children: React.ReactNode };

/**
 * production：平台页收敛为平台独占能力（发布与运行）；
 * 「数据集 / 持续回归 / 治理分析」以侧边栏为主入口，避免重复；
 * dev（非 production）：侧边栏本就不含这些入口，保留 Tab 以维持可达性与测试。
 */
export function platformTabItems(production: boolean, project: Project): PlatformTabItem[] {
  const base: PlatformTabItem[] = [
    { key: "publish", label: "发布与运行", children: <AgentsPage project={project} /> },
  ];
  if (production) return base;
  return [
    ...base,
    { key: "data", label: "数据集", children: <DatasetsPage project={project} /> },
    { key: "automation", label: "持续回归", children: <AutomationsPage project={project} /> },
    { key: "governance", label: "治理分析", children: <GovernancePage project={project} /> },
  ];
}

export function PlatformPage({ project }: { project: Project }) {
  const platformEnabled = useWorkspaceStore(
    (state) => (state.projectModesById?.[project.id] ?? "local") === "platform-enabled",
  );
  if (!platformEnabled) return <AgentsPage project={project} />;

  const production = import.meta.env.PROD || import.meta.env.VITE_AUTH_REQUIRED === "1";
  return <Tabs items={platformTabItems(production, project)} />;
}
