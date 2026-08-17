import { useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "./router";
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  DownOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  PlayCircleFilled,
  ReloadOutlined,
  StopOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Alert, Button, Empty, Select, Statistic } from "antd";
import { useRunStore } from "./run-store";
import { useWorkspaceStore } from "./workspace-store";
import { artifactUrl, cancelRun, getRun, retryRun, subscribeToTask, WorkerApiError } from "./worker-api";
import type { WorkerTask, WorkerTaskEvent } from "./worker-api";
import {
  cancelPlatformRun,
  createPlatformRun,
  fetchPlatformArtifact,
  getPlatformRun,
  retryPlatformRun,
} from "./platform-api";
import type { PlatformRun } from "./platform-api";
import { platformProjectContext } from "./platform-context";
import { message } from "./antd-feedback";
import type { Project, Run } from "./mock-data";
import { canUseCapability } from "./pages/shared";

type ProjectLayoutProps = {
  project: Project;
  section: "runs";
  children: ReactNode;
};
type PageHeadingProps = {
  title: string;
  description: string;
  actions?: ReactNode;
};
type RunDetailPageProps = {
  ProjectLayout: ComponentType<ProjectLayoutProps>;
  PageHeading: ComponentType<PageHeadingProps>;
  statusTag: (status: Run["status"]) => ReactNode;
  statusMeta: Record<Run["status"], { label: string }>;
};

function projectById(projects: Project[], id?: string) {
  return projects.find((project) => project.id === id);
}

function isWorkerRunId(id?: string) {
  return Boolean(id?.startsWith("run_"));
}

function isTerminalStatus(status: Run["status"]) {
  return status === "success" || status === "failed" || status === "canceled";
}

function durationFromMilliseconds(value: unknown) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "-";
  return milliseconds >= 1000
    ? `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`
    : `${milliseconds}ms`;
}

function workerTaskAsRun(task: WorkerTask, fallback?: Run): Run {
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
        : fallback?.duration ?? "-"
      : "进行中",
    screenshots: fallback?.screenshots ?? 0,
    retries: fallback?.retries ?? 0,
  };
}

function platformTaskAsRun(task: PlatformRun, fallback?: Run): Run {
  const flow = task.snapshot.flow && typeof task.snapshot.flow === "object"
    ? task.snapshot.flow as Record<string, unknown>
    : {};
  const environment = task.snapshot.environment && typeof task.snapshot.environment === "object"
    ? task.snapshot.environment as Record<string, unknown>
    : {};
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const completedSteps = task.events.filter((event) => event.kind === "step.completed").length;
  const status: Run["status"] = task.status === "dispatched" ? "running" : task.status;
  return {
    id: task.id,
    flowName: typeof flow.name === "string" ? flow.name : fallback?.flowName ?? "Platform run",
    status,
    environment: typeof environment.name === "string" ? environment.name : task.environmentId,
    progress: steps.length > 0 ? Math.round((completedSteps / steps.length) * 100) : status === "success" ? 100 : 0,
    completedSteps,
    totalSteps: steps.length,
    startedAt: new Date(task.createdAt).toLocaleString(),
    duration: isTerminalStatus(status) ? "Finished" : "In progress",
    screenshots: task.artifacts.filter((artifact) => artifact.contentType.startsWith("image/")).length,
    retries: 0,
  };
}

function platformEventAsLog(event: PlatformRun["events"][number]): ReportLog {
  const failed = event.kind.includes("failed") || event.kind.includes("error");
  const completed = event.kind === "step.completed" || event.kind === "run.complete";
  const index = Number(event.data.index);
  const title = typeof event.data.title === "string" ? event.data.title : "Step";
  const message = typeof event.data.message === "string"
    ? event.data.message
    : event.kind === "step.started"
      ? "Step started"
      : event.kind === "step.completed"
        ? "Step completed"
        : event.kind === "run.complete"
          ? `Run ${event.data.status === "success" ? "passed" : "finished"}`
          : event.kind;
  return {
    id: String(event.id),
    time: eventTime(event.at),
    level: failed ? "error" : completed ? "success" : "info",
    step: Number.isFinite(index) ? `${index + 1}. ${title}` : "平台",
    message,
    duration: durationFromMilliseconds(event.data.durationMs),
  };
}

