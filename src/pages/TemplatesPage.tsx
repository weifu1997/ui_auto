import {
  AppstoreAddOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { message } from "../antd-feedback";
import {
  applyPlatformTemplate,
  createPlatformTemplate,
  deletePlatformTemplate,
  favoritePlatformTemplate,
  getPlatformRevisions,
  getPlatformTemplate,
  getPlatformTemplates,
  getTemplateApplyCandidates,
  rePublishPlatformTemplate,
  updatePlatformTemplate,
} from "../platform-api";
import type {
  PlatformRevision,
  PlatformTemplate,
  TemplateApplyCandidate,
  TemplateApplyResult,
} from "../platform-api";
import { readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../platform-context";
import { useNavigate } from "../router";
import { useWorkspaceStore } from "../workspace-store";
import { WorkspaceSide } from "./shared";

const { Text, Paragraph } = Typography;

type TemplateForm = {
  projectId: string;
  revisionId: string;
  name: string;
  description?: string;
  category?: string;
};

export function TemplatesPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("recommended");
  const [templates, setTemplates] = useState<PlatformTemplate[]>([]);
  const [selected, setSelected] = useState<PlatformTemplate>();
  const [targetProjectId, setTargetProjectId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [republishOpen, setRepublishOpen] = useState(false);
  const [republishTemplate, setRepublishTemplate] = useState<PlatformTemplate>();
  const [republishRevisions, setRepublishRevisions] = useState<PlatformRevision[]>([]);
  const [republishSubmitting, setRepublishSubmitting] = useState(false);
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [outdatedMap, setOutdatedMap] = useState<Record<string, { latestRev: PlatformRevision; revisions: PlatformRevision[] }>>({});

  // Drawer states
  const [applyFlow, setApplyFlow] = useState(true);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [selectedVariableIds, setSelectedVariableIds] = useState<string[]>([]);
  const [applyEnvironments, setApplyEnvironments] = useState(true);
  const [elementMappings, setElementMappings] = useState<Record<string, string | null>>({});
  const [candidates, setCandidates] = useState<TemplateApplyCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [applyResult, setApplyResult] = useState<TemplateApplyResult | null>(null);

  const [form] = Form.useForm<TemplateForm>();
  const [editForm] = Form.useForm<TemplateForm>();
  const [republishForm] = Form.useForm<{ revisionId: string }>();

  const projects = useWorkspaceStore((state) => state.projects);
  const [session] = useState(readStoredPlatformSession);
  const workspaceId = readStoredPlatformWorkspaceId(session);
  const canPublish = Boolean(session);

  const load = useCallback(async (search: string) => {
    if (!session || !workspaceId) return setLoading(false);
    setLoading(true);
    try {
      const resp = await getPlatformTemplates(session.token, workspaceId, search);
      setTemplates(resp.templates);

      // Check outdated templates in background
      const projectIds = Array.from(
        new Set(resp.templates.map((t) => t.sourceProjectId).filter(Boolean)),
      ) as string[];

      const revsByProject: Record<string, PlatformRevision[]> = {};
      await Promise.all(
        projectIds.map(async (pid) => {
          try {
            const revRes = await getPlatformRevisions(session.token, pid);
            revsByProject[pid] = revRes.revisions.filter((r) => r.status === "published");
          } catch {
            revsByProject[pid] = [];
          }
        }),
      );

      const outdated: Record<string, { latestRev: PlatformRevision; revisions: PlatformRevision[] }> = {};
      for (const tmpl of resp.templates) {
        if (tmpl.sourceProjectId && tmpl.sourceRevisionId) {
          const published = revsByProject[tmpl.sourceProjectId] || [];
          if (published.length > 0) {
            const latest = published[0];
            if (latest.id !== tmpl.sourceRevisionId) {
              outdated[tmpl.id] = { latestRev: latest, revisions: published };
            }
          }
        }
      }
      setOutdatedMap(outdated);
    } catch {
      message.error("模板库加载失败");
    } finally {
      setLoading(false);
    }
  }, [session, workspaceId]);

  useEffect(() => {
    void load("");
  }, [load]);

  const visibleTemplates = useMemo(() => {
    const filtered =
      category === "all"
        ? templates
        : templates.filter((template) => template.category === category);
    if (sort === "name") {
      return [...filtered].sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN"),
      );
    }
    if (sort === "latest") {
      return [...filtered].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    }
    return filtered;
  }, [category, sort, templates]);

  const categories = useMemo(() => {
    return [...new Set(templates.map((template) => template.category))];
  }, [templates]);

  const openTemplate = async (template: PlatformTemplate) => {
    setSelected(template);
    const initialProjectId = projects[0]?.id;
    setTargetProjectId(initialProjectId);
    setApplyResult(null);
    setElementMappings({});

    if (!session) return;
    try {
      const detail = (await getPlatformTemplate(session.token, template.id)).template;
      setSelected(detail);

      // Initialize selection
      const snapshot = detail.snapshot;
      const elements = snapshot?.elements || [];
      const variables = snapshot?.variables || [];
      setApplyFlow(Boolean(snapshot?.flow));
      setSelectedElementIds(elements.map((e) => e.id));
      setSelectedVariableIds(variables.map((v) => v.id));
      setApplyEnvironments(Boolean(snapshot?.environments?.length));

      // Fetch apply candidates for target project
      if (initialProjectId) {
        setCandidatesLoading(true);
        try {
          const candRes = await getTemplateApplyCandidates(session.token, template.id, initialProjectId);
          setCandidates(candRes.candidates || []);
        } catch {
          setCandidates([]);
        } finally {
          setCandidatesLoading(false);
        }
      }
    } catch {
      message.error("模板详情加载失败");
    }
  };

  const handleTargetProjectChange = async (projectId: string) => {
    setTargetProjectId(projectId);
    setElementMappings({});
    setApplyResult(null);
    if (!session || !selected) return;
    setCandidatesLoading(true);
    try {
      const candRes = await getTemplateApplyCandidates(session.token, selected.id, projectId);
      setCandidates(candRes.candidates || []);
    } catch {
      setCandidates([]);
    } finally {
      setCandidatesLoading(false);
    }
  };

  const loadRevisions = async (projectId: string) => {
    if (!session) return;
    try {
      const items = (await getPlatformRevisions(session.token, projectId)).revisions.filter(
        (revision) => revision.status === "published",
      );
      setRevisions(items);
      form.setFieldValue("revisionId", items[0]?.id);
    } catch {
      setRevisions([]);
      message.error("已发布版本加载失败");
    }
  };

  const publish = async (values: TemplateForm) => {
    if (!session || !workspaceId) return;
    try {
      await createPlatformTemplate(session.token, workspaceId, values);
      setPublishOpen(false);
      await load(query);
      message.success("模板已发布为冻结快照");
    } catch {
      message.error("模板发布失败，请确认版本已发布且权限足够");
    }
  };

  const update = async (values: TemplateForm) => {
    if (!session || !selected) return;
    try {
      const result = await updatePlatformTemplate(session.token, selected.id, values);
      setSelected({ ...selected, ...result.template });
      setEditOpen(false);
      await load(query);
      message.success("模板信息已更新，冻结内容保持不变");
    } catch {
      message.error("只有创建者或管理员可以更新模板");
    }
  };

  const openRepublish = async (template: PlatformTemplate) => {
    setRepublishTemplate(template);
    if (!session || !template.sourceProjectId) return;
    try {
      const revRes = await getPlatformRevisions(session.token, template.sourceProjectId);
      const published = revRes.revisions.filter((r) => r.status === "published");
      setRepublishRevisions(published);
      republishForm.setFieldValue("revisionId", published[0]?.id);
      setRepublishOpen(true);
    } catch {
      message.error("获取已发布版本失败");
    }
  };

  const handleRepublish = async () => {
    if (!session || !republishTemplate) return;
    const values = await republishForm.validateFields();
    setRepublishSubmitting(true);
    try {
      const resp = await rePublishPlatformTemplate(session.token, republishTemplate.id, values.revisionId);
      message.success("模板已重新发布为最新快照");
      setRepublishOpen(false);
      if (selected?.id === republishTemplate.id) {
        setSelected(resp.template);
      }
      await load(query);
    } catch {
      message.error("重新发布模板失败");
    } finally {
      setRepublishSubmitting(false);
    }
  };

  // Snapshot computations & Dependency Closure (D6)
  const snapshot = selected?.snapshot;
  const flow = snapshot?.flow;
  const snapshotElements = useMemo(() => snapshot?.elements || [], [snapshot]);
  const snapshotVariables = useMemo(() => snapshot?.variables || [], [snapshot]);
  const snapshotEnvironments = useMemo(() => snapshot?.environments || [], [snapshot]);

  // Compute elements & variables strictly required by flow
  const { flowRequiredElementIds, flowRequiredVariableIds } = useMemo(() => {
    const reqElemIds = new Set<string>();
    const reqVarIds = new Set<string>();
    if (!flow || !flow.steps) return { flowRequiredElementIds: reqElemIds, flowRequiredVariableIds: reqVarIds };

    for (const step of flow.steps) {
      const ref = step.elementId || step.element;
      if (ref) {
        const found = snapshotElements.find((e) => e.id === ref || e.name === ref);
        if (found) reqElemIds.add(found.id);
      }
      // Scan all string properties in step for {{var}} references
      for (const val of Object.values(step)) {
        if (typeof val === "string") {
          for (const v of snapshotVariables) {
            const varName = v.name;
            const varRef = `${v.scope === "环境" ? "env" : "project"}.${varName}`;
            if (
              val.includes(`{{${varRef}}}`) ||
              val.includes(`{{${varName}}}`) ||
              val.includes(`{{secret.${varName}}}`)
            ) {
              reqVarIds.add(v.id);
            }
          }
        }
      }
    }
    if (flow.secretNames && Array.isArray(flow.secretNames)) {
      for (const sName of flow.secretNames) {
        for (const v of snapshotVariables) {
          const varRef = `${v.scope === "环境" ? "env" : "project"}.${v.name}`;
          if (sName === varRef || sName === v.name || sName === `secret.${v.name}`) {
            reqVarIds.add(v.id);
          }
        }
      }
    }
    return { flowRequiredElementIds: reqElemIds, flowRequiredVariableIds: reqVarIds };
  }, [flow, snapshotElements, snapshotVariables]);

  // Handle flow selection toggle with dependency closure
  const handleFlowToggle = (checked: boolean) => {
    setApplyFlow(checked);
    if (checked) {
      // Auto include required elements & variables
      setSelectedElementIds((prev) => Array.from(new Set([...prev, ...flowRequiredElementIds])));
      setSelectedVariableIds((prev) => Array.from(new Set([...prev, ...flowRequiredVariableIds])));
    }
  };

  const handleApply = async () => {
    if (!session || !selected || !targetProjectId) return;
    setApplying(true);
    try {
      const res = await applyPlatformTemplate(session.token, selected.id, {
        projectId: targetProjectId,
        selection: {
          flow: applyFlow,
          elements: selectedElementIds,
          variables: selectedVariableIds,
          environments: applyEnvironments,
        },
        elementMappings,
      });
      setApplyResult(res);
      message.success("模板应用成功！");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "应用模板失败";
      message.error(errMsg);
    } finally {
      setApplying(false);
    }
  };

  // Selected elements for mapping table
  const elementsForMapping = useMemo(() => {
    return snapshotElements.filter((e) => selectedElementIds.includes(e.id));
  }, [snapshotElements, selectedElementIds]);

  const targetProjectObj = useMemo(() => {
    return projects.find((p) => p.id === targetProjectId);
  }, [projects, targetProjectId]);

  return (
    <div className="workspace-layout">
      <WorkspaceSide />
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">工作空间</span>
            <h1>内部模板库</h1>
          </div>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!canPublish}
            onClick={() => {
              setRevisions([]);
              setPublishOpen(true);
            }}
          >
            发布模板
          </Button>
        </header>

        <div className="template-toolbar">
          <Input
            placeholder="搜索模板名称或说明…"
            prefix={<SearchOutlined />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onPressEnter={() => void load(query)}
            allowClear
            style={{ width: 280 }}
          />
          <Select
            value={category}
            onChange={setCategory}
            style={{ width: 140 }}
            options={[
              { value: "all", label: "全部分类" },
              ...categories.map((item) => ({ value: item, label: item })),
            ]}
          />
          <Select
            value={sort}
            onChange={setSort}
            style={{ width: 130 }}
            options={[
              { value: "recommended", label: "收藏优先" },
              { value: "latest", label: "最近更新" },
              { value: "name", label: "名称排序" },
            ]}
          />
          <Button onClick={() => void load(query)}>搜索</Button>
        </div>

        <section className="template-grid">
          {loading ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : visibleTemplates.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已发布模板" />
          ) : (
            <List
              grid={{ gutter: 16, xs: 1, sm: 2, lg: 3 }}
              dataSource={visibleTemplates}
              renderItem={(template) => {
                const isOutdated = Boolean(outdatedMap[template.id]);
                return (
                  <List.Item>
                    <article
                      className="template-card"
                      role="button"
                      tabIndex={0}
                      aria-label={`打开模板 ${template.name}`}
                      onClick={() => void openTemplate(template)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void openTemplate(template);
                        }
                      }}
                    >
                      <div className="template-card-top">
                        <Space size={6}>
                          <Tag>{template.category}</Tag>
                          {isOutdated && (
                            <Tooltip title="源项目已有更高版本的已发布快照，点击可重新发布覆盖当前模板快照">
                              <Tag
                                color="warning"
                                icon={<SyncOutlined spin={false} />}
                                style={{ cursor: "pointer" }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void openRepublish(template);
                                }}
                              >
                                有新版本
                              </Tag>
                            </Tooltip>
                          )}
                        </Space>
                        <Button
                          type="text"
                          size="small"
                          aria-label={template.favorite ? "取消收藏" : "收藏"}
                          icon={template.favorite ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!session) return;
                            void favoritePlatformTemplate(session.token, template.id, !template.favorite).then(() =>
                              setTemplates((items) =>
                                items.map((item) =>
                                  item.id === template.id ? { ...item, favorite: !item.favorite } : item,
                                ),
                              ),
                            );
                          }}
                        />
                      </div>
                      <h2>{template.name}</h2>
                      <p>{template.description || "无说明"}</p>
                      <div className="template-card-footer">
                        <Space size={12} className="template-meta-info" style={{ color: "var(--muted)", fontSize: "12px" }}>
                          <span>{template.createdAt.slice(0, 10)}</span>
                          {isOutdated && (
                            <Button
                              type="link"
                              size="small"
                              style={{ padding: 0, height: "auto", fontSize: "12px" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void openRepublish(template);
                              }}
                            >
                              更新版本
                            </Button>
                          )}
                        </Space>
                      </div>
                    </article>
                  </List.Item>
                );
              }}
            />
          )}
        </section>
      </main>

      {/* Application Drawer */}
      <Drawer
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{selected?.name || "模板详情与应用"}</span>
            {selected?.category && <Tag>{selected.category}</Tag>}
          </div>
        }
        open={Boolean(selected)}
        onClose={() => setSelected(undefined)}
        width={620}
        extra={
          selected ? (
            <Space>
              <Button
                aria-label="编辑模板"
                icon={<EditOutlined />}
                onClick={() => setEditOpen(true)}
              >
                编辑
              </Button>
              <Popconfirm
                title="归档该模板？"
                description="归档后此模板将从模板库中隐藏，但已应用项目的资源不受影响。"
                onConfirm={() =>
                  session &&
                  deletePlatformTemplate(session.token, selected.id)
                    .then(() => {
                      setSelected(undefined);
                      return load(query);
                    })
                    .then(() => message.success("模板已归档"))
                    .catch(() => message.error("模板归档失败"))
                }
              >
                <Button danger aria-label="归档模板" icon={<DeleteOutlined />}>
                  归档
                </Button>
              </Popconfirm>
            </Space>
          ) : undefined
        }
      >
        {selected && (
          <div className="template-drawer-content" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Description & Overview */}
            <div className="template-overview-box">
              <Paragraph style={{ margin: 0, color: "var(--text-secondary, #555)" }}>
                {selected.description || "暂无详细描述"}
              </Paragraph>
            </div>

            {/* Section 1: Snapshot Preview & Resource Selection */}
            <Card
              size="small"
              title={
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Space>
                    <NodeIndexOutlined style={{ color: "var(--primary, #1677ff)" }} />
                    <span style={{ fontWeight: 600 }}>1. 快照内容预览与勾选</span>
                  </Space>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    勾选需要复用的资源子集
                  </Text>
                </div>
              }
              styles={{ body: { padding: "12px" } }}
            >
              <Collapse
                defaultActiveKey={["flow", "elements", "variables"]}
                size="small"
                items={[
                  // Flow Step Preview
                  ...(flow
                    ? [
                        {
                          key: "flow",
                          label: (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={applyFlow}
                                onChange={(e) => handleFlowToggle(e.target.checked)}
                              >
                                <strong>流程：{flow.name || "未命名流程"}</strong>
                              </Checkbox>
                              <Badge count={flow.steps?.length ?? 0} overflowCount={999} style={{ backgroundColor: "#52c41a" }} />
                              {flow.secretNames && flow.secretNames.length > 0 && (
                                <Tooltip title={`含 ${flow.secretNames.length} 个密钥变量绑定，应用时将在目标项目中自动创建占位`}>
                                  <Tag color="purple" icon={<KeyOutlined />}>
                                    {flow.secretNames.length} 密钥
                                  </Tag>
                                </Tooltip>
                              )}
                            </div>
                          ),
                          children: (
                            <div style={{ maxHeight: 200, overflowY: "auto" }}>
                              {flow.steps && flow.steps.length > 0 ? (
                                <List
                                  size="small"
                                  dataSource={flow.steps}
                                  renderItem={(step, idx) => (
                                    <List.Item style={{ padding: "4px 8px" }}>
                                      <Space size={8} style={{ fontSize: "12px" }}>
                                        <Text type="secondary">{idx + 1}.</Text>
                                        <Tag color="blue">{step.action || "步骤"}</Tag>
                                        {step.element && <Text strong>{step.element}</Text>}
                                        {step.value && (
                                          <Text code style={{ fontSize: "11px" }}>
                                            {step.value.length > 35 ? `${step.value.slice(0, 35)}…` : step.value}
                                          </Text>
                                        )}
                                      </Space>
                                    </List.Item>
                                  )}
                                />
                              ) : (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无步骤定义" />
                              )}
                            </div>
                          ),
                        },
                      ]
                    : []),
                  // Elements Preview
                  ...(snapshotElements.length > 0
                    ? [
                        {
                          key: "elements",
                          label: (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                indeterminate={
                                  selectedElementIds.length > 0 &&
                                  selectedElementIds.length < snapshotElements.length
                                }
                                checked={selectedElementIds.length === snapshotElements.length}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedElementIds(snapshotElements.map((item) => item.id));
                                  } else {
                                    // Keep flow required if flow is checked
                                    setSelectedElementIds(applyFlow ? Array.from(flowRequiredElementIds) : []);
                                  }
                                }}
                              >
                                <strong>元素资产 ({snapshotElements.length})</strong>
                              </Checkbox>
                            </div>
                          ),
                          children: (
                            <div style={{ maxHeight: 180, overflowY: "auto" }}>
                              <List
                                size="small"
                                dataSource={snapshotElements}
                                renderItem={(elem) => {
                                  const isSelected = selectedElementIds.includes(elem.id);
                                  const isFlowRequired = applyFlow && flowRequiredElementIds.has(elem.id);
                                  return (
                                    <List.Item style={{ padding: "4px 8px" }}>
                                      <Checkbox
                                        checked={isSelected}
                                        disabled={isFlowRequired}
                                        onChange={(e) => {
                                          if (e.target.checked) {
                                            setSelectedElementIds((prev) => [...prev, elem.id]);
                                          } else {
                                            setSelectedElementIds((prev) => prev.filter((id) => id !== elem.id));
                                          }
                                        }}
                                      >
                                        <Space size={6}>
                                          <Text strong>{elem.name}</Text>
                                          <Tag>{elem.method || "css"}</Tag>
                                          <Text type="secondary" style={{ fontSize: "11px" }}>
                                            {elem.value || elem.selector}
                                          </Text>
                                          {isFlowRequired && <Tag color="orange">流程依赖</Tag>}
                                        </Space>
                                      </Checkbox>
                                    </List.Item>
                                  );
                                }}
                              />
                            </div>
                          ),
                        },
                      ]
                    : []),
                  // Variables Preview
                  ...(snapshotVariables.length > 0
                    ? [
                        {
                          key: "variables",
                          label: (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                indeterminate={
                                  selectedVariableIds.length > 0 &&
                                  selectedVariableIds.length < snapshotVariables.length
                                }
                                checked={selectedVariableIds.length === snapshotVariables.length}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedVariableIds(snapshotVariables.map((v) => v.id));
                                  } else {
                                    setSelectedVariableIds(applyFlow ? Array.from(flowRequiredVariableIds) : []);
                                  }
                                }}
                              >
                                <strong>变量资产 ({snapshotVariables.length})</strong>
                              </Checkbox>
                            </div>
                          ),
                          children: (
                            <div style={{ maxHeight: 180, overflowY: "auto" }}>
                              <List
                                size="small"
                                dataSource={snapshotVariables}
                                renderItem={(v) => {
                                  const isSelected = selectedVariableIds.includes(v.id);
                                  const isFlowRequired = applyFlow && flowRequiredVariableIds.has(v.id);
                                  return (
                                    <List.Item style={{ padding: "4px 8px" }}>
                                      <Checkbox
                                        checked={isSelected}
                                        disabled={isFlowRequired}
                                        onChange={(e) => {
                                          if (e.target.checked) {
                                            setSelectedVariableIds((prev) => [...prev, v.id]);
                                          } else {
                                            setSelectedVariableIds((prev) => prev.filter((id) => id !== v.id));
                                          }
                                        }}
                                      >
                                        <Space size={6}>
                                          <Text strong>{v.name}</Text>
                                          <Tag color={v.scope === "环境" ? "cyan" : "geekblue"}>{v.scope || "项目"}</Tag>
                                          {v.secret && <Tag color="purple">密钥</Tag>}
                                          {isFlowRequired && <Tag color="orange">流程依赖</Tag>}
                                        </Space>
                                      </Checkbox>
                                    </List.Item>
                                  );
                                }}
                              />
                            </div>
                          ),
                        },
                      ]
                    : []),
                  // Environments Preview
                  ...(snapshotEnvironments.length > 0
                    ? [
                        {
                          key: "environments",
                          label: (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={applyEnvironments}
                                onChange={(e) => setApplyEnvironments(e.target.checked)}
                              >
                                <strong>运行环境配置 ({snapshotEnvironments.length})</strong>
                              </Checkbox>
                            </div>
                          ),
                          children: (
                            <List
                              size="small"
                              dataSource={snapshotEnvironments}
                              renderItem={(env) => (
                                <List.Item style={{ padding: "4px 8px" }}>
                                  <Text>{env.name || "未命名环境"}</Text>
                                </List.Item>
                              )}
                            />
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </Card>

            {/* Section 2: Element Remapping Table (R3/D5) */}
            {elementsForMapping.length > 0 && (
              <Card
                size="small"
                title={
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <Space>
                      <CodeOutlined style={{ color: "var(--primary, #1677ff)" }} />
                      <span style={{ fontWeight: 600 }}>2. 元素重映射配置</span>
                    </Space>
                    <Text type="secondary" style={{ fontSize: "12px" }}>
                      可选映射至目标项目已有元素
                    </Text>
                  </div>
                }
                styles={{ body: { padding: "12px" } }}
              >
                <div style={{ marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    将模板元素映射至目标项目已有元素可避免重复创建；未映射的元素将按同名规则自动创建。
                  </Text>
                </div>
                <Table
                  size="small"
                  pagination={false}
                  loading={candidatesLoading}
                  dataSource={elementsForMapping}
                  rowKey="id"
                  columns={[
                    {
                      title: "模板元素",
                      key: "templateElem",
                      width: "45%",
                      render: (_, elem) => (
                        <div>
                          <div>
                            <Text strong>{elem.name}</Text>
                          </div>
                          <div style={{ fontSize: "11px", color: "var(--muted)" }}>
                            {elem.method}: {elem.value || elem.selector}
                          </div>
                        </div>
                      ),
                    },
                    {
                      title: "目标项目元素",
                      key: "targetMapping",
                      render: (_, elem) => {
                        const currentVal = elementMappings[elem.id] || "";
                        return (
                          <Select
                            style={{ width: "100%" }}
                            size="small"
                            placeholder="✨ 创建新元素（自动去重）"
                            value={currentVal}
                            onChange={(val) => {
                              setElementMappings((prev) => ({
                                ...prev,
                                [elem.id]: val || null,
                              }));
                            }}
                            options={[
                              { value: "", label: "✨ 创建新元素（自动去重）" },
                              ...candidates.map((cand) => ({
                                value: cand.id,
                                label: `${cand.name} (${cand.method}: ${cand.selector.slice(0, 20)})`,
                              })),
                            ]}
                          />
                        );
                      },
                    },
                  ]}
                />
              </Card>
            )}

            {/* Section 3: Apply & Conflicts Alert */}
            <Card
              size="small"
              title={
                <Space>
                  <AppstoreAddOutlined style={{ color: "var(--primary, #1677ff)" }} />
                  <span style={{ fontWeight: 600 }}>3. 应用模板到项目</span>
                </Space>
              }
              styles={{ body: { padding: "16px" } }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Text strong style={{ width: 80, flexShrink: 0 }}>
                    目标项目:
                  </Text>
                  <Select
                    style={{ flex: 1 }}
                    value={targetProjectId}
                    onChange={(val) => void handleTargetProjectChange(val)}
                    options={projects.map((p) => ({ value: p.id, label: p.name }))}
                    placeholder="选择目标项目"
                  />
                  <Button
                    type="primary"
                    icon={<AppstoreAddOutlined />}
                    loading={applying}
                    disabled={!targetProjectId || !session}
                    onClick={() => void handleApply()}
                  >
                    应用模板
                  </Button>
                </div>

                {/* Apply Result Display */}
                {applyResult && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                    <Alert
                      type="success"
                      showIcon
                      icon={<CheckCircleOutlined />}
                      title="模板已成功应用到项目"
                      description={
                        <div>
                          <div>
                            已在项目「<strong>{targetProjectObj?.name || targetProjectId}</strong>」中创建：
                            {applyResult.created?.flows?.length ? ` ${applyResult.created.flows.length} 个流程` : ""}
                            {applyResult.created?.elements?.length ? `、${applyResult.created.elements.length} 个元素` : ""}
                            {applyResult.created?.variables?.length ? `、${applyResult.created.variables.length} 个变量` : ""}
                            {applyResult.created?.environments?.length ? `、${applyResult.created.environments.length} 个环境` : ""}
                            。
                          </div>
                        </div>
                      }
                    />

                    {/* Conflicts Alert */}
                    {applyResult.conflicts && applyResult.conflicts.length > 0 && (
                      <Alert
                        type="info"
                        showIcon
                        title="检测到同名资源，已自动重命名（避免覆盖）"
                        description={
                          <ul style={{ margin: "4px 0 0 0", paddingLeft: 18, fontSize: "12px" }}>
                            {applyResult.conflicts.map((c, i) => (
                              <li key={i}>
                                {c.resourceType === "flows"
                                  ? "流程"
                                  : c.resourceType === "elements"
                                    ? "元素"
                                    : c.resourceType === "variables"
                                      ? "变量"
                                      : "环境"}
                                ：「<strong>{c.originalName}</strong>」→「<strong>{c.newName}</strong>」
                              </li>
                            ))}
                          </ul>
                        }
                      />
                    )}

                    {/* Warnings Alert */}
                    {applyResult.warnings && applyResult.warnings.length > 0 && (
                      <Alert
                        type="warning"
                        showIcon
                        title="提示"
                        description={applyResult.warnings.join("；")}
                      />
                    )}

                    {/* Quick navigation to Validation */}
                    <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                      {applyResult.created?.flows?.[0] ? (
                        <Button
                          type="primary"
                          onClick={() => {
                            const createdFlowId = applyResult.created.flows[0];
                            navigate(`/project/${targetProjectId}/flows/${createdFlowId}/edit`);
                          }}
                        >
                          前往流程编辑器校验元素定位
                        </Button>
                      ) : (
                        <Button
                          type="primary"
                          onClick={() => {
                            navigate(`/project/${targetProjectId}/elements`);
                          }}
                        >
                          前往元素资产列表
                        </Button>
                      )}
                      <Button onClick={() => setApplyResult(null)}>关闭提示</Button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </Drawer>

      {/* Publish Template Modal */}
      <Modal
        title="发布内部模板"
        open={publishOpen}
        destroyOnHidden
        afterOpenChange={(open) => {
          if (open && projects[0]) void loadRevisions(projects[0].id);
        }}
        okText="发布模板"
        okButtonProps={{ disabled: revisions.length === 0 }}
        onCancel={() => setPublishOpen(false)}
        onOk={() => form.validateFields().then(publish)}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ projectId: projects[0]?.id, category: "通用" }}
        >
          <Form.Item name="projectId" label="来源项目" rules={[{ required: true }]}>
            <Select
              options={projects.map((project) => ({
                value: project.id,
                label: project.name,
              }))}
              onChange={(value) => void loadRevisions(value)}
            />
          </Form.Item>
          <Form.Item
            name="revisionId"
            label="已发布版本"
            rules={[{ required: true, message: "请选择已发布版本" }]}
          >
            <Select
              options={revisions.map((revision) => ({
                value: revision.id,
                label: `${revision.flowName ?? "流程"} · v${revision.revisionNumber}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="name" label="模板名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit Template Info Modal */}
      <Modal
        title="更新模板信息"
        open={editOpen}
        destroyOnHidden
        okText="保存"
        onCancel={() => setEditOpen(false)}
        onOk={() => editForm.validateFields().then(update)}
      >
        <Form
          form={editForm}
          layout="vertical"
          initialValues={{
            name: selected?.name,
            description: selected?.description,
            category: selected?.category,
          }}
        >
          <Form.Item name="name" label="模板名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Re-Publish Template Modal (R4) */}
      <Modal
        title="重新发布模板快照"
        open={republishOpen}
        destroyOnHidden
        okText="确认重新发布"
        confirmLoading={republishSubmitting}
        okButtonProps={{ disabled: republishRevisions.length === 0 }}
        onCancel={() => setRepublishOpen(false)}
        onOk={() => void handleRepublish()}
      >
        <div style={{ marginBottom: 16 }}>
          <Alert
            type="warning"
            showIcon
            title="覆盖模板快照提示"
            description="重新发布将使用选中的已发布版本覆盖此模板的冻结快照。此前已应用该模板的项目属于独立克隆，不受影响。"
          />
        </div>
        <Form form={republishForm} layout="vertical">
          <Form.Item label="模板名称">
            <Input value={republishTemplate?.name} disabled />
          </Form.Item>
          <Form.Item
            name="revisionId"
            label="选择已发布版本"
            rules={[{ required: true, message: "请选择版本" }]}
          >
            <Select
              options={republishRevisions.map((rev) => ({
                value: rev.id,
                label: `${rev.flowName ?? "流程"} · v${rev.revisionNumber} (${rev.createdAt.slice(0, 10)})`,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
