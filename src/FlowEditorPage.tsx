import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "./router";
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CodeOutlined,
  DragOutlined,
  FileSearchOutlined,
  MoreOutlined,
  AudioOutlined,
  PlayCircleFilled,
  PlusOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Dropdown, Empty, Input, Modal, Select, Switch, Tooltip } from "antd";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useFlowStore } from "./flow-store";
import { useRunStore } from "./run-store";
import { useSecretStore } from "./secret-store";
import { useWorkspaceStore } from "./workspace-store";
import { message, modal } from "./antd-feedback";
import { localWorkerRunRequest } from "./local-worker-run";
import { PlatformApiError, cancelRecordingSession, createPlatformElementValidation, createPlatformRun, createRecordingSession, getRecordingEvents, getRecordingSession, getPlatformElementValidation, pauseRecordingSession, resumeRecordingSession, savePlatformSecret, stopRecordingSession } from "./platform-api";
import type { RecordingEvent, RecordingResult, RecordingSession } from "./platform-api";
import { platformProjectContext } from "./platform-context";
import { platformRunAsRun } from "./pages/shared";
import { createRun } from "./worker-api";
import { actionOptions } from "./mock-data";
import type { ElementAsset, Environment, Flow, FlowStep, Project, Variable } from "./mock-data";

const emptyFlows: Flow[] = [];
const emptyElements: ElementAsset[] = [];
const emptyVariables: Variable[] = [];
const emptyEnvironments: Environment[] = [];
const emptySecretValues: Record<string, string> = {};

function projectById(projects: Project[], id?: string) {
  return projects.find((project) => project.id === id);
}

function variableReference(variable: Variable) {
  return `${variable.scope === "环境" ? "env" : "project"}.${variable.name}`;
}

function requiredSecretVariables(variables: Variable[], steps: FlowStep[]) {
  return variables.filter((variable) => {
    if (!variable.secret || (variable.scope !== "环境" && variable.scope !== "项目")) return false;
    const reference = variableReference(variable).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = new RegExp(`{{\\s*${reference}\\s*}}`);
    return steps.some((step) => token.test(step.value));
  });
}

