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
  });
});
