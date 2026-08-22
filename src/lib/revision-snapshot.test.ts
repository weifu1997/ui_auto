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

import type { Variable, ElementAsset } from "./mock-data";
import {
  variableReference,
  requiredSecretVariables,
  snapshotVariables,
  revisionInput,
} from "./revision-snapshot";

describe("revision input builder and variable helpers", () => {
  const vars: Variable[] = [
    { id: "v1", name: "token", description: "", scope: "项目", secret: true, value: "secret-token", updatedAt: "刚刚" },
    { id: "v2", name: "baseUrl", description: "", scope: "环境", secret: false, value: "https://api.test", updatedAt: "刚刚" },
    { id: "v3", name: "globalKey", description: "", scope: "内置", secret: false, value: "none", updatedAt: "刚刚" },
  ];

  it("computes variable reference correctly", () => {
    expect(variableReference(vars[0])).toBe("project.token");
    expect(variableReference(vars[1])).toBe("env.baseUrl");
  });

  it("filters required secret variables used in step placeholders", () => {
    const stepsWithSecret: FlowStep[] = [
      { id: "s1", title: "步骤1", action: "填写", value: "Bearer {{project.token}}", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      { id: "s2", title: "步骤2", action: "打开页面", value: "{{env.baseUrl}}/home", timeout: 10, failurePolicy: "立即失败", status: "pending" },
    ];
    const req = requiredSecretVariables(vars, stepsWithSecret);
    expect(req.map((v) => v.id)).toEqual(["v1"]);
  });

  it("extracts non-secret project/env variables into snapshot", () => {
    const snapshotVars = snapshotVariables(vars);
    expect(snapshotVars).toEqual({
      "env.baseUrl": "https://api.test",
    });
  });

  it("constructs full revision input payload with matching environment elements", () => {
    const elems: ElementAsset[] = [
      { id: "e1", name: "Btn1", description: "", path: "/1", method: "css", value: "#b1", environment: "env-1", validation: "valid", updatedAt: "刚刚" },
      { id: "e2", name: "Btn2", description: "", path: "/2", method: "css", value: "#b2", environment: "env-other", validation: "valid", updatedAt: "刚刚" },
      { id: "e3", name: "Btn3", description: "", path: "/3", method: "css", value: "#b3", environment: "", validation: "valid", updatedAt: "刚刚" },
    ];
    const payload = revisionInput(flow, environment, elems, vars);
    expect(payload.environment.id).toBe("env-1");
    expect(payload.elements.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(payload.flow.id).toBe("flow-1");
    expect(payload.flow.variables).toEqual({ "env.baseUrl": "https://api.test" });
  });
});
