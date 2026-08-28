import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlatformApiError } from "../api/platform-api";
import {
  RunDispatchKeyMap,
  RUN_DISPATCH_KEY_STORAGE,
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

describe("RunDispatchKeyMap persistence (W1-7)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("write-through: set/delete persist to user-scoped storage and survive remount", () => {
    const store = new RunDispatchKeyMap();
    const intentA = runIntentKey({ projectId: "p1", flowId: "flow-a" });
    const intentB = runIntentKey({ projectId: "p1", flowId: "flow-b" });
    const keyA = nextRunDispatchKey(store, intentA);
    nextRunDispatchKey(store, intentB);

    const hydrated = new RunDispatchKeyMap();
    expect(hydrated.get(intentA)).toBe(keyA);
    expect(hydrated.get(intentB)).toBeTruthy();

    // 成功释放后重挂载：key 不再复用（也不会被误吞）。
    releaseRunDispatchKey(store, intentA);
    const remounted = new RunDispatchKeyMap();
    expect(remounted.has(intentA)).toBe(false);
    expect(remounted.has(intentB)).toBe(true);
  });

  it("drops entries older than the 24h TTL on hydration", () => {
    // 先用探针写一条，确定当前用户分区的实际存储键（登录态在测试里未定）。
    const probe = new RunDispatchKeyMap();
    probe.set(runIntentKey({ projectId: "p0", flowId: "flow-probe" }), "web-probe");
    const scopedKey =
      Object.keys(localStorage).find((key) => key.startsWith(RUN_DISPATCH_KEY_STORAGE)) ??
      RUN_DISPATCH_KEY_STORAGE;

    const intent = runIntentKey({ projectId: "p1", flowId: "flow-old" });
    const freshIntent = runIntentKey({ projectId: "p1", flowId: "flow-fresh" });
    const staleAt = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(
      scopedKey,
      JSON.stringify({
        [intent]: { key: "web-stale-key", at: staleAt },
        [freshIntent]: { key: "web-fresh-key", at: Date.now() },
      }),
    );

    const store = new RunDispatchKeyMap();
    expect(store.has(intent)).toBe(false);
    expect(store.get(freshIntent)).toBe("web-fresh-key");
  });
});
