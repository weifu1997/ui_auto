import {
  CopyOutlined,
  KeyOutlined,
  MailOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  UserDeleteOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Avatar,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { message } from "../antd-feedback";
import {
  createWorkspaceInvitation,
  createPlatformWorkspace,
  getPlatformAccounts,
  getWorkspaceInvitations,
  getWorkspaceMembers,
  issuePlatformPasswordReset,
  PlatformApiError,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  updatePlatformAccount,
  updateWorkspaceMemberRole,
  restorePlatformSession,
} from "../platform-api";
import type {
  PlatformAccount,
  PlatformWorkspaceInvitation,
  PlatformWorkspaceMember,
} from "../platform-api";
import {
  readStoredPlatformSession,
  readStoredPlatformWorkspaceId,
  storePlatformSession,
  storePlatformWorkspaceId,
} from "../platform-context";
import { Navigate, useNavigate } from "../router";
import { PageHeading, WorkspaceSide } from "./shared";

type InvitationFormValues = {
  email: string;
  role: PlatformWorkspaceMember["role"];
};

type WorkspaceFormValues = {
  name: string;
};

const workspaceRoleOptions = [
  { value: "member", label: "成员" },
  { value: "admin", label: "管理员" },
];

function operationError(error: unknown, fallback: string) {
  return error instanceof PlatformApiError ? `${fallback}（${error.code}）` : fallback;
}

function invitationStatus(invitation: PlatformWorkspaceInvitation) {
  const labels: Record<PlatformWorkspaceInvitation["status"], { label: string; color: string }> = {
    active: { label: "待接受", color: "processing" },
    consumed: { label: "已接受", color: "success" },
    revoked: { label: "已撤销", color: "default" },
    expired: { label: "已过期", color: "warning" },
  };
  const current = labels[invitation.status];
  return <Tag color={current.color}>{current.label}</Tag>;
}

/**
 * Server-issued capabilities decide whether this route is offered. Every
 * mutation still reaches the server, which enforces the same policy.
 */
export function WorkspaceAdministrationPage() {
  const navigate = useNavigate();
  const session = readStoredPlatformSession();
  const workspaceId = readStoredPlatformWorkspaceId(session);
  const workspace = session?.workspaces.find((item) => item.id === workspaceId);
  const isSuperAdmin = session?.user.globalRole === "super_admin";
  const canManageMembers = Boolean(
    isSuperAdmin || workspace?.role === "admin" || workspace?.capabilities?.includes("member.manage"),
  );
  const canManageInvitations = Boolean(
    isSuperAdmin || workspace?.role === "admin" || workspace?.capabilities?.includes("invite.manage"),
  );
  const hasSession = Boolean(session);
  const token = session?.token ?? "";
  const [members, setMembers] = useState<PlatformWorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<PlatformWorkspaceInvitation[]>([]);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string>();
  const [resetLink, setResetLink] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [workspaceSubmitting, setWorkspaceSubmitting] = useState(false);
  const [inviteForm] = Form.useForm<InvitationFormValues>();
  const [workspaceForm] = Form.useForm<WorkspaceFormValues>();

  const load = useCallback(async () => {
    if (!hasSession || (!workspaceId && !isSuperAdmin)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [memberResponse, invitationResponse, accountResponse] = await Promise.all([
        canManageMembers && workspaceId
          ? getWorkspaceMembers(token, workspaceId)
          : Promise.resolve({ members: [] }),
        canManageInvitations && workspaceId
          ? getWorkspaceInvitations(token, workspaceId)
          : Promise.resolve({ invitations: [] }),
        isSuperAdmin ? getPlatformAccounts(token) : Promise.resolve({ accounts: [] }),
      ]);
      setMembers(memberResponse.members);
      setInvitations(invitationResponse.invitations);
      setAccounts(accountResponse.accounts);
    } catch (error) {
      message.error(operationError(error, "无法加载成员与账户信息"));
    } finally {
      setLoading(false);
    }
  }, [canManageInvitations, canManageMembers, hasSession, isSuperAdmin, token, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeAdminCount = useMemo(
    () => members.filter((member) => member.role === "admin" && member.enabled).length,
    [members],
  );
  const activeSuperAdminCount = useMemo(
    () => accounts.filter((account) => account.globalRole === "super_admin" && account.enabled).length,
    [accounts],
  );

  const isLastActiveAdmin = (member: PlatformWorkspaceMember) =>
    member.role === "admin" && member.enabled && activeAdminCount <= 1;

  const isLastActiveSuperAdmin = (account: PlatformAccount) =>
    account.globalRole === "super_admin" && account.enabled && activeSuperAdminCount <= 1;

  if (!hasSession) {
    return <Navigate to="/projects" replace />;
  }

  if (workspace && !canManageMembers && !canManageInvitations && !isSuperAdmin) {
    return <Navigate to="/projects" replace />;
  }

  const changeMemberRole = async (
    member: PlatformWorkspaceMember,
    role: PlatformWorkspaceMember["role"],
  ) => {
    if (!workspaceId) return;
    if (member.role === "admin" && role === "member" && isLastActiveAdmin(member)) {
      return;
    }
    try {
      await updateWorkspaceMemberRole(token, workspaceId, member.id, role);
      message.success("成员角色已更新");
      await load();
    } catch (error) {
      message.error(operationError(error, "角色更新失败"));
    }
  };

  const removeMember = async (member: PlatformWorkspaceMember) => {
    if (!workspaceId) return;
    if (isLastActiveAdmin(member)) return;
    try {
      await removeWorkspaceMember(token, workspaceId, member.id);
      message.success("成员已从工作区移除");
      await load();
    } catch (error) {
      message.error(operationError(error, "移除成员失败"));
    }
  };

  const revokeInvitation = async (invitation: PlatformWorkspaceInvitation) => {
    if (!workspaceId) return;
    try {
      await revokeWorkspaceInvitation(token, workspaceId, invitation.id);
      message.success("邀请已撤销");
      await load();
    } catch (error) {
      message.error(operationError(error, "撤销邀请失败"));
    }
  };

  const createInvitation = async () => {
    if (!workspaceId) return;
    const values = await inviteForm.validateFields();
    setSubmitting(true);
    try {
      const response = await createWorkspaceInvitation(token, workspaceId, values);
      setInviteLink(
        `${window.location.origin}/invitations/accept?token=${encodeURIComponent(response.invitation.token)}`,
      );
      setInviteOpen(false);
      inviteForm.resetFields();
      message.success("邀请已创建，请在关闭本页面前复制链接");
      await load();
    } catch (error) {
      message.error(operationError(error, "创建邀请失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const changeAccountEnabled = async (account: PlatformAccount, enabled: boolean) => {
    if (!enabled && isLastActiveSuperAdmin(account)) return;
    try {
      await updatePlatformAccount(token, account.id, { enabled });
      message.success(enabled ? "账户已启用" : "账户已停用，旧会话已撤销");
      await load();
    } catch (error) {
      message.error(operationError(error, "账户状态更新失败"));
    }
  };

  const changeGlobalRole = async (account: PlatformAccount, value: string) => {
    const globalRole = value === "super_admin" ? "super_admin" : null;
    if (account.globalRole === "super_admin" && globalRole === null && isLastActiveSuperAdmin(account)) {
      return;
    }
    try {
      await updatePlatformAccount(token, account.id, { globalRole });
      message.success("部署级角色已更新，旧会话已撤销");
      await load();
    } catch (error) {
      message.error(operationError(error, "部署级角色更新失败"));
    }
  };

  const issuePasswordReset = async (account: PlatformAccount) => {
    try {
      const response = await issuePlatformPasswordReset(token, account.id);
      setResetLink(
        `${window.location.origin}/password-resets/accept?token=${encodeURIComponent(response.passwordReset.token)}`,
      );
      message.success("密码重置链接已生成，请仅通过受控渠道发送");
    } catch (error) {
      message.error(operationError(error, "生成密码重置链接失败"));
    }
  };

  const createWorkspace = async () => {
    const values = await workspaceForm.validateFields();
    setWorkspaceSubmitting(true);
    try {
      const response = await createPlatformWorkspace(token, values.name);
      const refreshed = await restorePlatformSession();
      storePlatformSession(refreshed);
      storePlatformWorkspaceId(response.workspace.id);
      workspaceForm.resetFields();
      setWorkspaceCreateOpen(false);
      message.success("工作区已创建");
      navigate("/projects", { replace: true });
    } catch (error) {
      message.error(operationError(error, "创建工作区失败"));
    } finally {
      setWorkspaceSubmitting(false);
    }
  };

  const memberColumns: TableColumnsType<PlatformWorkspaceMember> = [
    {
      title: "成员",
      key: "member",
      render: (_value, member) => (
        <Space size={12} align="center">
          <Avatar size={32} icon={<UserOutlined />} style={{ backgroundColor: "var(--accent)" }}>
            {member.name.slice(0, 1).toUpperCase()}
          </Avatar>
          <div>
            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{member.name}</div>
            <span style={{ fontSize: "var(--text-caption)", color: "var(--text-secondary)" }}>{member.email}</span>
          </div>
        </Space>
      ),
    },
    {
      title: "工作区角色",
      dataIndex: "role",
      width: 160,
      render: (_value, member) => (
        <Select
          aria-label={`设置 ${member.name} 的工作区角色`}
          value={member.role}
          options={workspaceRoleOptions}
          disabled={isLastActiveAdmin(member)}
          onChange={(role: PlatformWorkspaceMember["role"]) => void changeMemberRole(member, role)}
          style={{ width: 120 }}
        />
      ),
    },
    {
      title: "状态",
      dataIndex: "enabled",
      width: 104,
      render: (enabled: boolean) => (
        <Tag color={enabled ? "success" : "default"}>{enabled ? "正常" : "已停用"}</Tag>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 88,
      align: "right",
      render: (_value, member) => (
        <Popconfirm
          title={`移除 ${member.name}？`}
          description="该成员在本工作区的旧会话会立即失效；其他工作区关系不会删除。"
          okText="移除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          disabled={isLastActiveAdmin(member)}
          onConfirm={() => removeMember(member)}
        >
          <Tooltip title={isLastActiveAdmin(member) ? "不能移除最后一个启用的工作区管理员" : "移除成员"}>
            <Button
              danger
              type="text"
              size="small"
              icon={<UserDeleteOutlined />}
              aria-label={`移除成员 ${member.name}`}
              disabled={isLastActiveAdmin(member)}
            />
          </Tooltip>
        </Popconfirm>
      ),
    },
  ];

  const invitationColumns: TableColumnsType<PlatformWorkspaceInvitation> = [
    {
      title: "受邀邮箱",
      dataIndex: "email",
      render: (email: string) => (
        <Space size={8}>
          <MailOutlined style={{ color: "var(--text-tertiary)" }} />
          <span style={{ fontWeight: 500 }}>{email}</span>
        </Space>
      ),
    },
    {
      title: "预设角色",
      dataIndex: "role",
      width: 120,
      render: (role: PlatformWorkspaceInvitation["role"]) => (
        <Tag color={role === "admin" ? "purple" : "blue"}>
          {role === "admin" ? "管理员" : "成员"}
        </Tag>
      ),
    },
    {
      title: "邀请状态",
      key: "status",
      width: 112,
      render: (_value, invitation) => invitationStatus(invitation),
    },
    {
      title: "失效时间",
      dataIndex: "expiresAt",
      width: 200,
      render: (expiresAt: string) => new Date(expiresAt).toLocaleString("zh-CN"),
    },
    {
      title: "操作",
      key: "actions",
      width: 88,
      align: "right",
      render: (_value, invitation) => (
        <Popconfirm
          title="撤销这份邀请？"
          okText="撤销"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          disabled={invitation.status !== "active"}
          onConfirm={() => revokeInvitation(invitation)}
        >
          <Tooltip title={invitation.status === "active" ? "撤销邀请" : undefined}>
            <Button
              danger
              type="text"
              size="small"
              icon={<StopOutlined />}
              aria-label={`撤销邀请 ${invitation.email}`}
              disabled={invitation.status !== "active"}
            />
          </Tooltip>
        </Popconfirm>
      ),
    },
  ];

  const accountColumns: TableColumnsType<PlatformAccount> = [
    {
      title: "账户",
      key: "account",
      render: (_value, account) => (
        <Space size={12} align="center">
          <Avatar size={32} icon={<UserOutlined />} style={{ backgroundColor: account.globalRole === "super_admin" ? "var(--purple)" : "var(--accent)" }}>
            {account.name.slice(0, 1).toUpperCase()}
          </Avatar>
          <div>
            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{account.name}</div>
            <span style={{ fontSize: "var(--text-caption)", color: "var(--text-secondary)" }}>{account.email}</span>
          </div>
        </Space>
      ),
    },
    {
      title: "部署级角色",
      key: "globalRole",
      width: 190,
      render: (_value, account) => (
        <Select
          aria-label={`设置 ${account.name} 的部署级角色`}
          value={account.globalRole ?? "none"}
          options={[
            { value: "none", label: "普通账户" },
            { value: "super_admin", label: "超级管理员" },
          ]}
          disabled={isLastActiveSuperAdmin(account)}
          onChange={(value: string) => void changeGlobalRole(account, value)}
          style={{ width: 140 }}
        />
      ),
    },
    {
      title: "状态",
      key: "enabled",
      width: 180,
      render: (_value, account) => (
        <Space size={8}>
          <Tag color={account.enabled ? "success" : "default"}>{account.enabled ? "正常" : "已停用"}</Tag>
          <Popconfirm
            title={account.enabled ? `停用 ${account.name}？` : `启用 ${account.name}？`}
            description={account.enabled ? "该账户的所有会话会立即失效。" : undefined}
            okText={account.enabled ? "停用" : "启用"}
            cancelText="取消"
            okButtonProps={account.enabled ? { danger: true } : undefined}
            disabled={account.enabled && isLastActiveSuperAdmin(account)}
            onConfirm={() => changeAccountEnabled(account, !account.enabled)}
          >
            <Button
              type="text"
              size="small"
              aria-label={`${account.enabled ? "停用" : "启用"}账户 ${account.name}`}
              disabled={account.enabled && isLastActiveSuperAdmin(account)}
            >
              {account.enabled ? "停用" : "启用"}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 88,
      align: "right",
      render: (_value, account) => (
        <Tooltip title="生成一次性密码重置链接">
          <Button
            type="text"
            size="small"
            icon={<KeyOutlined />}
            aria-label={`生成 ${account.name} 的密码重置链接`}
            onClick={() => void issuePasswordReset(account)}
          />
        </Tooltip>
      ),
    },
  ];

  const workspaceManagement = workspaceId && (canManageMembers || canManageInvitations) ? (
    <Tabs
      className="administration-tabs"
      items={[
        {
          key: "members",
          label: "工作区成员",
          children: (
            <section className="surface administration-table">
              <div className="panel-heading">
                <div>
                  <h2>工作区成员</h2>
                  <span>角色变更和移除会立即生效并撤销受影响账户的活动会话。</span>
                </div>
                <Space size={8}>
                  <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    disabled={!canManageInvitations}
                    onClick={() => setInviteOpen(true)}
                    className="admin-invite-btn"
                  >
                    邀请成员
                  </Button>
                </Space>
              </div>
              <Table
                rowKey="id"
                loading={loading}
                columns={memberColumns}
                dataSource={members}
                pagination={false}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无工作区成员" /> }}
              />
            </section>
          ),
        },
        {
          key: "invitations",
          label: "受控邀请",
          children: (
            <section className="surface administration-table">
              <div className="panel-heading">
                <div>
                  <h2>邀请记录</h2>
                  <span>邀请链接创建后仅显示一次，默认 24 小时内有效。</span>
                </div>
                <Space size={8}>
                  <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    disabled={!canManageInvitations}
                    onClick={() => setInviteOpen(true)}
                    className="admin-invite-btn"
                  >
                    创建邀请
                  </Button>
                </Space>
              </div>
              <Table
                rowKey="id"
                loading={loading}
                columns={invitationColumns}
                dataSource={invitations}
                pagination={false}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无邀请记录" /> }}
              />
            </section>
          ),
        },
      ]}
    />
  ) : (
    <Alert type="info" showIcon message="当前没有可管理的工作区" description="创建工作区或选择一个已有工作区后，可在此管理成员和邀请。" />
  );

  return (
    <div className="workspace-layout administration-layout">
      <WorkspaceSide />
      <main className="workspace-main">
        <PageHeading
          title="成员与账户"
          description={workspace ? `管理“${workspace.name}”的成员、受控邀请和部署级账户。` : "管理部署级账户。"}
          actions={isSuperAdmin ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setWorkspaceCreateOpen(true)} className="admin-invite-btn">
              创建工作区
            </Button>
          ) : undefined}
        />
        {loading && !members.length && !accounts.length ? <div className="administration-loading"><Spin /></div> : workspaceManagement}
        {isSuperAdmin && (
          <section className="surface administration-table administration-accounts" style={{ marginTop: "var(--space-6)" }}>
            <div className="panel-heading">
              <div>
                <h2>部署级账户</h2>
                <span>仅超级管理员可变更账户状态、部署级角色或生成密码重置链接。</span>
              </div>
            </div>
            <Table
              rowKey="id"
              loading={loading}
              columns={accountColumns}
              dataSource={accounts}
              pagination={false}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账户" /> }}
            />
          </section>
        )}
      </main>

      <Modal
        title="邀请成员加入工作区"
        open={inviteOpen}
        confirmLoading={submitting}
        okText="创建邀请"
        cancelText="取消"
        onOk={() => void createInvitation()}
        onCancel={() => setInviteOpen(false)}
      >
        <Form form={inviteForm} layout="vertical" initialValues={{ role: "member" }} style={{ marginTop: 16 }}>
          <Form.Item
            label="邮箱"
            name="email"
            rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}
          >
            <Input autoFocus autoComplete="email" placeholder="member@company.com" prefix={<MailOutlined style={{ color: "var(--text-tertiary)" }} />} />
          </Form.Item>
          <Form.Item label="工作区角色" name="role" rules={[{ required: true }]}>
            <Select options={workspaceRoleOptions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="创建新工作区"
        open={workspaceCreateOpen}
        confirmLoading={workspaceSubmitting}
        okText="创建工作区"
        cancelText="取消"
        onOk={() => void createWorkspace()}
        onCancel={() => setWorkspaceCreateOpen(false)}
      >
        <Form form={workspaceForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="工作区名称"
            name="name"
            rules={[{ required: true, whitespace: true, message: "请输入工作区名称" }]}
          >
            <Input autoFocus maxLength={120} placeholder="例如：核心业务测试团队" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="复制邀请链接"
        open={Boolean(inviteLink)}
        footer={<Button type="primary" onClick={() => setInviteLink(undefined)}>已复制或安全保存</Button>}
        onCancel={() => setInviteLink(undefined)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
          <Alert
            type="warning"
            showIcon
            icon={<SafetyCertificateOutlined />}
            message="该链接仅在此时显示一次"
            description="请通过获批准的安全渠道发送给被邀请人。关闭此窗口后系统无法再次显示原始 token。"
          />
          <Input.TextArea
            aria-label="一次性邀请链接"
            value={inviteLink}
            readOnly
            autoSize={{ minRows: 3, maxRows: 5 }}
            style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
          />
          <Button
            type="dashed"
            icon={<CopyOutlined />}
            block
            onClick={() => {
              if (!inviteLink) return;
              void navigator.clipboard.writeText(inviteLink).then(
                () => message.success("邀请链接已复制到剪贴板"),
                () => message.error("复制失败，请手动复制链接"),
              );
            }}
          >
            点击复制链接
          </Button>
        </div>
      </Modal>

      <Modal
        title="复制一次性密码重置链接"
        open={Boolean(resetLink)}
        footer={<Button type="primary" onClick={() => setResetLink(undefined)}>已复制或安全保存</Button>}
        onCancel={() => setResetLink(undefined)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
          <Alert
            type="warning"
            showIcon
            icon={<SafetyCertificateOutlined />}
            message="该链接仅在此时显示一次"
            description="请通过获批准的安全渠道发送给用户；首次使用后 token 会立即失效。"
          />
          <Input.TextArea
            aria-label="一次性密码重置链接"
            value={resetLink}
            readOnly
            autoSize={{ minRows: 3, maxRows: 5 }}
            style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
          />
          <Button
            type="dashed"
            icon={<CopyOutlined />}
            block
            onClick={() => {
              if (!resetLink) return;
              void navigator.clipboard.writeText(resetLink).then(
                () => message.success("密码重置链接已复制到剪贴板"),
                () => message.error("复制失败，请手动复制链接"),
              );
            }}
          >
            点击复制链接
          </Button>
        </div>
      </Modal>
    </div>
  );
}
