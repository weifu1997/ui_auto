import { AppstoreAddOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SearchOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { Button, Drawer, Empty, Form, Input, List, Modal, Popconfirm, Select, Skeleton, Space, Tag } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { message } from "../antd-feedback";
import { applyPlatformTemplate, createPlatformTemplate, deletePlatformTemplate, favoritePlatformTemplate, getPlatformRevisions, getPlatformTemplate, getPlatformTemplates, updatePlatformTemplate } from "../platform-api";
import type { PlatformRevision, PlatformTemplate } from "../platform-api";
import { readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../platform-context";
import { useWorkspaceStore } from "../workspace-store";
import { WorkspaceSide } from "./shared";

type TemplateForm = { projectId: string; revisionId: string; name: string; description?: string; category?: string };

export function TemplatesPage() {
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
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [form] = Form.useForm<TemplateForm>();
  const [editForm] = Form.useForm<TemplateForm>();
  const projects = useWorkspaceStore((state) => state.projects);
  const [session] = useState(readStoredPlatformSession);
  const workspaceId = readStoredPlatformWorkspaceId(session);
  // 成员/角色已收敛为「登录即全权限」：发布与编辑模板能力恒可用。
  const canPublish = Boolean(session);

  const load = useCallback(async (search: string) => {
    if (!session || !workspaceId) return setLoading(false);
    setLoading(true);
    try { setTemplates((await getPlatformTemplates(session.token, workspaceId, search)).templates); }
    catch { message.error("模板库加载失败"); }
    finally { setLoading(false); }
  }, [session, workspaceId]);
  useEffect(() => { void load(""); }, [load]);

  const visibleTemplates = useMemo(() => {
    const filtered = category === "all" ? templates : templates.filter((template) => template.category === category);
    if (sort === "name") return [...filtered].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    if (sort === "latest") return [...filtered].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return filtered;
  }, [category, sort, templates]);
  const categories = [...new Set(templates.map((template) => template.category))];

  const openTemplate = async (template: PlatformTemplate) => {
    setSelected(template);
    setTargetProjectId(projects[0]?.id);
    if (!session) return;
    try { setSelected((await getPlatformTemplate(session.token, template.id)).template); }
    catch { message.error("模板详情加载失败"); }
  };
  const loadRevisions = async (projectId: string) => {
    if (!session) return;
    try {
      const items = (await getPlatformRevisions(session.token, projectId)).revisions.filter((revision) => revision.status === "published");
      setRevisions(items);
      form.setFieldValue("revisionId", items[0]?.id);
    } catch { setRevisions([]); message.error("已发布版本加载失败"); }
  };
  const publish = async (values: TemplateForm) => {
    if (!session || !workspaceId) return;
    try {
      await createPlatformTemplate(session.token, workspaceId, values);
      setPublishOpen(false);
      await load(query);
      message.success("模板已发布为冻结快照");
    } catch { message.error("模板发布失败，请确认版本已发布且权限足够"); }
  };
  const update = async (values: TemplateForm) => {
    if (!session || !selected) return;
    try {
      const result = await updatePlatformTemplate(session.token, selected.id, values);
      setSelected({ ...selected, ...result.template });
      setEditOpen(false);
      await load(query);
      message.success("模板信息已更新，冻结内容保持不变");
    } catch { message.error("只有创建者或管理员可以更新模板"); }
  };

  return (
    <div className="workspace-layout">
      <WorkspaceSide />
      <main className="workspace-main">
        <header className="workspace-header">
          <div><span className="eyebrow">工作空间</span><h1>内部模板库</h1></div>
          <Button type="primary" icon={<PlusOutlined />} disabled={!canPublish} onClick={() => { setRevisions([]); setPublishOpen(true); }}>发布模板</Button>
        </header>
        <div className="table-toolbar template-toolbar">
          <Input prefix={<SearchOutlined />} placeholder="搜索模板" value={query} onChange={(event) => setQuery(event.target.value)} onPressEnter={() => void load(query)} allowClear />
          <Select value={category} onChange={setCategory} options={[{ value: "all", label: "全部分类" }, ...categories.map((item) => ({ value: item, label: item }))]} />
          <Select value={sort} onChange={setSort} options={[{ value: "recommended", label: "收藏优先" }, { value: "latest", label: "最近更新" }, { value: "name", label: "名称排序" }]} />
          <Button onClick={() => void load(query)}>搜索</Button>
        </div>
        <section className="template-grid">
          {loading ? <Skeleton active /> : visibleTemplates.length === 0 ? <Empty description="暂无已发布模板" /> : (
            <List grid={{ gutter: 16, xs: 1, sm: 2, lg: 3 }} dataSource={visibleTemplates} renderItem={(template) => (
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
                  <div className="template-card-top"><Tag>{template.category}</Tag><Button type="text" size="small" aria-label={template.favorite ? "取消收藏" : "收藏"} icon={template.favorite ? <StarFilled /> : <StarOutlined />} onClick={(event) => { event.stopPropagation(); if (!session) return; void favoritePlatformTemplate(session.token, template.id, !template.favorite).then(() => setTemplates((items) => items.map((item) => item.id === template.id ? { ...item, favorite: !item.favorite } : item))); }} /></div>
                  <h2>{template.name}</h2><p>{template.description || "无说明"}</p>
                </article>
              </List.Item>
            )} />
          )}
        </section>
      </main>
      <Drawer title={selected?.name} open={Boolean(selected)} onClose={() => setSelected(undefined)} size={480} extra={selected ? <Space><Button aria-label="编辑模板" icon={<EditOutlined />} onClick={() => setEditOpen(true)} /><Popconfirm title="归档该模板？" onConfirm={() => session && deletePlatformTemplate(session.token, selected.id).then(() => { setSelected(undefined); return load(query); }).then(() => message.success("模板已归档")).catch(() => message.error("模板归档失败"))}><Button danger aria-label="归档模板" icon={<DeleteOutlined />} /></Popconfirm></Space> : undefined}>
        {selected && <div className="template-detail"><Tag>{selected.category}</Tag><p>{selected.description || "无说明"}</p><Select value={targetProjectId} onChange={setTargetProjectId} options={projects.map((project) => ({ value: project.id, label: project.name }))} placeholder="选择目标项目" /><Button type="primary" icon={<AppstoreAddOutlined />} loading={applying} disabled={!targetProjectId || !session} onClick={async () => { if (!session || !targetProjectId) return; setApplying(true); try { await applyPlatformTemplate(session.token, selected.id, targetProjectId); message.success("模板已应用到项目"); } catch { message.error("应用模板失败"); } finally { setApplying(false); } }}>应用模板</Button></div>}
      </Drawer>
      <Modal title="发布内部模板" open={publishOpen} destroyOnHidden afterOpenChange={(open) => { if (open && projects[0]) void loadRevisions(projects[0].id); }} okText="发布模板" okButtonProps={{ disabled: revisions.length === 0 }} onCancel={() => setPublishOpen(false)} onOk={() => form.validateFields().then(publish)}><Form form={form} layout="vertical" initialValues={{ projectId: projects[0]?.id, category: "通用" }}><Form.Item name="projectId" label="来源项目" rules={[{ required: true }]}><Select options={projects.map((project) => ({ value: project.id, label: project.name }))} onChange={(value) => void loadRevisions(value)} /></Form.Item><Form.Item name="revisionId" label="已发布版本" rules={[{ required: true, message: "请选择已发布版本" }]}><Select options={revisions.map((revision) => ({ value: revision.id, label: `${revision.flowName ?? "流程"} · v${revision.revisionNumber}` }))} /></Form.Item><Form.Item name="name" label="模板名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="category" label="分类"><Input /></Form.Item><Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item></Form></Modal>
      <Modal title="更新模板信息" open={editOpen} destroyOnHidden okText="保存" onCancel={() => setEditOpen(false)} onOk={() => editForm.validateFields().then(update)}><Form form={editForm} layout="vertical" initialValues={{ name: selected?.name, description: selected?.description, category: selected?.category }}><Form.Item name="name" label="模板名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="category" label="分类"><Input /></Form.Item><Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item></Form></Modal>
    </div>
  );
}