function requestRunSecrets(
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

export default function FlowEditorPage() {
  const { projectId, flowId } = useParams();
  const navigate = useNavigate();
  const projects = useWorkspaceStore((state) => state.projects);
  const project = projectById(projects, projectId);
  const storedFlows = useWorkspaceStore(
    (state) => (project ? state.flowsByProject[project.id] : undefined),
  );
  const storedElements = useWorkspaceStore(
    (state) => (project ? state.elementsByProject[project.id] : undefined),
  );
  const storedVariables = useWorkspaceStore(
    (state) => (project ? state.variablesByProject[project.id] : undefined),
  );
  const storedEnvironments = useWorkspaceStore(
    (state) => (project ? state.environmentsByProject[project.id] : undefined),
  );
  const activeEnvironmentId = useWorkspaceStore(
    (state) => (project ? state.activeEnvironmentByProject[project.id] : undefined),
  );
  const setFlows = useWorkspaceStore((state) => state.setFlows);
  const setElements = useWorkspaceStore((state) => state.setElements);
  const flow = project
    ? (storedFlows ?? emptyFlows).find((item) => item.id === flowId)
    : undefined;
  const flowDefinition = flow?.definition;
  const {
    steps,
    selectedStepId,
    setSelectedStep,
    updateStep,
    addStep,
    removeStep,
    moveStep,
    loadSteps,
    importRecordingSteps,
    isDirty,
    markSaved,
  } = useFlowStore();
  const [runToStep, setRunToStep] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [recordingSession, setRecordingSession] = useState<RecordingSession | null>(null);
  const [recordingResult, setRecordingResult] = useState<RecordingResult | null>(null);
  const [recordingStartUrl, setRecordingStartUrl] = useState("");
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingSecretMap, setRecordingSecretMap] = useState<Record<string, string>>({});
  const [recordingEnvironmentId, setRecordingEnvironmentId] = useState(activeEnvironmentId ?? "");
  const [recordingFreshLogin, setRecordingFreshLogin] = useState(false);
  const [recordingEvents, setRecordingEvents] = useState<RecordingEvent[]>([]);
  const [recordingImportBusy, setRecordingImportBusy] = useState(false);
  const recordingPollRef = useRef<number | undefined>(undefined);
  const recordingLastSeqRef = useRef(0);
  const recordingPollInFlightRef = useRef(false);
  const recordingRestoreInFlightRef = useRef(false);
  const selectedStep =
    steps.find((step) => step.id === selectedStepId) ?? steps[0];
  const elements = storedElements ?? emptyElements;
  const variables = storedVariables ?? emptyVariables;
  const environments = storedEnvironments ?? emptyEnvironments;
  const activeEnvironment =
    environments.find((environment) => environment.id === activeEnvironmentId) ??
    environments[0];
  const recordingEnvironment =
    environments.find((environment) => environment.id === recordingEnvironmentId) ??
    activeEnvironment;
  const platformContext = project ? platformProjectContext(project.id) : undefined;
  const upsertRun = useRunStore((state) => state.upsertRun);
  const sessionSecretValues = useSecretStore((state) =>
    project ? state.valuesByProject[project.id] ?? emptySecretValues : emptySecretValues,
  );
  const setSecretValues = useSecretStore((state) => state.setValues);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  useEffect(() => {
    if (flowId) loadSteps(flowDefinition ?? []);
  }, [flowDefinition, flowId, loadSteps]);

  useEffect(() => () => {
    if (recordingPollRef.current !== undefined) {
      window.clearInterval(recordingPollRef.current);
    }
  }, []);

  const recordingStorageKey = project && flow
    ? `autoflow-recording-session:${project.id}:${flow.id}`
    : "";
  const clearRecordingStorage = useCallback(() => {
    if (recordingStorageKey) window.sessionStorage.removeItem(recordingStorageKey);
  }, [recordingStorageKey]);
  const clearRecordingPoll = useCallback(() => {
    if (recordingPollRef.current !== undefined) {
      window.clearInterval(recordingPollRef.current);
      recordingPollRef.current = undefined;
    }
  }, []);
  const pollRecording = useCallback(async (sessionId: string) => {
    if (!platformContext || recordingPollInFlightRef.current) return;
    recordingPollInFlightRef.current = true;
    try {
      let cursor = recordingLastSeqRef.current;
      let hasMore = true;
      while (hasMore) {
        const page = await getRecordingEvents(
          platformContext.session.token,
          platformContext.projectId,
          sessionId,
          cursor,
          100,
        );
        setRecordingEvents((current) => {
          const bySeq = new Map(current.map((event) => [event.seq, event]));
          for (const event of page.events) bySeq.set(event.seq, event);
          return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
        });
        const pageSeq = page.events.reduce((max, event) => Math.max(max, event.seq), cursor);
        cursor = pageSeq;
        recordingLastSeqRef.current = cursor;
        hasMore = page.hasMore;
      }
      const detail = await getRecordingSession(
        platformContext.session.token,
        platformContext.projectId,
        sessionId,
      );
      setRecordingSession(detail.session);
      if (["stopped", "canceled", "expired", "failed"].includes(detail.session.status)) {
        clearRecordingPoll();
        clearRecordingStorage();
      }
    } catch {
      // Keep the cursor; a transient failure is retried by the next tick.
    } finally {
      recordingPollInFlightRef.current = false;
    }
  }, [clearRecordingPoll, clearRecordingStorage, platformContext]);
  const startRecordingPoll = useCallback((sessionId: string) => {
    clearRecordingPoll();
    void pollRecording(sessionId);
    recordingPollRef.current = window.setInterval(() => void pollRecording(sessionId), 1000);
  }, [clearRecordingPoll, pollRecording]);

  useEffect(() => {
    if (!platformContext || !recordingStorageKey || recordingSession || recordingRestoreInFlightRef.current) return;
    const recoveredId = window.sessionStorage.getItem(recordingStorageKey);
    if (!recoveredId) return;
    recordingRestoreInFlightRef.current = true;
    void getRecordingSession(
      platformContext.session.token,
      platformContext.projectId,
      recoveredId,
    ).then(({ session }) => {
      setRecordingSession(session);
      recordingLastSeqRef.current = session.lastSeq;
      if (["stopped", "canceled", "expired", "failed"].includes(session.status)) {
        clearRecordingStorage();
        return;
      }
      startRecordingPoll(session.id);
    }).catch(() => {
      clearRecordingStorage();
    }).finally(() => {
      recordingRestoreInFlightRef.current = false;
    });
  }, [clearRecordingStorage, platformContext, recordingSession, recordingStorageKey, startRecordingPoll]);

  if (!project || !flow) {
    return <Navigate to={project ? `/project/${project.id}/flows` : "/projects"} replace />;
  }
  const startRecording = async () => {
    if (!platformContext || !recordingEnvironment) {
      message.error("当前项目没有可用的平台环境");
      return;
    }
    setRecordingBusy(true);
    try {
      const created = await createRecordingSession(
        platformContext.session.token,
        platformContext.projectId,
        {
          flowId: flow.id,
          environmentId: recordingEnvironment.id,
          startUrl: recordingStartUrl || recordingEnvironment.baseUrl,
          freshLogin: recordingFreshLogin,
        },
      );
      setRecordingSession(created.session);
      setRecordingEnvironmentId(created.session.environmentId);
      window.sessionStorage.setItem(recordingStorageKey, created.session.id);
      setRecordingOpen(false);
      recordingLastSeqRef.current = 0;
      setRecordingEvents([]);
      message.success("录制已开始");
      startRecordingPoll(created.session.id);
    } catch (error) {
      if (error instanceof PlatformApiError && error.code === "RECORDING_SESSION_ACTIVE") {
        message.error("当前环境已有录制会话");
      } else {
        message.error("开始录制失败，请检查环境与浏览器服务");
      }
    } finally {
      setRecordingBusy(false);
    }
  };

  const stopRecording = async () => {
    if (!platformContext || !recordingSession) return;
    setRecordingBusy(true);
    try {
      const stopped = await stopRecordingSession(
        platformContext.session.token,
        platformContext.projectId,
        recordingSession.id,
      );
      clearRecordingPoll();
      setRecordingSession(stopped.session);
      setRecordingResult(stopped.result);
      setRecordingSecretMap({});
      clearRecordingStorage();
    } catch {
      message.error("停止录制失败，请稍后重试");
    } finally {
      setRecordingBusy(false);
    }
  };

  const cancelRecording = async () => {
    if (!platformContext || !recordingSession) return;
    setRecordingBusy(true);
    try {
      await cancelRecordingSession(
        platformContext.session.token,
        platformContext.projectId,
        recordingSession.id,
      );
      clearRecordingPoll();
      setRecordingSession(null);
      setRecordingResult(null);
      setRecordingEvents([]);
      clearRecordingStorage();
      message.info("录制已取消");
    } catch {
      message.error("取消录制失败，请稍后重试");
    } finally {
      setRecordingBusy(false);
    }
  };

  const verifyRecordingElements = async (assets: ElementAsset[]) => {
    if (!platformContext || !recordingEnvironment) return false;
    const seen = new Set<string>();
    for (const asset of assets) {
      const key = `${asset.environment}\u0000${asset.path}\u0000${asset.method}\u0000${asset.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const created = await createPlatformElementValidation(
        platformContext.session.token,
        platformContext.projectId,
        { environmentId: recordingEnvironment.id, element: asset },
      );
      let validation = created.validation;
      for (let attempt = 0; attempt < 60 && (validation.status === "queued" || validation.status === "running"); attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        validation = (await getPlatformElementValidation(
          platformContext.session.token,
          platformContext.projectId,
          validation.id,
        )).validation;
      }
      if (validation.status !== "success" || Number(validation.result?.count ?? 0) !== 1) {
        return false;
      }
    }
    return true;
  };

  const importRecordedFlow = async () => {
    if (!recordingResult || !project || !recordingEnvironment) return;
    const unresolved = recordingResult.requiredBindings.filter(
      (binding) => !recordingSecretMap[binding.stepId],
    );
    if (unresolved.length > 0) {
      message.error("请先为所有敏感输入绑定 secret 变量");
      return;
    }
    const existingNames = new Set(elements.map((element) => element.name));
    const nameMap: Record<string, string> = {};
    const newElements: ElementAsset[] = [];
    for (const [index, raw] of recordingResult.elements.entries()) {
      const rawName = String(raw.name ?? `录制元素 ${index + 1}`);
      const path = String(raw.path ?? "/");
      const method = String(raw.method ?? "css");
      const value = String(raw.value ?? "");
      const existing = elements.find(
        (element) =>
          element.environment === recordingEnvironment.id &&
          element.path === path &&
          element.method === method &&
          element.value === value,
      );
      if (existing) {
        nameMap[rawName] = existing.name;
        continue;
      }
      const name = existingNames.has(rawName) ? `${rawName} ${Date.now()}` : rawName;
      existingNames.add(name);
      nameMap[rawName] = name;
      newElements.push({
        id: `rec-el-${Date.now()}-${index}`,
        name,
        path,
        method,
        value,
        environment: recordingEnvironment.id,
        description: "",
        validation: "unverified" as const,
        updatedAt: "刚刚",
      });
    }
    const importedSteps: FlowStep[] = recordingResult.steps.map((raw, index) => {
      const rawId = String(raw.id ?? `rec-step-${index}`);
      const bound = recordingSecretMap[rawId];
      const rawElement = raw.element ? String(raw.element) : undefined;
      return {
        id: `step-${Date.now()}-${index}`,
        title: String(raw.title ?? raw.action ?? "录制步骤"),
        action: String(raw.action ?? "点击"),
        element: rawElement ? nameMap[rawElement] ?? rawElement : undefined,
        value: bound ? `{{${bound}}}` : String(raw.value ?? ""),
        timeout: 10,
        failurePolicy: "立即失败",
        status: "pending" as const,
      };
    });
    setRecordingImportBusy(true);
    try {
      const unique = await verifyRecordingElements([
        ...newElements,
        ...elements.filter((element) => Object.values(nameMap).includes(element.name)),
      ]);
      if (!unique) {
        message.error("存在未唯一匹配的定位器，未导入任何步骤或元素");
        return;
      }
      setElements(project.id, [...elements, ...newElements]);
      importRecordingSteps(importedSteps);
    } finally {
      setRecordingImportBusy(false);
    }
    setRecordingResult(null);
    setRecordingSession(null);
    setRecordingEvents([]);
    clearRecordingStorage();
    message.success("录制步骤已追加到流程草稿，请保存后发布");
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = steps.findIndex((step) => step.id === active.id);
    const to = steps.findIndex((step) => step.id === over.id);
    if (from >= 0 && to >= 0) moveStep(from, to);
  };
  const goBack = () => {
    if (isDirty)
      modal.confirm({
        title: "放弃未保存的修改？",
        content: "当前编排器草稿尚未保存。",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: () => {
          loadSteps(flow.definition ?? []);
          navigate(`/project/${project.id}/flows`);
        },
      });
    else navigate(`/project/${project.id}/flows`);
  };
  const saveFlow = () => {
    setFlows(
      project.id,
      (storedFlows ?? emptyFlows).map((item) =>
        item.id === flow.id
          ? {
              ...item,
              steps: steps.length,
              definition: steps.map((step) => ({ ...step })),
              updatedAt: "刚刚",
            }
          : item,
      ),
    );
    markSaved();
    message.success("流程已保存");
  };
  const run = async (upToStepId?: string) => {
    if (steps.length === 0) {
      message.error("请先添加并保存至少一个流程步骤。");
      return;
    }
    if (isDirty) {
      message.warning("请先保存流程草稿，再发布并执行。");
      return;
    }
    setRunToStep(true);
    const environment = activeEnvironment;
    if (!environment) {
      setRunToStep(false);
      message.error("当前项目没有可用运行环境");
      return;
    }
    const stepsToRun = upToStepId
      ? steps.slice(0, steps.findIndex((step) => step.id === upToStepId) + 1)
      : steps;
    const secretValues = await requestRunSecrets(
      project.id,
      variables,
      stepsToRun,
      sessionSecretValues,
      setSecretValues,
    );
    if (!secretValues) {
      setRunToStep(false);
      return;
    }
    const platformContext = platformProjectContext(project.id);
    if (platformContext) {
      try {
        for (const variable of requiredSecretVariables(variables, stepsToRun)) {
          const value = secretValues[variable.id];
          if (value) await savePlatformSecret(platformContext.session.token, platformContext.projectId, { name: variableReference(variable), value });
        }
        const result = await createPlatformRun(platformContext.session.token, platformContext.projectId, { flowId: flow.id, environmentId: environment.id, upToStepId });
        result.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
        message.success(`已创建 ${result.runIds.length} 个运行（部署机执行）`);
        if (result.runIds[0]) navigate(`/project/${project.id}/runs/${result.runIds[0]}`);
      } catch (error) {
        if (error instanceof PlatformApiError && error.code === "PUBLISHED_REVISION_REQUIRED") {
          message.error("该流程还没有已发布版本，请先保存流程");
        } else {
          message.error("创建平台运行失败，请检查执行服务与运行环境");
        }
      } finally {
        setRunToStep(false);
      }
      return;
    }
    try {
      const request = localWorkerRunRequest({
        environment,
        flow: { id: flow.id, name: flow.name },
        steps,
        elements,
        variables,
        secretValues,
        secretVariables: requiredSecretVariables(variables, stepsToRun),
        upToStepId,
      });
      const { runId } = await createRun(project.id, request);
      const totalSteps = upToStepId
        ? steps.findIndex((step) => step.id === upToStepId) + 1
        : steps.length;
      upsertRun(project.id, {
        id: runId,
        flowName: flow.name,
        status: "queued",
        environment: environment.name,
        progress: 0,
        completedSteps: 0,
        totalSteps,
        startedAt: "刚刚",
        duration: "排队中",
        screenshots: 0,
        retries: 0,
        request,
      });
      navigate(`/project/${project.id}/runs/${runId}`);
    } catch {
      message.error("本机 Playwright Worker 不可用，请先运行 npm run server 后重试。");
    } finally {
      setRunToStep(false);
    }
    return;
  };
  return (
    <div className="editor-page">
      <header className="editor-topbar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={goBack}>
          流程
        </Button>
        <span className="editor-divider" />
        <div className="editor-title">
          <strong>{flow.name}</strong>
          <span>{isDirty ? "未保存修改" : "已保存"}</span>
        </div>
        <div className="editor-actions">
          {recordingSession && !["stopped", "canceled", "expired", "failed"].includes(recordingSession.status) ? (
            <>
              {recordingSession.status === "paused" ? (
                <Button
                  icon={<AudioOutlined />}
                  loading={recordingBusy}
                  onClick={() => {
                    if (!platformContext) return;
                    setRecordingBusy(true);
                    void resumeRecordingSession(platformContext.session.token, platformContext.projectId, recordingSession.id)
                      .then(({ session }) => setRecordingSession(session))
                      .catch(() => message.error("继续录制失败，请稍后重试"))
                      .finally(() => setRecordingBusy(false));
                  }}
                >
                  继续录制
                </Button>
              ) : (
                <Button
                  icon={<AudioOutlined />}
                  loading={recordingBusy}
                  onClick={() => {
                    if (!platformContext) return;
                    setRecordingBusy(true);
                    void pauseRecordingSession(platformContext.session.token, platformContext.projectId, recordingSession.id)
                      .then(({ session }) => setRecordingSession(session))
                      .catch(() => message.error("暂停录制失败，请稍后重试"))
                      .finally(() => setRecordingBusy(false));
                  }}
                >
                  暂停录制
                </Button>
              )}
              <Button icon={<StopOutlined />} loading={recordingBusy} onClick={() => void stopRecording()}>
                停止录制
              </Button>
              <Button danger icon={<StopOutlined />} loading={recordingBusy} onClick={() => void cancelRecording()}>
                取消录制
              </Button>
            </>
          ) : platformContext && recordingEnvironment ? (
            <Button
              icon={<AudioOutlined />}
              onClick={() => {
                setRecordingEnvironmentId(activeEnvironment?.id ?? environments[0]?.id ?? "");
                setRecordingOpen(true);
              }}
            >
              录制
            </Button>
          ) : null}
          {recordingSession && ["stopped", "canceled", "expired", "failed"].includes(recordingSession.status) && (
            <span className="recording-status" aria-live="polite">
              录制{recordingSession.status === "stopped" ? "已停止" : recordingSession.status === "expired" ? "已过期" : recordingSession.status === "failed" ? "失败" : "已取消"}
              {recordingSession.environmentId ? ` · ${environments.find((item) => item.id === recordingSession.environmentId)?.name ?? recordingSession.environmentId}` : ""}
              {recordingSession.currentUrl ? ` · ${recordingSession.currentUrl}` : ""}
            </span>
          )}
          <Button icon={<PlayCircleFilled />} loading={runToStep} onClick={() => run()}>
            运行整个流程
          </Button>
          <Button
            type="primary"
            icon={<CheckCircleFilled />}
            disabled={!isDirty}
            onClick={saveFlow}
          >
            保存
          </Button>
        </div>
      </header>
      <main className="editor-workbench">
        <section className="steps-pane">
          <div className="pane-header">
            <div>
              <span className="eyebrow">编排</span>
              <h2>步骤</h2>
            </div>
            <Tooltip title="添加步骤">
              <Button
                type="text"
                icon={<PlusOutlined />}
                aria-label="新增步骤"
                onClick={() => addStep()}
              />
            </Tooltip>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={steps.map((step) => step.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="step-list">
                {steps.map((step, index) => (
                  <SortableStep
                    key={step.id}
                    step={step}
                    index={index}
                    isSelected={step.id === selectedStep?.id}
                    total={steps.length}
                    onSelect={() => setSelectedStep(step.id)}
                    onMove={moveStep}
                    onRemove={removeStep}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          <Button
            className="add-step"
            icon={<PlusOutlined />}
            onClick={() => addStep()}
          >
            添加步骤
          </Button>
        </section>
        <section className="step-editor">
          <div className="pane-header">
            <div>
              <span className="eyebrow">
                步骤{" "}
                {steps.findIndex((item) => item.id === selectedStep?.id) + 1}
              </span>
              <h2>{selectedStep?.title}</h2>
            </div>
            {selectedStep && (
              <Dropdown
                menu={{
                  items: [
                    {
                      key: "delete",
                      label: "删除步骤",
                      danger: true,
                      onClick: () => removeStep(selectedStep.id),
                    },
                  ],
                }}
              >
                <Button type="text" icon={<MoreOutlined />} aria-label={`步骤 ${selectedStep?.title} 操作`} />
              </Dropdown>
            )}
          </div>
          {selectedStep ? (
            <StepForm
              step={selectedStep}
              elements={elements}
              onChange={updateStep}
              onRunToHere={() => run(selectedStep.id)}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧添加一个步骤开始编排" />
          )}
        </section>
        <aside className="resource-pane">
          <div className="pane-header">
            <div>
              <span className="eyebrow">资源</span>
              <h2>元素与变量</h2>
            </div>
            <Button
              type="text"
              icon={<PlusOutlined />}
              aria-label="前往元素库"
              onClick={() => navigate(`/project/${project.id}/elements`)}
            />
          </div>
          <Input
            className="resource-search"
            prefix={<SearchOutlined />}
            placeholder="搜索资源"
          />
          <div className="resource-group">
            <div className="resource-group-title">
              <FileSearchOutlined /> 元素 <span>{elements.length}</span>
            </div>
            {elements.slice(0, 5).map((element) => (
              <button
                key={element.id}
                className="resource-row"
                onClick={() => updateStep({ element: element.name })}
              >
                <span className="resource-icon element">
                  <FileSearchOutlined />
                </span>
                <span>
                  <strong>{element.name}</strong>
                  <small>
                    {element.method}: {element.value}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <div className="resource-group">
            <div className="resource-group-title">
              <CodeOutlined /> 变量 <span>{variables.length}</span>
            </div>
            {variables.slice(0, 5).map((variable) => {
              const prefix =
                variable.scope === "环境"
                  ? "env"
                  : variable.scope === "内置"
                    ? "run"
                    : "project";
              const reference = `{{${prefix}.${variable.name}}}`;
              return (
                <button
                  key={variable.id}
                  className="resource-row"
                  onClick={() => updateStep({ value: reference })}
                >
                  <span className="resource-icon variable">
                    {variable.scope.slice(0, 1)}
                  </span>
                  <span>
                    <strong>{variable.name}</strong>
                    <small>{reference}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="stability-tip">
            <SafetyCertificateOutlined />
            <p>
              <strong>定位稳定性</strong>当前流程优先使用 <code>testid</code> 与{" "}
              <code>role</code> 元素。
            </p>
          </div>
        </aside>
      </main>

      <Modal
        title="开始录制"
        open={recordingOpen}
        onCancel={() => setRecordingOpen(false)}
        onOk={() => void startRecording()}
        confirmLoading={recordingBusy}
        okText="开始录制"
      >
        <div className="recording-form">
          <label>
            <span>环境</span>
            <Select
              aria-label="录制环境"
              value={recordingEnvironment?.id}
              options={environments.map((environment) => ({
                value: environment.id,
                label: environment.name,
              }))}
              onChange={(value) => setRecordingEnvironmentId(value)}
            />
          </label>
          <label>
            <span>起始 URL</span>
            <Input
              aria-label="录制起始 URL"
              value={recordingStartUrl}
              onChange={(event) => setRecordingStartUrl(event.target.value)}
              placeholder={activeEnvironment?.baseUrl ?? "/"}
            />
          </label>
          <Checkbox
            checked={recordingFreshLogin}
            onChange={(event) => setRecordingFreshLogin(event.target.checked)}
          >
            从头录制（不使用已有登录态）
          </Checkbox>
        </div>
      </Modal>

      <Modal
        title="录制结果"
        open={Boolean(recordingResult)}
        onCancel={() => {
          setRecordingResult(null);
          setRecordingSession(null);
          setRecordingEvents([]);
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setRecordingResult(null);
              setRecordingSession(null);
              setRecordingEvents([]);
            }}
          >取消</Button>,
          <Button
            key="import"
            type="primary"
            disabled={Boolean(recordingResult?.requiredBindings.some((binding) => !recordingSecretMap[binding.stepId]))}
            loading={recordingImportBusy}
            onClick={() => void importRecordedFlow()}
          >
            确认导入
          </Button>,
        ]}
      >
        {recordingResult && (
          <div className="recording-result">
            <p>共录制 {recordingResult.steps.length} 步，{recordingResult.elements.length} 个元素；已收到 {recordingEvents.length} 个事件。</p>
            <ol>
              {recordingResult.steps.map((step, index) => (
                <li key={String(step.id ?? index)}>{String(step.title ?? step.action ?? "录制步骤")} {step.element ? ` · ${String(step.element)}` : ""}</li>
              ))}
            </ol>
            <ul>
              {recordingResult.elements.map((element, index) => (
                <li key={String(element.id ?? index)}>
                  {String(element.name ?? `元素 ${index + 1}`)}：{String(element.method ?? "css")}={String(element.value ?? "")}
                  {element.matchCount !== undefined ? `（匹配 ${String(element.matchCount)} 个）` : "（待校验）"}
                </li>
              ))}
            </ul>
            {recordingResult.warnings.length > 0 && (
              <ul>
                {recordingResult.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
            {recordingResult.requiredBindings.length > 0 && (
              <div className="recording-bindings">
                <p>以下敏感输入必须绑定现有 secret 变量后才能导入：</p>
                {recordingResult.requiredBindings.map((binding) => (
                  <label key={binding.stepId}>
                    <span>{binding.fieldHint}</span>
                    <Select
                      aria-label={`绑定 ${binding.fieldHint}`}
                      placeholder="选择 secret 变量"
                      value={recordingSecretMap[binding.stepId]}
                      onChange={(value) => setRecordingSecretMap((current) => ({ ...current, [binding.stepId]: value }))}
                      options={variables
                        .filter((variable) => variable.secret)
                        .map((variable) => ({ value: variableReference(variable), label: variable.name }))}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function SortableStep({
  step,
  index,
  total,
  isSelected,
  onSelect,
  onMove,
  onRemove,
}: {
  step: FlowStep;
  index: number;
  total: number;
  isSelected: boolean;
  onSelect: () => void;
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: step.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`step-item ${isSelected ? "selected" : ""} ${
        isDragging ? "dragging" : ""
      }`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      role="button"
      tabIndex={0}
    >
      <span className="step-index">{index + 1}</span>
      <button
        className="step-drag-handle"
        type="button"
        aria-label={`拖拽排序：${step.title}`}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <DragOutlined />
      </button>
      <span className={`step-kind ${step.status}`}>
        <PlayCircleFilled />
      </span>
      <span className="step-copy">
        <strong>{step.title}</strong>
        <small>{step.action}</small>
      </span>
      <Dropdown
        menu={{
          items: [
            {
              key: "up",
              label: "上移",
              disabled: index === 0,
              onClick: () => onMove(index, index - 1),
            },
            {
              key: "down",
              label: "下移",
              disabled: index === total - 1,
              onClick: () => onMove(index, index + 1),
            },
            {
              key: "delete",
              label: "删除步骤",
              danger: true,
              onClick: () => onRemove(step.id),
            },
          ],
        }}
        trigger={["click"]}
      >
        <Button
          type="text"
          icon={<MoreOutlined />}
          aria-label={`步骤 ${step.title} 操作`}
          onClick={(event) => event.stopPropagation()}
        />
      </Dropdown>
    </div>
  );
}

function StepForm({
  step,
  elements,
  onChange,
  onRunToHere,
}: {
  step: FlowStep;
  elements: ElementAsset[];
  onChange: (patch: Partial<FlowStep>) => void;
  onRunToHere: () => void;
}) {
  return (
    <div className="step-form">
      <label>
        <span>动作</span>
        <Select
          value={step.action}
          options={actionOptions.map((value) => ({ value }))}
          onChange={(action) => onChange({ action, title: action })}
        />
      </label>
      {!["打开页面", "等待", "截图"].includes(step.action) && (
        <label>
          <span>元素</span>
          <Select
            value={step.element}
            showSearch
            optionFilterProp="label"
            placeholder="选择元素"
            options={elements.map((element) => ({
              value: element.name,
              label: element.name,
            }))}
            onChange={(element) => onChange({ element })}
          />
        </label>
      )}
      <label>
        <span>
          {step.action === "打开页面"
            ? "页面路径"
            : step.action.includes("断言")
              ? "期望值"
              : step.action === "等待"
                ? "等待时长"
                : "参数"}
        </span>
        <Input
          value={step.value}
          onChange={(event) => onChange({ value: event.target.value })}
          placeholder="支持 {{env.baseUrl}}、{{project.username}} 等变量引用"
        />
      </label>
      <div className="form-row">
        <label>
          <span>超时（秒）</span>
          <Input
            value={step.timeout}
            type="number"
            onChange={(event) =>
              onChange({ timeout: Number(event.target.value) })
            }
          />
        </label>
        <label>
          <span>失败策略</span>
          <Select
            value={step.failurePolicy}
            options={["立即失败", "继续执行", "重试 1 次"].map((value) => ({
              value,
            }))}
            onChange={(failurePolicy) => onChange({ failurePolicy })}
          />
        </label>
      </div>
      <div className="step-output-config">
        <label>
          <span>保存流程输出</span>
          <Switch
            size="small"
            checked={Boolean(step.output)}
            onChange={(checked) => onChange(checked
              ? { output: "output", outputSource: "text", outputPublic: false }
              : { output: undefined, outputSource: undefined, outputAttribute: undefined, outputParameter: undefined, responseUrl: undefined, outputPath: undefined, outputPublic: undefined })}
          />
        </label>
        {step.output && (
          <>
            <label>
              <span>输出变量名</span>
              <Input value={step.output} onChange={(event) => onChange({ output: event.target.value })} placeholder="例如 orderId" />
            </label>
            <label>
              <span>提取来源</span>
              <Select
                value={step.outputSource ?? "text"}
                options={[
                  { value: "text", label: "元素文本" },
                  { value: "attribute", label: "元素属性" },
                  { value: "url", label: "当前 URL 参数" },
                  { value: "response", label: "JSON 响应" },
                ]}
                onChange={(outputSource) => onChange({ outputSource })}
              />
            </label>
            {step.outputSource === "attribute" && <label><span>属性名</span><Input value={step.outputAttribute ?? "value"} onChange={(event) => onChange({ outputAttribute: event.target.value })} /></label>}
            {step.outputSource === "url" && <label><span>URL 参数名</span><Input value={step.outputParameter ?? step.output} onChange={(event) => onChange({ outputParameter: event.target.value })} /></label>}
            {step.outputSource === "response" && <><label><span>响应地址包含</span><Input value={step.responseUrl ?? ""} onChange={(event) => onChange({ responseUrl: event.target.value })} /></label><label><span>JSON 路径</span><Input value={step.outputPath ?? step.output} onChange={(event) => onChange({ outputPath: event.target.value })} /></label></>}
            <label>
              <span>可在报告中显示</span>
              <Switch size="small" checked={step.outputPublic === true} onChange={(outputPublic) => onChange({ outputPublic })} />
            </label>
          </>
        )}
      </div>
      <div className="step-form-footer">
        <Button icon={<PlayCircleFilled />} onClick={onRunToHere}>
          运行至此步骤
        </Button>
        <span>会从第一步开始执行，完成当前步骤后停止。</span>
      </div>
    </div>
  );
}
