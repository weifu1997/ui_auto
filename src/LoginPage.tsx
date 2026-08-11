import { LockOutlined, MailOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Typography } from "antd";
import { useState } from "react";
import { loginPlatform, PlatformApiError } from "./platform-api";
import type { PlatformSession } from "./platform-api";

type LoginValues = { email: string; password: string };

export function LoginPage({ onAuthenticated }: { onAuthenticated: (session: PlatformSession) => void }) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (values: LoginValues) => {
    setSubmitting(true);
    setError(undefined);
    try {
      onAuthenticated(await loginPlatform(values));
    } catch (error) {
      if (error instanceof PlatformApiError) {
        if (error.status === 401) setError("邮箱或密码不正确，或账号已被停用");
        else if (error.status === 0) setError("连接平台服务超时，请稍后重试");
        else setError(`登录失败（${error.code}）`);
      } else {
        setError("无法连接平台服务，请检查网络或服务状态");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand" aria-label="AutoFlow Workbench">
          <span className="login-brand-mark"><ThunderboltOutlined /></span>
          <span>AutoFlow</span>
        </div>
        <div className="login-copy">
          <Typography.Title id="login-title" level={1}>登录工作台</Typography.Title>
          <Typography.Text type="secondary">使用公司内网账号继续</Typography.Text>
        </div>
        {error && <Alert type="error" showIcon message={error} />}
        <Form<LoginValues> layout="vertical" requiredMark={false} onFinish={submit}>
          <Form.Item label="邮箱" name="email" rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}>
            <Input size="large" prefix={<MailOutlined />} autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password size="large" prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={submitting}>登录</Button>
        </Form>
      </section>
      <aside className="login-context" aria-hidden="true">
        <div className="login-context-grid" />
        <div className="login-context-window">
          <div className="login-context-bar"><span /><span /><span /></div>
          <div className="login-context-rows">
            <i /><i /><i /><i />
          </div>
          <div className="login-context-run"><ThunderboltOutlined /><b>Run 0248</b><span>Passed</span></div>
        </div>
      </aside>
    </main>
  );
}
