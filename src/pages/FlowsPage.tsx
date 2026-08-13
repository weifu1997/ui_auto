import { message } from "../antd-feedback";
import { localWorkerRunRequest } from "../local-worker-run";
import type { Flow, Project, Run } from "../mock-data";
import { PlatformApiError, createPlatformRun, savePlatformSecret } from "../platform-api";
import { platformProjectContext } from "../platform-context";
import { useNavigate } from "../router";
import { useRunStore } from "../run-store";
import { useSecretStore } from "../secret-store";
import { PageHeading, canUseCapability, emptyElements, emptyEnvironments, emptyFlows, emptySecretValues, emptyVariables, platformRunAsRun, requestRunSecrets, requiredSecretVariables, statusTag, variableReference, watchWorkerRun } from "./shared";
import { createRun } from "../worker-api";
import { useWorkspaceStore } from "../workspace-store";
import { CopyOutlined, DeleteOutlined, ExperimentOutlined, PlayCircleFilled, PlusOutlined, SearchOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Button, Drawer, Empty, Form, Input, Popconfirm, Select, Space, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useEffect, useRef, useState } from "react";

export function FlowsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const canEditFlow = canUseCapability("flow.edit");
  const canRunFlow = canUseCapability("run.execute");
  const production = import.meta.env.PROD || import.meta.env.VITE_AUTH_REQUIRED === "1";
  const watchCleanups = useRef<Array<() => void>>([]);
  useEffect(() => () => {
    for (const cleanup of watchCleanups.current) cleanup();
    watchCleanups.current = [];
  }, []);
  const storedFlows = useWorkspaceStore((state) => state.flowsByProject[project.id]);
  const storedVariables = useWorkspaceStore(
    (state) => state.variablesByProject[project.id],
  );
  const storedElements = useWorkspaceStore(
    (state) => state.elementsByProject[project.id],
  );
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const activeEnvironmentId = useWorkspaceStore(
    (state) => state.activeEnvironmentByProject[project.id],
  );
  const setFlows = useWorkspaceStore((state) => state.setFlows);
  const upsertRun = useRunStore((state) => state.upsertRun);
  const sessionSecretValues = useSecretStore(
    (state) => state.valuesByProject[project.id] ?? emptySecretValues,
  );
  const setSecretValues = useSecretStore((state) => state.setValues);
  const items = storedFlows ?? emptyFlows;
  const variables = storedVariables ?? emptyVariables;
  const elements = storedElements ?? emptyElements;
  const environments = storedEnvironments ?? emptyEnvironments;
  const activeEnvironment =
    environments.find((environment) => environment.id === activeEnvironmentId) ??
    environments[0];
  const updateItems = (updater: (flows: Flow[]) => Flow[]) =>
    setFlows(project.id, updater(items));
  const updateFlowStatus = (flowId: string, status: Flow["lastStatus"]) => {
    const current = useWorkspaceStore.getState().flowsByProject[project.id] ?? emptyFlows;
    useWorkspaceStore.getState().setFlows(
      project.id,
      current.map((item) => item.id === flowId ? { ...item, lastStatus: status } : item),
    );
  };
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [draftOpen, setDraftOpen] = useState(false);
  const filtered = items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()) &&
    (tagFilter === "all" || item.tags.includes(tagFilter)),
  );
  const runFlow = async (flow: Flow) => {
    const steps = flow.definition ?? [];
    if (steps.length === 0) {
      message.error("请先在编排器中添加并保存至少一个流程步骤。");
      return;
    }
    if (!activeEnvironment) {
      message.error("当前项目没有可用运行环境");
      return;
    }
    const secretValues = await requestRunSecrets(
      project.id,
      variables,
      steps,
      sessionSecretValues,
      setSecretValues,
    );
    if (!secretValues) return;
    const platformContext = platformProjectContext(project.id);
    if (platformContext) {
      try {
        for (const variable of requiredSecretVariables(variables, steps)) {
          const value = secretValues[variable.id];
          if (value) await savePlatformSecret(platformContext.session.token, platformContext.projectId, { name: variableReference(variable), value });
        }
        const result = await createPlatformRun(platformContext.session.token, platformContext.projectId, { environmentId: activeEnvironment.id });
        result.runs.forEach((run) => upsertRun(project.id, platformRunAsRun(run)));
        updateFlowStatus(flow.id, "running");
        message.success(`已创建 ${result.runIds.length} 个运行（部署机执行）`);
        navigate(`/project/${project.id}/runs`);
      } catch (error) {
        if (error instanceof PlatformApiError && error.code === "PUBLISHED_REVISION_REQUIRED") {
          message.error("当前项目还没有版本快照，请先在编排器中保存流程");
          return;
        }
        message.error("创建平台运行失败，请检查执行服务与运行环境");
      }
      return;
    }
    try {
      const secretVariables = requiredSecretVariables(variables, steps);
      if (secretVariables.length > 0 && production) {
        message.error("生产环境已禁用本机 Worker 明文密钥路径，请通过平台运行");
        return;
      }
      const request = localWorkerRunRequest({
        environment: activeEnvironment,
        flow: { id: flow.id, name: flow.name },
        steps,
        elements,
        variables,
        secretValues,
        secretVariables,
      });
      const { runId } = await createRun(project.id, request);
      const run: Run = {
        id: runId,
        flowName: flow.name,
        status: "queued",
        environment: activeEnvironment.name,
        progress: 0,
        completedSteps: 0,
        totalSteps: steps.length,
        startedAt: "刚刚",
        duration: "排队中",
        screenshots: 0,
        retries: 0,
      };
      upsertRun(project.id, run);
      watchCleanups.current.push(watchWorkerRun(project.id, run, upsertRun, (status) => {
        updateFlowStatus(flow.id, status);
      }));
      navigate(`/project/${project.id}/runs`);
    } catch {
      message.error("本机 Playwright Worker 不可用，请先运行 npm run server 后重试。");
    }
    return;
  };
  const columns: TableColumnsType<Flow> = [
    {
      title: "流程",
      dataIndex: "name",
      render: (_, flow) => (
        <button
          className="name-link"
          onClick={() =>
            navigate(`/project/${project.id}/flows/${flow.id}/edit`)
          }
        >
          <span className="flow-glyph">
            <UnorderedListOutlined />
          </span>
          <span>
            <strong>{flow.name}</strong>
            <small>{flow.description}</small>
          </span>
        </button>
      ),
    },
    {
      title: "标签",
      dataIndex: "tags",
      width: 190,
      render: (tags: string[]) => (
        <>
          {tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </>
      ),
    },
    { title: "步骤", dataIndex: "steps", width: 82, align: "center" },
    {
      title: "最近结果",
      dataIndex: "lastStatus",
      width: 125,
      render: (status: Run["status"]) => statusTag(status),
    },
    { title: "更新于", dataIndex: "updatedAt", width: 150 },
    {
      title: "",
      key: "actions",
      width: 142,
      render: (_, flow) => (
        <Space size={0}>
          {canRunFlow && (
            <Tooltip title="运行流程">
              <Button
                type="text"
                size="small"
                icon={<PlayCircleFilled />}
                aria-label={`运行流程 ${flow.name}`}
                onClick={() => void runFlow(flow)}
              />
            </Tooltip>
          )}
          {canEditFlow && (
            <>
              <Tooltip title="复制流程">
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  aria-label={`复制流程 ${flow.name}`}
                  onClick={() => {
                    updateItems((list) => [
                      {
                        ...flow,
                        id: `${flow.id}-copy-${Date.now()}`,
                        name: `${flow.name} - 副本`,
                        updatedAt: "刚刚",
                      },
                      ...list,
                    ]);
                    message.success("已创建流程副本");
                  }}
                />
              </Tooltip>
              <Popconfirm
                title="删除此流程？"
                okText="删除"
                cancelText="取消"
                onConfirm={() =>
                  updateItems((list) => list.filter((item) => item.id !== flow.id))
                }
              >
                <Tooltip title="删除流程">
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`删除流程 ${flow.name}`}
                  />
                </Tooltip>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];
  return (
    <>
      <PageHeading
        title="流程"
        description="由元素、动作和参数组合而成的可执行自动化流程。"
        actions={
          canEditFlow ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setDraftOpen(true)}
            >
              新建流程
            </Button>
          ) : undefined
        }
      />
      <div className="list-tools">
        <Input
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索流程"
          allowClear
        />
        <Select
          value={tagFilter}
          onChange={setTagFilter}
          options={[
            { value: "all", label: "全部标签" },
            { value: "冒烟", label: "冒烟" },
            { value: "回归", label: "回归" },
          ]}
        />
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <Empty description="尚无流程" /> }}
        />
      </section>
      <NewFlowDrawer
        open={draftOpen}
        project={project}
        onClose={() => setDraftOpen(false)}
        onCreated={(flow) => {
          updateItems((list) => [flow, ...list]);
          setDraftOpen(false);
          navigate(`/project/${project.id}/flows/${flow.id}/edit`);
        }}
      />
    </>
  );
}

