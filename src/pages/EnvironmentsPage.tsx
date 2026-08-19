import { message } from "../antd-feedback";
import type { Environment, Project } from "../mock-data";
import { PageHeading, emptyEnvironments, uniqueNameValidator } from "./shared";
import { useWorkspaceStore } from "../workspace-store";
import { GlobalOutlined, MoreOutlined, PlusOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Drawer, Dropdown, Empty, Form, Input, Select } from "antd";
import { environmentNameOptions, testIdAttributeOptions } from "./environment-form-options";
import { useEffect, useState } from "react";

export function EnvironmentsPage({ project }: { project: Project }) {
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const setEnvironments = useWorkspaceStore((state) => state.setEnvironments);
  const items = storedEnvironments ?? emptyEnvironments;
  const updateItems = (updater: (environments: Environment[]) => Environment[]) =>
    setEnvironments(project.id, updater(items));
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState<Environment | undefined>();
  return (
    <>
      <PageHeading
        title="环境"
        description="为同一流程维护独立的访问地址、浏览器与认证配置。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(undefined);
              setDrawer(true);
            }}
          >
            新建环境
          </Button>
        }
      />
      <section className="environment-grid">
        {items.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚未创建环境，点击右上角“新建环境”开始"
          />
        ) : items.map((environment) => (
          <article className="environment-card" key={environment.id}>
            <div className="environment-card-top">
              <span className={`environment-color ${environment.color}`} />
              <div>
                <h2>{environment.name}</h2>
                <p>{environment.description}</p>
              </div>
              <Dropdown
                menu={{
                  items: [
                    {
                      key: "edit",
                      label: "编辑环境",
                      onClick: () => {
                        setEditing(environment);
                        setDrawer(true);
                      },
                    },
                    {
                      key: "delete",
                      label: "删除环境",
                      danger: true,
                      onClick: () =>
                        updateItems((list) =>
                          list.filter((item) => item.id !== environment.id),
                        ),
                    },
                  ],
                }}
              >
                <Button
                  type="text"
                  icon={<MoreOutlined />}
                  aria-label={`${environment.name}更多操作`}
                />
              </Dropdown>
            </div>
            <div className="environment-url">
              <GlobalOutlined />
              <code>{environment.baseUrl}</code>
            </div>
            <dl>
              <div>
                <dt>浏览器</dt>
                <dd>{environment.browser}</dd>
              </div>
              <div>
                <dt>窗口模式</dt>
                <dd>{environment.headless === false ? "有头（可见窗口）" : "无头（后台执行）"}</dd>
              </div>
              <div>
                <dt>认证方式</dt>
                <dd>{environment.auth}</dd>
              </div>
              <div>
                <dt>超时</dt>
                <dd>{environment.timeout} 秒</dd>
              </div>
            </dl>
            <div className="environment-footer">
              <span>
                <i /> 可用
              </span>
              <small>更新于 {environment.updatedAt}</small>
            </div>
          </article>
        ))}
      </section>
      <EnvironmentDrawer
        open={drawer}
        environments={items}
        environment={editing}
        onClose={() => setDrawer(false)}
        onSave={(environment) => {
          updateItems((list) =>
            list.some((item) => item.id === environment.id)
              ? list.map((item) =>
                  item.id === environment.id ? environment : item,
                )
              : [...list, environment],
          );
          setDrawer(false);
          message.success("环境配置已保存");
        }}
      />
    </>
  );
}

export function EnvironmentDrawer({
  open,
  environments,
  environment,
  onClose,
  onSave,
}: {
  open: boolean;
  environments?: Environment[];
  environment?: Environment;
  onClose: () => void;
  onSave: (environment: Environment) => void;
}) {
  const existing = environments ?? [];
  const [form] = Form.useForm();
  useEffect(() => {
    if (open)
      form.setFieldsValue(
        environment
          ? { ...environment, headless: environment.headless ?? true }
          : {
              browser: "Chromium",
              auth: "无认证",
              timeout: 30,
              testIdAttribute: "data-testid",
              keepBrowserOpenOnFailure: false,
              headless: true,
            },
      );
  }, [environment, form, open]);
  return (
    <Drawer
      title={environment ? "编辑环境" : "新建环境"}
      open={open}
      size={500}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          onClick={() =>
            form
              .validateFields()
              .then((values) =>
                onSave({
                  id: environment?.id ?? `env-${Date.now()}`,
                  name: values.name,
                  description: values.description || "运行环境",
                  baseUrl: values.baseUrl,
                  browser: values.browser,
                  auth: values.auth,
                  timeout: values.timeout,
                  testIdAttribute: values.testIdAttribute || "data-testid",
                  keepBrowserOpenOnFailure: Boolean(values.keepBrowserOpenOnFailure),
                  headless: values.headless !== false,
                  color: environment?.color ?? "teal",
                  updatedAt: "刚刚",
                }),
              )
          }
        >
          保存配置
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="环境名称"
          validateTrigger={["onChange", "onBlur"]}
          rules={[
            { required: true, message: "请输入环境名称" },
            {
              validator: uniqueNameValidator({
                items: existing,
                getName: (item) => item.name,
                getId: (item) => item.id,
                editingId: environment?.id,
                entityLabel: "环境",
                extraScopeLabel: "项目",
              }),
            },
          ]}
        >
          <AutoComplete
            options={environmentNameOptions}
            placeholder="例如：测试环境"
            filterOption={(inputValue, option) => (option?.value ?? "").toUpperCase().includes(inputValue.toUpperCase())}
          />
        </Form.Item>
        <Form.Item
          name="baseUrl"
          label="基础地址"
          rules={[{ required: true, type: "url", message: "请输入有效 URL" }]}
        >
          <Input placeholder="https://staging.example.com" />
        </Form.Item>
        <div className="form-row">
          <Form.Item name="browser" label="浏览器">
            <Select
              options={[{ value: "Chromium", label: "Chromium" }]}
            />
          </Form.Item>
          <Form.Item name="timeout" label="默认超时（秒）">
            <Input type="number" />
          </Form.Item>
        </div>
        <Form.Item name="headless" label="浏览器模式" tooltip="无头在后台执行不弹窗，适合定时与批量运行；有头会弹出可见浏览器窗口，便于观察步骤执行。">
          <Select
            options={[
              { value: true, label: "无头（后台执行，不弹窗）" },
              { value: false, label: "有头（显示浏览器窗口）" },
            ]}
          />
        </Form.Item>
        <Form.Item name="auth" label="认证配置">
          <Select
            options={["无认证", "账号密码", "Cookie", "HTTP Basic"].map(
              (value) => ({ value }),
            )}
          />
        </Form.Item>
        <Form.Item
          name="testIdAttribute"
          label="测试属性名"
          rules={[{ required: true, message: "请输入测试属性名" }]}
        >
          <AutoComplete
            options={testIdAttributeOptions}
            placeholder="data-testid"
            filterOption={(inputValue, option) => (option?.value ?? "").toUpperCase().includes(inputValue.toUpperCase())}
          />
        </Form.Item>
        <Form.Item name="description" label="说明">
          <Input.TextArea rows={3} />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
