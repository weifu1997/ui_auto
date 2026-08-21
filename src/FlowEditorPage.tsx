import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "./router";
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CodeOutlined,
  DeleteOutlined,
  DragOutlined,
  ExclamationCircleFilled,
  FileSearchOutlined,
  LoadingOutlined,
  MoreOutlined,
  AudioOutlined,
  PlayCircleFilled,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Alert, Button, Checkbox, Dropdown, Drawer, Empty, Form, Input, Modal, Popover, Select, Switch, Tag, Tooltip } from "antd";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useFlowStore } from "./flow-store";
import { useRunStore } from "./run-store";
import { useSecretStore } from "./secret-store";
import { useWorkspaceStore } from "./workspace-store";
import { message, modal } from "./antd-feedback";
import { PlatformApiError, cancelActiveRecordingSession, cancelRecordingSession, createPlatformElementValidation, createPlatformRevision, createPlatformRun, createRecordingSession, getPlatformRevisions, getRecordingEvents, getRecordingSession, getPlatformElementValidation, pauseRecordingSession, resumeRecordingSession, savePlatformSecret, stopRecordingSession } from "./platform-api";
import type { RecordingEvent, RecordingResult, RecordingSession } from "./platform-api";
import { platformProjectContext } from "./platform-context";
import { elementValidationLoginMessage } from "./element-validation";
import { describePlatformRunError, platformRunAsRun, uniqueVariableNameValidator } from "./pages/shared";
import {
  clearStoredRecordingSession,
  isTerminalRecordingStatus,
  mergeRecordingEvents,
  nextRecordingEventPage,
  planRecordingImport,
  readStoredRecordingSession,
  recordingEventCursor,
  recordingSessionStorageKey,
  storeRecordingSessionId,
  type RecordingImportPlan,
} from "./recording-editor-state";
import { actionOptions } from "./mock-data";
import type { ElementAsset, Environment, Flow, FlowStep, Project, Variable } from "./mock-data";
import { requiredSecretVariables, revisionInput, variableReference } from "./revision-snapshot";

const emptyFlows: Flow[] = [];
const emptyElements: ElementAsset[] = [];
const emptyVariables: Variable[] = [];
const emptyEnvironments: Environment[] = [];
const emptySecretValues: Record<string, string> = {};

function projectById(projects: Project[], id?: string) {
  return projects.find((project) => project.id === id);
}

