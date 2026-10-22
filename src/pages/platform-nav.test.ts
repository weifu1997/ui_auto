import { describe, expect, it } from "vitest";
import { projectNavSections, sectionMeta } from "./shared";

describe("项目导航", () => {
  it("侧边栏只保留概览到审计这 9 个入口", () => {
    expect(projectNavSections.map((key) => sectionMeta[key].label)).toEqual([
      "概览",
      "流程",
      "元素库",
      "变量",
      "环境",
      "数据集",
      "运行中心",
      "持续回归",
      "审计",
    ]);
    expect(Object.keys(sectionMeta)).not.toEqual(expect.arrayContaining(["platform", "agents", "settings"]));
    expect([...projectNavSections]).not.toEqual(expect.arrayContaining(["platform", "agents", "settings"]));
  });
});
