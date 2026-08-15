import { describe, expect, it } from "vitest";
import type { Environment, Flow, FlowStep } from "./mock-data";
import { revisionElements, revisionEnvironment, revisionFlow } from "./revision-snapshot";

const step: FlowStep = {
  id: "step-1",
  title: "打开",
  action: "打开页面",
  value: "/",
  timeout: 30,
  failurePolicy: "立即失败",
  status: "success",
};

const flow: Flow = {
  id: "flow-1",
  name: "Flow",
  description: "Description",
  tags: ["regression"],
  steps: 1,
  definition: [step],
  lastStatus: "queued",
  updatedAt: "刚刚",
};

const environment: Environment = {
  id: "env-1",
  name: "Env",
  description: "Description",
  baseUrl: "https://example.test",
  browser: "Chromium",
  auth: "无认证",
  timeout: 30,
  testIdAttribute: "data-testid",
  keepBrowserOpenOnFailure: false,
  color: "teal",
  updatedAt: "刚刚",
};

describe("revision snapshot payload", () => {
  it("removes display and transient fields from the revision flow", () => {
    const payload = revisionFlow(flow, { "project.username": "user" });
    expect(payload).not.toHaveProperty("tags");
    expect(payload).not.toHaveProperty("lastStatus");
    expect(payload).not.toHaveProperty("updatedAt");
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(payload.steps).toHaveLength(1);
    expect(payload.steps[0]).not.toHaveProperty("status");
    expect(payload.steps[0]).toMatchObject({
      id: "step-1",
      action: "打开页面",
      value: "/",
      timeout: 30,
    });
  });

  it("keeps only execution and display metadata for environment", () => {
    const payload = revisionEnvironment(environment);
    expect(payload).not.toHaveProperty("updatedAt");
    expect(payload).not.toHaveProperty("color");
    expect(payload).not.toHaveProperty("description");
    expect(payload).toMatchObject({
      id: "env-1",
      baseUrl: "https://example.test",
      timeout: 30,
    });
  });

  it("sorts elements and excludes validation state", () => {
    const payload = revisionElements([
      { id: "b", name: "B", description: "", path: "/b", method: "testid", value: "b", environment: "env-1", validation: "unverified", updatedAt: "刚刚" },
      { id: "a", name: "A", description: "", path: "/a", method: "testid", value: "a", environment: "env-1", validation: "valid", updatedAt: "刚刚" },
    ]);
    expect(payload.map((item) => item.id)).toEqual(["a", "b"]);
    expect(payload[0]).not.toHaveProperty("validation");
    expect(payload[0]).not.toHaveProperty("updatedAt");
    expect(payload[0]).not.toHaveProperty("description");
  });
});
