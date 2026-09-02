import { message } from "../lib/antd-feedback";
import type { Flow, Project, Run } from "../lib/mock-data";
import { PlatformApiError, createPlatformRun, createPlatformRunBatch, getPlatformRevisions } from "../api/platform-api";
import type { PlatformRevision } from "../api/platform-api";
import { platformProjectContext } from "../api/platform-context";
import { useNavigate } from "../router";
import { useRunStore } from "../stores/run-store";
import { PageHeading, canUseCapability, createRunDispatchKeyStore, describePlatformRunError, emptyEnvironments, emptyFlows, emptyVariables, ensurePlatformRunSecrets, nextRunDispatchKey, platformRunSummaryAsRun, releaseRunDispatchKey, runIntentKey, statusTag, uniqueNameValidator } from "./shared";
import { useWorkspaceStore } from "../stores/workspace-store";
import { CopyOutlined, DeleteOutlined, ExperimentOutlined, PlayCircleFilled, PlusOutlined, SearchOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useEffect, useRef, useState } from "react";

export function FlowsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const canEditFlow = canUseCapability("flow.edit");
  const canRunFlow = canUseCapability("run.execute");
  const storedFlows = useWorkspaceStore((state) => state.flowsByProject[project.id]);
  const storedVariables = useWorkspaceStore(
    (state) => state.variablesByProject[project.id],
  );
  const storedEnvironments = useWorkspaceStore(
    (state) => state.environmentsByProject[project.id],
  );
  const activeEnvironmentId = useWorkspaceStore(
    (state) => state.activeEnvironmentByProject[project.id],
  );
  const setFlows = useWorkspaceStore((state) => state.setFlows);
  const upsertRun = useRunStore((state) => state.upsertRun);
  const items = storedFlows ?? emptyFlows;
  const variables = storedVariables ?? emptyVariables;
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
  const [publishedFlowIds, setPublishedFlowIds] = useState<ReadonlySet<string> | null>(null);
  const platformToken = platformProjectContext(project.id)?.session.token;
  const platformProjectIdValue = platformProjectContext(project.id)?.projectId;
  useEffect(() => {
    if (!platformToken || !platformProjectIdValue) {
      setPublishedFlowIds(null);
      return;
    }
    let cancelled = false;
    getPlatformRevisions(platformToken, platformProjectIdValue)
      .then((result) => {
        if (cancelled) return;
        const environmentId = activeEnvironment?.id;
        setPublishedFlowIds(
          new Set(
            result.revisions
              .filter((revision): revision is PlatformRevision & { flowId: string } =>
                revision.status === "published" &&
                (!environmentId || revision.environmentId === environmentId) &&
                typeof revision.flowId === "string")
              .map((revision) => revision.flowId),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setPublishedFlowIds(null);
      });
    return () => {
      cancelled = true;
    };
  }, [platformToken, platformProjectIdValue, activeEnvironment?.id]);
  const filtered = items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()) &&
    (tagFilter === "all" || item.tags.includes(tagFilter)),
  );
  const [dispatchingFlowId, setDispatchingFlowId] = useState<string | null>(null);
  const runDispatchKeysRef = useRef(createRunDispatchKeyStore());
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
    const platformContext = platformProjectContext(project.id);
    if (!platformContext) {
      message.error("当前项目尚未连接 Platform，请先完成项目同步");
      return;
    }
    setDispatchingFlowId(flow.id);
    const intent = runIntentKey({ projectId: platformContext.projectId, flowId: flow.id });
    try {
      if (!(await ensurePlatformRunSecrets(platformContext.session.token, platformContext.projectId, variables, steps))) {
        return;
      }
      const dispatchKey = nextRunDispatchKey(runDispatchKeysRef.current, intent);
      const result = await createPlatformRun(platformContext.session.token, platformContext.projectId, { flowId: flow.id, environmentId: activeEnvironment.id, dispatchKey });
      releaseRunDispatchKey(runDispatchKeysRef.current, intent);
      result.runs.forEach((run) => upsertRun(project.id, platformRunSummaryAsRun(run)));
      updateFlowStatus(flow.id, "running");
      message.success(`已创建 ${result.runIds.length} 个运行（部署机执行）`);
      navigate(`/project/${project.id}/runs`);
    } catch (error) {
      releaseRunDispatchKey(runDispatchKeysRef.current, intent, error);
      message.error(describePlatformRunError(error));
    } finally {
      setDispatchingFlowId(null);
    }
  };
  const isFlowRunnable = (flowId: string) =>
    publishedFlowIds === null || publishedFlowIds.has(flowId);
  const platformMode = Boolean(platformToken && platformProjectIdValue);
  const [selectedFlowIds, setSelectedFlowIds] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchEnvironmentId, setBatchEnvironmentId] = useState<string | undefined>(undefined);
  const batchClientRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    setSelectedFlowIds((ids) => {
      const valid = new Set(items.map((flow) => flow.id));
      const next = ids.filter((id) => valid.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [items]);
  const selectedFlows = items.filter((flow) => selectedFlowIds.includes(flow.id));
  const batchTotalSteps = selectedFlows.reduce(
    (sum, flow) => sum + (flow.definition?.length ?? 0),
    0,
  );
  const batchPreflightHint = (code: string) => {
    if (code === "PUBLISHED_REVISION_REQUIRED") return "当前环境没有已发布版本";
    if (code === "REVISION_ENVIRONMENT_MISMATCH") return "版本与环境不匹配";
    if (code === "FLOW_HAS_NO_STEPS") return "流程没有步骤";
    if (code === "RUN_SECRET_NOT_CONFIGURED") return "缺少密钥配置";
    if (code === "AGENT_BROWSER_UNSUPPORTED") {
      return "环境浏览器不受支持：执行服务仅支持 Chromium，请切换环境或在部署机上安装 Playwright Chromium。";
    }
    return code;
  };
  const submitBatchRun = async () => {
    if (!platformToken || !platformProjectIdValue || !batchEnvironmentId) return;
    if (selectedFlows.length < 2) return;
    setBatchSubmitting(true);
    try {
      const result = await createPlatformRunBatch(platformToken, platformProjectIdValue, {
        flowIds: selectedFlows.map((flow) => flow.id),
        environmentId: batchEnvironmentId,
        clientRequestId: batchClientRequestIdRef.current ?? crypto.randomUUID(),
      });
      message.success(`已创建批次（${result.batch.counts.total} 个流程，串行执行）`);
      setSelectedFlowIds([]);
      setBatchOpen(false);
      batchClientRequestIdRef.current = null;
      navigate(`/project/${project.id}/runs?batch=${encodeURIComponent(result.batch.id)}`);
    } catch (error) {
      if (
        error instanceof PlatformApiError
        && error.code === "BATCH_PREFLIGHT_FAILED"
        && error.items?.length
      ) {
        const details = error.items.map((item) => {
          const flow = items.find((candidate) => candidate.id === item.flowId);
          return `${flow?.name ?? item.flowId}：${batchPreflightHint(item.code)}`;
        });
        message.error(`部分流程无法执行，请修正后重新提交——${details.join("；")}`);
        return;
      }
      message.error(describePlatformRunError(error, "创建批量运行失败，请检查执行服务与运行环境"));
    } finally {
      setBatchSubmitting(false);
    }
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
            <Tooltip title={isFlowRunnable(flow.id) ? "运行流程" : "该流程尚未发布版本，请先在编排器中保存流程"}>
              <Button
                type="text"
                size="small"
                icon={<PlayCircleFilled />}
                aria-label={`运行流程 ${flow.name}`}
                disabled={!isFlowRunnable(flow.id) || dispatchingFlowId !== null}
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
        {platformMode && canRunFlow && (
          <Button
            icon={<PlayCircleFilled />}
            disabled={selectedFlowIds.length < 2 || selectedFlowIds.length > 20}
            onClick={() => {
              setBatchEnvironmentId(activeEnvironment?.id);
              batchClientRequestIdRef.current = crypto.randomUUID();
              setBatchOpen(true);
            }}
          >
            批量运行（{selectedFlowIds.length}）
          </Button>
        )}
        {canEditFlow && (
          <Popconfirm
            title="批量删除流程"
            description={`确定删除选中的 ${selectedFlowIds.length} 个流程？此操作不可恢复。`}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={selectedFlowIds.length === 0}
            onConfirm={() => {
              const count = selectedFlowIds.length;
              updateItems((list) => list.filter((item) => !selectedFlowIds.includes(item.id)));
              setSelectedFlowIds([]);
              message.success(`已批量删除 ${count} 个流程`);
            }}
          >
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={selectedFlowIds.length === 0}
            >
              批量删除{selectedFlowIds.length > 0 ? `（${selectedFlowIds.length}）` : ""}
            </Button>
          </Popconfirm>
        )}
      </div>
      <section className="surface">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          rowSelection={canEditFlow || (platformMode && canRunFlow) ? {
            selectedRowKeys: selectedFlowIds,
            onChange: (keys) => setSelectedFlowIds(keys.map(String)),
            getCheckboxProps: (flow) => ({ disabled: !canEditFlow && !isFlowRunnable(flow.id) }),
          } : undefined}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无流程" /> }}
        />
      </section>
      <Modal
        title="批量运行"
        open={batchOpen}
        okText="创建批次"
        cancelText="取消"
        confirmLoading={batchSubmitting}
        okButtonProps={{ disabled: selectedFlows.length < 2 || !batchEnvironmentId }}
        onCancel={() => { setBatchOpen(false); batchClientRequestIdRef.current = null; }}
        onOk={() => void submitBatchRun()}
      >
        <Form layout="vertical">
          <Form.Item label="环境" required>
            <Select
              aria-label="批量运行环境"
              value={batchEnvironmentId}
              onChange={(value) => {
                setBatchEnvironmentId(value);
                batchClientRequestIdRef.current = crypto.randomUUID();
              }}
              options={environments.map((environment) => ({
                value: environment.id,
                label: environment.name,
              }))}
            />
          </Form.Item>
          <Form.Item label={`流程（${selectedFlows.length} 个，共 ${batchTotalSteps} 步）`}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {selectedFlows.map((flow) => (
                <li key={flow.id}>{flow.name}</li>
              ))}
            </ul>
          </Form.Item>
        </Form>
        <div className="drawer-note">
          批次按提交顺序串行执行（同一时间最多一个运行）；每个流程完成或失败后自动执行下一个，并可能产生多条完成通知。
        </div>
      </Modal>
      <NewFlowDrawer
        open={draftOpen}
        project={project}
        flows={items}
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
  flows,
  onClose,
  onCreated,
}: {
  open: boolean;
  project: Project;
  flows?: Flow[];
  onClose: () => void;
  onCreated: (flow: Flow) => void;
}) {
  const existing = flows ?? [];
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
          validateTrigger={["onChange", "onBlur"]}
          rules={[
            { required: true, message: "请输入流程名称" },
            {
              validator: uniqueNameValidator({
                items: existing,
                getName: (item) => item.name,
                getId: (item) => item.id,
                entityLabel: "流程",
                extraScopeLabel: "项目",
              }),
            },
          ]}
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
