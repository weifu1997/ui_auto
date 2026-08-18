import { beforeEach, describe, expect, it } from "vitest";
import type { ElementAsset } from "./mock-data";
import type { RecordingEvent, RecordingResult } from "./platform-api";
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

  it("rejects an incomplete binding before planning any draft changes", () => {
    const sourceElements = [existingElement];
    expect(() => planRecordingImport(recordingResult, "env-1", sourceElements, {}, 100))
      .toThrow("RECORDING_SECRET_BINDING_REQUIRED");
    expect(sourceElements).toEqual([existingElement]);
  });
});
