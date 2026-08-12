import { message } from "../antd-feedback";
import type { ElementAsset, Project } from "../mock-data";
import { getDebugSessions, getPlatformProjectDocument, getPlatformRevisions, sendDebugCommand } from "../platform-api";
import type { PlatformDebugSession, PlatformElement, PlatformRevision, PlatformSession } from "../platform-api";
import { notifyPlatformContextChanged, readPlatformProjectMap, readStoredPlatformSession, storePlatformDocumentVersion } from "../platform-context";
import { Link } from "../router";
import { ElementPickerPanel } from "./ElementPickerPanel";
import { PageHeading } from "./shared";
import { useWorkspaceStore } from "../workspace-store";
import { PauseCircleOutlined, PlayCircleFilled, PlusOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useState } from "react";

export function DebugSessionsPage({ project }: { project: Project }) {
  const environments = useWorkspaceStore((state) => state.environmentsByProject[project.id] ?? []);
  const [platformSession] = useState<PlatformSession | undefined>(readStoredPlatformSession);
  const [platformProjectMap] = useState<Record<string, string>>(readPlatformProjectMap);
  const [revisions, setRevisions] = useState<PlatformRevision[]>([]);
  const [sessions, setSessions] = useState<PlatformDebugSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const platformProjectId = platformProjectMap[project.id];
  const selectedSession = sessions.find((item) => item.id === selectedSessionId) ?? sessions[0];
  const publishedRevisions = revisions.filter((revision) => revision.status === "published");

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

  const handleConfirmedElement = async (element: PlatformElement, documentVersion: number) => {
    if (!platformSession || !platformProjectId) return;
    const workspace = useWorkspaceStore.getState();
    if (!workspace.elementsByProject[project.id]?.some((item) => item.id === element.id)) {
      const asset: ElementAsset = {
        ...element,
        validation: element.validation === "verified" ? "valid" : "unverified",
      };
      workspace.setElements(project.id, [
        ...(workspace.elementsByProject[project.id] ?? []),
        asset,
      ]);
    }
    storePlatformDocumentVersion(platformProjectId, documentVersion);
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
        actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setStartOpen(true)}>新建调试会话</Button>}
      />
      {publishedRevisions.length === 0 && <Alert className="debug-alert" type="info" showIcon title="没有已发布版本，可创建空白调试会话：仅选择环境（+ 起始 URL），浏览器将直接打开目标页面。" />}
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
          <div className="surface debug-picker-panel">
            <ElementPickerPanel
              project={project}
              sessionId={selectedSession.id}
              onSessionIdChange={setSelectedSessionId}
              preferredEnvironmentId={selectedSession.environmentId ?? environments[0]?.id}
              confirmMode="element"
              onConfirmElement={(element, documentVersion) => void handleConfirmedElement(element, documentVersion)}
              createOpen={startOpen}
              onCreateOpenChange={setStartOpen}
            />
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
    </>
  );
}