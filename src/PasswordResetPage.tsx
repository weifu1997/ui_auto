import { LockOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Typography } from "antd";
import { useMemo, useState } from "react";
import { acceptPlatformPasswordReset, PlatformApiError } from "./platform-api";
import { useLocation, useNavigate } from "./router";

type ResetValues = { password: string; confirmation: string };

export function PasswordResetPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = useMemo(
    () => new URLSearchParams(location.search).get("token")?.trim() ?? "",
    [location.search],
  );
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (values: ResetValues) => {
    if (!token) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await acceptPlatformPasswordReset({ token, password: values.password });
      navigate("/", { replace: true });
    } catch (reason) {
      const code = reason instanceof PlatformApiError ? reason.code : "PASSWORD_RESET_FAILED";
      setError(`无法重置密码（${code}）`);
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return <main className="login-page"><section className="login-panel"><Alert type="error" showIcon message="密码重置链接无效" /></section></main>;
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="password-reset-title">
        <div className="login-brand" aria-label="AutoFlow Workbench">
          <span className="login-brand-mark"><ThunderboltOutlined /></span>
          <span>AutoFlow</span>
        </div>
        <div className="login-copy">
          <Typography.Title id="password-reset-title" level={1}>设置新密码</Typography.Title>
          <Typography.Text type="secondary">密码修改后，所有旧会话都会失效。</Typography.Text>
        </div>
        {error && <Alert type="error" showIcon message={error} />}
        <Form<ResetValues> layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)}>
          <Form.Item label="新密码" name="password" rules={[{ required: true, min: 8, message: "密码至少需要 8 个字符" }]}>
            <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" autoFocus />
          </Form.Item>
          <Form.Item
            label="确认新密码"
            name="confirmation"
            dependencies={["password"]}
            rules={[
              { required: true, message: "请再次输入密码" },
              ({ getFieldValue }) => ({ validator: (_rule, value) => value === getFieldValue("password") ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一致")) }),
            ]}
          >
            <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={submitting}>重置密码</Button>
        </Form>
      </section>
    </main>
  );
}
