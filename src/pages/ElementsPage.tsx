import { message } from "../antd-feedback";
import type { ElementAsset, Environment, Project } from "../mock-data";
import { createPlatformElementValidation, getPlatformElementValidation } from "../platform-api";
import { platformProjectContext } from "../platform-context";
import { PageHeading, durationFromMilliseconds, emptyElements, emptyEnvironments } from "./shared";
import { artifactUrl, createValidation, subscribeToTask } from "../worker-api";
import { useWorkspaceStore } from "../workspace-store";
import { CheckCircleFilled, EditOutlined, ExperimentOutlined, FileSearchOutlined, PlusOutlined, SearchOutlined, WarningFilled } from "@ant-design/icons";
import { Alert, Button, Drawer, Form, Input, Modal, Select, Space, Spin, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useEffect, useState } from "react";

export function ElementsPage({ project }: { project: Project }) {
  const storedElements = useWorkspaceStore((state) => state.elementsByProject[project.id]);
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const setElements = useWorkspaceStore((state) => state.setElements);
  const items = storedElements ?? emptyElements;
  const environments = storedEnvironments ?? emptyEnvironments;
  const updateItems = (updater: (elements: ElementAsset[]) => ElementAsset[]) =>
    setElements(project.id, updater(items));
  const [editor, setEditor] = useState<ElementAsset | null | "new">(null);
  const [validating, setValidating] = useState<ElementAsset | null>(null);
  const [validation, setValidation] = useState<{
    element: ElementAsset;
    count: number;
    environment: string;
    screenshotUrl?: string;
    elapsedMs?: number;
    firstMatch?: string;
    reason?: string;
  } | null>(null);
  const [validationTarget, setValidationTarget] =
    useState<ElementAsset | null>(null);
  const [validationEnvironment, setValidationEnvironment] = useState("");
  const [search, setSearch] = useState("");
  const [validationFilter, setValidationFilter] = useState("all");
  const filtered = items.filter((item) =>
    [item.name, item.path, item.value]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()) &&
    (validationFilter === "all" || item.validation === validationFilter),
  );
  const startValidation = (element: ElementAsset) => {
    setValidationTarget(element);
    setValidationEnvironment(element.environment);
  };
  const confirmValidation = async () => {
    if (!validationTarget) return;
    const target = validationTarget;
    const environment = environments.find(
      (item) => item.id === validationEnvironment,
    );
    if (!environment) return;
    setValidationTarget(null);
    setValidating(target);
    try {
      const platformContext = platformProjectContext(project.id);
      if (platformContext) {
        const created = await createPlatformElementValidation(
          platformContext.session.token,
          platformContext.projectId,
          { environmentId: environment.id, element: target },
        );
        const validationId = created.validation.id;
        let task = created.validation;
        for (let attempt = 0; attempt < 80 && (task.status === "queued" || task.status === "running"); attempt += 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
          const response = await getPlatformElementValidation(
            platformContext.session.token,
            platformContext.projectId,
            validationId,
          );
          task = response.validation;
        }
        if (task.status === "queued" || task.status === "running") throw new Error("VALIDATION_TIMEOUT");
        const count = Number(task.result?.count ?? 0);
        const validationStatus = count === 1 ? "valid" : count > 1 ? "multiple" : "unverified";
        updateItems((list) => list.map((item) => (
          item.id === target.id ? { ...item, validation: validationStatus, updatedAt: "刚刚" } : item
        )));
        setValidating(null);
        setValidation({
          element: target,
          count,
          environment: environment.name,
          elapsedMs: task.result?.elapsedMs,
          firstMatch: task.result?.firstMatch,
          reason: task.error,
        });
        return;
      }
      const { validationId } = await createValidation(project.id, environment, target);
      const unsubscribe = subscribeToTask(
        project.id,
        "validations",
        validationId,
        (event) => {
          if (event.kind !== "result") return;
          const count = Number(event.data.count ?? 0);
          const screenshotId = event.data.screenshotId;
          const validationStatus =
            count === 1 ? "valid" : count > 1 ? "multiple" : "unverified";
          updateItems((list) =>
            list.map((item) =>
              item.id === target.id
                ? { ...item, validation: validationStatus, updatedAt: "刚刚" }
                : item,
            ),
          );
          setValidating(null);
          setValidation({
            element: target,
            count,
            environment: environment.name,
            screenshotUrl:
              typeof screenshotId === "string"
                ? artifactUrl(project.id, screenshotId)
                : undefined,
            elapsedMs: Number(event.data.elapsedMs ?? 0),
            firstMatch:
              typeof event.data.firstMatch === "string" ? event.data.firstMatch : undefined,
            reason: typeof event.data.reason === "string" ? event.data.reason : undefined,
          });
          unsubscribe();
        },
        () => {
          setValidating(null);
          message.error("无法连接 Playwright Worker，元素验证未执行。");
        },
      );
    } catch {
      setValidating(null);
      message.error("创建元素验证任务失败，请检查 Playwright Worker。");
    }
  };
  const columns: TableColumnsType<ElementAsset> = [
    {
      title: "元素",
      dataIndex: "name",
      render: (_, item) => (
        <button className="name-link" onClick={() => setEditor(item)}>
          <span className="element-glyph">
            <FileSearchOutlined />
          </span>
          <span>
            <strong>{item.name}</strong>
            <small>{item.description}</small>
          </span>
        </button>
      ),
    },
    {
      title: "页面路径",
      dataIndex: "path",
      width: 185,
      render: (path) => <code className="inline-code">{path}</code>,
    },
    {
      title: "定位器",
      key: "locator",
      width: 265,
      render: (_, item) => (
        <div className="locator-cell">
          <Tag
            color={
              item.method === "CSS" || item.method === "XPath"
                ? "warning"
                : "cyan"
            }
          >
            {item.method}
          </Tag>
          <code>{item.value}</code>
        </div>
      ),
    },
    {
      title: "验证状态",
      dataIndex: "validation",
      width: 130,
      render: (value) => (
        <span className={`validation-status ${value}`}>
          <i />
          {value === "valid"
            ? "唯一匹配"
            : value === "multiple"
              ? "多个匹配"
              : "未验证"}
        </span>
      ),
    },
    { title: "更新于", dataIndex: "updatedAt", width: 135 },
    {
      title: "",
      key: "actions",
      width: 105,
      render: (_, item) => (
        <Space size={0}>
          <Tooltip title="验证元素">
            <Button
              type="text"
              icon={<ExperimentOutlined />}
              aria-label={`验证元素 ${item.name}`}
              onClick={() => startValidation(item)}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="text"
              icon={<EditOutlined />}
              aria-label={`编辑元素 ${item.name}`}
              onClick={() => setEditor(item)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];
  return (
    <>
      <PageHeading
        title="元素库"
        description="维护可复用的页面定位资产，并持续验证其稳定性。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setEditor("new")}
          >
            新建元素
          </Button>
        }
      />
      <div className="list-tools">
        <Input
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索名称、路径或定位值"
          allowClear
        />
        <Select
          value={validationFilter}
          onChange={setValidationFilter}
          options={[
            { value: "all", label: "全部验证状态" },
            { value: "valid", label: "唯一匹配" },
            { value: "multiple", label: "多个匹配" },
          ]}
        />
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 8, showSizeChanger: false }}
        />
      </section>
      <ElementDrawer
        open={editor !== null}
        element={editor === "new" ? undefined : editor}
        environments={environments}
        onClose={() => setEditor(null)}
        onSave={(element) => {
          updateItems((list) => {
            const exists = list.some((item) => item.id === element.id);
            return exists
              ? list.map((item) => (item.id === element.id ? element : item))
              : [element, ...list];
          });
          setEditor(null);
          message.success("元素已保存");
        }}
      />
      <Modal
        title="选择验证环境"
        open={validationTarget !== null}
        okText="开始验证"
        cancelText="取消"
        okButtonProps={{ disabled: environments.length === 0 }}
        onOk={confirmValidation}
        onCancel={() => setValidationTarget(null)}
      >
        <p className="validation-target">
          将验证元素「{validationTarget?.name}」的唯一性。
        </p>
        <Select
          className="validation-environment-select"
          value={validationEnvironment}
          onChange={setValidationEnvironment}
          options={environments.map((item) => ({
            value: item.id,
            label: `${item.name} · ${item.baseUrl}`,
          }))}
        />
      </Modal>
      <Modal
        open={validating !== null}
        footer={null}
        closable={false}
        centered
        width={380}
      >
        <div className="validation-progress">
          <Spin size="large" />
          <h3>正在验证元素</h3>
          <p>Playwright Worker 正在打开目标页面并检查定位器唯一性。</p>
        </div>
      </Modal>
      <ValidationModal
        result={validation}
        onClose={() => setValidation(null)}
      />
    </>
  );
}

