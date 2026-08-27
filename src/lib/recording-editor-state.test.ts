import { beforeEach, describe, expect, it } from "vitest";
import type { ElementAsset } from "./mock-data";
import type { RecordingEvent, RecordingResult } from "../api/platform-api";
import {
  clearStoredRecordingSession,
  isTerminalRecordingStatus,
  mergeRecordingEvents,
  nextRecordingEventPage,
  planRecordingImport,
  recordingSessionStorageKey,
  storeRecordingSessionId,
} from "./recording-editor-state";

const event = (seq: number): RecordingEvent => ({ seq, kind: "proposed_step", warnings: [] });

const existingElement: ElementAsset = {
  id: "existing-login",
  name: "Existing login button",
  description: "",
  path: "/login",
  method: "testid",
  value: "login-submit",
  environment: "env-1",
  validation: "valid",
  updatedAt: "now",
};

const recordingResult: RecordingResult = {
  steps: [
    { id: "open", title: "Open", action: "打开页面", value: "/login?token=discarded#fragment" },
    { id: "password", title: "Password", action: "填写", element: "Password field", value: "plain-text-password" },
    { id: "click", title: "Click", action: "点击", element: "Login button" },
  ],
  elements: [
    { id: "password-field", name: "Password field", path: "/login", method: "testid", value: "password" },
    { id: "login-button", name: "Login button", path: "/login", method: "testid", value: "login-submit" },
  ],
  requiredBindings: [{ stepId: "password", fieldHint: "password" }],
  warnings: [],
  lastSeq: 3,
};

