import { describe, expect, it } from "vitest";
import type { Project } from "../mock-data";
import { sectionMeta } from "./shared";
import { platformTabItems } from "./PlatformPage";

const project: Project = { id: "p-1", name: "Demo", description: "" };

describe("发布管理入口收敛（B1）", () => {
  it("侧边栏入口更名为「平台」", () => {
    expect(sectionMeta.platform.label).toBe("平台");
  });

  it("production 下平台页仅含发布与远程运行 / 远程调试（数据集/持续回归/治理分析以侧边栏为主入口）", () => {
    const keys = platformTabItems(true, project).map((item) => item.key);
    expect(keys).toEqual(["publish", "debug"]);
  });

  it("dev 下保留数据集/持续回归/治理分析 Tab 以维持可达性", () => {
    const keys = platformTabItems(false, project).map((item) => item.key);
    expect(keys).toEqual(["publish", "debug", "data", "automation", "governance"]);
  });

  it("两个模式下 发布与远程运行 / 远程调试 均可达", () => {
    for (const production of [true, false]) {
      const keys = platformTabItems(production, project).map((item) => item.key);
      expect(keys).toContain("publish");
      expect(keys).toContain("debug");
    }
  });
});