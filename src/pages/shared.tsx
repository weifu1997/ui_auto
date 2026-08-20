// Page components share these rendering and data helpers as a single, lazy-loaded module.
/* oxlint-disable react/only-export-components */
import { message, modal } from "../antd-feedback";
import type { ElementAsset, Environment, Flow, FlowStep, Project, Run, Variable } from "../mock-data";
import { getPlatformHealth, PlatformApiError } from "../platform-api";
import type { PlatformCapability, PlatformRun, PlatformSession } from "../platform-api";
import { readStoredPlatformSession, readStoredPlatformWorkspaceId, storePlatformSession, storePlatformWorkspaceId } from "../platform-context";
import { logoutPlatform } from "../platform-api";
import { Link, useLocation, useNavigate } from "../router";
import { useRunStore } from "../run-store";
import { useWorkspaceStore } from "../workspace-store";
import { platformConflictActionEvent } from "../ServerWorkspaceSynchronizer";
import { AppstoreOutlined, ClockCircleOutlined, CloudServerOutlined, CodeOutlined, DatabaseOutlined, DownOutlined, FileSearchOutlined, FolderOpenOutlined, GlobalOutlined, LogoutOutlined, MenuOutlined, PlayCircleFilled, SafetyCertificateOutlined, SettingOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Alert, Avatar, Badge, Button, Input, Select, Tag, Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import "../App.css";
import "../responsive.css";

function formatConflictActorTime(raw: string | null): string {
  if (!raw) return "";
  try {
    const draft = JSON.parse(raw) as { remoteUpdatedBy?: string; remoteUpdatedAt?: string };
    const parts: string[] = [];
    if (draft.remoteUpdatedAt) {
      parts.push(new Date(draft.remoteUpdatedAt).toLocaleString("zh-CN"));
    }
    if (draft.remoteUpdatedBy) {
      parts.push(`更新者 ${draft.remoteUpdatedBy}`);
    }
    return parts.length ? `其他成员已于 ${parts.join("，")} 更新该资源。` : "";
  } catch {
    return "";
  }
}

export type ProjectSection =
  | "overview"
  | "flows"
  | "elements"
  | "variables"
  | "environments"
  | "data"
  | "agents"
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
  agents: { label: "发布与运行", icon: <CloudServerOutlined /> },
  automations: { label: "持续回归", icon: <ClockCircleOutlined /> },
  governance: { label: "系统管理", icon: <SafetyCertificateOutlined /> },
  runs: { label: "运行中心", icon: <PlayCircleFilled /> },
  settings: { label: "项目设置", icon: <SettingOutlined /> },
  platform: { label: "平台", icon: <CloudServerOutlined /> },
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
  const isAdministration = location.pathname === "/workspace/administration";
  const session = readStoredPlatformSession();
  const workspaceId = readStoredPlatformWorkspaceId(session);
  const selectedWorkspace = session?.workspaces.find((workspace) => workspace.id === workspaceId);
  const canManageWorkspace = Boolean(
    session?.user.globalRole === "super_admin" ||
      selectedWorkspace?.capabilities?.includes("member.manage"),
  );
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
        {canManageWorkspace && (
          <Tooltip title={compact ? "成员与账户管理" : undefined} placement="right">
            <Link
              className={isAdministration ? "workspace-link active" : "workspace-link"}
              to="/workspace/administration"
            >
              <SafetyCertificateOutlined /> {!compact && <span>成员与账户</span>}
            </Link>
          </Tooltip>
        )}
      </nav>
      <div className="side-spacer" />
      <div className="side-profile">
        <Avatar className="side-avatar" size={28}>
          {session?.user.name.slice(0, 1).toUpperCase() ?? "A"}
        </Avatar>
        {!compact && (
          <div>
            <strong>{session?.user.name ?? "AutoFlow 用户"}</strong>
            <span>{session?.user.email ?? "未登录"}</span>
            {session && session.workspaces.length > 1 && (
              <Select
                aria-label="切换工作区"
                size="small"
                value={workspaceId || undefined}
                options={session.workspaces.map((workspace) => ({
                  value: workspace.id,
                  label: workspace.name,
                }))}
                onChange={(nextWorkspaceId) => {
                  storePlatformWorkspaceId(nextWorkspaceId);
                  window.location.assign("/projects");
                }}
              />
            )}
          </div>
        )}
        {!compact && session && <Tooltip title="退出登录"><Button type="text" icon={<LogoutOutlined />} aria-label="退出登录" onClick={() => void logoutPlatform().finally(() => { storePlatformSession(); window.location.assign("/"); })} /></Tooltip>}
      </div>
    </aside>
  );
}