function ElementDrawer({
  open,
  element,
  environments,
  onClose,
  onSave,
}: {
  open: boolean;
  element?: ElementAsset | null;
  environments: Environment[];
  onClose: () => void;
  onSave: (element: ElementAsset) => void;
}) {
  const [form] = Form.useForm();
  const method = Form.useWatch("method", form);
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue(
      element ?? {
        method: "testid",
        path: "/",
        environment: environments[0]?.id,
      },
    );
  }, [element, environments, form, open]);
  return (
    <Drawer
      title={element ? "编辑元素" : "新建元素"}
      open={open}
      size={520}
      onClose={onClose}
      extra={
        <Button
          type="primary"
          aria-label="保存"
          onClick={() =>
            form
              .validateFields()
              .then((values) =>
                onSave({
                  id: element?.id ?? `element-${Date.now()}`,
                  name: values.name,
                  description: values.description || "尚未添加描述",
                  path: values.path,
                  method: values.method,
                  value: values.value,
                  environment: values.environment,
                  validation: element?.validation ?? "unverified",
                  updatedAt: "刚刚",
                }),
              )
          }
        >
          保存
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="元素名称"
          rules={[{ required: true, message: "请输入元素名称" }]}
        >
          <Input placeholder="例如：登录按钮" />
        </Form.Item>
        <Form.Item
          name="path"
          label="所属页面路径"
          rules={[{ required: true, message: "请输入页面路径" }]}
        >
          <Input placeholder="/login（拼接环境 baseUrl）" />
        </Form.Item>
        <div className="form-row">
          <Form.Item
            name="method"
            label="定位方式"
            rules={[{ required: true }]}
          >
            <Select
              options={["testid", "role", "label", "text", "CSS", "XPath"].map(
                (value) => ({ value, label: value }),
              )}
            />
          </Form.Item>
          <Form.Item name="environment" label="默认验证环境">
            <Select
              options={environments.map(
                (item) => ({ value: item.id, label: item.name }),
              )}
            />
          </Form.Item>
        </div>
        <Form.Item
          name="value"
          label="定位值"
          rules={[{ required: true, message: "请输入定位值" }]}
        >
          <Input
            placeholder={
              method === "testid"
                ? "login-submit"
                : method === "role"
                  ? 'button[name="登录"]'
                  : "输入定位值"
            }
          />
        </Form.Item>
        {(method === "CSS" || method === "XPath") && (
          <Alert
            showIcon
            type="warning"
            title="该定位方式稳定性较低"
            description="优先选择 testid、role 或 label。CSS/XPath 在页面结构变化后更容易失效。"
          />
        )}
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="说明元素用途及使用注意事项" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

function ValidationModal({
  result,
  onClose,
}: {
  result: {
    element: ElementAsset;
    count: number;
    environment: string;
    screenshotUrl?: string;
    elapsedMs?: number;
    firstMatch?: string;
    reason?: string;
  } | null;
  onClose: () => void;
}) {
  if (!result) return null;
  const notFound = result.count === 0;
  const multiple = result.count > 1;
  return (
    <Modal
      open
      footer={
        <Button type="primary" onClick={onClose}>
          完成
        </Button>
      }
      onCancel={onClose}
      title="元素验证结果"
      width={670}
    >
      <div
        className={`validation-result ${
          notFound ? "not-found" : multiple ? "multiple" : "success"
        }`}
      >
        <div className="result-icon">
          {notFound || multiple ? <WarningFilled /> : <CheckCircleFilled />}
        </div>
        <div>
          <h3>
            {notFound
              ? "未找到匹配元素"
              : multiple
                ? `发现 ${result.count} 个匹配元素`
                : "定位器唯一匹配"}
          </h3>
          <p>已在{result.environment}完成验证，耗时 {durationFromMilliseconds(result.elapsedMs)}。</p>
        </div>
      </div>
      {result.screenshotUrl && (
        <div className="browser-shot worker-shot">
          <img src={result.screenshotUrl} alt="Worker 验证截图" />
        </div>
      )}
      {result.firstMatch && (
        <div className="result-detail">
          <span>首个匹配元素</span>
          <code>{result.firstMatch}</code>
        </div>
      )}
      {notFound && (
        <Alert
          type="error"
          showIcon
          title="定位器没有匹配到页面元素"
          description={result.reason ?? "请确认基础地址、页面路径和前置流程；也可检查页面是否仍使用当前定位器。"}
        />
      )}
      {multiple && (
        <Alert
          type="warning"
          showIcon
            title="建议进一步缩小定位范围"
          description="候选项已定位到页面中的相同按钮。请改用 testid 或提供更具体的 role 与名称。"
        />
      )}
    </Modal>
  );
}
