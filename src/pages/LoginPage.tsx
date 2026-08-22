import {
  CheckCircleFilled,
  LockOutlined,
  MailOutlined,
  NodeIndexOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Alert, Button, Form, Input, Typography } from "antd";
import { useState } from "react";
import { loginPlatform, PlatformApiError } from "../api/platform-api";
import type { PlatformSession } from "../api/platform-api";

type LoginValues = { email: string; password: string };

export function AuthShowcase() {
  return (
    <aside className="login-context" aria-hidden="true">
      <div className="login-context-glow-1" />
      <div className="login-context-glow-2" />
      <div className="login-context-grid" />
      
      <div className="login-context-window">
        <div className="login-context-bar">
          <div className="login-traffic-dots">
            <span className="dot dot-red" />
            <span className="dot dot-yellow" />
            <span className="dot dot-green" />
          </div>
          <div className="login-window-title">
            <ThunderboltOutlined /> AutoFlow Pipeline Matrix
          </div>
          <span className="login-window-badge">v3.1 Pro</span>
        </div>

        <div className="login-context-body">
          <div className="login-stats-grid">
            <div className="login-stat-pill">
              <span className="stat-label">用例通过率</span>
              <strong className="stat-val text-success">99.8%</strong>
            </div>
            <div className="login-stat-pill">
              <span className="stat-label">平均调度延迟</span>
              <strong className="stat-val text-accent">180ms</strong>
            </div>
            <div className="login-stat-pill">
              <span className="stat-label">智能自愈率</span>
              <strong className="stat-val text-purple">96.4%</strong>
            </div>
          </div>

          <div className="login-pipeline">
            <div className="pipeline-node done">
              <div className="node-icon"><PlayCircleOutlined /></div>
              <div className="node-meta">
                <span className="node-title">Webhook / 定时调度触发</span>
                <span className="node-desc">Trigger: main branch push · Run #0842</span>
              </div>
              <span className="node-status status-success">Ready</span>
            </div>

            <div className="pipeline-line" />

            <div className="pipeline-node active">
              <div className="node-icon"><NodeIndexOutlined /></div>
              <div className="node-meta">
                <span className="node-title">多浏览器并发矩阵集群</span>
                <span className="node-desc">Chromium & WebKit · 8 并发隔离执行</span>
              </div>
              <span className="node-status status-running">Running</span>
            </div>

            <div className="pipeline-line" />

            <div className="pipeline-node done">
              <div className="node-icon"><SafetyCertificateOutlined /></div>
              <div className="node-meta">
                <span className="node-title">AI 定位器自愈与断言校验</span>
                <span className="node-desc">Smart Selector · 像素级视觉对比已校验</span>
              </div>
              <span className="node-status status-verified">Verified</span>
            </div>
          </div>

          <div className="login-context-run">
            <div className="run-dot-pulse" />
            <ThunderboltOutlined />
            <b>Run 0248</b>
            <span>Passed</span>
            <small>1.24s · 0 Flaky</small>
          </div>
        </div>
      </div>
    </aside>
  );
}

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
          <span className="login-brand-text">AutoFlow</span>
          <span className="login-brand-tag">Workbench</span>
        </div>
        
        <div className="login-copy">
          <Typography.Title id="login-title" level={1}>登录工作台</Typography.Title>
          <Typography.Text type="secondary">企业级自动化测试与持续验证平台</Typography.Text>
        </div>

        {error && <Alert className="login-error-alert" type="error" showIcon message={error} />}

        <Form<LoginValues> layout="vertical" requiredMark={false} onFinish={submit} className="login-form">
          <Form.Item
            label="邮箱"
            name="email"
            rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}
          >
            <Input
              size="large"
              prefix={<MailOutlined className="input-prefix-icon" />}
              placeholder="name@company.com"
              autoComplete="username"
              autoFocus
            />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password
              size="large"
              prefix={<LockOutlined className="input-prefix-icon" />}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={submitting}
            icon={<ThunderboltOutlined />}
            className="login-submit-btn"
          >
            登录
          </Button>
        </Form>

        <div className="login-footer">
          <span><CheckCircleFilled className="text-success" /> 端到端隔离加密</span>
          <span>·</span>
          <span>高可用测试矩阵</span>
        </div>
      </section>

      <AuthShowcase />
    </main>
  );
}
