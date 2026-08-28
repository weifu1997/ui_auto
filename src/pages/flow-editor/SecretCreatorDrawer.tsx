import { useEffect } from "react";
import { Button, Drawer, Form, Input, Select } from "antd";
import { useSecretStore } from "../../stores/secret-store";
import { message } from "../../lib/antd-feedback";
import { uniqueVariableNameValidator } from "../shared";
import type { Project, Variable } from "../../lib/mock-data";

export type RecordingBinding = {
  stepId: string;
  fieldHint: string;
};

function suggestSecretNameFromHint(fieldHint: string, variables: Variable[], scope: Variable["scope"] = "项目"): string {
  const lower = fieldHint.toLowerCase();
  let base = "secret";
  if (/密码|password|passwd|pwd/.test(lower)) base = "password";
  else if (/token/.test(lower)) base = "api_token";
  else if (/密钥|secret|key/.test(lower)) base = "secret_key";
  else if (/用户名|登录|登录名|user|account|login/.test(lower)) base = "username";
  else {
    const cleaned = fieldHint.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, "_").replace(/^_+|_+$/g, "");
    if (cleaned.length > 0 && cleaned.length <= 32) base = cleaned;
  }
  const existSet = new Set(
    variables.filter((variable) => variable.scope === scope).map((variable) => variable.name),
  );
  if (!existSet.has(base)) return base;
  let suffix = 2;
  while (existSet.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function SecretCreatorDrawer({
  open,
  project,
  variables,
  stepBinding,
  onClose,
  onCreated,
}: {
  open: boolean;
  project: Project;
  variables: Variable[];
  stepBinding: RecordingBinding | null;
  onClose: () => void;
  onCreated: (variable: Variable) => void;
}) {
  const [form] = Form.useForm();
  const scope = Form.useWatch("scope", form) ?? "项目";
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ scope: "项目", description: stepBinding?.fieldHint ?? "" });
    // 根据 scope 和 hint 智能推断默认名称（去重）
    const defaultScope: Variable["scope"] = "项目";
    const defaultName = stepBinding
      ? suggestSecretNameFromHint(stepBinding.fieldHint, variables, defaultScope)
      : suggestSecretNameFromHint("", variables, defaultScope);
    form.setFieldsValue({ scope: defaultScope, name: defaultName, description: stepBinding?.fieldHint ?? "" });
  }, [form, open, stepBinding, variables]);
  return (
    <Drawer
      title={stepBinding ? `为「${stepBinding.fieldHint}」新建 secret` : "新建 secret 变量"}
      open={open}
      size={480}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          onClick={() =>
            form
              .validateFields()
              .then((values) => {
                const id = `var-${Date.now()}`;
                if (typeof values.value === "string" && values.value.trim()) {
                  useSecretStore.getState().setValues(project.id, { [id]: values.value });
                  message.info("密钥已注入当前会话（刷新后失效），不会保存到存储");
                }
                onCreated({
                  id,
                  name: values.name.trim(),
                  description: values.description?.trim() || stepBinding?.fieldHint || "项目变量",
                  value: "",
                  scope: values.scope,
                  secret: true,
                  updatedAt: "刚刚",
                });
              })
          }
        >
          创建并绑定
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="变量名"
          dependencies={["scope"]}
          validateTrigger={["onChange", "onBlur"]}
          rules={[
            { required: true, message: "请输入变量名" },
            { validator: uniqueVariableNameValidator(variables, scope) },
          ]}
          extra={`引用格式：{{${scope === "环境" ? "env" : "project"}.变量名}}`}
        >
          <Input placeholder="例如：password" />
        </Form.Item>
        <Form.Item name="scope" label="作用域">
          <Select
            options={[
              { value: "项目", label: "项目变量" },
              { value: "环境", label: "环境变量" },
            ]}
          />
        </Form.Item>
        <Form.Item name="value" label="值" rules={[{ required: true, message: "请输入密钥值" }]}>
          <Input.Password placeholder="密钥不会保存：仅注入当前会话，刷新后失效" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="说明变量的业务用途" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
