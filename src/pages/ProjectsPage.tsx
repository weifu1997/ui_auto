import { message, modal } from "../antd-feedback";
import { useNavigate } from "../router";
import { useRunStore } from "../run-store";
import { WorkspaceSide, emptyRuns, isTerminalStatus } from "./shared";
import { useWorkspaceStore } from "../workspace-store";
import { MoreOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Form, Input, Modal, Progress, Table } from "antd";
import type { TableColumnsType } from "antd";
import { useState } from "react";
import type { Project } from "../mock-data";

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
  const projectList = useWorkspaceStore((state) => state.projects);
  const flowsByProject = useWorkspaceStore((state) => state.flowsByProject);
  const environmentsByProject = useWorkspaceStore((state) => state.environmentsByProject);
  const runRecords = useRunStore((state) => state.apiRuns);
  const createProject = useWorkspaceStore((state) => state.createProject);
  const archiveProject = useWorkspaceStore((state) => state.archiveProject);
  const [form] = Form.useForm();
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
    { title: "最近运行", dataIndex: "lastRun", width: 176 },
    {
      title: "健康度",
      dataIndex: "health",
      width: 130,
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
                    onOk: () => {
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
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            新建项目
          </Button>
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
          form.validateFields().then((values) => {
            const project = createProject(values);
            setCreateOpen(false);
            form.resetFields();
            message.success("项目已创建");
            navigate(`/project/${project.id}/overview`);
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
    </div>
  );
}
