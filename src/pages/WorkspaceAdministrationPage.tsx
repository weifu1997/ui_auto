import {
  CopyOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  UserDeleteOutlined,
} from "@ant-design/icons";
import {
  Alert,
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
    workspace?.capabilities.includes("member.manage"),
  );
  const canManageInvitations = Boolean(
    workspace?.capabilities.includes("invite.manage"),
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

  if (!canManageMembers && !isSuperAdmin) {
    return <Navigate to="/projects" replace />;
  }

  const isLastActiveAdmin = (member: PlatformWorkspaceMember) =>
    member.role === "admin" && member.enabled && activeAdminCount <= 1;
  const isLastActiveSuperAdmin = (account: PlatformAccount) =>
    account.globalRole === "super_admin" && account.enabled && activeSuperAdminCount <= 1;

  const changeMemberRole = async (
    member: PlatformWorkspaceMember,
    role: PlatformWorkspaceMember["role"],
  ) => {
    if (!workspaceId || (isLastActiveAdmin(member) && role !== "admin")) return;
    try {
      await updateWorkspaceMemberRole(token, workspaceId, member.id, role);
      message.success("成员角色已更新，旧会话已撤销");
      await load();
    } catch (error) {
      message.error(operationError(error, "成员角色更新失败"));
    }
  };

  const removeMember = async (member: PlatformWorkspaceMember) => {
    if (!workspaceId || isLastActiveAdmin(member)) return;
    try {
      await removeWorkspaceMember(token, workspaceId, member.id);
      message.success("成员已移除，旧会话已撤销");
      await load();
    } catch (error) {
      message.error(operationError(error, "移除成员失败"));
    }
  };

  const createInvitation = async () => {
    if (!workspaceId) return;
    const values = await inviteForm.validateFields();
    setSubmitting(true);
    try {
      const response = await createWorkspaceInvitation(token, workspaceId, values);
      // Keep the raw capability only in component state. It is intentionally
      // never written to localStorage, sessionStorage, audit details, or logs.
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

  const revokeInvitation = async (invitation: PlatformWorkspaceInvitation) => {
    if (!workspaceId || invitation.status !== "active") return;
    try {
      await revokeWorkspaceInvitation(token, workspaceId, invitation.id);
      message.success("邀请已撤销");
      await load();
    } catch (error) {
      message.error(operationError(error, "撤销邀请失败"));
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
      // Never construct capabilities in the browser: refresh the full session
      // so the selected workspace is the server-issued projection.
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
        <Space direction="vertical" size={0}>
          <strong>{member.name}</strong>
          <span>{member.email}</span>
        </Space>
      ),
    },
    {
      title: "角色",
      dataIndex: "role",
      width: 160,
      render: (_value, member) => (
        <Select
          aria-label={`设置 ${member.name} 的工作区角色`}
          value={member.role}
          options={workspaceRoleOptions}
          disabled={isLastActiveAdmin(member)}
          onChange={(role: PlatformWorkspaceMember["role"]) => void changeMemberRole(member, role)}
        />
      ),
    },
    {
      title: "状态",
      dataIndex: "enabled",
      width: 104,
      render: (enabled: boolean) => <Tag color={enabled ? "success" : "default"}>{enabled ? "启用" : "停用"}</Tag>,
    },
    {
      title: "操作",
      key: "actions",
      width: 88,
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
    { title: "邮箱", dataIndex: "email" },
    {
      title: "角色",
      dataIndex: "role",
      width: 112,
      render: (role: PlatformWorkspaceInvitation["role"]) => role === "admin" ? "管理员" : "成员",
    },
    { title: "状态", key: "status", width: 112, render: (_value, invitation) => invitationStatus(invitation) },
    { title: "失效时间", dataIndex: "expiresAt", width: 210 },
    {
      title: "操作",
      key: "actions",
      width: 88,
      render: (_value, invitation) => (
        <Popconfirm
          title="撤销这份邀请？"
          okText="撤销"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          disabled={invitation.status !== "active"}
          onConfirm={() => revokeInvitation(invitation)}
        >
          <Button
            danger
            type="text"
            size="small"
            icon={<StopOutlined />}
            aria-label={`撤销邀请 ${invitation.email}`}
            disabled={invitation.status !== "active"}
          />
        </Popconfirm>
      ),
    },
  ];

  const accountColumns: TableColumnsType<PlatformAccount> = [
    {
      title: "账户",
      key: "account",
      render: (_value, account) => (
        <Space direction="vertical" size={0}>
          <strong>{account.name}</strong>
          <span>{account.email}</span>
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
        />
      ),
    },
    {
      title: "状态",
      key: "enabled",
      width: 180,
      render: (_value, account) => (
        <Space size={4}>
          <Tag color={account.enabled ? "success" : "default"}>{account.enabled ? "启用" : "停用"}</Tag>
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
      width: 64,
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
      items={[
        {
          key: "members",
          label: "成员",
          children: (
            <section className="surface administration-table">
              <div className="panel-heading">
                <div>
                  <h2>工作区成员</h2>
                  <span>角色变更和移除会立即撤销受影响账户的会话。</span>
                </div>
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    disabled={!canManageInvitations}
                    onClick={() => setInviteOpen(true)}
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
          label: "邀请",
          children: (
            <section className="surface administration-table">
              <div className="panel-heading">
                <div>
                  <h2>邀请记录</h2>
                  <span>链接仅在创建后显示一次，默认 24 小时失效。</span>
                </div>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={!canManageInvitations}
                  onClick={() => setInviteOpen(true)}
                >
                  创建邀请
                </Button>
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
          actions={(
            <Space>
              <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
              {isSuperAdmin && (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setWorkspaceCreateOpen(true)}>
                  创建工作区
                </Button>
              )}
            </Space>
          )}
        />
        {loading && !members.length && !accounts.length ? <div className="administration-loading"><Spin /></div> : workspaceManagement}
        {isSuperAdmin && (
          <section className="surface administration-table administration-accounts">
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
        title="邀请成员"
        open={inviteOpen}
        confirmLoading={submitting}
        okText="创建邀请"
        cancelText="取消"
        onOk={() => void createInvitation()}
        onCancel={() => setInviteOpen(false)}
      >
        <Form form={inviteForm} layout="vertical" initialValues={{ role: "member" }}>
          <Form.Item
            label="邮箱"
            name="email"
            rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}
          >
            <Input autoFocus autoComplete="email" />
          </Form.Item>
          <Form.Item label="工作区角色" name="role" rules={[{ required: true }]}>
            <Select options={workspaceRoleOptions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="创建工作区"
        open={workspaceCreateOpen}
        confirmLoading={workspaceSubmitting}
        okText="创建工作区"
        cancelText="取消"
        onOk={() => void createWorkspace()}
        onCancel={() => setWorkspaceCreateOpen(false)}
      >
        <Form form={workspaceForm} layout="vertical">
          <Form.Item
            label="工作区名称"
            name="name"
            rules={[{ required: true, whitespace: true, message: "请输入工作区名称" }]}
          >
            <Input autoFocus maxLength={120} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="复制邀请链接"
        open={Boolean(inviteLink)}
        footer={<Button onClick={() => setInviteLink(undefined)}>已复制或安全保存</Button>}
        onCancel={() => setInviteLink(undefined)}
      >
        <Alert
          type="warning"
          showIcon
          message="该链接仅在此时显示一次"
          description="请通过获批准的安全渠道发送。关闭此窗口后系统无法再次显示原始 token。"
        />
        <Input.TextArea aria-label="一次性邀请链接" value={inviteLink} readOnly autoSize={{ minRows: 3 }} />
        <Button
          icon={<CopyOutlined />}
          onClick={() => {
            if (!inviteLink) return;
            void navigator.clipboard.writeText(inviteLink).then(
              () => message.success("邀请链接已复制"),
              () => message.error("复制失败，请手动复制链接"),
            );
          }}
        >
          复制链接
        </Button>
      </Modal>

      <Modal
        title="复制密码重置链接"
        open={Boolean(resetLink)}
        footer={<Button onClick={() => setResetLink(undefined)}>已复制或安全保存</Button>}
        onCancel={() => setResetLink(undefined)}
      >
        <Alert
          type="warning"
          showIcon
          message="该链接仅在此时显示一次"
          description="请通过获批准的安全渠道发送；首次使用后 token 会失效。"
        />
        <Input.TextArea aria-label="一次性密码重置链接" value={resetLink} readOnly autoSize={{ minRows: 3 }} />
        <Button
          icon={<CopyOutlined />}
          onClick={() => {
            if (!resetLink) return;
            void navigator.clipboard.writeText(resetLink).then(
              () => message.success("密码重置链接已复制"),
              () => message.error("复制失败，请手动复制链接"),
            );
          }}
        >
          复制链接
        </Button>
      </Modal>
    </div>
  );
}
