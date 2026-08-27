import type { ElementAsset, FlowStep } from "./mock-data";
import type {
  RecordingEvent,
  RecordingEventPage,
  RecordingResult,
  RecordingSessionStatus,
} from "../api/platform-api";

const terminalStatuses = new Set<RecordingSessionStatus>([
  "stopped",
  "canceled",
  "expired",
  "failed",
  "interrupted",
]);

export function isTerminalRecordingStatus(status: RecordingSessionStatus) {
  return terminalStatuses.has(status);
}

export function mergeRecordingEvents(
  current: RecordingEvent[],
  incoming: RecordingEvent[],
) {
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export function recordingEventCursor(afterSeq: number, events: RecordingEvent[]) {
  return events.reduce((cursor, event) => Math.max(cursor, event.seq), afterSeq);
}

export function nextRecordingEventPage(
  afterSeq: number,
  page: RecordingEventPage,
) {
  const cursor = recordingEventCursor(afterSeq, page.events);
  // A cursor only advances with an event. `lastSeq` is the session-wide high
  // watermark, so using it here could skip a full intermediate page.
  return page.hasMore && cursor > afterSeq ? cursor : undefined;
}

export function recordingSessionStorageKey(projectId: string, flowId: string) {
  return `autoflow-recording-session:${projectId}:${flowId}`;
}

export function storeRecordingSessionId(
  storage: Pick<Storage, "setItem">,
  key: string,
  sessionId: string,
) {
  storage.setItem(key, sessionId);
}

export function clearStoredRecordingSession(
  storage: Pick<Storage, "removeItem">,
  key: string,
) {
  storage.removeItem(key);
}

export function readStoredRecordingSession(
  storage: Pick<Storage, "getItem">,
  key: string,
) {
  return storage.getItem(key);
}

function elementKey(element: Pick<ElementAsset, "environment" | "path" | "method" | "value">) {
  return `${element.environment}\u0000${element.path}\u0000${element.method}\u0000${element.value}`;
}

/**
 * 新元素/步骤/断言 id 必须由内容确定性推导（FNV-1a）。
 * 导入计划会随 workspace 同步轮询反复重算（elements 引用每次刷新都会变化），
 * 并在「候选预览」与「确认导入」时各算一次；若 id 里带时间戳，id 会随之漂移，
 * 勾选的候选断言会因重算后的 id 变化而被静默丢弃，正在进行的定位器校验结果和
 * 用户的编辑也会挂在旧 id 上，界面永远停在「校验中」。
 */
function contentId(prefix: string, key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function uniqueElementName(base: string, existingNames: Set<string>) {
  const normalized = base.trim() || "录制元素";
  if (!existingNames.has(normalized)) {
    existingNames.add(normalized);
    return normalized;
  }
  let index = 2;
  while (existingNames.has(`${normalized} ${index}`)) index += 1;
  const name = `${normalized} ${index}`;
  existingNames.add(name);
  return name;
}

function sanitizeRecordedPath(value: string) {
  const path = value.split(/[?#]/, 1)[0];
  return path || "/";
}

export type RecordingImportPlan = {
  newElements: ElementAsset[];
  importedSteps: FlowStep[];
  elementsToValidate: ElementAsset[];
  /** 候选可见性断言：默认不勾选，勾选后并入 importedSteps 一并导入。 */
  generatedAssertions: FlowStep[];
};

export function planRecordingImport(
  result: RecordingResult,
  environmentId: string,
  currentElements: ElementAsset[],
  secretBindings: Record<string, string>,
  // 保留该参数以兼容既有调用（测试以位置参数模拟不同时钟）；id 一律由内容派生，
  // 不再读取它，改名 _now 使 tsc noUnusedParameters 放行。
  _now = Date.now(),
): RecordingImportPlan {
  const recordedStepIds = new Set(result.steps.map((step) => step.id));
  for (const binding of result.requiredBindings) {
    if (!recordedStepIds.has(binding.stepId) || !secretBindings[binding.stepId]?.trim()) {
      throw new Error("RECORDING_SECRET_BINDING_REQUIRED");
    }
  }

  const names = new Set(currentElements.map((element) => element.name));
  const elementsByKey = new Map(currentElements.map((element) => [elementKey(element), element]));
  const elementNames = new Map<string, string>();
  const newElements: ElementAsset[] = [];
  const elementsToValidate: ElementAsset[] = [];

  for (const recorded of result.elements) {
    const key = elementKey({
      environment: environmentId,
      path: recorded.path,
      method: recorded.method,
      value: recorded.value,
    });
    const existing = elementsByKey.get(key);
    const resolved = existing ?? {
      id: contentId("rec-el", key),
      name: uniqueElementName(recorded.name, names),
      path: recorded.path,
      method: recorded.method,
      value: recorded.value,
      environment: environmentId,
      description: "",
      validation: "unverified" as const,
      updatedAt: "刚刚",
    };
    const priorName = elementNames.get(recorded.name);
    if (priorName && priorName !== resolved.name) {
      throw new Error("RECORDING_ELEMENT_NAME_AMBIGUOUS");
    }
    elementNames.set(recorded.name, resolved.name);
    if (!existing) {
      newElements.push(resolved);
      elementsByKey.set(key, resolved);
    }
    if (!elementsToValidate.some((element) => elementKey(element) === key)) {
      elementsToValidate.push(resolved);
    }
  }

  const importedSteps = result.steps.map((recorded, index) => {
    const element = recorded.element ? elementNames.get(recorded.element) : undefined;
    if (recorded.element && !element) throw new Error("RECORDING_ELEMENT_REFERENCE_MISSING");
    const binding = secretBindings[recorded.id]?.trim();
    return {
      id: contentId(
        "rec-step",
        `${index}\u0000${recorded.id}\u0000${recorded.action}\u0000${element ?? ""}\u0000${recorded.value ?? ""}`,
      ),
      title: recorded.title || recorded.action,
      action: recorded.action,
      element,
      value: binding
        ? `{{${binding}}}`
        : recorded.action === "打开页面"
          ? sanitizeRecordedPath(recorded.value ?? "")
          : recorded.value ?? "",
      timeout: 10,
      failurePolicy: "立即失败",
      status: "pending" as const,
    };
  });

  // 候选可见性断言：对每个被（非打开页面）步骤引用的元素，各生成一条
  // 「{name} 可见」断言。按 recorded 步骤的引用顺序去重，保证多次重算稳定。
  const assertionElementNames = new Set<string>();
  for (const recorded of result.steps) {
    if (recorded.action === "打开页面") continue;
    if (typeof recorded.element !== "string" || !recorded.element) continue;
    const resolvedName = elementNames.get(recorded.element);
    if (resolvedName) assertionElementNames.add(resolvedName);
  }
  const generatedAssertions: FlowStep[] = [...assertionElementNames].map(
    (name, index) => ({
      id: contentId("rec-assert", `${index}\u0000${name}`),
      title: `「${name}」可见`,
      action: "可见性断言",
      element: name,
      value: "",
      assertVisibility: "visible" as const,
      timeout: 10,
      failurePolicy: "立即失败",
      status: "pending" as const,
    }),
  );

  // W2-6：在可见性之外追加「建议草稿」——文本断言（点击 text 定位元素）与
  // 属性断言（填写了非敏感值）。默认不勾选，用户在导入面板自行挑选；
  // 每类上限 10 条，避免超大录制淹没面板。
  const assetByName = new Map(
    result.elements.map((asset) => [String(asset.name), asset] as const),
  );
  const boundStepIds = new Set(Object.keys(secretBindings));
  let suggestionSeq = generatedAssertions.length;
  const suggestionLimit = { text: 10, attribute: 10 };
  for (const recorded of result.steps) {
    if (typeof recorded.element !== "string" || !recorded.element) continue;
    const resolvedName = elementNames.get(recorded.element);
    if (!resolvedName) continue;
    const asset = assetByName.get(String(recorded.element));
    if (!asset) continue;

    if (
      recorded.action === "点击" &&
      suggestionLimit.text > 0 &&
      asset.method === "text" &&
      typeof asset.value === "string" &&
      asset.value.trim().length >= 4
    ) {
      suggestionLimit.text -= 1;
      const snippet = asset.value.trim();
      const seq = suggestionSeq;
      suggestionSeq += 1;
      generatedAssertions.push({
        id: contentId("rec-assert", `${seq}\u0000${resolvedName}\u0000${snippet}`),
        title: `「${resolvedName}」文本包含「${snippet.slice(0, 24)}${snippet.length > 24 ? "…" : ""}」`,
        action: "文本断言",
        element: resolvedName,
        value: snippet,
        assertMatch: "contains",
        timeout: 10,
        failurePolicy: "立即失败",
        status: "pending" as const,
      });
    }

    if (
      recorded.action === "填写" &&
      suggestionLimit.attribute > 0 &&
      !boundStepIds.has(recorded.id) &&
      typeof recorded.value === "string" &&
      recorded.value.trim() !== ""
    ) {
      suggestionLimit.attribute -= 1;
      const snippet = recorded.value.trim();
      const seq = suggestionSeq;
      suggestionSeq += 1;
      generatedAssertions.push({
        id: contentId("rec-assert", `${seq}\u0000${resolvedName}\u0000${snippet}`),
        title: `「${resolvedName}」value 含「${snippet.slice(0, 24)}${snippet.length > 24 ? "…" : ""}」`,
        action: "属性断言",
        element: resolvedName,
        value: snippet,
        assertAttribute: "value",
        assertMatch: "contains",
        timeout: 10,
        failurePolicy: "立即失败",
        status: "pending" as const,
      });
    }
  }

  return { newElements, importedSteps, elementsToValidate, generatedAssertions };
}
