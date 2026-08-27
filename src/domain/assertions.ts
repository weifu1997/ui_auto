/**
 * 断言字段契约（前端单一模块）。
 *
 * 权威来源: `.trellis/spec/backend/assertion-field-contract.md`。
 * 后端对应: `server-py/autoflow/assertion_contract.py`。跨层 parity:
 * - `src/lib/assertions-contract.test.ts`（本模块常量与契约文档一致）
 * - `server-py/tests/unit/test_assertion_contract.py`
 * - e2e `assertion-contract.spec.ts`（两端动作映射一致）
 *
 * 新增断言字段必须先更新契约文档，再同步本模块与后端 `assertion_contract.py`、
 * `revision_snapshot.STEP_KEYS`；任一端枚举漂移对应 parity 测试即红。
 */

/** 匹配方式（文本/属性断言），缺省 contains。 */
export const ASSERT_MATCHES = ["exact", "contains"] as const;
export type AssertMatch = (typeof ASSERT_MATCHES)[number];

/** 可见性（可见性断言），缺省 visible。 */
export const ASSERT_VISIBILITIES = ["visible", "hidden"] as const;
export type AssertVisibility = (typeof ASSERT_VISIBILITIES)[number];

/** 计数比较符（数量断言），缺省 =。 */
export const ASSERT_OPERATORS = ["=", ">", "<", ">=", "<="] as const;
export type AssertOperator = (typeof ASSERT_OPERATORS)[number];

/** 属性名缺省（属性断言）。 */
export const ASSERT_ATTRIBUTE_DEFAULT = "value";

/** 动作 -> 判定 type（`step.asserted` 事件与 `result.assertions` 载荷的统一标识）。 */
export const ASSERTION_ACTIONS = {
  "可见性断言": "visibility",
  "文本断言": "text",
  "数量断言": "count",
  "属性断言": "attribute",
  "URL 断言": "url",
} as const;
export type AssertionType = (typeof ASSERTION_ACTIONS)[keyof typeof ASSERTION_ACTIONS];

/** 类型收窄守卫：校验值属于对应枚举（供流程归一化等消费方做运行时白名单）。 */
export function isAssertMatch(value: unknown): value is AssertMatch {
  return (ASSERT_MATCHES as readonly unknown[]).includes(value);
}

export function isAssertVisibility(value: unknown): value is AssertVisibility {
  return (ASSERT_VISIBILITIES as readonly unknown[]).includes(value);
}

export function isAssertOperator(value: unknown): value is AssertOperator {
  return (ASSERT_OPERATORS as readonly unknown[]).includes(value);
}
