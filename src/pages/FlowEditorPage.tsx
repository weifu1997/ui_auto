import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "../router";
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CodeOutlined,
  FileSearchOutlined,
  MoreOutlined,
  PartitionOutlined,
  AudioOutlined,
  PlayCircleFilled,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Alert, Button, Checkbox, Dropdown, Empty, Input, Modal, Select, Tag, Tooltip } from "antd";
import { shouldReloadEditorSteps, useFlowStore } from "../stores/flow-store";
import { useRunStore } from "../stores/run-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import { message, modal } from "../lib/antd-feedback";
import { PlatformApiError, cancelActiveRecordingSession, cancelRecordingSession, createPlatformElementValidation, createPlatformRevision, createPlatformRun, createRecordingSession, getPlatformRevisions, getRecordingEvents, getRecordingSession, getRecordingSessionResult, getPlatformElementValidation, listRecordingSessions, pauseRecordingSession, previewPlatformRun, resumeRecordingSession, stopRecordingSession } from "../api/platform-api";
import type { PlatformPreviewRun } from "../api/platform-api";

// W3 试点：只读流程图懒加载为独立 chunk（React Flow 体积较大，避免进主包）。
const FlowGraphView = lazy(() => import("../components/FlowGraphView"));
import type { RecordingEvent, RecordingResult, RecordingSession } from "../api/platform-api";
import { platformProjectContext } from "../api/platform-context";
import { elementValidationLoginMessage } from "../lib/element-validation";
import { createRunDispatchKeyStore, describePlatformRunError, ensurePlatformRunSecrets, nextRunDispatchKey, platformRunSummaryAsRun, releaseRunDispatchKey, runIntentKey } from "./shared";
import {
  clearStoredRecordingSession,
  isImportableRecordingStatus,
  isTerminalRecordingStatus,
  mergeRecordingEvents,
  recordingLiveStatusLabel,
  recordingResultHasSteps,
  nextRecordingEventPage,
  planRecordingImport,
  readStoredRecordingSession,
  recordingEventCursor,
  recordingSessionStorageKey,
  storeRecordingSessionId,
  type RecordingImportPlan,
} from "../lib/recording-editor-state";
import type { ElementAsset, Environment, Flow, Project, Variable } from "../lib/mock-data";
import { AssertionStepPanel } from "./flow-editor/AssertionStepPanel";
import { AssertionBatchBar } from "./flow-editor/AssertionBatchBar";
import { StepList } from "./flow-editor/StepList";
import { RecordingImportPanel } from "./flow-editor/RecordingImportPanel";
import { SecretCreatorDrawer } from "./flow-editor/SecretCreatorDrawer";
import {
  VALIDATION_DEADLINE_MS,
  emptyElementEdits,
  emptyValidationResults,
  mergeElementEdits,
} from "./flow-editor/element-validation";
import type { ElementEditPatch, ElementValidationResult } from "./flow-editor/element-validation";
import { revisionInput, snapshotVariables, variableReference } from "../lib/revision-snapshot";

const emptyFlows: Flow[] = [];
const emptyElements: ElementAsset[] = [];

// 终态横幅文案：仅被 isTerminalRecordingStatus 门控后使用（stopped/canceled/expired/failed/interrupted）。
const terminalRecordingStatusLabel: Record<string, string> = {
  stopped: "已停止",
  canceled: "已取消",
  expired: "已过期",
  failed: "失败",
  interrupted: "已中断",
};
const emptyVariables: Variable[] = [];
const emptyEnvironments: Environment[] = [];

