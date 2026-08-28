import { describe, expect, it } from "vitest";
import { staleAssertionFields } from "./assertion-step-draft";

describe("staleAssertionFields", () => {
  it("keeps trimCompare only for text assertions", () => {
    expect(staleAssertionFields("文本断言")).toEqual({
      assertVisibility: undefined,
      assertOperator: undefined,
      assertAttribute: undefined,
    });
  });

  it("clears trimCompare when switching to other assertion actions", () => {
    for (const action of ["属性断言", "数量断言", "可见性断言", "URL 断言"]) {
      expect(staleAssertionFields(action)).toMatchObject({
        trimCompare: undefined,
      });
    }
  });

  it("clears every assertion field for non-assertion actions", () => {
    expect(staleAssertionFields("点击")).toEqual({
      assertMatch: undefined,
      assertVisibility: undefined,
      assertOperator: undefined,
      assertAttribute: undefined,
      trimCompare: undefined,
    });
  });
});
