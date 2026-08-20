import { LockOutlined, MailOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Typography } from "antd";
import { useMemo, useState } from "react";
import { acceptWorkspaceInvitation, PlatformApiError, restorePlatformSession } from "./platform-api";
import { storePlatformSession, readStoredPlatformSession } from "./platform-context";
import { useLocation, useNavigate } from "./router";

type InvitationValues = { email: string; name?: string; password: string };

function invitationError(error: unknown) {
  if (!(error instanceof PlatformApiError)) return "无法接受邀请，请检查网络后重试";
  switch (error.code) {
    case "INVITE_ALREADY_USED":
      return "该邀请链接已被使用。";
    case "INVITE_EXPIRED":
      return "该邀请链接已过期，请联系工作区管理员创建新邀请。";
    case "INVITE_REVOKED":
      return "该邀请链接已被撤销，请联系工作区管理员。";
    case "INVITE_LOGIN_REQUIRED":
      return "此邀请对应已有账户，请先使用该账户登录后再次打开链接。";
    case "INVITE_EMAIL_MISMATCH":
      return "邀请邮箱与当前操作的账户不一致。";
    default:
      return `无法接受邀请（${error.code}）`;
  }
}

export function InvitationAcceptPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = useMemo(
    () => new URLSearchParams(location.search).get("token")?.trim() ?? "",
    [location.search],
  );
  const existingSession = readStoredPlatformSession();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const complete = async (input: InvitationValues) => {
    if (!token) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await acceptWorkspaceInvitation({ token, ...input });
      const session = await restorePlatformSession();
      storePlatformSession(session);
      navigate("/projects", { replace: true });
    } catch (reason) {
      setError(invitationError(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <main className="login-page">
        <section className="login-panel"><Alert type="error" showIcon message="邀请链接无效" /></section>
      </main>
    );
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="invite-title">
        <div className="login-brand" aria-label="AutoFlow Workbench">
          <span className="login-brand-mark"><ThunderboltOutlined /></span>
          <span>AutoFlow</span>
        </div>
        <div className="login-copy">
          <Typography.Title id="invite-title" level={1}>接受工作区邀请</Typography.Title>
          <Typography.Text type="secondary">验证完成前不会显示工作区信息。</Typography.Text>
        </div>
        {error && <Alert type="error" showIcon message={error} />}
        {existingSession ? (
          <>
            <Alert type="info" showIcon message={`将以 ${existingSession.user.email} 接受邀请`} />
            <Button
              type="primary"
              size="large"
              block
              loading={submitting}
              onClick={() => void complete({ email: existingSession.user.email, password: "" })}
            >
              接受邀请
            </Button>
          </>
        ) : (
          <Form<InvitationValues> layout="vertical" requiredMark={false} onFinish={(values) => void complete(values)}>
            <Form.Item label="邀请邮箱" name="email" rules={[{ required: true, type: "email", message: "请输入与邀请一致的邮箱" }]}>
              <Input size="large" prefix={<MailOutlined />} autoComplete="email" autoFocus />
            </Form.Item>
            <Form.Item label="姓名" name="name">
              <Input size="large" autoComplete="name" />
            </Form.Item>
            <Form.Item label="设置密码" name="password" rules={[{ required: true, min: 8, message: "密码至少需要 8 个字符" }]}>
              <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting}>创建账户并接受邀请</Button>
          </Form>
        )}
      </section>
    </main>
  );
}