function platformContextFor(projectId: string) {
  const context = platformProjectContext(projectId);
  return context ? { session: context.session, platformProjectId: context.projectId } : undefined;
}

function reportRetryError(error: unknown) {
  if (error instanceof WorkerApiError && error.code === "RUN_SECRETS_REQUIRED") {
    message.info("此运行包含会话密钥，请从流程重新运行并重新注入密钥。");
    return true;
  }
  return false;
}
type ReportLog = {
  id: string;
  time: string;
  level: "success" | "error" | "info";
  step: string;
  message: string;
  duration: string;
};

function eventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function taskEventAsLog(
  event: WorkerTaskEvent,
  index: number,
  statusMeta: RunDetailPageProps["statusMeta"],
): ReportLog | undefined {
  const id = String(event.id ?? `${event.kind}-${index}`);
  if (event.kind === "log") {
    return {
      id,
      time: eventTime(event.at),
      level: event.data.level === "error" ? "error" : "info",
      step: "Worker",
      message: String(event.data.message ?? "Worker 已更新运行状态"),
      duration: "-",
    };
  }
  if (event.kind === "step") {
    const state = String(event.data.status ?? "running");
    return {
      id,
      time: eventTime(event.at),
      level: state === "failed" ? "error" : state === "success" ? "success" : "info",
      step: `${Number(event.data.index ?? 0) + 1}. ${String(event.data.title ?? "步骤")}`,
      message:
        state === "failed"
          ? String(event.data.error ?? "步骤执行失败")
          : state === "success"
            ? "步骤执行完成"
            : "开始执行步骤",
      duration: durationFromMilliseconds(event.data.durationMs),
    };
  }
  if (event.kind === "status") {
    const status = event.data.status as Run["status"];
    return {
      id,
      time: eventTime(event.at),
      level: status === "failed" ? "error" : status === "success" ? "success" : "info",
      step: "运行状态",
      message: Object.hasOwn(statusMeta, status) ? `状态变更为${statusMeta[status].label}` : "运行状态已更新",
      duration: "-",
    };
  }
  return undefined;
}

