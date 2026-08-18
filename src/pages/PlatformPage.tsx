/* oxlint-disable react/only-export-components */
import { Tabs } from "antd";
import type { Project } from "../mock-data";
import { AgentsPage } from "./AgentsPage";

export type PlatformTabItem = { key: string; label: string; children: React.ReactNode };

/**
 * 平台页收敛为平台独占能力（发布与运行）。
 */
export function platformTabItems(_platformOnly: boolean, project: Project): PlatformTabItem[] {
  return [
    { key: "publish", label: "发布与运行", children: <AgentsPage project={project} /> },
  ];
}

export function PlatformPage({ project }: { project: Project }) {
  return <Tabs items={platformTabItems(true, project)} />;
}
