import { Tabs } from "antd";
import type { Project } from "../mock-data";
import { AgentsPage } from "./AgentsPage";
import { AutomationsPage } from "./AutomationsPage";
import { DatasetsPage } from "./DatasetsPage";
import { DebugSessionsPage } from "./DebugSessionsPage";
import { GovernancePage } from "./GovernancePage";
import { useWorkspaceStore } from "../workspace-store";

export function PlatformPage({ project }: { project: Project }) {
  const platformEnabled = useWorkspaceStore(
    (state) => (state.projectModesById?.[project.id] ?? "local") === "platform-enabled",
  );
  if (!platformEnabled) return <AgentsPage project={project} />;

  return (
    <Tabs
      items={[
        { key: "publish", label: "发布与远程运行", children: <AgentsPage project={project} /> },
        { key: "debug", label: "远程调试", children: <DebugSessionsPage project={project} /> },
        { key: "data", label: "数据集", children: <DatasetsPage project={project} /> },
        { key: "automation", label: "持续回归", children: <AutomationsPage project={project} /> },
        { key: "governance", label: "治理分析", children: <GovernancePage project={project} /> },
      ]}
    />
  );
}
