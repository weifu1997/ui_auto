import { message } from "../antd-feedback";
import type { ElementAsset, Project } from "../mock-data";
import { confirmPickerCandidate, createDebugSession, enableElementPicker, fetchDebugArtifact, getDebugSessions, getPickerCaptures, getPlatformProjectDocument, getPlatformRevisions, previewPickerCandidate, sendDebugCommand } from "../platform-api";
import type { PlatformDebugSession, PlatformPickerCapture, PlatformRevision, PlatformSession } from "../platform-api";
import { notifyPlatformContextChanged, readPlatformProjectMap, readStoredPlatformSession, storePlatformDocumentVersion } from "../platform-context";
import { Link } from "../router";
import { PageHeading } from "./shared";
import { useWorkspaceStore } from "../workspace-store";
import { CheckCircleFilled, FileSearchOutlined, PauseCircleOutlined, PlayCircleFilled, PlusOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Modal, Select, Space, Spin, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useState } from "react";

export function DebugSessionsPage({ project }: { project: Project }) {
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? []);
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [sessions, setSessions] = useState<PlatformDebugSession[]>([]);
  const [captures, setCaptures] = useState<PlatformPickerCapture[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState<string>();
  const [startForm] = Form.useForm();
  const platformProjectId = platformProjectMap[project.id];
  const selectedSession = sessions.find((item) => item.id === selectedSessionId) ?? sessions[0];
  const publishedRevisions = revisions.filter((revision) => revision.status === "published");
  const selectedRevisionId = Form.useWatch("revisionId", startForm);
  const selectedRevision = publishedRevisions.find((revision) => revision.id === selectedRevisionId);
  const selectedRevisionEnvironment = environments.find((environment) => environment.id === selectedRevision?.environmentId);
  const latestScreenshot = selectedSession?.artifacts.find((artifact) => artifact.contentType.startsWith("image/"));
  const latestScreenshotId = latestScreenshot?.id;
  const latestCapture = captures[0];

  const loadSessions = useCallback(async () => {
    if (!platformSession || !platformProjectId) return;
    setLoading(true);
    try {
      const [revisionResponse, sessionResponse] = await Promise.all([
        getPlatformRevisions(platformSession.token, platformProjectId),
        getDebugSessions(platformSession.token, platformProjectId),
      ]);
      setRevisions(revisionResponse.revisions);
      setSessions(sessionResponse.sessions);
      setSelectedSessionId((current) => current ?? sessionResponse.sessions[0]?.id);
    } catch {
      message.error("无法读取调试会话，请检查平台连接");
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, platformSession]);

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

  const command = async (value: "start" | "continue" | "runCurrent" | "skip" | "pause" | "retry" | "stop") => {
    if (!platformSession || !platformProjectId || !selectedSession) return;
    try {
      const response = await sendDebugCommand(platformSession.token, platformProjectId, selectedSession.id, value);
      setSessions((current) => current.map((item) => item.id === response.session.id ? response.session : item));
      await loadSessions();
    } catch {
      message.error("调试命令未送达 Agent");
    }
  };

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
        target: "element",
        name: candidate.value,
      });
      const workspace = useWorkspaceStore.getState();
      if (!workspace.elementsByProject[project.id]?.some((element) => element.id === confirmed.element.id)) {
        const element: ElementAsset = {
          ...confirmed.element,
          validation: confirmed.element.validation === "verified" ? "valid" : "unverified",
        };
        workspace.setElements(project.id, [
          ...(workspace.elementsByProject[project.id] ?? []),
          element,
        ]);
      }
      storePlatformDocumentVersion(platformProjectId, confirmed.documentVersion);
      try {
        const document = await getPlatformProjectDocument(platformSession.token, platformProjectId);
        storePlatformDocumentVersion(platformProjectId, document.version);
        useWorkspaceStore.getState().hydratePlatformProjects([{
          platformProjectId,
          sourceProjectId: project.id,
          name: project.name,
          description: project.description,
          document: document.data,
        }]);
        notifyPlatformContextChanged();
      } catch {
        // The confirmed element is already durable on Platform. A later refresh reconciles the full document.
      }
      await loadPickerCaptures();
      message.success("元素已写入草稿元素库");
    } catch {
      message.error("无法确认该元素候选");
    }
  };

  if (!platformSession) {
    return (
      <>
        <PageHeading title="调试" description="在有头 Chromium 会话中保留页面状态并定位失败步骤。" />
        <Alert type="info" showIcon title="请先连接平台账户" action={<Link to={`/project/${project.id}/agents`}>前往执行节点</Link>} />
      </>
    );
  }

  if (!platformProjectId) {
    return (
      <>
        <PageHeading title="调试" description="在有头 Chromium 会话中保留页面状态并定位失败步骤。" />
        <Alert type="info" showIcon title="当前项目尚未导入平台" action={<Link to={`/project/${project.id}/agents`}>导入并绑定节点</Link>} />
      </>
    );
  }

  const activeSession = selectedSession && !["ended", "failed", "expired"].includes(selectedSession.status);
  const readySession = selectedSession && ["active", "paused"].includes(selectedSession.status);
  const sessionColumns: TableColumnsType<PlatformDebugSession> = [
    {
      title: "会话",
      dataIndex: "createdAt",
      render: (value: string, session) => (
        <span>
          <strong>#{session.id.slice(0, 8)}</strong>
          <small className="table-secondary">{new Date(value).toLocaleString()}</small>
        </span>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (status: PlatformDebugSession["status"]) => (
        <Tag color={status === "active" ? "processing" : status === "paused" ? "gold" : ["failed", "expired"].includes(status) ? "error" : status === "ended" ? "default" : "blue"}>
          {status === "requested" ? "等待连接" : status === "active" ? "运行中" : status === "paused" ? "已暂停" : status === "ending" ? "结束中" : status === "ended" ? "已结束" : status === "failed" ? "失败" : "已超时"}
        </Tag>
      ),
    },
    { title: "节点", dataIndex: ["agent", "name"], width: 130, render: (value: string | undefined) => value ?? "分配中" },
    { title: "步骤", dataIndex: "currentStep", width: 70, render: (value: number) => value + 1 },
  ];

  return (
    <>
      <PageHeading
        title="调试"
        description="调试浏览器保持页面、Cookie 与当前步骤状态；空闲 15 分钟或最长 2 小时后自动回收。"
        actions={<Button type="primary" icon={<PlusOutlined />} disabled={!publishedRevisions.some((revision) => revision.environmentId)} onClick={() => { const revision = publishedRevisions[0]; startForm.setFieldsValue({ revisionId: revision?.id, environmentId: revision?.environmentId }); setStartOpen(true); }}>新建调试会话</Button>}
      />
      {publishedRevisions.length === 0 && <Alert className="debug-alert" type="warning" showIcon title="没有已发布版本，无法创建调试会话。" />}
      <section className="surface debug-session-table">
        <Table
          rowKey="id"
          columns={sessionColumns}
          dataSource={sessions}
          loading={loading}
          pagination={false}
          rowClassName={(session) => session.id === selectedSession?.id ? "debug-session-selected" : ""}
          onRow={(session) => ({ onClick: () => setSelectedSessionId(session.id) })}
          locale={{ emptyText: <Empty description="尚无调试会话" /> }}
        />
      </section>
      {selectedSession && (
        <section className="debug-workbench">
          <div className="surface debug-control-panel">
            <div className="debug-session-heading">
              <div>
                <span className="eyebrow">当前会话</span>
                <h2>#{selectedSession.id.slice(0, 8)}</h2>
              </div>
              <Tag color={activeSession ? "processing" : "default"}>{selectedSession.status}</Tag>
            </div>
            <dl className="debug-session-meta">
              <div><dt>当前 URL</dt><dd>{selectedSession.currentUrl ?? "浏览器准备中"}</dd></div>
              <div><dt>执行节点</dt><dd>{selectedSession.agent?.name ?? selectedSession.agentId}</dd></div>
              <div><dt>当前步骤</dt><dd>{selectedSession.currentStep + 1}</dd></div>
              <div><dt>空闲回收</dt><dd>{new Date(selectedSession.idleExpiresAt).toLocaleTimeString()}</dd></div>
            </dl>
            <div className="debug-command-bar">
              <Tooltip title={readySession ? "从第一个步骤连续执行" : "等待 Agent 初始化浏览器"}><Button type="primary" icon={<PlayCircleFilled />} disabled={!readySession} onClick={() => void command("start")}>从头运行</Button></Tooltip>
              <Tooltip title={readySession ? "从当前步骤继续执行" : "等待 Agent 初始化浏览器"}><Button icon={<PlayCircleFilled />} disabled={!readySession} onClick={() => void command("continue")}>继续</Button></Tooltip>
              <Tooltip title={readySession ? "仅执行当前步骤" : "等待 Agent 初始化浏览器"}><Button icon={<PlayCircleFilled />} disabled={!readySession} onClick={() => void command("runCurrent")}>当前步骤</Button></Tooltip>
              <Tooltip title={readySession ? "跳过当前步骤" : "等待 Agent 初始化浏览器"}><Button icon={<ThunderboltOutlined />} disabled={!readySession} onClick={() => void command("skip")}>跳过</Button></Tooltip>
              <Tooltip title={readySession ? "在下一步骤边界暂停" : "等待 Agent 初始化浏览器"}><Button icon={<PauseCircleOutlined />} disabled={!readySession} onClick={() => void command("pause")}>暂停</Button></Tooltip>
              <Tooltip title={readySession ? "重试当前步骤" : "等待 Agent 初始化浏览器"}><Button icon={<ReloadOutlined />} disabled={!readySession} onClick={() => void command("retry")}>重试</Button></Tooltip>
              <Tooltip title="结束并回收浏览器"><Button danger icon={<StopOutlined />} disabled={!activeSession} onClick={() => void command("stop")}>结束</Button></Tooltip>
            </div>
          </div>
          <div className="surface debug-observation-panel">
            <div className="panel-heading"><div><h2>页面快照</h2><span>由 Agent 定时上传</span></div></div>
            {latestScreenshot ? (
              screenshotUrl ? <img className="debug-screenshot" src={screenshotUrl} alt={`调试截图 ${latestScreenshot.name}`} /> : <Spin size="small" />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待安全截图" />}
          </div>
          <div className="surface debug-picker-panel">
            <div className="panel-heading">
              <div><h2>元素选取</h2><span>在调试浏览器中点击元素后生成候选</span></div>
              <Tooltip title={readySession ? "在调试浏览器中启用一次选取" : "等待 Agent 初始化浏览器"}><Button icon={<FileSearchOutlined />} disabled={!readySession} onClick={() => void enablePicker()} /></Tooltip>
            </div>
            {!latestCapture ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待浏览器点击" /> : (
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
                      <Tooltip title="确认写入草稿元素库"><Button size="small" type="primary" icon={<CheckCircleFilled />} disabled={latestCapture.status !== "pending"} onClick={() => void confirmCandidate(latestCapture, index)} /></Tooltip>
                    </Space>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="surface debug-event-panel">
            <div className="panel-heading"><div><h2>会话事件</h2><span>URL、步骤、控制台与网络失败</span></div><Button icon={<ReloadOutlined />} onClick={() => void loadSessions()} /></div>
            <div className="debug-event-list">
              {selectedSession.events.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待 Agent 事件" /> : selectedSession.events.map((event) => (
                <div className={`debug-event-row ${event.kind.includes("failed") || event.kind.includes("error") ? "error" : ""}`} key={event.id}>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                  <strong>{event.kind}</strong>
                  <span>{typeof event.data.message === "string" ? event.data.message : typeof event.data.currentUrl === "string" ? event.data.currentUrl : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
      <Modal
        title="新建调试会话"
        open={startOpen}
        confirmLoading={creating}
        onCancel={() => setStartOpen(false)}
        okText="创建会话"
        onOk={() => startForm.validateFields().then(async (values) => {
          if (!platformSession) return;
          setCreating(true);
          try {
            const result = await createDebugSession(platformSession.token, platformProjectId, values);
            setSelectedSessionId(result.session.id);
            setStartOpen(false);
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
          <Form.Item name="revisionId" label="已发布流程版本" rules={[{ required: true, message: "请选择已发布版本" }]}>
            <Select onChange={(revisionId) => startForm.setFieldsValue({ environmentId: publishedRevisions.find((revision) => revision.id === revisionId)?.environmentId })} options={publishedRevisions.map((revision) => ({ value: revision.id, label: `版本 ${revision.revisionNumber} · ${new Date(revision.publishedAt ?? revision.createdAt).toLocaleString()}` }))} />
          </Form.Item>
          <Form.Item name="environmentId" label="运行环境" rules={[{ required: true, message: "请选择运行环境" }]}>
            <Select disabled options={selectedRevisionEnvironment ? [{ value: selectedRevisionEnvironment.id, label: selectedRevisionEnvironment.name }] : []} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
