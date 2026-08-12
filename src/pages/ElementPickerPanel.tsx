import { message } from "../antd-feedback";
import type { Project } from "../mock-data";
import {
  confirmPickerCandidate,
  createDebugSession,
  enableElementPicker,
  fetchDebugArtifact,
  getDebugSessions,
  getPickerCaptures,
  getPlatformRevisions,
  previewPickerCandidate,
} from "../platform-api";
import type {
  PlatformDebugSession,
  PlatformElement,
  PlatformPickerCapture,
  PlatformRevision,
  PlatformSession,
} from "../platform-api";
import { readPlatformProjectMap, readStoredPlatformSession } from "../platform-context";
import { useWorkspaceStore } from "../workspace-store";
import { CheckCircleFilled, FileSearchOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Radio, Select, Space, Spin, Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";

export type ElementPickerSelection = {
  captureId: string;
  candidateIndex: number;
  candidate: { method: string; value: string; count: number; score: number; label: string };
  path: string;
  environmentId: string;
  suggestedName: string;
};

export function ElementPickerPanel({
  project,
  sessionId,
  onSessionIdChange,
  preferredEnvironmentId,
  confirmMode = "element",
  onSelectCandidate,
  onConfirmElement,
  createOpen,
  onCreateOpenChange,
}: {
  project: Project;
  /** 绑定到外部选择的调试会话；缺省时面板自行管理会话（为 preferredEnvironmentId 复用/创建空白会话）。 */
  sessionId?: string;
  onSessionIdChange?: (sessionId: string) => void;
  /** 采集目标环境；缺省时面板使用环境选择器中的当前选择。 */
  preferredEnvironmentId?: string;
  confirmMode?: "element" | "fillback";
  onSelectCandidate?: (selection: ElementPickerSelection) => void;
  onConfirmElement?: (element: PlatformElement, documentVersion: number) => void;
  /** 外部控制新建会话弹窗（调试会话页复用）。 */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
}) {
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? []);
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const platformProjectId = platformProjectMap[project.id];
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [sessions, setSessions] = useState<PlatformDebugSession[]>([]);
  const [captures, setCaptures] = useState<PlatformPickerCapture[]>([]);
  const [managedSessionId, setManagedSessionId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [internalCreateOpen, setInternalCreateOpen] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState<string>();
  const [startForm] = Form.useForm();
  const [startMode, setStartMode] = useState<"revision" | "blank">("revision");

  const effectiveSessionId = sessionId ?? managedSessionId;
  const effectiveEnvironmentId = preferredEnvironmentId;
  const sessionsForEnvironment = useMemo(
    () => sessions.filter((session) => session.environmentId === effectiveEnvironmentId),
    [effectiveEnvironmentId, sessions],
  );
  const selectedSession = sessions.find((item) => item.id === effectiveSessionId)
    ?? sessionsForEnvironment.find((item) => ["requested", "active", "paused", "ending"].includes(item.status))
    ?? sessions[0];
  const publishedRevisions = revisions.filter((revision) => revision.status === "published");
  const selectedRevisionId = Form.useWatch("revisionId", startForm);
  const selectedRevision = publishedRevisions.find((revision) => revision.id === selectedRevisionId);
  const selectedRevisionEnvironment = environments.find((environment) => environment.id === selectedRevision?.environmentId);
  const latestScreenshot = selectedSession?.artifacts.find((artifact) => artifact.contentType.startsWith("image/"));
  const latestScreenshotId = latestScreenshot?.id;
  const latestCapture = captures[0];
  const modalOpen = createOpen ?? internalCreateOpen;
  const openCreate = () => { if (onCreateOpenChange) onCreateOpenChange(true); else setInternalCreateOpen(true); };
  const closeCreate = () => { if (onCreateOpenChange) onCreateOpenChange(false); else setInternalCreateOpen(false); };

  const loadSessions = useCallback(async () => {
    if (!platformSession || !platformProjectId) return;
    try {
      const [revisionResponse, sessionResponse] = await Promise.all([
        getPlatformRevisions(platformSession.token, platformProjectId),
        getDebugSessions(platformSession.token, platformProjectId),
      ]);
      setRevisions(revisionResponse.revisions);
      setSessions(sessionResponse.sessions);
      if (!sessionId) {
        setManagedSessionId((current) => current ?? sessionResponse.sessions[0]?.id);
      }
    } catch {
      message.error("无法读取调试会话，请检查平台连接");
    }
  }, [platformProjectId, platformSession, sessionId]);

  useEffect(() => {
    void loadSessions();
    const interval = setInterval(() => void loadSessions(), 4_000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const loadPickerCaptures = useCallback(async () => {
    if (!platformSession || !platformProjectId || !selectedSession) {
      setCaptures([]);
      return;
    }
    try {
      const response = await getPickerCaptures(platformSession.token, platformProjectId, selectedSession.id);
      setCaptures(response.captures);
    } catch {
      setCaptures([]);
    }
  }, [platformProjectId, platformSession, selectedSession]);

  useEffect(() => {
    void loadPickerCaptures();
    const interval = setInterval(() => void loadPickerCaptures(), 3_000);
    return () => clearInterval(interval);
  }, [loadPickerCaptures]);

  useEffect(() => {
    if (!platformSession || !latestScreenshotId) {
      setScreenshotUrl(undefined);
      return;
    }
    let currentUrl: string | undefined;
    let cancelled = false;
    void fetchDebugArtifact(platformSession.token, latestScreenshotId)
      .then((blob) => {
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setScreenshotUrl(currentUrl);
      })
      .catch(() => setScreenshotUrl(undefined));
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [latestScreenshotId, platformSession]);

  // 打开新建会话弹窗时初始化表单（默认使用已发布版本模式或空白模式）。
  useEffect(() => {
    if (!modalOpen) return;
    setStartMode(publishedRevisions.length > 0 ? "revision" : "blank");
    startForm.resetFields();
    if (publishedRevisions.length > 0) {
      const revision = publishedRevisions[0];
      startForm.setFieldsValue({ revisionId: revision?.id, environmentId: revision?.environmentId });
    }
  }, [modalOpen, publishedRevisions, startForm]);

  // 自动管理模式：为指定环境复用/创建空白调试会话（元素抽屉「从页面获取」）。
  useEffect(() => {
    if (sessionId || !platformSession || !platformProjectId || !effectiveEnvironmentId) return;
    if (sessionsForEnvironment.some((session) => ["requested", "active", "paused", "ending"].includes(session.status))) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await createDebugSession(platformSession.token, platformProjectId, {
            blank: true,
            environmentId: effectiveEnvironmentId,
          });
          if (cancelled) return;
          setManagedSessionId((current) => current ?? result.session.id);
          onSessionIdChange?.(result.session.id);
          message.success("调试浏览器正在准备");
        } catch {
          if (!cancelled) message.error("无法创建调试会话，请确认该环境已绑定在线执行节点");
        }
      })();
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [effectiveEnvironmentId, onSessionIdChange, platformProjectId, platformSession, sessionId, sessionsForEnvironment]);

  const readySession = selectedSession && ["active", "paused"].includes(selectedSession.status);

  const enablePicker = async () => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    try {
      await enableElementPicker(platformSession.token, platformProjectId, selectedSession.id);
      message.info("请在调试浏览器中点击一个元素");
    } catch {
      message.error("无法启用元素选取");
    }
  };

  const previewCandidate = async (capture: PlatformPickerCapture, candidateIndex: number) => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    try {
      await previewPickerCandidate(platformSession.token, platformProjectId, selectedSession.id, capture.id, candidateIndex);
    } catch {
      message.error("无法在浏览器中预览该候选定位器");
    }
  };

  const confirmCandidate = async (capture: PlatformPickerCapture, candidateIndex: number) => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    const candidate = capture.candidates[candidateIndex];
    try {
      const confirmed = await confirmPickerCandidate(platformSession.token, platformProjectId, selectedSession.id, capture.id, {
        candidateIndex,
        target: confirmMode === "fillback" ? "fillback" : "element",
        name: candidate.value,
      });
      if (confirmed.target === "fillback") {
        onSelectCandidate?.({
          captureId: capture.id,
          candidateIndex,
          candidate: confirmed.candidate,
          path: confirmed.path,
          environmentId: confirmed.environmentId,
          suggestedName: confirmed.suggestedName,
        });
        message.success("候选已回填到表单");
        return;
      }
      onConfirmElement?.(confirmed.element, confirmed.documentVersion);
      message.success("元素已写入草稿元素库");
    } catch {
      message.error("无法确认该元素候选");
    }
  };

  if (!platformSession) {
    return <Alert type="info" showIcon title="未连接平台账户，无法从页面获取元素。" action={<Button size="small" onClick={() => window.dispatchEvent(new Event("autoflow-open-platform-login"))}>前往登录</Button>} />;
  }
  if (!platformProjectId) {
    return <Alert type="info" showIcon title="当前项目尚未导入平台，无法从页面获取元素。" />;
  }

  return (
    <div className="element-picker-panel">
      <div className="panel-heading">
        <div>
          <h2>元素选取</h2>
          <span>在调试浏览器中点击元素后生成候选</span>
        </div>
        <Space>
          {!sessionId && (
            <Select
              className="picker-session-select"
              value={selectedSession?.id}
              onChange={(value) => setManagedSessionId(value)}
              placeholder="选择调试会话"
              options={sessions.map((session) => ({ value: session.id, label: `会话 ${session.id.slice(0, 8)}` }))}
              style={{ width: 180 }}
            />
          )}
          {!sessionId && (
            <Tooltip title="新建调试会话">
              <Button size="small" icon={<PlusOutlined />} onClick={openCreate}>新建会话</Button>
            </Tooltip>
          )}
          <Tooltip title={readySession ? "在调试浏览器中启用一次选取" : "等待 Agent 初始化浏览器"}>
            <Button icon={<FileSearchOutlined />} disabled={!readySession} onClick={() => void enablePicker()} />
          </Tooltip>
        </Space>
      </div>
      <div className="debug-observation-panel">
        <div className="panel-heading"><div><h2>页面快照</h2><span>由 Agent 定时上传</span></div></div>
        {selectedSession ? (
          latestScreenshot ? (
            screenshotUrl ? <img className="debug-screenshot" src={screenshotUrl} alt={`调试截图 ${latestScreenshot.name}`} /> : <Spin size="small" />
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待安全截图" />
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无调试会话" />}
      </div>
      {!selectedSession ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={effectiveEnvironmentId ? "尚未创建调试会话" : "请先选择环境后再从页面获取"}>
          {!sessionId && <Button type="primary" disabled={!effectiveEnvironmentId} onClick={openCreate}>创建调试会话</Button>}
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
                <Tooltip title="在调试浏览器中高亮"><Button size="small" icon={<FileSearchOutlined />} onClick={() => void previewCandidate(latestCapture, index)} /></Tooltip>
                <Tooltip title={confirmMode === "fillback" ? "选中并回填到表单（不写入元素库）" : "确认写入草稿元素库"}>
                  <Button size="small" type="primary" icon={<CheckCircleFilled />} disabled={confirmMode === "element" && latestCapture.status !== "pending"} onClick={() => void confirmCandidate(latestCapture, index)} />
                </Tooltip>
              </Space>
            </div>
          ))}
        </div>
      )}
      <Modal
        title="新建调试会话"
        open={modalOpen}
        confirmLoading={creating}
        onCancel={closeCreate}
        okText="创建会话"
        onOk={() => startForm.validateFields().then(async (values) => {
          if (!platformSession || !platformProjectId) return;
          setCreating(true);
          try {
            const result = await createDebugSession(platformSession.token, platformProjectId, startMode === "blank"
              ? { blank: true, environmentId: values.environmentId, startUrl: values.startUrl }
              : { revisionId: values.revisionId, environmentId: values.environmentId });
            setManagedSessionId(result.session.id);
            onSessionIdChange?.(result.session.id);
            closeCreate();
            await loadSessions();
            message.success("调试浏览器正在准备");
          } catch {
            message.error("无法创建调试会话，请确认有在线绑定节点");
          } finally {
            setCreating(false);
          }
        })}
      >
        <Form form={startForm} layout="vertical">
          <Form.Item label="会话类型">
            <Radio.Group value={startMode} onChange={(event) => setStartMode(event.target.value)} optionType="button" buttonStyle="solid">
              <Radio.Button value="revision">从已发布版本</Radio.Button>
              <Radio.Button value="blank">空白会话（仅环境 + 起始 URL）</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {startMode === "revision" ? (
            <>
              <Form.Item name="revisionId" label="已发布流程版本" rules={[{ required: true, message: "请选择已发布版本" }]}>
                <Select onChange={(revisionId) => startForm.setFieldsValue({ environmentId: publishedRevisions.find((revision) => revision.id === revisionId)?.environmentId })} options={publishedRevisions.map((revision) => ({ value: revision.id, label: `版本 ${revision.revisionNumber} · ${new Date(revision.publishedAt ?? revision.createdAt).toLocaleString()}` }))} />
              </Form.Item>
              <Form.Item name="environmentId" label="运行环境" rules={[{ required: true, message: "请选择运行环境" }]}>
                <Select disabled options={selectedRevisionEnvironment ? [{ value: selectedRevisionEnvironment.id, label: selectedRevisionEnvironment.name }] : []} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="environmentId" label="运行环境" rules={[{ required: true, message: "请选择运行环境" }]}>
                <Select onChange={(environmentId) => { const environment = environments.find((item) => item.id === environmentId); startForm.setFieldsValue({ startUrl: environment?.baseUrl ?? "" }); }} options={environments.map((item) => ({ value: item.id, label: `${item.name} · ${item.baseUrl}` }))} />
              </Form.Item>
              <Form.Item name="startUrl" label="起始 URL" tooltip="留空时使用环境基础地址">
                <Input placeholder="默认使用环境基础地址" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}