export type Capability = PlatformCapability;

// UI only presents commands issued in the server session projection. The API
// remains the authorization authority; browser storage is never trusted by it.
export function canUseCapability(capability: Capability) {
  const session = readStoredPlatformSession();
  const workspaceId = readStoredPlatformWorkspaceId(session);
  return Boolean(
    session?.workspaces
      .find((workspace) => workspace.id === workspaceId)
      ?.capabilities?.includes(capability),
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
  const location = useLocation();
  // 移动端项目侧栏为抽屉：路由变化或点击遮罩时关闭。
  const [projectNavOpen, setProjectNavOpen] = useState(false);
  useEffect(() => {
    setProjectNavOpen(false);
  }, [location.pathname]);
  const visibleSections = ["overview", "flows", "elements", "variables", "environments", "data", "automations", "runs", "platform", "governance", "settings"] as ProjectSection[];
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
  const syncError = useWorkspaceStore((state) => state.platformSyncErrorById[project.id]);
  const environments = storedEnvironments ?? emptyEnvironments;
  const environment =
    environments.find((item) => item.id === activeEnvironmentId) ?? environments[0];
  const runningRunCount = projectRuns.filter((run) => run.status === "running").length;
  const [platformStatus, setPlatformStatus] = useState<"checking" | "online" | "offline">("checking");

  useEffect(() => {
    let mounted = true;
    let request: AbortController | undefined;
    const refresh = async () => {
      request?.abort();
      request = new AbortController();
      try {
        const health = await getPlatformHealth(request.signal);
        if (mounted) setPlatformStatus(health.ok ? "online" : "offline");
      } catch {
        if (mounted) setPlatformStatus("offline");
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

  const platformLabel = platformStatus === "online"
    ? "执行服务在线"
    : platformStatus === "offline"
      ? "执行服务离线"
      : "正在检查执行服务";
  return (
    <div className="app-shell">
      <WorkspaceSide compact />
      <aside className={`project-side ${projectNavOpen ? "open" : ""}`}>
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
          {visibleSections
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
                <Badge count={runningRunCount} size="small" color="var(--accent)" />
              )}
            </Link>
            ))}
        </nav>
        <div className="project-side-footer">
          <SafetyCertificateOutlined />
          <span>项目数据已隔离</span>
        </div>
      </aside>
      {projectNavOpen && (
        <button
          type="button"
          className="project-side-mask"
          aria-label="关闭项目菜单"
          onClick={() => setProjectNavOpen(false)}
        />
      )}
      <main className="project-main">
        <header className="project-topbar">
          <div className="breadcrumb">
            <Button
              type="text"
              className="topbar-menu-button"
              icon={<MenuOutlined />}
              aria-label="打开项目菜单"
              onClick={() => setProjectNavOpen(true)}
            />
            <Link to="/projects">项目</Link>
            <span>/</span>
            <strong>{sectionMeta[section].label}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`platform-status ${platformStatus}`} title={platformLabel}>
              <i /> {platformLabel}
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
        <div className="page-content">
          {syncError === "RESOURCE_VERSION_CONFLICT" && <Alert
            className="sync-conflict-alert"
            type="warning"
            showIcon
            title="检测到其他成员已更新同一资源"
            description={`${formatConflictActorTime(sessionStorage.getItem(`autoflow-conflict-${project.id}`))}本地修改已保存为冲突草稿。可先复制留档，刷新远端，或基于最新版本重新提交。`}
            action={<span className="sync-conflict-actions"><Button size="small" onClick={() => { const draft = sessionStorage.getItem(`autoflow-conflict-${project.id}`) ?? ""; void navigator.clipboard.writeText(draft).then(() => message.success("本地草稿已复制")); }}>复制本地修改</Button><Button size="small" onClick={() => window.dispatchEvent(new CustomEvent(platformConflictActionEvent, { detail: { projectId: project.id, action: "refresh" } }))}>刷新远端</Button><Button size="small" type="primary" onClick={() => window.dispatchEvent(new CustomEvent(platformConflictActionEvent, { detail: { projectId: project.id, action: "resubmit" } }))}>重新提交</Button></span>}
          />}
          {children}
        </div>
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

export function FilterBar({
  children,
  extra,
  className = "",
}: {
  children: React.ReactNode;
  extra?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`filter-bar ${className}`.trim()}>
      <div className="filter-bar-inputs">{children}</div>
      {extra && <div className="filter-bar-extra">{extra}</div>}
    </div>
  );
}

export function FilterItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="filter-item">
      <span className="filter-label">{label}</span>
      <div className="filter-control">{children}</div>
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "default",
  icon,
}: {
  label: string;
  value: string | number;
  detail?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "info";
  icon?: React.ReactNode;
}) {
  return (
    <div className={`metric-card ${tone}`}>
      {icon && <div className="metric-icon">{icon}</div>}
      <span>{label}</span>
      <strong>{value}</strong>
      {detail !== undefined && detail !== null && <small>{detail}</small>}
    </div>
  );
}

