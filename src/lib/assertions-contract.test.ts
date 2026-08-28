import { describe, expect, it } from "vitest";
import {
  ASSERT_ATTRIBUTE_DEFAULT,
  ASSERTION_ACTIONS,
  ASSERT_MATCHES,
  ASSERT_OPERATORS,
  ASSERT_VISIBILITIES,
} from "../domain/assertions";
import { actionOptions } from "../domain/model";

/**
 * 前端侧跨层 parity：`src/domain/assertions.ts` 必须与契约文档
 * `.trellis/spec/backend/assertion-field-contract.md` 一致（后端
 * `assertion_contract.py` 由 Python parity 测试兜底）。枚举漂移即红。
 */
describe("断言字段契约（前端单源）", () => {
  it("匹配方式/可见性/比较符/属性缺省与契约一致", () => {
    expect([...ASSERT_MATCHES]).toEqual(["exact", "contains"]);
    expect([...ASSERT_VISIBILITIES]).toEqual(["visible", "hidden"]);
    expect([...ASSERT_OPERATORS]).toEqual(["=", ">", "<", ">=", "<="]);
    expect(ASSERT_ATTRIBUTE_DEFAULT).toBe("value");
  });

  it("动作->判定 type 映射与契约一致，且覆盖 actionOptions 全部断言动作", () => {
    expect(ASSERTION_ACTIONS).toEqual({
      "可见性断言": "visibility",
      "文本断言": "text",
      "数量断言": "count",
      "属性断言": "attribute",
      "URL 断言": "url",
    });
    const assertionActions = actionOptions.filter((action) => action.includes("断言"));
    expect(Object.keys(ASSERTION_ACTIONS).sort()).toEqual([...assertionActions].sort());
  });
});
