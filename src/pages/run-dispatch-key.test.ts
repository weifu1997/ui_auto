import { describe, expect, it } from "vitest";
import { PlatformApiError } from "../api/platform-api";
import {
  nextRunDispatchKey,
  releaseRunDispatchKey,
  runIntentKey,
} from "./shared";

describe("runIntentKey", () => {
  it("distinguishes different dispatch intents", () => {
    const flowA = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    const flowB = runIntentKey({ projectId: "p1", flowId: "flow-b" });
    expect(flowA).not.toBe(flowB);

    const stepFull = runIntentKey({ projectId: "p1", flowId: "flow-a", upToStepId: "s-1" });
    const stepNone = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    expect(stepFull).not.toBe(stepNone);

    const revision = runIntentKey({ projectId: "p1", revisionId: "rev-1" });
    const flow = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    expect(revision).not.toBe(flow);

    const retry = runIntentKey({ projectId: "p1", runId: "run-1" });
    expect(retry).not.toBe(flow);
  });

  it("scopes by projectId", () => {
    const a = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    const b = runIntentKey({ projectId: "p2", flowId: "flow-a" });
    expect(a).not.toBe(b);
  });
});

describe("nextRunDispatchKey / releaseRunDispatchKey", () => {
  it("keeps the same key per intent and splits across intents", () => {
    const map = new Map<string, string>();
    const intentA = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    const intentB = runIntentKey({ projectId: "p1", flowId: "flow-b" });
    const keyA1 = nextRunDispatchKey(map, intentA);
    const keyA2 = nextRunDispatchKey(map, intentA);
    const keyB = nextRunDispatchKey(map, intentB);
    expect(keyA1).toBe(keyA2);
    expect(keyB).not.toBe(keyA1);
  });

  it("releases the key on success", () => {
    const map = new Map<string, string>();
    const intent = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    const key = nextRunDispatchKey(map, intent);
    releaseRunDispatchKey(map, intent);
    expect(map.has(intent)).toBe(false);
    expect(nextRunDispatchKey(map, intent)).not.toBe(key);
  });

  it("keeps the key on network/5xx errors and releases on 4xx", () => {
    const map = new Map<string, string>();
    const intent = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    const key = nextRunDispatchKey(map, intent);

    releaseRunDispatchKey(map, intent, new TypeError("Network failure"));
    expect(map.get(intent)).toBe(key);

    releaseRunDispatchKey(map, intent, new PlatformApiError(503, "UPSTREAM_DOWN"));
    expect(map.get(intent)).toBe(key);

    releaseRunDispatchKey(map, intent, new PlatformApiError(409, "RUN_NOT_RETRYABLE"));
    expect(map.has(intent)).toBe(false);
  });
});