export function reportRetryError(error: unknown) {
  if (error instanceof PlatformApiError && error.code === "RUN_SECRETS_REQUIRED") {
    message.info("此运行包含会话密钥，请从流程重新运行并重新注入密钥。");
    return true;
  }
  return false;
}

function knownPlatformRunErrorCode(code: string, status: number): string | undefined {
  switch (code) {
    case "PUBLISHED_REVISION_REQUIRED":
      return "该流程还没有已发布版本，请先保存流程";
    case "REVISION_ENVIRONMENT_MISMATCH":
      return "已发布版本与所选运行环境不匹配，请在目标环境下重新保存并发布流程";
    case "FLOW_HAS_NO_STEPS":
      return "流程没有可执行步骤，请在编排器中添加步骤后再保存";
    case "RUN_SECRET_NOT_CONFIGURED":
      return "缺少必填的运行密钥配置，请确认密钥变量已在项目或环境中声明";
    case "AGENT_BROWSER_UNSUPPORTED":
      // 后端有两条抛出路径，通过 HTTP 状态码区分：
      // - 400：环境配置的 browser 字段不是 Chromium（require_chromium_environment）
      // - 409：执行服务 Playwright 未安装或 Chromium 可执行文件缺失（ensure_chromium_available）
      if (status === 400) {
        return "所选环境的浏览器类型不受支持：当前执行服务仅支持 Chromium。请在环境设置中将浏览器切换为 Chromium。";
      }
      return "执行服务检测不到可用的 Chromium 浏览器，请在部署机上执行 `playwright install chromium` 安装浏览器，并确认 Playwright 依赖完整。";
    case "EXECUTION_SERVICE_UNAVAILABLE":
      return "执行服务未启动或不可达，请检查部署机 Agent 状态与网络连通性";
    case "ENVIRONMENT_NOT_READY":
      return "所选运行环境未就绪，请检查环境基础 URL 与 Agent 健康状态";
    default:
      return undefined;
  }
}

/**
 * 统一解释「创建平台运行」相关的错误，避免 catch-all 吞掉后端给出的
 * 具体失败原因。返回最终要展示给用户的文案；非 PlatformApiError 的异常
 * 也会尽量提取出可读信息。
 */
export function describePlatformRunError(error: unknown, fallback = "创建平台运行失败，请检查执行服务与运行环境") {
  if (error instanceof PlatformApiError) {
    const known = knownPlatformRunErrorCode(error.code, error.status);
    if (known) return known;
    if (error.message) {
      return `${fallback}（${error.code}：${error.message}）`;
    }
    return `${fallback}（错误码：${error.code}）`;
  }
  if (error instanceof Error && error.message) {
    return `${fallback}（${error.message}）`;
  }
  return fallback;
}

export function isTerminalStatus(status: Run["status"]) {
  return status === "success" || status === "failed" || status === "canceled";
}

export function variableReference(variable: Variable) {
  return `${variable.scope === "环境" ? "env" : "project"}.${variable.name}`;
}

export function uniqueVariableNameValidator(
  variables: Variable[],
  scope: Variable["scope"],
  editingId?: string,
): (_: unknown, value: string) => Promise<void> {
  return async (_, value) => {
    const name = value?.trim();
    if (!name) return;
    const conflict = variables.some(
      (variable) =>
        variable.scope === scope &&
        variable.name === name &&
        variable.id !== editingId,
    );
    if (conflict) {
      const scopeLabel = scope === "环境" ? "环境" : "项目";
      throw new Error(`${scopeLabel}作用域已存在同名变量「${name}」，请修改`);
    }
  };
}

