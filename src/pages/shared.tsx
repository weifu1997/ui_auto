// Page components share these rendering and data helpers as a single, lazy-loaded module.
/* oxlint-disable react/only-export-components */
import { message, modal } from "../antd-feedback";
import type { ElementAsset, Environment, Flow, FlowStep, Project, Run, Variable } from "../mock-data";
import type { PlatformRun, PlatformSession } from "../platform-api";
import { readStoredPlatformSession } from "../platform-context";
import { Link, useLocation, useNavigate } from "../router";
import { useRunStore } from "../run-store";
import { WorkerApiError, getWorkerHealth, subscribeToTask } from "../worker-api";
import type { WorkerTask } from "../worker-api";
import { useWorkspaceStore } from "../workspace-store";
import { AppstoreOutlined, ClockCircleOutlined, CloudServerOutlined, CodeOutlined, DatabaseOutlined, DownOutlined, ExperimentOutlined, FileSearchOutlined, FolderOpenOutlined, GlobalOutlined, PlayCircleFilled, SafetyCertificateOutlined, SettingOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Alert, Avatar, Badge, Input, Select, Tag, Tooltip } from "antd";
import { useEffect, useState } from "react";
import "../App.css";
import "../responsive.css";

export type ProjectSection =
  | "overview"
  | "flows"
  | "elements"
  | "variables"
  | "environments"
  | "data"
  | "agents"
  | "debug"
  | "automations"
  | "governance"
  | "runs"
  | "settings"
  | "platform";

export const sectionMeta: Record<
  ProjectSection,
  { label: string; icon: React.ReactNode }
> = {
  overview: { label: "概览", icon: <AppstoreOutlined /> },
  flows: { label: "流程", icon: <UnorderedListOutlined /> },
  elements: { label: "元素库", icon: <FileSearchOutlined /> },
  variables: { label: "变量", icon: <CodeOutlined /> },
  environments: { label: "环境", icon: <GlobalOutlined /> },
  data: { label: "数据集", icon: <DatabaseOutlined /> },
  agents: { label: "执行节点", icon: <CloudServerOutlined /> },
  debug: { label: "调试", icon: <ExperimentOutlined /> },
  automations: { label: "持续回归", icon: <ClockCircleOutlined /> },
  governance: { label: "治理分析", icon: <SafetyCertificateOutlined /> },
  runs: { label: "运行中心", icon: <PlayCircleFilled /> },
  settings: { label: "项目设置", icon: <SettingOutlined /> },
  platform: { label: "发布与远程执行", icon: <CloudServerOutlined /> },
};

export const statusMeta = {
  success: { label: "通过", color: "success" },
  failed: { label: "失败", color: "error" },
  running: { label: "运行中", color: "processing" },
  queued: { label: "排队中", color: "default" },
  canceled: { label: "已取消", color: "default" },
} as const;

export const emptyRuns: Run[] = [];
export const emptyFlows: Flow[] = [];
export const emptyElements: ElementAsset[] = [];
export const emptyVariables: Variable[] = [];
export const emptyEnvironments: Environment[] = [];
export const emptySecretValues: Record<string, string> = {};

