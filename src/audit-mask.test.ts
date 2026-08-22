import { describe, expect, it } from "vitest";
import { maskAuditDetail } from "./audit-mask";

describe("maskAuditDetail", () => {
  it("掩码敏感键值并保留普通字段", () => {
    expect(maskAuditDetail({ url: "https://example.com", channelName: "值班群", code: 19024, error: null }))
      .toEqual({ url: "******", channelName: "值班群", code: 19024, error: null });
  });

  it("掩码常见凭据类键名变体", () => {
    expect(
      maskAuditDetail({
        apiKey: "ak-1",
        api_key: "ak-2",
        accessKey: "ak-3",
        access_key_id: "ak-4",
        privateKey: "pk-1",
        Authorization: "Bearer x",
        cookie: "sid=1",
        sessionId: "s-1",
        displayName: "值班群",
      }),
    ).toEqual({
      apiKey: "******",
      api_key: "******",
      accessKey: "******",
      access_key_id: "******",
      privateKey: "******",
      Authorization: "******",
      cookie: "******",
      sessionId: "******",
      displayName: "值班群",
    });
  });

  it("递归处理嵌套对象与数组", () => {
    expect(maskAuditDetail({ names: ["SECRET_A"], nested: { signingSecret: "abc", ok: 1 }, list: [{ keyword: "股票日报" }] }))
      .toEqual({ names: ["SECRET_A"], nested: { signingSecret: "******", ok: 1 }, list: [{ keyword: "******" }] });
  });

  it("普通标量原样返回", () => {
    expect(maskAuditDetail("hello")).toBe("hello");
    expect(maskAuditDetail(42)).toBe(42);
    expect(maskAuditDetail(null)).toBe(null);
    expect(maskAuditDetail(undefined)).toBe(undefined);
  });

  it("空对象与空数组不变", () => {
    expect(maskAuditDetail({})).toEqual({});
    expect(maskAuditDetail([])).toEqual([]);
  });
});
