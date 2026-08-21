import { describe, expect, it } from "vitest";
import {
  ELEMENT_VALIDATION_LOGIN_INVALID,
  ELEMENT_VALIDATION_LOGIN_REQUIRED,
  elementValidationLoginMessage,
} from "./element-validation";

describe("elementValidationLoginMessage", () => {
  it("maps the required-login code to an actionable instruction", () => {
    const message = elementValidationLoginMessage(ELEMENT_VALIDATION_LOGIN_REQUIRED);
    expect(message).toContain("登录");
    expect(message).toContain("录制");
  });

  it("maps the stale-snapshot code to a re-record instruction", () => {
    const message = elementValidationLoginMessage(ELEMENT_VALIDATION_LOGIN_INVALID);
    expect(message).toContain("失效");
    expect(message).toContain("重新");
  });

  it("returns null for unrelated or missing errors", () => {
    expect(elementValidationLoginMessage("VALIDATION_CANCELED")).toBeNull();
    expect(elementValidationLoginMessage("TIMEOUT")).toBeNull();
    expect(elementValidationLoginMessage(undefined)).toBeNull();
  });
});
