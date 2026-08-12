import { describe, expect, it } from "vitest";
import type { Project } from "../mock-data";
import { sectionMeta } from "./shared";
import { platformTabItems } from "./PlatformPage";

const project: Project = { id: "p-1", name: "Demo", description: "" };

describe("平台入口收敛（方案C 裁剪后）", () => {
  it("侧边栏入口名为「平台」，「发布与运行」为执行入口", () => {
    expect(sectionMeta.platform.label).toBe("平台");
    expect(sectionMeta.agents.label).toBe("发布与运行");
    expect("debug" in sectionMeta).toBe(false);
  });

  it("production 下平台页仅含发布与运行（数据集/持续回归/治理分析以侧边栏为主入口）", () => {
    const keys = platformTabItems(true, project).map((item) => item.key);
    expect(keys).toEqual(["publish"]);
  });

  it("dev 下保留数据集/持续回归/治理分析 Tab 以维持可达性", () => {
    const keys = platformTabItems(false, project).map((item) => item.key);
    expect(keys).toEqual(["publish", "data", "automation", "governance"]);
  });

  it("两个模式下发布与运行均可达", () => {
    for (const production of [true, false]) {
      const keys = platformTabItems(production, project).map((item) => item.key);
      expect(keys).toContain("publish");
    }
  });
});
