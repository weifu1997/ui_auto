import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import { useNavigate } from "../router";
import { PageHeading, emptyMembers } from "./shared";
import { updatePlatformProject } from "../platform-api";
import { readStoredPlatformSession } from "../platform-context";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceStore } from "../workspace-store";
import { useThemeStore } from "../theme-mode";
import type { ThemeMode } from "../theme-mode";
import { PauseCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { Avatar, Button, Form, Input, Modal, Popconfirm, Segmented, Select, Tag } from "antd";
import { useEffect, useState } from "react";

const serverWorkspaceEnabled = import.meta.env.PROD || import.meta.env.VITE_AUTH_REQUIRED === "1";

export function SettingsPage({ project }: { project: Project }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const themeMode = useThemeStore((state) => state.mode);
  const setThemeMode = useThemeStore((state) => state.setMode);
  const updateProject = useWorkspaceStore((state) => state.updateProject);
  const archiveProject = useWorkspaceStore((state) => state.archiveProject);
  const members = useWorkspaceStore(
    (state) => state.membersByProject[project.id] ?? emptyMembers,
  );
  const addMember = useWorkspaceStore((state) => state.addMember);
  const [form] = Form.useForm();
  const [memberForm] = Form.useForm();
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  useEffect(() => {
    form.setFieldsValue({ name: project.name, description: project.description });
  }, [form, project.description, project.id, project.name]);
  return (
    <>
      <PageHeading
        title="项目设置"
        description="管理项目基础信息、成员权限和危险操作。"
      />
      <section className="settings-stack">
        <div className="surface settings-section">
          <div>
            <h2>基础信息</h2>
            <p>这些信息仅影响当前项目。</p>
          </div>
          <Form
            form={form}
            layout="vertical"
            onFinish={(values) => {
              updateProject(project.id, {
                name: values.name.trim(),
                description: values.description.trim(),
              });
              message.success("项目设置已保存");
            }}
          >
            <Form.Item
              name="name"
              label="项目名称"
              rules={[{ required: true, whitespace: true, message: "请输入项目名称" }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label="项目说明">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
            >
              保存修改
            </Button>
          </Form>
        </div>
        <div className="surface settings-section">
          <div>
            <h2>外观</h2>
            <p>选择界面明暗模式，跟随系统将自动适配。</p>
          </div>
          <Segmented
            value={themeMode}
            onChange={(value) => setThemeMode(value as ThemeMode)}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
          />
        </div>
        <div className="surface settings-section">
          <div>
            <h2>成员与权限</h2>
            <p>权限在项目边界内独立管理。</p>
          </div>
          <div className="member-row">
            <Avatar className="member-avatar">
              R
            </Avatar>
            <span>
              <strong>Rui Chen</strong>
              <small>rui@example.com</small>
            </span>
            <Tag color="success">管理员</Tag>
          </div>
          {members.map((member) => (
            <div className="member-row" key={member.id}>
              <Avatar className="member-avatar member-avatar-alt">
                {member.name.slice(0, 1).toUpperCase()}
              </Avatar>
              <span>
                <strong>{member.name}</strong>
                <small>{member.email}</small>
              </span>
              <Tag color={member.role === "管理员" ? "success" : "processing"}>
                {member.role}
              </Tag>
            </div>
          ))}
          <Button icon={<PlusOutlined />} onClick={() => setMemberDialogOpen(true)}>
            添加成员
          </Button>
        </div>
        <div className="surface settings-section danger-zone">
          <div>
            <h2>归档项目</h2>
            <p>项目将从活动列表移除，并清理当前浏览器中的项目资产与配置。</p>
          </div>
          <Popconfirm
            title={`归档“${project.name}”？`}
            description="归档后将从活动项目列表移除。"
            okText="归档项目"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              if (serverWorkspaceEnabled) {
                const session = readStoredPlatformSession();
                if (!session) {
                  message.error("归档失败：未登录平台");
                  return;
                }
                try {
                  await updatePlatformProject(session.token, project.id, { name: project.name, description: project.description, archived: true });
                  await queryClient.invalidateQueries({ queryKey: ["server-workspace"] });
                } catch {
                  message.error("归档失败，请稍后重试");
                  return;
                }
              }
              archiveProject(project.id);
              message.info(`“${project.name}”已归档`);
              navigate("/projects");
            }}
          >
            <Button danger icon={<PauseCircleOutlined />}>
              归档项目
            </Button>
          </Popconfirm>
        </div>
      </section>
      <Modal
        title="添加项目成员"
        open={memberDialogOpen}
        onCancel={() => setMemberDialogOpen(false)}
        okText="添加成员"
        onOk={() =>
          memberForm.validateFields().then((values) => {
            addMember(project.id, {
              name: values.name.trim(),
              email: values.email.trim(),
              role: values.role,
            });
            memberForm.resetFields();
            setMemberDialogOpen(false);
            message.success("成员已添加");
          })
        }
      >
        <Form form={memberForm} layout="vertical" initialValues={{ role: "成员" }}>
          <Form.Item
            name="name"
            label="成员姓名"
            rules={[{ required: true, message: "请输入成员姓名" }]}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item
            name="email"
            label="成员邮箱"
            rules={[
              { required: true, message: "请输入成员邮箱" },
              { type: "email", message: "请输入有效邮箱" },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="role" label="项目角色">
            <Select options={["成员", "管理员"].map((value) => ({ value }))} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
