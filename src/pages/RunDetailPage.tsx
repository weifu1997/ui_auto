import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "../router";
import { VirtualList } from "../components/VirtualList";
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
import { useRunStore } from "../stores/run-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import {
  cancelPlatformRun,
  createPlatformAssertionReport,
  createPlatformRun,
  fetchPlatformArtifact,
  getPlatformRun,
  retryPlatformRun,
} from "../api/platform-api";
import type { PlatformRun } from "../api/platform-api";
import { platformProjectContext } from "../api/platform-context";
import { message } from "../lib/antd-feedback";
import type { Project, Run } from "../lib/mock-data";
import { canUseCapability, createRunDispatchKeyStore, nextRunDispatchKey, releaseRunDispatchKey, runIntentKey } from "./shared";

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

function platformTaskAsRun(task: PlatformRun, fallback?: Run): Run {
  const flow = task.snapshot.flow && typeof task.snapshot.flow === "object"
    ? task.snapshot.flow as Record<string, unknown>
    : {};
  const environment = task.snapshot.environment && typeof task.snapshot.environment === "object"
    ? task.snapshot.environment as Record<string, unknown>
    : {};
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  // 平台事件流中同时存在「step.completed」（新版本，规范命名）与「step.succeeded」
  // （旧版本 runner.py 兼容名），两者都表示该步骤已经完成，应该计入已完成步骤。
  const completedEvents = task.events.filter(
    (event) => event.kind === "step.completed" || event.kind === "step.succeeded"
  ).length;
  const status: Run["status"] = task.status === "dispatched" ? "running" : task.status;
  // 当 run 最终状态为 success 时，即使事件流中因异常（例如 runner 早期版本没写 step.completed）
  // 缺失完成事件，也应视为全步骤已完成，避免出现 0/9 通过的假象。
  const completedSteps = status === "success" ? steps.length : completedEvents;
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

// 断言结果契约（result.assertions 与 step.asserted 事件共用同一判定载荷）。
type AssertionRecord = {
  stepIndex: number;
  stepId: string;
  title: string;
  type: "visibility" | "text" | "count" | "attribute";
  passed: boolean;
  expected: string;
  actual: string;
};

const ASSERTION_TYPE_LABELS: Record<string, string> = {
  visibility: "可见性",
  text: "文本",
  count: "数量",
  attribute: "属性",
};

function assertionTypeLabel(type: string) {
  return ASSERTION_TYPE_LABELS[type] ?? type;
}

function runAssertions(run: Pick<PlatformRun, "result">): AssertionRecord[] {
  const raw = run.result?.assertions;
  if (!Array.isArray(raw)) return [];
  const records: AssertionRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (typeof value.passed !== "boolean") continue;
    records.push({
      stepIndex: Number(value.stepIndex) || 0,
      stepId: typeof value.stepId === "string" ? value.stepId : "",
      title: typeof value.title === "string" ? value.title : "断言",
      type: (value.type as AssertionRecord["type"]) ?? "text",
      passed: value.passed,
      expected: typeof value.expected === "string" ? value.expected : String(value.expected ?? ""),
      actual: typeof value.actual === "string" ? value.actual : String(value.actual ?? ""),
    });
  }
  return records;
}