export default function RunDetailPage({ ProjectLayout, PageHeading, statusTag, statusMeta }: RunDetailPageProps) {
  const { projectId, runId } = useParams();
  const navigate = useNavigate();
  const canExecuteRun = canUseCapability("run.execute");
  const projects = useWorkspaceStore((state) => state.projects);
  const project = projectById(projects, projectId);
  const activeProjectId = project?.id;
  const apiRun = useRunStore((state) =>
    project ? state.apiRuns[project.id]?.find((item) => item.id === runId) : undefined,
  );
  const localRun = apiRun;
  const workerRun = isWorkerRunId(runId);
  const [activeLog, setActiveLog] = useState("all");
  const [workerTask, setWorkerTask] = useState<WorkerTask | null>(null);
  const [workerEvents, setWorkerEvents] = useState<WorkerTaskEvent[]>([]);
  const [workerError, setWorkerError] = useState(false);
  const [platformTask, setPlatformTask] = useState<PlatformRun | null>(null);
  const [platformError, setPlatformError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    if (!activeProjectId || !workerRun || !runId) return;
    setWorkerTask(null);
    setWorkerEvents([]);
    setWorkerError(false);
    let mounted = true;
    let pollingTimer: number | undefined;
    let unsubscribe: (() => void) | undefined;
    const stopPolling = () => {
      if (pollingTimer !== undefined) window.clearInterval(pollingTimer);
      pollingTimer = undefined;
    };
    const refresh = async () => {
      try {
        const task = await getRun(activeProjectId, runId);
        if (!mounted) return;
        setWorkerTask(task);
        setWorkerEvents((events) => {
          const byId = new Map(events.map((event) => [event.id, event]));
          for (const event of task.events ?? []) byId.set(event.id, event);
          return [...byId.values()].sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
        });
        setWorkerError(false);
        if (isTerminalStatus(task.status)) stopPolling();
      } catch {
        if (mounted) setWorkerError(true);
      }
    };
    const startPolling = () => {
      if (pollingTimer !== undefined) return;
      void refresh();
      pollingTimer = window.setInterval(() => void refresh(), 2_000);
    };
    void refresh();
    unsubscribe = subscribeToTask(
      activeProjectId,
      "runs",
      runId,
      (event) => {
        if (!mounted) return;
        setWorkerEvents((events) =>
          event.id !== undefined && events.some((item) => item.id === event.id)
            ? events
            : [...events, event],
        );
        if (event.kind === "status") {
          const status = event.data.status as Run["status"];
          setWorkerTask((task) => (task ? { ...task, status } : task));
          if (isTerminalStatus(status)) {
            void refresh();
            unsubscribe?.();
            stopPolling();
          }
        }
      },
      startPolling,
    );
    return () => {
      mounted = false;
      unsubscribe?.();
      stopPolling();
    };
  }, [activeProjectId, runId, workerRun]);

  useEffect(() => {
    if (!activeProjectId || workerRun || !runId) return;
    const context = platformContextFor(activeProjectId);
    if (!context) {
      setPlatformError(true);
      return;
    }
    setPlatformTask(null);
    setPlatformError(false);
    let mounted = true;
    let pollingTimer: number | undefined;
    const stopPolling = () => {
      if (pollingTimer !== undefined) window.clearInterval(pollingTimer);
      pollingTimer = undefined;
    };
    const refresh = async () => {
      try {
        const response = await getPlatformRun(context.session.token, context.platformProjectId, runId);
        if (!mounted) return;
        setPlatformTask(response.run);
        setPlatformError(false);
        const status = response.run.status === "dispatched" ? "running" : response.run.status;
        if (isTerminalStatus(status)) stopPolling();
      } catch {
        if (mounted) setPlatformError(true);
      }
    };
    void refresh();
    pollingTimer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      mounted = false;
      stopPolling();
    };
  }, [activeProjectId, runId, workerRun]);

  if (!project) return <Navigate to="/projects" replace />;
  if (!localRun && !workerRun && !platformContextFor(project.id)) {
    return <Navigate to={`/project/${project.id}/runs`} replace />;
  }
  const fallbackRun: Run = {
    id: runId ?? "",
    flowName: "正在加载运行详情",
    status: "queued",
    environment: "-",
    progress: 0,
    completedSteps: 0,
    totalSteps: 0,
    startedAt: "刚刚",
    duration: "排队中",
    screenshots: 0,
    retries: 0,
  };
  const baseRun = localRun ?? fallbackRun;
  const completedFromEvents = workerEvents.filter(
    (event) => event.kind === "step" && event.data.status === "success",
  ).length;
  const workerSummary = workerTask ? workerTaskAsRun(workerTask, baseRun) : undefined;
  const platformSummary = platformTask ? platformTaskAsRun(platformTask, baseRun) : undefined;
  const completedSteps = Math.max(workerSummary?.completedSteps ?? baseRun.completedSteps, completedFromEvents);
  const run = {
    ...(workerSummary ?? platformSummary ?? baseRun),
    completedSteps: workerRun ? completedSteps : platformSummary?.completedSteps ?? baseRun.completedSteps,
    progress:
      workerRun && (workerSummary ?? baseRun).totalSteps > 0
        ? Math.round((completedSteps / (workerSummary ?? baseRun).totalSteps) * 100)
        : (workerSummary ?? platformSummary ?? baseRun).progress,
  };
  const reportLogs: ReportLog[] = workerRun
    ? workerEvents
      .map((event, index) => taskEventAsLog(event, index, statusMeta))
      .filter((log): log is ReportLog => Boolean(log))
    : (platformTask?.events ?? []).map(platformEventAsLog);
  const logs = activeLog === "all" ? reportLogs : reportLogs.filter((log) => log.level === activeLog);
  const artifacts = workerRun ? workerTask?.artifacts ?? [] : platformTask?.artifacts ?? [];
  const error = workerRun
    ? typeof workerTask?.result?.error === "string" ? workerTask.result.error : undefined
    : typeof platformTask?.result?.error === "string" ? platformTask.result.error : undefined;
  const browserStateLabels = {
    queued: "等待队列",
    launching: "正在打开",
    running: "正在执行",
    waiting: "等待手动停止",
    closing: "正在关闭",
    closed: "已关闭",
  } as const;
  const browserState = workerTask?.browserState
    ? browserStateLabels[workerTask.browserState]
    : "等待 Worker";
  const retry = async () => {
    if (!workerRun) {
      const context = platformContextFor(project.id);
      if (!context || !runId) {
        message.error("Platform run is unavailable");
        return;
      }
      setRetrying(true);
      try {
        const prior = platformTask ?? (await getPlatformRun(context.session.token, context.platformProjectId, runId)).run;
        const flowId = (prior.snapshot.flow as { id?: unknown } | undefined)?.id;
        const created = prior.status === "success"
          ? await createPlatformRun(context.session.token, context.platformProjectId, {
              flowId: typeof flowId === "string" ? flowId : undefined,
              environmentId: prior.environmentId,
            })
          : await retryPlatformRun(context.session.token, context.platformProjectId, prior.id);
        const nextRunId = created.runIds[0];
        if (!nextRunId) throw new Error("PLATFORM_RUN_NOT_CREATED");
        message.success(prior.status === "success" ? "已按最新已发布版本创建新运行" : "已按原快照重新提交");
        navigate(`/project/${project.id}/runs/${nextRunId}`);
      } catch {
        message.error("重新提交平台运行失败");
      } finally {
        setRetrying(false);
      }
      return;
    }
    if (!workerRun || !runId) {
      message.error("该运行不是 Playwright Worker 创建的任务，无法重试。");
      return;
    }
    setRetrying(true);
    try {
      const { runId: retriedRunId } = await retryRun(project.id, runId);
      message.success("已重新提交给 Playwright Worker");
      navigate(`/project/${project.id}/runs/${retriedRunId}`);
    } catch (error) {
      if (!reportRetryError(error)) message.error("重新提交失败，请稍后重试");
    } finally {
      setRetrying(false);
    }
  };
  const cancel = async () => {
    if (!workerRun) {
      if (!runId) return;
      const context = platformContextFor(project.id);
      if (!context) {
        message.error("Platform session is unavailable");
        return;
      }
      setCanceling(true);
      try {
        const response = await cancelPlatformRun(context.session.token, context.platformProjectId, runId);
        setPlatformTask(response.run);
        message.info("已发送取消请求。");
      } catch {
        message.error("取消平台运行失败");
      } finally {
        setCanceling(false);
      }
      return;
    }
    if (!workerRun || !runId) return;
    setCanceling(true);
    try {
      const task = await cancelRun(project.id, runId);
      setWorkerTask(task);
      message.info("已停止运行并关闭浏览器窗口");
    } catch {
      message.error("停止运行失败，请稍后重试");
    } finally {
      setCanceling(false);
    }
  };
  return (
    <ProjectLayout project={project} section="runs">
      <div className="detail-back">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/project/${project.id}/runs`)}>
          运行中心
        </Button>
      </div>
      <PageHeading
        title={run.flowName}
        description={`${run.id} · ${run.environment} · ${run.startedAt}`}
        actions={
          <>
            {canExecuteRun && (
              <>
                {isTerminalStatus(run.status) && (
                  <Button icon={<ReloadOutlined />} loading={retrying} onClick={() => void retry()}>
                    {run.status === "success" ? "再次运行（新运行）" : "重试"}
                  </Button>
                )}
                {!isTerminalStatus(run.status) && (
                  <Button danger icon={<StopOutlined />} loading={canceling} onClick={() => void cancel()}>
                    停止运行
                  </Button>
                )}
              </>
            )}
            {statusTag(run.status)}
          </>
        }
      />
      {!workerRun && platformTask?.retryOfRunId && (
        <Alert
          type="info"
          showIcon
          message="重试自"
          description={(
            <button
              className="run-link"
              onClick={() => navigate(`/project/${project.id}/runs/${platformTask.retryOfRunId}`)}
            >
              查看源运行 {platformTask.retryOfRunId}
            </button>
          )}
        />
      )}
      {workerError && (
        <Alert
          className="worker-detail-alert"
          type="warning"
          showIcon
          title="Worker 状态暂时不可用"
          description="正在使用兼容轮询重试获取运行详情。"
        />
      )}
      {platformError && !workerRun && (
        <Alert
          className="worker-detail-alert"
          type="warning"
          showIcon
          title="平台运行详情暂时不可用"
          description="请确认当前浏览器仍登录到拥有该项目权限的平台工作空间。"
        />
      )}
      <section className="run-detail-grid">
        <div className="surface detail-main">
          <div className="report-summary">
            <div className={`report-state ${run.status}`}>
              <span>
                {run.status === "success" ? <CheckCircleFilled /> : run.status === "failed" ? <StopOutlined /> : <PlayCircleFilled />}
              </span>
              <div>
                <strong>{statusMeta[run.status].label}</strong>
                <small>执行耗时 {run.duration}</small>
              </div>
            </div>
            <div><Statistic title="已完成步骤" value={`${run.completedSteps}/${run.totalSteps}`} /></div>
            <div><Statistic title="截图" value={run.screenshots} /></div>
            <div><Statistic title="重试次数" value={run.retries} /></div>
            {workerTask && <div><Statistic title="浏览器" value={browserState} /></div>}
            {platformTask && <div><Statistic title="执行节点" value="部署机本机" /></div>}
            {workerTask?.queue?.position && (
              <div><Statistic title="队列位置" value={`第 ${workerTask.queue.position} 位`} /></div>
            )}
          </div>
          <div className="log-heading">
            <div>
              <h2>执行日志</h2>
              <span>来自 Worker 事件流</span>
            </div>
            <Select
              value={activeLog}
              onChange={setActiveLog}
              options={[
                { value: "all", label: "全部日志" },
                { value: "success", label: "成功" },
                { value: "error", label: "错误" },
                { value: "info", label: "信息" },
              ]}
            />
          </div>
          <div className="log-list">
            {logs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待 Worker 输出日志" />
            ) : logs.map((log) => (
              <div className={`log-row ${log.level}`} key={log.id}>
                <time>{log.time}</time>
                <span className="log-icon">
                  {log.level === "success" ? <CheckCircleFilled /> : log.level === "error" ? <StopOutlined /> : <ClockCircleOutlined />}
                </span>
                <div>
                  <strong>{log.step}</strong>
                  <p>{log.message}</p>
                </div>
                <span className="log-duration">{log.duration}</span>
              </div>
            ))}
          </div>
        </div>
        <aside className="detail-aside">
          <div className="surface artifact-card">
            <h2>产物</h2>
            {artifacts.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="产物生成中" />
            ) : artifacts.map((artifact) => {
              const isImage = artifact.contentType.startsWith("image/");
              const isTrace = artifact.contentType === "application/zip";
              return (
                <a
                  className="artifact-link"
                  key={artifact.id}
                  href={workerRun ? artifactUrl(project.id, artifact.id) : "#"}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    if (workerRun) return;
                    event.preventDefault();
                    const context = platformContextFor(project.id);
                    if (!context) {
                      message.error("平台登录已失效，无法下载产物");
                      return;
                    }
                    void fetchPlatformArtifact(context.session.token, artifact.id)
                      .then((blob) => {
                        const objectUrl = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = objectUrl;
                        link.download = artifact.name;
                        link.click();
                        URL.revokeObjectURL(objectUrl);
                      })
                      .catch(() => message.error("下载平台产物失败"));
                  }}
                >
                  <span className={`artifact-icon ${isImage ? "screenshot" : isTrace ? "trace" : "video"}`}>
                    {isImage ? <FileSearchOutlined /> : isTrace ? <ExperimentOutlined /> : <PlayCircleFilled />}
                  </span>
                  <span>
                    <strong>{artifact.name}</strong>
                    <small>{artifact.contentType}</small>
                  </span>
                  <DownOutlined />
                </a>
              );
            })}
          </div>
          {error && (
            <div className="surface error-card">
              <div><WarningFilled /><span>错误详情</span></div>
              <code>{error}</code>
              <p>请检查对应步骤的元素定位、变量值或等待条件。</p>
            </div>
          )}
          {!workerRun && platformTask?.flowOutputs.length ? (
            <div className="surface error-card">
              <div><FileSearchOutlined /><span>流程输出</span></div>
              {platformTask.flowOutputs.map((output) => (
                <code key={output.name}>{`${output.name}: ${output.value}`}</code>
              ))}
            </div>
          ) : null}
        </aside>
      </section>
    </ProjectLayout>
  );
}