export function statusTag(status: Run["status"]) {
  const meta = statusMeta[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function projectById(projects: Project[], id?: string) {
  return projects.find((project) => project.id === id);
}

export function WorkspaceSide({ compact = false }: { compact?: boolean }) {
  const location = useLocation();
  const isProjects = location.pathname === "/projects";
  const isTemplates = location.pathname === "/templates";
  return (
    <aside className={`workspace-side ${compact ? "compact" : ""}`}>
      <Link className="brand" to="/projects" aria-label="AutoFlow 工作空间">
        <span className="brand-mark">
          <ThunderboltOutlined />
        </span>
        {!compact && <span>AutoFlow</span>}
      </Link>
      <nav className="workspace-nav" aria-label="工作空间导航">
        <Tooltip title={compact ? "项目列表" : undefined} placement="right">
          <Link
            className={isProjects ? "workspace-link active" : "workspace-link"}
            to="/projects"
          >
            <FolderOpenOutlined /> {!compact && <span>项目</span>}
          </Link>
        </Tooltip>
        <Tooltip title={compact ? "公共模板库" : undefined} placement="right">
          <Link
            className={isTemplates ? "workspace-link active" : "workspace-link"}
            to="/templates"
          >
            <DatabaseOutlined /> {!compact && <span>公共模板</span>}
          </Link>
        </Tooltip>
      </nav>
      <div className="side-spacer" />
      <div className="side-profile">
        <Avatar
          size={28}
          style={{ background: "#ddeeea", color: "#147a73", fontWeight: 700 }}
        >
          R
        </Avatar>
        {!compact && (
          <div>
            <strong>Rui Chen</strong>
            <span>工作空间管理员</span>
          </div>
        )}
      </div>
    </aside>
  );
}

export function ProjectLayout({
  project,
  section,
  children,
}: {
  project: Project;
  section: ProjectSection;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const projectRuns = useRunStore(
    (state) => state.apiRuns[project.id] ?? emptyRuns,
  );
  const activeEnvironmentId = useWorkspaceStore(
    (state) => state.activeEnvironmentByProject[project.id],
  );
  const setActiveEnvironment = useWorkspaceStore(
    (state) => state.setActiveEnvironment,
  );
  const environments = storedEnvironments ?? emptyEnvironments;
  const environment =
    environments.find((item) => item.id === activeEnvironmentId) ?? environments[0];
  const runningRunCount = projectRuns.filter((run) => run.status === "running").length;
  const [workerStatus, setWorkerStatus] = useState<"checking" | "online" | "offline">("checking");
  const agentStatus: string = "local";
  const agentName = undefined;

  useEffect(() => {
    let mounted = true;
    let request: AbortController | undefined;
    const refresh = async () => {
      request?.abort();
      request = new AbortController();
      try {
        const health = await getWorkerHealth(request.signal);
        if (mounted) setWorkerStatus(health.ok ? "online" : "offline");
      } catch {
        if (mounted) setWorkerStatus("offline");
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      mounted = false;
      request?.abort();
      window.clearInterval(interval);
    };
  }, []);

  const workerLabel = workerStatus === "online"
    ? "Worker 在线"
    : workerStatus === "offline"
      ? "Worker 离线"
      : "正在检查 Worker";
  const agentLabel = agentStatus === "online"
    ? `Agent ${agentName ?? ""} 在线`
    : agentStatus === "offline"
      ? `Agent ${agentName ?? ""} 离线`
      : agentStatus === "unbound"
        ? "未绑定 Agent"
        : agentStatus === "unimported"
          ? "项目未导入 Platform"
          : agentStatus === "unknown"
            ? "Platform 状态未知"
            : "正在检查 Agent";
  void agentLabel;
  return (
    <div className="app-shell">
      <WorkspaceSide compact />
      <aside className="project-side">
        <button
          className="project-switcher"
          onClick={() => navigate("/projects")}
        >
          <span className="project-initial">{project.name.slice(0, 1)}</span>
          <span>
            <strong>{project.name}</strong>
            <small>当前项目</small>
          </span>
          <DownOutlined />
        </button>
        <nav className="project-nav" aria-label="项目导航">
          {(Object.keys(sectionMeta) as ProjectSection[])
            .filter((key) => !["data", "agents", "debug", "automations", "governance"].includes(key))
            .map((key) => (
            <Link
              key={key}
              className={
                section === key ? "project-nav-item active" : "project-nav-item"
              }
              to={`/project/${project.id}/${key}`}
            >
              {sectionMeta[key].icon}
              <span>{sectionMeta[key].label}</span>
              {key === "runs" && (
                <Badge count={runningRunCount} size="small" color="#147a73" />
              )}
            </Link>
            ))}
        </nav>
        <div className="project-side-footer">
          <SafetyCertificateOutlined />
          <span>项目数据已隔离</span>
        </div>
      </aside>
      <main className="project-main">
        <header className="project-topbar">
          <div className="breadcrumb">
            <Link to="/projects">项目</Link>
            <span>/</span>
            <strong>{sectionMeta[section].label}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`worker-status ${workerStatus}`} title={workerLabel}>
              <i /> {workerLabel}
            </span>
            <Select
              className="environment-select"
              value={environment?.id}
              onChange={(environmentId) =>
                setActiveEnvironment(project.id, environmentId)
              }
              options={environments.map(
                (item) => ({ value: item.id, label: item.name }),
              )}
              suffixIcon={<DownOutlined />}
            />
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}

export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

export function isWorkerRunId(id?: string) {
  return Boolean(id?.startsWith("run_"));
}

export function reportRetryError(error: unknown) {
  if (error instanceof WorkerApiError && error.code === "RUN_SECRETS_REQUIRED") {
    message.info("此运行包含会话密钥，请从流程重新运行并重新注入密钥。");
    return true;
  }
  return false;
}

export function isTerminalStatus(status: Run["status"]) {
  return status === "success" || status === "failed" || status === "canceled";
}

export function variableReference(variable: Variable) {
  return `${variable.scope === "环境" ? "env" : "project"}.${variable.name}`;
}

export function requiredSecretVariables(variables: Variable[], steps: FlowStep[]) {
  return variables.filter((variable) => {
    if (!variable.secret || (variable.scope !== "环境" && variable.scope !== "项目")) return false;
    const reference = variableReference(variable).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = new RegExp(`{{\\s*${reference}\\s*}}`);
    return steps.some((step) => token.test(step.value));
  });
}

export function requestRunSecrets(
  projectId: string,
  variables: Variable[],
  steps: FlowStep[],
  sessionValues: Record<string, string>,
  setValues: (projectId: string, values: Record<string, string>) => void,
) {
  const required = requiredSecretVariables(variables, steps);
  const missing = required.filter((variable) => !sessionValues[variable.id]);
  if (missing.length === 0) return Promise.resolve(sessionValues);
  return new Promise<Record<string, string> | null>((resolve) => {
    const submitted = { ...sessionValues };
    modal.confirm({
      title: "运行前注入密钥",
      content: (
        <div className="secret-run-fields">
          {missing.map((variable) => (
            <label key={variable.id}>
              <span>{variable.name}</span>
              <Input.Password
                aria-label={`运行密钥 ${variable.name}`}
                autoComplete="off"
                onChange={(event) => {
                  submitted[variable.id] = event.target.value;
                }}
              />
            </label>
          ))}
        </div>
      ),
      okText: "注入并运行",
      cancelText: "取消",
      onOk: () => {
        const unresolved = missing.find((variable) => !submitted[variable.id]);
        if (unresolved) {
          message.error(`请填写密钥变量“${unresolved.name}”`);
          return Promise.reject(new Error("SECRET_VALUE_REQUIRED"));
        }
        setValues(projectId, submitted);
        resolve(submitted);
      },
      onCancel: () => resolve(null),
    });
  });
}

export function platformVariables(variables: Variable[]) {
  return Object.fromEntries(
    variables
      .filter((variable) => !variable.secret && (variable.scope === "项目" || variable.scope === "环境"))
      .map((variable) => [variableReference(variable), variable.value]),
  );
}

export function durationFromMilliseconds(value: unknown) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "-";
  return milliseconds >= 1000
    ? `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`
    : `${milliseconds}ms`;
}

export function workerTaskAsRun(task: WorkerTask, fallback?: Run): Run {
  const totalSteps = Number(task.result?.totalSteps ?? task.summary?.totalSteps ?? fallback?.totalSteps ?? 0);
  const completedSteps = Number(task.result?.completedSteps ?? fallback?.completedSteps ?? 0);
  const terminal = isTerminalStatus(task.status);
  return {
    id: task.id,
    flowName: task.summary?.flowName ?? fallback?.flowName ?? "运行任务",
    status: task.status,
    environment: task.summary?.environmentName ?? fallback?.environment ?? "-",
    progress: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
    completedSteps,
    totalSteps,
    startedAt: fallback?.startedAt ?? new Date(task.createdAt).toLocaleString(),
    duration: terminal
      ? durationFromMilliseconds(task.result?.elapsedMs) !== "-"
        ? durationFromMilliseconds(task.result?.elapsedMs)
        : fallback?.duration ?? "已完成"
      : "进行中",
    screenshots: task.artifacts.filter((artifact) => artifact.contentType.startsWith("image/")).length,
    retries: fallback?.retries ?? 0,
  };
}

export function platformRunAsRun(run: PlatformRun): Run {
  const snapshot = run.snapshot;
  const flow = snapshot.flow && typeof snapshot.flow === "object" ? snapshot.flow as Record<string, unknown> : {};
  const environment = snapshot.environment && typeof snapshot.environment === "object" ? snapshot.environment as Record<string, unknown> : {};
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const completedSteps = run.events.filter((event) => event.kind === "step.completed").length;
  const status: Run["status"] = run.status === "dispatched" ? "running" : run.status;
  return {
    id: run.id,
    flowName: typeof flow.name === "string" ? flow.name : "平台运行",
    status,
    environment: typeof environment.name === "string" ? environment.name : run.environmentId,
    progress: steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : status === "success" ? 100 : 0,
    completedSteps: status === "success" ? steps.length : completedSteps,
    totalSteps: steps.length,
    startedAt: new Date(run.createdAt).toLocaleString(),
    duration: isTerminalStatus(status) ? "已完成" : "进行中",
    screenshots: run.artifacts.filter((artifact) => artifact.contentType.startsWith("image/")).length,
    retries: Math.max(0, (run.lease?.attempt ?? 1) - 1),
  };
}

export function watchWorkerRun(
  projectId: string,
  run: Run,
  upsertRun: (projectId: string, run: Run) => void,
) {
  let current = run;
  const unsubscribe = subscribeToTask(projectId, "runs", run.id, (event) => {
    if (event.kind === "status") {
      const status = event.data.status as Run["status"];
      if (!Object.hasOwn(statusMeta, status)) return;
      current = {
        ...current,
        status,
        progress: status === "success" ? 100 : current.progress,
        completedSteps: status === "success" ? current.totalSteps : current.completedSteps,
        duration: isTerminalStatus(status) ? "已完成" : "进行中",
      };
    }
    if (event.kind === "step") {
      const completedSteps =
        event.data.status === "success"
          ? Math.max(current.completedSteps, Number(event.data.index ?? -1) + 1)
          : current.completedSteps;
      current = {
        ...current,
        status: event.data.status === "failed" ? "failed" : "running",
        completedSteps,
        progress:
          current.totalSteps > 0
            ? Math.round((completedSteps / current.totalSteps) * 100)
            : 0,
        screenshots:
          event.data.artifactId && event.data.status === "failed"
            ? current.screenshots + 1
            : current.screenshots,
      };
    }
    upsertRun(projectId, current);
    if (isTerminalStatus(current.status)) unsubscribe();
  });
  return unsubscribe;
}

export function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function PlatformProjectRequired({ project, title, description }: { project: Project; title: string; description: string }) {
  const [session] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  return (
    <>
      <PageHeading title={title} description={description} />
      <Alert type="info" showIcon title={session ? "当前项目尚未导入平台" : "请先连接平台账户"} action={<Link to={`/project/${project.id}/agents`}>{session ? "导入并绑定节点" : "前往执行节点"}</Link>} />
    </>
  );
}
