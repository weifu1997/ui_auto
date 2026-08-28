import type { ElementAsset } from "../../lib/mock-data";

export type ElementValidationStatus =
  | "pending"
  | "running"
  | "success"
  | "ambiguous"
  | "missed"
  | "error";

export type ElementValidationResult = {
  status: ElementValidationStatus;
  count?: number;
  errorMessage?: string;
  /** 校验落在登录墙上：元素位于登录后才能访问的页面，需要登录态。 */
  loginBlocked?: boolean;
};

export type ElementEditPatch = {
  path?: string;
  method?: ElementAsset["method"];
  value?: string;
  environment?: string;
};

export type ValidationTotals = Record<ElementValidationStatus, number>;

export const emptyValidationResults: Record<string, ElementValidationResult> = {};
export const emptyElementEdits: Record<string, Partial<ElementAsset>> = {};

// 服务端按 workspace 串行执行校验，单个任务实测可达 ~50s，批量时按队列顺序
// 依次完成（第 k 个约在 k×~50s）。用 7.5 分钟墙钟上限覆盖常见批次的排队耗时，
// 避免「前端放弃轮询、服务端仍在跑」导致的假性「校验中」滞留。
export const VALIDATION_DEADLINE_MS = 7 * 60_000 + 30_000;

export function mergeElementEdits(
  element: ElementAsset,
  edits: Record<string, Partial<ElementAsset>>,
): ElementAsset {
  const patch = edits[element.id];
  if (!patch) return element;
  return { ...element, ...patch };
}

export function elementValidationLabel(result: ElementValidationResult, validated: boolean) {
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
