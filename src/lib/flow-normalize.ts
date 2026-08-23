import type { Flow, FlowStep, RunStatus } from "./mock-data";

// Flow 资源由不同写入方产生：编排器保存的是完整格式，而模板应用写入的
// 是快照格式（steps 为数组、缺 tags/lastStatus/updatedAt）。统一归一化成
// 页面消费的 Flow 形状，避免渲染对缺失字段调用 map 时崩溃。
const runStatuses = new Set<RunStatus>(["success", "failed", "running", "queued", "canceled"]);

function normalizeStep(raw: unknown): FlowStep {
  if (!raw || typeof raw !== "object") {
    return { id: "", title: "录制步骤", action: "", value: "", timeout: 10, failurePolicy: "立即失败", status: "pending" };
  }
  const step = raw as Record<string, unknown>;
  const action = typeof step.action === "string" ? step.action : "";
  const assertMatch = step.assertMatch;
  const assertVisibility = step.assertVisibility;
  const assertOperator = step.assertOperator;
  const assertAttribute = step.assertAttribute;
  return {
    ...step,
    id: typeof step.id === "string" ? step.id : "",
    title:
      typeof step.title === "string" && step.title !== ""
        ? step.title
        : action || "录制步骤",
    action,
    value: typeof step.value === "string" ? step.value : "",
    timeout: typeof step.timeout === "number" ? step.timeout : 10,
    failurePolicy:
      typeof step.failurePolicy === "string" ? step.failurePolicy : "立即失败",
    status:
      step.status === "success" || step.status === "failed" ? step.status : "pending",
    // 断言字段：仅接受各自枚举/类型内的合法值，非法数据回落 undefined（缺省语义由后端执行时兜底）。
    assertMatch: assertMatch === "exact" || assertMatch === "contains" ? assertMatch : undefined,
    assertVisibility:
      assertVisibility === "visible" || assertVisibility === "hidden"
        ? assertVisibility
        : undefined,
    assertOperator:
      assertOperator === "=" || assertOperator === ">" || assertOperator === "<" ||
      assertOperator === ">=" || assertOperator === "<="
        ? assertOperator
        : undefined,
    assertAttribute:
      typeof assertAttribute === "string" && assertAttribute !== ""
        ? assertAttribute
        : undefined,
  };
}

export function normalizeFlow(raw: unknown): Flow {
  const flow = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const definition = Array.isArray(flow.definition)
    ? flow.definition
    : Array.isArray(flow.steps)
      ? flow.steps
      : undefined;
  const stepCount =
    typeof flow.steps === "number" ? flow.steps : (definition?.length ?? 0);
  return {
    id: typeof flow.id === "string" ? flow.id : "",
    name: typeof flow.name === "string" ? flow.name : "未命名流程",
    description: typeof flow.description === "string" ? flow.description : "",
    tags: Array.isArray(flow.tags)
      ? flow.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    steps: stepCount,
    definition: definition ? definition.map(normalizeStep) : undefined,
    lastStatus:
      typeof flow.lastStatus === "string" &&
      runStatuses.has(flow.lastStatus as RunStatus)
        ? (flow.lastStatus as RunStatus)
        : "queued",
    updatedAt: typeof flow.updatedAt === "string" ? flow.updatedAt : "刚刚",
  };
}
