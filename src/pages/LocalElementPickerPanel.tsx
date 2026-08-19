import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import {
  confirmLocalPickerCandidate,
  createLocalPickerSession,
  enableLocalPicker,
  getLocalPickerCaptures,
  getLocalPickerSessions,
  getWorkerHealth,
  localPickerScreenshotUrl,
  previewLocalPickerCandidate,
  stopLocalPickerSession,
} from "../worker-api";
import type { LocalPickerCapture, LocalPickerSession as WorkerLocalPickerSession } from "../worker-api";
import { useWorkspaceStore } from "../workspace-store";
import { emptyEnvironments } from "./shared";
import { CheckCircleFilled, FileSearchOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Select, Space, Spin, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

export type LocalPickerSelection = {
  captureId: string;
  candidateIndex: number;
  candidate: { method: string; value: string; count: number; score: number; label: string };
  path: string;
  environmentId: string;
  suggestedName: string;
};

export function LocalElementPickerPanel({
  project,
  preferredEnvironmentId,
  onSelectCandidate,
  createOpen,
  onCreateOpenChange,
}: {
  project: Project;
  preferredEnvironmentId?: string;
  onSelectCandidate?: (selection: LocalPickerSelection) => void;
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
}) {
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? emptyEnvironments);
  const [workerState, setWorkerState] = useState<"checking" | "online" | "offline">("checking");
  const [sessions, setSessions] = useState<WorkerLocalPickerSession[]>([]);
  const [captures, setCaptures] = useState<LocalPickerCapture[]>([]);
  const [managedSessionId, setManagedSessionId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [internalCreateOpen, setInternalCreateOpen] = useState(false);
  const [screenshotStamp, setScreenshotStamp] = useState(0);
  const [screenshotFailed, setScreenshotFailed] = useState(false);
  const [startForm] = Form.useForm();

  const effectiveEnvironmentId = preferredEnvironmentId;
  const effectiveEnvironment = environments.find((item) => item.id === effectiveEnvironmentId);
  const sessionForEnvironment = sessions.find((item) => item.environmentId === effectiveEnvironmentId);
  const selectedSession = sessions.find((item) => item.id === managedSessionId) ?? sessionForEnvironment ?? sessions[0];
  const latestCapture = captures[0];
  const modalOpen = createOpen ?? internalCreateOpen;
  const openCreate = () => { if (onCreateOpenChange) onCreateOpenChange(true); else setInternalCreateOpen(true); };
  const closeCreate = () => { if (onCreateOpenChange) onCreateOpenChange(false); else setInternalCreateOpen(false); };

  const refreshHealth = useCallback(async () => {
    try {
      const health = await getWorkerHealth();
      setWorkerState(health.ok ? "online" : "offline");
    } catch {
      setWorkerState("offline");
    }
  }, []);
  useEffect(() => { void refreshHealth(); }, [refreshHealth]);

  const loadSessions = useCallback(async () => {
    if (workerState !== "online") return;
    try {
      const response = await getLocalPickerSessions(project.id);
      setSessions(response.sessions);
      setManagedSessionId((current) => current ?? response.sessions[0]?.id);
    } catch {
      // keep current state
    }
  }, [project.id, workerState]);
  useEffect(() => {
    void loadSessions();
    const interval = setInterval(() => void loadSessions(), 4_000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const loadCaptures = useCallback(async () => {
    if (workerState !== "online" || !selectedSession) {
      setCaptures([]);
      return;
    }
    try {
      const response = await getLocalPickerCaptures(project.id, selectedSession.id);
      setCaptures(response.captures);
      setScreenshotStamp((value) => value + 1);
      setScreenshotFailed(false);
    } catch {
      setCaptures([]);
    }
  }, [project.id, selectedSession, workerState]);
  useEffect(() => {
    void loadCaptures();
    const interval = setInterval(() => void loadCaptures(), 1_000);
    return () => clearInterval(interval);
  }, [loadCaptures]);

  const openBrowser = async () => {
    if (workerState !== "online" || !effectiveEnvironment || creating) return;
    setCreating(true);
    try {
      const result = await createLocalPickerSession(project.id, effectiveEnvironment);
      setManagedSessionId(result.session.id);
      await loadSessions();
      message.success("本地调试浏览器正在准备");
    } catch {
      message.error("无法启动本地调试浏览器，请确认本机执行服务可用");
    } finally {
      setCreating(false);
    }
  };

  const enablePicker = async () => {
    if (workerState !== "online" || !selectedSession) return;
    try {
      await enableLocalPicker(project.id, selectedSession.id);
      message.info("请在本地调试浏览器中点击一个元素");
    } catch {
      message.error("无法启用元素选取");
    }
  };

  const previewCandidate = async (capture: LocalPickerCapture, candidateIndex: number) => {
    if (workerState !== "online" || !selectedSession) return;
    try {
      await previewLocalPickerCandidate(project.id, selectedSession.id, capture.id, candidateIndex);
    } catch {
      message.error("无法在浏览器中预览该候选定位器");
    }
  };

  const confirmCandidate = async (capture: LocalPickerCapture, candidateIndex: number) => {
    if (workerState !== "online" || !selectedSession) return;
    const candidate = capture.candidates[candidateIndex];
    try {
      const confirmed = await confirmLocalPickerCandidate(project.id, selectedSession.id, capture.id, {
        candidateIndex,
        name: candidate.value,
      });
      onSelectCandidate?.({
        captureId: capture.id,
        candidateIndex,
        candidate: confirmed.candidate,
        path: confirmed.path,
        environmentId: confirmed.environmentId,
        suggestedName: confirmed.suggestedName,
      });
      message.success("候选已回填到表单");
    } catch {
      message.error("无法确认该元素候选");
    }
  };

  const stopSession = async () => {
    if (workerState !== "online" || !selectedSession) return;
    try {
      await stopLocalPickerSession(project.id, selectedSession.id);
      setManagedSessionId(undefined);
      await loadSessions();
    } catch {
      message.error("无法结束本地调试会话");
    }
  };

  if (workerState === "offline") {
    return (
      <Alert
        type="warning"
        showIcon
        message="本机执行服务未运行，无法从页面获取元素。"
        description="请先在项目目录运行 npm run server 启动本机执行服务后重试。"
        action={<Button size="small" onClick={() => void refreshHealth()}>重试</Button>}
      />
    );
  }
  if (workerState === "checking") {
    return <div className="element-picker-panel"><Spin /></div>;
  }
  if (!effectiveEnvironment) {
    return <Alert type="info" showIcon message="请先在元素表单中选择默认验证环境后再从页面获取。" />;
  }

  return (
    <div className="element-picker-panel">
      <div className="panel-heading">
        <div>
          <h2>元素选取（本地通道）</h2>
          <span>本机有头浏览器 · 点击元素生成候选定位器</span>
        </div>
        <Space>
          <Select
            className="picker-session-select"
            value={selectedSession?.id}
            onChange={setManagedSessionId}
            placeholder="选择会话"
            options={sessions.map((session) => ({ value: session.id, label: `${session.environmentName} #${session.id.slice(0, 6)}` }))}
          />
          <Tooltip title="新建本地调试会话"><Button icon={<PlusOutlined />} onClick={openCreate}>新建会话</Button></Tooltip>
          <Tooltip title={selectedSession ? "在调试浏览器中启用一次选取" : "等待浏览器初始化"}>
            <Button icon={<FileSearchOutlined />} aria-label="启用元素选取" disabled={!selectedSession} onClick={() => void enablePicker()} />
          </Tooltip>
          {selectedSession && <Button danger onClick={() => void stopSession()}>结束</Button>}
        </Space>
      </div>
      <div className="debug-observation-panel">
        <div className="panel-heading"><div><h2>页面快照</h2><span>本机浏览器定时截图</span></div></div>
        {selectedSession ? (
          screenshotFailed ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待截图" />
          ) : (
            <img
              className="debug-screenshot"
              src={`${localPickerScreenshotUrl(project.id, selectedSession.id)}?t=${screenshotStamp}`}
              alt="本地调试截图"
              onError={() => setScreenshotFailed(true)}
              onLoad={() => setScreenshotFailed(false)}
            />
          )
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未创建本地调试会话" />
        )}
      </div>
      {!selectedSession ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未打开本地调试浏览器">
          <Space direction="vertical">
            <Button type="primary" loading={creating} onClick={() => void openBrowser()}>打开调试浏览器</Button>
            <Button onClick={openCreate}>自定义环境 / 起始 URL</Button>
          </Space>
        </Empty>
      ) : !latestCapture ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待浏览器点击" />
      ) : (
        <div className="picker-candidate-list">
          {latestCapture.candidates.map((candidate, index) => (
            <div className="picker-candidate-row" key={`${candidate.method}-${candidate.value}`}>
              <span className="picker-score">{candidate.score}</span>
              <div>
                <strong>{candidate.method}</strong>
                <code>{candidate.value}</code>
                <small>{candidate.count === 1 ? "唯一匹配" : `${candidate.count} 个匹配`}</small>
              </div>
              <Space size={2}>
                <Tooltip title="在浏览器中高亮"><Button size="small" icon={<FileSearchOutlined />} aria-label={`高亮候选 ${candidate.method} ${candidate.value}`} onClick={() => void previewCandidate(latestCapture, index)} /></Tooltip>
                <Tooltip title="选中并回填到表单（不写入元素库）">
                  <Button size="small" type="primary" icon={<CheckCircleFilled />} aria-label={`选中候选 ${candidate.method} ${candidate.value}`} onClick={() => void confirmCandidate(latestCapture, index)} />
                </Tooltip>
              </Space>
            </div>
          ))}
        </div>
      )}
      <Modal
        title="新建本地调试会话"
        open={modalOpen}
        confirmLoading={creating}
        onCancel={closeCreate}
        okText="创建会话"
        onOk={() => startForm.validateFields().then(async (values) => {
          const environment = environments.find((item) => item.id === values.environmentId);
          if (!environment) return;
          setCreating(true);
          try {
            const result = await createLocalPickerSession(project.id, environment, values.startUrl);
            setManagedSessionId(result.session.id);
            closeCreate();
            await loadSessions();
            message.success("本地调试浏览器正在准备");
          } catch {
            message.error("无法创建本地调试会话，请确认本机执行服务可用");
          } finally {
            setCreating(false);
          }
        })}
      >
        <Form form={startForm} layout="vertical">
          <Form.Item name="environmentId" label="运行环境" rules={[{ required: true, message: "请选择运行环境" }]}>
            <Select onChange={(environmentId) => { const environment = environments.find((item) => item.id === environmentId); startForm.setFieldsValue({ startUrl: environment?.baseUrl ?? "" }); }} options={environments.map((item) => ({ value: item.id, label: `${item.name} · ${item.baseUrl}` }))} />
          </Form.Item>
          <Form.Item name="startUrl" label="起始 URL" tooltip="留空时使用环境基础地址">
            <Input placeholder="默认使用环境基础地址" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