function platformEventAsLog(event: PlatformRun["events"][number]): ReportLog {
  const isAsserted = event.kind === "step.asserted";
  const failed = isAsserted
    ? event.data.passed !== true
    : event.kind.includes("failed") || event.kind.includes("error");
  const isStepCompleted = event.kind === "step.completed" || event.kind === "step.succeeded";
  const completed = isStepCompleted || event.kind === "run.complete";
  const index = Number(event.data.index);
  const title = typeof event.data.title === "string" ? event.data.title : "Step";
  let message = typeof event.data.message === "string"
    ? event.data.message
    : event.kind === "step.started"
      ? "Step started"
      : isStepCompleted
        ? "Step completed"
        : event.kind === "run.complete"
          ? `Run ${event.data.status === "success" ? "passed" : "finished"}`
          : event.kind;
  if (isAsserted) {
    const expected = typeof event.data.expected === "string"
      ? event.data.expected
      : String(event.data.expected ?? "");
    const actual = typeof event.data.actual === "string"
      ? event.data.actual
      : String(event.data.actual ?? "");
    message = event.data.passed === true
      ? `断言通过：期望 ${expected}，实际 ${actual}`
      : `断言失败：期望 ${expected}，实际 ${actual}`;
  }
  return {
    id: String(event.id),
    time: eventTime(event.at),
    level: failed ? "error" : isAsserted || completed ? "success" : "info",
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
  if (error instanceof Error && error.message === "RUN_SECRETS_REQUIRED") {
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
  const [activeLog, setActiveLog] = useState("all");
  const [platformTask, setPlatformTask] = useState<PlatformRun | null>(null);
  const [platformError, setPlatformError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const runDispatchKeysRef = useRef(createRunDispatchKeyStore());
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    if (!activeProjectId || !runId) return;
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
  }, [activeProjectId, runId]);

  if (!project) return <Navigate to="/projects" replace />;
  if (!apiRun && !platformContextFor(project.id)) {
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
  const baseRun = apiRun ?? fallbackRun;
  const platformSummary = platformTask ? platformTaskAsRun(platformTask, baseRun) : undefined;
  const run = {
    ...(platformSummary ?? baseRun),
  };
  const reportLogs: ReportLog[] = (platformTask?.events ?? []).map(platformEventAsLog);
  const logs = activeLog === "all" ? reportLogs : reportLogs.filter((log) => log.level === activeLog);
  // 断言结果区块：读 run.result.assertions（无断言步骤的 run 不展示）。
  const assertions = platformTask ? runAssertions(platformTask) : [];
  const passedAssertions = assertions.filter((item) => item.passed).length;
  const artifacts = platformTask?.artifacts ?? [];
  const error = typeof platformTask?.result?.error === "string" ? platformTask.result.error : undefined;
  const securityDisabledMessage = (platformTask?.events ?? []).find((event) => event.kind === "run.security")
    ?.data?.message as string | undefined;
  // 三态显示：
  // 1) 还有在跑：写 "生成中…"（只有这个状态是真的在等待）
  // 2) 已结束但 artifacts=0：
  //    - 有 run.security 事件：这是敏感 run，系统禁用了截图和 Trace，没有任何文件可以下载 → 给出原因
  //    - 其他：明确说「本次运行未生成产物」（不是生成中，而是结束了就没文件）
  const runFinished = Boolean(
    platformTask
      && platformTask.status !== "queued"
      && platformTask.status !== "dispatched"
      && platformTask.status !== "running",
  );
  const emptyDescription: string = artifacts.length > 0 ? ""
    : !runFinished ? "产物生成中…"
      : securityDisabledMessage
        ? `因安全策略未生成产物：${securityDisabledMessage}`
        : platformTask?.status === "success"
          ? "本次运行未产生可下载的产物"
          : "运行未成功完成，无可下载产物";
  const retry = async () => {
    const context = platformContextFor(project.id);
    if (!context || !runId) {
      message.error("Platform run is unavailable");
      return;
    }
    setRetrying(true);
    let intent: string | undefined;
    try {
      const prior = platformTask ?? (await getPlatformRun(context.session.token, context.platformProjectId, runId)).run;
      const flowId = (prior.snapshot.flow as { id?: unknown } | undefined)?.id;
      let created;
      if (prior.status === "success") {
        if (typeof flowId !== "string" || !flowId) throw new Error("PLATFORM_FRESH_RUN_FLOW_REQUIRED");
        intent = runIntentKey({ projectId: context.platformProjectId, flowId });
        const dispatchKey = nextRunDispatchKey(runDispatchKeysRef.current, intent);
        created = await createPlatformRun(context.session.token, context.platformProjectId, {
          flowId,
          environmentId: prior.environmentId,
          dispatchKey,
        });
        releaseRunDispatchKey(runDispatchKeysRef.current, intent);
      } else {
        intent = runIntentKey({ projectId: context.platformProjectId, runId: prior.id });
        const dispatchKey = nextRunDispatchKey(runDispatchKeysRef.current, intent);
        created = await retryPlatformRun(context.session.token, context.platformProjectId, prior.id, dispatchKey);
        releaseRunDispatchKey(runDispatchKeysRef.current, intent);
      }
      const nextRunId = created.runIds[0];
      if (!nextRunId) throw new Error("PLATFORM_RUN_NOT_CREATED");
      message.success(prior.status === "success" ? "已按最新已发布版本创建新运行" : "已按原快照重新提交");
      navigate(`/project/${project.id}/runs/${nextRunId}`);
    } catch (error) {
      if (intent) releaseRunDispatchKey(runDispatchKeysRef.current, intent, error);
      if (!reportRetryError(error)) message.error("重新提交失败，请稍后重试");
    } finally {
      setRetrying(false);
    }
  };
  const cancel = async () => {
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
      message.error("停止运行失败，请稍后重试");
    } finally {
      setCanceling(false);
    }
  };
  // 导出断言报告：先请求生成（端点登记为 run artifact），再走既有产物下载链路。
  const exportAssertionReport = async (format: "json" | "xlsx") => {
    const context = platformContextFor(project.id);
    if (!context || !runId) {
      message.error("Platform session is unavailable");
      return;
    }
    try {
      const { artifact } = await createPlatformAssertionReport(
        context.session.token,
        context.platformProjectId,
        runId,
        format,
      );
      const blob = await fetchPlatformArtifact(context.session.token, artifact.id);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.name;
      link.click();
      URL.revokeObjectURL(objectUrl);
      message.success("断言报告已导出");
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      message.error(code === "RUN_HAS_NO_ASSERTIONS" ? "本次运行没有断言可导出" : "导出断言报告失败");
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
      {platformTask?.retryOfRunId && (
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
      {platformError && (
        <Alert
          className="platform-detail-alert"
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
            {platformTask && <div><Statistic title="执行节点" value="部署机本机" /></div>}
          </div>
          {assertions.length > 0 && (
            <div className="assertion-block">
              <div className="assertion-heading">
                <h2>断言结果</h2>
                <span>{passedAssertions}/{assertions.length} 通过</span>
                <div className="assertion-export">
                  <Button size="small" onClick={() => void exportAssertionReport("json")}>导出 JSON</Button>
                  <Button size="small" onClick={() => void exportAssertionReport("xlsx")}>导出 Excel</Button>
                </div>
              </div>
              <div className="assertion-list">
                {assertions.map((assertion) => (
                  <div
                    className={`assertion-row ${assertion.passed ? "passed" : "failed"}`}
                    key={`${assertion.stepId}-${assertion.stepIndex}`}
                  >
                    <span className="assertion-icon">
                      {assertion.passed ? <CheckCircleFilled /> : <StopOutlined />}
                    </span>
                    <div className="assertion-title">
                      <strong>{assertion.title}</strong>
                      <small>{assertionTypeLabel(assertion.type)}断言</small>
                    </div>
                    <div className="assertion-compare">
                      <span>期望 <code>{assertion.expected}</code></span>
                      <span>实际 <code>{assertion.actual}</code></span>
                    </div>
                    <span className={`assertion-verdict ${assertion.passed ? "passed" : "failed"}`}>
                      {assertion.passed ? "通过" : "失败"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="log-heading">
            <div>
              <h2>执行日志</h2>
                <span>来自 Platform 执行事件</span>
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
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待 Platform 输出日志" />
            ) : (
              <VirtualList
                items={logs}
                className="virtual-list-scroll"
                rowClassName={(log) => `log-row ${log.level}`}
                estimateSize={58}
                maxHeight={420}
                ariaLabel="执行日志"
                renderItem={(log) => (
                  <>
                    <time>{log.time}</time>
                    <span className="log-icon">
                      {log.level === "success" ? <CheckCircleFilled /> : log.level === "error" ? <StopOutlined /> : <ClockCircleOutlined />}
                    </span>
                    <div>
                      <strong>{log.step}</strong>
                      <p>{log.message}</p>
                    </div>
                    <span className="log-duration">{log.duration}</span>
                  </>
                )}
              />
            )}
          </div>
        </div>
        <aside className="detail-aside">
          <div className="surface artifact-card">
            <h2>产物</h2>
            {artifacts.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />
            ) : artifacts.map((artifact) => {
              const isImage = artifact.contentType.startsWith("image/");
              const isTrace = artifact.contentType === "application/zip";
              return (
                <a
                  className="artifact-link"
                  key={artifact.id}
                  href="#"
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
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
          {platformTask?.flowOutputs.length ? (
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
