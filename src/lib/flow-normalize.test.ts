import { describe, expect, it } from "vitest";
import { normalizeFlow } from "./flow-normalize";

describe("normalizeFlow", () => {
  it("keeps a canonical flow resource unchanged in meaning", () => {
    const flow = normalizeFlow({
      id: "flow-1",
      name: "登录",
      description: "说明",
      tags: ["冒烟"],
      steps: 2,
      definition: [
        { id: "s1", title: "打开页面", action: "打开页面", value: "/", timeout: 10, failurePolicy: "立即失败", status: "pending" },
      ],
      lastStatus: "running",
      updatedAt: "刚刚",
    });
    expect(flow).toMatchObject({
      id: "flow-1",
      name: "登录",
      description: "说明",
      tags: ["冒烟"],
      steps: 2,
      lastStatus: "running",
      updatedAt: "刚刚",
    });
    expect(flow.definition).toHaveLength(1);
  });

  it("fills defaults for a snapshot-format flow resource (template apply)", () => {
    const flow = normalizeFlow({
      id: "743bbe8c-d02a-4cbf-b242-b5dea5aa8e4f",
      name: "登录",
      description: "尚未添加说明",
      steps: [
        { id: "s1", action: "打开页面", value: "https://example.test/", timeout: 10, failurePolicy: "立即失败" },
        { id: "s2", action: "点击", element: "登录按钮", value: "", timeout: 10, failurePolicy: "立即失败" },
      ],
      variables: {},
      secretNames: [],
    });
    expect(flow.tags).toEqual([]);
    expect(flow.steps).toBe(2);
    expect(flow.lastStatus).toBe("queued");
    expect(flow.updatedAt).toBe("刚刚");
    expect(flow.definition).toHaveLength(2);
    // 快照步骤缺少展示字段，归一化后补上默认值，且保留原始字段。
    expect(flow.definition?.[0]).toMatchObject({
      id: "s1",
      action: "打开页面",
      title: "打开页面",
      status: "pending",
      timeout: 10,
    });
    expect(flow.definition?.[1]).toMatchObject({ element: "登录按钮", title: "点击" });
  });

  it("preserves template extension fields variables and secretNames (W2-4)", () => {
    const flow = normalizeFlow({
      id: "flow-tpl",
      steps: [{ id: "s1", action: "打开页面", value: "/" }],
      variables: { "env.账号": "demo" },
      secretNames: ["token"],
    });
    expect(flow.variables).toEqual({ "env.账号": "demo" });
    expect(flow.secretNames).toEqual(["token"]);
  });

  it("passes through unknown top-level keys so sequential edits cannot drop them (W2-4)", () => {
    const flow = normalizeFlow({
      id: "flow-future",
      name: "未来版本流程",
      futureMetadata: { sourceWriter: "v-next", flag: true },
    });
    expect((flow as unknown as Record<string, unknown>).futureMetadata).toEqual({
      sourceWriter: "v-next",
      flag: true,
    });
  });

  it("coerces non-string variable values out of the passthrough typed field", () => {
    const flow = normalizeFlow({
      id: "flow-vars",
      variables: { ok: "1", bad: 42, nested: { x: 1 } } as Record<string, unknown>,
      secretNames: ["a", 3, null] as unknown[],
    });
    expect(flow.variables).toEqual({ ok: "1" });
    expect(flow.secretNames).toEqual(["a"]);
  });

  it("does not crash on malformed or empty input", () => {
    expect(normalizeFlow(undefined)).toMatchObject({ tags: [], steps: 0, lastStatus: "queued" });
    expect(normalizeFlow(null)).toMatchObject({ tags: [], steps: 0 });
    expect(normalizeFlow({})).toMatchObject({ name: "未命名流程", tags: [], steps: 0 });
  });

  it("coerces invalid tags and status to safe defaults", () => {
    const flow = normalizeFlow({
      id: "flow-x",
      tags: ["冒烟", 42, null],
      steps: "3",
      lastStatus: "bogus",
    });
    expect(flow.tags).toEqual(["冒烟"]);
    expect(flow.steps).toBe(0);
    expect(flow.lastStatus).toBe("queued");
  });
});