describe("recording editor state", () => {
  beforeEach(() => sessionStorage.clear());

  it("paginates with event cursors and deduplicates a repeated page", () => {
    const firstPage = { events: [event(1), event(2)], lastSeq: 4, hasMore: true };
    const secondPage = { events: [event(2), event(3)], lastSeq: 4, hasMore: false };

    expect(nextRecordingEventPage(0, firstPage)).toBe(2);
    expect(nextRecordingEventPage(2, secondPage)).toBeUndefined();
    expect(mergeRecordingEvents(firstPage.events, secondPage.events).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("does not spin when a malformed paginated response makes no cursor progress", () => {
    expect(nextRecordingEventPage(4, { events: [event(4)], lastSeq: 8, hasMore: true })).toBeUndefined();
  });

  it("recovers only a session id in browser storage and recognizes terminal states", () => {
    const key = recordingSessionStorageKey("project-1", "flow-1");
    storeRecordingSessionId(sessionStorage, key, "recording-session-1");

    expect(sessionStorage.getItem(key)).toBe("recording-session-1");
    expect(JSON.stringify(sessionStorage)).not.toContain("plain-text-password");
    expect(isTerminalRecordingStatus("failed")).toBe(true);
    expect(isTerminalRecordingStatus("interrupted")).toBe(true);
    expect(isTerminalRecordingStatus("paused")).toBe(false);

    clearStoredRecordingSession(sessionStorage, key);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("plans one safe import, reuses matching assets, and binds sensitive values", () => {
    const plan = planRecordingImport(
      recordingResult,
      "env-1",
      [existingElement],
      { password: "project.loginPassword" },
      100,
    );

    expect(plan.newElements).toHaveLength(1);
    expect(plan.elementsToValidate.map((element) => element.name)).toEqual([
      "Password field",
      "Existing login button",
    ]);
    expect(plan.importedSteps.map((step) => step.value)).toEqual([
      "/login",
      "{{project.loginPassword}}",
      "",
    ]);
    expect(plan.importedSteps[2].element).toBe("Existing login button");
    expect(JSON.stringify(plan)).not.toContain("plain-text-password");
  });

  it("generates unchecked visibility assertions per referenced element", () => {
    const plan = planRecordingImport(
      recordingResult,
      "env-1",
      [existingElement],
      { password: "project.loginPassword" },
      100,
    );

    // 每个被非打开页面步骤引用的元素各生成一条候选可见性断言，使用 assertVisibility。
    expect(plan.generatedAssertions.map((step) => step.action)).toEqual([
      "可见性断言",
      "可见性断言",
    ]);
    expect(plan.generatedAssertions.map((step) => step.element)).toEqual([
      "Password field",
      "Existing login button",
    ]);
    expect(plan.generatedAssertions.every((step) => step.assertVisibility === "visible")).toBe(true);
    expect(plan.generatedAssertions.every((step) => step.failurePolicy === "立即失败")).toBe(true);
    // 打开页面步骤不产生断言。
    expect(plan.generatedAssertions.some((step) => step.title.includes("Open"))).toBe(false);
  });

  it("rejects an incomplete binding before planning any draft changes", () => {
    const sourceElements = [existingElement];
    expect(() => planRecordingImport(recordingResult, "env-1", sourceElements, {}, 100))
      .toThrow("RECORDING_SECRET_BINDING_REQUIRED");
    expect(sourceElements).toEqual([existingElement]);
  });

  it("keeps new element ids stable across re-plans and store re-fetches", () => {
    // The import plan is recomputed whenever the workspace sync poll rewrites
    // the element store (new array refs, same content) and at a different
    // clock tick. New-element ids must be derived from the locator content, not
    // from the plan timestamp, otherwise in-flight locator validations and
    // user edits would be keyed to ids that no longer exist and would appear
    // stuck at "校验中" forever.
    const sensitiveStepId = "pass" + "word";
    const bindings = { [sensitiveStepId]: "project.loginPassword" };
    const a = planRecordingImport(recordingResult, "env-1", [existingElement], bindings, 100);
    const b = planRecordingImport(recordingResult, "env-1", [existingElement], bindings, 999_999);
    // Fresh array reference for the same logical element store, as the 30s
    // synchronizer refetch produces.
    const refetched = [{ ...existingElement }];
    const c = planRecordingImport(recordingResult, "env-1", refetched, bindings, 100);

    expect(b.newElements.map((element) => element.id)).toEqual(a.newElements.map((element) => element.id));
    expect(c.newElements.map((element) => element.id)).toEqual(a.newElements.map((element) => element.id));
    // ids are derived from the locator key, not from the plan timestamp
    expect(a.newElements[0].id).not.toContain("100");
    expect(a.newElements[0].id).not.toContain("999999");

    // 步骤与候选断言的 id 同样必须内容派生：FlowEditorPage 在「候选预览」
    // （渲染期 draftPlan）与「确认导入」（importRecordedFlow 重算）各调一次
    // planRecordingImport，若 id 随时钟变化，用户勾选的候选断言会在重算后被
    // 静默丢弃（assertion.id 不再命中 selectedAssertionIds）。
    expect(b.importedSteps.map((step) => step.id)).toEqual(a.importedSteps.map((step) => step.id));
    expect(c.importedSteps.map((step) => step.id)).toEqual(a.importedSteps.map((step) => step.id));
    expect(b.generatedAssertions.map((step) => step.id)).toEqual(a.generatedAssertions.map((step) => step.id));
    expect(c.generatedAssertions.map((step) => step.id)).toEqual(a.generatedAssertions.map((step) => step.id));
    expect(a.importedSteps[0].id).not.toContain("100");
    expect(a.importedSteps[0].id).not.toContain("999999");
    expect(a.generatedAssertions[0].id).not.toContain("100");
    expect(a.generatedAssertions[0].id).not.toContain("999999");
    // 同一计划内步骤与断言 id 必须互不冲突。
    expect(new Set([...a.importedSteps, ...a.generatedAssertions].map((step) => step.id)).size).toBe(
      a.importedSteps.length + a.generatedAssertions.length,
    );
  });

  it("suggests text assertions for clicked text-located elements (W2-6)", () => {
    const result: RecordingResult = {
      ...recordingResult,
      steps: [
        { id: "open", title: "Open", action: "打开页面", value: "/" },
        { id: "click-text", title: "Click text", action: "点击", element: "Text button" },
      ],
      elements: [
        { id: "text-btn", name: "Text button", path: "/login", method: "text", value: "确认提交订单并支付" },
      ],
      requiredBindings: [],
    };
    const plan = planRecordingImport(result, "env-1", [], {}, 100);
    const visibility = plan.generatedAssertions.filter((a) => a.action === "可见性断言");
    const suggestions = plan.generatedAssertions.filter((a) => a.action === "文本断言");
    expect(visibility.map((a) => a.element)).toEqual(["Text button"]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      element: "Text button",
      assertMatch: "contains",
      value: "确认提交订单并支付",
    });
  });

  it("skips attribute suggestion for secret-bound fills (W2-6)", () => {
    // 密码步骤有绑定 → 不生成属性断言建议（明文值不应被断言固化）。
    const bindings = { password: "project.loginPassword" };
    const plan = planRecordingImport(recordingResult, "env-1", [], bindings, 100);
    const valueSuggestions = plan.generatedAssertions.filter(
      (a) => a.action === "属性断言",
    );
    expect(valueSuggestions).toEqual([]);
  });

  it("caps per-type assertion suggestions at ten (W2-6)", () => {
    const manySteps = Array.from({ length: 14 }, (_, index) => ({
      id: `click-${index}`,
      title: `Click ${index}`,
      action: "点击",
      element: `按钮 ${index}`,
    }));
    const manyElements = Array.from({ length: 14 }, (_, index) => ({
      id: `btn-${index}`,
      name: `按钮 ${index}`,
      path: "/x",
      method: "text",
      value: `订单确认按钮文字示例第${index}号`,
    }));
    const result: RecordingResult = {
      steps: [{ id: "open", title: "Open", action: "打开页面", value: "/" }, ...manySteps],
      elements: manyElements,
      requiredBindings: [],
      warnings: [],
      lastSeq: 15,
    };
    const plan = planRecordingImport(result, "env-1", [], {}, 100);
    expect(plan.generatedAssertions.filter((a) => a.action === "文本断言")).toHaveLength(10);
    expect(plan.generatedAssertions.filter((a) => a.action === "可见性断言")).toHaveLength(14);
  });
});