export function uniqueNameValidator<T>(options: {
  items: T[];
  getName: (item: T) => string;
  getId?: (item: T) => string;
  editingId?: string;
  entityLabel: string;
  extraScopeLabel?: string;
  getExtraScopeKey?: (item: T) => string | undefined;
  currentExtraScopeKey?: string;
}): (_: unknown, value: string) => Promise<void> {
  return async (_, value) => {
    const name = value?.trim();
    if (!name) return;
    const {
      items,
      getName,
      getId,
      editingId,
      entityLabel,
      extraScopeLabel,
      getExtraScopeKey,
      currentExtraScopeKey,
    } = options;
    const conflict = items.some((item) => {
      if (editingId !== undefined && getId) {
        if (getId(item) === editingId) return false;
      }
      if (getExtraScopeKey && currentExtraScopeKey !== undefined) {
        if (getExtraScopeKey(item) !== currentExtraScopeKey) return false;
      }
      return getName(item) === name;
    });
    if (conflict) {
      const prefix = extraScopeLabel ? `${extraScopeLabel}内` : "";
      throw new Error(`${prefix}已存在同名${entityLabel}「${name}」，请修改`);
    }
  };
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
      width: 520,
      content: (
        <div className="secret-run-fields">
          <Alert
            type="info"
            showIcon
            message="以下密钥仅用于本次运行会话，不会保存至服务器存储。"
            style={{ marginBottom: 8 }}
          />
          {missing.map((variable) => (
            <label key={variable.id} className="secret-run-field">
              <div className="secret-run-label">
                <span className="secret-run-name">
                  <span className="secret-run-required" aria-hidden="true">*</span>
                  {variable.name}
                </span>
                <Tag
                  color={variable.scope === "环境" ? "blue" : "purple"}
                  className="secret-run-scope"
                >
                  {variable.scope}
                </Tag>
              </div>
              {variable.description && (
                <div className="secret-run-description">{variable.description}</div>
              )}
              <Input.Password
                aria-label={`运行密钥 ${variable.name}`}
                autoComplete="new-password"
                placeholder={`请输入 ${variable.name}`}
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

export function platformRunAsRun(run: PlatformRun): Run {
  const snapshot = run.snapshot;
  const flow = snapshot.flow && typeof snapshot.flow === "object" ? snapshot.flow as Record<string, unknown> : {};
  const environment = snapshot.environment && typeof snapshot.environment === "object" ? snapshot.environment as Record<string, unknown> : {};
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  // 同时兼容 runner.py 现在写入的规范事件名「step.completed」和历史写入的「step.succeeded」。
  const completedEvents = run.events.filter(
    (event) => event.kind === "step.completed" || event.kind === "step.succeeded"
  ).length;
  const status: Run["status"] = run.status === "dispatched" ? "running" : run.status;
  const completedSteps = status === "success" ? steps.length : completedEvents;
  return {
    id: run.id,
    flowName: typeof flow.name === "string" ? flow.name : "平台运行",
    status,
    environment: typeof environment.name === "string" ? environment.name : run.environmentId,
    progress: steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : status === "success" ? 100 : 0,
    completedSteps,
    totalSteps: steps.length,
    startedAt: new Date(run.createdAt).toLocaleString(),
    duration: isTerminalStatus(status) ? "已完成" : "进行中",
    screenshots: run.artifacts.filter((artifact) => artifact.contentType.startsWith("image/")).length,
    retries: 0,
  };
}

// 统一轮询 hook：页面隐藏时暂停定时器，恢复可见时重新调度。
export function usePolling(callback: () => void | Promise<void>, intervalMs: number) {
  const savedCallback = useRef(callback);
  useEffect(() => {
    savedCallback.current = callback;
  });
  useEffect(() => {
    if (intervalMs <= 0) return;
    let timer: number | undefined;
    const schedule = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = window.setInterval(() => void savedCallback.current(), intervalMs);
    };
    schedule();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") schedule();
      else if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
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
      <Alert type="info" showIcon title={session ? "项目数据尚未就绪" : "请先连接平台账户"} action={<Link to={session ? "/projects" : `/project/${project.id}/platform`}>{session ? "返回项目列表" : "前往平台"}</Link>} />
    </>
  );
}