function projectById(projects: Project[], id?: string) {
  return projects.find((project) => project.id === id);
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
  const setVariables = useWorkspaceStore((state) => state.setVariables);
  const flow = project
    ? (storedFlows ?? emptyFlows).find((item) => item.id === flowId)
    : undefined;
  const flowDefinition = flow?.definition;
  const {
    steps,
    selectedStepId,
    setSelectedStep,
    updateStep,
    updateSteps,
    addStep,
    removeStep,
    moveStep,
    loadSteps,
    importRecordingSteps,
    isDirty,
    markSaved,
  } = useFlowStore();
  // 批量编辑：仅断言步骤可勾选（rowSelection），批量操作条改匹配方式/失败策略。
  const [selectedStepIds, setSelectedStepIds] = useState<string[]>([]);
  const [runToStep, setRunToStep] = useState(false);
  const [previewResult, setPreviewResult] = useState<PlatformPreviewRun | null>(null);
  const [flowGraphOpen, setFlowGraphOpen] = useState(false);
  const runDispatchKeysRef = useRef(createRunDispatchKeyStore());
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [recordingSession, setRecordingSession] = useState<RecordingSession | null>(null);
  const [recordingResult, setRecordingResult] = useState<RecordingResult | null>(null);
  const [recordingStartUrl, setRecordingStartUrl] = useState("");
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [endingRecordingBusy, setEndingRecordingBusy] = useState(false);
  const [recordingSecretMap, setRecordingSecretMap] = useState<Record<string, string>>({});
  const [secretCreatorStepId, setSecretCreatorStepId] = useState<string | null>(null);
  const [elementEdits, setElementEdits] = useState<Record<string, Partial<ElementAsset>>>(emptyElementEdits);
  const [expandedElementId, setExpandedElementId] = useState<string | null>(null);
  const [validationResults, setValidationResults] = useState<Record<string, ElementValidationResult>>(emptyValidationResults);
  const [hasValidated, setHasValidated] = useState(false);
  const validationRunningRef = useRef(false);
  const [recordingEnvironmentId, setRecordingEnvironmentId] = useState(activeEnvironmentId ?? "");
  const [recordingFreshLogin, setRecordingFreshLogin] = useState(false);
  const [recordingEvents, setRecordingEvents] = useState<RecordingEvent[]>([]);
  const [recordingImportBusy, setRecordingImportBusy] = useState(false);
  // 导入弹窗里勾选的候选断言（按元素名去重；候选断言与元素一一对应，元素名
  // 是稳定键，不随 plan 重算漂移）。默认不勾选。
  const [selectedAssertionIds, setSelectedAssertionIds] = useState<Set<string>>(new Set());
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

  const draftPlan = useMemo<RecordingImportPlan | null>(() => {
    if (!recordingResult || !recordingEnvironment) return null;
    try {
      return planRecordingImport(
        recordingResult,
        recordingEnvironment.id,
        elements,
        recordingSecretMap,
      );
    } catch {
      return null;
    }
  }, [recordingResult, recordingEnvironment, elements, recordingSecretMap]);

  const effectiveNewElements = useMemo<ElementAsset[]>(() => {
    if (!draftPlan) return [];
    return draftPlan.newElements.map((element) => mergeElementEdits(element, elementEdits));
  }, [draftPlan, elementEdits]);

  const effectiveElementsToValidate = useMemo<ElementAsset[]>(() => {
    if (!draftPlan) return [];
    const keyOf = (element: ElementAsset) =>
      `${element.environment}\u0000${element.path}\u0000${element.method}\u0000${element.value}`;
    const byKey = new Map<string, ElementAsset>();
    for (const base of draftPlan.elementsToValidate) {
      const merged = mergeElementEdits(base, elementEdits);
      byKey.set(keyOf(merged), merged);
    }
    return [...byKey.values()];
  }, [draftPlan, elementEdits]);

  const allBindingsFilled = useMemo(() => {
    if (!recordingResult) return false;
    return recordingResult.requiredBindings.every(
      (binding) => Boolean(recordingSecretMap[binding.stepId]?.trim()),
    );
  }, [recordingResult, recordingSecretMap]);

  const validationSummary = useMemo(() => {
    const totals = { pending: 0, running: 0, success: 0, ambiguous: 0, missed: 0, error: 0 };
    for (const asset of effectiveNewElements) {
      const status = validationResults[asset.id]?.status ?? "pending";
      totals[status] += 1;
    }
    const canImport =
      effectiveNewElements.length === 0 ||
      (hasValidated &&
        effectiveNewElements.every((asset) => validationResults[asset.id]?.status === "success"));
    return { totals, canImport };
  }, [effectiveNewElements, validationResults, hasValidated]);

  const loginValidationErrors = useMemo(
    () =>
      effectiveNewElements
        .filter((element) => validationResults[element.id]?.loginBlocked)
        .map((element) => validationResults[element.id].errorMessage ?? "")
        .filter(Boolean),
    [effectiveNewElements, validationResults],
  );

  const platformContext = useMemo(
    () => (project ? platformProjectContext(project.id) : undefined),
    [project],
  );
  const [hasPublishedRevision, setHasPublishedRevision] = useState<boolean | null>(null);

  const platformToken = platformContext?.session.token;
  const platformProjectId = platformContext?.projectId;

  useEffect(() => {
    if (!platformToken || !platformProjectId || !flowId) {
      setHasPublishedRevision(null);
      return;
    }
    let cancelled = false;
    getPlatformRevisions(platformToken, platformProjectId)
      .then((result) => {
        if (cancelled) return;
        const has = result.revisions.some(
          (r) => r.flowId === flowId && r.status === "published",
        );
        setHasPublishedRevision(has);
      })
      .catch(() => {
        if (!cancelled) setHasPublishedRevision(null);
      });
    return () => {
      cancelled = true;
    };
  }, [platformToken, platformProjectId, flowId]);

  const canSave = isDirty || hasPublishedRevision === false;

  const pollValidation = useCallback(
    async (
      token: string,
      projectId: string,
      validationId: string,
    ): Promise<{ status: string; count?: number; error?: string }> => {
      let validation = (await getPlatformElementValidation(token, projectId, validationId)).validation;
      const deadline = Date.now() + VALIDATION_DEADLINE_MS;
      while (validation.status === "queued" || validation.status === "running") {
        if (Date.now() >= deadline) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        validation = (await getPlatformElementValidation(token, projectId, validation.id)).validation;
      }
      return {
        status: validation.status,
        count: Number(validation.result?.count ?? 0),
        error: validation.error,
      };
    },
    [],
  );

  const runSingleValidation = useCallback(
    async (_assetId: string, asset: ElementAsset, onUpdate: (result: ElementValidationResult) => void) => {
      if (!platformContext || !recordingEnvironment) {
        onUpdate({ status: "error", errorMessage: "未登录平台或环境不存在" });
        return;
      }
      try {
        onUpdate({ status: "running" });
        const created = await createPlatformElementValidation(
          platformContext.session.token,
          platformContext.projectId,
          { environmentId: recordingEnvironment.id, element: asset },
        );
        const { status, count, error } = await pollValidation(
          platformContext.session.token,
          platformContext.projectId,
          created.validation.id,
        );
        const finalCount = count ?? 0;
        if (status === "success" && finalCount === 1) {
          onUpdate({ status: "success", count: 1 });
        } else if (status === "success" && finalCount > 1) {
          onUpdate({ status: "ambiguous", count: finalCount });
        } else if (status === "success") {
          onUpdate({ status: "missed", count: finalCount });
        } else {
          const loginMessage = elementValidationLoginMessage(error);
          onUpdate({
            status: "error",
            count: 0,
            loginBlocked: Boolean(loginMessage),
            errorMessage: loginMessage ?? error ?? "校验异常",
          });
        }
      } catch (error) {
        onUpdate({
          status: "error",
          errorMessage: error instanceof Error ? error.message : "校验异常",
        });
      }
    },
    [platformContext, recordingEnvironment, pollValidation],
  );

  const runBatchValidation = useCallback(async () => {
    if (!effectiveElementsToValidate.length) return;
    if (validationRunningRef.current) return;
    setHasValidated(true);
    validationRunningRef.current = true;
    try {
      const keyOf = (asset: ElementAsset) =>
        `${asset.environment}\u0000${asset.path}\u0000${asset.method}\u0000${asset.value}`;
      const keyToAssetIds = new Map<string, string[]>();
      for (const asset of effectiveNewElements) {
        const key = keyOf(asset);
        const bucket = keyToAssetIds.get(key);
        if (bucket) bucket.push(asset.id);
        else keyToAssetIds.set(key, [asset.id]);
      }
      const updateAll = (ids: string[], result: ElementValidationResult) =>
        setValidationResults((prev) => {
          const next = { ...prev };
          for (const id of ids) next[id] = result;
          return next;
        });
      const queue = [...effectiveElementsToValidate];
      const workers = 3;
      const worker = async () => {
        while (true) {
          const target = queue.shift();
          if (!target) return;
          const ids = keyToAssetIds.get(keyOf(target)) ?? [];
          updateAll(ids, { status: "running" });
          await runSingleValidation(ids[0] ?? target.id, target, (result) => updateAll(ids, result));
        }
      };
      await Promise.all(Array.from({ length: workers }, () => worker()));
    } finally {
      validationRunningRef.current = false;
    }
  }, [effectiveNewElements, effectiveElementsToValidate, runSingleValidation]);

  const retrySingleValidation = useCallback(
    (assetId: string) => {
      const asset = effectiveNewElements.find((item) => item.id === assetId);
      if (!asset) return;
      setHasValidated(true);
      runSingleValidation(assetId, asset, (result) => {
        setValidationResults((prev) => ({ ...prev, [assetId]: result }));
      });
    },
    [effectiveNewElements, runSingleValidation],
  );

  // 元素编辑保存：写入编辑草稿、收起编辑行、标记已校验，并立即重校该元素。
  // （复合回调，由 RecordingImportPanel 在「保存并重校」时上抛。）
  const handleSaveElementEdit = useCallback(
    (element: ElementAsset, patch: ElementEditPatch) => {
      setElementEdits((prev) => ({
        ...prev,
        [element.id]: { ...(prev[element.id] ?? {}), ...patch },
      }));
      setExpandedElementId(null);
      setHasValidated(true);
      // 保存后自动重新校验
      const merged = mergeElementEdits(element, {
        ...elementEdits,
        [element.id]: { ...(elementEdits[element.id] ?? {}), ...patch },
      });
      runSingleValidation(element.id, merged, (result) => {
        setValidationResults((prev) => ({ ...prev, [element.id]: result }));
      });
    },
    [elementEdits, runSingleValidation],
  );

  const upsertRun = useRunStore((state) => state.upsertRun);
  const lastLoadedDefinition = useRef<{ flowId: string; serialized: string } | null>(null);
  useEffect(() => {
    if (!flowId) return;
    const next = { flowId, serialized: JSON.stringify(flowDefinition ?? []) };
    if (!shouldReloadEditorSteps(lastLoadedDefinition.current, next, isDirty)) return;
    lastLoadedDefinition.current = next;
    loadSteps(flowDefinition ?? []);
  }, [flowDefinition, flowId, loadSteps, isDirty]);

  // 录制结果切换（或关闭）时，清空用户编辑和校验结果，保持无状态
  useEffect(() => {
    setElementEdits(emptyElementEdits);
    setValidationResults(emptyValidationResults);
    setExpandedElementId(null);
    setHasValidated(false);
  }, [recordingResult]);

  const deleteRecordingStep = useCallback(
    (stepIndex: number) => {
      if (!recordingResult) return;
      const targetStep = recordingResult.steps[stepIndex];
      if (!targetStep) return;
      setRecordingResult((prev) => {
        if (!prev) return prev;
        const newSteps = prev.steps.filter((_, index) => index !== stepIndex);
        const newBindings = prev.requiredBindings.filter((binding) => binding.stepId !== targetStep.id);
        // 在 RecordingResult 原始结构内，step.element 与 element.name 都是录制时
        // 的 recorded.name，两者一一对应，因此可以安全地按「剩余 steps 引用的
        // recorded.name 集合」过滤 elements。
        // 注意：这里用 typeof === 'string' 而不是 if (step.element)，避免空字符串
        // 名字被误判为未引用而删掉。
        const usedElementNames = new Set<string>();
        for (const step of newSteps) {
          if (typeof step.element === "string") usedElementNames.add(step.element);
        }
        // 同时处理 element.name 为空字符串的情况：仅当 recorded.name 完全匹配
        // 才删除，不会因空字符串 falsy 判断误伤。
        // planRecordingImport 在后续阶段会再做 recorded.name → resolved.name
        // 映射（uniqueElementName 可能追加序号、或合并到已有元素），但这是在
        // RecordingResult 之外的处理，不影响当前结构的一致性。
        const newElements = prev.elements.filter((element) => usedElementNames.has(element.name));
        return {
          ...prev,
          steps: newSteps,
          elements: newElements,
          requiredBindings: newBindings,
        };
      });
      // 删除该 step 对应的 secret 映射
      setRecordingSecretMap((prev) => {
        const next = { ...prev };
        delete next[targetStep.id];
        return next;
      });
      // 清空校验状态和编辑状态
      setElementEdits(emptyElementEdits);
      setValidationResults(emptyValidationResults);
      setExpandedElementId(null);
      setHasValidated(false);
    },
    [recordingResult],
  );

  const toggleRecordingAssertion = useCallback((assertionId: string, checked: boolean) => {
    setSelectedAssertionIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(assertionId);
      else next.delete(assertionId);
      return next;
    });
  }, []);

  const toggleStepSelection = useCallback((stepId: string, checked: boolean) => {
    setSelectedStepIds((prev) =>
      checked
        ? [...new Set([...prev, stepId])]
        : prev.filter((id) => id !== stepId),
    );
  }, []);

  const handleRemoveStep = useCallback(
    (id: string) => {
      removeStep(id);
      setSelectedStepIds((prev) => prev.filter((selected) => selected !== id));
    },
    [removeStep],
  );

  const applyBatchMatch = useCallback(
    (match: "exact" | "contains") => {
      if (selectedStepIds.length === 0) return;
      const targetIds = steps
        .filter(
          (step) =>
            selectedStepIds.includes(step.id) &&
            (step.action === "文本断言" ||
              step.action === "属性断言" ||
              step.action === "URL 断言"),
        )
        .map((step) => step.id);
      if (targetIds.length > 0) updateSteps(targetIds, { assertMatch: match });
      if (targetIds.length < selectedStepIds.length) {
        message.info("匹配方式仅对文本/属性/URL 断言步骤生效");
      }
    },
    [selectedStepIds, steps, updateSteps],
  );

  const applyBatchFailurePolicy = useCallback(
    (policy: string) => {
      if (selectedStepIds.length === 0) return;
      updateSteps(selectedStepIds, { failurePolicy: policy });
    },
    [selectedStepIds, updateSteps],
  );

  useEffect(() => () => {
    if (recordingPollRef.current !== undefined) {
      window.clearInterval(recordingPollRef.current);
    }
  }, []);

  const recordingStorageKey = project && flow
    ? recordingSessionStorageKey(project.id, flow.id)
    : "";
  const clearRecordingStorage = useCallback(() => {
    if (recordingStorageKey) clearStoredRecordingSession(window.sessionStorage, recordingStorageKey);
  }, [recordingStorageKey]);
  const clearRecordingPoll = useCallback(() => {
    if (recordingPollRef.current !== undefined) {
      window.clearInterval(recordingPollRef.current);
      recordingPollRef.current = undefined;
    }
  }, []);
  const loadTerminalRecordingResult = useCallback(async (
    sessionId: string,
    status: RecordingSession["status"],
  ) => {
    if (!platformContext || !isImportableRecordingStatus(status)) return;
    try {
      const { result } = await getRecordingSessionResult(
        platformContext.session.token,
        platformContext.projectId,
        sessionId,
      );
      if (recordingResultHasSteps(result)) {
        setRecordingResult(result);
        setSelectedAssertionIds(new Set());
        setRecordingSecretMap({});
      }
    } catch {
      // Missing or empty terminal result is not an importable draft.
    }
  }, [platformContext]);
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
          return mergeRecordingEvents(current, page.events);
        });
        const nextPage = nextRecordingEventPage(cursor, page);
        cursor = recordingEventCursor(cursor, page.events);
        recordingLastSeqRef.current = cursor;
        hasMore = nextPage !== undefined;
      }
      const detail = await getRecordingSession(
        platformContext.session.token,
        platformContext.projectId,
        sessionId,
      );
      setRecordingSession(detail.session);
      if (isTerminalRecordingStatus(detail.session.status)) {
        clearRecordingPoll();
        clearRecordingStorage();
        void loadTerminalRecordingResult(sessionId, detail.session.status);
      }
    } catch {
      // Keep the cursor; a transient failure is retried by the next tick.
    } finally {
      recordingPollInFlightRef.current = false;
    }
  }, [clearRecordingPoll, clearRecordingStorage, loadTerminalRecordingResult, platformContext]);
  const startRecordingPoll = useCallback((sessionId: string) => {
    clearRecordingPoll();
    void pollRecording(sessionId);
    recordingPollRef.current = window.setInterval(() => void pollRecording(sessionId), 1000);
  }, [clearRecordingPoll, pollRecording]);

  useEffect(() => {
    if (!platformContext || !recordingStorageKey || recordingSession || recordingRestoreInFlightRef.current) return;
    recordingRestoreInFlightRef.current = true;
    const recoveredId = readStoredRecordingSession(window.sessionStorage, recordingStorageKey);
    if (!recoveredId) {
      // D6 恢复：sessionStorage 无会话 id（页面刷新/跨标签）时，查询最近会话
      // 发现「已中断」的遗留录制并仅显示终态横幅；不自动重启录制、不轮询。
      listRecordingSessions(platformContext.session.token, platformContext.projectId, 1, 5)
        .then((page) => {
          const interrupted = page.sessions.find((item) => item.status === "interrupted");
          if (interrupted) {
            setRecordingSession(interrupted);
            void loadTerminalRecordingResult(interrupted.id, interrupted.status);
          }
        })
        .catch(() => {})
        .finally(() => {
          recordingRestoreInFlightRef.current = false;
        });
      return;
    }
    void getRecordingSession(
      platformContext.session.token,
      platformContext.projectId,
      recoveredId,
    ).then(({ session }) => {
      setRecordingSession(session);
      recordingLastSeqRef.current = session.lastSeq;
      if (isTerminalRecordingStatus(session.status)) {
        clearRecordingStorage();
        void loadTerminalRecordingResult(session.id, session.status);
        return;
      }
      startRecordingPoll(session.id);
    }).catch(() => {
      clearRecordingStorage();
    }).finally(() => {
      recordingRestoreInFlightRef.current = false;
    });
  }, [clearRecordingStorage, loadTerminalRecordingResult, platformContext, recordingSession, recordingStorageKey, startRecordingPoll]);

  if (!project || !flow) {
    return <Navigate to={project ? `/project/${project.id}/flows` : "/projects"} replace />;
  }

  const endActiveRecording = async () => {
    if (!platformContext || !recordingEnvironment) {
      message.error("当前项目没有可用的平台环境");
      return;
    }
    setEndingRecordingBusy(true);
    try {
      const { canceled } = await cancelActiveRecordingSession(
        platformContext.session.token,
        platformContext.projectId,
        recordingEnvironment.id,
      );
      if (canceled) {
        clearRecordingStorage();
        setRecordingSession(null);
        message.success("已结束现有录制会话，可以重新开始");
      } else {
        message.info("当前没有需要结束的录制会话");
      }
    } catch {
      message.error("结束录制会话失败，请稍后重试");
    } finally {
      setEndingRecordingBusy(false);
    }
  };

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
      storeRecordingSessionId(window.sessionStorage, recordingStorageKey, created.session.id);
      setRecordingOpen(false);
      recordingLastSeqRef.current = 0;
      setRecordingEvents([]);
      message.success(
        created.session.status === "starting" ? "正在打开录制浏览器窗口…" : "录制已开始",
      );
      startRecordingPoll(created.session.id);
    } catch (error) {
      if (error instanceof PlatformApiError && error.code === "RECORDING_SESSION_ACTIVE") {
        const sessionId = typeof error.detail?.sessionId === "string" ? error.detail.sessionId : undefined;
        if (platformContext && sessionId) {
          try {
            const { session } = await getRecordingSession(
              platformContext.session.token,
              platformContext.projectId,
              sessionId,
            );
            setRecordingSession(session);
            setRecordingEnvironmentId(session.environmentId);
            storeRecordingSessionId(window.sessionStorage, recordingStorageKey, session.id);
            setRecordingOpen(false);
            recordingLastSeqRef.current = session.lastSeq;
            setRecordingEvents([]);
            message.success("已恢复现有录制会话");
            startRecordingPoll(session.id);
          } catch {
            message.error("当前环境已有录制会话，但恢复失败，请稍后重试");
          }
        } else {
          message.error("当前环境已有录制会话");
        }
      } else {
        const code = error instanceof PlatformApiError ? error.code : "UNKNOWN";
        message.error(`开始录制失败（${code}），请检查环境与浏览器服务`);
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
      setSelectedAssertionIds(new Set());
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
      const canceled = await cancelRecordingSession(
        platformContext.session.token,
        platformContext.projectId,
        recordingSession.id,
      );
      clearRecordingPoll();
      setRecordingSession(canceled.session);
      setRecordingResult(null);
      setSelectedAssertionIds(new Set());
      setRecordingEvents([]);
      clearRecordingStorage();
      message.info("录制已取消");
    } catch {
      message.error("取消录制失败，请稍后重试");
    } finally {
      setRecordingBusy(false);
    }
  };

  const importRecordedFlow = async () => {
    if (!recordingResult || !project || !recordingEnvironment) return;
    let plan;
    try {
      plan = planRecordingImport(
        recordingResult,
        recordingEnvironment.id,
        elements,
        recordingSecretMap,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "RECORDING_SECRET_BINDING_REQUIRED") {
        message.error("请先为所有敏感输入绑定 secret 变量");
      } else {
        message.error("录制结果包含无法解析的元素引用，未导入任何步骤或元素");
      }
      return;
    }
    setRecordingImportBusy(true);
    try {
      const finalNewElements = plan.newElements.map((element) => mergeElementEdits(element, elementEdits));
      // 勾选的候选断言并入 importedSteps（追加在录制步骤之后）。
      const checkedAssertions = plan.generatedAssertions.filter((assertion) =>
        selectedAssertionIds.has(assertion.id),
      );
      const stepsToImport = [...plan.importedSteps, ...checkedAssertions];
      // All fallible work completes first. The two synchronous store writes then
      // expose one confirmed recording draft, never incremental event imports.
      setElements(project.id, [...elements, ...finalNewElements]);
      importRecordingSteps(stepsToImport);
    } finally {
      setRecordingImportBusy(false);
    }
    setRecordingResult(null);
    setRecordingSession(null);
    setSelectedAssertionIds(new Set());
    setRecordingEvents([]);
    clearRecordingStorage();
    message.success("录制步骤已追加到流程草稿，请保存后发布");
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
  const saveFlow = async () => {
    const updatedFlow: Flow = {
      ...flow,
      steps: steps.length,
      definition: steps.map((step) => ({ ...step })),
      updatedAt: "刚刚",
    };
    setFlows(
      project.id,
      (storedFlows ?? emptyFlows).map((item) =>
        item.id === flow.id ? updatedFlow : item,
      ),
    );
    markSaved();
    if (platformContext && activeEnvironment) {
      let revisionPublished = false;
      try {
        await createPlatformRevision(
          platformContext.session.token,
          platformContext.projectId,
          revisionInput(updatedFlow, activeEnvironment, elements, variables),
        );
        revisionPublished = true;
      } catch {
        // 同步器兜底；置为 false 让 run() 在执行前重新尝试创建版本
      }
      setHasPublishedRevision(revisionPublished);
    }
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
    const environment = activeEnvironment;
    if (!environment) {
      message.error("当前项目没有可用运行环境");
      return;
    }
    const platformContext = platformProjectContext(project.id);
    if (!platformContext) {
      message.error("当前项目尚未连接 Platform，请先完成项目同步");
      return;
    }
    setRunToStep(true);
    const stepsToRun = upToStepId
      ? steps.slice(0, steps.findIndex((step) => step.id === upToStepId) + 1)
      : steps;
    const intent = runIntentKey({ projectId: platformContext.projectId, flowId: flow.id, upToStepId });
    try {
      if (!(await ensurePlatformRunSecrets(platformContext.session.token, platformContext.projectId, variables, stepsToRun))) {
        return;
      }
      if (hasPublishedRevision === false) {
        await createPlatformRevision(
          platformContext.session.token,
          platformContext.projectId,
          revisionInput(flow, environment, elements, variables),
        );
        setHasPublishedRevision(true);
      }
      const dispatchKey = nextRunDispatchKey(runDispatchKeysRef.current, intent);
      const result = await createPlatformRun(platformContext.session.token, platformContext.projectId, { flowId: flow.id, environmentId: environment.id, upToStepId, dispatchKey });
      releaseRunDispatchKey(runDispatchKeysRef.current, intent);
      result.runs.forEach((run) => upsertRun(project.id, platformRunSummaryAsRun(run)));
      message.success(`已创建 ${result.runIds.length} 个运行（部署机执行）`);
      if (result.runIds[0]) navigate(`/project/${project.id}/runs/${result.runIds[0]}`);
    } catch (error) {
      releaseRunDispatchKey(runDispatchKeysRef.current, intent, error);
      message.error(describePlatformRunError(error));
    } finally {
      setRunToStep(false);
    }
  };
  // W1-6：「运行至此步骤」走服务端试跑通道（不落库、不污染通过率统计），
  // 正式全量运行仍由 run() 走真实运行链路。
  const previewToStep = async (upToStepId: string) => {
    if (steps.length === 0) {
      message.error("请先添加至少一个流程步骤。");
      return;
    }
    const environment = activeEnvironment;
    if (!environment) {
      message.error("当前项目没有可用运行环境");
      return;
    }
    const platformContext = platformProjectContext(project.id);
    if (!platformContext) {
      message.error("当前项目尚未连接 Platform，请先完成项目同步");
      return;
    }
    setRunToStep(true);
    try {
      if (!(await ensurePlatformRunSecrets(platformContext.session.token, platformContext.projectId, variables, steps))) {
        return;
      }
      const input = revisionInput(flow, environment, elements, variables);
      const stepsToRun = steps.slice(0, steps.findIndex((step) => step.id === upToStepId) + 1);
      const outcome = await previewPlatformRun(platformContext.session.token, platformContext.projectId, {
        environment: input.environment,
        flow: { id: input.flow.id, name: input.flow.name, steps: stepsToRun },
        elements: input.elements,
        variables: snapshotVariables(variables),
        secretNames: input.secretNames,
        upToStepId,
      });
      setPreviewResult(outcome);
    } catch (error) {
      message.error(describePlatformRunError(error));
    } finally {
      setRunToStep(false);
    }
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
          <Button
            icon={<PartitionOutlined />}
            disabled={steps.length === 0}
            onClick={() => setFlowGraphOpen(true)}
          >
            流程图
          </Button>
          {recordingSession && !isTerminalRecordingStatus(recordingSession.status) ? (
            <>
              <span className="recording-status" aria-live="polite">
                {recordingLiveStatusLabel(recordingSession.status)}
                {recordingSession.environmentId ? ` · ${environments.find((item) => item.id === recordingSession.environmentId)?.name ?? recordingSession.environmentId}` : ""}
                {recordingSession.currentUrl ? ` · ${recordingSession.currentUrl}` : ""}
                {` · ${recordingSession.recordedStepCount ?? recordingEvents.length} 步`}
              </span>
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
          {recordingSession && isTerminalRecordingStatus(recordingSession.status) && (
            <>
              <span className="recording-status" aria-live="polite">
                录制{terminalRecordingStatusLabel[recordingSession.status] ?? "已取消"}
                {recordingSession.environmentId ? ` · ${environments.find((item) => item.id === recordingSession.environmentId)?.name ?? recordingSession.environmentId}` : ""}
                {recordingSession.currentUrl ? ` · ${recordingSession.currentUrl}` : ""}
                {recordingSession.errorCode ? ` · ${recordingSession.errorCode}` : ""}
              </span>
              {isImportableRecordingStatus(recordingSession.status) && !recordingResult ? (
                <Button
                  icon={<FileSearchOutlined />}
                  onClick={() => void loadTerminalRecordingResult(recordingSession.id, recordingSession.status)}
                >
                  导入录制结果
                </Button>
              ) : null}
            </>
          )}
          <Button icon={<PlayCircleFilled />} loading={runToStep} onClick={() => run()}>
            运行整个流程
          </Button>
          <Button
            type="primary"
            icon={<CheckCircleFilled />}
            disabled={!canSave}
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
          <AssertionBatchBar
            selectedCount={selectedStepIds.length}
            onApplyMatch={applyBatchMatch}
            onApplyFailurePolicy={applyBatchFailurePolicy}
            onClearSelection={() => setSelectedStepIds([])}
          />
          <StepList
            steps={steps}
            selectedStepId={selectedStep?.id}
            selectedStepIds={selectedStepIds}
            onSelect={setSelectedStep}
            onToggleSelection={toggleStepSelection}
            onMove={moveStep}
            onRemove={handleRemoveStep}
            onAdd={addStep}
          />
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
            <AssertionStepPanel
              step={selectedStep}
              elements={elements}
              onChange={updateStep}
              runInFlight={runToStep}
              onRunToHere={() => previewToStep(selectedStep.id)}
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
        footer={[
          <Button key="end" loading={endingRecordingBusy} onClick={() => void endActiveRecording()}>
            结束
          </Button>,
          <Button key="cancel" onClick={() => setRecordingOpen(false)}>
            取消
          </Button>,
          <Button key="ok" type="primary" loading={recordingBusy} onClick={() => void startRecording()}>
            开始录制
          </Button>,
        ]}
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
          setSelectedAssertionIds(new Set());
          setRecordingEvents([]);
        }}
        width={720}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setRecordingResult(null);
              setRecordingSession(null);
              setSelectedAssertionIds(new Set());
              setRecordingEvents([]);
            }}
          >取消</Button>,
          <Button
            key="validate"
            icon={<ReloadOutlined />}
            disabled={!effectiveNewElements.length || Boolean(validationSummary.totals.running)}
            onClick={() => void runBatchValidation()}
          >
            {hasValidated ? "重新校验全部" : "校验全部"}
          </Button>,
          <Tooltip
            key="import-tooltip"
            title={(() => {
              if (recordingResult?.requiredBindings.length && !allBindingsFilled) return "请先为所有敏感输入绑定 secret 变量";
              if (effectiveNewElements.length > 0 && !hasValidated) return "请先点击「校验全部」校验元素定位器";
              if (!validationSummary.canImport) {
                if (validationSummary.totals.running + validationSummary.totals.pending > 0) return "等待元素定位器校验完成…";
                if (validationSummary.totals.missed) return `有 ${validationSummary.totals.missed} 个元素未匹配到，请编辑定位器或重新校验`;
                if (validationSummary.totals.ambiguous) return `有 ${validationSummary.totals.ambiguous} 个元素匹配多个，请收窄定位器`;
                if (validationSummary.totals.error) return `有 ${validationSummary.totals.error} 个元素校验异常，请重试`;
              }
              return undefined;
            })()}
          >
            <Button
              key="import"
              type="primary"
              disabled={!allBindingsFilled || !validationSummary.canImport}
              loading={recordingImportBusy}
              onClick={() => void importRecordedFlow()}
            >
              确认导入
            </Button>
          </Tooltip>,
        ]}
      >
        {recordingResult && (
          <RecordingImportPanel
            recordingResult={recordingResult}
            eventCount={recordingEvents.length}
            draftPlan={draftPlan}
            selectedAssertionIds={selectedAssertionIds}
            effectiveNewElements={effectiveNewElements}
            validationTotals={validationSummary.totals}
            validationResults={validationResults}
            hasValidated={hasValidated}
            loginValidationErrors={loginValidationErrors}
            elementEdits={elementEdits}
            expandedElementId={expandedElementId}
            variables={variables}
            environments={environments}
            recordingSecretMap={recordingSecretMap}
            onDeleteStep={deleteRecordingStep}
            onToggleAssertion={toggleRecordingAssertion}
            onSetSecretBinding={(stepId, value) =>
              setRecordingSecretMap((current) => ({ ...current, [stepId]: value }))
            }
            onCreateSecret={setSecretCreatorStepId}
            onExpandElement={setExpandedElementId}
            onSaveElementEdit={handleSaveElementEdit}
            onRetryValidation={retrySingleValidation}
          />
        )}
      </Modal>
      <Modal
        open={previewResult !== null}
        title="试跑结果"
        onCancel={() => setPreviewResult(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setPreviewResult(null)}>
            关闭
          </Button>,
        ]}
        width={640}
      >
        {previewResult ? (
          <div className="preview-result" aria-live="polite">
            <Alert
              showIcon
              type={
                previewResult.result.status === "success"
                  ? "success"
                  : previewResult.result.status === "failed"
                    ? "error"
                    : "warning"
              }
              message={`试跑${
                previewResult.result.status === "success"
                  ? "成功"
                  : previewResult.result.status === "failed"
                    ? "失败"
                    : "已取消"
              }${typeof previewResult.result.elapsedMs === "number" ? ` · ${previewResult.result.elapsedMs}ms` : ""}`}
              description={
                previewResult.result.error
                  ? String(previewResult.result.error)
                  : "试跑不产生运行记录，也不影响项目通过率统计。"
              }
            />
            {(previewResult.result.assertions ?? []).length > 0 ? (
              <ul className="preview-assertions">
                {(previewResult.result.assertions ?? []).map((item, index) => (
                  <li key={`${item.stepId ?? index}-${index}`}>
                    <Tag color={item.passed ? "success" : "error"}>
                      {item.passed ? "通过" : "失败"}
                    </Tag>
                    <span>{item.title ?? item.stepId ?? `步骤 ${item.stepIndex}`}</span>
                    {typeof item.expected === "string" && (
                      <span className="preview-assertion-detail">
                        期望「{item.expected}」实际「{item.actual ?? ""}」
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>本次试跑没有断言步骤。</p>
            )}
          </div>
        ) : null}
      </Modal>
      <Modal
        open={flowGraphOpen}
        title="流程图（只读）"
        onCancel={() => setFlowGraphOpen(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setFlowGraphOpen(false)}>
            关闭
          </Button>,
        ]}
        width={720}
      >
        <Suspense fallback={<p>流程图加载中…</p>}>
          <FlowGraphView
            steps={steps}
            onSelectStep={(stepId) => {
              setSelectedStep(stepId);
              setFlowGraphOpen(false);
            }}
          />
        </Suspense>
      </Modal>
      {project && secretCreatorStepId !== null && (
        <SecretCreatorDrawer
          open
          project={project}
          variables={variables}
          stepBinding={recordingResult?.requiredBindings.find((b) => b.stepId === secretCreatorStepId) ?? null}
          onClose={() => setSecretCreatorStepId(null)}
          onCreated={(newVariable) => {
            if (!project) return;
            const storedVariables = useWorkspaceStore.getState().variablesByProject[project.id];
            const currentList = Array.isArray(storedVariables) ? storedVariables : [];
            setVariables(project.id, [newVariable, ...currentList]);
            setRecordingSecretMap((current) => ({
              ...current,
              [secretCreatorStepId]: variableReference(newVariable),
            }));
            setSecretCreatorStepId(null);
            message.success("secret 已创建并绑定");
          }}
        />
      )}
    </div>
  );
}
