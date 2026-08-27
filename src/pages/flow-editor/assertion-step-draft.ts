import { useCallback } from "react";
import type { FlowStep } from "../../lib/mock-data";

// 断言字段互斥：每个字段只属于一种断言类型。切换动作时清掉不属于新动作的字段，
// 避免跨类型字段残留（后端跨类型误值回落默认，但编辑器不应让用户配置出这种状态）。
const ASSERTION_FIELDS = [
  "assertMatch",
  "assertVisibility",
  "assertOperator",
  "assertAttribute",
] as const;

export function staleAssertionFields(action: string): Partial<FlowStep> {
  const clear = (name: (typeof ASSERTION_FIELDS)[number]): Partial<FlowStep> => ({
    [name]: undefined,
  });
  if (action === "文本断言") {
    // 文本断言仅保留 assertMatch。
    return { ...clear("assertVisibility"), ...clear("assertOperator"), ...clear("assertAttribute") };
  }
  if (action === "属性断言") {
    // 属性断言保留 assertMatch + assertAttribute。
    return { ...clear("assertVisibility"), ...clear("assertOperator") };
  }
  if (action === "数量断言") {
    return { ...clear("assertMatch"), ...clear("assertVisibility"), ...clear("assertAttribute") };
  }
  if (action === "可见性断言") {
    return { ...clear("assertMatch"), ...clear("assertOperator"), ...clear("assertAttribute") };
  }
  // 非断言动作：全部清除。
  return {
    assertMatch: undefined,
    assertVisibility: undefined,
    assertOperator: undefined,
    assertAttribute: undefined,
  };
}

/**
 * 断言步骤编辑 draft hook：集中「跨类型断言字段互斥」规则。
 *
 * 编辑保持受控（补丁直接回调 onChange），互斥规则收敛于此——切换动作时由本 hook
 * 清掉不属于新动作的断言字段（对应 .trellis/spec/backend/assertion-field-contract.md
 * 的字段归属语义，前端在配置期即避免产生后端回落缺省的跨类型状态）。
 */
export function useAssertionStepDraft(onChange: (patch: Partial<FlowStep>) => void) {
  return useCallback(
    (action: string) => onChange({ action, title: action, ...staleAssertionFields(action) }),
    [onChange],
  );
}