function NewFlowDrawer({
  open,
  project,
  onClose,
  onCreated,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
  onCreated: (flow: Flow) => void;
}) {
  const [form] = Form.useForm();
  void project;
  useEffect(() => {
    if (open) form.resetFields();
  }, [form, open]);
  return (
    <Drawer
      title="新建流程"
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
                const createdAt = Date.now();
                onCreated({
                  id: `flow-${createdAt}`,
                  name: values.name,
                  description: values.description || "尚未添加说明",
                  tags: values.tags || [],
                  steps: 0,
                  definition: [],
                  lastStatus: "queued",
                  updatedAt: "刚刚",
                });
              })
          }
        >
          创建并编辑
        </Button>
      }
    >
      <Form form={form} layout="vertical">
        <Form.Item
          label="流程名称"
          name="name"
          rules={[{ required: true, message: "请输入流程名称" }]}
        >
          <Input placeholder="例如：用户登录并提交订单" />
        </Form.Item>
        <Form.Item label="说明" name="description">
          <Input.TextArea rows={3} placeholder="描述流程覆盖的业务场景" />
        </Form.Item>
        <Form.Item label="标签" name="tags">
          <Select
            mode="tags"
            placeholder="输入后按回车创建标签"
            options={[{ value: "冒烟" }, { value: "回归" }, { value: "支付" }]}
          />
        </Form.Item>
        <div className="drawer-note">
          <ExperimentOutlined /> 创建后可按需从空白编排器添加步骤。
        </div>
      </Form>
    </Drawer>
  );
}
