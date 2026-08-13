import { message, modal } from "../antd-feedback";
import { useNavigate } from "../router";
import { useRunStore } from "../run-store";
import { WorkspaceSide, emptyRuns, isTerminalStatus } from "./shared";
import { useWorkspaceStore } from "../workspace-store";
import { InboxOutlined, MoreOutlined, PlusOutlined, SearchOutlined, UndoOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Form, Input, List, Modal, Progress, Space, Table } from "antd";
import type { TableColumnsType } from "antd";
import { useState } from "react";
import type { Project } from "../mock-data";
import { useQueryClient } from "@tanstack/react-query";
import { createWorkspaceProject, getWorkspaceProjects, updatePlatformProject } from "../platform-api";
import type { PlatformProject } from "../platform-api";
import { readStoredPlatformSession, readStoredPlatformWorkspaceId } from "../platform-context";

const serverWorkspaceEnabled = import.meta.env.PROD || import.meta.env.VITE_AUTH_REQUIRED === "1";

type ProjectListRow = Project & {
  environmentCount: number;
  flowCount: number;
  lastRun: string;
  health?: number;
};

export function ProjectsPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<PlatformProject[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const projectList = useWorkspaceStore((state) => state.projects);
  const flowsByProject = useWorkspaceStore((state) => state.flowsByProject);
  const environmentsByProject = useWorkspaceStore((state) => state.environmentsByProject);
  const runRecords = useRunStore((state) => state.apiRuns);
  const createProject = useWorkspaceStore((state) => state.createProject);
  const archiveProject = useWorkspaceStore((state) => state.archiveProject);
  const [form] = Form.useForm();
  const queryClient = useQueryClient();
  const projectRows: ProjectListRow[] = projectList.map((project) => {
    const projectRuns = runRecords[project.id] ?? emptyRuns;
    const completedProjectRuns = projectRuns.filter((run) => isTerminalStatus(run.status));
    return {
      ...project,
      environmentCount: environmentsByProject[project.id]?.length ?? 0,
      flowCount: flowsByProject[project.id]?.length ?? 0,
      lastRun: projectRuns[0]?.startedAt ?? "尚未运行",
      health: completedProjectRuns.length
        ? Math.round(
            (completedProjectRuns.filter((run) => run.status === "success").length /
              completedProjectRuns.length) *
              100,
          )
        : undefined,
    };
  });
  const visibleProjects = projectRows.filter((project) =>
    project.name.toLowerCase().includes(query.toLowerCase()),
  );
  const runs = Object.values(runRecords).flat();
  const completedRuns = runs.filter((run) => isTerminalStatus(run.status));
  const successRate = completedRuns.length
    ? `${Math.round((completedRuns.filter((run) => run.status === "success").length / completedRuns.length) * 100)}%`
    : "-";
  const openArchive = async () => {
    const session = readStoredPlatformSession();
    const workspaceId = readStoredPlatformWorkspaceId(session);
    if (!session || !workspaceId) return;
    setArchiveOpen(true);
    setArchiveLoading(true);
    try { setArchivedProjects((await getWorkspaceProjects(session.token, workspaceId, true)).projects); }
    catch { message.error("归档项目加载失败"); }
    finally { setArchiveLoading(false); }
  };
  const restoreProject = async (project: PlatformProject) => {
    const session = readStoredPlatformSession();
    const workspaceId = readStoredPlatformWorkspaceId(session);
    if (!session || !workspaceId) return;
    try {
      await updatePlatformProject(session.token, project.id, { name: project.name, description: project.description, archived: false });
      setArchivedProjects((items) => items.filter((item) => item.id !== project.id));
      await queryClient.invalidateQueries({ queryKey: ["server-workspace", workspaceId] });
      message.success(`“${project.name}”已恢复`);
    } catch { message.error("项目恢复失败"); }
  };

  const columns: TableColumnsType<ProjectListRow> = [
    {
      title: "项目",
      dataIndex: "name",
      render: (_, project) => (
        <button
          className="project-cell"
          onClick={() => navigate(`/project/${project.id}/overview`)}
        >
          <span className="project-icon">{project.name.slice(0, 1)}</span>
          <span>
            <strong>{project.name}</strong>
            <small>{project.description}</small>
          </span>
        </button>
      ),
    },
    {
      title: "环境",
      dataIndex: "environmentCount",
      width: 104,
      render: (value) => `${value} 个`,
    },
    {
      title: "流程",
      dataIndex: "flowCount",
      width: 104,
      render: (value) => `${value} 条`,
    },
    { title: "最近运行", dataIndex: "lastRun", width: 176, responsive: ["sm"] },
    {
      title: "健康度",
      dataIndex: "health",
      width: 130,
      responsive: ["sm"],
      render: (value) => (
        value === undefined ? (
          <span>-</span>
        ) : (
          <div className="health-cell">
            <Progress
              percent={value}
              showInfo={false}
              size="small"
              strokeColor={value > 90 ? "#227a52" : "#c68418"}
            />
            <span>{value}%</span>
          </div>
        )
      ),
    },
    {
      title: "",
      key: "actions",
      width: 68,
      align: "right",
      render: (_, project) => (
        <Dropdown
          menu={{
            items: [
              {
                key: "open",
                label: "进入项目",
                onClick: () => navigate(`/project/${project.id}/overview`),
              },
              {
                key: "archive",
                label: "归档项目",
                danger: true,
                onClick: () =>
                  modal.confirm({
                    title: `归档“${project.name}”？`,
                    content: "归档后将从活动项目列表移除。",
                    okText: "归档项目",
                    cancelText: "取消",
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      if (serverWorkspaceEnabled) {
                        const session = readStoredPlatformSession();
                        if (!session) throw new Error("AUTH_REQUIRED");
                        await updatePlatformProject(session.token, project.id, { name: project.name, description: project.description, archived: true });
                        await queryClient.invalidateQueries({ queryKey: ["server-workspace"] });
                      }
                      archiveProject(project.id);
                      message.info(`“${project.name}”已归档`);
                    },
                  }),
              },
            ],
          }}
        >
          <Button
            type="text"
            icon={<MoreOutlined />}
            aria-label={`${project.name}更多操作`}
          />
        </Dropdown>
      ),
    },
  ];

  return (
    <div className="workspace-layout">
      <WorkspaceSide />
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">工作空间</span>
            <h1>测试项目</h1>
          </div>
          <Space><Button icon={<InboxOutlined />} onClick={() => void openArchive()}>归档</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建项目</Button></Space>
        </header>
        <section className="workspace-summary">
          <div>
            <span>活跃项目</span>
            <strong>{projectList.length}</strong>
          </div>
          <div>
            <span>过去 7 天运行</span>
            <strong>{runs.length}</strong>
          </div>
          <div>
            <span>整体通过率</span>
            <strong className="success-number">{successRate}</strong>
          </div>
          <div>
            <span>运行中的任务</span>
            <strong className="running-number">{runs.filter((run) => run.status === "running").length}</strong>
          </div>
        </section>
        <div className="table-toolbar">
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索项目"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            allowClear
          />
          <span>{visibleProjects.length} 个项目</span>
        </div>
        <section className="surface project-table">
          <Table
            rowKey="id"
            columns={columns}
            dataSource={visibleProjects}
            pagination={false}
            locale={{ emptyText: <Empty description="尚未创建测试项目" /> }}
          />
        </section>
      </main>
      <Modal
        title="新建测试项目"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="创建项目"
        onOk={() =>
          form.validateFields().then(async (values) => {
            let project: Project;
            if (serverWorkspaceEnabled) {
              const session = readStoredPlatformSession();
              const workspaceId = readStoredPlatformWorkspaceId(session);
              if (!session || !workspaceId) throw new Error("AUTH_REQUIRED");
              project = (await createWorkspaceProject(session.token, workspaceId, values)).project;
              await queryClient.invalidateQueries({ queryKey: ["server-workspace", workspaceId] });
            } else {
              project = createProject(values);
            }
            setCreateOpen(false);
            form.resetFields();
            message.success("项目已创建");
            navigate(`/project/${project.id}/overview`);
          })
          .catch((error: unknown) => {
            if (Array.isArray(error)) return; // 表单字段校验错误由 Form 展示
            message.error("创建项目失败，请检查服务连接后重试");
          })
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="项目名称"
            name="name"
            rules={[{ required: true, message: "请输入项目名称" }]}
          >
            <Input placeholder="例如：支付中心 Web" autoFocus />
          </Form.Item>
          <Form.Item label="项目说明" name="description">
            <Input.TextArea rows={3} placeholder="简要说明被测系统和范围" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="归档项目" open={archiveOpen} footer={<Button onClick={() => setArchiveOpen(false)}>关闭</Button>} onCancel={() => setArchiveOpen(false)}>
        <List loading={archiveLoading} dataSource={archivedProjects} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无归档项目" /> }} renderItem={(project) => <List.Item actions={[<Button key="restore" icon={<UndoOutlined />} onClick={() => void restoreProject(project)}>恢复</Button>]}><List.Item.Meta title={project.name} description={project.description || "无说明"} /></List.Item>} />
      </Modal>
    </div>
  );
}