function suggestSecretNameFromHint(fieldHint: string, variables: Variable[], scope: Variable["scope"] = "项目"): string {
  const lower = fieldHint.toLowerCase();
  let base = "secret";
  if (/密码|password|passwd|pwd/.test(lower)) base = "password";
  else if (/token/.test(lower)) base = "api_token";
  else if (/密钥|secret|key/.test(lower)) base = "secret_key";
  else if (/用户名|登录|登录名|user|account|login/.test(lower)) base = "username";
  else {
    const cleaned = fieldHint.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, "_").replace(/^_+|_+$/g, "");
    if (cleaned.length > 0 && cleaned.length <= 32) base = cleaned;
  }
  const existSet = new Set(
    variables.filter((variable) => variable.scope === scope).map((variable) => variable.name),
  );
  if (!existSet.has(base)) return base;
  let suffix = 2;
  while (existSet.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

type RecordingBinding = {
  stepId: string;
  fieldHint: string;
};

function SecretCreatorDrawer({
  open,
  project,
  variables,
  stepBinding,
  onClose,
  onCreated,
}: {
  open: boolean;
  project: Project;
  variables: Variable[];
  stepBinding: RecordingBinding | null;
  onClose: () => void;
  onCreated: (variable: Variable) => void;
}) {
  const [form] = Form.useForm();
  const scope = Form.useWatch("scope", form) ?? "项目";
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ scope: "项目", description: stepBinding?.fieldHint ?? "" });
    // 根据 scope 和 hint 智能推断默认名称（去重）
    const defaultScope: Variable["scope"] = "项目";
    const defaultName = stepBinding
      ? suggestSecretNameFromHint(stepBinding.fieldHint, variables, defaultScope)
      : suggestSecretNameFromHint("", variables, defaultScope);
    form.setFieldsValue({ scope: defaultScope, name: defaultName, description: stepBinding?.fieldHint ?? "" });
  }, [form, open, stepBinding, variables]);
  return (
    <Drawer
      title={stepBinding ? `为「${stepBinding.fieldHint}」新建 secret` : "新建 secret 变量"}
      open={open}
      size={480}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          onClick={() =>
            form
              .validateFields()
              .then((values) => {
                const id = `var-${Date.now()}`;
                if (typeof values.value === "string" && values.value.trim()) {
                  useSecretStore.getState().setValues(project.id, { [id]: values.value });
                  message.info("密钥已注入当前会话（刷新后失效），不会保存到存储");
                }
                onCreated({
                  id,
                  name: values.name.trim(),
                  description: values.description?.trim() || stepBinding?.fieldHint || "项目变量",
                  value: "",
                  scope: values.scope,
                  secret: true,
                  updatedAt: "刚刚",
                });
              })
          }
        >
          创建并绑定
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="变量名"
          dependencies={["scope"]}
          validateTrigger={["onChange", "onBlur"]}
          rules={[
            { required: true, message: "请输入变量名" },
            { validator: uniqueVariableNameValidator(variables, scope) },
          ]}
          extra={`引用格式：{{${scope === "环境" ? "env" : "project"}.变量名}}`}
        >
          <Input placeholder="例如：password" />
        </Form.Item>
        <Form.Item name="scope" label="作用域">
          <Select
            options={[
              { value: "项目", label: "项目变量" },
              { value: "环境", label: "环境变量" },
            ]}
          />
        </Form.Item>
        <Form.Item name="value" label="值" rules={[{ required: true, message: "请输入密钥值" }]}>
          <Input.Password placeholder="密钥不会保存：仅注入当前会话，刷新后失效" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="说明变量的业务用途" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

type ElementValidationStatus =
  | "pending"
  | "running"
  | "success"
  | "ambiguous"
  | "missed"
  | "error";

type ElementValidationResult = {
  status: ElementValidationStatus;
  count?: number;
  errorMessage?: string;
  /** 校验落在登录墙上：元素位于登录后才能访问的页面，需要登录态。 */
  loginBlocked?: boolean;
};

const emptyValidationResults: Record<string, ElementValidationResult> = {};
const emptyElementEdits: Record<string, Partial<ElementAsset>> = {};

// 服务端按 workspace 串行执行校验，单个任务实测可达 ~50s，批量时按队列顺序
// 依次完成（第 k 个约在 k×~50s）。用 7.5 分钟墙钟上限覆盖常见批次的排队耗时，
// 避免「前端放弃轮询、服务端仍在跑」导致的假性「校验中」滞留。
const VALIDATION_DEADLINE_MS = 7 * 60_000 + 30_000;

function mergeElementEdits(
  element: ElementAsset,
  edits: Record<string, Partial<ElementAsset>>,
): ElementAsset {
  const patch = edits[element.id];
  if (!patch) return element;
  return { ...element, ...patch };
}

function elementValidationLabel(result: ElementValidationResult, validated: boolean) {
  if (!validated && result.status !== "running") return "未校验，点击「校验全部」开始";
  switch (result.status) {
    case "pending":
      return "等待校验";
    case "running":
      return "校验中";
    case "success":
      return "唯一命中";
    case "ambiguous":
      return `匹配 ${result.count ?? "多个"} 个`;
    case "missed":
      return "未匹配到元素";
    case "error":
      return result.errorMessage ?? "校验失败";
  }
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
    const recoveredId = readStoredRecordingSession(window.sessionStorage, recordingStorageKey);
    if (!recoveredId) return;
    recordingRestoreInFlightRef.current = true;
    void getRecordingSession(
      platformContext.session.token,
      platformContext.projectId,
      recoveredId,
    ).then(({ session }) => {
      setRecordingSession(session);
      recordingLastSeqRef.current = session.lastSeq;
      if (isTerminalRecordingStatus(session.status)) {
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
      message.success("录制已开始");
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
      // All fallible work completes first. The two synchronous store writes then
      // expose one confirmed recording draft, never incremental event imports.
      setElements(project.id, [...elements, ...finalNewElements]);
      importRecordingSteps(plan.importedSteps);
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
      try {
        await createPlatformRevision(
          platformContext.session.token,
          platformContext.projectId,
          revisionInput(updatedFlow, activeEnvironment, elements, variables),
        );
      } catch {
        // 同步器兜底
      }
    }
    setHasPublishedRevision(true);
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
        if (hasPublishedRevision === false) {
          await createPlatformRevision(
            platformContext.session.token,
            platformContext.projectId,
            revisionInput(flow, environment, elements, variables),
          );
          setHasPublishedRevision(true);
        }
        for (const variable of requiredSecretVariables(variables, stepsToRun)) {
          const value = secretValues[variable.id];
          if (value) await savePlatformSecret(platformContext.session.token, platformContext.projectId, { name: variableReference(variable), value });
        }
        const result = await createPlatformRun(platformContext.session.token, platformContext.projectId, { flowId: flow.id, environmentId: environment.id, upToStepId });
        result.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
        message.success(`已创建 ${result.runIds.length} 个运行（部署机执行）`);
        if (result.runIds[0]) navigate(`/project/${project.id}/runs/${result.runIds[0]}`);
      } catch (error) {
        message.error(describePlatformRunError(error));
      } finally {
        setRunToStep(false);
      }
      return;
    }
    message.error("当前项目尚未连接 Platform，请先完成项目同步");
    setRunToStep(false);
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
          {recordingSession && !isTerminalRecordingStatus(recordingSession.status) ? (
            <>
              <span className="recording-status" aria-live="polite">
                {recordingSession.status === "paused" ? "录制已暂停" : "录制中"}
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
            <span className="recording-status" aria-live="polite">
              录制{recordingSession.status === "stopped" ? "已停止" : recordingSession.status === "expired" ? "已过期" : recordingSession.status === "failed" ? "失败" : "已取消"}
              {recordingSession.environmentId ? ` · ${environments.find((item) => item.id === recordingSession.environmentId)?.name ?? recordingSession.environmentId}` : ""}
              {recordingSession.currentUrl ? ` · ${recordingSession.currentUrl}` : ""}
              {recordingSession.errorCode ? ` · ${recordingSession.errorCode}` : ""}
            </span>
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
          setRecordingEvents([]);
        }}
        width={720}
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
          <div className="recording-result">
            <p>共录制 {recordingResult.steps.length} 步，{recordingResult.elements.length} 个元素；已收到 {recordingEvents.length} 个事件。</p>
            <ol className="recording-steps-list">
              {recordingResult.steps.map((step, index) => (
                <li key={String(step.id ?? index)} className="recording-step-item">
                  <span className="recording-step-content">
                    <span className="recording-step-index">{index + 1}.</span>
                    <span>{String(step.title ?? step.action ?? "录制步骤")} {step.element ? ` · ${String(step.element)}` : ""}</span>
                  </span>
                  <Tooltip title="删除此步骤">
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => deleteRecordingStep(index)}
                    />
                  </Tooltip>
                </li>
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
                  <label key={binding.stepId} className="recording-binding-row">
                    <span>{binding.fieldHint}</span>
                    <div className="recording-binding-actions">
                      <Select
                        aria-label={`绑定 ${binding.fieldHint}`}
                        placeholder="搜索或选择 secret 变量"
                        showSearch
                        optionFilterProp="label"
                        filterOption
                        value={recordingSecretMap[binding.stepId]}
                        onChange={(value) => setRecordingSecretMap((current) => ({ ...current, [binding.stepId]: value }))}
                        options={variables
                          .filter((variable) => variable.secret && (variable.scope === "环境" || variable.scope === "项目"))
                          .map((variable) => ({ value: variableReference(variable), label: variable.name }))}
                      />
                      <Button
                        type="dashed"
                        icon={<PlusOutlined />}
                        onClick={() => setSecretCreatorStepId(binding.stepId)}
                      >
                        新建并绑定
                      </Button>
                    </div>
                  </label>
                ))}
              </div>
            )}
            {effectiveNewElements.length > 0 && (
              <div className="recording-bindings">
                <p style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  新增元素定位器校验（{effectiveNewElements.length} 个）
                  <span className="validation-summary-tags">
                    {validationSummary.totals.success > 0 && (
                      <Tag color="success" icon={<CheckCircleFilled />}>成功 {validationSummary.totals.success}</Tag>
                    )}
                    {validationSummary.totals.ambiguous > 0 && (
                      <Tag color="warning" icon={<ExclamationCircleFilled />}>匹配多个 {validationSummary.totals.ambiguous}</Tag>
                    )}
                    {validationSummary.totals.missed > 0 && (
                      <Tag color="error" icon={<CloseCircleFilled />}>未匹配 {validationSummary.totals.missed}</Tag>
                    )}
                    {validationSummary.totals.error > 0 && (
                      <Tag color="error">异常 {validationSummary.totals.error}</Tag>
                    )}
                    {(validationSummary.totals.pending + validationSummary.totals.running) > 0 && (
                      <Tag icon={<LoadingOutlined />}>校验中 {validationSummary.totals.pending + validationSummary.totals.running}</Tag>
                    )}
                  </span>
                </p>
                {loginValidationErrors.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: "var(--space-3)" }}
                    message={`${loginValidationErrors.length} 个元素需要登录态才能校验`}
                    description={elementValidationLoginMessage(loginValidationErrors[0]) ?? undefined}
                  />
                )}
                {effectiveNewElements.map((element) => {
                  const result = validationResults[element.id] ?? { status: "pending" as ElementValidationStatus };
                  const expanded = expandedElementId === element.id;
                  const statusIcon =
                    result.status === "success" ? (
                      <CheckCircleFilled style={{ color: "var(--success)" }} />
                    ) : result.status === "ambiguous" ? (
                      <ExclamationCircleFilled style={{ color: "var(--warning)" }} />
                    ) : result.status === "missed" || result.status === "error" ? (
                      <CloseCircleFilled style={{ color: "var(--danger)" }} />
                    ) : result.status === "running" ? (
                      <LoadingOutlined />
                    ) : (
                      <FileSearchOutlined style={{ color: "var(--text-secondary)" }} />
                    );
                  return (
                    <div key={element.id} className="element-validation-row">
                      <div className="element-validation-main">
                        <Tooltip title={elementValidationLabel(result, hasValidated)}>
                          <span className="element-validation-icon">{statusIcon}</span>
                        </Tooltip>
                        <span className="element-validation-name">{element.name}</span>
                        <Tag className="element-validation-method">
                          {element.method}
                        </Tag>
                        <Popover
                          content={<code style={{ whiteSpace: "pre-wrap" }}>{element.value}</code>}
                          title="定位值"
                          trigger="click"
                        >
                          <span className="element-validation-value" title={element.value}>
                            {element.value.length > 40 ? `${element.value.slice(0, 40)}…` : element.value}
                          </span>
                        </Popover>
                        <span className="element-validation-spacer" />
                        <Tooltip title="重新校验该元素">
                          <Button
                            type="text"
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={() => retrySingleValidation(element.id)}
                            disabled={result.status === "running"}
                          />
                        </Tooltip>
                        <Button
                          type="text"
                          size="small"
                          onClick={() =>
                            setExpandedElementId(expanded ? null : element.id)
                          }
                        >
                          {expanded ? "收起" : "编辑"}
                        </Button>
                      </div>
                      {expanded && (
                        <div className="element-validation-edit">
                          <ElementEditForm
                            element={element}
                            environments={environments}
                            initialPatch={elementEdits[element.id]}
                            onCancel={() => setExpandedElementId(null)}
                            onSubmit={(patch) => {
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
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                {!draftPlan && (
                  <Alert
                    type="warning"
                    showIcon
                    message="无法生成导入计划"
                    description="当前录制结果与元素库或 secret 绑定不兼容，请先完成 requiredBindings 的 secret 绑定后再校验。"
                  />
                )}
              </div>
            )}
          </div>
        )}
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

function ElementEditForm({
  element,
  environments,
  initialPatch,
  onCancel,
  onSubmit,
}: {
  element: ElementAsset;
  environments: Environment[];
  initialPatch?: Partial<ElementAsset>;
  onCancel: () => void;
  onSubmit: (patch: { path?: string; method?: ElementAsset["method"]; value?: string; environment?: string }) => void;
}) {
  const [form] = Form.useForm();
  const method = Form.useWatch("method", form);
  const merged: ElementAsset = initialPatch ? { ...element, ...initialPatch } : element;
  useEffect(() => {
    form.setFieldsValue({
      path: merged.path,
      method: merged.method,
      value: merged.value,
      environment: merged.environment,
    });
  }, [form, merged.path, merged.method, merged.value, merged.environment]);
  return (
    <Form
      form={form}
      layout="vertical"
      className="element-edit-form"
      onFinish={(values) => {
        onSubmit({
          path: typeof values.path === "string" ? values.path.trim() : undefined,
          method: values.method,
          value: typeof values.value === "string" ? values.value : undefined,
          environment: typeof values.environment === "string" ? values.environment : undefined,
        });
      }}
    >
      <div className="form-row">
        <Form.Item
          name="path"
          label="页面路径"
          rules={[{ required: true, message: "请输入路径" }]}
          style={{ flex: 2 }}
        >
          <Input placeholder="/login" />
        </Form.Item>
        <Form.Item
          name="environment"
          label="默认验证环境"
          style={{ flex: 1 }}
        >
          <Select
            options={environments.map((env) => ({ value: env.id, label: env.name }))}
          />
        </Form.Item>
      </div>
      <div className="form-row">
        <Form.Item
          name="method"
          label="定位方式"
          rules={[{ required: true }]}
          style={{ flex: 1 }}
        >
          <Select
            options={["testid", "role", "label", "text", "CSS", "XPath"].map((value) => ({
              value,
              label: value,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="value"
          label="定位值"
          rules={[{ required: true, message: "请输入定位值" }]}
          style={{ flex: 2 }}
        >
          <Input
            placeholder={
              method === "testid"
                ? "login-submit"
                : method === "role"
                  ? 'button[name="登录"]'
                  : "请输入定位值"
            }
          />
        </Form.Item>
      </div>
      {(method === "CSS" || method === "XPath") && (
        <Alert
          showIcon
          type="warning"
          title="该定位方式稳定性较低"
          description="优先选择 testid、role 或 label。CSS/XPath 在页面结构变化后更容易失效。"
        />
      )}
      <div className="element-edit-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" htmlType="submit">保存并重校</Button>
      </div>
    </Form>
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
