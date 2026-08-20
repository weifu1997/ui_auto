import { message } from "../antd-feedback";
import type { Project, Variable } from "../mock-data";
import { PageHeading, emptyVariables, uniqueVariableNameValidator } from "./shared";
import { useSecretStore } from "../secret-store";
import { useWorkspaceStore } from "../workspace-store";
import { CheckCircleFilled, DeleteOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Drawer, Empty, Form, Input, Popconfirm, Select, Switch, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useEffect, useState } from "react";

export function VariablesPage({ project }: { project: Project }) {
  const storedVariables = useWorkspaceStore((state) => state.variablesByProject[project.id]);
  const setVariables = useWorkspaceStore((state) => state.setVariables);
  const items = storedVariables ?? emptyVariables;
  const updateItems = (updater: (variables: Variable[]) => Variable[]) =>
    setVariables(project.id, updater(items));
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [selectedVariableIds, setSelectedVariableIds] = useState<string[]>([]);
  const columns: TableColumnsType<Variable> = [
    {
      title: "变量",
      dataIndex: "name",
      render: (_, item) => (
        <div className="variable-name">
          <span className="var-glyph">
            {item.scope === "环境" ? "E" : item.scope === "内置" ? "R" : "P"}
          </span>
          <span>
            <strong>{item.name}</strong>
            <small>{item.description}</small>
          </span>
        </div>
      ),
    },
    {
      title: "作用域",
      dataIndex: "scope",
      width: 110,
      render: (scope) => <Tag>{scope}</Tag>,
    },
    {
      title: "值",
      dataIndex: "value",
      width: 260,
      render: (value, item) => (
        <code className="value-code">
          {item.secret ? "••••••••••••" : value}
        </code>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 145,
      render: (_, item) =>
        item.secret ? (
          <span className="configured">
            <CheckCircleFilled /> 已配置
          </span>
        ) : (
          <span className="configured">普通变量</span>
        ),
    },
    { title: "更新于", dataIndex: "updatedAt", width: 150 },
    {
      title: "",
      key: "actions",
      width: 66,
      render: (_, item) =>
        item.scope !== "内置" && (
          <Popconfirm
            title="删除变量？"
            okText="删除"
            cancelText="取消"
            onConfirm={() =>
              updateItems((list) =>
                list.filter((variable) => variable.id !== item.id),
              )
            }
          >
            <Tooltip title="删除变量">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除变量 ${item.name}`}
              />
            </Tooltip>
          </Popconfirm>
        ),
    },
  ];
  const filtered = items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()) &&
    (scopeFilter === "all" || item.scope === scopeFilter),
  );
  return (
    <>
      <PageHeading
        title="变量"
        description="在流程参数中使用 {{env.xxx}}、{{project.xxx}} 和 {{run.xxx}} 引用值。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setDrawer(true)}
          >
            新建变量
          </Button>
        }
      />
      <Alert
        className="scope-alert"
        showIcon
        type="info"
        title="密钥变量不会返回明文"
        description="接口只返回“已配置”和最后更新时间；运行时由 Platform 执行服务解析注入。"
      />
      <div className="list-tools">
        <Input
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索变量"
          allowClear
        />
        <Select
          value={scopeFilter}
          onChange={setScopeFilter}
          options={[
            { value: "all", label: "全部作用域" },
            { value: "环境", label: "环境变量" },
            { value: "项目", label: "项目变量" },
          ]}
        />
        <Popconfirm
          title="批量删除变量"
          description={`确定删除选中的 ${selectedVariableIds.length} 个变量？删除后引用这些变量的流程步骤将无法解析其值。`}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          disabled={selectedVariableIds.length === 0}
          onConfirm={() => {
            const count = selectedVariableIds.length;
            updateItems((list) =>
              list.filter((variable) => variable.scope === "内置" || !selectedVariableIds.includes(variable.id)),
            );
            setSelectedVariableIds([]);
            message.success(`已批量删除 ${count} 个变量`);
          }}
        >
          <Button
            danger
            icon={<DeleteOutlined />}
            disabled={selectedVariableIds.length === 0}
          >
            批量删除{selectedVariableIds.length > 0 ? `（${selectedVariableIds.length}）` : ""}
          </Button>
        </Popconfirm>
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          rowSelection={{
            selectedRowKeys: selectedVariableIds,
            onChange: (keys) => setSelectedVariableIds(keys.map(String)),
            getCheckboxProps: (item) => ({ disabled: item.scope === "内置" }),
          }}
          pagination={false}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未创建变量" /> }}
        />
      </section>
      <VariableDrawer
        open={drawer}
        project={project}
        variables={items}
        onClose={() => setDrawer(false)}
        onSave={(variable) => {
          updateItems((list) => [variable, ...list]);
          setDrawer(false);
          message.success("变量已创建");
        }}
      />
    </>
  );
}

function VariableDrawer({
  open,
  project,
  variables,
  onClose,
  onSave,
}: {
  open: boolean;
  project: Project;
  variables: Variable[];
  onClose: () => void;
  onSave: (variable: Variable) => void;
}) {
  const [form] = Form.useForm();
  const secret = Form.useWatch("secret", form);
  const scope = Form.useWatch("scope", form) ?? "项目";
  useEffect(() => {
    if (open) form.setFieldsValue({ scope: "项目", secret: false });
  }, [form, open]);
  const scopeLabel = scope === "环境" ? "env" : "project";
  return (
    <Drawer
      title="新建变量"
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
                if (values.secret && typeof values.value === "string" && values.value.trim()) {
                  useSecretStore.getState().setValues(project.id, { [id]: values.value });
                  message.info("密钥已注入当前会话（刷新后失效），不会保存到存储");
                }
                onSave({
                  id,
                  name: values.name,
                  description: values.description || "项目变量",
                  value: values.secret ? "" : values.value || "",
                  scope: values.scope,
                  secret: values.secret,
                  updatedAt: "刚刚",
                });
              })
          }
        >
          保存变量
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
          extra={`引用格式：{{${scopeLabel}.变量名}}`}
        >
          <Input placeholder="例如：username" />
        </Form.Item>
        <Form.Item name="scope" label="作用域">
          <Select
            options={[
              { value: "项目", label: "项目变量" },
              { value: "环境", label: "环境变量" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="value"
          label="值"
          rules={[{ required: !secret, message: "请输入变量值" }]}
        >
          <Input
            type={secret ? "password" : "text"}
            placeholder={secret ? "密钥不会保存：填写后注入当前会话，运行前不再弹出（刷新后失效）" : "输入变量值"}
          />
        </Form.Item>
        <Form.Item name="secret" label="密钥变量" valuePropName="checked">
          <Switch checkedChildren="密钥" unCheckedChildren="普通" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="说明变量的业务用途" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
