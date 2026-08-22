import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Environment } from "../lib/mock-data";

vi.mock("../lib/antd-feedback", () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
}));

import { environmentNameOptions, testIdAttributeOptions } from "./environment-form-options";
import { EnvironmentDrawer } from "./EnvironmentsPage";

const existingEnvironment: Environment = {
  id: "env-1",
  name: "测试环境",
  description: "运行环境",
  baseUrl: "https://example.test",
  browser: "Chromium",
  auth: "无认证",
  timeout: 30,
  testIdAttribute: "data-cy",
  color: "teal",
  updatedAt: "刚刚",
};

function renderDrawer(environment?: Environment) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <EnvironmentDrawer
      open
      environment={environment}
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { onSave, onClose };
}

describe("环境表单下拉选择", () => {
  it("环境名称下拉包含开发/测试/正式环境选项", () => {
    expect(environmentNameOptions.map((option) => option.value)).toEqual(["开发环境", "测试环境", "正式环境"]);
  });

  it("测试属性名下拉包含常用测试属性选项", () => {
    expect(testIdAttributeOptions.map((option) => option.value)).toEqual(["data-testid", "data-test", "data-cy", "data-qa", "name", "id"]);
  });

  it("新建环境默认测试属性名为 data-testid", () => {
    renderDrawer();
    expect(screen.getByLabelText("测试属性名")).toHaveValue("data-testid");
  });

  it("编辑环境时正确回填现有值", () => {
    renderDrawer(existingEnvironment);
    expect(screen.getByLabelText("环境名称")).toHaveValue("测试环境");
    expect(screen.getByLabelText("测试属性名")).toHaveValue("data-cy");
  });

  it("支持手动输入自定义环境名称与测试属性名并保存", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDrawer();
    const nameInput = screen.getByLabelText("环境名称");
    await user.clear(nameInput);
    await user.type(nameInput, "我的自定义环境");
    const attributeInput = screen.getByLabelText("测试属性名");
    await user.clear(attributeInput);
    await user.type(attributeInput, "data-custom");
    await user.type(screen.getByLabelText("基础地址"), "https://custom.example.test");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as Environment;
    expect(saved.name).toBe("我的自定义环境");
    expect(saved.testIdAttribute).toBe("data-custom");
  });

  it("打开环境名称下拉可看到预设选项", async () => {
    const user = userEvent.setup();
    renderDrawer();
    const nameInput = screen.getByLabelText("环境名称");
    await user.click(nameInput);
    await waitFor(() => expect(screen.getAllByText("正式环境").length).toBeGreaterThan(0));
  });
});